#!/usr/bin/env node
// Builds the evidence directory the classify-and-name-prompts workflow reads.
//
// Wording is not evidence of facing; the emission route is. Each packet pins a
// candidate to EVERY literal in the pristine bundle that carries it (from the
// extractor's own AST pass), quotes the minified code around the first sites,
// and carries the traced route: the sinks its value provably reaches (a
// tool_result, a local-command result, a local-jsx onDone, an Ink child, a
// debug log…) and the branches the tracer could not follow. Candidates are
// grouped by the function that emits them so one agent rules a family
// consistently, and the families are cut into ceil(candidates /
// --candidates-per-agent) chunks of near-equal rendered size.
//
//   node tools/buildClassifyEvidence.mjs --cli /tmp/cli-X.Y.Z.js \
//     --prompts data/prompts/prompts-X.Y.Z.json --prev data/prompts/prompts-P.json \
//     --out /tmp/classify-evidence-X.Y.Z [--piebald /tmp/pieb-X.Y.Z.json] \
//     [--candidates <file.json>] [--cache-dir /tmp/tweakcc-route-cache] \
//     [--classification data/prompt-classification.json] \
//     [--settings-oracle data/settings-descriptions/oracle-X.Y.Z.json] \\
//     [--candidates-per-agent N]
//
// Candidates default to /tmp/classify-chunk-NN.json (driver classify-candidates).
// Writes <out>/manifest.json, chunk-NN.json (the machine record the checker
// reads), chunk-NN.md (the whole markdown packet) and, when it is larger than
// one Read call, its parts chunk-NN.partK.md (what the agent reads, every part
// in one message; tools/lib/packetParts.mjs), existing-ids.json and
// catalogue-index.json, and clears any packet or verdict files a previous
// build left.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { routesForCandidates, compactRoute, sha1 } from './lib/classifyRoutes.mjs';
import { BundleIndex } from './lib/bundleQuery.mjs';
import { partitionContiguous, agentsFor } from './lib/packByWeight.mjs';
import { writeMarkdownParts, partByteCap } from './lib/packetParts.mjs';
import { attachContinuity } from './lib/continuity.mjs';
import { rewriteTablePairs } from './checkScannedLiterals.mjs';
import {
  catalogueNeighbourIndex,
  rewriteRoles,
  snippetBook,
  propSetLine,
  renderFamilyMd,
  renderCandidateMd,
  renderChunkHeaderMd,
} from './lib/classifyPacketMd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) { (opt._ ||= []).push(argv[i]); continue; }
    opt[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return opt;
}

const bodyOf = p => (p.pieces || []).filter(x => typeof x === 'string').join('') || p.content || '';
const readPrompts = f => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).prompts || [];
  } catch {
    return [];
  }
};

export function loadCandidates(file) {
  if (file) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(doc) ? doc : doc.candidates || [];
  }
  const files = fs.readdirSync('/tmp').filter(f => /^classify-chunk-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('no candidates: pass --candidates or run `driver classify-candidates` first (/tmp/classify-chunk-NN.json)');
  const out = [];
  const seen = new Set();
  for (const f of files) for (const c of JSON.parse(fs.readFileSync(path.join('/tmp', f), 'utf8'))) {
    if (seen.has(c.hash)) continue;
    seen.add(c.hash);
    out.push(c);
  }
  return out;
}

// Candidates one classify agent rules. Set from the 2.1.288 batching replay
// (see memory showtime-token-cost): per-agent cost there was dominated by the
// fixed context every agent pays, not by the candidates it ruled.
export const CANDIDATES_PER_AGENT = 67;

