#!/usr/bin/env node
// Where does a string's value go? Prints the proven sinks and the branches the
// tracer could not follow, for one literal of a Claude Code bundle.
//
//   node tools/traceEmissionRoute.mjs --cache <route-cache.json> --offset <N> [--json]
//   node tools/traceEmissionRoute.mjs --cli <cli.js> (--offset N | --text "..." | --hash <sha1>) [--cache-dir D] [--json] [--full]
//
// With --cache only, it answers from the per-bundle summary that
// buildClassifyEvidence wrote (no bundle load) and says so when the offset is
// outside it; with --cli it loads the bundle, reusing that summary when one
// exists for the same sha. --text enumerates every literal containing the text.
// Offsets are bundle offsets of the literal (the packet's sites[].start); any
// offset inside a literal is accepted with --cli.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RouteProgram } from './lib/emissionRoute.mjs';
import { cachePathFor, CACHE_FORMAT, TRACER_SHA } from './lib/classifyRoutes.mjs';
import { parseArgs } from './buildClassifyEvidence.mjs';

const opt = parseArgs(process.argv.slice(2));
const asJson = 'json' in opt;
if (!opt.cache && !opt.cli) {
  console.error('usage: traceEmissionRoute.mjs (--cache <route-cache.json> | --cli <cli.js>) (--offset N | --text "..." | --hash H) [--json]');
  process.exit(2);
}

let cache = null;
let code = null;
if (opt.cli) {
  code = fs.readFileSync(opt.cli, 'utf8');
  const sha = crypto.createHash('sha256').update(code).digest('hex');
  const cp = opt.cache || cachePathFor(opt['cache-dir'], sha);
  if (fs.existsSync(cp)) {
    const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
    if (c.format === CACHE_FORMAT && c.bundleSha === sha && c.tracer === TRACER_SHA) cache = c;
  }
} else {
  cache = JSON.parse(fs.readFileSync(opt.cache, 'utf8'));
  if (cache.format !== CACHE_FORMAT || cache.tracer !== TRACER_SHA) throw new Error('route cache was written by another tracer version; rebuild it with buildClassifyEvidence (or pass --cli)');
}
const program = cache ? RouteProgram.fromJSON(cache.program, code) : new RouteProgram(code);
const sites = cache ? new Map(cache.sites) : new Map();
const sorted = [...sites.values()].flat().sort((a, b) => a[0] - b[0]);

function literalAt(off) {
  let best = null;
  for (const s of sorted) {
    if (s[0] > off) break;
    if (s[0] <= off && off < s[1]) best = s;
  }
  return best;
}

const targets = [];
if (opt.offset != null) {
  const off = Number(opt.offset);
  const lit = literalAt(off);
  targets.push(lit ? lit[0] : off);
} else if (opt.hash) {
  for (const s of sites.get(opt.hash) || []) targets.push(s[0]);
  if (!targets.length) throw new Error(`hash ${opt.hash} has no indexed literal site${cache ? '' : ' (pass --cli with a built cache)'}`);
} else if (opt.text) {
  if (!code) throw new Error('--text needs --cli');
  const enc = [opt.text, JSON.stringify(opt.text).slice(1, -1)];
  const seen = new Set();
  for (const needle of enc) {
    for (let i = code.indexOf(needle); i >= 0 && targets.length < 40; i = code.indexOf(needle, i + 1)) {
      const lit = literalAt(i);
      const at = lit ? lit[0] : null;
      if (at != null && !seen.has(at)) { seen.add(at); targets.push(at); }
    }
  }
  if (!targets.length) throw new Error('text not found inside an indexed literal');
}

const out = [];
for (const t of targets) {
  const key = 'L' + t;
  if (program.offline && !program.memo.has(key)) {
    out.push({ offset: t, error: 'not in the cached summary — rerun with --cli <cli.js>' });
    continue;
  }
  const route = program.trace(t);
  out.push({ offset: t, family: program.offline ? null : program.familyOf(t), route });
}

if (asJson) {
  console.log(JSON.stringify(out, null, 1));
} else {
  for (const o of out) {
    if (o.error) { console.log(`@${o.offset}: ${o.error}`); continue; }
    const r = o.route;
    console.log(`@${o.offset}${o.family && o.family.head ? `  in ${o.family.head}` : ''}`);
    console.log(`  verdict: ${r.verdict || 'open'}  resolved: ${r.resolved}  states: ${r.states}`);
    const show = 'full' in opt ? r.sinks : r.sinks.slice(0, 12);
    for (const s of show) console.log(`  sink ${s.kind} [${s.facing ?? 'open'}] @${s.at}${s.command ? ` /${s.command}` : ''}${s.guarded ? ' (behind an instanceof guard)' : ''}${s.via && s.via.length ? `\n      via ${s.via.join(' → ')}` : ''}`);
    if (r.moreSinks) console.log(`  … more sinks: ${JSON.stringify(r.moreSinks)}`);
    for (const u of r.unresolved.slice(0, 'full' in opt ? 100 : 8)) console.log(`  open: ${u.reason} @${u.at ?? '?'}`);
    if (r.note) console.log(`  note: ${r.note}`);
  }
}
