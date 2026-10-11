#!/usr/bin/env node
// Mixed-verdict gate: a call group (the literal arguments at one position
// across every call of one function in a module) whose arms are ruled both
// `model` and `ui`/`internal`.
//
// A callee usually sends every argument at a position down one route, so a
// split ruling means a wrong verdict unless the call sites themselves route
// differently: a generic error class thrown on one path and caught on another,
// or one caller rendering the result where another drops it. Each classify
// agent rules a string from its own call site, so nothing compared the
// verdicts of one callee's arguments. On CC 2.1.296, 23 of 40 such groups held
// 51 wrong verdicts between them (slash-command output sent to the model ruled
// `ui`, workflow refusal fragments ruled `internal` beside their catalogued
// head).
//
// data/mixed-call-verdicts.json records reviews per arm. An entry is keyed by
// the group's fingerprint (see mixedRulings in checkSiblingArms.mjs) and holds
// reviews, each naming why the call sites route differently and the
// `(arm key, facing)` pairs it covers. Only arms no review covers are raised,
// so a group of a hundred arms re-raises the one arm that changed, not all of
// them. When a group's earned model arms change, its fingerprint
// changes; the entries at the same argument position that share one of its
// model arms are the same callee, and their reviews carry over until --record
// or --prune files them under the new fingerprint.
//
// Usage:
//   node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json>
//     [--cache data/prompt-classification.json]
//     [--allowlist data/mixed-call-verdicts.json] [--json]
//   ... --record <reviews.json>   add reviews
//   ... --prune                   drop entries and arms the scan no longer has
// <reviews.json> is [{key, why, arms?}]: key is the fingerprint a MIXED line
// prints, arms the arm keys to cover (default: every arm the group raises). A
// group with a wrong verdict is fixed in the classification cache instead.
// Exit 0 = every mixed arm reviewed, 1 = unreviewed arms or a rejected record,
// 2 = usage error, a bundle segment that could not be parsed, or two groups
// sharing a fingerprint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CACHE, scanSiblingArms } from './checkSiblingArms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST = path.join(
  HERE,
  '..',
  'data',
  'mixed-call-verdicts.json'
);

const PREVIEW = 60;
export const preview = body =>
  body.length > PREVIEW ? body.slice(0, PREVIEW - 1) + '…' : body;

