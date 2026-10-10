#!/usr/bin/env node
// Catalogue entries whose pieces pin a minified name.
//
// The extractor turns identifiers inside a slot expression into slots; any it
// leaves behind stays in a piece as one build's text. The apply's matchers
// accept any name there (src/systemPromptExpressionIdentifiers.ts), but the
// cache key, the id carryover and an override's write-back all use the literal:
// CC 2.1.296 renamed `String(O)` to `String(M)` inside a slot of
// tool-result-start-task-input-wrong-type and the id was lost.
//
// Ground truth is the bundles themselves. For each entry, every identifier the
// matchers generalize becomes a capture; the entry is matched in every bundle
// given, and a capture that reads differently from the piece is a baked name.
//
//   node tools/checkBakedIdentifiers.mjs <prompts.json> <cli.js> [<cli.js> …] [--json]
//
// Exit 0 = no entry carries a name that differs across the bundles; 1 = some
// do (listed); 2 = usage error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One self-contained module exporting the apply's own generalization and regex
// builder, so the scanner cannot drift from what the apply matches.
export const loadMatcherCore = async () => {
  const built = await esbuild.build({
    absWorkingDir: REPO,
    stdin: {
      contents: [
        "export { generalizeExpressionIdentifiers, IDENTIFIER_SENTINEL } from './src/systemPromptExpressionIdentifiers';",
        "export { buildSearchRegexFromPieces } from './src/systemPromptSync';",
      ].join('\n'),
      resolveDir: REPO,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'esnext',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  });
  const code = built.outputFiles[0].text;
  const dir = path.join(REPO, '.matcher-core');
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha1').update(code).digest('hex');
  const file = path.join(dir, `baked-${hash}.mjs`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, code);
    fs.renameSync(tmp, file);
  }
  return import(pathToFileURL(file).href);
};

const MARK = '\x01';

// The generalized identifiers of one entry: per piece, the names the matchers
// replace, and the pieces with each such name swapped for MARK.
export const bakedPositions = (core, pieces) => {
  const generalized = core.generalizeExpressionIdentifiers(pieces);
  const sentinel = core.IDENTIFIER_SENTINEL;
  const names = [];
  const marked = [];
  generalized.forEach((gen, p) => {
    const orig = pieces[p];
    const parts = gen.split(sentinel);
    const pieceNames = [];
    let cursor = 0;
    let out = '';
    parts.forEach((part, k) => {
      out += part;
      cursor += part.length;
      if (k === parts.length - 1) return;
      const name = orig.slice(cursor).match(/^[\w$]+/)[0];
      pieceNames.push(name);
      out += MARK;
      cursor += name.length;
    });
    names.push(pieceNames);
    marked.push(out);
  });
  return { names, marked };
};

// Capture-group roles in pattern order: each piece's baked names, then the
// slot that follows it.
export const scannerPattern = (core, marked, names, version, buildTime) => {
  const pattern = core
    .buildSearchRegexFromPieces(marked, version, buildTime)
    .split(MARK)
    .join('([\\w$]+)');
  const roles = [];
  names.forEach((pieceNames, p) => {
    pieceNames.forEach((name, k) => roles.push({ piece: p, k, name }));
    if (p < names.length - 1) roles.push(null);
  });
  return { pattern, roles };
};

export const scanEntry = (core, entry, bundles) => {
  const { names, marked } = bakedPositions(core, entry.pieces);
  if (!names.some(n => n.length)) return null;
  const found = {};
  const differing = new Map();
  for (const b of bundles) {
    const { pattern, roles } = scannerPattern(
      core,
      marked,
      names,
      b.version,
      b.buildTime
    );
    const re = new RegExp(pattern, 'sg');
    let count = 0;
    let m;
    while ((m = re.exec(b.content)) !== null) {
      count++;
      roles.forEach((role, i) => {
        if (!role) return;
        const got = m[i + 1];
        if (got === role.name) return;
        const key = `${role.piece}:${role.k}`;
        if (!differing.has(key)) differing.set(key, { ...role, seen: {} });
        const seen = differing.get(key).seen;
        (seen[b.label] ||= new Set()).add(got);
      });
      if (m[0].length === 0) re.lastIndex++;
    }
    found[b.label] = count;
  }
  return {
    id: entry.id || entry.name || '(anonymous)',
    names: names.flat(),
    found,
    differing: [...differing.values()].map(d => ({
      piece: d.piece,
      name: d.name,
      seen: Object.fromEntries(
        Object.entries(d.seen).map(([k, v]) => [k, [...v]])
      ),
    })),
  };
};

export const readBundle = (file, fallbackVersion) => {
  const content = fs.readFileSync(file, 'utf8');
  const version =
    (content.match(/"(\d+\.\d+\.\d+)"/) || [])[1] || fallbackVersion;
  const buildTime = (content.match(/BUILD_TIME:"([^"]+)"/) || [])[1];
  return { label: file, content, version, buildTime };
};

const main = async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const [promptsFile, ...bundleFiles] = args.filter(a => a !== '--json');
  if (!promptsFile || bundleFiles.length === 0) {
    console.error(
      'usage: checkBakedIdentifiers.mjs <prompts.json> <cli.js> [<cli.js> …] [--json]'
    );
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  const core = await loadMatcherCore();
  const bundles = bundleFiles.map(f => readBundle(f, data.version));
  const scanned = [];
  for (const entry of data.prompts) {
    const r = scanEntry(core, entry, bundles);
    if (r) scanned.push(r);
  }
  const baked = scanned.filter(r => r.differing.length);
  const missing = scanned.filter(r =>
    bundles.some(b => r.found[b.label] === 0)
  );
  if (json) {
    console.log(JSON.stringify({ scanned, baked, missing }, null, 1));
  } else {
    console.log(
      `baked-identifier scan: ${scanned.length} entr(ies) keep a name inside a slot expression; ${baked.length} differ across ${bundles.length} bundle(s)`
    );
    for (const r of baked) {
      console.log(`  ${r.id}`);
      for (const d of r.differing)
        console.log(
          `    piece ${d.piece} \`${d.name}\` -> ${Object.entries(d.seen)
            .map(
              ([b, v]) =>
                `${path.basename(path.dirname(b))}/${path.basename(b)}: ${v.join(',')}`
            )
            .join('; ')}`
        );
    }
    for (const r of missing)
      console.log(
        `  (not found in every bundle: ${r.id} ${JSON.stringify(r.found)})`
      );
  }
  process.exit(baked.length ? 1 : 0);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
