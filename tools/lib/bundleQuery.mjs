// Many bundle lookups in one call, answered from one load.
//
// Classify and audit agents used to answer "what code surrounds this offset",
// "who calls this function", "where is this option set" and "which catalogued
// prompt says this" with one ad-hoc python probe per question, each reloading
// the 40 MB bundle and each costing a full agent turn. BundleIndex answers a
// whole list of such questions against one loaded bundle and the per-bundle
// route cache buildClassifyEvidence writes (literal sites + the tracer's
// serialised summary), so an agent collects its lookups and spends one turn.
//
// Answers are evidence, never verdicts: every hit carries its offset and the
// minified code around it, so the agent can check what it relies on.
import { RouteProgram } from './emissionRoute.mjs';

const isFn = n =>
  n &&
  (n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression');

const oneLine = s => s.replace(/\s+/g, ' ');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Properties too generic to say anything about one call path.
const COMMON_PROPS = new Set([
  'length', 'type', 'name', 'value', 'message', 'error', 'code', 'size',
  'data', 'content', 'kind', 'id', 'status', 'text', 'result', 'key', 'path',
  'options', 'props', 'children', 'current', 'then', 'catch', 'default',
]);

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeCtl = s =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
const escapeUnicode = s =>
  s.replace(
    /[^\x20-\x7e]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );

export const pieceText = p =>
  (p.pieces || [])
    .map(x => (typeof x === 'string' ? x : '${…}'))
    .join('') ||
  p.content ||
  '';

export class BundleIndex {
  // code: the bundle; program: a RouteProgram over it (fromJSON of the route
  // cache, or fresh); sites: Map(sha1(body) -> [[start, end, kind]]) of every
  // indexed literal; classification: {sha1: {facing, id?}}; catalogue: the
  // prompts array of prompts-X.Y.Z.json.
  constructor({ code, program, sites = null, classification = null, catalogue = null }) {
    this.code = code;
    this.program = program || new RouteProgram(code);
    this.sites = sites || new Map();
    this.classification = classification || {};
    this.catalogue = catalogue || [];
    this.sorted = [...this.sites.entries()]
      .flatMap(([h, list]) => list.map(s => [s[0], s[1], s[2], h]))
      .sort((a, b) => a[0] - b[0]);
    this.importersOf = null;
  }

  // ---- positions -----------------------------------------------------------
  literalAt(abs) {
    const a = this.sorted;
    let lo = 0;
    let hi = a.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] <= abs) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = best; i >= 0 && i > best - 64; i--) {
      if (a[i][0] <= abs && abs < a[i][1]) return a[i];
    }
    return null;
  }
  literalsIn(start, end) {
    const a = this.sorted;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] < start) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < a.length && a[i][0] < end; i++) out.push(a[i]);
    return out;
  }

  // Innermost-first chain of AST nodes containing `abs`, with the module.
  nodePath(abs) {
    const m = this.program.moduleAt(abs);
    if (!m || m.failed) return null;
    const rel = abs - m.base;
    const path = [];
    let n = m.ast;
    while (n) {
      path.push(n);
      let next = null;
      for (const key in n) {
        if (key === 'parent' || key === 'loc') continue;
        const c = n[key];
        if (!c || typeof c !== 'object') continue;
        const arr = Array.isArray(c) ? c : [c];
        for (const x of arr) {
          if (x && typeof x.type === 'string' && x.start <= rel && rel < x.end) {
            next = x;
            break;
          }
        }
        if (next) break;
      }
      n = next;
    }
    return { m, path: path.reverse() };
  }

  fnInfo(m, fn) {
    const start = m.base + fn.start;
    const end = m.base + fn.end;
    let name = fn.id ? fn.id.name : null;
    const p = fn.parent;
    if (!name && p) {
      if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier') name = p.id.name;
      else if ((p.type === 'Property' || p.type === 'MethodDefinition') && p.key)
        name = p.key.name || String(p.key.value);
      else if (p.type === 'AssignmentExpression')
        name = oneLine(this.code.slice(m.base + p.left.start, m.base + p.left.end)).slice(0, 40);
    }
    return {
      start,
      end,
      name,
      module: m.seg.name.replace(/^\/\$bunfs\/root\//, ''),
      head: oneLine(this.code.slice(start, Math.min(end, start + 90))),
    };
  }

  // Innermost function containing abs, and the outermost function of its
  // inline-callback chain (the "family" function the packets group by).
  enclosing(abs) {
    const np = this.nodePath(abs);
    if (!np) return null;
    const fns = np.path.filter(isFn);
    if (!fns.length) return { m: np.m, path: np.path, inner: null, family: null };
    let fam = fns[0];
    for (let i = 1; i < fns.length; i++) {
      const prev = fns[i - 1];
      const par = prev.parent;
      const passedAsArg =
        par && (par.type === 'CallExpression' || par.type === 'NewExpression') && par.callee !== prev;
      if (prev.type !== 'FunctionDeclaration' && passedAsArg) fam = fns[i];
      else break;
    }
    return {
      m: np.m,
      path: np.path,
      inner: this.fnInfo(np.m, fns[0]),
      family: this.fnInfo(np.m, fam),
      innerNode: fns[0],
      familyNode: fam,
    };
  }

  // Conditions the code at `abs` sits behind, innermost first, up to the
  // family function: which arm of which if / ternary / && / switch case.
  guards(abs, max = 4) {
    const e = this.enclosing(abs);
    if (!e) return [];
    const stopAt = e.familyNode;
    const out = [];
    const { m } = e;
    const src = n => oneLine(this.code.slice(m.base + n.start, m.base + n.end));
    for (let i = 0; i + 1 < e.path.length && out.length < max; i++) {
      const child = e.path[i];
      const par = e.path[i + 1];
      let arm = null;
      let test = null;
      if (par.type === 'IfStatement' && child !== par.test) {
        arm = child === par.consequent ? 'then' : 'else';
        test = par.test;
      } else if (par.type === 'ConditionalExpression' && child !== par.test) {
        arm = child === par.consequent ? 'then' : 'else';
        test = par.test;
      } else if (par.type === 'LogicalExpression' && child === par.right) {
        arm = par.operator === '&&' ? 'then' : 'else';
        test = par.left;
      } else if (par.type === 'SwitchCase' && child !== par.test) {
        arm = par.test ? 'case' : 'default';
        test = par.test || par.parent?.discriminant || null;
      }
      if (arm && test) {
        const props = new Set();
        const walk = n => {
          if (!n || typeof n.type !== 'string') return;
          const isCallee = n.parent && n.parent.type === 'CallExpression' && n.parent.callee === n;
          if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier' && !isCallee)
            props.add(n.property.name);
          if (n.type === 'Property' && n.key && n.key.type === 'Identifier') props.add(n.key.name);
          // A minified local standing for an option: `{replaceInstalledCopy:c}`
          // destructured from a parameter, or `let c=o.replaceInstalledCopy`.
          if (n.type === 'Identifier') {
            const alias = this.optionAlias(m, n);
            if (alias) props.add(alias);
          }
          for (const k in n) {
            if (k === 'parent') continue;
            const c = n[k];
            if (Array.isArray(c)) c.forEach(walk);
            else if (c && typeof c === 'object' && typeof c.type === 'string') walk(c);
          }
        };
        walk(test);
        out.push({
          at: m.base + test.start,
          arm,
          test: clip(src(test), 140),
          props: [...props].filter(p => p.length >= 4 && !COMMON_PROPS.has(p)),
        });
      }
      if (par === stopAt) break;
    }
    return out;
  }

  optionAlias(m, id) {
    const v = m.varOf && m.varOf.get(id);
    const d = v && v.defs[0];
    if (!d || !d.name) return null;
    const par = d.name.parent;
    if (par && par.type === 'Property' && par.value === d.name && par.parent && par.parent.type === 'ObjectPattern' && par.key) {
      return par.key.type === 'Identifier' ? par.key.name : typeof par.key.value === 'string' ? par.key.value : null;
    }
    if (par && par.type === 'AssignmentPattern' && par.left === d.name) {
      const pp = par.parent;
      if (pp && pp.type === 'Property' && pp.parent && pp.parent.type === 'ObjectPattern' && pp.key && pp.key.type === 'Identifier') return pp.key.name;
    }
    if (d.type === 'Variable' && d.node && d.node.init && d.node.init.type === 'MemberExpression' && !d.node.init.computed && d.node.init.property.type === 'Identifier') {
      return d.node.init.property.name;
    }
    return null;
  }

  // Destructured props of every function around `abs`, innermost first:
  // `function vl({setError:k,setResult:v})` -> [['setError','k'],['setResult','v']].
  // A view that receives a setter pair passes one of them to each outcome;
  // which minified local is which decides facing (setResult reaches onDone,
  // setError a local error state).
  aliases(abs, max = 4) {
    const np = this.nodePath(abs);
    if (!np) return [];
    const { m } = np;
    const out = [];
    const pairsOf = pat => {
      const pairs = [];
      if (!pat || pat.type !== 'ObjectPattern') return pairs;
      for (const p of pat.properties) {
        if (p.type !== 'Property' || !p.key) continue;
        const key = p.key.type === 'Identifier' ? p.key.name : typeof p.key.value === 'string' ? p.key.value : null;
        const v = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
        if (key && v && v.type === 'Identifier') pairs.push([key, v.name]);
      }
      return pairs;
    };
    for (const fn of np.path.filter(isFn)) {
      const pairs = [];
      for (const prm of fn.params) pairs.push(...pairsOf(prm.type === 'AssignmentPattern' ? prm.left : prm));
      if (fn.body && fn.body.type === 'BlockStatement') {
        for (const st of fn.body.body) {
          if (st.type !== 'VariableDeclaration') continue;
          for (const d of st.declarations) pairs.push(...pairsOf(d.id));
        }
      }
      if (pairs.length) out.push({ fn: this.fnInfo(m, fn), pairs });
      if (out.length >= max) break;
    }
    return out;
  }

  // How each caller wires the props of the function enclosing `abs`: at every
  // call or JSX render, the source of each prop it passes. Setter wiring can
  // be crosswise at the call site (CC 2.1.288: Discover renders a view with
  // setError: a.setResult, so that view's "errors" reach onDone).
  wiring(abs, max = 6) {
    const e = this.enclosing(abs);
    if (!e || !e.inner) return { fn: null, sites: [] };
    const fn = e.innerNode;
    const keys = new Set();
    const prm = fn.params[0] && (fn.params[0].type === 'AssignmentPattern' ? fn.params[0].left : fn.params[0]);
    if (prm && prm.type === 'ObjectPattern') for (const p of prm.properties) if (p.type === 'Property' && p.key && p.key.type === 'Identifier') keys.add(p.key.name);
    const r = this.program.callersOf(e.inner.start);
    const sites = [...(r.called || []).map(c => [c, 'call']), ...(r.jsxType || []).map(c => [c, 'jsx'])];
    const out = [];
    for (const [cid, how] of sites.slice(0, max)) {
      const at = Number(String(cid).split('+')[0]);
      const np = this.nodePath(at);
      if (!np) continue;
      const call = np.path.find(n => (n.type === 'CallExpression' || n.type === 'NewExpression') && np.m.base + n.start === at) || np.path.find(n => n.type === 'CallExpression');
      if (!call) continue;
      const obj = call.arguments.find(a => a.type === 'ObjectExpression' && a.properties.some(p => p.type === 'Property' && p.key && keys.has(p.key.name)));
      const props = [];
      if (obj) {
        for (const p of obj.properties) {
          if (p.type !== 'Property' || !p.key || p.key.type !== 'Identifier') continue;
          if (keys.size && !keys.has(p.key.name)) continue;
          props.push([p.key.name, clip(oneLine(this.code.slice(np.m.base + p.value.start, np.m.base + p.value.end)), 60)]);
        }
      }
      const ce = this.enclosing(at);
      out.push({ at, how, in: ce && ce.inner ? ce.inner : null, props });
    }
    return { fn: e.inner, total: sites.length, sites: out };
  }

  // The destructured prop a call's minified callee stands for, for the
  // innermost call at or around `abs` (`v(Rn(...))` -> 'setResult').
  calleeAlias(abs) {
    // Offsets from route hops can sit on the punctuation before a call.
    for (const at of [abs, abs + 1, abs + 2, abs - 1]) {
      const r = this.calleeAliasExact(at);
      if (r) return r;
    }
    return null;
  }

  calleeAliasExact(abs) {
    const np = this.nodePath(abs);
    if (!np) return null;
    // Innermost first; a wrapper like Rn(...) inside v(...) is skipped. Stops
    // at the first function boundary.
    for (const n of np.path) {
      if (isFn(n)) break;
      if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier') continue;
      const key = this.optionAlias(np.m, n.callee);
      if (key) return { local: n.callee.name, key, at: np.m.base + n.start };
    }
    return null;
  }

  // ---- lookups -------------------------------------------------------------
  slice(abs, before = 400, after = 400) {
    const a = Math.max(0, abs - before);
    const b = Math.min(this.code.length, abs + after);
    return { from: a, to: b, text: this.code.slice(a, b) };
  }

  callers(abs, depth = 1, breadth = 8) {
    const e = this.enclosing(abs);
    if (!e || !e.inner) return { fn: null, levels: [] };
    const seen = new Set();
    const levels = [];
    let frontier = [e.inner];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      const level = [];
      for (const fn of frontier) {
        if (seen.has(fn.start)) continue;
        seen.add(fn.start);
        const r = this.program.callersOf(fn.start);
        const sites = [...(r.called || []).map(cid => [cid, 'call']), ...(r.jsxType || []).map(cid => [cid, 'jsx'])];
        const calls = sites.slice(0, breadth).map(([cid, how]) => {
          const [s, len] = String(cid).split('+').map(Number);
          const ce = this.enclosing(s);
          const caller = ce && ce.inner ? ce.inner : null;
          // An inline callback (`.map(x=>f(x))`) is called by the runtime;
          // the next level follows the function that hands it over.
          const outer = ce && ce.family && caller && ce.family.start !== caller.start ? ce.family : null;
          if (caller && d + 1 < depth) next.push(outer || caller);
          return {
            at: s,
            how,
            code: clip(oneLine(this.code.slice(Math.max(0, s - 80), s + Math.min(len || 0, 200) + 60)), 360),
            in: caller,
            outer,
            guards: this.guards(s, 2),
          };
        });
        level.push({
          fn,
          total: sites.length,
          calls,
          roles: r.roles || [],
          hofs: (r.hofs || []).slice(0, 4),
          jsxType: (r.jsxType || []).slice(0, 4),
          unresolved: [...new Set((r.unresolved || []).map(u => (typeof u === 'string' ? u : u.reason)))].slice(0, 4),
        });
      }
      levels.push(level);
      frontier = next;
    }
    return { fn: e.inner, family: e.family, levels };
  }

  bindingAt(name, abs) {
    const np = this.nodePath(abs);
    if (!np) return null;
    const { m } = np;
    for (const node of np.path) {
      const sc = m.scope.acquire(node, true) || m.scope.acquire(node);
      for (let s = sc; s; s = s.upper) {
        const v = s.set && s.set.get(name);
        if (v && v.defs.length) return { m, v };
      }
      if (sc) break;
    }
    for (const s of m.scope.scopes) {
      const v = s.set && s.set.get(name);
      if (v && v.defs.length && (s.type === 'module' || s.type === 'global')) return { m, v };
    }
    return null;
  }

  refs(name, abs, max = 25) {
    const b = this.bindingAt(name, abs);
    if (!b) return { binding: null, refs: [] };
    const { m, v } = b;
    const key = m.base + v.defs[0].name.start;
    const out = [];
    const push = (mod, r) => {
      const id = r.identifier;
      const s = mod.base + id.start;
      const par = id.parent;
      const kind =
        par && par.type === 'CallExpression' && par.callee === id
          ? 'call'
          : r.isWrite()
            ? 'write'
            : 'read';
      out.push({ at: s, kind, module: mod.seg.name.replace(/^\/\$bunfs\/root\//, ''), code: clip(oneLine(this.code.slice(Math.max(0, s - 90), s + 140)), 260) });
    };
    for (const r of v.references) push(m, r);
    // Importers of the binding in other modules.
    const p = this.program;
    if (p.scanned && p.importSpec) {
      if (!this.importersOf) {
        this.importersOf = new Map();
        for (const k of p.importSpec.keys()) {
          const t = p.resolveImportAlias(k);
          if (t !== k) (this.importersOf.get(t) || this.importersOf.set(t, []).get(t)).push(k);
        }
      }
      for (const ik of this.importersOf.get(key) || []) {
        const mod = p.moduleAt(ik);
        if (!mod || mod.failed) continue;
        const iv = mod.varByKey.get(ik);
        if (iv) for (const r of iv.references) push(mod, r);
      }
    }
    return {
      binding: { name, at: key, module: m.seg.name.replace(/^\/\$bunfs\/root\//, ''), def: clip(oneLine(this.code.slice(key, key + 120)), 120) },
      total: out.length,
      refs: out.slice(0, max),
    };
  }

  // Where an object property / option is written vs read. Candidates come
  // from a text scan (property keys survive minification); each is then
  // classified on the AST: a key in an object literal SETS the option (its
  // value is shown, so `!1`/`void 0` reads differently from `!0`), a key in a
  // destructuring pattern or a member read READS it.
  prop(name, max = 12) {
    const n = escapeRe(name);
    const re = new RegExp(`(?:[{,]\\s*(?:"|')?|\\??\\.)(${n})(?:"|')?(?![$\\w])`, 'g');
    const groups = { set: [], read: [], other: [] };
    const totals = { set: 0, read: 0, other: 0 };
    let classified = 0;
    let mm;
    while ((mm = re.exec(this.code)) !== null) {
      const at = mm.index + mm[0].indexOf(name);
      let kind = 'other';
      let detail = '';
      if (classified < 400) {
        classified++;
        const np = this.nodePath(at);
        if (np) {
          const { m, path } = np;
          const src = x => oneLine(this.code.slice(m.base + x.start, m.base + x.end));
          for (let i = 0; i < path.length && i < 4; i++) {
            const x = path[i];
            if (x.type === 'Property' && x.key && m.base + x.key.start <= at && at < m.base + x.key.end) {
              const owner = path[i + 1];
              if (owner && owner.type === 'ObjectPattern') {
                kind = 'read';
                detail = 'destructured';
              } else if (owner && owner.type === 'ObjectExpression') {
                kind = 'set';
                detail = `= ${clip(src(x.value), 80)}`;
              }
              break;
            }
            if (x.type === 'MemberExpression' && !x.computed && m.base + x.property.start === at) {
              const par = path[i + 1];
              if (par && par.type === 'AssignmentExpression' && par.left === x) {
                kind = 'set';
                detail = `${par.operator} ${clip(src(par.right), 80)}`;
              } else if (par && par.type === 'UpdateExpression') kind = 'set';
              else kind = 'read';
              break;
            }
          }
        }
      }
      totals[kind]++;
      if (groups[kind].length < max) {
        const e = this.enclosing(at);
        groups[kind].push({ at, detail, in: e && e.inner ? e.inner : null, code: clip(oneLine(this.code.slice(Math.max(0, at - 110), at + 120)), 240) });
      }
    }
    return [
      { kind: 'SET (object literal key or assignment)', total: totals.set, hits: groups.set },
      { kind: 'READ (member read or destructuring)', total: totals.read, hits: groups.read },
      ...(totals.other ? [{ kind: 'unclassified (string text, or beyond the first 400 hits)', total: totals.other, hits: groups.other }] : []),
    ];
  }

  text(t, max = 15) {
    const seen = new Set();
    const hits = [];
    let total = 0;
    for (const needle of [...new Set([t, escapeCtl(t), escapeUnicode(escapeCtl(t))])]) {
      if (!needle) continue;
      for (let i = this.code.indexOf(needle); i >= 0; i = this.code.indexOf(needle, i + 1)) {
        if (seen.has(i)) continue;
        seen.add(i);
        total++;
        if (hits.length >= max) continue;
        const lit = this.literalAt(i);
        const e = this.enclosing(i);
        hits.push({
          at: i,
          literal: lit ? { start: lit[0], end: lit[1], facing: this.facingOf(lit[3]) } : null,
          in: e && e.inner ? e.inner : null,
          code: clip(oneLine(this.code.slice(Math.max(0, i - 120), i + needle.length + 120)), 300 + needle.length),
        });
      }
    }
    return { total, hits };
  }

  regex(src, flags = '', max = 15) {
    const re = new RegExp(src, flags.includes('g') ? flags : `${flags}g`);
    const hits = [];
    let total = 0;
    let mm;
    while ((mm = re.exec(this.code)) !== null) {
      if (mm[0] === '') re.lastIndex++;
      total++;
      if (hits.length < max) {
        const at = mm.index;
        const e = this.enclosing(at);
        hits.push({ at, match: clip(mm[0], 200), in: e && e.inner ? e.inner : null, code: clip(oneLine(this.code.slice(Math.max(0, at - 100), at + Math.min(mm[0].length, 200) + 100)), 420) });
      }
      if (total > 5000) break;
    }
    return { total, hits };
  }

  facingOf(hash) {
    const c = this.classification[hash];
    if (!c) return null;
    return c.id ? `${c.facing} ${c.id}` : c.facing;
  }

  trace(abs) {
    const lit = this.literalAt(abs);
    const start = lit ? lit[0] : abs;
    return { start, route: this.program.trace(start) };
  }

  // Every indexed literal emitted from the family function around `abs`, with
  // the facing the classification cache holds for it.
  siblings(abs, max = 40) {
    const e = this.enclosing(abs);
    if (!e || !e.family) return { fn: null, items: [] };
    const lits = this.literalsIn(e.family.start, e.family.end);
    const items = lits.slice(0, max).map(([s, en, , h]) => ({
      at: s,
      hash: h,
      facing: this.facingOf(h),
      text: clip(oneLine(this.code.slice(s + 1, Math.min(en - 1, s + 140))), 120),
    }));
    return { fn: e.family, total: lits.length, items };
  }

  catalogueSearch(t, max = 12) {
    const q = t.toLowerCase();
    const out = [];
    const seen = new Set();
    for (const p of this.catalogue) {
      if (!p.id) continue;
      const body = pieceText(p);
      const i = body.toLowerCase().indexOf(q);
      const inId = p.id.includes(q);
      if (i < 0 && !inId) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const a = Math.max(0, i - 80);
      out.push({ id: p.id, excerpt: clip(oneLine(i >= 0 ? body.slice(a, i + q.length + 120) : body.slice(0, 200)), 260) });
      if (out.length >= max) break;
    }
    return out;
  }

  // ---- batch ---------------------------------------------------------------
  run(q) {
    if (typeof q !== 'object' || !q) throw new Error('a query is an object, e.g. {"slice":123}');
    if (q.slice != null) return { kind: 'slice', ...this.slice(Number(q.slice), q.before ?? 400, q.after ?? 400) };
    if (q.fn != null) {
      const e = this.enclosing(Number(q.fn));
      if (!e || !e.inner) return { kind: 'fn', none: true };
      const max = q.max ?? 2500;
      const f = e.inner;
      const len = f.end - f.start;
      const source = len <= max ? this.code.slice(f.start, f.end) : `${this.code.slice(f.start, f.start + Math.floor(max * 0.4))}\n  …[${len - max} chars elided; window around ${q.fn}]…\n${this.code.slice(Math.max(f.start, Number(q.fn) - Math.floor(max * 0.3)), Math.min(f.end, Number(q.fn) + Math.floor(max * 0.3)))}`;
      return { kind: 'fn', inner: f, family: e.family.start !== f.start ? e.family : null, guards: this.guards(Number(q.fn)), source };
    }
    if (q.callers != null) return { kind: 'callers', ...this.callers(Number(q.callers), Math.min(3, Math.max(1, q.depth ?? 1)), q.max ?? 8) };
    if (q.refs != null) return { kind: 'refs', ...this.refs(String(q.refs), Number(q.at), q.max ?? 25) };
    if (q.prop != null) return { kind: 'prop', name: q.prop, results: this.prop(String(q.prop), q.max ?? 12) };
    if (q.text != null) return { kind: 'text', ...this.text(String(q.text), q.max ?? 15) };
    if (q.regex != null) return { kind: 'regex', ...this.regex(String(q.regex), q.flags || '', q.max ?? 15) };
    if (q.trace != null) return { kind: 'trace', ...this.trace(Number(q.trace)) };
    if (q.siblings != null) return { kind: 'siblings', ...this.siblings(Number(q.siblings), q.max ?? 40) };
    if (q.catalogue != null) return { kind: 'catalogue', hits: this.catalogueSearch(String(q.catalogue), q.max ?? 12) };
    if (q.guards != null) return { kind: 'guards', guards: this.guards(Number(q.guards), q.max ?? 6) };
    if (q.aliases != null) return { kind: 'aliases', list: this.aliases(Number(q.aliases)), callee: this.calleeAlias(Number(q.aliases)), wiring: this.wiring(Number(q.aliases)) };
    throw new Error(`unknown query ${JSON.stringify(q).slice(0, 80)} — kinds: slice, fn, callers, refs, prop, text, regex, trace, siblings, catalogue, guards, aliases`);
  }
}

const fnLabel = f => (f ? `${f.name ? `${f.name} ` : ''}@${f.start} [${f.module}] ${f.head}` : '(module scope)');
const guardLine = g => `${g.arm} of \`${g.test}\` @${g.at}${g.props.length ? ` (props: ${g.props.join(', ')})` : ''}`;

export function renderRoute(route, { maxSinks = 12, maxOpen = 8 } = {}) {
  const lines = [`verdict: ${route.verdict || 'open'}  resolved: ${route.resolved}`];
  for (const s of route.sinks.slice(0, maxSinks)) {
    lines.push(`sink ${s.kind} [${s.facing ?? 'open'}] @${s.at}${s.command ? ` /${s.command}` : ''}${s.guarded ? ' (behind an instanceof guard)' : ''}${s.via && s.via.length ? ` via ${[].concat(s.via).join(' → ')}` : ''}`);
  }
  if (route.sinks.length > maxSinks) lines.push(`… ${route.sinks.length - maxSinks} more sink(s)`);
  for (const u of route.unresolved.slice(0, maxOpen)) lines.push(`open: ${u.reason} @${u.at ?? '?'}`);
  if (route.unresolved.length > maxOpen) lines.push(`… ${route.unresolved.length - maxOpen} more open branch(es)`);
  return lines.join('\n');
}

export function renderAnswer(a) {
  const L = [];
  switch (a.kind) {
    case 'slice':
      L.push(`@${a.from}..${a.to}`, a.text);
      break;
    case 'fn':
      if (a.none) { L.push('(module scope: no enclosing function)'); break; }
      L.push(`fn ${fnLabel(a.inner)} len ${a.inner.end - a.inner.start}`);
      if (a.family) L.push(`inline callback of ${fnLabel(a.family)}`);
      for (const g of a.guards) L.push(`guard: ${guardLine(g)}`);
      L.push(a.source);
      break;
    case 'callers':
      if (!a.fn) { L.push('(no enclosing function)'); break; }
      a.levels.forEach((level, d) => {
        for (const x of level) {
          L.push(`${'  '.repeat(d)}callers of ${fnLabel(x.fn)}: ${x.total}${x.roles.length ? ` roles: ${x.roles.join(', ')}` : ''}${x.jsxType.length ? ` used as JSX component @${x.jsxType.join(',')}` : ''}${x.hofs.length ? ` handed to ${x.hofs.map(h => `${h.hof}@${h.cs}`).join(', ')}` : ''}`);
          for (const c of x.calls) {
            L.push(`${'  '.repeat(d)}- ${c.how === 'jsx' ? 'rendered as JSX ' : ''}@${c.at} in ${fnLabel(c.in)}${c.outer ? ` (an inline callback of ${fnLabel(c.outer)})` : ''}`);
            L.push(`${'  '.repeat(d)}  ${c.code}`);
            for (const g of c.guards) L.push(`${'  '.repeat(d)}  guard: ${guardLine(g)}`);
          }
          if (x.total > x.calls.length) L.push(`${'  '.repeat(d)}  … ${x.total - x.calls.length} more`);
          for (const u of x.unresolved) L.push(`${'  '.repeat(d)}  open: ${u}`);
        }
      });
      break;
    case 'refs':
      if (!a.binding) { L.push('no binding of that name is visible at that offset'); break; }
      L.push(`binding ${a.binding.name} @${a.binding.at} [${a.binding.module}] ${a.binding.def} — ${a.total} reference(s)`);
      for (const r of a.refs) L.push(`- ${r.kind} @${r.at} [${r.module}] ${r.code}`);
      break;
    case 'prop':
      for (const r of a.results) {
        L.push(`${r.kind}: ${r.total}`);
        for (const h of r.hits) L.push(`- @${h.at}${h.detail ? ` ${h.detail}` : ''} in ${fnLabel(h.in)}\n  ${h.code}`);
        if (r.total > r.hits.length) L.push(`  … ${r.total - r.hits.length} more`);
      }
      break;
    case 'text':
    case 'regex':
      L.push(`${a.total} hit(s)`);
      for (const h of a.hits) {
        L.push(`- @${h.at}${h.literal ? ` in literal @${h.literal.start}${h.literal.facing ? ` (cached: ${h.literal.facing})` : ''}` : ''} in ${fnLabel(h.in)}`);
        L.push(`  ${h.code}`);
      }
      if (a.total > a.hits.length) L.push(`… ${a.total - a.hits.length} more (raise "max")`);
      break;
    case 'trace':
      L.push(`literal @${a.start}`, renderRoute(a.route));
      break;
    case 'siblings':
      if (!a.fn) { L.push('(module scope)'); break; }
      L.push(`literals in ${fnLabel(a.fn)}: ${a.total}`);
      for (const s of a.items) L.push(`- @${s.at} ${s.facing || 'uncached'}: ${s.text}`);
      break;
    case 'catalogue':
      if (!a.hits.length) L.push('no catalogued prompt contains that text');
      for (const h of a.hits) L.push(`- ${h.id}: ${h.excerpt}`);
      break;
    case 'aliases':
      if (a.callee) L.push(`call @${a.callee.at}: ${a.callee.local}(…) is the destructured prop ${a.callee.key}`);
      if (!a.list.length) L.push('no destructured props in the enclosing functions');
      for (const x of a.list) L.push(`- ${fnLabel(x.fn)}: ${x.pairs.map(([k, l]) => `${l}=${k}`).join(', ')}`);
      if (a.wiring && a.wiring.sites.length) {
        L.push(`wired by its ${a.wiring.total} caller(s) (prop = what the caller passes):`);
        for (const w of a.wiring.sites) L.push(`- ${w.how === 'jsx' ? 'rendered' : 'called'} @${w.at} in ${fnLabel(w.in)}: ${w.props.map(([k, v]) => `${k}=${v}`).join(', ') || '(no object of its props)'}`);
      }
      break;
    case 'guards':
      if (!a.guards.length) L.push('no enclosing condition inside its function');
      for (const g of a.guards) L.push(`- ${guardLine(g)}`);
      break;
    default:
      L.push(JSON.stringify(a));
  }
  return L.join('\n');
}
