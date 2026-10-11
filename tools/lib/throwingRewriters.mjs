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

  // Every Identifier node spelled `name`, bindings and properties included.
  identsNamed(name) {
    if (!this.idents) {
      this.idents = new Map();
      for (const n of this.parent.keys()) {
        if (n.type !== 'Identifier') continue;
        if (!this.idents.has(n.name)) this.idents.set(n.name, []);
        this.idents.get(n.name).push(n);
      }
    }
    return this.idents.get(name) || [];
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
      // errorRecovery hands back a tree with the broken spans skipped; what
      // they held is unknown, so it counts as a parse failure.
      for (const e of ast?.errors || [])
        this.parseErrors.push({ module: name, message: e.message });
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
  if (FN_TYPES.has(e.node.type))
    return b.mod.reassignments(b).length ? null : e.node;
  return null;
};

// The one expression a function always returns, or null when its body does
// anything else first.
const soleReturn = fn => {
  if (fn.async || fn.generator) return null;
  if (fn.body.type !== 'BlockStatement') return fn.body;
  const [only, ...rest] = fn.body.body;
  return !rest.length && only?.type === 'ReturnStatement' && only.argument
    ? only.argument
    : null;
};

// The property `key` of a const object literal, or null.
const constProp = (bundle, m, node) => {
  if (node.object.type !== 'Identifier') return null;
  const want = node.computed
    ? node.property.type === 'StringLiteral'
      ? node.property.value
      : null
    : keyName(node.property);
  if (want == null) return null;
  const b = bundle.resolveIdent(m, node.object);
  const init = constInit(b);
  if (!init || init.type !== 'ObjectExpression') return null;
  const prop = init.properties.find(
    p => p.type === 'ObjectProperty' && !p.computed && keyName(p.key) === want
  );
  return prop ? { m: b.mod, node: prop.value } : null;
};

const MATCH_METHODS = new Set(['includes', 'indexOf', 'startsWith', 'search']);
const REPLACE_METHODS = new Set(['replaceAll', 'replace']);

const isIdent = (n, name) => n && n.type === 'Identifier' && n.name === name;

// Every node under `root`, nested functions included.
const allNodes = function* (root) {
  const stack = childrenOf(root).reverse();
  while (stack.length) {
    const n = stack.pop();
    yield n;
    stack.push(...childrenOf(n).reverse());
  }
};

// The name a replacement argument hands back: `r`, or `()=>r`.
const replacementName = arg => {
  if (!arg) return null;
  if (arg.type === 'Identifier') return arg.name;
  if (FN_TYPES.has(arg.type) && !arg.params.length) {
    const r = soleReturn(arg);
    return r && r.type === 'Identifier' ? r.name : null;
  }
  return null;
};

