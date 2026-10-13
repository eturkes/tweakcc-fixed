import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { directory, materializeCorpus, readSuite } from './core.mjs';
import {
  extractNative,
  verifyFormatterOnlyPair,
} from './native-extraction.mjs';
import { executeNative, ripgrepIdentity } from './native-handler.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--before', '--after', '--out'].includes(key) || !value)
    throw new Error(`Invalid option: ${key}`);
  options[key.slice(2)] = value;
}
if (!options.before || !options.after || !options.out)
  throw new Error(
    '--before CONFIG --after CONFIG --out DIRECTORY are required'
  );

const configs = [options.before, options.after].map(path =>
  JSON.parse(readFileSync(path))
);
const argument = (config, flag) =>
  config.command[config.command.indexOf(flag) + 1];
const sources = configs.map(config =>
  extractNative(
    argument(config, '--source'),
    argument(config, '--source-sha256')
  )
);
verifyFormatterOnlyPair(...sources);
const cacheDir = argument(configs[0], '--cache');
assert.equal(argument(configs[1], '--cache'), cacheDir);
const ripgrep = ripgrepIdentity(argument(configs[0], '--ripgrep'));
for (const config of configs)
  assert.equal(argument(config, '--ripgrep-sha256'), ripgrep.sha256);
const outputDir = resolve(options.out);
mkdirSync(outputDir, { recursive: true });
const suite = readSuite();
const corpusDir = materializeCorpus(resolve(directory, '../..'), suite);
const contractsDir = mkdtempSync(
  join(tmpdir(), 'navigation-eval-native-contracts-')
);
const checks = [];

const lines = result =>
  result.data.content ? result.data.content.split('\n') : [];
const textField = field =>
  field.text ?? Buffer.from(field.bytes, 'base64').toString('utf8');

function independentSourceRows(capture) {
  return capture.stdout
    .split('\n')
    .filter(Boolean)
    .map(row => JSON.parse(row))
    .filter(event => event.type === 'match')
    .flatMap(({ data }) => {
      const path = relative(capture.identity.cwd, textField(data.path));
      const text = textField(data.lines).replace(/\r?\n$/, '');
      return text
        .split('\n')
        .map(
          (row, index) =>
            `${path}:${data.line_number + index}:${row.length > 500 ? '[Omitted long matching line]' : row}`
        );
    });
}

