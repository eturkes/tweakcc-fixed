#!/usr/bin/env node
// Sibling-arm gate: when one arm of a switch or ternary is a catalogued
// model-facing literal, every other arm that returns a literal is almost
// certainly model-facing too, so each must be catalogued or carry a verdict.
//
// Why this exists. The extractor finds prompts one literal at a time: a long
// string clears the prose gate, a short one only gets in through a cache
// verdict. A short arm whose verdict was never asked for therefore falls
// through silently, even when its sibling arm two cases up is catalogued. On CC
// 2.1.295 the `call_only` arm of the unreachable-attached-machines reminder
// ("${h} A call to ${s?"it":"one of them"} takes up to 10 seconds to fail and
// ${y}") was missed while its `rechecked` sibling was catalogued; only a
// cross-check against the upstream catalogue noticed. The artifact approval
// question builder had two more (`delete` and the unattended `public_change`
// arm) with every other case catalogued.
//
// A group is
//   - a `switch`: the literals returned from each of its cases (through `if`
//     blocks inside the case, ternary arms, array elements, `+` chains and
//     `||`/`??`), plus the return it falls out to (the statements after it,
//     when it has no `default` or a case `break`s) as its default arm,
//   - a returned ternary: the literal leaves of a conditional that is a
//     `return` argument or an arrow body,
//   - a list: an array literal holding a `...xs.map(cb)` / `...xs.flatMap(cb)`
//     spread, whose arms are its plain elements and every return of those
//     callbacks (nested switches included), or
//   - a respelling row: `[needle, replacement]` in a table of such pairs. Its
//     anchor is not an arm but the catalogued prompt whose text contains the
//     needle, since the replacement renders into that prompt at runtime; a
//     needle that is a bare key token marks a lookup table and anchors nothing.
// An array or `+` chain is one arm when the extractor ruled its joined text (a
// composite verdict); otherwise its own literal leaves are the arms, each under
// the body the extractor looks it up by (a composite element is a fragment).
// A group is checked only when one of its arms is catalogued (a `model` cache
// verdict or a catalogue body). Each other arm that has no verdict at all
// (current or pre-promotion key), is not catalogued, and reads as words (two
// or more outside `${}`, counting the literals a slot falls back to) is a
// finding. Arms that already carry a `ui`/`internal` verdict were ruled on and
// are not re-reported.
//
// Usage:
//   node tools/checkSiblingArms.mjs <cli.js> <prompts.json>
//     [--cache data/prompt-classification.json] [--json]
// Exit 0 = no finding, 1 = findings, 2 = usage error or a bundle segment acorn
// could not parse (its arms were never seen, so a pass would be unearned).
// With --json, stdout is the JSON alone and the summary goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildEntries,
  describe,
  detectVersion,
  entryKeys,
  keyVariants,
} from './probeCacheKey.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const ex = require('./promptExtractor.js');
const { splitModuleBundle } = require('./lib/moduleBundle.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE = path.join(
  HERE,
  '..',
  'data',
  'prompt-classification.json'
);

const USAGE =
  'usage: node tools/checkSiblingArms.mjs <cli.js> <prompts.json> [--cache <classification.json>] [--json]';

const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function parseSegment(source) {
  const opts = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  };
  try {
    return acorn.parse(source, { ...opts, sourceType: 'module' });
  } catch {
    return acorn.parse(source, { ...opts, sourceType: 'script' });
  }
}

function childNodes(n) {
  const out = [];
  for (const key in n) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const c = n[key];
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c)) {
      for (const x of c) if (x && typeof x.type === 'string') out.push(x);
    } else if (typeof c.type === 'string') out.push(c);
  }
  return out;
}

const isLiteralLeaf = n =>
  (n.type === 'Literal' && typeof n.value === 'string') ||
  n.type === 'TemplateLiteral';
const isConcat = n => n.type === 'BinaryExpression' && n.operator === '+';

