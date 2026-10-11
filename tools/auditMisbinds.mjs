#!/usr/bin/env node
// Mis-bind audit — the prevention gate for the "override resolves to a wrong-but-
// valid var" bug class (silent sibling of the ReferenceError / slot-shift classes;
// see AGENTS.md bug-classes). For every override, every placeholder it USES must
// sit at the same identifierMap slot as upstream's authoritative complete map. A
// name at a different slot => the patcher captures the wrong var at apply time =>
// wrong content, no crash, invisible to four-zeros + smoke. Run during showtime
// after extracting the prompts JSON; exits non-zero if any mis-bind is found.
//
// Usage:
//   git show upstream/main:data/prompts/prompts-<ver>.json > /tmp/pieb-<ver>.json
//   node tools/auditMisbinds.mjs [ourJson] [upstreamJson] [overridesDir]
// Defaults target the local showtime layout.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  bakedPositions,
  loadMatcherCore,
  scannerPattern,
} from './checkBakedIdentifiers.mjs';

const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  appliedPromptsDir,
  printAuditedSets,
} = require('./lib/overrideSets.cjs');

// Default to the newest committed prompts JSON. A hardcoded old version silently
// audits the wrong release (or skips entirely) long after that version is gone.
const latestCommittedVer = () => {
  const dir = 'data/prompts';
  const vers = fs
    .readdirSync(dir)
    .map(f => /^prompts-(\d+\.\d+\.\d+)\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .sort((a, b) => {
      const [x, y] = [a, b].map(v => v.split('.').map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  return vers[vers.length - 1];
};

const parsed = parseOverrideArgs(process.argv.slice(2));
const VER = process.env.CC_VER || latestCommittedVer();
const ourJson = parsed.rest[0] || `data/prompts/prompts-${VER}.json`;
const upstreamJson = parsed.rest[1] || `/tmp/pieb-${VER}.json`;
// Default to whatever the live symlink names, not a set that may be retired.
let overridesDir = parsed.rest[2];
if (!overridesDir) {
  const applied = appliedPromptsDir();
  try {
    overridesDir = fs.realpathSync(applied);
  } catch {
    console.error(`no override folder at ${applied}, nothing to audit`);
    process.exit(parsed.requireSets ? 2 : 0);
  }
}
printAuditedSets([{ dir: overridesDir, name: path.basename(overridesDir) }]);

const OURS = JSON.parse(fs.readFileSync(ourJson, 'utf8'));
// Upstream reference is required. On a box without the `upstream` remote (e.g. a
// VPS mirror) the dump is empty — skip loudly rather than crash with a raw
// JSON.parse stack. The audit runs during showtime on the Mac, which has upstream.
// A skip exits NON-ZERO: this is a showtime gate, and "did nothing" must never be
// mistaken for "found nothing" (exit 0 on skip read as a pass for three releases).
// Set TWEAKCC_ALLOW_MISBIND_SKIP=1 on boxes that legitimately have no upstream.
let PIEB;
try {
  const raw = fs.readFileSync(upstreamJson, 'utf8');
  if (!raw.trim()) throw new Error('file is empty');
  PIEB = JSON.parse(raw);
} catch (e) {
  const allowSkip = process.env.TWEAKCC_ALLOW_MISBIND_SKIP === '1';
  console.error(
    `mis-bind audit: SKIPPED — upstream reference '${upstreamJson}' missing/empty (${e.message}). ` +
      `Dump it first: git show upstream/prompts/${VER}:data/prompts/prompts-${VER}.json > ${upstreamJson}` +
      (allowSkip
        ? ''
        : ' (set TWEAKCC_ALLOW_MISBIND_SKIP=1 to treat a skip as non-fatal)')
  );
  process.exit(allowSkip ? 0 : 2);
}
// Upstream is the reference, not scripture. Where its map is verifiably wrong
// against the binary, tools/promptExtractor.js CURATED_IDENTIFIER_MAPS corrects
// ours on purpose, and this audit must not "restore" the bug. Every entry here
// needs the evidence recorded next to the correction in the extractor.
//
// tool-description-bash-git-commit-and-pr-creation-instructions: upstream rotates
// slots 7/8/9, so the LCC override's ${PR_GENERATED_WITH_CLAUDE_CODE} bound to a
// FUNCTION and the patcher rendered its source text into the Bash tool
// description. Verified against the pristine 2.1.206 cli.js.
//
// system-prompt-harness-instructions: upstream's 2.1.274 map puts the security
// policy at slot 4 and output-style names on slots 0/1; the builder's template
// emits the hoisted intro, then the security-policy const, then the reminder
// guidance call, tool context, and the pasted-content bullet. Verified against
// the pristine 2.1.274 cli.js.
const CURATED_DIVERGENCES = new Set([
  'tool-description-bash-git-commit-and-pr-creation-instructions',
  'system-prompt-harness-instructions',
]);

const invert = m => {
  const r = {};
  if (m) for (const [s, n] of Object.entries(m)) r[n] = s;
  return r;
};
const byId = d => {
  const m = {};
  for (const p of d.prompts) if (p.id) m[p.id] = p;
  return m;
};
const O = byId(OURS),
  P = byId(PIEB);

const core = await loadMatcherCore();
// Both catalogues store the version and build stamp as placeholders; the
// pattern fills upstream's, so ours must carry the same values to match.
const BUILD_TIME_PROBE = '2000-01-01T00:00:00Z';
const fillStamps = piece =>
  piece
    .replace(/<<CCVERSION>>/g, OURS.version)
    .replace(/<<BUILD_TIME>>/g, BUILD_TIME_PROBE);
const sameIdentifiers = (ours, upstream) =>
  JSON.stringify(ours.identifiers || []) ===
  JSON.stringify(upstream.identifiers || []);
// Upstream slot -> our slot, read by matching upstream's pieces against our
// body. When the text differs (upstream published for another build, or we
// cut the prompt differently) but the identifiers arrays are equal, the slots
// are compared label for label, as before slot alignment existed. `how` says
// which; null means neither applies.
const alignedSlots = (ours, upstream) => {
  if (!ours) return null;
  const prefix = '__TWEAKCC_AUDIT_SLOT_';
  const content = ours.pieces
    .map(
      (piece, i) =>
        fillStamps(piece) +
        (i < ours.identifiers.length ? `${prefix}${ours.identifiers[i]}__` : '')
    )
    .join('');
  const { names, marked } = bakedPositions(core, upstream.pieces);
  const { pattern, roles } = scannerPattern(
    core,
    marked,
    names,
    OURS.version,
    BUILD_TIME_PROBE
  );
  const match = new RegExp(pattern, 's').exec(content);
  if (!match) {
    if (!sameIdentifiers(ours, upstream)) return null;
    const slots = {};
    for (const label of upstream.identifiers || [])
      slots[String(label)] = String(label);
    return { slots, how: 'identifiers' };
  }
  const links = new Map();
  let occurrence = 0;
  roles.forEach((role, group) => {
    if (role) return;
    const upstreamSlot = String(upstream.identifiers[occurrence++]);
    const captured = new RegExp(`^${prefix}(\\d+)__$`).exec(match[group + 1]);
    if (!captured) return;
    if (!links.has(upstreamSlot)) links.set(upstreamSlot, new Set());
    links.get(upstreamSlot).add(captured[1]);
  });
  if (occurrence !== upstream.identifiers.length) return null;
  const slots = {};
  for (const [slot, targets] of links)
    if (targets.size === 1) slots[slot] = [...targets][0];
  const counts = new Map();
  for (const target of Object.values(slots))
    counts.set(target, (counts.get(target) || 0) + 1);
  for (const [slot, target] of Object.entries(slots))
    if (counts.get(target) > 1) delete slots[slot];
  return { slots, how: 'aligned' };
};

const misbinds = [];
const skipped = [];
let compared = 0;
let byIdentifiers = 0;
for (const f of fs.readdirSync(overridesDir)) {
  if (!f.endsWith('.md')) continue;
  const id = f.slice(0, -3);
  // inline-* overrides remap minified idents positionally, not by identifierMap.
  if (id.startsWith('inline-')) continue;
  const raw = fs.readFileSync(path.join(overridesDir, f), 'utf8');
  const body = (raw.match(/^<!--[\s\S]*?-->\n?([\s\S]*)$/) || [, raw])[1];
  const used = new Set(
    [...body.matchAll(/(?<!\\)\$\{([A-Z][A-Z0-9_]+)/g)].map(m => m[1])
  );
  if (!used.size || !P[id]) continue; // can only audit prompts upstream also has
  if (CURATED_DIVERGENCES.has(id)) {
    console.log(`mis-bind audit: curated divergence from upstream — ${id}`);
    continue;
  }
  // Slot NUMBERS are only comparable when both sides describe the same slot
  // layout. Upstream publishes per-version, and on a bump where they have not
  // published yet the reference is an OLDER release: CC 2.1.237 inserted a slot
  // into tool-description-edit (`${r?"":cES()}` -> `${r?uES():cES()}`), shifting
  // every later label by one, so comparing our 5-slot map against upstream's
  // 4-slot one reports two mis-binds where both maps are correct for their own
  // version. That is a false positive on a gate whose whole value is that a hit
  // means something, so skip the prompt and say so, rather than adding a
  // permanent per-id silencer that would also hide a real regression later.
  const aligned = alignedSlots(O[id], P[id]);
  if (!aligned) {
    skipped.push(id);
    console.log(
      `mis-bind audit: slot layout differs from upstream (${(O[id]?.identifiers || []).length} vs ${(P[id]?.identifiers || []).length} slots) — not comparable: ${id}`
    );
    continue;
  }
  const { slots, how } = aligned;
  compared++;
  if (how === 'identifiers') byIdentifiers++;
  const our = invert(O[id]?.identifierMap);
  const pieb = invert(P[id]?.identifierMap);
  for (const name of used) {
    const so = our[name],
      sp = pieb[name];
    if (so === undefined || sp === undefined) continue; // leak/uncomparable: other gates cover it
    if (slots[sp] === undefined) {
      misbinds.push(
        `${id}: \${${name}} ours=slot${so} upstream=slot${sp} has no unique current expression slot (removed or ambiguous binding)`
      );
      continue;
    }
    if (so !== slots[sp])
      misbinds.push(
        `${id}: \${${name}} ours=slot${so} upstream=slot${sp} (maps to ours=slot${slots[sp]})`
      );
  }
}

// A skipped prompt is not audited at all, so a mass skip would read as a clean
// pass. Measured on the 2.1.296 catalogue: 2 skips of 258 against upstream's
// 2.1.296 and 2.1.295, 7 of 242 against its 2.1.294 (the driver falls back to
// upstream's newest release), 10 of 5251 against our own 2.1.295 and 54 of
// 4952 against 2.1.292. The floor covers the handful of prompts the two
// extractors cut differently; 2% leaves headroom over the worst real ratio
// while any broken matcher or wrong reference skips far more.
const skipLimit = Math.max(10, Math.ceil(compared * 0.02));
const coverage = `${compared} compared (${byIdentifiers} by identifiers), ${skipped.length} not comparable (limit ${skipLimit})`;
if (skipped.length > skipLimit) {
  console.error(
    `mis-bind audit: ${skipped.length} prompts not comparable to the upstream slot layout, over the limit of ${skipLimit} (${coverage}). Check the upstream reference version and the matcher before trusting this gate.`
  );
  process.exit(1);
}
if (misbinds.length) {
  console.error(
    `MIS-BINDS: ${misbinds.length} (override placeholder at wrong slot; ${coverage})`
  );
  for (const m of misbinds) console.error('  ' + m);
  console.error(
    '\nFix: align upstream names to matching expression slots, or hand-name the slot; promoted slots make raw map keys nonportable. See AGENTS.md bug-classes.'
  );
  process.exit(1);
}
console.log(
  `mis-bind audit: 0 (every used placeholder sits at the upstream slot; ${coverage})`
);
