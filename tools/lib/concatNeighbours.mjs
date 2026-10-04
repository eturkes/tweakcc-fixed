// The fragments a prompt is CONCATENATED with in the bundle.
//
// A catalogued id is often one operand of `'…Err on the side of not ' +
// 'suggesting anything until you have confidence. …'`, or one element of an
// array that is joined into one text. A sentence can then span two ids: cutting
// one id's half leaves the other's half broken ("…Err on the side of not If
// it's truly consequential…"). Emitter siblings do not show this (they are
// every text in the function); this finds the direct neighbours of each site's
// literal in its `+` chain or array, and says whether the boundary falls inside
// a sentence.
//
// Each neighbour: {side: 'before'|'after', how: '+'|'array', join?, id|null,
// text|null, expr?, offset, crossesSentence: true|false|null}. A neighbour that
// is an expression rather than a literal has text null and crossesSentence
// null (unknown).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const LITERAL = new Set(['StringLiteral', 'TemplateLiteral']);
const SKIP = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'range',
  'type',
]);

const children = node => {
  const out = [];
  for (const k of Object.keys(node)) {
    if (SKIP.has(k)) continue;
    const v = node[k];
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.start === 'number') out.push(c);
    } else if (typeof v.start === 'number') out.push(v);
  }
  return out;
};

// Outer→inner chain of nodes containing `at` (segment-relative).
const pathTo = (root, at) => {
  const chain = [];
  let node = root;
  while (node) {
    chain.push(node);
    node = children(node).find(c => c.start <= at && at < c.end) || null;
  }
  return chain;
};

export const literalText = node => {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    let s = '';
    node.quasis.forEach((q, i) => {
      s += q.value.cooked ?? q.value.raw;
      if (i < node.expressions.length) s += '${…}';
    });
    return s;
  }
  return null;
};

// Whether text L followed directly by text R continues one sentence.
export const crossesSentence = (left, right) => {
  if (left == null || right == null) return null;
  if (!left.trim() || !right.trim()) return false;
  if (/\n\s*$/.test(left) || /^\s*\n/.test(right)) return false;
  return !/[.!?](["'’”)\]]*)\s*$/.test(left);
};

const flattenPlus = node =>
  node.type === 'BinaryExpression' && node.operator === '+'
    ? [...flattenPlus(node.left), ...flattenPlus(node.right)]
    : [node];

export const findConcatNeighbours = ({ src, targets, siteOwner }) => {
  const { splitModuleBundle } = require('./moduleBundle.cjs');
  const parser = require('@babel/parser');
  const segs = splitModuleBundle(src) || [
    { name: '<bundle>', start: 0, source: src },
  ];
  const segOf = off => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= off) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.start <= off && off < s.start + s.source.length ? s : null;
  };
  const asts = new Map();
  const astOf = seg => {
    if (!asts.has(seg.name)) {
      let ast = null;
      try {
        ast = parser.parse(seg.source, {
          sourceType: 'module',
          plugins: ['jsx'],
          errorRecovery: true,
        });
      } catch {
        ast = null;
      }
      asts.set(seg.name, ast);
    }
    return asts.get(seg.name);
  };

  const out = new Map();
  for (const [id, offsets] of targets) {
    const rows = [];
    const seen = new Set();
    for (const off of offsets) {
      const seg = segOf(off);
      if (!seg) continue;
      const ast = astOf(seg);
      if (!ast) continue;
      const base = seg.start;
      const chain = pathTo(ast.program, off - base);
      let li = -1;
      for (let i = chain.length - 1; i >= 0; i--) {
        if (LITERAL.has(chain[i].type)) {
          li = i;
          break;
        }
      }
      if (li < 0) continue;
      const lit = chain[li];
      const own = literalText(lit);
      const parent = chain[li - 1];
      let operands = null;
      let how = null;
      let join;
      if (
        parent &&
        parent.type === 'BinaryExpression' &&
        parent.operator === '+'
      ) {
        let top = li - 1;
        while (
          top > 0 &&
          chain[top - 1].type === 'BinaryExpression' &&
          chain[top - 1].operator === '+'
        )
          top--;
        operands = flattenPlus(chain[top]);
        how = '+';
      } else if (parent && parent.type === 'ArrayExpression') {
        operands = parent.elements.filter(Boolean);
        how = 'array';
        const member = chain[li - 2];
        const call = chain[li - 3];
        if (
          member &&
          member.type === 'MemberExpression' &&
          member.object === parent &&
          ((member.property.type === 'Identifier' &&
            member.property.name === 'join') ||
            (member.property.type === 'StringLiteral' &&
              member.property.value === 'join')) &&
          call &&
          call.type === 'CallExpression' &&
          call.callee === member
        ) {
          const a = call.arguments[0];
          join = !a ? ',' : a.type === 'StringLiteral' ? a.value : null;
        } else join = null;
      }
      if (!operands) continue;
      const i = operands.indexOf(lit);
      if (i < 0) continue;
      for (const [side, j] of [
        ['before', i - 1],
        ['after', i + 1],
      ]) {
        const n = operands[j];
        if (!n) continue;
        const abs = n.start + base;
        const key = `${side}:${abs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text = LITERAL.has(n.type) ? literalText(n) : null;
        const owner = text != null ? siteOwner(abs, n.end + base) : null;
        if (owner === id) continue;
        const sep = how === 'array' ? join : '';
        let crosses;
        if (how === 'array' && join == null) crosses = null;
        else if (sep && sep.includes('\n')) crosses = false;
        else
          crosses =
            side === 'after'
              ? crossesSentence(own + sep, text)
              : crossesSentence(text == null ? null : text + sep, own);
        rows.push({
          side,
          how,
          ...(how === 'array' ? { join: join ?? null } : {}),
          id: owner,
          text,
          ...(text == null
            ? { expr: seg.source.slice(n.start, Math.min(n.end, n.start + 80)) }
            : {}),
          offset: abs,
          crossesSentence: crosses,
        });
      }
    }
    if (rows.length) out.set(id, rows);
  }
  return out;
};

// siteOwner over every located catalogue site: the id whose site falls inside
// [start, end).
export const siteOwnerFrom = index => {
  const pts = [];
  for (const [idx, list] of index.sitesByIdx) {
    for (const s of list) pts.push([s.offset, index.docs[idx].id]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return (start, end) => {
    let lo = 0;
    let hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] < start) lo = mid + 1;
      else hi = mid;
    }
    return lo < pts.length && pts[lo][0] < end ? pts[lo][1] : null;
  };
};
