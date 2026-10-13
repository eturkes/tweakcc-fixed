import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'target/debug/rg-fff'
);
const temp = mkdtempSync(path.join(os.tmpdir(), 'fff-output-'));
const root = path.join(temp, 'repo');
mkdirSync(root);
let directory = root;
for (let index = 0; index < 8; index++) {
  directory = path.join(directory, 'a'.repeat(90) + index);
  mkdirSync(directory);
}
writeFileSync(
  path.join(directory, 'hits.txt'),
  ('needle '.repeat(60) + '\n').repeat(800)
);
const env = {
  ...process.env,
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_NO_FUZZY_FALLBACK: '1',
  RIPGREP_CONFIG_PATH: '',
};
delete env.RG_FFF_LOG;
delete env.CLAUDE_CODE_EXECPATH;
const options = {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 30000,
  maxBuffer: 64 * 1024 * 1024,
};
const argv = ['-no', 'needle', '.'];

try {
  const expected = spawnSync('rg', argv, options);
  assert.ifError(expected.error);
  assert.equal(expected.status, 0, expected.stderr.toString());
  assert.ok(expected.stdout.length > 32 * 1024 * 1024);
  const rejected = spawnSync(wrapper, ['--no-fallback', ...argv], options);
  assert.ifError(rejected.error);
  assert.equal(rejected.status, 2, rejected.stderr.toString());
  assert.equal(rejected.stdout.length, 0);
  const actual = spawnSync(wrapper, argv, options);
  assert.ifError(actual.error);
  assert.equal(actual.status, expected.status, actual.stderr.toString());
  assert.deepEqual(actual.stdout, expected.stdout);
  assert.deepEqual(actual.stderr, expected.stderr);
  process.stdout.write(
    'Expanded output exceeds the buffer budget and falls back without partial or missing results\n'
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