// The arm nodes an expression can evaluate to, looking through ternary arms,
// `||`/`??` operands and the tail of a comma list. A literal, an array and a
// `+` chain are arm nodes; armOf() opens the last two.
function leaves(n, out = []) {
  if (!n) return out;
  if (isLiteralLeaf(n) || isConcat(n) || n.type === 'ArrayExpression')
    out.push(n);
  else if (n.type === 'ConditionalExpression') {
    leaves(n.consequent, out);
    leaves(n.alternate, out);
  } else if (n.type === 'LogicalExpression' && n.operator !== '&&') {
    leaves(n.left, out);
    leaves(n.right, out);
  } else if (n.type === 'SequenceExpression') leaves(n.expressions.at(-1), out);
  return out;
}

// The prose of a literal, from the AST: a template's cooked quasis, so a `{`
// inside a slot (`${e("{")} Please confirm`) cannot swallow the text after it,
// plus the literals a slot can render by itself: its ternary arms and `??`/`||`
// fallbacks. `${p??"the arguments"} ${d.message??"are not valid"}` has no word
// outside its slots.
const proseOf = n =>
  n.type === 'Literal'
    ? n.value
    : [
        ...n.quasis.map(q => q.value.cooked ?? q.value.raw),
        ...n.expressions.flatMap(e =>
          leaves(e).filter(isLiteralLeaf).map(proseOf)
        ),
      ].join(' ');

// An arm as absolute ranges: a literal carries its prose; an array or `+`
// chain carries `parts`, the arms of its elements / operands, used when the
// joined text has no verdict of its own.
function armOf(n, base) {
  const arm = { start: base + n.start, end: base + n.end };
  if (isLiteralLeaf(n)) {
    arm.text = proseOf(n);
    return arm;
  }
  const kids = isConcat(n)
    ? [n.left, n.right]
    : n.elements.filter(el => el && el.type !== 'SpreadElement');
  arm.parts = kids.flatMap(k => leaves(k)).map(k => armOf(k, base));
  return arm;
}

// Return arguments reachable from a case body without entering a nested
// function or, unless `intoSwitches`, a nested switch (which forms its own
// group).
function caseReturns(stmts, { intoSwitches = false } = {}) {
  const out = [];
  const stack = [...stmts];
  while (stack.length) {
    const n = stack.pop();
    if (
      !n ||
      FN_TYPES.has(n.type) ||
      (n.type === 'SwitchStatement' && !intoSwitches) ||
      n.type === 'ClassBody'
    )
      continue;
    if (n.type === 'ReturnStatement') {
      if (n.argument) out.push(n.argument);
      continue;
    }
    if (/Expression$/.test(n.type)) continue;
    stack.push(...childNodes(n));
  }
  return out;
}

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

// `true`, `!0` and `1`-style constant tests never let a loop exit on its own.
const alwaysTrue = t =>
  !t ||
  (t.type === 'Literal' && Boolean(t.value)) ||
  (t.type === 'UnaryExpression' &&
    t.operator === '!' &&
    t.argument.type === 'Literal' &&
    !t.argument.value);

const union = (...sets) => new Set(sets.flatMap(s => [...s]));
const without = (set, ...drop) => {
  const out = new Set(set);
  for (const d of drop) out.delete(d);
  return out;
};

