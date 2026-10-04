#!/usr/bin/env node
// Reconciles every chunk's verdict files against the evidence manifest and
// emits the merged verdict array `driver classify-merge` consumes.
//
//   node tools/harvestClassify.mjs <evidenceDir> [--out <file>] [--allow-unverified]
//
// Classifier and verifier completion are reported separately: a chunk whose
// draft passes but whose verify file is missing or failing is NOT done, and
// the merged file is written only when every chunk is both classified and
// verified (or --allow-unverified is passed, which marks the gap loudly).
// Exit 0 when complete, 1 when any chunk needs a rerun, 2 on usage errors.
import fs from 'node:fs';
import path from 'node:path';
import {
  loadManifest,
  evaluateChunk,
  digestProblems,
} from './lib/classifyVerdicts.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const allowUnverified = args.includes('--allow-unverified');
const dirArg = args.find((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
if (!dirArg) {
  console.error('usage: harvestClassify.mjs <evidenceDir> [--out <file>] [--allow-unverified]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
let m;
try {
  m = loadManifest(dir);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const digest = digestProblems(m);
const rows = [];
for (const c of m.chunks) {
  // The cross-chunk id check runs once below over the whole merged set.
  const cls = evaluateChunk(dir, m, c.chunk, { stage: 'classify', checkFiles: false, otherChunks: false });
  const ver = cls.classified ? evaluateChunk(dir, m, c.chunk, { stage: 'verify', checkFiles: false, otherChunks: false }) : null;
  rows.push({ chunk: c.chunk, cls, ver });
}

const classifiedOk = rows.filter(r => r.cls.classified);
const verifiedOk = rows.filter(r => r.ver && r.ver.verified);
const merged = [];
for (const r of rows) {
  const src = r.ver && r.ver.verified ? r.ver.merged : allowUnverified && r.cls.classified ? r.cls.merged : null;
  if (src) merged.push(...src);
}

// One id names one body across the WHOLE batch.
const byId = new Map();
const dupes = [];
for (const v of merged) {
  if (v.facing !== 'model' || typeof v.id !== 'string') continue;
  const prev = byId.get(v.id);
  if (prev && prev !== v.hash) dupes.push(`${v.id}: ${prev.slice(0, 10)}, ${v.hash.slice(0, 10)}`);
  else byId.set(v.id, v.hash);
}
const expected = new Set(m.chunks.flatMap(c => c.hashes));
const seen = new Set();
const alien = [];
const doubled = [];
for (const v of merged) {
  if (!expected.has(v.hash)) alien.push(v.hash);
  if (seen.has(v.hash)) doubled.push(v.hash);
  seen.add(v.hash);
}

console.log(`harvest ${m.version}: ${m.chunkCount} chunk(s), ${expected.size} candidate(s)`);
console.log(`  classified: ${classifiedOk.length}/${m.chunkCount}   verified: ${verifiedOk.length}/${m.chunkCount}`);
for (const p of digest) console.log(`  ! ${p}`);
const rerunClassify = rows.filter(r => !r.cls.classified);
const rerunVerify = rows.filter(r => r.cls.classified && !(r.ver && r.ver.verified));
for (const r of rerunClassify) console.log(`  classify ${r.chunk}: ${r.cls.problems.slice(0, 3).join(' | ')}${r.cls.problems.length > 3 ? ` (+${r.cls.problems.length - 3})` : ''}`);
for (const r of rerunVerify) console.log(`  verify   ${r.chunk}: ${(r.ver ? r.ver.problems : ['not run']).slice(0, 3).join(' | ')}`);
if (dupes.length) console.log(`  ids on two bodies across chunks: ${dupes.join('; ')}`);
if (alien.length) console.log(`  verdicts for hashes outside the manifest: ${alien.slice(0, 8).join(', ')}`);
if (doubled.length) console.log(`  hashes ruled twice: ${doubled.slice(0, 8).join(', ')}`);
const missing = [...expected].filter(h => !seen.has(h));

const complete = !digest.length && !rerunClassify.length && (allowUnverified || !rerunVerify.length) && !dupes.length && !alien.length && !doubled.length && !missing.length;
if (rerunClassify.length) console.log(`  rerun classify for chunks: ${rerunClassify.map(r => r.chunk).join(',')}`);
if (rerunVerify.length) console.log(`  rerun verify for chunks: ${rerunVerify.map(r => r.chunk).join(',')}`);
if (!complete) {
  console.log(`INCOMPLETE — ${missing.length} candidate(s) without a usable verdict; nothing written`);
  process.exit(1);
}
const outFile = out || path.join(dir, 'verdicts-merged.json');
const counts = { model: 0, ui: 0, internal: 0 };
for (const v of merged) counts[v.facing]++;
fs.writeFileSync(
  outFile,
  JSON.stringify(
    merged.map(v => ({ hash: v.hash, facing: v.facing, id: v.id ?? null, name: v.name ?? null, desc: v.desc ?? null, evidence: v.evidence })),
    null,
    1
  )
);
console.log(`COMPLETE${rerunVerify.length ? ' (UNVERIFIED chunks included: ' + rerunVerify.map(r => r.chunk).join(',') + ')' : ''}: ${merged.length} verdict(s) (model ${counts.model}, ui ${counts.ui}, internal ${counts.internal}) -> ${outFile}`);
