import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll as after, test } from 'vitest';
import {
  clipUtf8,
  directory,
  materializeCorpus,
  nativeOracle,
  nativeRaw,
  readSuite,
  runAdapter,
  scoreQuery,
  scoreTask,
  visibleLocations,
} from './core.mjs';

const temp = mkdtempSync(join(tmpdir(), 'navigation-eval-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const task = {
  requiredEvidence: [
    { id: 'a', path: 'a.ts', line: 1, snippet: 'return 1;' },
    { id: 'b', path: 'b.ts', line: 2, snippet: 'return 2;' },
  ],
  expectedAnswerFacts: [{ id: 'both', evidenceIds: ['a', 'b'] }],
};
const oracle = {
  matches: [
    { path: 'a.ts', line: 1, text: 'return 1;', submatches: 1 },
    { path: 'b.ts', line: 2, text: 'return 2;', submatches: 1 },
  ],
  totalFiles: 2,
  totalMatches: 2,
  totalMatchedLines: 2,
};

test('the frozen public and synthetic evidence validates against the pinned commit', () => {
  const suite = readSuite();
  assert.equal(suite.manifest.tasks.length, 10);
  assert.equal(suite.tasks.length, 15);
  for (const item of suite.manifest.tasks) {
    assert.ok(
      new Set(item.requiredEvidence.map(evidence => evidence.path)).size >= 2
    );
  }
  const corpus = materializeCorpus(resolve(directory, '../..'), suite);
  rmSync(corpus, { recursive: true, force: true });
});

test('UTF-8 budgets count bytes and never leave a partial Unicode scalar', () => {
  const text = 'a€🦀z';
  for (let budget = 0; budget <= Buffer.byteLength(text) + 2; budget++) {
    const bounded = clipUtf8(text, budget);
    assert.ok(Buffer.byteLength(bounded) <= budget);
    assert.ok(text.startsWith(bounded));
    assert.ok(!bounded.includes('\uFFFD'));
  }
  assert.throws(() => clipUtf8('x', -1));
});

test('an omitted required file cannot be scored as a successful investigation', () => {
  const query = scoreQuery(
    { output: 'a.ts:1:return 1;\n', exitCode: 0 },
    oracle,
    2048
  );
  const score = scoreTask(task, [query]);
  assert.equal(score.allEvidenceVisible, false);
  assert.deepEqual(score.missingRequiredFiles, ['b.ts']);
  assert.deepEqual(score.missingRequiredEvidence, ['b']);
  assert.deepEqual(score.fullySupportedFacts, []);
});

test('only bytes inside the common visible budget receive credit', () => {
  const first = 'a.ts:1:return 1;\n';
  const query = scoreQuery(
    { output: first + 'b.ts:2:return 2;\n', exitCode: 0 },
    oracle,
    Buffer.byteLength(first)
  );
  assert.equal(query.budgetClipped, true);
  assert.deepEqual(scoreTask(task, [query]).missingRequiredEvidence, ['b']);
});

test('filenames without source excerpts do not count as evidence', () => {
  const query = scoreQuery(
    { output: 'a.ts\nb.ts\n', exitCode: 0 },
    oracle,
    2048
  );
  const score = scoreTask(task, [query]);
  assert.equal(score.visibleRequiredFiles.length, 2);
  assert.equal(score.visibleRequiredEvidence.length, 0);
});

test('the right snippet at the wrong path or line earns no evidence credit', () => {
  const query = scoreQuery(
    { output: 'c.ts:1:return 1;\nb.ts:3:return 2;\n', exitCode: 0 },
    oracle,
    2048
  );
  assert.equal(scoreTask(task, [query]).visibleRequiredEvidence.length, 0);
});

test('failed searches receive no coverage credit even when stdout contains evidence', () => {
  for (const result of [
    { exitCode: 2 },
    { exitCode: 0, error: 'timed out' },
    { exitCode: 1 },
  ]) {
    const query = scoreQuery(
      { output: 'a.ts:1:return 1;\nb.ts:2:return 2;\n', ...result },
      oracle,
      2048
    );
    const score = scoreTask(task, [query]);
    assert.equal(score.visibleRequiredEvidence.length, 0);
    assert.equal(score.failedQueries, 1);
    assert.equal(score.allEvidenceVisible, false);
  }
});

test('honesty checks reject false completeness, totals, and nonadvancing continuation', () => {
  const query = scoreQuery(
    {
      output: 'a.ts:1:return 1;\n',
      exitCode: 0,
      totalFiles: 1,
      totalMatches: 1,
      complete: true,
      nextOffset: 0,
    },
    oracle,
    2048
  );
  assert.ok(
    query.honestyViolations.some(item => item.startsWith('totalFiles:'))
  );
  assert.ok(
    query.honestyViolations.some(item => item.startsWith('totalMatches:'))
  );
  assert.ok(
    query.honestyViolations.some(item => item.startsWith('complete=true'))
  );
  assert.ok(
    query.honestyViolations.includes('Continuation offset does not advance')
  );
});

test('an honest incomplete result remains incomplete rather than becoming a task success', () => {
  const query = scoreQuery(
    {
      output: 'a.ts:1:return 1;\n',
      exitCode: 0,
      totalFiles: 2,
      totalMatches: 2,
      complete: false,
      nextOffset: 1,
    },
    oracle,
    2048
  );
  assert.deepEqual(query.honestyViolations, []);
  assert.equal(query.visibleComplete, false);
  assert.equal(scoreTask(task, [query]).allEvidenceVisible, false);
});

test('a zero-match native exit is valid while required source evidence remains missing', () => {
  const query = scoreQuery(
    { output: '', exitCode: 1 },
    {
      matches: [],
      totalFiles: 0,
      totalMatches: 0,
      totalMatchedLines: 0,
    },
    2048
  );
  assert.equal(query.valid, true);
  assert.equal(query.visibleComplete, true);
  assert.equal(scoreTask(task, [query]).allEvidenceVisible, false);
});

test('native oracle distinguishes submatches from matched lines and sorts raw paths', () => {
  writeFileSync(join(temp, 'b.ts'), 'token token\n');
  writeFileSync(join(temp, 'a.ts'), 'token\n');
  const query = { pattern: 'token', path: '.', context: 0 };
  const truth = nativeOracle(temp, query);
  assert.equal(truth.totalMatches, 3);
  assert.equal(truth.totalMatchedLines, 2);
  assert.equal(truth.totalFiles, 2);
  const raw = nativeRaw(temp, query);
  assert.equal(raw.exitCode, 0);
  assert.ok(raw.output.indexOf('a.ts') < raw.output.indexOf('b.ts'));
});

test('native execution refuses a search scope outside the frozen corpus', () => {
  assert.throws(
    () => nativeOracle(temp, { pattern: 'x', path: '..' }),
    /escapes corpus/
  );
});

test('adapters receive identical query and byte budget as structured stdin', () => {
  const adapter = {
    command: [
      process.execPath,
      '-e',
      "let b=''; process.stdin.on('data',c=>b+=c); process.stdin.on('end',()=>{const r=JSON.parse(b); process.stdout.write(JSON.stringify({output:JSON.stringify(r),exitCode:0}));});",
    ],
  };
  const query = { pattern: 'token', path: '.', context: 0 };
  const result = runAdapter(adapter, temp, query, 2048);
  assert.equal(result.exitCode, 0);
  const input = JSON.parse(result.output);
  assert.deepEqual(input.query, query);
  assert.equal(input.byteBudget, 2048);
  assert.equal(input.corpusDir, temp);
});

test('adapter failures and malformed responses are explicit failures', () => {
  for (const source of ['process.exit(2)', 'console.log("not JSON")']) {
    const result = runAdapter(
      { command: [process.execPath, '-e', source] },
      temp,
      {},
      2048
    );
    assert.ok(result.error);
    assert.equal(result.output, '');
  }
});

test('absolute native paths, spaces, and Unicode filenames retain source locations', () => {
  writeFileSync(join(temp, 'münchen quota.ts'), 'const $cap = "€";\n');
  const result = visibleLocations(
    `${temp}/münchen quota.ts:12:const $cap = "€";\n`,
    temp
  );
  assert.deepEqual(result.entries, [
    { path: 'münchen quota.ts', line: 12, text: 'const $cap = "€";' },
  ]);
});

test('verified file paths keep numeric separators inside source text intact', () => {
  const text = "const msg = 'x:123:y-456-z';";
  writeFileSync(join(temp, 'numeric-content.ts'), text + '\n');
  for (const separator of [':', '-']) {
    const result = visibleLocations(
      `numeric-content.ts${separator}12${separator}${text}\n`,
      temp
    );
    assert.deepEqual(result.entries, [
      { path: 'numeric-content.ts', line: 12, text },
    ]);
  }
});

test('verified filenames can contain numeric colon or dash sequences', () => {
  for (const separator of [':', '-']) {
    const path = `name${separator}123${separator}entry.ts`;
    writeFileSync(join(temp, path), 'value\n');
    const result = visibleLocations(`${path}:7:x:456:y\n`, temp);
    assert.deepEqual(result.entries, [{ path, line: 7, text: 'x:456:y' }]);
  }
});

test('two existing filename interpretations are rejected as ambiguous', () => {
  for (const separator of [':', '-']) {
    writeFileSync(join(temp, `ambiguous${separator}name`), 'first\n');
    writeFileSync(
      join(temp, `ambiguous${separator}name${separator}12${separator}tail`),
      'second\n'
    );
    const result = visibleLocations(
      `ambiguous${separator}name${separator}12${separator}tail${separator}34${separator}value\n`,
      temp
    );
    assert.deepEqual(result, { entries: [], files: [] });
  }
});

test('a standalone filename that is also a valid source location is ambiguous', () => {
  writeFileSync(join(temp, 'dual.ts'), 'text\n');
  writeFileSync(join(temp, 'dual.ts:12:text'), 'other\n');
  const result = visibleLocations('dual.ts:12:text\n', temp);
  assert.deepEqual(result, { entries: [], files: [] });
});

test('overlapping numeric delimiters do not hide an ambiguous interpretation', () => {
  writeFileSync(join(temp, 'overlap'), 'first\n');
  writeFileSync(join(temp, 'overlap:12'), 'second\n');
  const result = visibleLocations('overlap:12:34:text\n', temp);
  assert.deepEqual(result, { entries: [], files: [] });
});

test('without a corpus, only unambiguous source locations receive credit', () => {
  assert.deepEqual(visibleLocations("foo.ts:12:const msg = 'x:123:y';\n"), {
    entries: [],
    files: [],
  });
  assert.deepEqual(visibleLocations('name:123:entry.ts:7:value\n'), {
    entries: [],
    files: [],
  });
  assert.deepEqual(visibleLocations('foo.ts:12:value\n'), {
    entries: [{ path: 'foo.ts', line: 12, text: 'value' }],
    files: ['foo.ts'],
  });
});
