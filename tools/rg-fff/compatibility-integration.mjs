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
const temp = mkdtempSync(path.join(os.tmpdir(), 'fff-compatibility-'));
chmodSync(temp, 0o700);
const root = path.join(temp, 'repo');
const home = path.join(temp, 'home');
mkdirSync(root);
mkdirSync(home);
mkdirSync(path.join(root, 'text'));
writeFileSync(
  path.join(root, 'text/a.txt'),
  [
    'foo',
    'bar',
    'foo foo foo',
    'foofoo',
    'foobar',
    'foo|bar',
    '(foo)',
    'foo(bar)',
    'fo+',
    'foo+',
    'fooo',
    'foo?',
    'foo{2}',
    'foo\\|bar',
    'FOO',
    'prefix foo suffix',
  ].join('\n') + '\n'
);
writeFileSync(path.join(root, 'text/b.txt'), 'bar\nfoo foo\nother\n');
writeFileSync(path.join(root, 'text/none.txt'), 'unrelated\n');
writeFileSync(path.join(root, 'text/empty.txt'), '');
writeFileSync(path.join(root, 'binary.dat'), Buffer.from('foo\0foo foo\n'));
assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
const files = ['text/a.txt', 'text/b.txt', 'text/none.txt', 'text/empty.txt'];
const env = {
  ...process.env,
  HOME: home,
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_NO_FUZZY_FALLBACK: '1',
  RG_FFF_SESSION: 'synthetic-compatibility',
  LC_ALL: 'C',
  GREP_OPTIONS: '',
  UGREP_OPTIONS: '',
  RIPGREP_CONFIG_PATH: '',
};
for (const name of [
  'RG_FFF_FIRST',
  'RG_FFF_DEBUG',
  'RG_FFF_LOG',
  'CLAUDE_CODE_EXECPATH',
])
  delete env[name];
const presets = [
  '-G',
  '--hidden',
  '--ignore-files',
  '--exclude-dir=.git',
  '--exclude-dir=.svn',
  '--exclude-dir=.hg',
  '--exclude-dir=.bzr',
  '--exclude-dir=.jj',
  '--exclude-dir=.sl',
];
const cases = [
  ['bre-word', ['foo']],
  ['bre-literal-alternation', ['foo|bar']],
  ['bre-literal-group', ['(foo)']],
  ['bre-literal-plus', ['fo+']],
  ['bre-literal-question', ['foo?']],
  ['bre-literal-repetition', ['foo{2}']],
  ['bre-alternation', ['foo\\|bar']],
  ['bre-group', ['\\(foo\\)']],
  ['bre-repetition', ['fo\\{2\\}']],
  ['bre-backreference', ['\\(foo\\)\\1']],
  ['bre-word-boundary', ['\\<foo\\>']],
  ['ere-alternation', ['-E', 'foo|bar']],
  ['ere-unprefixed', ['-E', 'foo|bar'], undefined, []],
  ['ere-group', ['-E', 'foo(bar)?']],
  ['ere-literal-group', ['-E', '\\(foo\\)']],
  ['ere-repetition', ['-E', 'fo{2}']],
  ['ere-only-matching', ['-E', '-o', 'foo|bar']],
  ['fixed-alternation', ['-F', 'foo|bar']],
  ['fixed-group', ['-F', '(foo)']],
  ['fixed-escaped-alternation', ['-F', 'foo\\|bar']],
  ['bre-pattern-list', ['-e', 'foo\\|bar', '-e', 'fo+']],
  ['ere-pattern-list', ['-E', '-e', '(foo|bar)', '-e', 'other']],
  ['fixed-pattern-list', ['-F', '-e', 'foo|bar', '-e', '(foo)']],
  ['last-extended', ['-G', '-E', 'foo|bar']],
  ['last-basic', ['-E', '-G', 'foo|bar']],
  ['last-fixed', ['-E', '-F', 'foo|bar']],
  ['fixed-then-extended', ['-F', '-E', 'foo|bar']],
  ['fixed-then-basic', ['-F', '-G', 'foo\\|bar']],
  ['combined-fixed-basic', ['-FG', 'foo\\|bar']],
  ['combined-extended-fixed', ['-EF', 'foo|bar']],
  ['combined-fixed-extended', ['-FE', 'foo|bar']],
  ['no-match', ['absent_symbol']],
  ['empty-file', ['foo'], ['text/empty.txt']],
  ['nonmatching-file', ['foo'], ['text/none.txt']],
  ['matching-file', ['foo'], ['text/a.txt']],
  ['count-all', ['-c', 'foo']],
  ['count-empty', ['-c', 'foo'], ['text/empty.txt']],
  ['count-none', ['-c', 'foo'], ['text/none.txt']],
  ['count-one', ['-c', 'foo'], ['text/a.txt']],
  ['count-files', ['-lc', 'foo']],
  ['files-count', ['-cl', 'foo']],
  ['count-matches', ['-oc', 'foo']],
  ['matches-count', ['-co', 'foo']],
  ['count-matches-none', ['-oc', 'foo'], ['text/none.txt', 'text/empty.txt']],
  ['count-files-none', ['-lc', 'foo'], ['text/none.txt', 'text/empty.txt']],
  ['count-separate-options', ['-c', '-l', 'foo']],
  ['files-separate-options', ['-l', '-c', 'foo']],
  ['count-fixed-patterns', ['-F', '-c', '-e', 'foo|bar', '-e', '(foo)']],
  ['count-extended', ['-E', '-c', 'foo|bar']],
  ['binary-skip', ['-I', 'foo'], [...files, 'binary.dat']],
  ['binary-count', ['-c', 'foo'], ['binary.dat']],
  ['binary-match-count', ['-oc', 'foo'], ['binary.dat']],
  ['binary-text', ['--binary-files=text', '-n', 'foo'], ['binary.dat']],
];
const rgCases = cases.filter(
  ([label]) =>
    (label.startsWith('count-') && label !== 'count-extended') ||
    label === 'files-count' ||
    label === 'matches-count' ||
    label === 'files-separate-options'
);

