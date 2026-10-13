import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper =
  process.env.RG_FFF_TEST_BINARY ||
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'target/debug/rg-fff'
  );
assert.ok(existsSync(wrapper), `Build the Rust wrapper first: ${wrapper}`);
const temp = mkdtempSync(path.join(os.tmpdir(), 'fff-semantic-test-'));
chmodSync(temp, 0o700);
const root = path.join(temp, 'repo');
for (const directory of ['src/nested', 'src/unicode', 'src/endings'])
  mkdirSync(path.join(root, directory), { recursive: true });
for (const [name, contents] of Object.entries({
  'src/literals.txt':
    'literal *.ts here\nliteral *text* here\nliteral \\*text here\nliteral \\n here\nreference target.ts outside filename\n',
  'src/nested/references.txt': 'reference target.ts another file\nneedle\n',
  'src/target.ts': 'reference target.ts own file\n',
  'src/unicode/cases.txt': 'fooébar\nééé\n١٢٣\néneedle\nKelvin\nneedle\n',
  'src/endings/cases.txt': 'abc\n\rabc\nabc\r\nlast',
}))
  writeFileSync(path.join(root, name), contents);

const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith('RG_FFF_')) delete env[key];
delete env.RIPGREP_CONFIG_PATH;
Object.assign(env, {
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_NO_FUZZY_FALLBACK: '1',
  RG_FFF_SESSION: 'synthetic-semantics',
});
const native =
  process.env.RG_FFF_TEST_CLAUDE ||
  path.join(os.homedir(), '.local/bin/claude');
const references = [
  { name: 'system rg', executable: 'rg' },
  ...(existsSync(native)
    ? [{ name: 'embedded rg', executable: native, argv0: 'rg' }]
    : []),
];
const normalized = output => {
  assert.equal(output.length === 0 || output.at(-1) === '\n', true);
  return output.length === 0 ? [] : output.slice(0, -1).split('\n').sort();
};
const literal = (line, contents) => `src/literals.txt:${line}:${contents}`;
const unicode = (line, contents) => `src/unicode/cases.txt:${line}:${contents}`;
const ending = (line, contents) => `src/endings/cases.txt:${line}:${contents}`;
const cases = [
  {
    name: 'fixed filename-shaped needle searches other filenames',
    argv: ['-nF', 'target.ts', 'src'],
    lines: [
      literal(5, 'reference target.ts outside filename'),
      'src/nested/references.txt:1:reference target.ts another file',
      'src/target.ts:1:reference target.ts own file',
    ],
  },
  {
    name: 'fixed extension-shaped needle',
    argv: ['-nF', '*.ts', 'src'],
    lines: [literal(1, 'literal *.ts here')],
  },
  {
    name: 'fixed wildcard-shaped needle',
    argv: ['-nF', '*text*', 'src'],
    lines: [literal(2, 'literal *text* here')],
  },
  {
    name: 'fixed leading escaped star does not match unescaped star',
    argv: ['-nF', '\\*text', 'src'],
    lines: [literal(3, 'literal \\*text here')],
  },
  {
    name: 'literal backslash n stays literal',
    argv: ['-nF', '\\n', 'src'],
    lines: [literal(4, 'literal \\n here')],
  },
  {
    name: 'fixed leading CR is not trimmed from needle',
    argv: ['-nF', '\rabc', 'src/endings'],
    lines: [ending(2, '\rabc')],
  },
  {
    name: 'fixed trailing CR is not trimmed from needle or output',
    argv: ['-nF', 'abc\r', 'src/endings'],
    lines: [ending(3, 'abc\r')],
  },
  {
    name: 'actual newline in fixed pattern keeps native error',
    argv: ['-nF', 'abc\ndef', 'src'],
    lines: [],
    status: 2,
  },
  {
    name: 'default regex dot matches Unicode codepoints',
    argv: ['-n', 'foo.bar', 'src/unicode'],
    lines: [unicode(1, 'fooébar')],
  },
  {
    name: 'default repeated dot counts Unicode codepoints',
    argv: ['-n', '^...$', 'src/unicode'],
    lines: [unicode(2, 'ééé'), unicode(3, '١٢٣')],
  },
  {
    name: 'default word class includes Unicode words',
    argv: ['-n', '^\\w{3}$', 'src/unicode'],
    lines: [unicode(2, 'ééé'), unicode(3, '١٢٣')],
  },
  {
    name: 'default digit class includes Unicode digits',
    argv: ['-n', '^\\d{3}$', 'src/unicode'],
    lines: [unicode(3, '١٢٣')],
  },
  {
    name: 'default word boundaries exclude Unicode-adjacent needle',
    argv: ['-n', '\\bneedle\\b', 'src/unicode'],
    lines: [unicode(6, 'needle')],
  },
  {
    name: 'default ignore-case includes Unicode case folding',
    argv: ['-ni', 'Kelvin', 'src/unicode'],
    lines: [unicode(5, 'Kelvin')],
  },
  {
    name: 'explicit ASCII dot is not overridden',
    argv: ['-n', '(?-u:foo.bar)', 'src/unicode'],
    lines: [],
  },
  {
    name: 'explicit ASCII word class is not overridden',
    argv: ['-n', '(?-u:^\\w{3}$)', 'src/unicode'],
    lines: [],
  },
  {
    name: 'explicit ASCII boundary is not overridden',
    argv: ['-n', '(?-u:\\bneedle\\b)', 'src/unicode'],
    lines: [unicode(4, 'éneedle'), unicode(6, 'needle')],
  },
  {
    name: 'explicit ASCII case folding is not overridden',
    argv: ['-n', '(?i-u:Kelvin)', 'src/unicode'],
    lines: [],
  },
  {
    name: 'overlapping roots preserve duplicate results',
    argv: ['-n', 'needle', 'src', 'src/nested'],
    lines: [
      'src/nested/references.txt:2:needle',
      'src/nested/references.txt:2:needle',
      unicode(4, 'éneedle'),
      unicode(6, 'needle'),
    ],
  },
  {
    name: 'repeated roots preserve duplicate results',
    argv: ['-n', 'needle', 'src/nested', 'src/nested'],
    lines: [
      'src/nested/references.txt:2:needle',
      'src/nested/references.txt:2:needle',
    ],
  },
  {
    name: 'matched CRLF line preserves CR byte',
    argv: ['-n', 'abc', 'src/endings'],
    lines: [ending(1, 'abc'), ending(2, '\rabc'), ending(3, 'abc\r')],
  },
  {
    name: 'context preserves CRLF and unterminated final line',
    argv: ['-nC1', 'abc', 'src/endings'],
    lines: [
      ending(1, 'abc'),
      ending(2, '\rabc'),
      ending(3, 'abc\r'),
      'src/endings/cases.txt-4-last',
    ],
  },
];

