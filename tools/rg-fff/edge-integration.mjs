import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
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
const temp = mkdtempSync(path.join(os.tmpdir(), 'fff-edge-test-'));
chmodSync(temp, 0o700);
const root = path.join(temp, 'repo');
for (const directory of ['plain', 'utf8', 'utf16le', 'utf16be', 'inventory'])
  mkdirSync(path.join(root, directory), { recursive: true });
writeFileSync(
  path.join(root, 'plain/data.txt'),
  'before\nneedle and needle\nafter\nquiet\nmore needle\nend\n'
);
const text = 'needle decoded\n';
const little = Buffer.from(text, 'utf16le');
const big = Buffer.from(little).swap16();
for (const [directory, contents] of [
  ['utf8', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])],
  ['utf16le', Buffer.concat([Buffer.from([0xff, 0xfe]), little])],
  ['utf16be', Buffer.concat([Buffer.from([0xfe, 0xff]), big])],
])
  writeFileSync(path.join(root, directory, 'data.txt'), contents);
writeFileSync(path.join(root, 'inventory/replacement�.txt'), 'needle first\n');
writeFileSync(path.join(root, 'inventory/other.txt'), 'needle second\n');
const input = path.join(temp, 'input.txt');
writeFileSync(input, 'needle from stdin\n');
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith('RG_FFF_')) delete env[key];
delete env.RIPGREP_CONFIG_PATH;
Object.assign(env, {
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_NO_FUZZY_FALLBACK: '1',
});
const native =
  process.env.RG_FFF_TEST_CLAUDE ||
  path.join(os.homedir(), '.local/bin/claude');
const tools = [
  { tool: 'rg', binary: 'rg', defaults: ['--no-config'] },
  ...(existsSync(native)
    ? [
        { tool: 'rg', binary: native, defaults: ['--no-config'] },
        { tool: 'ugrep', binary: native, defaults: [] },
      ]
    : []),
];
const normalized = buffer => {
  const value = buffer.toString('utf8');
  assert.ok(!value || value.endsWith('\n'));
  return value ? value.slice(0, -1).split('\n').sort() : [];
};
let comparisons = 0;

function run(binary, argv, tool = 'rg', extra = {}) {
  const { stdinFile, ...options } = extra;
  const descriptor = stdinFile ? openSync(stdinFile, 'r') : null;
  try {
    const result = spawnSync(binary, argv, {
      cwd: root,
      env,
      argv0: tool,
      stdio: [descriptor ?? 'ignore', 'pipe', 'pipe'],
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function compare(reference, argv, label, extra, fallback = true) {
  const args = [...reference.defaults, ...argv];
  const options = {
    ...extra,
    env:
      reference.binary === 'rg'
        ? {
            ...env,
            HOME: path.join(temp, 'empty-home'),
            CLAUDE_CODE_EXECPATH: '',
          }
        : env,
  };
  const expected = run(reference.binary, args, reference.tool, options);
  const prefix =
    reference.binary === 'rg' ? [] : [`--fff-claude-bin=${reference.binary}`];
  const actual = run(wrapper, [...prefix, ...args], reference.tool, options);
  assert.equal(actual.status, expected.status, `${label}: status`);
  assert.deepEqual(
    normalized(actual.stdout),
    normalized(expected.stdout),
    `${label}: output`
  );
  if (fallback) {
    const probe = run(
      wrapper,
      [...prefix, '--no-fallback', ...args],
      reference.tool,
      options
    );
    assert.equal(probe.status, 2, `${label}: native fallback`);
  }
  comparisons++;
}

try {
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  for (const reference of tools) {
    const recursive = reference.tool === 'ugrep' ? ['-r'] : [];
    for (const suffix of [
      ['-g'],
      ['--glob'],
      ['--include'],
      ['--color=garbage'],
      ['--fixed-regexp'],
    ])
      compare(
        reference,
        [...recursive, '-n', 'needle', 'plain', ...suffix],
        `${reference.tool} invalid ${suffix}`
      );
    compare(
      reference,
      [...recursive, '-n', '--pattern', 'needle', 'plain'],
      `${reference.tool} unsupported pattern alias`
    );
    if (reference.tool === 'rg')
      for (const suffix of [['--color'], ['--include=*.txt'], ['-I'], ['-nI']])
        compare(
          reference,
          ['-n', 'needle', 'plain', ...suffix],
          `rg option ${suffix}`
        );
    for (const context of ['-C1', '-A1', '-B1'])
      compare(
        reference,
        [...recursive, '-nFo', context, 'needle', 'plain'],
        `${reference.tool} only-matching context ${context}`
      );
    compare(
      reference,
      [...recursive, '-nFo', '-C0', 'needle', 'plain'],
      `${reference.tool} zero context stays eligible`,
      undefined,
      false
    );
    for (const encoding of ['utf8', 'utf16le', 'utf16be'])
      for (const mode of ['-n', '-l', '-c'])
        compare(
          reference,
          [...recursive, mode, 'needle', encoding],
          `${reference.tool} ${encoding} ${mode}`
        );
    if (reference.tool === 'rg') {
      compare(reference, ['-n', 'needle'], 'regular stdin redirection', {
        stdinFile: input,
      });
    }
  }
  for (const [name, enumeration] of [
    ['invalid-utf8', "printf 'inventory/replacement\\377.txt\\n'"],
    ['signaled', "printf 'inventory/other.txt\\n'; kill -TERM $$"],
  ]) {
    const executable = path.join(temp, name);
    writeFileSync(
      executable,
      '#!/bin/sh\nfor arg in "$@"; do\n' +
        '  if [ "$arg" = "--files" ]; then\n' +
        `    ${enumeration}\n    exit 0\n  fi\ndone\nexec rg "$@"\n`,
      { mode: 0o700 }
    );
    compare(
      { tool: 'rg', binary: executable, defaults: ['--no-config'] },
      ['-n', 'needle', 'inventory'],
      `${name} inventory is rejected`
    );
  }
  const opaque = spawnSync(
    'python3',
    [
      '-c',
      'import os,subprocess,sys\n' +
        'wrapper,native,root=sys.argv[1:]\n' +
        'args=[b"--no-config",b"-n",b"needle",b"missing-\\xff.txt"]\n' +
        'prefix=[os.fsencode("--fff-claude-bin="+native)] if native else []\n' +
        'expected=subprocess.run([b"rg",*args],executable=os.fsencode(native or "rg"),cwd=root,stdin=subprocess.DEVNULL,capture_output=True)\n' +
        'actual=subprocess.run([b"rg",*prefix,*args],executable=os.fsencode(wrapper),cwd=root,stdin=subprocess.DEVNULL,capture_output=True)\n' +
        'assert expected.returncode == 2\n' +
        'assert actual.returncode == expected.returncode, (actual.returncode,actual.stderr)\n' +
        'assert actual.stdout == expected.stdout\n' +
        'assert actual.stderr == expected.stderr\n',
      wrapper,
      existsSync(native) ? native : '',
      root,
    ],
    { env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  assert.ifError(opaque.error);
  assert.equal(opaque.status, 0, opaque.stderr.toString());
  process.stdout.write(
    `${comparisons} CLI/encoding/context/inventory comparisons and opaque argument preservation passed\n`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