// Cut the families, in bundle order, into `agents` chunks of near-equal
// weight. A family stays in one chunk unless it is heavier than an even share
// (total / agents); then it is split into consecutive parts and each part says
// so. Order is never changed, so neighbouring families of one module share a
// chunk.
export function packFamilies(families, { agents = 1 } = {}) {
  const total = families.reduce((a, f) => a + f.items.reduce((b, x) => b + x.weight, 0), 0);
  const share = total / Math.max(1, agents);
  const units = [];
  for (const fam of families) {
    const w = fam.items.reduce((a, x) => a + x.weight, 0);
    const pieces = w > share && fam.items.length > 1 ? partitionContiguous(fam.items, Math.ceil(w / share), x => x.weight) : [fam.items];
    for (const items of pieces) units.push({ key: fam.key, head: fam.head, items, weight: items.reduce((a, x) => a + x.weight, 0) });
  }
  const runs = partitionContiguous(units, agents, u => u.weight);
  const chunks = runs.map(run => {
    const fams = [];
    for (const u of run) {
      const last = fams[fams.length - 1];
      if (last && last.key === u.key) last.hashes.push(...u.items.map(x => x.hash));
      else fams.push({ key: u.key, head: u.head, hashes: u.items.map(x => x.hash) });
    }
    return { items: run.flatMap(u => u.items), weight: run.reduce((a, u) => a + u.weight, 0), families: fams };
  });
  // A family spread over several chunks is labelled part i of n in each.
  const spread = new Map();
  chunks.forEach((c, ci) => c.families.forEach(f => spread.set(f.key, [...(spread.get(f.key) || []), ci])));
  chunks.forEach((c, ci) => c.families.forEach(f => {
    const at = spread.get(f.key);
    if (at.length > 1) f.split = { part: at.indexOf(ci) + 1, of: at.length };
  }));
  return chunks;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt._ && opt._.length && !opt.cli) {
    console.error('buildClassifyEvidence: positional arguments are no longer accepted; see the usage in the file header (--cli/--prompts/--prev/--out).');
    process.exit(2);
  }
  for (const k of ['cli', 'prompts', 'prev', 'out']) {
    if (!opt[k]) {
      console.error(`buildClassifyEvidence: --${k} is required`);
      process.exit(2);
    }
  }
  for (const gone of ['md-bytes', 'chunk-count', 'chunk-bytes']) {
    if (opt[gone] !== undefined) {
      console.error(`buildClassifyEvidence: --${gone} is gone — chunks are no longer capped by bytes or count (a packet larger than one Read is split into part files); size the fan-out with --candidates-per-agent (default ${CANDIDATES_PER_AGENT}).`);
      process.exit(2);
    }
  }
  const perAgent = Number(opt['candidates-per-agent'] || CANDIDATES_PER_AGENT);
  if (!(Number.isInteger(perAgent) && perAgent > 0)) {
    console.error('buildClassifyEvidence: --candidates-per-agent must be a positive integer');
    process.exit(2);
  }
  const partBytes = partByteCap();
  const classificationPath = path.resolve(opt.classification || path.join(HERE, '..', 'data', 'prompt-classification.json'));
  const outDir = path.resolve(opt.out);
  const promptsJson = path.resolve(opt.prompts);
  const version = opt.version || JSON.parse(fs.readFileSync(promptsJson, 'utf8')).version;
  const cands = loadCandidates(opt.candidates);
  const bad = cands.filter(c => !/^[0-9a-f]{40}$/.test(c.hash || '') || typeof c.body !== 'string');
  if (bad.length) throw new Error(`${bad.length} candidate(s) without a 40-hex hash or a body (first: ${JSON.stringify(bad[0]).slice(0, 120)})`);

  const t0 = Date.now();
  const { program, siteIndex, routesByHash, cachePath, bundleSha, code } = await routesForCandidates({
    cliPath: opt.cli,
    cands,
    version,
    cacheDir: opt['cache-dir'],
    log: s => console.log(`  ${s}`),
  });

  // Catalogue: every live id, and the bodies each one names (the collision
  // check lets an id stay only on its own body).
  const current = readPrompts(promptsJson);
  const catalogue = {};
  for (const p of current) {
    if (!p.id) continue;
    (catalogue[p.id] ||= []);
    const h = sha1(bodyOf(p));
    if (!catalogue[p.id].includes(h)) catalogue[p.id].push(h);
  }
  const prevById = new Map();
  const prevPrompts = readPrompts(opt.prev);
  for (const p of prevPrompts) if (p.id && !prevById.has(p.id)) prevById.set(p.id, bodyOf(p));
  // Continuity hints travel with the candidates (driver classify-candidates);
  // a candidate that arrives without either one gets them computed here with
  // the same rules, so a packet never silently lacks the id a string lost.
  const bare = cands.filter(c => !c.reusedFrom && !c.possibleSuccessorOf);
  attachContinuity(bare, current, prevPrompts, { log: m => console.log(`  ${m} (filled by the builder)`), prevVer: path.basename(opt.prev) });
  const filled = bare.filter(c => c.reusedFrom || c.possibleSuccessorOf).length;
  // Weaker still: a removed id whose old body shares a slot-free 25-character
  // run with the candidate (the lead the removed-id pass uses later). It
  // catches restructures the shingle passes score too low (CC 2.1.288: two
  // removed approval messages merged into one ternary). Advisory only.
  const liveIds = new Set(current.filter(p => p.id).map(p => p.id));
  const removedBodies = [];
  for (const [id, b] of prevById) if (!liveIds.has(id) && b) removedBodies.push([id, b]);
  const removedLeads = body => {
    const hits = [];
    for (const [id, ob] of removedBodies) {
      let n = 0;
      for (let k = 0; k + 25 <= body.length; k += 3) {
        const w = body.slice(k, k + 25);
        if (w.includes('${') || w.includes('}')) continue;
        if (ob.includes(w)) n++;
      }
      if (n) hits.push({ id, windows: n });
    }
    return hits.sort((a, b) => b.windows - a.windows).slice(0, 3);
  };
  // The pristine /update-config capture: every settings-schema description the
  // model is sent. Authoritative for a settings .describe() candidate.
  const oraclePath = opt['settings-oracle'] ? path.resolve(opt['settings-oracle']) : path.join(HERE, '..', 'data', 'settings-descriptions', `oracle-${version}.json`);
  const normWs = t => String(t).replace(/\s+/g, ' ').trim();
  const oracle = fs.existsSync(oraclePath) ? (JSON.parse(fs.readFileSync(oraclePath, 'utf8')).descriptions || []).map(normWs) : null;
  const oracleSet = new Set(oracle || []);
  const oracleRole = body => {
    if (!oracle) return null;
    const b = normWs(body);
    if (oracleSet.has(b)) return 'exact';
    const runs = b.split(/\$\{[^}]*\}/).map(x => x.trim()).filter(x => x.length >= 16);
    if (runs.length && oracle.some(d => runs.every(r => d.includes(r)))) return 'contained';
    return null;
  };
  const piebaldByBody = new Map();
  if (opt.piebald && fs.existsSync(opt.piebald)) {
    for (const p of readPrompts(opt.piebald)) {
      if (!p.id) continue;
      const b = bodyOf(p);
      if (b && !piebaldByBody.has(b)) piebaldByBody.set(b, { id: p.id, name: p.name || '', desc: p.description || '' });
    }
  }

  // Packet entries.
  const entries = [];
  for (const c of cands) {
    const r = routesByHash.get(c.hash);
    const sites = r.sites;
    const route = compactRoute(r.route);
    const fam = sites.length ? program.familyOf(sites[0].start) : { key: 'unlocated' };
    const e = {
      hash: c.hash,
      len: c.body.length,
      source: c.source || 'captured',
      ...(c.hint ? { cachedFacing: c.hint } : {}),
      family: fam.key,
      lead: c.lead || '',
      body: c.body,
      siteMethod: r.method,
      siteCount: sites.length,
      sites: sites.slice(0, 6).map((s, i) => ({
        start: s.start,
        end: s.end,
        kind: s.kind,
        ...(s.fragment ? { fragment: true } : {}),
        ...(s.textMatch ? { textMatch: true } : {}),
        ...(i < 2 ? { before: code.slice(Math.max(0, s.start - 500), s.start), after: code.slice(s.end, s.end + 300) } : {}),
        ...(sites.length > 1 && s.route ? { route: compactRoute(s.route, { maxSinks: 2, maxOpen: 1 }) } : {}),
      })),
      route,
    };
    Object.defineProperty(e, 'fullRoute', { value: r.route, enumerable: false });
    const allowed = new Set();
    const pie = piebaldByBody.get(c.body);
    if (pie) { e.piebaldExact = pie; allowed.add(pie.id); }
    if (c.reusedFrom) {
      e.reusedFrom = c.reusedFrom;
      allowed.add(c.reusedFrom.id);
      const old = prevById.get(c.reusedFrom.id);
      if (old) e.reusedFromOldBody = old;
    }
    if (c.possibleSuccessorOf) {
      e.possibleSuccessorOf = c.possibleSuccessorOf;
      allowed.add(c.possibleSuccessorOf.id);
      const old = prevById.get(c.possibleSuccessorOf.id);
      if (old) e.possibleSuccessorOldBody = old;
    }
    e.allowedIds = [...allowed];
    if (!c.reusedFrom && !c.possibleSuccessorOf) {
      const leads = removedLeads(c.body);
      if (leads.length) e.removedIdLeads = leads.map(l => ({ ...l, oldBody: prevById.get(l.id) }));
    }
    const orc = oracleRole(c.body);
    if (orc) e.settingsOracle = orc;
    e.famHead = fam.head || null;
    e.famOrder = sites.length ? [program.segIndexAt(sites[0].start), fam.fn ?? sites[0].start] : [1e9, 0];
    entries.push(e);
  }

  // A candidate that is not one literal but a JOIN of several (a "+" concat or
  // array join the extractor captured whole) is tiled by the located
  // candidates its body contains. Ids belong on fragments: the join may never
  // take a fragment's id or the continuity id a fragment lost
  // (checkClassifyVerdicts enforces it); a model-facing join takes its own.
  const located = entries.filter(x => x.siteMethod === 'ast-exact' && x.body.trim().length >= 12);
  for (const e of entries) {
    if (e.siteMethod === 'ast-exact') continue;
    const parts = located.filter(x => x.hash !== e.hash && x.body.length < e.body.length && e.body.includes(x.body));
    if (!parts.length) continue;
    const covered = new Array(e.body.length).fill(false);
    for (const x of parts) {
      for (let i = e.body.indexOf(x.body); i >= 0; i = e.body.indexOf(x.body, i + 1)) for (let j = i; j < i + x.body.length; j++) covered[j] = true;
    }
    const allCandidates = [...e.body].every((ch, i) => covered[i] || /\s/.test(ch));
    const forbidden = new Set(parts.flatMap(x => x.allowedIds || []));
    if (e.reusedFrom) forbidden.add(e.reusedFrom.id);
    if (e.possibleSuccessorOf) forbidden.add(e.possibleSuccessorOf.id);
    e.joinOf = { hashes: parts.map(x => x.hash), keys: parts.map(x => x.hash.slice(0, 12)), allFragmentsAreCandidates: allCandidates, fragmentIds: [...forbidden] };
    // A continuity hint on a join names the id its fragment lost; the join
    // itself is not licensed to take it.
    e.allowedIds = (e.allowedIds || []).filter(id => !forbidden.has(id));
  }

  // Evidence an agent used to fetch one probe at a time, computed once here:
  // the conditions each site sits behind and where the options they test are
  // set, the callers of each emitting function (three levels, with their
  // conditions), the cached facing of the function's other literals, the
  // nearest catalogued prompts, and rewrite-table roles.
  const classification = fs.existsSync(classificationPath) ? JSON.parse(fs.readFileSync(classificationPath, 'utf8')) : {};
  const bq = new BundleIndex({ code, program, sites: siteIndex, classification, catalogue: current });
  const candHashes = new Set(cands.map(c => c.hash));
  const nearIdx = catalogueNeighbourIndex(current);
  const roles = rewriteRoles(rewriteTablePairs(code));
  // Option names a guard tests, with where the bundle SETS each one. Only a
  // specific option is worth the lines: a name set at more than 12 sites
  // (`source`, `entry`) says nothing about one call path.
  const propSets = new Map();
  const propSpecific = new Map();
  const noteProps = guards => {
    for (const g of guards) {
      for (const p of g.props) {
        if (propSpecific.has(p)) continue;
        const res = bq.prop(p, 4);
        const set = res.find(x => x.kind.startsWith('SET'));
        const specific = !!set && set.total <= 12;
        propSpecific.set(p, specific);
        if (specific) propSets.set(p, propSetLine(res));
      }
    }
  };
  // The conditions along each proven model path: at the literal, at every
  // return it leaves through and every call site it returns to. A model sink
  // behind an option no model-bound caller sets is not a model route (CC
  // 2.1.288: the plugin installer's switch messages only render when
  // replaceInstalledCopy is set, and the /plugin onDone caller never sets it).
  const modelPathGuards = full => {
    const out = [];
    const seen = new Set();
    let callerSide = 0;
    for (const sk of (full.sinks || []).filter(x => x.facing === 'model').slice(0, 3)) {
      for (const hop of sk.via || []) {
        if (/→fn@/.test(hop)) continue;
        const m = /@(\d+)/.exec(hop);
        if (!m) continue;
        // A caller-side hop (the value returns to, or is thrown at, a call
        // site) shows the condition under which that caller reaches the
        // callee at all; every such gate is listed. Elsewhere only
        // option-gated conditions are.
        const caller = /caller@/.test(hop);
        for (const g of bq.guards(Number(m[1]), caller ? 2 : 3)) {
          if (seen.has(g.at)) continue;
          seen.add(g.at);
          noteProps([g]);
          const gated = g.props.some(p => propSpecific.get(p));
          if (gated || (caller && callerSide < 4)) {
            if (!gated) callerSide++;
            out.push({ ...g, hop: hop.replace(/@.*/, ''), hopAt: Number(m[1]) });
          }
        }
      }
    }
    return out.slice(0, 8);
  };
  // Where the function holding the model sink is entered from, with the
  // condition at each entry (a call, or a JSX render): an entry point gated
  // to another case (CC 2.1.288: the /plugin installer view rendered only for
  // <pkg>@npm specs) closes the route even when the callee's own branches
  // look open.
  const sinkEntries = full => {
    const sk = (full.sinks || []).find(x => x.facing === 'model');
    const at = sk ? Number(/^(\d+)/.exec(String(sk.at || ''))?.[1]) : NaN;
    if (!Number.isFinite(at)) return null;
    // The sink usually sits in an inline callback (`.then(R=>onComplete(R))`,
    // an effect); the runtime calls those, so the entry that matters is the
    // function that hands them over.
    const enc = bq.enclosing(at);
    if (!enc || !enc.family) return null;
    const r = bq.callers(enc.family.start, 1, 3);
    const lvl = r.levels[0] && r.levels[0][0];
    if (!lvl || !lvl.total) return null;
    for (const c of lvl.calls) noteProps(c.guards);
    return { fn: { start: lvl.fn.start, name: lvl.fn.name }, total: lvl.total, calls: lvl.calls.map(c => ({ at: c.at, how: c.how, in: c.in ? { start: c.in.start, name: c.in.name } : null, guards: c.guards })) };
  };
  // Which destructured prop a minified callee is, at each sink / open offset.
  const aliasAt = at => {
    const o = Number(/^(\d+)/.exec(String(at || ''))?.[1]);
    return Number.isFinite(o) ? bq.calleeAlias(o) : null;
  };
  for (const e of entries) {
    const first = e.sites[0];
    e.guards = first ? bq.guards(first.start, 3) : [];
    noteProps(e.guards);
    const enc = first ? bq.enclosing(first.start) : null;
    e.inner = enc && enc.inner ? { start: enc.inner.start, end: enc.inner.end, name: enc.inner.name, head: enc.inner.head } : null;
    e.familyFn = e.famOrder[1];
    e.near = nearIdx.nearest(e.body);
    e.modelPath = e.route.verdict === 'model' ? modelPathGuards(e.fullRoute) : [];
    if (e.route.verdict === 'model') e.sinkEntry = sinkEntries(e.fullRoute);
    // A permission deny can be a payload of an OUTBOUND control_response to a
    // remote client (CC 2.1.288: answerOwnWithdrawnAsk) — transport, never a
    // local tool_result. Flag model sinks whose code mentions it.
    const outbound = [];
    for (const sk of e.route.sinks || []) {
      const o = Number(/^(\d+)/.exec(String(sk.at || ''))?.[1]);
      if (sk.facing === 'model' && Number.isFinite(o) && /control_response|control_request|control_cancel_request/.test(code.slice(Math.max(0, o - 400), o + 400))) outbound.push(sk.at);
    }
    if (outbound.length) e.outboundControl = outbound;
    const aliases = {};
    for (const sk of e.route.sinks || []) {
      const a = aliasAt(sk.at);
      if (a) aliases[sk.at] = `${a.local}=${a.key}`;
    }
    for (const o of e.route.open || []) {
      const mm = /@([\d+]+)$/.exec(o);
      const a = mm && aliasAt(mm[1]);
      if (a) aliases[mm[1]] = `${a.local}=${a.key}`;
    }
    if (Object.keys(aliases).length) e.calleeAliases = aliases;
    const role = roles.get(e.body);
    if (role) e.rewriteRole = role;
  }
  const famInfo = new Map();
  for (const e of entries) {
    if (famInfo.has(e.family) || !/^fn:\d+$/.test(e.family)) continue;
    const at = Number(e.family.slice(3));
    const enc = bq.enclosing(at);
    const fn = enc && enc.inner && enc.inner.start === at ? enc.inner : enc && enc.inner ? enc.inner : null;
    const callers = fn ? bq.callers(fn.start, 1, 4) : null;
    if (callers) for (const level of callers.levels) for (const x of level) for (const c of x.calls) noteProps(c.guards);
    let literals = null;
    if (fn) {
      const lits = bq.literalsIn(fn.start, fn.end);
      const counts = { model: 0, ui: 0, internal: 0, uncached: 0 };
      let thisRun = 0;
      const shown = [];
      let more = 0;
      for (const [s0, e0, , h] of lits) {
        if (candHashes.has(h)) { thisRun++; continue; }
        const c = classification[h];
        if (!c) { counts.uncached++; continue; }
        counts[c.facing] = (counts[c.facing] || 0) + 1;
        if (c.facing === "model" || shown.length < 4) {
          if (shown.length < 12) shown.push({ at: s0, facing: c.id ? `model ${c.id}` : c.facing, text: code.slice(s0 + 1, Math.min(e0 - 1, s0 + 120)) });
          else more++;
        } else more++;
      }
      literals = { total: lits.length, thisRun, counts, shown, more };
    }
    const props = fn ? (bq.aliases(fn.start + 1, 1)[0] || null) : null;
    const setters = props && props.fn.start === fn.start ? props.pairs.filter(([k]) => /^(set|on)[A-Z]/.test(k)) : [];
    let wiring = null;
    if (setters.length) {
      const keys = new Set(setters.map(([k]) => k));
      const w = bq.wiring(fn.start + 1, 4);
      wiring = { total: w.total, sites: w.sites.map(x => ({ at: x.at, how: x.how, in: x.in ? { start: x.in.start, name: x.in.name } : null, props: x.props.filter(([k]) => keys.has(k)) })) };
    }
    famInfo.set(e.family, { fn, callers, literals, setters, wiring });
  }

  // Families in bundle order, so neighbouring families of one module share a
  // chunk when they fit.
  const famMap = new Map();
  for (const e of entries) {
    const f = famMap.get(e.family) || { key: e.family, head: e.famHead, order: e.famOrder, items: [] };
    f.items.push(e);
    famMap.set(e.family, f);
  }
  const families = [...famMap.values()].sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.key.localeCompare(b.key));
  // Weight = rendered size (an upper bound: snippets are deduplicated per
  // chunk); a family's own block is charged to its first candidate.
  for (const f of families) {
    const fi = famInfo.get(f.key) || {};
    const snip = snippetBook(code);
    const famMd = renderFamilyMd({ label: 'F00', key: f.key, fn: fi.fn, callers: fi.callers, literals: fi.literals, setters: fi.setters, wiring: fi.wiring, candidateCount: f.items.length }, { snip, propSets });
    f.items.forEach((e, i) => {
      e.key = 'k00';
      e.weight = renderCandidateMd(e, { snip, propSets, src: code }).length + 2 + (i === 0 ? famMd.length + 2 : 0);
    });
  }
  const agents = agentsFor(entries.length, perAgent);
  const packed = packFamilies(families, { agents });
  const width = Math.max(2, String(packed.length - 1).length);

  // Clear everything a previous build wrote: a leftover packet or verdict
  // file is well-formed, full of real hashes, and indistinguishable from this
  // run's output.
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    if (/^(chunk|verdicts|verify|verify-scope|classify-evidence)-\d+\.(json|md)$|^(chunk|verify)-\d+\.part\d+\.md$|^(manifest|verdicts-merged|existing-ids|catalogue-index)\.json$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  }
  const corpusDigest = crypto.createHash('sha256').update(fs.readFileSync(promptsJson)).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(outDir, 'existing-ids.json'), JSON.stringify(Object.keys(catalogue).sort()));
  fs.writeFileSync(path.join(outDir, 'catalogue-index.json'), JSON.stringify(catalogue));
  const tools = HERE;
  const queryCmd = `node ${path.join(tools, 'bundleQuery.mjs')} --cli ${path.resolve(opt.cli)} --catalogue ${promptsJson} --classification ${classificationPath}${opt['cache-dir'] ? ` --cache-dir ${path.resolve(opt['cache-dir'])}` : ''}`;
  const header = nn => ({
    format: 1,
    version,
    chunk: nn,
    chunkCount: packed.length,
    bundle: { path: path.resolve(opt.cli), sha256: bundleSha },
    corpus: { promptsJson, digest: corpusDigest },
    existingIdsPath: path.join(outDir, 'existing-ids.json'),
    previousJson: path.resolve(opt.prev),
    verdictsPath: path.join(outDir, `verdicts-${nn}.json`),
    verifyScopePath: path.join(outDir, `verify-scope-${nn}.json`),
    verifyPath: path.join(outDir, `verify-${nn}.json`),
    commands: {
      check: `node ${path.join(tools, 'checkClassifyVerdicts.mjs')} ${outDir} ${nn}`,
      checkVerify: `node ${path.join(tools, 'checkClassifyVerdicts.mjs')} ${outDir} ${nn} --stage verify`,
      trace: `node ${path.join(tools, 'traceEmissionRoute.mjs')} --cache ${cachePath} --offset <N>`,
      write: `node ${path.join(tools, 'writeClassifyVerdicts.mjs')} ${outDir} ${nn}`,
      writeVerify: `node ${path.join(tools, 'writeClassifyVerdicts.mjs')} ${outDir} ${nn} --stage verify`,
      query: queryCmd,
    },
  });
  const manifestChunks = [];
  const mdSizes = [];
  const partCounts = [];
  const where = new Map();
  packed.forEach((ch, i) => {
    const nn = String(i).padStart(width, '0');
    const kw = Math.max(2, String(ch.items.length).length);
    ch.items.forEach((e, j) => {
      e.key = `k${String(j + 1).padStart(kw, '0')}`;
      where.set(e.hash, { nn, key: e.key });
    });
  });
  for (const e of entries) {
    if (e.joinOf) e.joinOf.keys = e.joinOf.hashes.map(h => { const w = where.get(h); return w ? `chunk ${w.nn} ${w.key}` : h.slice(0, 12); });
  }
  packed.forEach((ch, i) => {
    const nn = String(i).padStart(width, '0');
    const snip = snippetBook(code);
    const famMd = {};
    const parts = [];
    let fi = 0;
    for (const f of ch.families) {
      fi++;
      const info = famInfo.get(f.key) || {};
      const label = `F${fi}`;
      famMd[f.key] = renderFamilyMd({ label, key: f.key, fn: info.fn, callers: info.callers, literals: info.literals, setters: info.setters, wiring: info.wiring, candidateCount: f.hashes.length, split: f.split }, { snip, propSets });
      parts.push(famMd[f.key]);
      for (const h of f.hashes) {
        const e = ch.items.find(x => x.hash === h);
        e.md = renderCandidateMd(e, { snip, propSets, src: code });
        parts.push(e.md);
      }
    }
    const h = header(nn);
    const head = renderChunkHeaderMd({
      chunk: nn, chunkCount: packed.length, version, candidates: ch.items.length, families: ch.families.length,
      jsonPath: path.join(outDir, `chunk-${nn}.json`), writeCmd: h.commands.write, queryCmd,
      bundlePath: h.bundle.path, bundleSha, promptsJson, existingIdsPath: h.existingIdsPath, previousJson: h.previousJson,
    });
    const md = [head, ...parts].join('\n\n') + '\n';
    const mdParts = writeMarkdownParts(path.join(outDir, `chunk-${nn}.md`), md, { maxBytes: partBytes });
    mdSizes.push(Buffer.byteLength(md));
    partCounts.push(mdParts.length);
    const candidates = ch.items.map(({ weight, famHead, famOrder, familyFn, inner, guards, near, modelPath, sinkEntry, calleeAliases, outboundControl, ...rest }) => rest);
    const families = ch.families.map(f => ({ ...f, md: famMd[f.key] }));
    const packet = { ...h, mdPath: path.join(outDir, `chunk-${nn}.md`), mdParts, families, candidates };
    fs.writeFileSync(path.join(outDir, `chunk-${nn}.json`), JSON.stringify(packet, null, 1));
    const bodyBytes = ch.items.reduce((a, x) => a + x.body.length, 0);
    manifestChunks.push({ chunk: nn, file: `chunk-${nn}.json`, md: `chunk-${nn}.md`, mdParts: mdParts.map(f => path.basename(f)), mdBytes: Buffer.byteLength(md), hashes: candidates.map(c => c.hash), keys: candidates.map(c => c.key), weight: ch.weight, bodyBytes, families: ch.families.length });
  });

  const routes = entries.map(e => e.route);
  const sinkKinds = {};
  for (const e of entries) {
    const kinds = new Set([...(e.route.sinks || []).map(s => s.kind), ...Object.keys(e.route.nonModel || {})]);
    for (const k of kinds) sinkKinds[k] = (sinkKinds[k] || 0) + 1;
  }
  const stats = {
    candidates: entries.length,
    located: entries.filter(e => e.siteCount).length,
    multiSite: entries.filter(e => e.siteCount > 1).length,
    siteMethods: entries.reduce((a, e) => ((a[e.siteMethod] = (a[e.siteMethod] || 0) + 1), a), {}),
    routes: {
      resolved: routes.filter(r => r.resolved).length,
      withVerdict: routes.filter(r => r.verdict).length,
      verdicts: routes.reduce((a, r) => ((a[r.verdict || 'open'] = (a[r.verdict || 'open'] || 0) + 1), a), {}),
      candidatesPerSinkKind: sinkKinds,
    },
    families: families.length,
    splitFamilies: packed.filter(c => c.families.some(f => f.split)).length,
    heaviestChunk: Math.max(...packed.map(c => c.weight)),
    mdBytes: { max: Math.max(...mdSizes), mean: Math.round(mdSizes.reduce((a, b) => a + b, 0) / mdSizes.length), min: Math.min(...mdSizes) },
    candidatesPerChunk: { min: Math.min(...packed.map(c => c.items.length)), max: Math.max(...packed.map(c => c.items.length)) },
    mdParts: { total: partCounts.reduce((a, b) => a + b, 0), max: Math.max(...partCounts) },
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  const manifest = {
    format: 1,
    version,
    createdAt: new Date().toISOString(),
    bundle: { path: path.resolve(opt.cli), sha256: bundleSha },
    corpus: { promptsJson, digest: corpusDigest },
    previousJson: path.resolve(opt.prev),
    piebaldJson: opt.piebald ? path.resolve(opt.piebald) : null,
    routeCache: cachePath,
    catalogueIndex: 'catalogue-index.json',
    packing: { candidatesPerAgent: perAgent, agents, partBytes },
    classification: classificationPath,
    chunkCount: packed.length,
    chunks: manifestChunks,
    stats,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`classify evidence ${version}: ${stats.candidates} candidate(s) in ${packed.length} chunk(s) at ${perAgent} per agent (${stats.candidatesPerChunk.min}–${stats.candidatesPerChunk.max} per chunk; ${families.length} families; chunk-NN.md ${(stats.mdBytes.min / 1000).toFixed(1)}–${(stats.mdBytes.max / 1000).toFixed(1)} KB, mean ${(stats.mdBytes.mean / 1000).toFixed(1)} KB, ${stats.mdParts.total} part file(s) of ≤${partBytes} B) -> ${outDir}`);
  if (filled) console.log(`  continuity: ${filled} candidate(s) arrived without hints and got them from the builder`);
  console.log(`  settings oracle: ${oracle ? `${oracle.length} description(s) from ${oraclePath}; ${entries.filter(e => e.settingsOracle).length} candidate(s) match` : `none at ${oraclePath} (capture it first: node tools/captureSettingsOracle.mjs)`}`);
  console.log(`  sites: located ${stats.located}/${stats.candidates} (${stats.multiSite} at several sites) ${JSON.stringify(stats.siteMethods)}`);
  console.log(`  routes: ${stats.routes.withVerdict}/${stats.candidates} with a route verdict ${JSON.stringify(stats.routes.verdicts)}; fully resolved ${stats.routes.resolved}`);
  console.log(`  workflow args: {"version":"${version}","evidenceDir":"${outDir}","chunkCount":${packed.length},"mdParts":${JSON.stringify(partCounts)},"model":…,"verifyModel":…,"classifyEffort":…,"verifyEffort":…,"repoDir":"${path.dirname(HERE)}"}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error(`buildClassifyEvidence: ${e.stack || e.message}`);
    process.exit(1);
  });
}
