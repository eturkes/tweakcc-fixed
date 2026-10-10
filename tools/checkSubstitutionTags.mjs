#!/usr/bin/env node
// Guard for the class in skrabe/lobotomized-claude-code#2: an override that drops a
// placeholder CC substitutes into at runtime.
//
// CC injects generated content into some prompts with a plain string `.replace("<tag>", …)`.
// String replace is a SILENT NO-OP when the tag is absent, so an override that trims or
// suppresses the tag compiles clean, applies clean, boots clean, and simply never receives
// the injected content. Issue #2 was the empty-body form (the auto-mode classifier lost its
// whole prompt); the 2.1.221 audit hit the subtler form — a rewrite that kept 6.7KB of prose
// but deleted the two injection sites inside it.
//
// Rule: if a prompt's pristine text carries a substitution tag, every override of that prompt
// must carry it too. Tags are discovered from the binary, not hardcoded, so a new one added by
// Anthropic is covered the run it appears.
//
// Usage: node tools/checkSubstitutionTags.mjs [--cli <cli.js>] [--json <prompts.json>]
//                                             [--overrides <dir>]... [--require-sets]
//
// With no --overrides, audits the system-prompts folder `--apply` actually reads.
// --overrides may be repeated to audit specific folders instead, for a setup that
// keeps several side by side.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseOverrideArgs,
  resolveOverrideSets,
  printAuditedSets,
  pristineCliPath,
} = require('./lib/overrideSets.cjs');

const parsed = parseOverrideArgs(process.argv.slice(2));
const sets = resolveOverrideSets(parsed, { fallback: 'applied' });
printAuditedSets(sets);

const arg = (n, d) => {
  const i = parsed.rest.indexOf(n);
  return i === -1 ? d : parsed.rest[i + 1];
};
const CLI = arg('--cli', pristineCliPath());
const REPO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..'
);

const promptsJson =
  arg('--json') ??
  fs
    .readdirSync(path.join(REPO, 'data/prompts'))
    .filter(f => /^prompts-\d+\.\d+\.\d+\.json$/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
const jsonPath = path.isAbsolute(promptsJson)
  ? promptsJson
  : path.join(REPO, 'data/prompts', promptsJson);

// The stale-backup rule deletes native-claudejs-orig.js before the bump's first
// apply, so the default CLI does not exist for the first half of every run. Fall
// back to the extraction the pipeline makes at that point, version-checked so a
// leftover file from another release cannot stand in.
const jsonVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8')).version;
  } catch {
    return null;
  }
})();
const cliPath = (() => {
  if (fs.existsSync(CLI)) return CLI;
  if (!jsonVersion) return CLI;
  const tmp = path.join(process.env.SHOWTIME_TMP || '/tmp', `cli-${jsonVersion}.js`);
  if (fs.existsSync(tmp)) {
    console.error(`substitution-tags: ${CLI} absent — using ${tmp}`);
    return tmp;
  }
  return CLI;
})();

for (const p of [cliPath, jsonPath]) {
  if (!fs.existsSync(p)) {
    console.error(`substitution-tags: missing ${p}`);
    process.exit(2);
  }
}

// Only the STRING-literal form is an injection site:
//   .replace("<permissions_template>", () => Aqo(Dqo))
// It is the dangerous idiom precisely because String.prototype.replace with a string
// pattern no-ops silently when the tag is absent.
//
// The regex form is deliberately NOT collected — every instance of it in the bundle parses
// or strips MODEL OUTPUT, not prompt text: <analysis>/<summary> extract the compaction
// result, <thinking> strips classifier reasoning, <sandbox_violations> strips display text.
// Those are output contracts owned by whichever prompt defines the schema, so an override
// that defers to that owner legitimately has no tag of its own. Collecting them produced 16
// false positives — 12 delegation-example prompts nothing parses, plus 4 pointer prompts
// deferring to agent-prompt-conversation-summary-analysis-summary-blocks, which does keep
// <summary>. If Anthropic ever adds a regex-form site that injects INTO a prompt, add it
// here explicitly rather than widening the pattern.
const cli = fs.readFileSync(cliPath, 'utf8');
const tags = new Set();
for (const m of cli.matchAll(/\.replace\(\s*"(<[a-z0-9_]{3,60}>)"/g))
  tags.add(m[1]);

const { prompts } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const setDirs = sets.map(s => s.dir);

const body = file => {
  const t = fs.readFileSync(file, 'utf8');
  const k = t.indexOf('-->');
  return (k === -1 ? t : t.slice(k + 3)).trim();
};

let checked = 0;
const failures = [];
for (const p of prompts) {
  const pristine = (p.pieces ?? []).filter(x => typeof x === 'string').join('');
  const need = [...tags].filter(t => pristine.includes(t));
  if (need.length === 0) continue;
  for (const setDir of setDirs) {
    const set = path.basename(setDir);
    const file = path.join(setDir, `${p.id}.md`);
    if (!fs.existsSync(file)) continue; // no override: pristine passes through, fine
    checked += 1;
    const b = body(file);
    if (b === '') {
      failures.push({
        set,
        id: p.id,
        why: `suppressed, but pristine carries ${need.join(' ')}`,
      });
      continue;
    }
    const missing = need.filter(t => !b.includes(t));
    if (missing.length)
      failures.push({ set, id: p.id, why: `drops ${missing.join(' ')}` });
  }
}

const label = 'substitution tags';
if (failures.length === 0) {
  console.log(
    `✓ ${label}: ${checked} override(s) across ${setDirs.length} set(s) keep every runtime injection site (${tags.size} tag(s) tracked)`
  );
  process.exit(0);
}
console.error(
  `✗ ${label}: ${failures.length} override(s) drop a site CC substitutes into`
);
for (const f of failures) console.error(`    ${f.set}/${f.id} — ${f.why}`);
console.error(
  '  A string .replace() finds nothing and silently injects nothing; the prompt still applies and boots.'
);
console.error('  See skrabe/lobotomized-claude-code#2.');
process.exit(1);