// How a statement can complete: 'normal', 'return', 'throw', 'break' and
// 'continue' (unlabelled), 'break:L' and 'continue:L'. Expressions are never
// entered, so a nested function's returns are not this statement's.
function completions(n) {
  if (!n) return new Set(['normal']);
  if (Array.isArray(n)) return listCompletions(n);
  switch (n.type) {
    case 'BlockStatement':
    case 'StaticBlock':
      return listCompletions(n.body);
    case 'ReturnStatement':
      return new Set(['return']);
    case 'ThrowStatement':
      return new Set(['throw']);
    case 'BreakStatement':
      return new Set([n.label ? `break:${n.label.name}` : 'break']);
    case 'ContinueStatement':
      return new Set([n.label ? `continue:${n.label.name}` : 'continue']);
    case 'IfStatement':
      return union(completions(n.consequent), completions(n.alternate));
    case 'LabeledStatement': {
      const c = completions(n.body);
      const out = without(
        c,
        `break:${n.label.name}`,
        `continue:${n.label.name}`
      );
      if (c.has(`break:${n.label.name}`)) out.add('normal');
      return out;
    }
    case 'SwitchStatement':
      return switchCompletions(n);
    case 'TryStatement': {
      let c = completions(n.block);
      if (n.handler)
        c = union(without(c, 'throw'), completions(n.handler.body));
      if (!n.finalizer) return c;
      const f = completions(n.finalizer);
      return f.has('normal') ? union(c, without(f, 'normal')) : f;
    }
    case 'WithStatement':
      return completions(n.body);
    default:
      if (LOOP_TYPES.has(n.type)) {
        const body = completions(n.body);
        const out = without(body, 'break', 'continue', 'normal');
        const each = n.type === 'ForInStatement' || n.type === 'ForOfStatement';
        const testRuns =
          n.type !== 'DoWhileStatement' ||
          body.has('normal') ||
          body.has('continue');
        if (body.has('break') || (testRuns && (each || !alwaysTrue(n.test))))
          out.add('normal');
        return out;
      }
      return new Set(['normal']);
  }
}

function listCompletions(stmts) {
  const out = new Set();
  for (const s of stmts) {
    const c = completions(s);
    for (const k of c) if (k !== 'normal') out.add(k);
    if (!c.has('normal')) return out;
  }
  out.add('normal');
  return out;
}

// A switch completes normally when no clause matches (no `default`), when a
// `break` binds to it, or when the last clause runs off its end (every clause
// that runs off its end falls through into the next).
function switchCompletions(sw) {
  const out = new Set();
  if (!sw.cases.some(c => c.test === null)) out.add('normal');
  sw.cases.forEach((c, i) => {
    const cc = completions(c.consequent);
    for (const k of cc) {
      if (k === 'break') out.add('normal');
      else if (k !== 'normal' || i === sw.cases.length - 1) out.add(k);
    }
  });
  if (!sw.cases.length) out.add('normal');
  return out;
}

// Can control leave the switch to the statements after it? A labelled
// `break` to the switch's own label leaves it too.
function fallsOut(sw, parents) {
  const c = switchCompletions(sw);
  if (c.has('normal')) return true;
  const p = parents && parents.get(sw);
  return p?.type === 'LabeledStatement' && c.has(`break:${p.label.name}`);
}

// The statements that run after a switch falls out: its later siblings in the
// enclosing statement list. Their return is the switch's default arm.
function fallOutStatements(sw, parents) {
  if (!fallsOut(sw, parents)) return [];
  let node = sw;
  let p = parents.get(node);
  while (p?.type === 'LabeledStatement') {
    node = p;
    p = parents.get(node);
  }
  const list = p && (Array.isArray(p.body) ? p.body : p.consequent);
  if (!Array.isArray(list)) return [];
  const i = list.indexOf(node);
  return i < 0 ? [] : list.slice(i + 1);
}

// Return arguments of a callback, through nested switches but not nested
// functions; an expression-bodied arrow returns its body.
const callbackReturns = fn =>
  fn.body.type === 'BlockStatement'
    ? caseReturns(fn.body.body, { intoSwitches: true })
    : [fn.body];

// `...xs.map(cb)` / `...xs.flatMap(cb)`: the callback whose returns become
// elements of the enclosing array. `map` and `flatMap` are built-in names.
function spreadCallback(el) {
  if (el?.type !== 'SpreadElement') return null;
  const call = el.argument;
  if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression')
    return null;
  const name = call.callee.property?.name;
  if (name !== 'map' && name !== 'flatMap') return null;
  const fn = call.arguments[0];
  return fn && FN_TYPES.has(fn.type) ? fn : null;
}

