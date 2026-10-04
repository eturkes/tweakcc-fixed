// Emission sites and routes for classify candidates, cached per bundle.
//
// Sites come from the extractor's own AST pass (collectLiteralSites), keyed by
// sha1 of the exact body it hashes, so a candidate maps to EVERY literal that
// carries it — not to the first substring match. Routes come from the
// emission-route tracer. Both are written once per bundle sha to a cache file
// so classify agents and later queries never re-derive them from the bundle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { RouteProgram, summarizeRoute, SINKS } from './emissionRoute.mjs';

const require = createRequire(import.meta.url);

export const CACHE_FORMAT = 2;
export const DEFAULT_CACHE_DIR = '/tmp/tweakcc-route-cache';

export const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
// The cached summary memoises interpreter results (callers, onDone sites), so
// it is only valid for the tracer that wrote it.
export const TRACER_SHA = crypto
  .createHash('sha1')
  .update(fs.readFileSync(new URL('./emissionRoute.mjs', import.meta.url)))
  .update(fs.readFileSync(new URL('./classifyRoutes.mjs', import.meta.url)))
  .digest('hex')
  .slice(0, 12);
export const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Only prose-like literals are worth indexing: a candidate is English text.
const indexable = body => body.length >= 12 && /\s/.test(body);

export function cachePathFor(cacheDir, bundleSha) {
  return path.join(cacheDir || DEFAULT_CACHE_DIR, `route-${bundleSha.slice(0, 16)}.json`);
}

// literal records -> Map(sha1(body) -> [[start, end, kind]])
export function buildSiteIndex(records) {
  const idx = new Map();
  for (const r of records) {
    if (!r || typeof r.cacheBody !== 'string' || !indexable(r.cacheBody)) continue;
    const h = sha1(r.cacheBody);
    const k = r.kind === 'template' ? 't' : 's';
    const list = idx.get(h);
    if (list) list.push([r.start, r.end, k]);
    else idx.set(h, [[r.start, r.end, k]]);
  }
  return idx;
}

export function collectSites(cliPath) {
  const ex = require('../promptExtractor.js');
  const log = console.log;
  const warn = console.warn;
  // The extractor narrates its pass; the caller only wants the records.
  console.log = () => {};
  console.warn = () => {};
  try {
    return ex.collectLiteralSites(cliPath);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function settingsIndexFor(code) {
  const { buildSettingsIndex } = require('./settingsSchema.cjs');
  const out = new Map();
  for (const [k, v] of buildSettingsIndex(code)) {
    if (!v.safe) continue;
    out.set(k, { internal: /^.@internal/.test(code.slice(k, k + 12)) });
  }
  return out;
}

// Body encodings a captured candidate may differ by from the literal the
// extractor hashed: the catalogue stores the CC version as a placeholder.
function bodyVariants(body, version) {
  const out = [body];
  if (version && body.includes('<<CCVERSION>>')) out.push(body.split('<<CCVERSION>>').join(version));
  return out;
}

// Every occurrence of `needle` in the bundle (bounded).
function allIndexes(code, needle, cap = 50) {
  const out = [];
  if (!needle) return out;
  for (let i = code.indexOf(needle); i >= 0 && out.length < cap; i = code.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const escapeCtl = s => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
const escapeUnicode = s => s.replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const ENCODINGS = [s => s, escapeCtl, escapeUnicode, s => escapeUnicode(escapeCtl(s))];

// The literal node that contains bundle offset `at`, from a sorted site list.
function enclosingLiteral(sorted, at) {
  let lo = 0, hi = sorted.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid][0] <= at) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = best; i != null && i >= 0 && i > best - 50; i--) {
    const s = sorted[i];
    if (s[0] <= at && at < s[1]) return s;
  }
  return null;
}

// Sites for one candidate. Exact hash first; then the composite case (a body
// the extractor assembled from several array elements joined by newlines);
// then a text search that enumerates EVERY occurrence and names the literal
// each one sits in.
export function sitesFor(cand, { siteIndex, code, sortedSites, version }) {
  for (const b of bodyVariants(cand.body, version)) {
    const hit = siteIndex.get(sha1(b));
    if (hit) return { method: 'ast-exact', sites: hit.map(([start, end, kind]) => ({ start, end, kind })) };
  }
  const parts = cand.body.split('\n').filter(x => x.trim());
  if (parts.length > 1) {
    const found = parts.map(p => siteIndex.get(sha1(p)) || []);
    if (found.every(f => f.length)) {
      return { method: 'ast-composite', sites: found.flat().map(([start, end, kind]) => ({ start, end, kind, fragment: true })) };
    }
  }
  if (!code) return { method: 'none', sites: [] };
  const runs = cand.body.split(/\$\{[^}]*\}/g).map(s => s.trim()).filter(s => s.length >= 24).sort((a, b) => b.length - a.length);
  for (const run of runs.slice(0, 6)) {
    for (const enc of ENCODINGS) {
      const needle = enc(run).slice(0, 200);
      if (needle.length < 24) continue;
      const at = allIndexes(code, needle);
      if (!at.length) continue;
      const seen = new Set();
      const sites = [];
      for (const a of at) {
        const lit = sortedSites ? enclosingLiteral(sortedSites, a) : null;
        const key = lit ? lit[0] : a;
        if (seen.has(key)) continue;
        seen.add(key);
        sites.push(lit ? { start: lit[0], end: lit[1], kind: lit[2] === 't' ? 'template' : 'string', textMatch: true } : { start: a, end: a + needle.length, kind: 'text', textMatch: true });
      }
      return { method: 'text-search', sites };
    }
  }
  return { method: 'none', sites: [] };
}

