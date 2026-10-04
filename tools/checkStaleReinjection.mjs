#!/usr/bin/env node
// An override that is LONGER than pristine is normal here — LCC adds steering on
// purpose. What is not normal is an override re-injecting a sentence Anthropic
// DELETED: that text reached the model in an older release, Anthropic removed it,
// and our stale copy puts it back. Nothing else sees this. The conflict detector
// compares versions, so an override whose ccVersion was bumped without the body
// being realigned reports clean forever.
//
//   node tools/checkStaleReinjection.mjs <version> [--set=<dir>…]
//
// A finding is: a sentence in the deployed body that appears in NO current-version
// pristine for that id, but DOES appear in some earlier release's pristine.
// Deliberate retentions live in data/stale-reinjection-allowlist.json, keyed by
// "<id>::<sha1 of the sentence>" with a reason — because keeping a sentence
// Anthropic dropped is often exactly the point of this project.
// The committed baseline is keyed to the maintainer's overrides; for other users
// NEW findings are still real defects in their overrides.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
// Windows are scoped to markdown blocks; see tools/lib/markdownBlocks.mjs for why.
import { blocksOf } from './lib/markdownBlocks.mjs';
import { isAdjacencyRun } from './lib/adjacency.mjs';
const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  remindersDirsFor,
  printAuditedSets,
} = require('./lib/overrideSets.cjs');

const parsed = parseOverrideArgs(process.argv.slice(2));
const sets = resolveOverrideSets(parsed, { fallback: 'applied' });
const version = parsed.rest[0] || '';
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: checkStaleReinjection.mjs <version> [--set=<dir>…]');
  process.exit(2);
}
printAuditedSets(sets);
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const ALLOW = path.join(REPO, 'data/stale-reinjection-allowlist.json');
const allow = fs.existsSync(ALLOW) ? JSON.parse(fs.readFileSync(ALLOW, 'utf8')) : {};
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// Reconstruct a prompt body. TWO invariants, both easy to get wrong and both
// wrong in the first cut of this file:
//   1. `pieces` ALREADY carry the `${` and `}` delimiters ("owned by you${",
//      "}; includes …"), so the label is inserted BARE. Wrapping it again emits
//      `${${LABEL}}`, which matches nothing and makes an exact pristine stub
//      look like a curated body.
//   2. The identifierMap key is `identifiers[i]`, NOT `i`. They coincide often
//      enough to hide the bug.
// This mirrors reconstructContentFromPieces in src/systemPromptSync.ts.
const reconstruct = p => {
  const pieces = p.pieces || [];
  if (!pieces.length) return p.content || '';
  const ids = p.identifiers || [];
  const map = p.identifierMap || {};
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    out += pieces[i];
    if (i < ids.length) out += map[String(ids[i])] || `UNKNOWN_${ids[i]}`;
  }
  return out;
};

const vkey = f => (f.match(/prompts-(\d+)\.(\d+)\.(\d+)\.json/) || []).slice(1).map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const files = fs.readdirSync(path.join(REPO, 'data/prompts'))
  .filter(f => /^prompts-\d+\.\d+\.\d+\.json$/.test(f))
  .sort((a, b) => cmp(vkey(a), vkey(b)));

// id -> { current: Set<body>, past: Map<body, lastVersionSeen> }
const cur = new Map(), past = new Map();
for (const f of files) {
  const v = f.replace(/^prompts-|\.json$/g, '');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(REPO, 'data/prompts', f), 'utf8')); } catch { continue; }
  for (const p of doc.prompts || []) {
    if (!p.id) continue;
    const b = reconstruct(p);
    if (v === version) { if (!cur.has(p.id)) cur.set(p.id, new Set()); cur.get(p.id).add(b); }
    if (!past.has(p.id)) past.set(p.id, new Map());
    past.get(p.id).set(b, v);
  }
}

// Word-shingle granularity, NOT sentences. Override bodies hard-wrap prose
// mid-sentence and are dense with backticks and list markers, so every attempt to
// reconstitute "a sentence" failed on the one case this gate exists to catch: the
// whiteboard `--title` paragraph never re-formed as a unit, and its fragments
// matched nothing. A sliding window over the token stream is immune to wrapping,
// indentation and punctuation, which is the same reason the continuity matcher in
// the driver uses shingles rather than lines.
const W = 10;
const tokens = t =>
  t.toLowerCase().replace(/[^a-z0-9$_]+/g, ' ').split(' ').filter(Boolean);
