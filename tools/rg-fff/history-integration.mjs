import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper =
  process.env.RG_FFF_TEST_BINARY ||
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'target/debug/rg-fff'
  );
const temp = mkdtempSync('/tmp/fff-history-test-');
chmodSync(temp, 0o700);
const root = path.join(temp, 'repo');
mkdirSync(root);
writeFileSync(
  path.join(root, 'HistoryFile.ts'),
  'HistoryNeedle();\nOtherNeedle();\n'
);
assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
const env = {
  ...process.env,
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_NO_FUZZY_FALLBACK: '1',
  RG_FFF_SESSION: 'synthetic-history',
  RIPGREP_CONFIG_PATH: '',
};
delete env.RG_FFF_DEBUG;
delete env.RG_FFF_LOG;
let locker;

function run(argv, argv0) {
  const result = spawnSync(wrapper, argv, {
    cwd: root,
    env,
    argv0,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function lockReceipt(file) {
  const child = spawn(
    'python3',
    [
      '-u',
      '-c',
      'import fcntl,sys\nf=open(sys.argv[1],"r+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("READY",flush=True)\nsys.stdin.buffer.read(1)\n',
      file,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  locker = child;
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('Receipt locker did not become ready')),
      2000
    );
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.includes('READY\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Receipt locker exited early'));
    });
  });
  return child;
}

async function stopLocker(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end('x');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(timer);
}

try {
  const initial = run(['--no-fallback', '-n', 'HistoryNeedle'], 'rg');
  const dir = path.join(env.RG_FFF_STATE_DIR, 'receipts');
  const names = readdirSync(dir);
  assert.equal(names.length, 1);
  const receipt = path.join(dir, names[0]);
  const before = readFileSync(receipt);
  await lockReceipt(receipt);
  assert.equal(run(['--no-fallback', '-n', 'HistoryNeedle'], 'rg'), initial);
  run(['--record-access', 'HistoryFile.ts', env.RG_FFF_SESSION]);
  assert.match(run(['files', 'HistoryFile']), /HistoryFile\.ts.* -> Read/);
  assert.deepEqual(
    readFileSync(receipt),
    before,
    'Contended history was modified'
  );
  await stopLocker(locker);
  locker = undefined;
  run(['--no-fallback', '-n', 'OtherNeedle'], 'rg');
  const after = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(after.length, JSON.parse(before.toString('utf8')).length + 1);
  assert.equal(after.at(-1).query, 'OtherNeedle');
  process.stdout.write(
    'Search, file discovery, and access recording remain responsive with contended receipts; history resumes after unlock\n'
  );
} finally {
  await stopLocker(locker);
  rmSync(temp, { recursive: true, force: true });
}
