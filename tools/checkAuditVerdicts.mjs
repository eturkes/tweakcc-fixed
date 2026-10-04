#!/usr/bin/env node
// Checks one stage-1 audit group's verdict file against its packet and the
// corpus as deployed. The stage-1 agent runs it and fixes until it passes;
// tools/harvestAudit.mjs runs it again over every group, so a group that never
// passed cannot reach the stage-1 result.
//
//   node tools/checkAuditVerdicts.mjs <audit-packet-NN.json> <verdicts-NN.json> [--json]
//
// What it enforces:
//   - exactly the packet's ids, once each, and the stage-1 verdict schema;
//   - pristine-keep has a null trimPlan, trim has a non-empty one, wipe-merge
//     has at least one coveredBy pair, and a rewrite-table replacement is
//     never wiped;
//   - a trim or wipe of a fragment whose sentence crosses into a concatenated
//     neighbour (packet concatNeighbours, crossesSentence) names that
//     neighbour in trimPlan or why;
//   - every coveredBy pair is typed {carrierId, quote}; the carrier is a
//     corpus id (catalogue id, inline-* blob, or system-reminders/<name>) or
//     MODEL_DEFAULT; it is not the audited id, not suppressed, not shadowed,
//     and not wiped by this same file; and the quote is present VERBATIM in
//     the carrier's deployed body after un-escaping (whitespace may differ).
// Warnings (printed, not failing): a carrier the syntax places on the opposite
// arm of the target's branch, a carrier this file also trims, a very short
// quote. Co-rendering itself cannot be checked here; the agent proves it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  openIndex,
  resolveCarrier,
  quoteIn,
  bestRelation,
  MODEL_DEFAULT,
} from './lib/auditCorpus.mjs';

const VERDICT_KEYS = [
  'id',
  'verdict',
  'slopCheck',
  'duplicateCheck',
  'why',
  'coveredBy',
  'trimPlan',
];
const VERDICTS = new Set(['pristine-keep', 'trim', 'wipe-merge']);

export const crossingNeighbours = prompt =>
  Array.isArray(prompt?.concatNeighbours)
    ? prompt.concatNeighbours.filter(n => n.crossesSentence === true && n.id)
    : [];

export const couplingMessage = (v, n, state) =>
  `${v.verdict} cuts into a sentence that continues in concatenated fragment ${n.id} (${n.side}), which ${state} — its half of the sentence would be left broken; change both in this stage or keep this one`;

export const openPacketIndex = packet =>
  openIndex({
    catalogue: packet.corpus.catalogue,
    activeSet: packet.corpus.activeSet,
    remindersDir: packet.corpus.remindersDir || null,
    bundle: packet.corpus.bundle || null,
    cachePath: packet.corpus.index || null,
  }).index;

