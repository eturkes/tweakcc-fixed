// Rewrite tables whose needles the bundle REQUIRES, not merely looks for.
//
// CC 2.1.296 lifts paragraphs between prompt surfaces through a rewriter that
// refuses to run on text that lost a spelling it restates:
//
//   function Oq(e,a){let t=e;for(let[n,r]of a){
//     if(!t.includes(n))throw Error("core prompt: a lifted paragraph lacks a spelling it rewrites");
//     t=t.replaceAll(n,r)}return t}
//
// An override that drops or rewords one of those needles does not ship a stale
// spelling, it makes tool.prompt() throw, and every turn then fails with
// model_error. The tables reach the rewriter every way a minifier can pass an
// array: inline, through a module const, through a const imported from another
// chunk, through a wrapper (`cZe(cond,text,table)`), through a conditional
// (`c?O4o:H4o`), with template-literal entries that carry `${}` holes. A regex
// over the call text saw none of the eleven 2.1.296 needles, so this reads the
// modules with a parser and resolves bindings the way the bundle does.
//
// The function name changes every build; a rewriter is recognised by shape: a
// for-of over a parameter destructured into [needle, replacement], a throw
// guarded by the text not containing the needle, and a replace of the needle.

import { createRequire } from 'node:module';
import { cookedForms, segmentsOf, siteOffsets } from './searchNeedles.mjs';

const require = createRequire(import.meta.url);
const { parseModuleSegment } = require('./moduleBundle.cjs');

const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'type',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);
const PARSE_OPTIONS = {
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  errorRecovery: true,
};

const childrenOf = node => {
  const out = [];
  for (const k in node) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') out.push(c);
    } else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
};

// Every node under `root` that is not inside a nested function.
const ownNodes = function* (root) {
  const stack = childrenOf(root).reverse();
  while (stack.length) {
    const n = stack.pop();
    yield n;
    if (FN_TYPES.has(n.type)) continue;
    stack.push(...childrenOf(n).reverse());
  }
};

const patternNames = (p, out = []) => {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'ArrayPattern')
    for (const e of p.elements) patternNames(e, out);
  else if (p.type === 'ObjectPattern')
    for (const prop of p.properties)
      patternNames(prop.type === 'RestElement' ? prop : prop.value, out);
  return out;
};

const keyName = k =>
  k.type === 'Identifier'
    ? k.name
    : k.type === 'StringLiteral'
      ? k.value
      : null;

// One parsed module: parents, a scope per function, imports, exports, and the
// assignment and call lists the resolvers search.
class ModuleIndex {
  constructor(seg, ast) {
    this.name = seg.name;
    this.ast = ast;
    this.parent = new Map();
    this.scopes = new Map();
    this.imports = new Map();
    this.exports = new Map();
    this.assigns = new Map();
    this.calls = [];
    this.fns = [];
    this.build();
  }

  scopeNode(node) {
    let n = node;
    while (n) {
      if (n.type === 'Program' || FN_TYPES.has(n.type)) return n;
      n = this.parent.get(n);
    }
    return this.ast.program;
  }

  declare(scopeNode, name, entry) {
    const sc = this.scopes.get(scopeNode);
    if (!sc.decls.has(name)) sc.decls.set(name, []);
    sc.decls.get(name).push(entry);
  }

