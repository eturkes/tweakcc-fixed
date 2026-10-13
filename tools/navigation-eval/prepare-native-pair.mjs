import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { directory, sha256 } from './core.mjs';
import {
  extractNative,
  nativeVersion,
  verifyFormatterOnlyPair,
} from './native-extraction.mjs';
import { ripgrepIdentity } from './native-handler.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    !['--pristine', '--candidate', '--out', '--ripgrep'].includes(name) ||
    !value
  ) {
    throw new Error(`Unknown or incomplete option: ${name}`);
  }
  options[name.slice(2)] = value;
}
if (!options.pristine || !options.candidate || !options.out) {
  throw new Error('Use --pristine SOURCE --candidate SOURCE --out DIRECTORY');
}

const before = extractNative(resolve(options.pristine));
const after = extractNative(resolve(options.candidate));
verifyFormatterOnlyPair(before, after);
const ripgrep = ripgrepIdentity(options.ripgrep);
const outputDir = resolve(options.out);
const cacheDir = join(outputDir, 'shared-ripgrep-captures');
mkdirSync(outputDir, { recursive: true });
const adapterFiles = [
  'core.mjs',
  'fixtures.mjs',
  'native-adapter.mjs',
  'native-extraction.mjs',
  'native-handler.mjs',
];
const adapterSha256 = Object.fromEntries(
  adapterFiles.map(name => [name, sha256(readFileSync(join(directory, name)))])
);
const configs = [];
for (const [name, condition, extracted] of [
  ['native-grep-before', 'pristine', before],
  ['native-grep-after', 'formatter-only', after],
]) {
  const config = {
    name,
    command: [
      process.execPath,
      join(directory, 'native-adapter.mjs'),
      '--source',
      extracted.sourcePath,
      '--source-sha256',
      extracted.sourceSha256,
      '--cache',
      cacheDir,
      '--ripgrep',
      ripgrep.path,
      '--ripgrep-sha256',
      ripgrep.sha256,
    ],
    metadata: {
      condition,
      claudeVersion: nativeVersion,
      module: '415:/$bunfs/root/chunk-sfn1dbxq.js',
      sourceSha256: extracted.sourceSha256,
      moduleSha256: extracted.moduleSha256,
      handlerSha256: extracted.handlerSha256,
      componentSha256: extracted.componentSha256,
      adapterSha256,
      adapterCombinedSha256: sha256(JSON.stringify(adapterSha256)),
      node: process.version,
      ripgrep,
      sharedCache: {
        directory: cacheDir,
        identityFields: ['args', 'cwd', 'target', 'ripgrepSha256'],
        ordering:
          'The first native ripgrep capture is reused unchanged by both conditions.',
        injectedSort: false,
      },
      byteBudget:
        'The frozen evaluator clips actual mapper output; the native handler receives its ordinary line limit.',
    },
  };
  const path = join(outputDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  configs.push(path);
}
console.log(
  JSON.stringify({ configs, cacheDir, onlyActualFooChanged: true }, null, 2)
);
