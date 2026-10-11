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
// A reviewed group is recorded in data/mixed-call-verdicts.json under a key
// that covers every ruled arm and its facing, with the reason its call sites
// route differently. A group is raised again whenever a verdict or an arm
// changes.
//
// Usage:
//   node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json>
//     [--cache data/prompt-classification.json]
//     [--allowlist data/mixed-call-verdicts.json] [--json]
//   node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json>
//     --record <reviews.json> [--cache F] [--allowlist F]
// <reviews.json> is [{key, at, why}], one per group whose split stands; a
// group with a wrong verdict is fixed in the classification cache instead.
// Exit 0 = every mixed group reviewed, 1 = unreviewed groups, 2 = usage error
// or a bundle segment that could not be parsed.
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

export function unreviewedMixed(mixed, allowlist) {
  return mixed.filter(m => !allowlist[m.key]?.why);
}

// Appends as text so every existing byte stays in place.
export function recordReviews(allowlistPath, reviews, mixedByKey) {
  const raw = fs.existsSync(allowlistPath)
    ? fs.readFileSync(allowlistPath, 'utf8')
    : '{\n}\n';
  const current = JSON.parse(raw);
  const problems = [];
  const rows = [];
  for (const r of reviews) {
    if (!r || typeof r.key !== 'string' || !/^[0-9a-f]{16}$/.test(r.key))
      problems.push(`bad key: ${JSON.stringify(r?.key)}`);
    else if (typeof r.why !== 'string' || r.why.trim().length < 20)
      problems.push(`${r.key}: why must name the differing routes`);
    else if (current[r.key]) problems.push(`${r.key}: already recorded`);
    else if (mixedByKey && !mixedByKey.has(r.key))
      problems.push(`${r.key}: not a current mixed group`);
    else rows.push(r);
  }
  if (problems.length) return { appended: 0, problems };
  if (!rows.length) return { appended: 0, problems };
  const body = rows
    .map(r => {
      const m = mixedByKey?.get(r.key);
      const entry = {
        at: r.at ?? m?.at,
        why: r.why,
        ...(m && { model: m.model, other: m.other }),
      };
      return (
        '  ' +
        JSON.stringify(r.key) +
        ': ' +
        JSON.stringify(entry, null, 2).replace(/\n/g, '\n  ')
      );
    })
    .join(',\n');
  const empty = Object.keys(current).length === 0;
  const head = raw.replace(/\n?\}\n?$/, '');
  const next = (empty ? '{\n' : head + ',\n') + body + '\n}\n';
  JSON.parse(next);
  fs.writeFileSync(allowlistPath, next);
  return { appended: rows.length, problems };
}

function parseArgs(argv) {
  const opt = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) opt.positional.push(argv[i]);
    else if (m[1] === 'json') opt.json = true;
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
  if (opt.positional.length !== 2) {
    console.error(
      'usage: node tools/checkMixedCallVerdicts.mjs <cli.js> <prompts.json> [--cache F] [--allowlist F] [--json] [--record <reviews.json>]'
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
  if (opt.record) {
    const reviews = JSON.parse(fs.readFileSync(opt.record, 'utf8'));
    const rec = recordReviews(
      allowlistPath,
      reviews,
      new Map(r.mixed.map(m => [m.key, m]))
    );
    for (const p of rec.problems) console.error(`FAIL ${p}`);
    console.log(`mixed call verdicts: recorded ${rec.appended} review(s)`);
    process.exit(rec.problems.length ? 1 : 0);
  }
  const open = unreviewedMixed(r.mixed, allowlist);
  const say = opt.json ? console.error : console.log;
  if (opt.json) console.log(JSON.stringify(open, null, 1));
  else
    for (const m of open) {
      console.log(`MIXED ${m.key} @${m.at}`);
      for (const b of m.model) console.log(`  model    ${JSON.stringify(b)}`);
      for (const o of m.other)
        console.log(`  ${o.facing.padEnd(8)} ${JSON.stringify(o.body)}`);
    }
  for (const u of r.unparsed)
    say(`UNPARSED segment ${u.name || '(bundle)'}@${u.start}: ${u.error}`);
  say(
    `mixed call verdicts: ${open.length} unreviewed of ${r.mixed.length} call group(s) ruled both model and ui/internal`
  );
  process.exit(r.unparsed.length ? 2 : open.length ? 1 : 0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