  build() {
    const program = this.ast.program;
    this.scopes.set(program, { params: new Map(), decls: new Map() });
    const stack = [[program, null]];
    while (stack.length) {
      const [node, parent] = stack.pop();
      if (parent) this.parent.set(node, parent);
      const t = node.type;
      if (FN_TYPES.has(t)) {
        const params = new Map();
        node.params.forEach((p, i) => {
          for (const n of patternNames(p)) params.set(n, i);
        });
        this.scopes.set(node, { params, decls: new Map() });
        this.fns.push(node);
        if (t === 'FunctionDeclaration' && node.id)
          this.declare(this.scopeNode(parent), node.id.name, { node });
        else if (t === 'FunctionExpression' && node.id)
          this.declare(node, node.id.name, { node });
      } else if (t === 'VariableDeclaration') {
        const sn = this.scopeNode(parent);
        for (const d of node.declarations) {
          for (const n of patternNames(d.id))
            this.declare(sn, n, {
              node: d,
              pattern: d.id.type !== 'Identifier',
            });
        }
      } else if (t === 'ClassDeclaration' && node.id) {
        this.declare(this.scopeNode(parent), node.id.name, {
          node,
          opaque: true,
        });
      } else if (t === 'CatchClause' && node.param) {
        for (const n of patternNames(node.param))
          this.declare(this.scopeNode(parent), n, { node, opaque: true });
      } else if (t === 'ImportDeclaration') {
        for (const s of node.specifiers) {
          this.imports.set(s.local.name, {
            from: node.source.value,
            imported:
              s.type === 'ImportSpecifier'
                ? keyName(s.imported)
                : s.type === 'ImportDefaultSpecifier'
                  ? 'default'
                  : '*',
          });
        }
      } else if (t === 'ExportNamedDeclaration') {
        for (const s of node.specifiers || []) {
          const exported = keyName(s.exported);
          if (node.source)
            this.exports.set(exported, {
              from: node.source.value,
              imported: keyName(s.local),
            });
          else this.exports.set(exported, { local: keyName(s.local) });
        }
        const d = node.declaration;
        if (d) {
          const names = d.declarations
            ? d.declarations.flatMap(x => patternNames(x.id))
            : d.id
              ? [d.id.name]
              : [];
          for (const n of names) this.exports.set(n, { local: n });
        }
      } else if (t === 'AssignmentExpression') {
        for (const n of patternNames(node.left)) {
          if (!this.assigns.has(n)) this.assigns.set(n, []);
          this.assigns.get(n).push(node);
        }
      } else if (
        t === 'UpdateExpression' &&
        node.argument.type === 'Identifier'
      ) {
        const n = node.argument.name;
        if (!this.assigns.has(n)) this.assigns.set(n, []);
        this.assigns.get(n).push(node);
      } else if (t === 'CallExpression') {
        this.calls.push(node);
      }
      const kids = childrenOf(node);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], node]);
    }
  }

  // The binding `name` refers to at `node`: a parameter, a declaration, an
  // import, or null for a global.
  lookup(node, name) {
    let s = this.scopeNode(node);
    for (;;) {
      const sc = this.scopes.get(s);
      if (sc.params.has(name))
        return { kind: 'param', mod: this, fn: s, index: sc.params.get(name) };
      if (sc.decls.has(name))
        return {
          kind: 'decl',
          mod: this,
          scope: s,
          name,
          entries: sc.decls.get(name),
        };
      if (s.type === 'Program') {
        const imp = this.imports.get(name);
        return imp ? { kind: 'import', mod: this, name, ...imp } : null;
      }
      s = this.scopeNode(this.parent.get(s));
    }
  }

  sameBinding(a, b) {
    return (
      a && b && a.kind === 'decl' && b.kind === 'decl' && a.scope === b.scope
    );
  }

  // Assignments after the declaration that rebind it.
  reassignments(binding) {
    return (this.assigns.get(binding.name) || []).filter(a =>
      this.sameBinding(this.lookup(a, binding.name), binding)
    );
  }

  enclosingFn(node) {
    let n = this.parent.get(node);
    while (n && !FN_TYPES.has(n.type)) n = this.parent.get(n);
    return n || null;
  }

  fnName(fn) {
    if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name;
    const p = this.parent.get(fn);
    if (p && p.type === 'VariableDeclarator' && p.id.type === 'Identifier')
      return p.id.name;
    if (
      p &&
      p.type === 'AssignmentExpression' &&
      p.left.type === 'Identifier' &&
      p.right === fn
    )
      return p.left.name;
    return null;
  }
}

class Bundle {
  constructor(src, segs = segmentsOf(src)) {
    this.src = src;
    this.segs = segs;
    this.byName = new Map(segs.map(s => [s.name, s]));
    this.cache = new Map();
    this.parseErrors = [];
  }

  mod(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const seg = this.byName.get(name);
    let idx = null;
    if (seg) {
      const ast = parseModuleSegment(
        seg,
        PARSE_OPTIONS,
        'throwingRewriters',
        m => this.parseErrors.push({ module: name, message: m })
      );
      if (ast) idx = new ModuleIndex(seg, ast);
    }
    this.cache.set(name, idx);
    return idx;
  }

  importersOf(name) {
    const needle = `"${name}"`;
    return this.segs.filter(s => s.name !== name && s.source.includes(needle));
  }