// A window is worth reporting only if it reads as instruction rather than code.
const CODEY = new Set(['const','let','var','function','return','await','typeof','null','true','false','map','push','json','stringify']);
// `pos` is the window's absolute stream position (blocks are spaced apart) so a
// run can be rebuilt from real neighbours even where filtered windows left gaps.
const windows = t => {
  const out = [];
  let base = 0;
  for (const block of blocksOf(t)) {
    const tk = tokens(block);
    const off = base;
    base += tk.length + W;
    for (let i = 0; i + W <= tk.length; i++) {
      const w = tk.slice(i, i + W);
      if (w.filter(x => CODEY.has(x)).length > 1) continue;
      if (w.filter(x => x.length > 2).length < 7) continue;
      out.push({ s: w.join(' '), pos: off + i });
    }
  }
  return out;
};

const split = file => {
  const raw = fs.readFileSync(file, 'utf8');
  const m = /^<!--\n([\s\S]*?)\n-->\n?/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
};

// A backtick-hosted override PRE-DOUBLES its backslashes (systemPrompts.ts only
// doubles for the quote delimiters), so its stored body reads \` where pristine
// reads ` — and a raw string compare between the two never matches. That alone
// hid the one finding this gate was built for. Normalise both sides.
// An EMPTY interpolation carries no prose but shifts every window that spans it,
// so a body reproducing the sentence verbatim minus the inert slot reads as a
// re-injection. CC 2.1.234's `runs: int (default 3)${""}` is exactly that. Drop
// them before tokenizing, on both sides.
const norm = s =>
  s
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\')
    .replace(/\$\{\s*(?:""|'')\s*\}/g, '')
    .replace(/[ \t]+/g, ' ');

// Index every historical body's shingles ONCE per id. Scanning each window
// against each past body with .includes() is quadratic and hangs on a 3,500-file
// corpus with 60 releases of history.
const pastIdx = new Map();
for (const [id, bodies] of past) {
  const m = new Map();
  for (const [b, v] of bodies) for (const w of windows(norm(b))) m.set(w.s, v);
  pastIdx.set(id, m);
}

// A shadowed id is never iterated by applySystemPrompts — the reminder registry
// or another override already spliced that cli.js region — so its `.md` cannot
// re-inject anything and flagging it is a false positive. Most shadows are
// declared in the SHARED `system-reminders` folder's front-matter, not in the
// per-model prompt sets, so both sources are scanned.
const shadowed = new Set();
try {
  const src = fs.readFileSync(
    path.join(REPO, 'src/patches/systemReminderOverrides.ts'),
    'utf8'
  );
  for (const m of src.matchAll(/shadows:\s*\[([^\]]*)\]/g))
    for (const q of m[1].matchAll(/'([^']+)'/g)) shadowed.add(q[1]);
} catch {
  /* patcher source not present; fall through */
}
for (const dir of [...sets.map(s => s.dir), ...remindersDirsFor(sets)]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const head = fs.readFileSync(path.join(dir, f), 'utf8').split('-->')[0];
    const m = head.match(/^shadows:\s*\n((?:\s*-\s*\S+\n)+)/m);
    if (m) for (const q of m[1].matchAll(/-\s*(\S+)/g)) shadowed.add(q[1]);
  }
}

