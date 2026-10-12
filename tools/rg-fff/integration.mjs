import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from './replay.mjs';

const wrapper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'target/debug/rg-fff'
);
const temp = mkdtempSync(path.join(os.tmpdir(), 'fff-integration-'));
const root = path.join(temp, 'repo');
mkdirSync(path.join(root, 'src'), { recursive: true });
mkdirSync(path.join(root, 'test'), { recursive: true });
writeFileSync(
  path.join(root, 'src', 'a.ts'),
  'before\nconst needle = 1; needle();\notherneedle\nafter\n'
);
writeFileSync(path.join(root, 'src', 'z.ts'), 'before\nneedle();\nafter\n');
writeFileSync(path.join(root, 'test', 'sample.tsx'), 'needle();\nother();\n');
const cases = [
  ['-n', 'needle'],
  ['-l', 'needle'],
  ['-c', 'needle'],
  ['-n', '-C1', 'needle'],
  ['-no', 'needle'],
  ['-now', 'needle'],
  ['-n', '-e', 'needle', '-e', 'other'],
  ['-nF', 'needle()'],
  ['-n', '-g', 'src/*.{ts,tsx}', 'needle'],
  ['-n', '-g', '**/*.ts', '-g', '!test/**', 'needle'],
  ['--no-line-number', 'needle'],
  ['-n', '--', 'needle'],
  ['-n', '-g', '*.[jt]s', 'needle'],
];
const env = {
  ...process.env,
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_SESSION: 'synthetic',
};
function run(argv) {
  const result = spawnSync(wrapper, argv, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  const summary = replay(
    cases.map(argv => ({ tool: 'rg', argv, cwd: root })),
    { wrapper, state: env.RG_FFF_STATE_DIR }
  );
  assert.equal(summary.mismatches, 0, JSON.stringify(summary));
  assert.equal(summary.timeouts, 0, JSON.stringify(summary));
  assert.equal(summary.served, cases.length, JSON.stringify(summary));
  run(['-n', 'needle']);
  run(['--record-access', path.join(root, 'src/z.ts'), 'synthetic']);
  assert.match(run(['-n', 'needle']), /^src\/z.ts:/);
  assert.equal(
    run(['-n', '-C1', 'needle'])
      .split('\n')
      .filter(line => line === '--').length,
    2
  );
  const filenames = run(['files', 'z.ts', '5']);
  assert.match(filenames, /src\/z\.ts -> Read/);
  assert.ok(!filenames.includes('needle();'));
  writeFileSync(path.join(root, 'src/unicode.ts'), 'needlé needleé\n');
  writeFileSync(
    path.join(root, 'src/long-unicode.ts'),
    'x'.repeat(600) + ' needleé\n'
  );
  const unicode = replay(
    ['-now', '-lw', '-cw'].map(flag => ({
      tool: 'rg',
      argv: [flag, 'needle'],
      cwd: root,
    })),
    { wrapper, state: env.RG_FFF_STATE_DIR }
  );
  assert.equal(unicode.mismatches, 0);
  assert.equal(unicode.fallback, 3);
  const native = path.join(os.homedir(), '.local/bin/claude');
  const claude = existsSync(native) ? native : undefined;
  const bre = replay(
    [
      { tool: 'grep', argv: ['-rn', '-e', 'needle', '-e', 'other'], cwd: root },
      {
        tool: 'grep',
        argv: ['-rnF', '-e', 'needle', '-e', 'other'],
        cwd: root,
      },
      {
        tool: 'grep',
        argv: ['-rn', '--exclude-dir', 'test', 'needle'],
        cwd: root,
      },
    ],
    { wrapper, claude, state: env.RG_FFF_STATE_DIR }
  );
  assert.equal(bre.mismatches, 0);
  const unsafe = replay(
    [{ tool: 'rg', argv: ['--pre', 'touch sentinel', 'needle'], cwd: root }],
    { wrapper, state: env.RG_FFF_STATE_DIR }
  );
  assert.equal(unsafe.skipped, 1);
  const malformed = path.join(temp, 'malformed.json');
  writeFileSync(malformed, '{"pattern":"PRIVATE_FIXTURE_SECRET",invalid}');
  const rejected = spawnSync(
    process.execPath,
    [
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'replay.mjs'),
      malformed,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '{"error":"private_replay_failed"}\n');
  assert.equal(rejected.stderr, '');
  writeFileSync(
    path.join(root, 'src/large.ts'),
    'needle' + 'x'.repeat(900) + '\n'
  );
  const longLines = replay(
    [{ tool: 'rg', argv: ['-n', 'needle'], cwd: root }],
    { wrapper, state: env.RG_FFF_STATE_DIR }
  );
  assert.equal(longLines.mismatches, 0);
  assert.equal(longLines.fallback, 1);
  process.stdout.write(
    'Synthetic search, feedback, and privacy checks passed\n'
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
