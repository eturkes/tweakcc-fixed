#!/usr/bin/env node
// Batched corpus-wide search for the stage-1 audit. This IS the corpus-wide
// duplication search the audit rules require, not a shortlist that replaces
// it: every query runs against every deployed body in the active set
// (inline-*.md included), every system-reminder body, and catalogue pristine
// for each id with no override. One call answers every claim of every id.
//
//   node tools/auditCorpusSearch.mjs --packet <audit-packet-NN.json> --in <queries.json> [--out <result.json>]
//   node tools/auditCorpusSearch.mjs --manifest <packetDir>/audit-manifest.json --in - < queries.json
//
// --text prints the results as compact text on stdout (the JSON still goes to
// --out), so an agent reads the answer from the command's own output instead
// of parsing the JSON in further calls.
//
// queries.json:
//   {
//     "queries": [
//       { "forId": "<assigned id>", "q": "exact claim or phrase" },
//       { "forId": "<assigned id>", "q": ["term", "term"], "mode": "terms" },
//       { "forId": "<assigned id>", "q": "phrase", "mode": "phrase", "limit": 25 }   // default 6 per section
//     ],
//     "siblings":   ["<id>", ...],   // texts emitted from the same function
//     "neighbours": ["<id>", ...]    // nearest deployed bodies by similarity
//   }
//
// mode "auto" (default) runs the phrase search and falls back to the terms
// search when the phrase has no exact or normalized hit. Every hit carries its
// carrier's state (suppressed, shadowedBy, source) and, when forId is set, a
// coRender relation that is an UNPROVEN syntactic hint.
import fs from 'node:fs';
import path from 'node:path';
import {
  openIndex,
  phraseSearch,
  termsSearch,
  neighbours,
  emitterSiblings,
  hintLine,
  CORENDER_NOTE,
} from './lib/auditCorpus.mjs';

const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const usage = () => {
  console.error(
    'usage: auditCorpusSearch.mjs (--packet <packet.json> | --manifest <audit-manifest.json>) --in <queries.json|-> [--out <result.json>] [--text] [--rebuild]'
  );
  process.exit(2);
};

const src = opt('packet') || opt('manifest');
if (!src || !opt('in')) usage();
const holder = JSON.parse(fs.readFileSync(src, 'utf8'));
const corpus = holder.corpus;
if (!corpus || !corpus.catalogue || !corpus.activeSet) {
  console.error(
    `${src}: no corpus block — rebuild packets with tools/buildAuditPacket.mjs`
  );
  process.exit(2);
}

const inText =
  opt('in') === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(opt('in'), 'utf8');
let req;
try {
  req = JSON.parse(inText);
} catch (e) {
  console.error(`queries are not valid JSON: ${e.message}`);
  process.exit(2);
}
if (Array.isArray(req)) req = { queries: req };
const queries = Array.isArray(req.queries) ? req.queries : [];

const t0 = Date.now();
const { index, cached } = openIndex({
  catalogue: corpus.catalogue,
  activeSet: corpus.activeSet,
  remindersDir: corpus.remindersDir || null,
  bundle: corpus.bundle || null,
  cachePath: corpus.index || null,
  rebuild: argv.includes('--rebuild'),
  log: m => console.error(`auditCorpusSearch: ${m}`),
});
const openMs = Date.now() - t0;

// Empty sections are left out: a query with no hit anywhere reads as
// {"n", "forId", "q", "hits": 0}.
const section = r =>
  r && r.total
    ? {
        total: r.total,
        ...(r.truncated ? { truncated: true } : {}),
        ...(r.need != null ? { need: r.need, of: r.terms.length } : {}),
        hits: r.hits,
      }
    : null;
const compact = r => {
  const out = { n: r.n, forId: r.forId, q: r.q };
  if (r.mode !== 'auto') out.mode = r.mode;
  for (const k of ['warning', 'error']) if (r[k]) out[k] = r[k];
  let hits = 0;
  for (const k of ['exact', 'normalized', 'terms']) {
    const sec = section(r[k]);
    if (sec) {
      out[k] = sec;
      hits += sec.total;
    }
  }
  if (r.selfMatch) out.selfMatch = true;
  if (!hits && !out.error) out.hits = 0;
  return out;
};

const flags = h =>
  [
    h.rel,
    h.kind,
    h.pristine ? 'pristine' : null,
    h.suppressed ? 'SUPPRESSED' : null,
    h.shadowedBy ? `shadowed-by ${h.shadowedBy.join(',')}` : null,
    h.score != null ? `score ${h.score}` : null,
    h.matched != null ? `${h.matched} terms` : null,
  ]
    .filter(Boolean)
    .join(', ');