// A list assembled from spread callbacks has no composite of its own (its
// elements are not all literals), so its clauses are only ever seen one by
// one. Arms: the plain elements and every callback return.
function listArms(arr) {
  const callbacks = arr.elements.map(spreadCallback);
  if (!callbacks.some(Boolean)) return null;
  return arr.elements.flatMap((el, i) => {
    if (!el) return [];
    if (callbacks[i])
      return callbackReturns(callbacks[i]).flatMap(r => leaves(r));
    return el.type === 'SpreadElement' ? [] : leaves(el);
  });
}

const plainString = n =>
  (n?.type === 'Literal' && typeof n.value === 'string') ||
  (n?.type === 'TemplateLiteral' && n.expressions.length === 0);
const isPair = n =>
  n?.type === 'ArrayExpression' &&
  n.elements.length === 2 &&
  n.elements.every(plainString);

// The cooked value of a plain string node.
const stringValue = n =>
  n.type === 'Literal' ? n.value : (n.quasis[0].value.cooked ?? '');

// Is `n` one row of a respelling table, `[[needle, replacement], …]`? The
// replacement is substituted for the needle in some host text at runtime, so
// it renders wherever that host does.
function isRespellingRow(n, parents) {
  if (!isPair(n)) return false;
  const table = parents.get(n);
  return table?.type === 'ArrayExpression' && table.elements.every(isPair);
}

// Is the top of a ternary chain returned? Climbs through the wrappers leaves()
// looks through, then requires a `return` or an arrow body.
function isReturned(node, parents) {
  let cur = node;
  let p = parents.get(cur);
  while (
    p &&
    (p.type === 'ArrayExpression' ||
      isConcat(p) ||
      (p.type === 'LogicalExpression' && p.operator !== '&&') ||
      (p.type === 'SequenceExpression' && p.expressions.at(-1) === cur))
  ) {
    cur = p;
    p = parents.get(cur);
  }
  if (!p) return false;
  if (p.type === 'ReturnStatement') return true;
  return p.type === 'ArrowFunctionExpression' && p.body === cur;
}

// Every switch / returned-ternary group in `code`, its arms as absolute
// ranges (see armOf), and the bundle segments acorn could not parse.
export function armGroups(code) {
  const segments = splitModuleBundle(code) || [
    { name: '', start: 0, source: code },
  ];
  const groups = [];
  const unparsed = [];
  for (const seg of segments) {
    let ast;
    try {
      ast = parseSegment(seg.source);
    } catch (err) {
      unparsed.push({
        name: seg.name,
        start: seg.start,
        error: err.message.split('\n')[0],
      });
      continue;
    }
    const parents = new Map();
    const stack = [ast];
    while (stack.length) {
      const n = stack.pop();
      let arms = null;
      let kind = null;
      if (n.type === 'SwitchStatement') {
        kind = 'switch';
        arms = n.cases
          .map(c => c.consequent)
          .concat([fallOutStatements(n, parents)])
          .flatMap(stmts => caseReturns(stmts).flatMap(r => leaves(r)));
      } else if (n.type === 'ArrayExpression' && isRespellingRow(n, parents)) {
        const [needle, replacement] = n.elements;
        groups.push({
          kind: 'respelling',
          at: seg.start + n.start,
          needle: stringValue(needle),
          arms: [armOf(replacement, seg.start)],
        });
      } else if (n.type === 'ArrayExpression') {
        kind = 'list';
        arms = listArms(n);
      } else if (
        n.type === 'ConditionalExpression' &&
        parents.get(n)?.type !== 'ConditionalExpression' &&
        isReturned(n, parents)
      ) {
        kind = 'ternary';
        arms = leaves(n);
      }
      if (arms && arms.length > 1)
        groups.push({
          kind,
          at: seg.start + n.start,
          arms: arms.map(a => armOf(a, seg.start)),
        });
      for (const c of childNodes(n)) {
        parents.set(c, n);
        stack.push(c);
      }
    }
  }
  return { groups, unparsed };
}

