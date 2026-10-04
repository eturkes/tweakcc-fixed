#!/usr/bin/env node
// Answer MANY bundle lookups in one call (one bundle load, one agent turn).
//
//   node tools/bundleQuery.mjs --cli /tmp/cli-X.Y.Z.js [--catalogue prompts.json] \
//     [--classification data/prompt-classification.json] [--cache-dir D] [--in queries.json] <<'Q'
//   [{"slice":4221262},{"callers":4225521,"depth":2},{"prop":"replaceInstalledCopy"}]
//   Q
//
// Queries (a JSON array; any number per call):
//   {"slice":N,"before":400,"after":400}  minified code around offset N
//   {"fn":N,"max":2500}                   enclosing function of N: name, range, guards, source
//   {"callers":N,"depth":1..3}            call sites of the function enclosing N (with their guards),
//                                         then of their callers, through imports/re-exports
//   {"refs":"name","at":N}                every reference of the binding `name` visible at N,
//                                         in its module and in every module importing it
//   {"prop":"name"}                       where an object property / option is SET vs READ
//   {"guards":N}                          the if/ternary/&&/switch arms N sits behind
//   {"text":"literal","max":15}           every occurrence (raw, JSON- and \u-escaped) with its
//                                         literal, cached facing and enclosing function
//   {"regex":"src","flags":"i","max":15}  regex hits with enclosing function
//   {"trace":N}                           emission route of the literal at N
//   {"siblings":N}                        every literal emitted by the family function around N,
//                                         with its cached facing (classification cache)
//   {"catalogue":"text"}                  catalogued prompts whose body or id contains the text
//   {"aliases":N}                         destructured props of the functions around N
//                                         ({setError:k,setResult:v} -> k=setError, v=setResult) and
//                                         which prop the call at N invokes
//
// Answers come from the bundle plus the per-bundle route cache that
// buildClassifyEvidence writes (/tmp/tweakcc-route-cache/route-<sha16>.json);
// without one the tracer runs cold (slower, no literal index). Output is plain
// text: one "## q<N> <query>" block per query, each capped at --cap chars.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RouteProgram } from './lib/emissionRoute.mjs';
import { cachePathFor, CACHE_FORMAT, TRACER_SHA } from './lib/classifyRoutes.mjs';
import { BundleIndex, renderAnswer } from './lib/bundleQuery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opt = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) rest.push(argv[i]);
    else opt[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return { opt, rest };
}

export function loadIndex({ cli, cacheDir, cache, catalogue, classification }) {
  const code = fs.readFileSync(cli, 'utf8');
  const sha = crypto.createHash('sha256').update(code).digest('hex');
  const cp = cache || cachePathFor(cacheDir, sha);
  let c = null;
  let note = null;
  if (fs.existsSync(cp)) {
    try {
      c = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (c.format !== CACHE_FORMAT || c.bundleSha !== sha || c.tracer !== TRACER_SHA) {
        note = `route cache ${cp} is for another bundle or tracer; answering cold`;
        c = null;
      }
    } catch {
      c = null;
    }
  } else note = `no route cache at ${cp}; answering cold (no literal index)`;
  const program = c ? RouteProgram.fromJSON(c.program, code) : new RouteProgram(code);
  const readJson = f => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  const cat = readJson(catalogue);
  return {
    index: new BundleIndex({
      code,
      program,
      sites: c ? new Map(c.sites) : null,
      classification: readJson(classification),
      catalogue: cat ? cat.prompts || [] : [],
    }),
    note,
    sha,
  };
}

function main() {
  const { opt, rest } = parseArgs(process.argv.slice(2));
  if (!opt.cli) {
    console.error('usage: bundleQuery.mjs --cli <cli.js> [--catalogue prompts.json] [--classification f.json] [--cache-dir D] [--in queries.json | \'<json>\' | stdin]');
    process.exit(2);
  }
  let raw;
  if (opt.in) raw = fs.readFileSync(opt.in === '-' ? 0 : opt.in, 'utf8');
  else if (rest.length) raw = rest.join(' ');
  else raw = fs.readFileSync(0, 'utf8');
  let queries;
  try {
    queries = JSON.parse(raw);
  } catch (e) {
    console.error(`bundleQuery: the queries are not JSON (${e.message})`);
    process.exit(2);
  }
  if (!Array.isArray(queries)) queries = queries && Array.isArray(queries.queries) ? queries.queries : [queries];
  const classification = opt.classification || path.join(HERE, '..', 'data', 'prompt-classification.json');
  const { index, note } = loadIndex({ cli: opt.cli, cacheDir: opt['cache-dir'], cache: opt.cache, catalogue: opt.catalogue, classification });
  if (note) console.log(`(${note})`);
  const cap = Number(opt.cap || 6000);
  queries.forEach((q, i) => {
    console.log(`## q${i + 1} ${JSON.stringify(q)}`);
    let text;
    try {
      text = renderAnswer(index.run(q));
    } catch (e) {
      text = `error: ${e.message}`;
    }
    console.log(text.length > cap ? `${text.slice(0, cap)}\n… [answer cut at ${cap} chars; narrow the query or pass --cap]` : text);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