export const checkGroup = ({ packet, verdictsText, index }) => {
  const errors = [];
  const warnings = [];
  const group = packet.group || '?';
  const sha = crypto
    .createHash('sha256')
    .update(verdictsText ?? '')
    .digest('hex')
    .slice(0, 12);
  const fail = (id, msg) => errors.push(id ? `${id}: ${msg}` : msg);
  const warn = (id, msg) => warnings.push(id ? `${id}: ${msg}` : msg);

  let doc;
  try {
    doc = JSON.parse(verdictsText);
  } catch (e) {
    fail(null, `verdicts file is not valid JSON: ${e.message}`);
    return { group, ok: false, errors, warnings, count: 0, sha, verdicts: [] };
  }
  if (
    !doc ||
    typeof doc !== 'object' ||
    Array.isArray(doc) ||
    !Array.isArray(doc.verdicts)
  ) {
    fail(null, 'top level must be an object {"verdicts": [...]}');
    return { group, ok: false, errors, warnings, count: 0, sha, verdicts: [] };
  }
  const extraTop = Object.keys(doc).filter(k => k !== 'verdicts');
  if (extraTop.length)
    fail(null, `unexpected top-level key(s): ${extraTop.join(', ')}`);

  const expected = packet.prompts.map(p => p.id);
  const expectedSet = new Set(expected);
  const byPacketId = new Map(packet.prompts.map(p => [p.id, p]));
  const seen = new Map();
  for (const [n, v] of doc.verdicts.entries()) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      fail(null, `verdicts[${n}] is not an object`);
      continue;
    }
    const id = typeof v.id === 'string' ? v.id : `verdicts[${n}]`;
    if (typeof v.id !== 'string' || !v.id)
      fail(null, `verdicts[${n}]: id must be a non-empty string`);
    else if (!expectedSet.has(v.id))
      fail(v.id, 'not an id assigned in this packet');
    else if (seen.has(v.id)) fail(v.id, 'duplicate verdict');
    else seen.set(v.id, v);
    const keys = Object.keys(v);
    const missing = VERDICT_KEYS.filter(k => !keys.includes(k));
    const extra = keys.filter(k => !VERDICT_KEYS.includes(k));
    if (missing.length) fail(id, `missing field(s): ${missing.join(', ')}`);
    if (extra.length) fail(id, `unexpected field(s): ${extra.join(', ')}`);
    if (!VERDICTS.has(v.verdict))
      fail(id, `verdict must be one of ${[...VERDICTS].join(' | ')}`);
    for (const k of ['slopCheck', 'duplicateCheck', 'why']) {
      if (typeof v[k] !== 'string' || !v[k].trim())
        fail(id, `${k} must be a non-empty string`);
    }
    if (!Array.isArray(v.coveredBy)) fail(id, 'coveredBy must be an array');
    if (v.trimPlan !== null && typeof v.trimPlan !== 'string')
      fail(id, 'trimPlan must be a string or null');
    if (v.verdict === 'pristine-keep' && v.trimPlan !== null)
      fail(id, 'pristine-keep must have null trimPlan');
    if (
      v.verdict === 'trim' &&
      !(typeof v.trimPlan === 'string' && v.trimPlan.trim())
    ) {
      fail(id, 'trim needs a non-empty trimPlan');
    }
    if (
      v.verdict === 'wipe-merge' &&
      (!Array.isArray(v.coveredBy) || !v.coveredBy.length)
    ) {
      fail(
        id,
        'wipe-merge needs at least one coveredBy pair (full coverage is the only wipe reason)'
      );
    }
    const pk = byPacketId.get(v.id);
    if (v.verdict === 'wipe-merge' && pk?.externalRefs?.rewriteReplacement) {
      fail(
        id,
        'externalRefs.rewriteReplacement is true: a rewrite-table replacement is never wiped'
      );
    }
    // A sentence spanning this fragment and a concatenated neighbour is cut
    // whole across both ids or not at all; cutting one half leaves the other
    // half's words dangling in the rendered text. Only boundaries that fall
    // inside a sentence are held, so a cut at a clean boundary passes as is.
    if (
      (v.verdict === 'trim' || v.verdict === 'wipe-merge') &&
      Array.isArray(pk?.concatNeighbours)
    ) {
      const said = `${typeof v.why === 'string' ? v.why : ''}\n${typeof v.trimPlan === 'string' ? v.trimPlan : ''}`;
      for (const n of pk.concatNeighbours) {
        if (n.crossesSentence !== true) continue;
        if (n.id && !said.includes(n.id)) {
          fail(
            id,
            `a sentence crosses the ${n.side} boundary into concatenated fragment ${n.id}; a ${v.verdict} must cut that sentence whole across both ids or not at all — name ${n.id} in trimPlan or why and say how its half is handled`
          );
        } else if (!n.id) {
          warn(
            id,
            `a sentence crosses the ${n.side} boundary into an uncatalogued concatenated literal; that half cannot be edited, so do not cut the sentence`
          );
        }
      }
    }
  }
  for (const id of expected) if (!seen.has(id)) fail(id, 'no verdict');

  // The other half of a sentence-crossing pair kept pristine in this same
  // file: a wipe then leaves its half dangling for certain; a trim might stop
  // short of the boundary, so it is a warning.
  for (const v of seen.values()) {
    if (v.verdict !== 'trim' && v.verdict !== 'wipe-merge') continue;
    for (const n of crossingNeighbours(byPacketId.get(v.id))) {
      const other = seen.get(n.id);
      if (other && other.verdict === 'pristine-keep') {
        (v.verdict === 'wipe-merge' ? fail : warn)(
          v.id,
          couplingMessage(v, n, 'is pristine-keep in this file')
        );
      }
    }
  }

  const wipedHere = new Set(
    [...seen.values()].filter(v => v.verdict === 'wipe-merge').map(v => v.id)
  );
  const trimmedHere = new Set(
    [...seen.values()].filter(v => v.verdict === 'trim').map(v => v.id)
  );
  for (const v of seen.values()) {
    if (!Array.isArray(v.coveredBy)) continue;
    for (const [n, pair] of v.coveredBy.entries()) {
      const where = `coveredBy[${n}]`;
      if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
        fail(v.id, `${where} must be {carrierId, quote}`);
        continue;
      }
      const extra = Object.keys(pair).filter(
        k => k !== 'carrierId' && k !== 'quote'
      );
      if (extra.length)
        fail(v.id, `${where} unexpected field(s): ${extra.join(', ')}`);
      const { carrierId, quote } = pair;
      if (typeof carrierId !== 'string' || !carrierId.trim()) {
        fail(v.id, `${where}.carrierId must be a non-empty string`);
        continue;
      }
      if (typeof quote !== 'string' || !quote.trim()) {
        fail(v.id, `${where}.quote must be a non-empty string`);
        continue;
      }
      if (carrierId === MODEL_DEFAULT) continue;
      if (carrierId === v.id) {
        fail(v.id, `${where}: a prompt cannot cover itself`);
        continue;
      }
      const c = resolveCarrier(index, carrierId);
      if (!c) {
        fail(
          v.id,
          `${where}: carrierId "${carrierId}" is not in the corpus (use a catalogue id, an inline-* id, system-reminders/<name>, or MODEL_DEFAULT)`
        );
        continue;
      }
      if (c.doc.id !== carrierId)
        fail(v.id, `${where}: write carrierId as "${c.doc.id}"`);
      if (c.doc.suppressed) {
        fail(
          v.id,
          `${where}: carrier ${c.doc.id} is SUPPRESSED (empty body) and covers nothing`
        );
        continue;
      }
      if (c.doc.shadowedBy.length) {
        fail(
          v.id,
          `${where}: carrier ${c.doc.id} is shadowed by ${c.doc.shadowedBy.join(', ')} — its own body never renders; cite the shadowing blob`
        );
        continue;
      }
      if (wipedHere.has(c.doc.id)) {
        fail(
          v.id,
          `${where}: carrier ${c.doc.id} is itself wipe-merged in this file — circular coverage`
        );
        continue;
      }
      const m = quoteIn(c.doc.body, quote);
      const at = c.doc.path || `catalogue pristine of ${c.doc.id}`;
      if (m === 'normalized-only') {
        fail(
          v.id,
          `${where}: quote matches ${c.doc.id} only ignoring case/punctuation — copy it verbatim from ${at}`
        );
        continue;
      }
      if (!m) {
        fail(
          v.id,
          `${where}: quote not found in the deployed body of ${c.doc.id} (${at})`
        );
        continue;
      }
      if (trimmedHere.has(c.doc.id)) {
        warn(
          v.id,
          `${where}: carrier ${c.doc.id} is also trimmed in this file — its trim must keep the quoted text`
        );
      }
      if (quote.trim().length < 12)
        warn(v.id, `${where}: very short quote "${quote}"`);
      const rel = bestRelation(index, v.id, c.idx);
      if (rel && rel.relation === 'exclusive-arms') {
        warn(
          v.id,
          `${where}: syntax places ${c.doc.id} on the OTHER arm of the branch that emits this prompt (offsets ${rel.targetOffset}/${rel.carrierOffset}) — an alternative arm never co-renders; prove co-rendering or drop the pair`
        );
      }
    }
  }
  const verdicts = expected.filter(id => seen.has(id)).map(id => seen.get(id));
  return {
    group,
    ok: errors.length === 0,
    errors,
    warnings,
    count: seen.size,
    expected: expected.length,
    sha,
    verdicts,
  };
};