let comparisons = 0;
let failures = 0;
const compare = (test, reference, tools = ['rg', 'fff']) => {
  const options = {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  };
  const defaults = reference.argv0 === 'ugrep' ? [] : ['--no-config'];
  const status = test.status ?? (test.lines.length ? 0 : 1);
  const expectedLines = [...test.lines].sort();
  const baseline = spawnSync(
    reference.executable,
    [...defaults, ...test.argv],
    { ...options, ...(reference.argv0 ? { argv0: reference.argv0 } : {}) }
  );
  assert.ifError(baseline.error);
  assert.equal(baseline.status, status, `${reference.name}: ${test.name}`);
  assert.deepEqual(
    normalized(baseline.stdout),
    expectedLines,
    `${reference.name}: ${test.name}`
  );
  for (const tool of tools) {
    const actual = spawnSync(
      wrapper,
      [
        ...(reference.argv0
          ? [`--fff-claude-bin=${reference.executable}`]
          : []),
        ...defaults,
        ...test.argv,
      ],
      { ...options, argv0: tool }
    );
    comparisons++;
    try {
      assert.ifError(actual.error);
      assert.equal(actual.status, status);
      assert.deepEqual(normalized(actual.stdout), expectedLines);
      if (status === 2) assert.notEqual(actual.stderr, '');
    } catch (error) {
      failures++;
      process.stderr.write(
        `${reference.name}, ${tool}, ${test.name}: ${error.message}\n`
      );
    }
  }
};
try {
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  for (const test of cases)
    for (const reference of references) compare(test, reference);
  if (existsSync(native)) {
    const reference = {
      name: 'embedded Ugrep',
      executable: native,
      argv0: 'ugrep',
    };
    for (const test of [
      {
        name: 'Ugrep dot matches Unicode codepoints',
        argv: ['-rnE', 'foo.bar', 'src/unicode'],
        lines: [unicode(1, 'fooébar')],
      },
      {
        name: 'Ugrep repeated dot counts Unicode codepoints',
        argv: ['-rnE', '^...$', 'src/unicode'],
        lines: [unicode(2, 'ééé'), unicode(3, '١٢٣')],
      },
      {
        name: 'Ugrep ASCII ignore-case retains native folding',
        argv: ['-rni', 'Kelvin', 'src/unicode'],
        lines: [],
      },
    ])
      compare(test, reference, ['ugrep']);
  }
  assert.equal(
    failures,
    0,
    `${failures}/${comparisons} semantic comparisons failed`
  );
  process.stdout.write(
    `${comparisons} exact semantic comparisons passed against ${references.map(reference => reference.name).join(' and ')}\n`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