async function validateContent(
  id,
  root,
  query,
  { independent = false, unchanged = false } = {}
) {
  const settings = { cacheDir, ripgrep };
  const all = [];
  for (const source of sources) {
    all.push(
      await executeNative(
        source,
        {
          corpusDir: root,
          query: { ...query, output_mode: 'content', head_limit: 0 },
          offset: 0,
        },
        settings
      )
    );
  }
  assert.equal(
    all[0].captures[0].key,
    all[1].captures[0].key,
    `${id}: raw capture key`
  );
  assert.equal(
    all[0].captures[0].sha256,
    all[1].captures[0].sha256,
    `${id}: raw bytes`
  );
  assert.equal(
    all[1].captures[0].cacheHit,
    true,
    `${id}: after must reuse before's capture`
  );
  assert.deepEqual(
    [...lines(all[0])].sort(),
    [...lines(all[1])].sort(),
    `${id}: complete match multiset`
  );
  if (unchanged)
    assert.equal(all[0].output, all[1].output, `${id}: guarded shape changed`);
  if (independent) {
    const expected = independentSourceRows(all[0].captures[0]).sort();
    for (const result of all)
      assert.deepEqual(
        [...lines(result)].sort(),
        expected,
        `${id}: native rg source records`
      );
  }
  const pageCounts = [];
  for (let condition = 0; condition < sources.length; condition++) {
    const expected = lines(all[condition]);
    const seen = [];
    const limit = 17;
    let pages = 0;
    for (
      let offset = 0;
      offset < Math.max(1, expected.length);
      offset += limit
    ) {
      const page = await executeNative(
        sources[condition],
        {
          corpusDir: root,
          query: { ...query, output_mode: 'content', head_limit: limit },
          offset,
        },
        settings
      );
      const pageLines = lines(page);
      assert.deepEqual(
        pageLines,
        expected.slice(offset, offset + limit),
        `${id}: pagination sequence`
      );
      assert.equal(page.data.totalLines, expected.length, `${id}: totalLines`);
      assert.equal(page.data.numLines, pageLines.length, `${id}: numLines`);
      assert.equal(
        page.data.appliedLimit,
        expected.length - offset > limit ? limit : undefined
      );
      assert.equal(page.data.appliedOffset, offset || undefined);
      if (page.data.appliedLimit !== undefined || offset > 0) {
        assert.match(page.output, /\[Showing results with pagination = /);
      }
      seen.push(...pageLines);
      pages++;
    }
    assert.deepEqual(seen, expected, `${id}: full traversal`);
    const tail = await executeNative(
      sources[condition],
      {
        corpusDir: root,
        query: { ...query, output_mode: 'content', head_limit: 0 },
        offset: 3,
      },
      settings
    );
    assert.deepEqual(lines(tail), expected.slice(3), `${id}: unlimited offset`);
    const beyond = await executeNative(
      sources[condition],
      {
        corpusDir: root,
        query: { ...query, output_mode: 'content', head_limit: 17 },
        offset: expected.length + 1,
      },
      settings
    );
    assert.equal(beyond.data.numLines, 0);
    assert.match(
      beyond.output,
      expected.length ? /No entries at this offset/ : /No matches found/
    );
    const ordinary = await executeNative(
      sources[condition],
      {
        corpusDir: root,
        query: { ...query, output_mode: 'content' },
        offset: 0,
      },
      settings
    );
    assert.deepEqual(
      lines(ordinary),
      expected.slice(0, 250),
      `${id}: native default limit`
    );
    pageCounts.push(pages);
  }
  checks.push({
    id,
    sourceRows: lines(all[0]).length,
    independentSourceOracle: independent,
    unchangedGuard: unchanged,
    pages: pageCounts,
    captureKey: all[0].captures[0].key,
  });
}

try {
  for (const task of suite.tasks) {
    for (let index = 0; index < task.queries.length; index++) {
      await validateContent(
        `${task.id}/${index}`,
        corpusDir,
        task.queries[index],
        { independent: true }
      );
    }
  }
  writeFileSync(
    join(contractsDir, 'a-many.ts'),
    Array.from(
      { length: 321 },
      (_, index) => `const row${index} = 'needle';`
    ).join('\n') + '\n'
  );
  writeFileSync(
    join(contractsDir, 'z-other.ts'),
    'needle repeated repeated\nbridge\nneedle\n'
  );
  writeFileSync(join(contractsDir, 'colon:123:name.ts'), 'needle x:123:y\n');
  writeFileSync(
    join(contractsDir, 'long.ts'),
    'needle ' + 'x'.repeat(520) + '\n'
  );
  await validateContent(
    'contracts/default-and-unlimited',
    contractsDir,
    { pattern: 'needle', path: '.' },
    { independent: true }
  );
  await validateContent('contracts/context', contractsDir, {
    pattern: 'needle',
    path: '.',
    context: 1,
  });
  await validateContent(
    'contracts/only-matching',
    contractsDir,
    { pattern: 'needle|repeated', path: '.', '-o': true },
    { unchanged: true }
  );
  await validateContent(
    'contracts/multiline',
    contractsDir,
    { pattern: 'needle.*\\nbridge', path: '.', multiline: true },
    { unchanged: true }
  );
  await validateContent(
    'contracts/single-file',
    contractsDir,
    { pattern: 'needle', path: 'z-other.ts' },
    { unchanged: true }
  );
  for (const mode of ['count', 'files_with_matches']) {
    for (const head_limit of [0, 2]) {
      for (const offset of [0, 1, 10]) {
        const input = {
          corpusDir: contractsDir,
          query: {
            pattern: 'needle',
            path: '.',
            output_mode: mode,
            head_limit,
          },
          offset,
        };
        const before = await executeNative(sources[0], input, {
          cacheDir,
          ripgrep,
        });
        const after = await executeNative(sources[1], input, {
          cacheDir,
          ripgrep,
        });
        assert.deepEqual(before.data, after.data);
        assert.equal(before.output, after.output);
        checks.push({
          id: `contracts/${mode}/${head_limit}/${offset}`,
          unchanged: true,
        });
      }
    }
  }
  const report = {
    passed: true,
    corpusRevision: suite.integrity.revision,
    manifestSha256: suite.integrity.manifestSha256,
    sources: sources.map(source => ({
      sourceSha256: source.sourceSha256,
      handlerSha256: source.handlerSha256,
    })),
    ripgrep,
    checks,
  };
  writeFileSync(
    join(outputDir, 'native-contract-validation.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({ passed: true, checks: checks.length, outputDir }, null, 2)
  );
} finally {
  rmSync(corpusDir, { recursive: true, force: true });
  rmSync(contractsDir, { recursive: true, force: true });
}
