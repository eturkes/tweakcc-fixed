import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'target/debug/rg-fff'
);
const temp = mkdtempSync('/tmp/fff-daemon-test-');
const root = path.join(temp, 'repo');
const one = path.join(root, 'one');
const two = path.join(root, 'two');
mkdirSync(one, { recursive: true });
mkdirSync(two);
mkdirSync(path.join(root, 'build'));
writeFileSync(path.join(root, '.gitignore'), 'build/\n');
writeFileSync(path.join(root, 'build/ignored.txt'), 'needle\n');
writeFileSync(path.join(one, 'a.ts'), 'needle\n');
writeFileSync(path.join(two, 'b.ts'), 'needle\n');
writeFileSync(path.join(one, 'sample_local.ts'), 'needle\n');
for (let index = 0; index < 25; index++)
  writeFileSync(path.join(two, `sample_${index}.ts`), 'needle\n');
assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
const env = {
  ...process.env,
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_IDLE_SECONDS: '30',
};
delete env.RG_FFF_NO_DAEMON;
const children = [];
const launch = cwd => {
  const child = spawn(wrapper, ['--daemon', cwd], {
    cwd,
    env,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
};
function rpc(socket, request) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let body = '';
    connection.setTimeout(2000, () =>
      connection.destroy(new Error('RPC timeout'))
    );
    connection.on('connect', () => connection.end(request));
    connection.on('data', data => {
      body += data.toString();
    });
    connection.on('end', () => resolve(body));
    connection.on('error', reject);
  });
}
try {
  launch(one);
  let socket;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const dir = path.join(env.RG_FFF_STATE_DIR, 'daemons');
      socket = readdirSync(dir).find(name => name.endsWith('.sock'));
      if (socket) {
        socket = path.join(dir, socket);
        if ((await rpc(socket, 'v10\nping\n{}\n')) === '0\n5\nREADY') break;
      }
    } catch {
      socket = undefined;
    }
    socket = undefined;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(socket, 'daemon did not become ready');
  const duplicate = launch(two);
  await new Promise(resolve => duplicate.once('exit', resolve));
  assert.equal(
    readdirSync(path.dirname(socket)).filter(name => name.endsWith('.sock'))
      .length,
    1
  );
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal(
    spawnSync(
      wrapper,
      [
        '--record-access',
        path.join(one, 'a.ts'),
        'synthetic',
        'navigation-session',
      ],
      { cwd: one, env }
    ).status,
    0
  );
  const scopeResult = spawnSync(wrapper, ['--scope', 'navigation-session'], {
    cwd: one,
    env,
    encoding: 'utf8',
  });
  assert.equal(scopeResult.status, 0);
  const scope = JSON.parse(scopeResult.stdout);
  assert.equal(scope.indexedFiles, 2);
  assert.equal(scope.recentSessionFiles, 1);
  assert.equal(scope.recentSessionDirectories, 1);
  assert.ok(
    Object.values(scope).every(
      value => Number.isSafeInteger(value) && value >= 0
    )
  );
  for (const [cwd, expected] of [
    [path.join(root, 'build'), './ignored.txt:1:needle\n'],
  ]) {
    const result = spawnSync(wrapper, ['-n', 'needle', '.'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
  }
  for (const cwd of [one, two]) {
    const result = spawnSync(wrapper, ['-n', 'needle', '.'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout
        .split('\n')
        .filter(Boolean)
        .every(line => /^\.\/[^/]+\.ts:/.test(line))
    );
  }
  const suggestions = spawnSync(wrapper, ['--suggest', 'sample', '15'], {
    cwd: one,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  assert.equal(suggestions.status, 0);
  const items = JSON.parse(suggestions.stdout);
  assert.ok(items.some(item => item.path === 'sample_local.ts'));
  assert.ok(
    items.every(
      item => !item.path.includes('two/') && item.score >= 0 && item.score <= 1
    )
  );
  assert.equal(await rpc(socket, 'obsolete\nping\n{}\n'), 'FALLBACK\n');
  assert.equal(await rpc(socket, 'v10\nsearch\nnot-json\n'), 'FALLBACK\n');
  writeFileSync(path.join(one, 'fresh.ts'), 'new_symbol\n');
  await new Promise(resolve => setTimeout(resolve, 300));
  const fresh = spawnSync(wrapper, ['-n', 'new_symbol', '.'], {
    cwd: one,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /fresh\.ts:1:new_symbol/);
  process.stdout.write(
    'Daemon root sharing, scoping, protocol, permissions, and watcher checks passed\n'
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
