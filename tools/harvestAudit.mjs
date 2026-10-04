#!/usr/bin/env node
// Harvests a stage-1 audit fan-out from DISK and emits the stage-1 result.
//
//   node tools/harvestAudit.mjs <packetDir> [--out <file>]
//
// The workflow agents write <packetDir>/verdicts-NN.json and return only the
// checker's last line, so nothing large crosses the workflow boundary. This is
// the authority: it re-runs tools/checkAuditVerdicts.mjs on every group,
// reconciles the union against the manifest's id list, and checks what one
// group cannot see — a carrier wiped by ANOTHER group (circular coverage) and
// a corpus that changed after the packets were built (the freeze).
//
// Writes <packetDir>/stage1-result.json ({verdicts} in id-file order plus
// counts, warnings, errors and the groups to rerun) and exits 0 only when every
// id has a passing verdict and nothing failed.
import fs from 'node:fs';
import path from 'node:path';
import {
  checkGroup,
  openPacketIndex,
  crossingNeighbours,
  couplingMessage,
} from './checkAuditVerdicts.mjs';
import { currentCorpusDigest, resolveCarrier } from './lib/auditCorpus.mjs';

const argv = process.argv.slice(2);
const packetDir = argv.find(a => !a.startsWith('--'));
if (!packetDir) {
  console.error('usage: harvestAudit.mjs <packetDir> [--out <file>]');
  process.exit(2);
}
const oi = argv.indexOf('--out');
const outPath =
  oi >= 0 ? argv[oi + 1] : path.join(packetDir, 'stage1-result.json');
const manifestPath = path.join(packetDir, 'audit-manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(
    `${manifestPath} not found — build packets with tools/buildAuditPacket.mjs`
  );
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const errors = [];
const warnings = [];
const groupRows = [];
const all = new Map();
const owner = new Map();
let index = null;

const corpusNow = currentCorpusDigest({
  catalogue: manifest.corpus.catalogue,
  activeSet: manifest.corpus.activeSet,
  remindersDir: manifest.corpus.remindersDir || null,
});

const neighboursOf = new Map();
for (const g of manifest.groups) {
  const packet = JSON.parse(fs.readFileSync(g.packet, 'utf8'));
  if (!index) index = openPacketIndex(packet);
  for (const p of packet.prompts) neighboursOf.set(p.id, crossingNeighbours(p));
  if (!fs.existsSync(g.verdicts)) {
    groupRows.push({
      name: g.name,
      ok: false,
      missing: true,
      ids: g.ids.length,
    });
    errors.push(`${g.name}: no verdicts file (${g.verdicts})`);
    continue;
  }
  const r = checkGroup({
    packet,
    verdictsText: fs.readFileSync(g.verdicts, 'utf8'),
    index,
  });
  groupRows.push({
    name: g.name,
    ok: r.ok,
    sha: r.sha,
    verdicts: r.count,
    ids: g.ids.length,
    errors: r.errors.length,
    warnings: r.warnings.length,
  });
  for (const e of r.errors) errors.push(`${g.name}: ${e}`);
  for (const w of r.warnings) warnings.push(`${g.name}: ${w}`);
  if (!r.ok) continue;
  for (const v of r.verdicts) {
    if (all.has(v.id)) {
      errors.push(`${v.id}: verdict in both ${owner.get(v.id)} and ${g.name}`);
      continue;
    }
    all.set(v.id, v);
    owner.set(v.id, g.name);
  }
}

