#!/usr/bin/env node
// Write a chunk's verdicts AND check them, in one step (one agent turn).
//
//   node tools/writeClassifyVerdicts.mjs <evidenceDir> <NN> [--stage classify|verify] [--replace] <<'V'
//   [{"k":"k01","facing":"ui","id":null,"name":null,"desc":null,"evidence":"…"}, …]
//   V
//
// Each entry names its candidate by packet key ("k01") or full hash. The
// writer fills the hash, chunk, bundleSha and corpusDigest from the packet,
// sets id/name/desc to JSON null on a ui/internal verdict, MERGES the entries
// into the verdict file already on disk (so a fix re-sends only the entries
// it changes; --replace starts from an empty file), writes verdicts-NN.json
// (classify) or verify-NN.json (verify), and runs the same check as
// checkClassifyVerdicts.mjs. Output and exit code are the checker's: first
// line PASS or FAIL, then the problems by key. A classify PASS also writes
// verify-scope-NN.json and verify-NN.md.
import fs from 'node:fs';
import path from 'node:path';
import {
  loadManifest,
  normalizeChunk,
  loadChunk,
  evaluateChunk,
  report,
  verdictsFile,
  verifyFile,
  readJson,
} from './lib/classifyVerdicts.mjs';

const args = process.argv.slice(2);
const stageIdx = args.indexOf('--stage');
const stage = stageIdx >= 0 ? args[stageIdx + 1] : 'classify';
const replace = args.includes('--replace');
const inIdx = args.indexOf('--in');
const pos = args.filter((a, i) => !a.startsWith('--') && !(stageIdx >= 0 && i === stageIdx + 1) && !(inIdx >= 0 && i === inIdx + 1));
const [dirArg, chunkArg] = pos;
if (!dirArg || chunkArg == null || !['classify', 'verify'].includes(stage)) {
  console.error("usage: writeClassifyVerdicts.mjs <evidenceDir> <NN> [--stage classify|verify] [--replace] [--in file] <<'V' [...] V");
  process.exit(2);
}
const dir = path.resolve(dirArg);
let m;
let nn;
try {
  m = loadManifest(dir);
  nn = normalizeChunk(m, chunkArg);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

let incoming;
try {
  const raw = fs.readFileSync(inIdx >= 0 ? args[inIdx + 1] : 0, 'utf8');
  const doc = JSON.parse(raw);
  incoming = Array.isArray(doc) ? doc : doc && Array.isArray(doc.verdicts) ? doc.verdicts : null;
  if (!incoming) throw new Error('expected a JSON array of verdicts (or {"verdicts":[…]})');
} catch (e) {
  console.log(`FAIL chunk ${nn} (${stage}): input is not usable — ${e.message}`);
  process.exit(1);
}

const { packet, cands } = loadChunk(dir, m, nn);
const byKey = new Map([...cands.values()].map(c => [c.key, c.hash]));
const unknown = [];
const entries = [];
for (const v of incoming) {
  if (!v || typeof v !== 'object') {
    unknown.push(JSON.stringify(v));
    continue;
  }
  const ref = v.k ?? v.key ?? v.hash;
  const hash = typeof ref === 'string' && cands.has(ref) ? ref : byKey.get(String(ref));
  if (!hash) {
    unknown.push(String(ref));
    continue;
  }
  const out = { hash, facing: v.facing, id: v.id ?? null, name: v.name ?? null, desc: v.desc ?? null, evidence: v.evidence };
  if (typeof v.roleChange === 'string' && v.roleChange.trim()) out.roleChange = v.roleChange;
  if (out.facing === 'ui' || out.facing === 'internal') {
    out.id = null;
    out.name = null;
    out.desc = null;
  }
  entries.push(out);
}
if (unknown.length) {
  console.log(`FAIL chunk ${nn} (${stage}): ${unknown.length} entr${unknown.length === 1 ? 'y names' : 'ies name'} no candidate of this chunk: ${unknown.slice(0, 12).join(', ')} — use the packet keys (k01…) or full hashes; nothing was written`);
  process.exit(1);
}

const file = stage === 'verify' ? verifyFile(dir, nn) : verdictsFile(dir, nn);
const merged = new Map();
if (!replace && fs.existsSync(file)) {
  try {
    for (const v of readJson(file).verdicts || []) if (v && cands.has(v.hash)) merged.set(v.hash, v);
  } catch {
    /* an unreadable file is replaced */
  }
}
for (const v of entries) merged.set(v.hash, v);
const order = packet.candidates.map(c => c.hash);
const verdicts = order.filter(h => merged.has(h)).map(h => merged.get(h));
fs.writeFileSync(file, JSON.stringify({ chunk: nn, bundleSha: m.bundle.sha256, corpusDigest: m.corpus.digest, verdicts }, null, 1));

const r = evaluateChunk(dir, m, nn, { stage });
process.exit(await report(dir, m, nn, stage, r));
