import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper =
  process.env.RG_FFF_TEST_BINARY ||
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'target/debug/rg-fff'
  );
assert.ok(existsSync(wrapper), `Build the Rust wrapper first: ${wrapper}`);
const temp = mkdtempSync('/tmp/fff-freshness-');
chmodSync(temp, 0o700);
const root = path.join(realpathSync(temp), 'repo');
mkdirSync(root);
const files = {
  'base.txt': 'needle old\n',
  'replace.txt': 'quiet old\n',
  'nonmatching.txt': 'filler other\n',
  'removed.txt': 'needle removed\n',
  'binary.txt': 'quiet\0xx\n',
};
for (const [name, contents] of Object.entries(files))
  writeFileSync(path.join(root, name), contents);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith('RG_FFF_')) delete env[key];
delete env.RIPGREP_CONFIG_PATH;
Object.assign(env, {
  RG_FFF_STATE_DIR: path.join(realpathSync(temp), 'state'),
  RG_FFF_IDLE_SECONDS: '30',
  RG_FFF_NO_FUZZY_FALLBACK: '1',
});
const request = {
  cwd: root,
  word: false,
  only_matching: false,
  expected_files: null,
  session: '',
  pattern: 'needle',
  symbol: 'needle',
  dir_prefixes: [],
  line_numbers: true,
  files_only: false,
  count: false,
  mode: 'Plain',
  ignore_case: false,
  hidden: false,
  before_context: 0,
  after_context: 0,
  sep_between_files: true,
  include_exts: [],
  path_prefix: '',
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let socket;
let comparisons = 0;

function native(argv, cwd = root) {
  const result = spawnSync('rg', ['--no-config', ...argv], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result;
}

function rpc(operation, payload) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    const chunks = [];
    connection.setTimeout(3000, () =>
      connection.destroy(new Error('Freshness daemon request timed out'))
    );
    connection.on('connect', () =>
      connection.end(`v11\n${operation}\n${JSON.stringify(payload)}\n`)
    );
    connection.on('data', chunk => chunks.push(chunk));
    connection.on('end', () => resolve(Buffer.concat(chunks)));
    connection.on('error', reject);
  });
}

async function search(overrides) {
  const response = await rpc('search', { ...request, ...overrides });
  if (response.equals(Buffer.from('FALLBACK\n'))) return null;
  const first = response.indexOf(10);
  const second = response.indexOf(10, first + 1);
  assert.ok(first > 0 && second > first);
  const code = Number(response.subarray(0, first).toString());
  const length = Number(response.subarray(first + 1, second).toString());
  const body = response.subarray(second + 1);
  assert.equal(body.length, length);
  const result = JSON.parse(body.toString('utf8'));
  assert.equal(result.code, code);
  return result;
}

const normalized = output => output.split('\n').filter(Boolean).sort();

async function compare(label, cwd = root) {
  const inventory = native(['--files'], cwd).stdout.split('\n').filter(Boolean);
  const expected = native(['-n', 'needle'], cwd);
  const actual = await search({ cwd, expected_files: inventory });
  assert.ok(actual, `${label}: daemon unexpectedly deferred`);
  assert.equal(actual.code, expected.status, `${label}: status`);
  assert.deepEqual(
    normalized(actual.body),
    normalized(expected.stdout),
    `${label}: complete current matches`
  );
  assert.deepEqual(
    [...actual.files].sort(),
    native(['-l', 'needle'], cwd).stdout.split('\n').filter(Boolean).sort(),
    `${label}: current typed file receipts`
  );
  comparisons++;
  return actual;
}

try {
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  child = spawn(wrapper, ['--daemon', root], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'Daemon exited before readiness');
    try {
      const directory = path.join(env.RG_FFF_STATE_DIR, 'daemons');
      const name = readdirSync(directory).find(name => name.endsWith('.sock'));
      if (name) {
        socket = path.join(directory, name);
        if ((await rpc('ping', {})).equals(Buffer.from('0\n5\nREADY'))) {
          ready = true;
          break;
        }
      }
    } catch {
      assert.equal(child.exitCode, null, 'Daemon exited before readiness');
    }
    await pause(50);
  }
  assert.ok(ready, 'Daemon did not become ready');
  await compare('initial warm index');
  await compare('unchanged warm index');
  const base = path.join(root, 'base.txt');
  for (let index = 0; index < 8; index++) {
    writeFileSync(base, readFileSync(base) + `needle appended${index}\n`);
    await compare(`immediate append ${index}`);
  }
  const replacement = path.join(root, 'replace.txt');
  const original = statSync(replacement);
  writeFileSync(replacement, 'needle ok\n');
  assert.equal(statSync(replacement).size, original.size);
  utimesSync(replacement, original.atime, original.mtime);
  await compare('same-size replacement with original timestamp');
  const beforeRename = statSync(replacement);
  const atomic = path.join(root, 'atomic.tmp');
  writeFileSync(atomic, 'quiet new\n');
  utimesSync(atomic, beforeRename.atime, beforeRename.mtime);
  renameSync(atomic, replacement);
  assert.notEqual(statSync(replacement).ino, beforeRename.ino);
  await compare('atomic inode replacement with restored timestamp');
  chmodSync(base, (statSync(base).mode & 0o777) ^ 0o100);
  await compare('permissions change on a cached matching file');
  const nonmatching = path.join(root, 'nonmatching.txt');
  writeFileSync(nonmatching, 'needle other\n');
  await compare('previously nonmatching file becomes matching');
  writeFileSync(path.join(root, 'new.txt'), 'needle created\n');
  await compare('new matching file');
  unlinkSync(path.join(root, 'removed.txt'));
  await compare('removed matching file');
  writeFileSync(path.join(root, 'binary.txt'), 'needle text\n');
  await compare('previously binary file becomes text');
  writeFileSync(path.join(root, 'binary.txt'), 'quiet\0xx\n');
  await compare('text becomes nonmatching binary');
  const nested = path.join(root, 'nested');
  mkdirSync(nested);
  writeFileSync(path.join(nested, 'child.txt'), 'needle child\n');
  await compare('current inventory scoped to nested cwd', nested);
  assert.equal(await search({ expected_files: null }), null);
  assert.equal(await search({ expected_files: ['../outside.txt'] }), null);
  assert.equal(await search({ expected_files: [base] }), null);
  assert.equal(await search({ expected_files: ['nested/../base.txt'] }), null);
  assert.equal(await search({ expected_files: ['nested//child.txt'] }), null);
  assert.equal(await search({ expected_files: ['missing.txt'] }), null);
  const outside = path.join(realpathSync(temp), 'outside.txt');
  writeFileSync(outside, 'needle outside\n');
  symlinkSync(outside, path.join(root, 'outside-link.txt'));
  assert.equal(await search({ expected_files: ['outside-link.txt'] }), null);
  const large = path.join(root, 'large.txt');
  writeFileSync(large, '');
  truncateSync(large, 10 * 1024 * 1024 + 1);
  assert.equal(await search({ expected_files: ['large.txt'] }), null);
  process.stdout.write(
    `${comparisons} immediate warm freshness comparisons and 8 inventory rejection checks passed\n`
  );
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  }
  rmSync(temp, { recursive: true, force: true });
}
