#!/usr/bin/env node
// Checks one chunk's verdict file against its evidence packet. Every classify
// agent runs this on its own output and fixes what it reports until it prints
// PASS; the workflow script cannot read files, so this is where completeness
// and collisions are enforced.
//
//   node tools/checkClassifyVerdicts.mjs <evidenceDir> <NN> [--stage classify]
//
// verdicts-NN.json covers exactly the chunk's hashes, every field is
// well-formed, no catalogue id is reused without licence, no id is shared by
// two bodies (in this chunk or across chunks), and bundle/corpus digests match
// the build the packets came from. --stage is accepted for old callers;
// --stage verify is rejected.
// Exit 0 on PASS, 1 on problems, 2 on usage errors.
import path from 'node:path';
import {
  loadManifest,
  normalizeChunk,
  evaluateChunk,
  report,
} from './lib/classifyVerdicts.mjs';

const args = process.argv.slice(2);
const stageIdx = args.indexOf('--stage');
const stage = stageIdx >= 0 ? args[stageIdx + 1] : 'classify';
const pos = args.filter((a, i) => !a.startsWith('--') && !(stageIdx >= 0 && i === stageIdx + 1));
const [dirArg, chunkArg] = pos;
if (!dirArg || chunkArg == null || stage !== 'classify') {
  console.error('usage: checkClassifyVerdicts.mjs <evidenceDir> <NN> [--stage classify]');
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

process.exit(report(dir, m, nn, evaluateChunk(dir, m, nn)));