const oneLine = s => String(s).replace(/\s+/g, ' ');
function renderText(o) {
  const L = [`# ${o.note}`];
  for (const r of o.results) {
    L.push(
      `q${r.n} [${r.forId || '-'}] ${JSON.stringify(r.q)}${r.mode ? ` (${r.mode})` : ''}`
    );
    if (r.error) L.push(`  error: ${r.error}`);
    if (r.warning) L.push(`  warning: ${r.warning}`);
    if (r.selfMatch) L.push('  (also in the asking id itself)');
    for (const k of ['exact', 'normalized', 'terms']) {
      const sec = r[k];
      if (!sec) continue;
      L.push(
        `  ${k} ${sec.total}${sec.truncated ? ' (truncated; raise limit)' : ''}${sec.need != null ? ` (need ${sec.need}/${sec.of} terms)` : ''}:`
      );
      for (const h of sec.hits)
        L.push(`   - ${h.id} [${flags(h)}] «${oneLine(h.snippet)}»`);
    }
    if (r.hits === 0) L.push('  no hit anywhere in the corpus');
  }
  for (const [k, title] of [
    ['siblings', 'emitter siblings'],
    ['neighbours', 'nearest bodies'],
  ]) {
    if (!o[k]) continue;
    L.push(`## ${title}`);
    for (const [id, v] of Object.entries(o[k])) {
      L.push(
        `${id}: ${Array.isArray(v) ? v.join(' | ') || 'none' : JSON.stringify(v)}`
      );
    }
  }
  return L.join('\n') + '\n';
}

const t1 = Date.now();
const raw = queries.map((qq, n) => {
  const forId = typeof qq.forId === 'string' && qq.forId ? qq.forId : null;
  const limit = Math.max(1, Math.min(100, Number(qq.limit) || 6));
  const mode = qq.mode || 'auto';
  const base = { n, forId, q: qq.q, mode };
  if (forId && !index.byId.has(forId))
    base.warning = `forId ${forId} is not in the corpus; coRender omitted`;
  const fid = forId && index.byId.has(forId) ? forId : null;
  if (typeof qq.q !== 'string' && !Array.isArray(qq.q)) {
    return { ...base, error: 'q must be a string or an array of terms' };
  }
  if (mode === 'terms' || Array.isArray(qq.q)) {
    return { ...base, terms: termsSearch(index, qq.q, { forId: fid, limit }) };
  }
  if (!qq.q.trim()) return { ...base, error: 'empty q' };
  const p = phraseSearch(index, qq.q, { forId: fid, limit });
  const out = { ...base, ...p };
  if (mode === 'auto' && !p.exact.total && !p.normalized.total) {
    out.terms = termsSearch(index, qq.q, {
      forId: fid,
      limit: Math.min(limit, 4),
    });
  }
  return out;
});
const results = raw.map(compact);

const listOf = v =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
const siblings = {};
for (const id of listOf(req.siblings)) {
  if (!index.byId.has(id)) siblings[id] = { error: 'not in corpus' };
  else {
    const r = emitterSiblings(index, id, { limit: 15 });
    siblings[id] = [
      ...r.siblings.map(hintLine),
      ...(r.truncated ? [`+${r.total - r.siblings.length} more`] : []),
    ];
  }
}
const near = {};
for (const id of listOf(req.neighbours)) {
  near[id] = index.byId.has(id)
    ? neighbours(index, id, { limit: 5 }).map(hintLine)
    : { error: 'not in corpus' };
}
const queryMs = Date.now() - t1;

const out = {
  corpusDigest: index.digest,
  corpus: {
    docs: index.docs.length,
    activeSet: corpus.activeSet,
    remindersDir: corpus.remindersDir || null,
    catalogue: corpus.catalogue,
    bundleSites: Boolean(index.bundleSha),
  },
  note: CORENDER_NOTE,
  timing: { openMs, queryMs, indexCached: cached },
  results,
  ...(Object.keys(siblings).length ? { siblings } : {}),
  ...(Object.keys(near).length ? { neighbours: near } : {}),
};
const text = JSON.stringify(out, null, 1);
const dest = opt('out');
if (dest) {
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  fs.writeFileSync(dest, text);
}
if (argv.includes('--text')) process.stdout.write(renderText(out));
else if (!dest) process.stdout.write(text + '\n');
const hits = results.reduce(
  (a, r) =>
    a +
    (r.exact?.total || 0) +
    (r.normalized?.total || 0) +
    (r.terms?.total || 0),
  0
);
const empty = results.filter(r => r.hits === 0).length;
console.error(
  `auditCorpusSearch: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, ${hits} hit(s), ${empty} with none, over ${index.docs.length} docs; ` +
    `open ${openMs} ms (${cached ? 'cached' : 'built'}), query ${queryMs} ms${dest ? ` -> ${dest}` : ''}`
);