// Build (or load) the per-bundle cache and trace every candidate site.
// Returns { program, siteIndex, routesByHash, cachePath, bundleSha }.
export async function routesForCandidates({ cliPath, cands, version, cacheDir, log = () => {} }) {
  const code = fs.readFileSync(cliPath, 'utf8');
  const bundleSha = crypto.createHash('sha256').update(code).digest('hex');
  const cachePath = cachePathFor(cacheDir, bundleSha);
  let cached = null;
  if (fs.existsSync(cachePath)) {
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.format !== CACHE_FORMAT || cached.bundleSha !== bundleSha || cached.tracer !== TRACER_SHA) cached = null;
    } catch {
      cached = null;
    }
  }
  let siteIndex;
  let program;
  if (cached) {
    log(`route cache hit: ${cachePath}`);
    siteIndex = new Map(cached.sites);
    program = RouteProgram.fromJSON(cached.program, code);
  } else {
    log('collecting literal sites with the extractor...');
    siteIndex = buildSiteIndex(collectSites(cliPath));
    log(`indexed ${siteIndex.size} prose literal bodies; building settings index...`);
    program = new RouteProgram(code, { settingsIndex: settingsIndexFor(code) });
  }
  const sortedSites = [...siteIndex.values()].flat().sort((a, b) => a[0] - b[0]);
  const routesByHash = new Map();
  for (const c of cands) {
    const located = sitesFor(c, { siteIndex, code, sortedSites, version });
    const routes = located.sites.map(s => ({ ...s, route: s.kind === 'text' ? null : program.trace(s.start) }));
    routesByHash.set(c.hash, { method: located.method, sites: routes, route: combineRoutes(routes.map(r => r.route).filter(Boolean)) });
  }
  program.ondoneCallSites();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: CACHE_FORMAT, tracer: TRACER_SHA, bundleSha, bundlePath: path.resolve(cliPath), createdAt: new Date().toISOString(), sites: [...siteIndex], program: program.toJSON() }));
  fs.renameSync(tmp, cachePath);
  return { program, siteIndex, routesByHash, cachePath, bundleSha, code };
}

// One candidate can sit at several sites; a model proof at ANY site makes it
// model-facing, and it is resolved only when every site is.
export function combineRoutes(routes) {
  if (!routes.length) return { verdict: null, resolved: false, sinks: [], unresolved: [{ reason: 'no emission site located' }] };
  const sinks = routes.flatMap(r => r.sinks);
  const unresolved = routes.flatMap(r => r.unresolved);
  const model = sinks.some(s => s.facing === 'model');
  const resolved = routes.every(r => r.resolved);
  const verdict = model ? 'model' : resolved ? (sinks.some(s => s.facing === 'ui') ? 'ui' : 'internal') : null;
  return { verdict, resolved, sinks, unresolved };
}

// The compact form that goes into a packet: what proved what, and why the
// rest is open. Model and undecided sinks carry their call chain (the proof
// to check); UI/internal sinks are listed by kind with a count. Bounded so a
// route never crowds out the body it explains.
export function compactRoute(route, { maxSinks = 4, maxOpen = 3 } = {}) {
  const sinks = [];
  const seenKind = new Map();
  // Model proofs first: they are what an agent must check, and a cap that
  // dropped one would hide the reason the verdict is "model".
  const ordered = [...route.sinks.filter(s => s.facing === 'model'), ...route.sinks.filter(s => s.facing == null)];
  for (const s of ordered) {
    const n = seenKind.get(s.kind) || 0;
    if (n >= 2 || sinks.length >= maxSinks) continue;
    seenKind.set(s.kind, n + 1);
    sinks.push({ kind: s.kind, facing: s.facing, at: s.at, ...(s.command ? { command: s.command } : {}), ...(s.display != null ? { display: s.display } : {}), ...(s.guarded ? { guarded: true } : {}), ...(s.via && s.via.length ? { via: s.via.slice(-3).join(' > ') } : {}) });
  }
  const other = {};
  for (const s of route.sinks) {
    if (s.facing !== 'ui' && s.facing !== 'internal') continue;
    const k = `${s.kind}`;
    other[k] = (other[k] || 0) + 1;
  }
  const firstAt = {};
  for (const s of route.sinks) if ((s.facing === 'ui' || s.facing === 'internal') && firstAt[s.kind] == null && s.kind !== 'compare') firstAt[s.kind] = s.at;
  const open = [];
  const seenReason = new Set();
  for (const u of route.unresolved) {
    if (seenReason.has(u.reason) || open.length >= maxOpen) continue;
    seenReason.add(u.reason);
    open.push(`${u.reason} @${u.at ?? '?'}`);
  }
  return {
    verdict: route.verdict,
    resolved: route.resolved,
    ...(sinks.length ? { sinks } : {}),
    ...(Object.keys(other).length ? { nonModel: other, nonModelAt: firstAt } : {}),
    ...(open.length ? { open, openTotal: route.unresolved.length } : {}),
  };
}

export { SINKS, summarizeRoute };