// Cross-group coverage: a carrier wiped anywhere in this stage covers nothing.
const wiped = new Set(
  [...all.values()].filter(v => v.verdict === 'wipe-merge').map(v => v.id)
);
const trimmed = new Set(
  [...all.values()].filter(v => v.verdict === 'trim').map(v => v.id)
);
const failedGroups = new Set(groupRows.filter(r => !r.ok).map(r => r.name));
for (const v of all.values()) {
  for (const pair of v.coveredBy) {
    if (pair.carrierId === 'MODEL_DEFAULT') continue;
    const c = index ? resolveCarrier(index, pair.carrierId) : null;
    const cid = c ? c.doc.id : pair.carrierId;
    if (wiped.has(cid) && owner.get(cid) !== owner.get(v.id)) {
      errors.push(
        `${owner.get(v.id)}: ${v.id}: carrier ${cid} is wipe-merged by ${owner.get(cid)} — circular coverage`
      );
      failedGroups.add(owner.get(v.id));
    } else if (trimmed.has(cid) && owner.get(cid) !== owner.get(v.id)) {
      warnings.push(
        `${owner.get(v.id)}: ${v.id}: carrier ${cid} is trimmed by ${owner.get(cid)} — its trim must keep the quoted text (stage 3 checks)`
      );
    }
  }
}

// A sentence spanning two fragments, cut on one side only. Same-group pairs
// were judged by the checker; here the other half lives in another group or
// was not in this stage at all.
for (const v of all.values()) {
  if (v.verdict !== 'trim' && v.verdict !== 'wipe-merge') continue;
  for (const n of neighboursOf.get(v.id) || []) {
    const other = all.get(n.id);
    if (other && owner.get(n.id) === owner.get(v.id)) continue;
    let state = null;
    if (other && other.verdict === 'pristine-keep')
      state = `is pristine-keep in ${owner.get(n.id)}`;
    else if (!other) {
      const c = index ? resolveCarrier(index, n.id) : null;
      if (!c || c.doc.matchesPristine)
        state = 'is not in this stage and renders pristine';
    }
    if (!state) continue;
    const msg = `${owner.get(v.id)}: ${v.id}: ${couplingMessage(v, n, state)}`;
    if (v.verdict === 'wipe-merge') {
      errors.push(msg);
      failedGroups.add(owner.get(v.id));
    } else warnings.push(msg);
  }
}

const idsFile =
  manifest.idsFile && fs.existsSync(manifest.idsFile)
    ? fs
        .readFileSync(manifest.idsFile, 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    : manifest.groups.flatMap(g => g.ids);
const wanted = new Set(manifest.groups.flatMap(g => g.ids));
for (const id of idsFile)
  if (!wanted.has(id))
    errors.push(`${id}: in ${manifest.idsFile} but in no packet`);
const missing = idsFile.filter(id => !all.has(id));
// The freeze: the index may have been rebuilt underneath, so compare against
// the digest recorded when the packets were built, never the live index.
if (
  manifest.corpus.corpusDigest &&
  manifest.corpus.corpusDigest !== corpusNow
) {
  warnings.push(
    'corpus changed after the packets were built — stage 1 must run on a frozen corpus; quotes were checked against the CURRENT disk'
  );
}

const verdicts = idsFile.filter(id => all.has(id)).map(id => all.get(id));
const counts = { 'pristine-keep': 0, trim: 0, 'wipe-merge': 0 };
for (const v of verdicts) counts[v.verdict] += 1;
const rerun = [...failedGroups].sort();
const complete = missing.length === 0 && errors.length === 0;
const result = {
  version: manifest.version,
  packetDir: path.resolve(packetDir),
  corpusDigest: corpusNow,
  complete,
  counts,
  verdicts,
  missing,
  rerun,
  groups: groupRows,
  errors,
  warnings,
};
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
console.log(
  `stage1 ${manifest.version}: ${verdicts.length}/${idsFile.length} verdicts — ` +
    `${counts['pristine-keep']} pristine-keep, ${counts.trim} trim, ${counts['wipe-merge']} wipe-merge; ` +
    `${errors.length} error(s), ${warnings.length} warning(s) -> ${outPath}`
);
for (const e of errors) console.log(`  error: ${e}`);
for (const w of warnings) console.log(`  warning: ${w}`);
if (rerun.length) console.log(`rerun groups: ${rerun.join(', ')}`);
process.exit(complete ? 0 : 1);