export function fingerprintCollisions(mixed) {
  const count = new Map();
  for (const m of mixed)
    count.set(m.fingerprint, (count.get(m.fingerprint) || 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([fp]) => fp);
}

// The entries whose reviews apply to each group: its own, or else those at the
// same argument position sharing one of its model arms (the same callee, whose
// model text changed) that no current group owns.
function sourcesOf(mixed, allowlist) {
  const owned = new Set(
    mixed.map(m => m.fingerprint).filter(fp => allowlist[fp])
  );
  return new Map(
    mixed.map(m => {
      if (allowlist[m.fingerprint]) return [m, [m.fingerprint]];
      const keys = new Set(m.model.map(a => a.key));
      const carried = Object.keys(allowlist).filter(
        fp =>
          !owned.has(fp) &&
          allowlist[fp].position === m.position &&
          Object.keys(allowlist[fp].model || {}).some(k => keys.has(k))
      );
      return [m, carried];
    })
  );
}

const covers = (entries, arm) =>
  entries.some(e =>
    (e.reviews || []).some(
      r => r.why && r.arms?.[arm.key]?.facing === arm.facing
    )
  );

// Every group with an arm no review covers, with those arms as `uncovered`.
export function unreviewedMixed(mixed, allowlist) {
  const sources = sourcesOf(mixed, allowlist);
  const open = [];
  for (const m of mixed) {
    const from = sources.get(m);
    const entries = from.map(fp => allowlist[fp]);
    const uncovered = m.other.filter(a => !covers(entries, a));
    if (uncovered.length)
      open.push({
        ...m,
        uncovered,
        ...(from.length && from[0] !== m.fingerprint && { carriedFrom: from }),
      });
  }
  return open;
}

const entryFor = (m, reviews) => ({
  at: m.at,
  model: Object.fromEntries(m.model.map(a => [a.key, preview(a.body)])),
  position: m.position,
  reviews,
});

// The reviews of `from` restricted to arms the group still raises with the same
// facing; reviews left with no arm are dropped and the same reason is merged.
function liveReviews(m, from) {
  const current = new Map(m.other.map(a => [a.key, a]));
  const byWhy = new Map();
  for (const e of from)
    for (const r of e.reviews || []) {
      const arms = Object.entries(r.arms || {}).filter(
        ([k, v]) => current.get(k)?.facing === v.facing
      );
      if (!r.why || !arms.length) continue;
      if (!byWhy.has(r.why)) byWhy.set(r.why, {});
      for (const [k] of arms)
        byWhy.get(r.why)[k] = {
          facing: current.get(k).facing,
          preview: preview(current.get(k).body),
        };
    }
  return [...byWhy].map(([why, arms]) => ({ arms, why }));
}

// Adds `reviews` ([{key, why, arms?}]) to a copy of `allowlist`. A group
// reviewed from carried entries is filed under its fingerprint with those
// reviews; an entry no other current group draws on is then dropped.
export function recordReviews(allowlist, reviews, mixed) {
  const next = { ...allowlist };
  const problems = [];
  const open = new Map(
    unreviewedMixed(mixed, allowlist).map(m => [m.fingerprint, m])
  );
  const sources = sourcesOf(mixed, allowlist);
  const current = new Set(mixed.map(m => m.fingerprint));
  const seen = new Set();
  const rows = [];
  if (!Array.isArray(reviews))
    return { allowlist, recorded: 0, problems: ['reviews must be an array'] };
  for (const r of reviews) {
    const key = r?.key;
    if (typeof key !== 'string' || !/^[0-9a-f]{16}$/.test(key))
      problems.push(`bad key: ${JSON.stringify(key)}`);
    else if (seen.has(key)) problems.push(`${key}: listed twice in this batch`);
    else if (typeof r.why !== 'string' || r.why.trim().length < 20)
      problems.push(`${key}: why must name the differing routes`);
    else if (!current.has(key))
      problems.push(`${key}: not a current mixed group`);
    else if (!open.has(key))
      problems.push(`${key}: every arm is already reviewed`);
    else {
      const raised = new Map(open.get(key).uncovered.map(a => [a.key, a]));
      const picked = r.arms ?? [...raised.keys()];
      const bad = Array.isArray(picked)
        ? picked.filter(k => !raised.has(k))
        : [String(picked)];
      if (bad.length)
        problems.push(`${key}: not an unreviewed arm here: ${bad.join(', ')}`);
      else if (new Set(picked).size !== picked.length)
        problems.push(`${key}: an arm is listed twice`);
      else
        rows.push({
          key,
          why: r.why.trim(),
          arms: picked.map(k => raised.get(k)),
        });
    }
    if (typeof key === 'string') seen.add(key);
  }
  if (problems.length || !rows.length)
    return { allowlist, recorded: 0, problems };
  const groups = new Map(mixed.map(m => [m.fingerprint, m]));
  for (const { key, why, arms } of rows) {
    const m = groups.get(key);
    const from = sources.get(m).map(fp => allowlist[fp]);
    next[key] = entryFor(m, [
      ...liveReviews(m, from),
      {
        arms: Object.fromEntries(
          arms.map(a => [a.key, { facing: a.facing, preview: preview(a.body) }])
        ),
        why,
      },
    ]);
  }
  const drawn = new Set([...sourcesOf(mixed, next).values()].flat());
  for (const { key } of rows)
    for (const fp of sources.get(groups.get(key)))
      if (fp !== key && !drawn.has(fp)) delete next[fp];
  return { allowlist: next, recorded: rows.length, problems };
}

// Rebuilds `allowlist` from the current scan: each group's reviews filed under
// its fingerprint with only the arms it still raises at the recorded facing.
// Reports the entries no group draws on, the entries filed under a new
// fingerprint, and the arms dropped from the rest.
export function pruneReviews(allowlist, mixed) {
  const sources = sourcesOf(mixed, allowlist);
  const next = {};
  const kept = new Map();
  const rekeyed = [];
  for (const m of mixed) {
    const from = sources.get(m);
    if (!from.length) continue;
    const facing = new Map(m.other.map(a => [a.key, a.facing]));
    for (const fp of from) {
      if (fp !== m.fingerprint) rekeyed.push({ from: fp, to: m.fingerprint });
      if (!kept.has(fp)) kept.set(fp, new Set());
      for (const r of allowlist[fp].reviews || [])
        for (const [k, v] of Object.entries(r.arms || {}))
          if (r.why && facing.get(k) === v.facing) kept.get(fp).add(k);
    }
    const reviews = liveReviews(
      m,
      from.map(fp => allowlist[fp])
    );
    if (reviews.length) next[m.fingerprint] = entryFor(m, reviews);
  }
  const removedEntries = [];
  const removedArms = [];
  for (const [fp, e] of Object.entries(allowlist)) {
    if (!kept.get(fp)?.size) {
      removedEntries.push({ key: fp, ...e });
      continue;
    }
    for (const r of e.reviews || [])
      for (const [k, v] of Object.entries(r.arms || {}))
        if (!kept.get(fp).has(k)) removedArms.push({ entry: fp, key: k, ...v });
  }
  return { allowlist: next, removedEntries, removedArms, rekeyed };
}

// Sorted keys, two-space indent, one line per covered arm.
export function formatAllowlist(allowlist) {
  const fmt = (v, indent) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const inner = indent + '  ';
    if (Array.isArray(v))
      return v.length
        ? `[\n${v.map(x => inner + fmt(x, inner)).join(',\n')}\n${indent}]`
        : '[]';
    const keys = Object.keys(v).sort();
    if (keys.join() === 'facing,preview')
      return `{"facing": ${JSON.stringify(v.facing)}, "preview": ${JSON.stringify(v.preview)}}`;
    return keys.length
      ? `{\n${keys.map(k => `${inner}${JSON.stringify(k)}: ${fmt(v[k], inner)}`).join(',\n')}\n${indent}}`
      : '{}';
  };
  return fmt(allowlist, '') + '\n';
}