function execute(binary, argv, argv0, runEnv = env) {
  const result = spawnSync(binary, argv, {
    cwd: root,
    env: runEnv,
    argv0,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${argv0}: unexpected signal`);
  return result;
}

function normalized(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => line.replace(/ \[def\]$/, ''))
    .sort();
}

const native =
  process.env.RG_FFF_TEST_CLAUDE ||
  process.env.CLAUDE_CODE_EXECPATH ||
  path.join(os.homedir(), '.local/bin/claude');
const references = [
  { name: 'system-grep', binary: 'grep', argv0: 'grep', presets: [] },
];
references.push({
  name: 'system-rg',
  binary: 'rg',
  argv0: 'rg',
  tool: 'rg',
  cases: rgCases,
  presets: [],
});
if (existsSync(native)) {
  const probe = execute(native, ['--version'], 'ugrep');
  if (probe.status === 0 && /^ugrep\b/i.test(probe.stdout))
    references.push(
      {
        name: 'embedded-basic',
        binary: native,
        argv0: 'ugrep',
        presets: ['-G'],
      },
      { name: 'embedded-managed', binary: native, argv0: 'ugrep', presets }
    );
  const rgProbe = execute(native, ['--version'], 'rg');
  if (rgProbe.status === 0 && /^ripgrep\b/i.test(rgProbe.stdout))
    references.push({
      name: 'embedded-rg',
      binary: native,
      argv0: 'rg',
      tool: 'rg',
      cases: rgCases,
      presets: [],
    });
}
let comparisons = 0;
let servedChecks = 0;
let fallbackChecks = 0;
const failures = [];
try {
  for (const reference of references)
    for (const first of [undefined, '1', '0'])
      for (const [
        label,
        flags,
        operands = ['text'],
        casePresets = reference.presets,
      ] of reference.cases || cases) {
        const runEnv = { ...env };
        if (first !== undefined) runEnv.RG_FFF_FIRST = first;
        const args = [
          ...casePresets,
          ...(reference.tool === 'rg' ? [] : ['-r']),
          ...flags,
          ...operands,
        ];
        const expected = execute(
          reference.binary,
          args,
          reference.argv0,
          runEnv
        );
        const actual = execute(
          wrapper,
          [
            ...(reference.binary === native
              ? [`--fff-claude-bin=${native}`]
              : []),
            ...args,
          ],
          reference.tool || 'ugrep',
          runEnv
        );
        comparisons++;
        const routing =
          reference.tool === 'rg'
            ? undefined
            : label === 'ere-alternation' && casePresets.includes('-G')
              ? 'fallback'
              : [
                    'bre-word',
                    'bre-literal-alternation',
                    'ere-alternation',
                    'ere-unprefixed',
                  ].includes(label)
                ? 'served'
                : [
                      'bre-alternation',
                      'bre-group',
                      'bre-repetition',
                      'count-all',
                    ].includes(label)
                  ? 'fallback'
                  : undefined;
        if (routing) {
          const probe = execute(
            wrapper,
            [
              ...(reference.binary === native
                ? [`--fff-claude-bin=${native}`]
                : []),
              '--no-fallback',
              ...args,
            ],
            'ugrep',
            runEnv
          );
          if (routing === 'served') {
            assert.ok(
              probe.status === 0 || probe.status === 1,
              `${reference.name} ${label} FIRST=${first ?? 'unset'}: expected fff to serve`
            );
            servedChecks++;
          } else {
            assert.equal(
              probe.status,
              2,
              `${reference.name} ${label} FIRST=${first ?? 'unset'}: expected faithful fallback`
            );
            fallbackChecks++;
          }
        }
        if (
          actual.status !== expected.status ||
          JSON.stringify(normalized(actual.stdout)) !==
            JSON.stringify(normalized(expected.stdout))
        )
          failures.push({
            reference: reference.name,
            first: first ?? 'unset',
            label,
            expected: {
              status: expected.status,
              output: normalized(expected.stdout),
            },
            actual: {
              status: actual.status,
              output: normalized(actual.stdout),
            },
          });
      }
  assert.equal(
    failures.length,
    0,
    JSON.stringify(
      {
        mismatches: failures.length,
        cases: [
          ...new Set(
            failures.map(failure => `${failure.reference}:${failure.label}`)
          ),
        ],
        examples: failures.slice(0, 3),
      },
      null,
      2
    )
  );
  process.stdout.write(
    `${comparisons} grep dialect/count comparisons, ${servedChecks} fff-serving checks, and ${fallbackChecks} fallback checks passed across ${references.map(reference => reference.name).join(', ')} and default/FIRST=1/FIRST=0 environments\n`
  );
  if (!references.some(reference => reference.name === 'embedded-managed'))
    process.stdout.write(
      'Embedded ugrep is unavailable; native managed presets were skipped\n'
    );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
