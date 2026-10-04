#!/usr/bin/env node
// Writes one stage-1 group's verdicts from stdin and checks them, in one step.
//
//   node tools/writeAuditVerdicts.mjs <audit-packet-NN.json> [--merge] <<'VERDICTS'
//   {"verdicts":[...]}
//   VERDICTS
//
// Writing the file and running the checker were separate turns, and a failing
// check meant re-emitting the whole file. --merge replaces only the verdicts
// passed (by id) and keeps every other verdict already in the file, so a fix
// sends just the ids the checker named; a resumed attempt does the same.
//
// The file written is the packet's verdictsFile. The output is exactly
// checkAuditVerdicts.mjs's: first line `PASS gNN n/n verdicts sha256=…` or
// `FAIL gNN: …`, then every error and warning. Exit 0 only on PASS. Input that
// is not a {"verdicts":[…]} object is refused before anything is written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkGroup,
  formatResult,
  openPacketIndex,
} from './checkAuditVerdicts.mjs';

// The merged document: the packet's order first, then anything unexpected
// (left in so the checker names it).
export const mergeVerdicts = (packet, existing, incoming) => {
  const byId = new Map();
  const extra = [];
  for (const v of existing || []) {
    if (v && typeof v.id === 'string') byId.set(v.id, v);
  }
  for (const v of incoming) {
    if (v && typeof v.id === 'string') byId.set(v.id, v);
    else extra.push(v);
  }
  const order = packet.prompts.map(p => p.id);
  const known = new Set(order);
  return [
    ...order.filter(id => byId.has(id)).map(id => byId.get(id)),
    ...[...byId.keys()].filter(id => !known.has(id)).map(id => byId.get(id)),
    ...extra,
  ];
};

export const writeAndCheck = ({ packet, input, merge = false, index }) => {
  const group = packet.group || '?';
  let doc;
  try {
    doc = JSON.parse(input);
  } catch (e) {
    return {
      ok: false,
      text: `FAIL ${group}: stdin is not valid JSON (${e.message}) — nothing written; send {"verdicts":[...]}`,
    };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.verdicts)) {
    return {
      ok: false,
      text: `FAIL ${group}: stdin must be an object {"verdicts":[...]} — nothing written`,
    };
  }
  const file = packet.verdictsFile;
  let verdicts = doc.verdicts;
  if (merge && fs.existsSync(file)) {
    let prior = null;
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      prior = null;
    }
    if (prior && Array.isArray(prior.verdicts))
      verdicts = mergeVerdicts(packet, prior.verdicts, doc.verdicts);
  }
  const out = { ...doc, verdicts };
  const text = JSON.stringify(out, null, 1) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const r = checkGroup({ packet, verdictsText: text, index: index() });
  return { ok: r.ok, text: formatResult(r), result: r };
};

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
) {
  const argv = process.argv.slice(2);
  const packetPath = argv.find(a => !a.startsWith('--'));
  if (!packetPath) {
    console.error(
      "usage: writeAuditVerdicts.mjs <audit-packet-NN.json> [--merge] <<'VERDICTS' … VERDICTS"
    );
    process.exit(2);
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  if (!packet.corpus || !packet.verdictsFile) {
    console.error(
      `${packetPath}: no corpus block or verdictsFile — rebuild packets with tools/buildAuditPacket.mjs`
    );
    process.exit(2);
  }
  const r = writeAndCheck({
    packet,
    input: fs.readFileSync(0, 'utf8'),
    merge: argv.includes('--merge'),
    index: () => openPacketIndex(packet),
  });
  console.log(r.text);
  if (r.result) console.log(`wrote ${packet.verdictsFile}`);
  process.exit(r.ok ? 0 : 1);
}
