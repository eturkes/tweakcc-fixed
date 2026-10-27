#!/usr/bin/env node
// Regenerates the README coverage table from the catalogues, so its figures
// have one derivation instead of being carried forward by hand.
//
//   node tools/readmeStats.mjs X.Y.Z [--write]
//
// Prompt sites: entries in data/prompts/prompts-X.Y.Z.json (one per binary
// site). Unique prompt IDs: distinct ids among them. Patches: entries in
// PATCH_DEFINITIONS. Upstream: the same counts from upstream/main's newest
// catalogue and patch list at or below X.Y.Z (needs `git fetch upstream`).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [version] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const write = process.argv.includes('--write');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: readmeStats.mjs X.Y.Z [--write]');
  process.exit(2);
}

const git = (...args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const promptCounts = text => {
  const prompts = JSON.parse(text).prompts;
  return {
    sites: prompts.length,
    ids: new Set(prompts.map(p => p.id).filter(Boolean)).size,
  };
};
// Counts `id: '…'` entries of the PATCH_DEFINITIONS array literal.
const patchCount = source => {
  const start = source.indexOf('const PATCH_DEFINITIONS');
  const end = source.indexOf('\n]', start);
  if (start < 0 || end < 0) throw new Error('PATCH_DEFINITIONS not found');
  return (source.slice(start, end).match(/^\s+id: '/gm) || []).length;
};

const ours = {
  ...promptCounts(
    fs.readFileSync(
      path.join(ROOT, 'data/prompts', `prompts-${version}.json`),
      'utf8'
    )
  ),
  patches: patchCount(
    fs.readFileSync(path.join(ROOT, 'src/patches/index.ts'), 'utf8')
  ),
};

const upstreamVersion = git(
  'ls-tree',
  '--name-only',
  'upstream/main',
  'data/prompts/'
)
  .split('\n')
  .map(l => /prompts-(\d+\.\d+\.\d+)\.json$/.exec(l)?.[1])
  .filter(v => v && cmp(v, version) <= 0)
  .sort(cmp)
  .pop();
if (!upstreamVersion) {
  console.error(
    'no upstream catalogue at or below this version (git fetch upstream)'
  );
  process.exit(1);
}
const upstream = {
  ...promptCounts(
    git('show', `upstream/main:data/prompts/prompts-${upstreamVersion}.json`)
  ),
  patches: patchCount(git('show', 'upstream/main:src/patches/index.ts')),
};

const fmt = n => n.toLocaleString('en-US');
const cell = (s, w) => {
  const pad = w - s.length;
  return ' '.repeat(Math.floor(pad / 2)) + s + ' '.repeat(Math.ceil(pad / 2));
};
const row = (label, a, b) =>
  `| ${label.padEnd(28)} | ${cell(a, 13)} | ${cell(b, 9)} |`;
const table = [
  `|                              | tweakcc-fixed | upstream  |`,
  `| ---------------------------- | :-----------: | :-------: |`,
  row(
    `Prompt sites (CC ${version})`,
    `**${fmt(ours.sites)}**`,
    fmt(upstream.sites)
  ),
  row('Unique prompt IDs', `**${fmt(ours.ids)}**`, fmt(upstream.ids)),
  row('Patches', `**${ours.patches}**`, String(upstream.patches)),
  row('Overrides on native installs', '**yes**', 'gated off'),
].join('\n');

if (!write) {
  console.log(table);
  console.log(`(upstream catalogue: ${upstreamVersion})`);
  process.exit(0);
}
const readmePath = path.join(ROOT, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const re = /\|\s+\| tweakcc-fixed \| upstream\s+\|\n(?:\|.*\|\n)+/;
if (!re.test(readme)) {
  console.error('README coverage table not found');
  process.exit(1);
}
fs.writeFileSync(readmePath, readme.replace(re, `${table}\n`));
console.log(
  `README coverage table: CC ${version}, upstream ${upstreamVersion}`
);
