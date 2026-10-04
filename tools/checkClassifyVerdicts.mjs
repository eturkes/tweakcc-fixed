#!/usr/bin/env node
// Checks one chunk's verdict file against its evidence packet. Every classify
// and verify agent runs this on its own output and fixes what it reports
// until it prints PASS; the workflow script cannot read files, so this is
// where completeness and collisions are enforced.
//
//   node tools/checkClassifyVerdicts.mjs <evidenceDir> <NN> [--stage classify|verify]
//
// classify: verdicts-NN.json covers exactly the chunk's hashes, every field is
//   well-formed, no catalogue id is reused without licence, no id is shared by
//   two bodies (in this chunk or across chunks), and bundle/corpus digests
//   match the build the packets came from. On PASS it writes
//   verify-scope-NN.json (the hashes the verifier must re-rule) and
//   verify-NN.md (the verifier's packet: those candidates with their drafts).
// verify: verify-NN.json covers exactly that scope, with the same checks run
//   over the draft as corrected by the verifier.
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
if (!dirArg || chunkArg == null || !['classify', 'verify'].includes(stage)) {
  console.error('usage: checkClassifyVerdicts.mjs <evidenceDir> <NN> [--stage classify|verify]');
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

const r = evaluateChunk(dir, m, nn, { stage });
process.exit(await report(dir, m, nn, stage, r));