let findings = 0, allowed = 0;
const rows = [];
const curTokById = new Map();
for (const set of sets) {
  const label = set.name.replace('system-prompts-', '');
  for (const f of fs.readdirSync(set.dir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (!cur.has(id) || !past.has(id) || shadowed.has(id)) continue;
    const body = norm(split(path.join(set.dir, f)).trim());
    if (!body) continue;
    const currentText = norm([...cur.get(id)].join('\n'));
    const curTok = tokens(currentText).join(' ');
    curTokById.set(`${label}::${id}`, curTok);
    if (currentText.includes(body)) continue;   // pristine stub
    const seen = new Set();
    let i = -1;
    for (const { s, pos } of windows(body)) {
      i++;
      if (seen.has(s)) continue;
      if (curTok.includes(s)) continue;         // still in current pristine
      seen.add(s);
      let lastSeen = pastIdx.get(id)?.get(s) ?? null;
      if (!lastSeen || lastSeen === version) continue;
      const key = `${id}::${sha1(s)}`;
      rows.push({ label, id, lastSeen, key, s, i, pos, allowed: Boolean(allow[key]) });
    }
  }
}

// Ratchet, not a wall — the same three-tier shape as audit-backlog and
// detection-coverage. There are ~35 standing retentions, most of them deliberate
// (the whole point of this project is keeping text Anthropic dropped). Demanding
// zero on day one produces a gate everyone waves through, which is how the
// whiteboard title convention survived three releases. So: anything NEW since the
// baseline blocks, the standing count is printed and must not grow, and shrinking
// it is a campaign.
const BASE = path.join(REPO, 'data/stale-reinjection-baseline.json');
// One stale paragraph yields ~30 overlapping windows. Collapse consecutive
// windows of the same id into a single run so the reported count is the number of
// re-injected PASSAGES, which is what a human can act on.
const runs = [];
for (const r of rows.sort((a, b) => a.id.localeCompare(b.id) || a.label.localeCompare(b.label) || a.i - b.i)) {
  const last = runs[runs.length - 1];
  if (last && last.id === r.id && last.label === r.label && r.i - last.iEnd <= 1) {
    last.iEnd = r.i;
    const gap = Math.min(r.pos - last.pos, W);
    last.s += ' ' + r.s.split(' ').slice(-gap).join(' ');
    last.pos = r.pos;
    last.allowed ||= r.allowed;
  } else runs.push({ ...r, iEnd: r.i });
}
// The allowlist silences a whole run, not one window. Applied per window before
// collapsing, an allowlisted first window only promoted the next overlapping
// window to be the run's key, so a reviewed passage re-reported under a fresh
// key on every run (CC 2.1.285: three keys for one deliberate cut).
// A run whose two halves both live in current pristine is a cut, not a
// re-injection; it never counts and never enters the baseline.
const adjacency = [];
for (let k = runs.length - 1; k >= 0; k--) {
  const r = runs[k];
  if (isAdjacencyRun(r.s, curTokById.get(`${r.label}::${r.id}`) || '')) {
    adjacency.unshift(r);
    runs.splice(k, 1);
  }
}
for (let k = runs.length - 1; k >= 0; k--) {
  if (runs[k].allowed) { allowed++; runs.splice(k, 1); }
}
findings = runs.length;
const keys = [...new Set(runs.map(r => r.key))].sort();
if (adjacency.length) {
  console.log('adjacency (both halves live in current pristine — a cut, not a re-injection):');
  for (const r of adjacency) console.log(`  ${r.label.padEnd(9)} ${r.id}  ${r.key}`);
}
const adjNote = adjacency.length ? `; ${adjacency.length} adjacency` : '';
if (!fs.existsSync(BASE)) {
  fs.writeFileSync(BASE, JSON.stringify(keys, null, 1));
  console.log(`stale re-injection: baseline recorded — ${keys.length} standing retention(s), 0 new`);
  process.exit(0);
}
const baseline = new Set(JSON.parse(fs.readFileSync(BASE, 'utf8')));
const fresh = runs.filter(r => !baseline.has(r.key));
const freshKeys = new Set(fresh.map(r => r.key));

for (const r of fresh) {
  console.log(`${r.label.padEnd(9)} ${r.id}`);
  console.log(`    Anthropic last shipped this at ${r.lastSeen}; the override still injects it`);
  console.log(`    ${JSON.stringify(r.s.slice(0, 160))}`);
  console.log(`    allowlist key: ${r.key}`);
}
if (keys.length > baseline.size) {
  console.log(`stale re-injection: standing set GREW ${baseline.size} -> ${keys.length}`);
  process.exit(1);
}
if (freshKeys.size) {
  console.log(`stale re-injection: ${freshKeys.size} NEW sentence(s) Anthropic deleted that overrides put back`);
  console.log('Realign the override, or record the retention in data/stale-reinjection-allowlist.json with a reason.');
  process.exit(1);
}
console.log(`stale re-injection: 0 new (standing ${keys.length}, was ${baseline.size}; ${allowed} allowlisted)${adjNote}`);
process.exit(0);