// `t.replaceAll(n,r)`, `t.replace(n,()=>r)` or `t.split(n).join(r)` with t the
// text.
const replaceOf = (call, needle, repl) => {
  if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression')
    return null;
  const method = keyName(call.callee.property);
  if (
    REPLACE_METHODS.has(method) &&
    isIdent(call.arguments[0], needle) &&
    replacementName(call.arguments[1]) === repl &&
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

const throwsIn = n =>
  n.type === 'ThrowStatement' ||
  [...ownNodes(n)].some(x => x.type === 'ThrowStatement');

// `if(!t.includes(x))throw …`, the check anywhere in the test (also inside a
// callback: `if(!a.every(([n])=>t.includes(n)))throw`). With `textNames`, the
// searched value must be one of them.
const isThrowGuard = (n, textNames = null) =>
  n.type === 'IfStatement' &&
  throwsIn(n.consequent) &&
  [n.test, ...allNodes(n.test)].some(
    x =>
      x.type === 'CallExpression' &&
      x.callee.type === 'MemberExpression' &&
      MATCH_METHODS.has(keyName(x.callee.property)) &&
      x.arguments[0]?.type === 'Identifier' &&
      (!textNames ||
        (x.callee.object.type === 'Identifier' &&
          textNames.has(x.callee.object.name)))
  );

// The [needle, replacement] names a loop binds: `[n,r]` directly, or `x` that
// the body destructures with `let[n,r]=x`.
const pairNames = (bind, body) => {
  let pat = bind;
  if (pat && pat.type === 'VariableDeclaration') pat = pat.declarations[0].id;
  if (pat && pat.type === 'Identifier') {
    const x = pat.name;
    pat = null;
    for (const n of [body, ...ownNodes(body)])
      if (
        n.type === 'VariableDeclarator' &&
        n.id.type === 'ArrayPattern' &&
        isIdent(n.init, x)
      ) {
        pat = n.id;
        break;
      }
  }
  if (
    !pat ||
    pat.type !== 'ArrayPattern' ||
    pat.elements.length < 2 ||
    pat.elements[0]?.type !== 'Identifier' ||
    pat.elements[1]?.type !== 'Identifier'
  )
    return null;
  return { needle: pat.elements[0].name, repl: pat.elements[1].name };
};

// Every walk over a parameter's pairs: `for(… of a)` and `a.forEach(cb)`.
const pairLoops = function* (fn, sc) {
  for (const n of ownNodes(fn.body)) {
    if (n.type === 'ForOfStatement' && n.right.type === 'Identifier') {
      const tableIdx = sc.params.get(n.right.name);
      const names = tableIdx === undefined ? null : pairNames(n.left, n.body);
      if (names) yield { tableIdx, body: n.body, ...names };
    } else if (
      n.type === 'CallExpression' &&
      n.callee.type === 'MemberExpression' &&
      keyName(n.callee.property) === 'forEach' &&
      n.callee.object.type === 'Identifier' &&
      FN_TYPES.has(n.arguments[0]?.type)
    ) {
      const tableIdx = sc.params.get(n.callee.object.name);
      const cb = n.arguments[0];
      const names =
        tableIdx === undefined ? null : pairNames(cb.params[0], cb.body);
      if (names) yield { tableIdx, body: cb.body, ...names };
    }
  }
};

// Every pair-table rewriter defined in `m`, throwing or not.
export const rewritersIn = m => {
  const out = [];
  for (const fn of m.fns) {
    if (fn.params.length < 2) continue;
    const sc = m.scopes.get(fn);
    for (const loop of pairLoops(fn, sc)) {
      const { needle, repl, body } = loop;
      let textVar = null;
      for (const n of [body, ...ownNodes(body)]) {
        if (n.type !== 'AssignmentExpression' || n.left.type !== 'Identifier')
          continue;
        const v = replaceOf(n.right, needle, repl);
        if (v && v === n.left.name) textVar = v;
      }
      if (!textVar) continue;
      const textNames = new Set([textVar]);
      let textIdx = sc.params.get(textVar);
      if (textIdx === undefined) {
        const d = (sc.decls.get(textVar) || [])[0];
        const init = d && d.node.type === 'VariableDeclarator' && d.node.init;
        const used =
          init &&
          [init, ...ownNodes(init)].find(
            x => x.type === 'Identifier' && sc.params.has(x.name)
          );
        if (used) {
          textIdx = sc.params.get(used.name);
          textNames.add(used.name);
        }
      }
      out.push({
        mod: m,
        fn,
        name: m.fnName(fn),
        tableIdx: loop.tableIdx,
        textIdx: textIdx === undefined ? null : textIdx,
        throws: [...allNodes(fn.body)].some(n => isThrowGuard(n, textNames)),
        offset: fn.start,
      });
      break;
    }
  }
  return out;
};

// `t.includes(n)`-style calls in a guard's test: [text, value] names.
const guardChecks = n =>
  [n.test, ...allNodes(n.test)]
    .filter(
      x =>
        x.type === 'CallExpression' &&
        x.callee.type === 'MemberExpression' &&
        MATCH_METHODS.has(keyName(x.callee.property)) &&
        x.callee.object.type === 'Identifier' &&
        x.arguments[0]?.type === 'Identifier'
    )
    .map(x => [x.callee.object.name, x.arguments[0], x]);

// `t.replaceAll(n,…)`, `t.replace(n,…)`, `t.split(n)`: [text, value] names.
const replaceChecks = root =>
  [...allNodes(root)]
    .filter(
      x =>
        x.type === 'CallExpression' &&
        x.callee.type === 'MemberExpression' &&
        ['replaceAll', 'replace', 'split'].includes(
          keyName(x.callee.property)
        ) &&
        x.callee.object.type === 'Identifier' &&
        x.arguments[0]?.type === 'Identifier'
    )
    .map(x => [x.callee.object.name, x.arguments[0].name]);

// Whether `id` is destructured out of a pair by a function's parameter, as in
// `a.every(([n])=>t.includes(n))`.
const fromPairParam = (m, id) => {
  const fn = m.enclosingFn(id);
  return (
    !!fn &&
    fn.params.some(
      p =>
        p.type === 'ArrayPattern' &&
        p.elements[0]?.type === 'Identifier' &&
        p.elements[0].name === id.name
    )
  );
};

// Guards that throw when a text lacks a value, in a function (or the one a
// callback sits in) that also replaces that value in that text: the rewriter
// idiom, whatever shape its loop takes. Each must sit in a recognised rewriter.
const throwIdioms = m => {
  const out = [];
  for (const fn of m.fns) {
    for (const n of ownNodes(fn.body)) {
      if (n.type !== 'IfStatement' || !throwsIn(n.consequent)) continue;
      const checks = guardChecks(n);
      if (!checks.length) continue;
      let owner = fn;
      let hit = false;
      for (let k = 0; owner && k < 2 && !hit; k++) {
        const reps = replaceChecks(owner.body);
        hit = checks.some(([text, arg]) =>
          reps.some(
            ([rt, rn]) =>
              rt === text && (rn === arg.name || fromPairParam(m, arg))
          )
        );
        owner = m.enclosingFn(owner);
      }
      if (hit) out.push({ node: n, fn });
    }
  }
  return out;
};

const FOR_PAIR_RE =
  /for\s*\(\s*(?:let|const|var)?\s*\[\s*[$\w]+\s*,\s*[$\w]+\s*\]\s*of\s*[$\w]+\s*\)/g;
const GUARD_RE =
  /\.(?:includes|indexOf|startsWith|search)\([$\w]+\)[^;}]{0,60}?throw\b/g;
const IDENT_REPLACE_RE = /\.(?:replaceAll|replace|split)\([$\w]+[,)]/;

// Modules whose text holds a for-of pair loop, or a throw-on-missing guard,
// with a throw and a replace within reach — the only ones worth parsing to
// look for a rewriter.
const candidateModules = segs =>
  segs.filter(seg => {
    const s = seg.source;
    if (!s.includes('throw')) return false;
    for (const [re, near] of [
      [FOR_PAIR_RE, [0, 1200]],
      [GUARD_RE, [-1500, 1500]],
    ]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s)) !== null) {
        const win = s.slice(Math.max(0, m.index + near[0]), m.index + near[1]);
        if (win.includes('throw') && IDENT_REPLACE_RE.test(win)) return true;
      }
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
    case 'MemberExpression': {
      const prop = constProp(bundle, m, node);
      if (prop) return evalParts(bundle, prop.m, prop.node, depth + 1);
      break;
    }
    case 'CallExpression': {
      // `getNeedle()`: a const function that only returns a constant.
      if (node.arguments.length || node.callee.type !== 'Identifier') break;
      const b = bundle.resolveIdent(m, node.callee);
      const fn = constInit(b);
      const ret = fn && FN_TYPES.has(fn.type) ? soleReturn(fn) : null;
      if (ret) return evalParts(bundle, b.mod, ret, depth + 1);
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
// hole either its constant value or any slot. An override's own slot may also
// be spelled out as the non-empty value it carries. A hole the bundle computes
// at runtime matches nothing: the gate cannot know what text it requires.
export const needleRegex = parts =>
  new RegExp(
    joinParts(parts)
      .map(p =>
        typeof p === 'string'
          ? esc(p)
          : p.value != null
            ? `(?:${esc(p.value)}|${SLOT})`
            : p.slot
              ? `(?:${SLOT}|[^\\n]{1,400}?)`
              : '(?!)'
      )
      .join('')
  );

// Override text as needle parts: its own `${…}` slots become open holes.
const partsFromOverride = text => {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/\$\{[^}\n]*\}/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ hole: true, value: null, slot: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

// A needle as text: holes as their values, and as the catalogue spells a slot
// (`${}`), which is how an id carrying a templated needle reads.
const spellingsOf = parts => [
  ...new Set([
    needleText(parts),
    parts.map(p => (typeof p === 'string' ? p : '${}')).join(''),
  ]),
];

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

// The expression whose source spells a needle: through const bindings, const
// object members and constant-returning functions, as evalParts reads it.
const needleSource = (bundle, m, node) => {
  for (let depth = 0; depth < 12; depth++) {
    let next = null;
    if (node.type === 'Identifier') {
      const b = bundle.resolveIdent(m, node);
      const init = constInit(b);
      if (init && !FN_TYPES.has(init.type)) next = { m: b.mod, node: init };
    } else if (node.type === 'MemberExpression') {
      next = constProp(bundle, m, node);
    } else if (
      node.type === 'CallExpression' &&
      !node.arguments.length &&
      node.callee.type === 'Identifier'
    ) {
      const b = bundle.resolveIdent(m, node.callee);
      const fn = constInit(b);
      const ret = fn && FN_TYPES.has(fn.type) ? soleReturn(fn) : null;
      if (ret) next = { m: b.mod, node: ret };
    }
    if (!next) break;
    ({ m, node } = next);
  }
  return { m, node };
};

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
        const parts = joinParts(evalParts(bundle, pm, nn));
        const at = `${pm.name || '<bundle>'}@${nn.start}`;
        if (parts.some(p => typeof p !== 'string' && p.value == null)) {
          acc.unresolved.push({
            where: at,
            reason:
              `needle ${JSON.stringify(needleText(parts).slice(0, 80))} has a ` +
              'part computed at runtime, so no override can be checked against it',
          });
          continue;
        }
        if (!needleText(parts).trim()) {
          acc.unresolved.push({
            where: at,
            reason: 'needle is empty, so it matches any text',
          });
          continue;
        }
        const src = needleSource(bundle, pm, nn);
        acc.entries.push({
          parts,
          start: src.node.start,
          end: src.node.end,
          module: src.m.name,
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

// Whether `id` under `p` names something without reading the binding's value:
// a call's callee, a declaration, an import or export specifier, a property
// key, or the target of an assignment.
const NON_REFERENCE = (p, id) => {
  switch (p.type) {
    case 'CallExpression':
      return p.callee === id;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'VariableDeclarator':
      return p.id === id;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return true;
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      return p.property === id && !p.computed;
    case 'ObjectProperty':
      return p.key === id && !p.computed && !p.shorthand;
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ClassProperty':
      return p.key === id && !p.computed;
    case 'AssignmentExpression':
      return p.left === id;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true;
    default:
      return false;
  }
};

// Every concrete call of a throwing rewriter, through wrappers and imports.
const callSites = (bundle, rewriter) => {
  const sites = [];
  const unresolved = [];
  const done = new Set();
  const neverCalled = new Set();
  // A wrapper reached twice with different fixed arguments is two traversals:
  // `w(t,f){return f?Oq(t,A):Oq(t,B)}` must check both A and B.
  const ids = new Map();
  const idOf = arg => {
    if (!arg) return '-';
    if (!ids.has(arg.node)) ids.set(arg.node, ids.size);
    return ids.get(arg.node);
  };
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

  // A function value that leaves by any route but a direct call (`const W=Oq`,
  // `{rw:Oq}`, a callback argument) reaches the rewriter through calls this
  // traversal cannot see.
  const escapesChecked = new Set();
  const escapes = (c, h) => {
    const k = `${h.m.name}\0${h.name}`;
    if (escapesChecked.has(k)) return;
    escapesChecked.add(k);
    for (const id of h.m.identsNamed(h.name)) {
      const p = h.m.parent.get(id);
      if (!p || NON_REFERENCE(p, id)) continue;
      const b = h.m.lookup(id, h.name);
      if (!b) continue;
      if (h.imported ? b.kind !== 'import' : !h.m.sameBinding(b, h.decl))
        continue;
      unresolved.push({
        where: `${h.m.name}@${id.start}`,
        reason:
          `${c.name} (${c.via.join(' <- ')}) is used as a value (${p.type}), ` +
          'so calls made through it are not traced',
      });
    }
  };

  while (queue.length) {
    const c = queue.shift();
    const key = [
      c.mod.name,
      c.name,
      c.tableIdx,
      c.textIdx,
      idOf(c.fixedTable),
      idOf(c.fixedText),
    ].join('\0');
    if (done.has(key)) continue;
    done.add(key);
    let found = 0;
    for (const h of homes(c.mod, c.name)) {
      escapes(c, h);
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
    const wrapper = `${c.mod.name}\0${c.name}`;
    if (!found && !neverCalled.has(wrapper)) {
      neverCalled.add(wrapper);
      unresolved.push({
        where: `${c.mod.name}`,
        reason:
          c.via.length > 1
            ? `wrapper ${c.name} (${c.via.join(' <- ')}) is never called by name`
            : `rewriter ${c.name} is never called by name`,
      });
    }
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
    if (!m) continue;
    const mine = rewritersIn(m).filter(r => r.throws);
    rewriters.push(...mine);
    const fns = new Set(mine.map(r => r.fn));
    for (const idiom of throwIdioms(m)) {
      let f = idiom.fn;
      while (f && !fns.has(f)) f = m.enclosingFn(f);
      if (!f)
        problems.push({
          kind: 'unrecognised',
          where: `${m.name || '<bundle>'}@${idiom.node.start}`,
          reason:
            'a guard throws when text lacks a value the function then ' +
            'replaces, but no rewriter shape was recognised around it',
        });
    }
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
    const spellings = spellingsOf(row.parts);
    for (const id of byId.keys()) {
      const forms = cookedOf(id)
        .map(f => f.trim())
        .filter(f => f.length >= 8);
      if (!forms.some(f => spellings.some(t => t.includes(f)))) continue;
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
  const unparsed = new Map();
  for (const e of bundle.parseErrors)
    if (!unparsed.has(e.module)) unparsed.set(e.module, e.message);
  for (const [module, message] of unparsed)
    problems.push({
      kind: 'unparsed',
      where: module || '<bundle>',
      reason: `a module the analysis reads did not parse cleanly: ${message}`,
    });
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

// The needle once an override replaces one id's pristine text inside it, or
// null when no entry of that id lines up with any spelling of the needle. The
// override is cooked the same way as the pristine form that lined up.
const patchSpelling = (spellings, pristineBodies, ov) => {
  const ovForms = cookedForms(ov);
  for (const body of pristineBodies) {
    const forms = cookedForms(body);
    for (let i = 0; i < forms.length; i++) {
      const pc = forms[i].trim();
      if (!pc) continue;
      const repl = (ovForms[i] ?? ovForms.at(-1)).trim();
      for (const whole of spellings) {
        if (whole.trim() === pc) return leadWs(whole) + repl + trailWs(whole);
        if (whole.includes(pc)) return whole.replace(pc, () => repl);
      }
    }
  }
  return null;
};

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
    let spellings = spellingsOf(row.parts);
    const changedBy = [];
    const unpatched = [];
    for (const id of row.needleIds) {
      const ov = overrideOf(id);
      if (ov == null) continue;
      const pristine = pristineBodies(id);
      if (pristine.some(b => b.trim() === ov.trim())) continue;
      changedBy.push(id);
      const patched = patchSpelling(spellings, pristine, ov);
      if (patched == null) {
        unpatched.push(id);
        continue;
      }
      spellings = [patched];
      parts = partsFromOverride(patched);
    }
    if (unpatched.length) {
      failures.push({
        kind: 'unpatchable',
        id: unpatched.join(', '),
        needle: row.needle,
        calls: row.calls,
        detail:
          'the override changes text the needle is built from, but the gate ' +
          'cannot place its pristine text in the needle to compute what the ' +
          'patched bundle requires',
      });
      continue;
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