  // The declaration an exported name of `modName` refers to, following
  // re-exports across modules.
  exported(modName, exportedName, seen = new Set()) {
    const key = `${modName}\0${exportedName}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const m = this.mod(modName);
    if (!m) return null;
    const e = m.exports.get(exportedName);
    if (!e) return null;
    if (e.from) return this.exported(e.from, e.imported, seen);
    return this.resolveName(m, m.ast.program, e.local, seen);
  }

  resolveName(m, atNode, name, seen = new Set()) {
    const b = m.lookup(atNode, name);
    if (!b) return null;
    if (b.kind === 'import') return this.exported(b.from, b.imported, seen);
    return b;
  }

  resolveIdent(m, ident) {
    return this.resolveName(m, ident, ident.name);
  }
}

// A binding with exactly one initialised declarator and nothing reassigning it.
const constInit = b => {
  if (!b || b.kind !== 'decl' || b.entries.length !== 1) return null;
  const e = b.entries[0];
  if (e.pattern || e.opaque) return null;
  if (e.node.type === 'VariableDeclarator') {
    if (!e.node.init || b.mod.reassignments(b).length) return null;
    return e.node.init;
  }
  if (FN_TYPES.has(e.node.type)) return e.node;
  return null;
};

const MATCH_METHODS = new Set(['includes', 'indexOf', 'startsWith', 'search']);
const REPLACE_METHODS = new Set(['replaceAll', 'replace']);

const isIdent = (n, name) => n && n.type === 'Identifier' && n.name === name;

// `t.replaceAll(n,r)`, `t.replace(n,r)` or `t.split(n).join(r)` with t the text.
const replaceOf = (call, needle, repl) => {
  if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression')
    return null;
  const method = keyName(call.callee.property);
  if (
    REPLACE_METHODS.has(method) &&
    isIdent(call.arguments[0], needle) &&
    isIdent(call.arguments[1], repl) &&
    call.callee.object.type === 'Identifier'
  )
    return call.callee.object.name;
  if (method === 'join' && isIdent(call.arguments[0], repl)) {
    const inner = call.callee.object;
    if (
      inner.type === 'CallExpression' &&
      inner.callee.type === 'MemberExpression' &&
      keyName(inner.callee.property) === 'split' &&
      isIdent(inner.arguments[0], needle) &&
      inner.callee.object.type === 'Identifier'
    )
      return inner.callee.object.name;
  }
  return null;
};

const throwsOnMissing = (body, needle) => {
  for (const n of [body, ...ownNodes(body)]) {
    if (n.type !== 'IfStatement') continue;
    const guards = [n.test, ...ownNodes(n.test)].some(
      x =>
        x.type === 'CallExpression' &&
        x.callee.type === 'MemberExpression' &&
        MATCH_METHODS.has(keyName(x.callee.property)) &&
        isIdent(x.arguments[0], needle)
    );
    if (!guards) continue;
    const c = n.consequent;
    if (
      c.type === 'ThrowStatement' ||
      [...ownNodes(c)].some(x => x.type === 'ThrowStatement')
    )
      return true;
  }
  return false;
};

// Every pair-table rewriter defined in `m`, throwing or not.
export const rewritersIn = m => {
  const out = [];
  for (const fn of m.fns) {
    if (fn.params.length < 2) continue;
    const sc = m.scopes.get(fn);
    for (const loop of ownNodes(fn.body)) {
      if (loop.type !== 'ForOfStatement' || loop.right.type !== 'Identifier')
        continue;
      const tableIdx = sc.params.get(loop.right.name);
      if (tableIdx === undefined) continue;
      const left = loop.left;
      const pat =
        left.type === 'VariableDeclaration' ? left.declarations[0].id : left;
      if (
        pat.type !== 'ArrayPattern' ||
        pat.elements.length < 2 ||
        pat.elements[0]?.type !== 'Identifier' ||
        pat.elements[1]?.type !== 'Identifier'
      )
        continue;
      const needle = pat.elements[0].name;
      const repl = pat.elements[1].name;
      let textVar = null;
      for (const n of [loop.body, ...ownNodes(loop.body)]) {
        if (n.type !== 'AssignmentExpression' || n.left.type !== 'Identifier')
          continue;
        const v = replaceOf(n.right, needle, repl);
        if (v && v === n.left.name) textVar = v;
      }
      if (!textVar) continue;
      let textIdx = sc.params.get(textVar);
      if (textIdx === undefined) {
        const d = (sc.decls.get(textVar) || [])[0];
        const init = d && d.node.type === 'VariableDeclarator' && d.node.init;
        if (init && init.type === 'Identifier')
          textIdx = sc.params.get(init.name);
        else if (init) {
          const used = [init, ...ownNodes(init)].find(
            x => x.type === 'Identifier' && sc.params.has(x.name)
          );
          if (used) textIdx = sc.params.get(used.name);
        }
      }
      out.push({
        mod: m,
        fn,
        name: m.fnName(fn),
        tableIdx,
        textIdx: textIdx === undefined ? null : textIdx,
        throws: throwsOnMissing(loop.body, needle),
        offset: fn.start,
      });
      break;
    }
  }
  return out;
};

const FOR_PAIR_RE =
  /for\s*\(\s*(?:let|const|var)?\s*\[\s*[$\w]+\s*,\s*[$\w]+\s*\]\s*of\s*[$\w]+\s*\)/g;

// Modules whose text holds a for-of pair loop with a throw and a replace within
// reach of it — the only ones worth parsing to look for a rewriter.
const candidateModules = segs =>
  segs.filter(seg => {
    const s = seg.source;
    if (!s.includes('throw')) return false;
    FOR_PAIR_RE.lastIndex = 0;
    let m;
    while ((m = FOR_PAIR_RE.exec(s)) !== null) {
      const win = s.slice(m.index, m.index + 1200);
      if (win.includes('throw') && /\.(?:replaceAll|replace|split)\(/.test(win))
        return true;
    }
    return false;
  });

// ---- static string evaluation -------------------------------------------

// A needle is a list of literal text parts and holes (`${expr}`), each hole
// carrying its value when the expression is a constant the bundle resolves.
const evalParts = (bundle, m, node, depth = 0) => {
  if (depth > 12) return [{ hole: true, value: null }];
  switch (node.type) {
    case 'StringLiteral':
      return [node.value];
    case 'NumericLiteral':
      return [String(node.value)];
    case 'TemplateLiteral': {
      const out = [];
      node.quasis.forEach((q, i) => {
        if (q.value.cooked == null) out.push({ hole: true, value: null });
        else out.push(q.value.cooked);
        const e = node.expressions[i];
        if (e)
          out.push({ hole: true, value: evalString(bundle, m, e, depth + 1) });
      });
      return out;
    }
    case 'BinaryExpression':
      if (node.operator === '+')
        return [
          ...evalParts(bundle, m, node.left, depth + 1),
          ...evalParts(bundle, m, node.right, depth + 1),
        ];
      break;
    case 'Identifier': {
      const b = bundle.resolveIdent(m, node);
      const init = constInit(b);
      if (init && !FN_TYPES.has(init.type))
        return evalParts(bundle, b.mod, init, depth + 1);
      break;
    }
    default:
      break;
  }
  return [{ hole: true, value: null }];
};

const evalString = (bundle, m, node, depth = 0) => {
  const parts = evalParts(bundle, m, node, depth);
  let s = '';
  for (const p of parts) {
    if (typeof p === 'string') s += p;
    else if (p.value != null) s += p.value;
    else return null;
  }
  return s;
};

const joinParts = parts => {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string' && typeof out[out.length - 1] === 'string')
      out[out.length - 1] += p;
    else out.push(p);
  }
  return out;
};

export const needleText = parts =>
  parts
    .map(p => (typeof p === 'string' ? p : p.value != null ? p.value : '${…}'))
    .join('');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// An override spells a slot as `${NAME}` (or `${NAME[key]}`); the catalogue's
// pristine pieces leave the name out: `${}`.
const SLOT = '\\$\\{[^}\\n]*\\}';

// The needle as a regex over cooked prompt text: literal parts verbatim, each
// hole either its constant value or any slot.
export const needleRegex = parts =>
  new RegExp(
    joinParts(parts)
      .map(p =>
        typeof p === 'string'
          ? esc(p)
          : p.value != null
            ? `(?:${esc(p.value)}|${SLOT})`
            : `(?:${SLOT}|[^\\n]{0,400}?)`
      )
      .join('')
  );

// Override text as needle parts: its own `${…}` slots become open holes.
const partsFromOverride = text => {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\$\{[^}\n]*\}/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ hole: true, value: null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

const longestLiteral = parts =>
  parts
    .filter(p => typeof p === 'string')
    .reduce((a, b) => (b.length > a.length ? b : a), '');

export const textHasNeedle = (text, parts) => {
  const key = longestLiteral(parts);
  const re = needleRegex(parts);
  return cookedForms(text).some(f => (!key || f.includes(key)) && re.test(f));
};

// ---- table resolution -----------------------------------------------------

const resolveTable = (bundle, m, node, acc, seen = new Set()) => {
  if (seen.has(node)) return;
  seen.add(node);
  const where = `${m.name || '<bundle>'}@${node.start}`;
  switch (node.type) {
    case 'ArrayExpression':
      for (const el of node.elements) {
        if (!el) continue;
        if (el.type === 'SpreadElement') {
          resolveTable(bundle, m, el.argument, acc, seen);
          continue;
        }
        let pair = el;
        let pm = m;
        if (pair.type === 'Identifier') {
          const b = bundle.resolveIdent(m, pair);
          const init = constInit(b);
          if (init) {
            pair = init;
            pm = b.mod;
          }
        }
        if (pair.type !== 'ArrayExpression' || !pair.elements[0]) {
          acc.unresolved.push({ where, reason: `entry is ${pair.type}` });
          continue;
        }
        const nn = pair.elements[0];
        if (nn.type === 'SpreadElement') {
          acc.unresolved.push({ where, reason: 'entry spreads its needle' });
          continue;
        }
        acc.entries.push({
          parts: joinParts(evalParts(bundle, pm, nn)),
          start: nn.start,
          end: nn.end,
          module: pm.name,
        });
      }
      return;
    case 'Identifier': {
      const b = bundle.resolveIdent(m, node);
      if (b && b.kind === 'param') {
        acc.unresolved.push({
          where,
          reason: `table is parameter ${node.name}`,
        });
        return;
      }
      const init = constInit(b);
      if (!init) {
        acc.unresolved.push({
          where,
          reason: `${node.name} is not a single-assignment const`,
        });
        return;
      }
      resolveTable(bundle, b.mod, init, acc, seen);
      return;
    }
    case 'ConditionalExpression':
      resolveTable(bundle, m, node.consequent, acc, seen);
      resolveTable(bundle, m, node.alternate, acc, seen);
      return;
    case 'LogicalExpression':
      resolveTable(bundle, m, node.left, acc, seen);
      resolveTable(bundle, m, node.right, acc, seen);
      return;
    case 'SequenceExpression':
      resolveTable(bundle, m, node.expressions.at(-1), acc, seen);
      return;
    case 'MemberExpression': {
      let base = node.object;
      while (base.type === 'MemberExpression') base = base.object;
      if (base.type === 'Identifier') {
        const b = bundle.resolveIdent(m, base);
        const init =
          b && b.kind === 'decl' && b.entries.length === 1
            ? b.entries[0].node.init
            : null;
        if (
          init &&
          (init.type === 'NullLiteral' ||
            (init.type === 'Identifier' && init.name === 'undefined')) &&
          !b.mod.reassignments(b).length
        ) {
          acc.dead.push({
            where,
            reason: `${base.name} is only ever ${init.type === 'NullLiteral' ? 'null' : 'undefined'}`,
          });
          return;
        }
        const objInit = constInit(b);
        if (
          objInit &&
          objInit.type === 'ObjectExpression' &&
          node.object === base &&
          !node.computed
        ) {
          const want = keyName(node.property);
          const prop = objInit.properties.find(
            p => p.type === 'ObjectProperty' && keyName(p.key) === want
          );
          if (prop) {
            resolveTable(bundle, b.mod, prop.value, acc, seen);
            return;
          }
        }
      }
      acc.unresolved.push({
        where,
        reason: 'table is a member of a runtime object',
      });
      return;
    }
    default:
      acc.unresolved.push({ where, reason: `table is a ${node.type}` });
  }
};

// ---- value-flow reach of the rewritten text -------------------------------

const STRING_METHODS = new Set([
  'join',
  'trim',
  'trimEnd',
  'trimStart',
  'replace',
  'replaceAll',
  'concat',
  'filter',
  'map',
  'flatMap',
  'flat',
  'slice',
  'toString',
]);

// The literal source ranges whose text can end up in the value of `node`:
// conditionals take both arms but never their tests, a call reaches what the
// callee returns plus what it is handed, an array local reaches what is pushed
// onto it. A function's whole body is never swept in, so a flag check in a
// helper cannot drag unrelated prompts into the attribution.
const reachRanges = (bundle, m, node, cap = 50000) => {
  const ranges = [];
  const seen = new Set();
  let steps = 0;
  const work = [[m, node]];
  const returnsOf = (fm, fn) => {
    if (
      fn.type === 'ArrowFunctionExpression' &&
      fn.body.type !== 'BlockStatement'
    )
      work.push([fm, fn.body]);
    else
      for (const n of ownNodes(fn.body))
        if (n.type === 'ReturnStatement' && n.argument)
          work.push([fm, n.argument]);
  };
  const binding = b => {
    if (!b || b.kind !== 'decl') return;
    const bm = b.mod;
    for (const e of b.entries) {
      if (e.opaque) continue;
      if (FN_TYPES.has(e.node.type)) {
        if (!seen.has(e.node)) {
          seen.add(e.node);
          returnsOf(bm, e.node);
        }
      } else if (e.node.type === 'VariableDeclarator' && e.node.init) {
        const init = e.node.init;
        if (FN_TYPES.has(init.type)) {
          if (!seen.has(init)) {
            seen.add(init);
            returnsOf(bm, init);
          }
        } else work.push([bm, init]);
      }
    }
    for (const a of bm.reassignments(b))
      if (a.type === 'AssignmentExpression') work.push([bm, a.right]);
    for (const c of bm.calls) {
      const cal = c.callee;
      if (
        cal.type === 'MemberExpression' &&
        cal.object.type === 'Identifier' &&
        cal.object.name === b.name &&
        ['push', 'unshift', 'splice'].includes(keyName(cal.property)) &&
        bm.sameBinding(bm.lookup(c, b.name), b)
      )
        for (const arg of c.arguments) work.push([bm, arg]);
    }
  };
  while (work.length) {
    const [wm, n] = work.pop();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (++steps > cap) return { ranges, overflow: true };
    switch (n.type) {
      case 'StringLiteral':
        ranges.push([n.start, n.end]);
        break;
      case 'TemplateLiteral':
        for (const q of n.quasis) ranges.push([q.start, q.end]);
        for (const e of n.expressions) work.push([wm, e]);
        break;
      case 'TaggedTemplateExpression':
        work.push([wm, n.quasi]);
        break;
      case 'BinaryExpression':
        if (n.operator === '+') work.push([wm, n.left], [wm, n.right]);
        break;
      case 'ConditionalExpression':
        work.push([wm, n.consequent], [wm, n.alternate]);
        break;
      case 'LogicalExpression':
        work.push([wm, n.left], [wm, n.right]);
        break;
      case 'SequenceExpression':
        work.push([wm, n.expressions.at(-1)]);
        break;
      case 'ParenthesizedExpression':
        work.push([wm, n.expression]);
        break;
      case 'AssignmentExpression':
        work.push([wm, n.right]);
        break;
      case 'ArrayExpression':
        for (const el of n.elements) if (el) work.push([wm, el]);
        break;
      case 'SpreadElement':
        work.push([wm, n.argument]);
        break;
      case 'AwaitExpression':
        work.push([wm, n.argument]);
        break;
      case 'Identifier':
        binding(bundle.resolveIdent(wm, n));
        break;
      case 'CallExpression':
      case 'NewExpression': {
        for (const a of n.arguments) work.push([wm, a]);
        const cal = n.callee;
        if (cal.type === 'Identifier') binding(bundle.resolveIdent(wm, cal));
        else if (FN_TYPES.has(cal.type)) returnsOf(wm, cal);
        else if (cal.type === 'MemberExpression') {
          const method = keyName(cal.property);
          if (STRING_METHODS.has(method)) {
            work.push([wm, cal.object]);
            if (method === 'map' || method === 'flatMap') {
              const cb = n.arguments[0];
              if (cb && FN_TYPES.has(cb.type)) returnsOf(wm, cb);
            }
          }
        }
        break;
      }
      case 'MemberExpression': {
        if (n.computed || n.object.type !== 'Identifier') break;
        const b = bundle.resolveIdent(wm, n.object);
        const init = constInit(b);
        if (init && init.type === 'ObjectExpression') {
          const want = keyName(n.property);
          const prop = init.properties.find(
            p => p.type === 'ObjectProperty' && keyName(p.key) === want
          );
          if (prop) work.push([b.mod, prop.value]);
        }
        break;
      }
      default:
        break;
    }
  }
  return { ranges, overflow: false };
};

// ---- call sites -------------------------------------------------------------

// Every concrete call of a throwing rewriter, through wrappers and imports.
const callSites = (bundle, rewriter) => {
  const sites = [];
  const unresolved = [];
  const done = new Set();
  const queue = [
    {
      mod: rewriter.mod,
      name: rewriter.name,
      tableIdx: rewriter.tableIdx,
      textIdx: rewriter.textIdx,
      fixedTable: null,
      fixedText: null,
      via: [rewriter.name],
    },
  ];
  // Modules where `local` (a binding of `home`) is reachable, and the name it
  // goes by there, following imports and re-exports.
  const homes = (home, local) => {
    const out = [
      { m: home, name: local, decl: home.lookup(home.ast.program, local) },
    ];
    const exportsOf = (m, name) =>
      [...m.exports].filter(([, e]) => e.local === name).map(([k]) => k);
    const q = [{ m: home, exportedAs: exportsOf(home, local) }];
    const seenH = new Set([`${home.name}\0${local}`]);
    while (q.length) {
      const { m, exportedAs } = q.shift();
      if (!exportedAs.length) continue;
      for (const seg of bundle.importersOf(m.name)) {
        const im = bundle.mod(seg.name);
        if (!im) {
          unresolved.push({
            where: seg.name,
            reason: `importer of ${m.name} did not parse`,
          });
          continue;
        }
        for (const [locName, imp] of im.imports) {
          if (imp.from !== m.name || !exportedAs.includes(imp.imported))
            continue;
          const key = `${im.name}\0${locName}`;
          if (seenH.has(key)) continue;
          seenH.add(key);
          out.push({ m: im, name: locName, decl: null, imported: true });
          q.push({ m: im, exportedAs: exportsOf(im, locName) });
        }
        for (const [expName, e] of im.exports) {
          if (e.from !== m.name || !exportedAs.includes(e.imported)) continue;
          const key = `${im.name}\0${expName}\0re`;
          if (seenH.has(key)) continue;
          seenH.add(key);
          q.push({ m: im, exportedAs: [expName] });
        }
      }
    }
    return out;
  };

  while (queue.length) {
    const c = queue.shift();
    const key = `${c.mod.name}\0${c.name}\0${c.tableIdx}\0${c.textIdx}`;
    if (done.has(key)) continue;
    done.add(key);
    let found = 0;
    for (const h of homes(c.mod, c.name)) {
      for (const call of h.m.calls) {
        if (!isIdent(call.callee, h.name)) continue;
        const b = h.m.lookup(call, h.name);
        if (!b) continue;
        if (h.imported ? b.kind !== 'import' : !h.m.sameBinding(b, h.decl))
          continue;
        found += 1;
        const tableArg = c.tableIdx != null ? call.arguments[c.tableIdx] : null;
        const textArg = c.textIdx != null ? call.arguments[c.textIdx] : null;
        const table = tableArg ? { m: h.m, node: tableArg } : c.fixedTable;
        const text = textArg ? { m: h.m, node: textArg } : c.fixedText;
        if (!table) {
          unresolved.push({
            where: `${h.m.name}@${call.start}`,
            reason: 'call passes no table',
          });
          continue;
        }
        const fn = h.m.enclosingFn(call);
        const paramOf = arg => {
          if (!fn || !arg || arg.m !== h.m || arg.node.type !== 'Identifier')
            return null;
          const b2 = h.m.lookup(arg.node, arg.node.name);
          return b2 && b2.kind === 'param' && b2.fn === fn ? b2.index : null;
        };
        const tableParam = paramOf(table);
        const textParam = paramOf(text);
        const wrapName = fn ? h.m.fnName(fn) : null;
        if ((tableParam != null || textParam != null) && wrapName) {
          queue.push({
            mod: h.m,
            name: wrapName,
            tableIdx: tableParam,
            textIdx: textParam,
            fixedTable: tableParam != null ? null : table,
            fixedText: textParam != null ? null : text,
            via: [...c.via, wrapName],
          });
          continue;
        }
        sites.push({
          module: h.m.name,
          offset: call.start,
          call: bundle.src.slice(
            call.start,
            Math.min(call.end, call.start + 160)
          ),
          via: c.via,
          table,
          text,
        });
      }
    }
    if (!found && c.via.length > 1)
      unresolved.push({
        where: `${c.mod.name}`,
        reason: `wrapper ${c.name} (${c.via.join(' <- ')}) is never called by name`,
      });
  }
  return { sites, unresolved };
};

// ---- the analysis -----------------------------------------------------------

const cookedPristine = p =>
  cookedForms((p.pieces || []).filter(x => typeof x === 'string').join(''));

const inRanges = (o, ranges) => ranges.some(([a, b]) => o >= a && o < b);

// Everything the gate needs from the bundle and the catalogue, independent of
// any override set: each needle a throwing rewriter requires, where the bundle
// spells it, the catalogued ids that supply the text it is matched against
// (`paragraphIds`) and the ids whose text IS the needle (`needleIds`).
export const analyzeThrowingRewriters = (src, prompts, opts = {}) => {
  const bundle = new Bundle(src, opts.segs);
  const rewriters = [];
  const problems = [];
  for (const seg of candidateModules(bundle.segs)) {
    const m = bundle.mod(seg.name);
    if (!m) {
      problems.push({
        kind: 'unparsed',
        where: seg.name,
        reason: 'module holding a pair-table loop with a throw did not parse',
      });
      continue;
    }
    for (const r of rewritersIn(m)) if (r.throws) rewriters.push(r);
  }

  const byId = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }
  const cooked = new Map();
  const cookedOf = id => {
    if (!cooked.has(id)) cooked.set(id, byId.get(id).flatMap(cookedPristine));
    return cooked.get(id);
  };
  const sitesCache = new Map();
  const sitesOf = id => {
    if (!sitesCache.has(id)) sitesCache.set(id, siteOffsets(src, byId.get(id)));
    return sitesCache.get(id);
  };

  const needles = new Map();
  const dead = [];
  const sites = [];
  for (const r of rewriters) {
    if (!r.name) {
      problems.push({
        kind: 'unresolved',
        where: `${r.mod.name}@${r.offset}`,
        reason: 'throwing rewriter has no name to find its callers by',
      });
      continue;
    }
    const { sites: found, unresolved } = callSites(bundle, r);
    for (const u of unresolved) problems.push({ kind: 'unresolved', ...u });
    for (const site of found) {
      const acc = { entries: [], unresolved: [], dead: [] };
      resolveTable(bundle, site.table.m, site.table.node, acc);
      for (const u of acc.unresolved)
        problems.push({
          kind: 'unresolved',
          where: u.where,
          reason: u.reason,
          call: site.call,
        });
      dead.push(...acc.dead.map(d => ({ ...d, call: site.call })));
      if (!acc.entries.length) continue;
      const reach = site.text
        ? reachRanges(bundle, site.text.m, site.text.node)
        : { ranges: [], overflow: false };
      if (reach.overflow)
        problems.push({
          kind: 'unresolved',
          where: `${site.module}@${site.offset}`,
          reason: 'text reach overflowed; attribution would be a guess',
          call: site.call,
        });
      sites.push({
        ...site,
        needles: acc.entries.map(e => needleText(e.parts)),
      });
      for (const e of acc.entries) {
        const text = needleText(e.parts);
        const key = `${text}\0${e.module}\0${e.start}`;
        if (!needles.has(key))
          needles.set(key, {
            needle: text,
            parts: e.parts,
            module: e.module,
            start: e.start,
            end: e.end,
            rewriter: r.name,
            calls: [],
            reach: [],
            textless: false,
          });
        const row = needles.get(key);
        row.calls.push(site.call);
        if (site.text) for (const rg of reach.ranges) row.reach.push(rg);
        else row.textless = true;
      }
    }
  }

  const rows = [];
  for (const row of needles.values()) {
    const re = needleRegex(row.parts);
    const key = longestLiteral(row.parts);
    const carriers = [];
    for (const id of byId.keys()) {
      if (cookedOf(id).some(f => (!key || f.includes(key)) && re.test(f)))
        carriers.push(id);
    }
    // Ids whose whole text sits inside the needle's own literal: overriding one
    // changes the needle itself.
    const needleIds = [];
    const plain = row.parts.every(p => typeof p === 'string')
      ? row.parts.join('')
      : null;
    for (const id of byId.keys()) {
      const forms = cookedOf(id)
        .map(f => f.trim())
        .filter(f => f.length >= 8);
      if (!forms.some(f => (plain ?? needleText(row.parts)).includes(f)))
        continue;
      if (sitesOf(id).some(o => o >= row.start && o < row.end))
        needleIds.push(id);
    }
    const paragraphIds = [];
    const unplaced = [];
    for (const id of carriers) {
      if (needleIds.includes(id)) continue;
      const at = sitesOf(id);
      if (!at.length) unplaced.push(id);
      else if (row.textless || at.some(o => inRanges(o, row.reach)))
        paragraphIds.push(id);
    }
    paragraphIds.push(...unplaced);
    const others = carriers.filter(
      id => !needleIds.includes(id) && !paragraphIds.includes(id)
    );
    rows.push({
      needle: row.needle,
      parts: row.parts,
      module: row.module,
      offset: row.start,
      rewriter: row.rewriter,
      calls: [...new Set(row.calls)],
      needleIds,
      paragraphIds,
      unplaced,
      unattributedCarriers: paragraphIds.length ? [] : others,
    });
  }
  return {
    rewriters: rewriters.map(r => ({
      module: r.mod.name,
      name: r.name,
      offset: r.offset,
    })),
    sites,
    needles: rows,
    dead,
    problems,
    parseErrors: bundle.parseErrors,
  };
};

// ---- per-set check ----------------------------------------------------------

const leadWs = s => s.match(/^\s*/)[0];
const trailWs = s => s.match(/\s*$/)[0];

// Failures for one override set. `overrideOf(id)` returns the override body
// (frontmatter stripped) or null when the set does not override that id.
export const checkThrowingNeedles = (analysis, prompts, overrideOf) => {
  const byId = new Map();
  for (const p of prompts) {
    if (!p.id) continue;
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  }
  const pristineBodies = id =>
    byId
      .get(id)
      .map(p => (p.pieces || []).filter(x => typeof x === 'string').join(''));
  const failures = [];
  const notes = [];
  for (const row of analysis.needles) {
    // The needle as the patched bundle will spell it.
    let parts = row.parts;
    const changedBy = [];
    for (const id of row.needleIds) {
      const ov = overrideOf(id);
      if (ov == null) continue;
      const pristine = pristineBodies(id);
      if (pristine.some(b => b.trim() === ov.trim())) continue;
      changedBy.push(id);
      const pristineCooked = cookedForms(pristine[0]).at(-1);
      const whole = needleText(row.parts);
      const ovCooked = cookedForms(ov).at(-1);
      if (whole.trim() === pristineCooked.trim()) {
        parts = partsFromOverride(
          leadWs(whole) + ovCooked.trim() + trailWs(whole)
        );
      } else if (whole.includes(pristineCooked.trim())) {
        parts = partsFromOverride(
          whole.replace(pristineCooked.trim(), ovCooked.trim())
        );
      }
    }
    if (row.needleIds.length && row.paragraphIds.length)
      notes.push(
        `coupled: ${row.needleIds.join(', ')} spells the needle ` +
          `${JSON.stringify(row.needle.slice(0, 60))} that ` +
          `${row.paragraphIds.join(', ')} must contain — edit them together`
      );
    if (!joinParts(parts).some(p => typeof p !== 'string' || p.trim())) {
      failures.push({
        kind: 'empty-needle',
        id: changedBy.join(', '),
        needle: row.needle,
        calls: row.calls,
        detail:
          'the override blanks a needle; replaceAll("", r) splices the ' +
          'replacement between every character of the paragraph',
      });
      continue;
    }
    if (!row.paragraphIds.length) {
      if (row.unattributedCarriers.length)
        failures.push({
          kind: 'unattributed',
          id: row.unattributedCarriers.join(', '),
          needle: row.needle,
          calls: row.calls,
          detail:
            'catalogued prompts carry this needle but none could be traced ' +
            'to the rewritten text; the gate cannot tell which override must keep it',
        });
      else
        notes.push(
          `needle ${JSON.stringify(row.needle.slice(0, 60))} is in no catalogued ` +
            'prompt — no override can drop it'
        );
      continue;
    }
    for (const id of row.paragraphIds) {
      const ov = overrideOf(id);
      const texts = ov == null ? pristineBodies(id) : [ov];
      if (texts.some(t => textHasNeedle(t, parts))) continue;
      const empty = ov != null && !ov.trim();
      failures.push({
        kind:
          changedBy.length && ov == null
            ? 'desync'
            : empty
              ? 'empty'
              : 'missing',
        id,
        needleIds: row.needleIds,
        changedBy,
        needle: needleText(parts),
        pristineNeedle: row.needle,
        calls: row.calls,
        detail: empty
          ? 'the override is empty, so the rewritten text lacks the needle'
          : changedBy.length
            ? `${changedBy.join(', ')} rewrote the needle and this paragraph no longer spells it`
            : 'the override no longer contains the needle',
      });
    }
  }
  return { failures, notes };
};