function writeAllowlist(file, allowlist) {
  const text = formatAllowlist(allowlist);
  JSON.parse(text);
  fs.writeFileSync(file, text);
}

function parseArgs(argv) {
  const opt = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) opt.positional.push(argv[i]);
    else if (m[1] === 'json' || m[1] === 'prune') opt[m[1]] = true;
    else if (['cache', 'allowlist', 'record'].includes(m[1]))
      opt[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    else throw new Error(`unknown option --${m[1]}`);
  }
  return opt;
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const allowlistPath = opt.allowlist || DEFAULT_ALLOWLIST;
  if (opt.positional.length !== 2 || (opt.record && opt.prune)) {
    console.error(
      'usage: node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json> [--cache F] [--allowlist F] [--json] [--record <reviews.json> | --prune]'
    );
    process.exit(2);
  }
  const [cli, json] = opt.positional;
  const catalogue = JSON.parse(fs.readFileSync(json, 'utf8')).prompts;
  const cache = JSON.parse(fs.readFileSync(opt.cache || DEFAULT_CACHE, 'utf8'));
  const allowlist = fs.existsSync(allowlistPath)
    ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
    : {};
  const r = scanSiblingArms(cli, { catalogue, cache });
  const say = opt.json ? console.error : console.log;
  for (const u of r.unparsed)
    console.error(
      `UNPARSED segment ${u.name || '(bundle)'}@${u.start}: ${u.error}`
    );
  const collisions = fingerprintCollisions(r.mixed);
  for (const fp of collisions)
    console.error(
      `COLLISION ${fp}: groups @${r.mixed
        .filter(m => m.fingerprint === fp)
        .map(m => m.at)
        .join(', @')} share one fingerprint, so one review would cover both`
    );
  if ((opt.record || opt.prune) && (r.unparsed.length || collisions.length)) {
    console.error(
      'mixed call verdicts: refusing to write: the scan is incomplete or ambiguous'
    );
    process.exit(2);
  }
  if (opt.record) {
    const reviews = JSON.parse(fs.readFileSync(opt.record, 'utf8'));
    const rec = recordReviews(allowlist, reviews, r.mixed);
    for (const p of rec.problems) console.error(`FAIL ${p}`);
    if (rec.recorded) writeAllowlist(allowlistPath, rec.allowlist);
    console.log(`mixed call verdicts: recorded ${rec.recorded} review(s)`);
    process.exit(rec.problems.length ? 1 : 0);
  }
  if (opt.prune) {
    const p = pruneReviews(allowlist, r.mixed);
    for (const e of p.removedEntries)
      console.log(
        `PRUNED entry ${e.key} @${e.at}: ${JSON.stringify(preview(e.reviews?.[0]?.why ?? ''))}`
      );
    for (const a of p.removedArms)
      console.log(
        `PRUNED arm ${a.key} (${a.facing}) from ${a.entry}: ${JSON.stringify(a.preview)}`
      );
    for (const k of p.rekeyed) console.log(`REKEYED ${k.from} -> ${k.to}`);
    writeAllowlist(allowlistPath, p.allowlist);
    console.log(
      `mixed call verdicts: pruned ${p.removedEntries.length} entr(ies) and ${p.removedArms.length} arm(s), re-keyed ${p.rekeyed.length}; ${Object.keys(p.allowlist).length} entr(ies) kept`
    );
    process.exit(0);
  }
  const open = unreviewedMixed(r.mixed, allowlist);
  if (opt.json) console.log(JSON.stringify(open, null, 1));
  else
    for (const m of open) {
      console.log(
        `MIXED ${m.fingerprint} @${m.at} arg ${m.position}: ${m.uncovered.length} of ${m.other.length} arm(s) unreviewed${m.carriedFrom ? ` (reviews carried from ${m.carriedFrom.join(', ')})` : ''}`
      );
      for (const a of m.model)
        console.log(`  model    ${a.key} ${JSON.stringify(a.body)}`);
      for (const a of m.uncovered)
        console.log(
          `  ${a.facing.padEnd(8)} ${a.key} ${JSON.stringify(a.body)}`
        );
    }
  const arms = open.reduce((n, m) => n + m.uncovered.length, 0);
  const p = pruneReviews(allowlist, r.mixed);
  const stale =
    p.removedEntries.length + p.removedArms.length + p.rekeyed.length;
  say(
    `mixed call verdicts: ${open.length} unreviewed of ${r.mixed.length} call group(s) ruled both model and ui/internal (${arms} arm(s) to review${stale ? `; ${p.removedEntries.length} stale entr(ies), ${p.removedArms.length} stale arm(s), ${p.rekeyed.length} to re-key: run --prune` : ''})`
  );
  process.exit(
    r.unparsed.length || collisions.length ? 2 : open.length ? 1 : 0
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