// One word: letters, a one-letter word included, with inner apostrophes or
// hyphens, once surrounding punctuation is stripped. A token carrying `_` or
// `/`, or a dot between letters, is an identifier, path or host
// (`own_calls`, `/usr/bin/chromium`, `api.github.com`), not prose.
const WORD = /^[A-Za-z]+(?:['\u2019-][A-Za-z]+)*$/;
const isWord = token => {
  if (/[_/\\${}]/.test(token)) return false;
  const core = token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  return WORD.test(core);
};

// Two or more words in the literal text of an arm (a template's quasis, never
// its slots): an enum value, a bare slot or punctuation can be an arm but is
// never a prompt on its own.
export function readsAsWords(text) {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token && isWord(token) && ++n >= 2) return true;
  }
  return false;
}

// Catalogue pieces keep a template's source escapes; a needle is cooked.
const cook = s =>
  s.replace(
    /\\([nrt`$\\'"])/g,
    (_m, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c
  );

function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// The scan proper. `catalogue` is the prompts array of a prompts JSON; `cache`
// the classification cache object.
export function scanSiblingArms(cliPath, { catalogue, cache, version } = {}) {
  const code = fs.readFileSync(cliPath, 'utf8');
  ex.setCcVersionForCacheLookups(version || detectVersion(cliPath, code));
  const records = quietly(() =>
    ex.collectLiteralSites(cliPath, { composites: true })
  );
  // A string folded into a composite element keeps only its fragment entry
  // (buildEntries), so every kind but the joined composite text is a literal
  // site; where a range has more than one, string/template wins.
  const literals = new Map();
  const composites = new Map();
  const rank = e => (e.kind === 'string' || e.kind === 'template' ? 0 : 1);
  for (const e of buildEntries(records)) {
    const k = `${e.start}:${e.end}`;
    if (e.kind === 'composite') {
      if (!composites.has(k)) composites.set(k, e);
      continue;
    }
    if (!literals.has(k)) literals.set(k, []);
    literals.get(k).push(e);
  }
  for (const list of literals.values()) list.sort((a, b) => rank(a) - rank(b));

  const catalogued = new Map();
  const hosts = [];
  for (const p of catalogue || []) {
    const body = (p.pieces || []).filter(x => typeof x === 'string').join('');
    for (const v of keyVariants(body))
      if (!catalogued.has(v.key)) catalogued.set(v.key, p.id);
    if (p.id) hosts.push({ id: p.id, text: cook(body) });
  }
  // The catalogued prompts whose text holds a respelling needle: the host the
  // replacement renders into. A needle that is a bare key token ("teammate",
  // "ECONNRESET", "claude-3-5-sonnet") makes the table a key-to-label lookup
  // whose key merely turns up in unrelated prompts; a reworded phrase carries
  // a space or punctuation ("upload_asset:", "clearer than terminal text").
  const hostsOf = needle =>
    needle.trim() && !/^[$\w.-]+$/.test(needle.trim())
      ? hosts.filter(h => h.text.includes(needle)).map(h => h.id)
      : [];
  const ruling = e => {
    const d = describe(e, cache || {});
    const keys = entryKeys(e);
    const catId = keys.map(k => catalogued.get(k.key)).find(Boolean) || null;
    return {
      start: e.start,
      end: e.end,
      kind: e.kind,
      body: e.cacheBody,
      key: keys[0]?.key,
      verdict: d.verdict,
      modelId:
        d.verdict?.facing === 'model'
          ? d.verdict.id || catId || '(unnamed)'
          : catId,
    };
  };
  const memo = new Map();
  const lookup = (map, start, end) => {
    const k = `${map === composites ? 'c' : 'l'}:${start}:${end}`;
    if (memo.has(k)) return memo.get(k);
    let r = null;
    const hit = map.get(`${start}:${end}`);
    if (map === composites) r = hit ? ruling(hit) : null;
    else if (hit) {
      const rulings = hit.map(ruling);
      r = rulings.find(x => x.modelId || x.verdict) || rulings[0];
    }
    memo.set(k, r);
    return r;
  };
  // An array or `+` chain whose joined text is ruled is one arm, covered or
  // anchoring as a whole; otherwise its parts are the arms.
  const resolve = arm => {
    if (!arm.parts) {
      const r = lookup(literals, arm.start, arm.end);
      return r ? [{ ...r, text: arm.text }] : [];
    }
    const c = lookup(composites, arm.start, arm.end);
    if (c && (c.verdict || c.modelId)) return [c];
    return arm.parts.flatMap(resolve);
  };

  const { groups, unparsed } = armGroups(code);
  const findings = [];
  const seen = new Set();
  let anchored = 0;
  let trivial = 0;
  for (const g of groups) {
    const arms = g.arms.flatMap(resolve);
    const anchors =
      g.kind === 'respelling'
        ? hostsOf(g.needle)
        : arms.filter(a => a.modelId).map(a => a.modelId);
    if (!anchors.length) continue;
    anchored++;
    for (const a of arms) {
      if (a.modelId || a.verdict || seen.has(`${a.start}:${a.end}`)) continue;
      if (!readsAsWords(a.text ?? a.body)) {
        trivial++;
        continue;
      }
      seen.add(`${a.start}:${a.end}`);
      findings.push({
        start: a.start,
        end: a.end,
        kind: a.kind,
        key: a.key,
        body: a.body,
        group: g.kind,
        groupAt: g.at,
        anchors: [...new Set(anchors)],
      });
    }
  }
  return { groups: groups.length, anchored, trivial, unparsed, findings };
}

function parseArgs(argv) {
  const opt = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) opt.positional.push(argv[i]);
    else if (m[1] === 'json') opt.json = true;
    else if (m[1] === 'cache')
      opt.cache = m[2] !== undefined ? m[2] : argv[++i];
    else throw new Error(`unknown option --${m[1]}`);
  }
  if (opt.positional.length !== 2)
    throw new Error('need <cli.js> and <prompts.json>');
  return opt;
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`checkSiblingArms: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const [cli, json] = opt.positional.map(p => path.resolve(p));
  for (const f of [cli, json]) {
    if (!fs.existsSync(f)) {
      console.error(`checkSiblingArms: no such file ${f}\n${USAGE}`);
      process.exit(2);
    }
  }
  const catalogue = JSON.parse(fs.readFileSync(json, 'utf8')).prompts || [];
  const cache = JSON.parse(
    fs.readFileSync(opt.cache ? path.resolve(opt.cache) : DEFAULT_CACHE, 'utf8')
  );
  const r = scanSiblingArms(cli, { catalogue, cache });
  if (opt.json) console.log(JSON.stringify(r, null, 1));
  else
    for (const f of r.findings)
      console.log(
        `SIBLING ${f.start}-${f.end} ${f.kind} raw=${f.key} ${f.group}@${f.groupAt} beside ${f.anchors.join(',')} ${JSON.stringify(f.body.length > 120 ? f.body.slice(0, 120) + '…' : f.body)}`
      );
  const say = opt.json ? console.error : console.log;
  for (const u of r.unparsed)
    say(`UNPARSED segment ${u.name || '(bundle)'}@${u.start}: ${u.error}`);
  say(
    `sibling arms: ${r.findings.length} uncatalogued unclassified arm(s) in ${r.anchored} group(s) with a catalogued arm (${r.groups} switch/ternary groups scanned, ${r.trivial} non-prose arm(s) skipped, ${r.unparsed.length} unparseable segment(s))`
  );
  process.exit(r.unparsed.length ? 2 : r.findings.length ? 1 : 0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