export const formatResult = r =>
  [
    r.ok
      ? `PASS ${r.group} ${r.count}/${r.expected} verdicts sha256=${r.sha}${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}`
      : `FAIL ${r.group}: ${r.errors.length} error(s) — fix the verdicts file and re-run`,
    ...r.errors.map(e => `  error: ${e}`),
    ...r.warnings.map(w => `  warning: ${w}`),
  ].join('\n');

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
) {
  const [packetPath, verdictsPath] = process.argv
    .slice(2)
    .filter(a => !a.startsWith('--'));
  if (!packetPath || !verdictsPath) {
    console.error(
      'usage: checkAuditVerdicts.mjs <audit-packet-NN.json> <verdicts-NN.json> [--json]'
    );
    process.exit(2);
  }
  const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
  if (!packet.corpus) {
    console.error(
      `${packetPath}: no corpus block — rebuild packets with tools/buildAuditPacket.mjs`
    );
    process.exit(2);
  }
  const verdictsText = fs.existsSync(verdictsPath)
    ? fs.readFileSync(verdictsPath, 'utf8')
    : null;
  const r =
    verdictsText === null
      ? {
          group: packet.group,
          ok: false,
          errors: [`${verdictsPath} does not exist`],
          warnings: [],
          count: 0,
          expected: packet.prompts.length,
          sha: '-',
        }
      : checkGroup({ packet, verdictsText, index: openPacketIndex(packet) });
  if (process.argv.includes('--json')) {
    const { verdicts: _omit, ...rest } = r;
    console.log(JSON.stringify(rest, null, 1));
  } else console.log(formatResult(r));
  process.exit(r.ok ? 0 : 1);
}
