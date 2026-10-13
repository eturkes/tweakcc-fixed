import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
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
const temp = mkdtempSync(path.join(os.tmpdir(), 'fff-viewer-test-'));
chmodSync(temp, 0o700);
const root = path.join(temp, 'repo');
const viewers = path.join(temp, 'viewers');
const custom = path.join(temp, 'custom');
const customPlain = path.join(temp, 'custom-plain');
const emptyCustom = path.join(root, 'empty-custom');
const maskRoot = path.join(temp, 'masks');
const zDotDir = path.join(temp, 'zsh');
mkdirSync(zDotDir);
for (const directory of [root, viewers, custom, path.join(root, 'src')])
  mkdirSync(directory, { recursive: true });
for (const viewer of ['cat', 'head', 'tail', 'sed'])
  symlinkSync(wrapper, path.join(viewers, viewer));
for (const [name, data] of Object.entries({
  'a.txt': 'alpha\nbeta\ngamma\n',
  'b.txt': 'delta\nepsilon\n',
  'empty.txt': '',
  'space name.txt': 'spaces\n',
  'café.txt': 'unicode\n',
  '-dash.txt': 'dash\n',
  'src/nested.txt': 'nested\n',
  'large.txt': 'line\n'.repeat(500000),
  'script.sed': '1p\n',
  'src/AlphaService.ts': 'export const Service = 1;\n',
  'src/ZetaService.ts': 'export const Service = 1;\n',
}))
  writeFileSync(path.join(root, name), data);
try {
  writeFileSync(
    Buffer.concat([
      Buffer.from(`${root}/`),
      Buffer.from([255]),
      Buffer.from('.txt'),
    ]),
    'bytes\n'
  );
} catch (error) {
  if (process.platform !== 'darwin' || error.code !== 'EILSEQ') throw error;
  process.stdout.write(
    'Darwin rejected the non-UTF8 fixture; execution parity is still checked\n'
  );
}
writeFileSync(path.join(temp, 'outside.txt'), 'outside\n');
symlinkSync(
  path.join(temp, 'outside.txt'),
  path.join(root, 'outside-link.txt')
);
symlinkSync(path.join(root, 'a.txt'), path.join(root, 'inside-link.txt'));
writeFileSync(
  path.join(custom, 'cat'),
  '#!/bin/sh\nprintf "custom:%s:%s\\n" "$0" "$*"\n'
);
chmodSync(path.join(custom, 'cat'), 0o700);
for (const directory of [customPlain, emptyCustom]) {
  mkdirSync(directory);
  writeFileSync(
    path.join(directory, 'cat'),
    `${directory === emptyCustom ? '#!/bin/sh\n' : ''}printf "plain:%s:%s\\n" "$0" "$*"\n`
  );
  chmodSync(path.join(directory, 'cat'), 0o700);
}
for (let mask = 0; mask < 16; mask++) {
  const directory = path.join(maskRoot, String(mask));
  mkdirSync(directory, { recursive: true });
  for (const [bit, viewer] of ['cat', 'head', 'tail', 'sed'].entries())
    if (mask & (1 << bit)) symlinkSync(wrapper, path.join(directory, viewer));
}
assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
const basePath = process.env.PATH;
const shellNames = ['/bin/bash', '/bin/zsh'].filter(existsSync);
const baseEnv = {
  ...process.env,
  RG_FFF_STATE_DIR: path.join(temp, 'state'),
  RG_FFF_NO_DAEMON: '1',
  RG_FFF_CONTEXT_ROOT: root,
  RG_FFF_SESSION: '314159',
  CLAUDE_PID: '314159',
  ZDOTDIR: zDotDir,
};
delete baseEnv.RG_FFF_VIEWER_DIR;
delete baseEnv.BASH_ENV;
delete baseEnv.ENV;
let comparisons = 0;
let caseIndex = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function execute(shell, command, env, options = {}) {
  const result = spawnSync(
    shell,
    [
      ...(shell.endsWith('zsh') ? ['-f'] : []),
      '-c',
      `export PATH=${shellQuote(env.PATH)}; ${command}`,
    ],
    {
      cwd: root,
      env,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    }
  );
  assert.ifError(result.error);
  return result;
}

function control(argv, env = baseEnv) {
  const result = spawnSync(wrapper, argv, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function history(session, env, expected, label) {
  const deadline = Date.now() + 1500;
  let actual;
  do {
    actual = JSON.parse(control(['--context', session], env)).sort();
    if (JSON.stringify(actual) === JSON.stringify([...expected].sort())) break;
    await pause(20);
  } while (Date.now() < deadline);
  assert.deepEqual(actual, [...expected].sort(), `${label}: learned files`);
}

const cases = [
  ['cat-single', 'cat a.txt', ['a.txt']],
  ['cat-multiple', 'cat a.txt b.txt', ['a.txt', 'b.txt']],
  ['cat-empty', 'cat empty.txt', ['empty.txt']],
  [
    'quoted-unicode',
    "cat 'space name.txt' café.txt",
    ['space name.txt', 'café.txt'],
  ],
  ['non-utf8', 'cat "$(printf \'\\377.txt\')"', []],
  ['dash-name', 'cat -- -dash.txt', ['-dash.txt']],
  ['cat-numbered', 'cat -n a.txt', ['a.txt']],
  ['cat-help', 'cat --help a.txt', []],
  ['cat-version', 'cat --version a.txt', []],
  ['glob', 'cat src/*.txt', ['src/nested.txt']],
  ['variable', 'p=a.txt; cat "$p"', ['a.txt']],
  ['changed-directory', 'cd src; cat nested.txt', ['src/nested.txt']],
  ['changed-relative-parent', 'cd src; cat ../a.txt', ['a.txt']],
  ['changed-outside', 'cd ..; cat outside.txt', []],
  ['inside-symlink', 'cat inside-link.txt', ['a.txt']],
  ['outside-symlink', 'cat outside-link.txt', []],
  ['unexecuted', 'false && cat a.txt; printf done', []],
  ['conditional', 'if false; then cat a.txt; else cat b.txt; fi', ['b.txt']],
  ['substitution', 'v=$(cat a.txt); printf "%s" "$v"', ['a.txt']],
  ['loop', 'for p in a.txt b.txt; do cat "$p"; done', ['a.txt', 'b.txt']],
  [
    'background-jobs',
    'for i in 1 2 3 4; do cat a.txt >/dev/null & done; wait',
    ['a.txt'],
  ],
  ['failed-multiple', 'cat a.txt missing.txt; printf done', []],
  ['head-lines', 'head -n 2 a.txt b.txt', ['a.txt', 'b.txt']],
  ['head-default', 'head a.txt', ['a.txt']],
  ['head-bytes', 'head -c3 a.txt', ['a.txt']],
  ['head-zero', 'head -n 0 a.txt', []],
  ['tail-lines', 'tail -n1 a.txt', ['a.txt']],
  ['tail-default', 'tail a.txt', ['a.txt']],
  ['tail-bytes', 'tail -c 3 a.txt', ['a.txt']],
  ['tail-zero', 'tail -c0 a.txt', []],
  ['unknown-option', 'cat --fff-unknown-option a.txt', []],
  ['sed-range', "sed -n '1,2p' a.txt", ['a.txt']],
  ['sed-default', "sed 's/alpha/ALPHA/' a.txt", ['a.txt']],
  ['sed-expression', "sed -n -e '2p' a.txt", ['a.txt']],
  ['sed-script-file', 'sed -n -f script.sed a.txt', ['a.txt']],
  ['sed-early-single', "sed -n '1p;q' a.txt", ['a.txt']],
  ['sed-early-multiple', "sed -n '1p;q' a.txt b.txt", []],
  ['sed-in-place', "sed -i.bak 's/alpha/alpha/' a.txt", []],
  ['sed-zero', "sed -n 'q' a.txt", ['a.txt']],
  ['stdin-redirection', 'cat < a.txt', []],
  ['stdin-pipe', 'printf piped | cat', []],
  ['explicit-command', 'command cat a.txt', ['a.txt']],
  ['env-command', 'env cat a.txt', ['a.txt']],
  ['xargs-command', "printf '%s\\n' a.txt | xargs cat", ['a.txt']],
  ['absolute-command', '/bin/cat a.txt', []],
  [
    'sigpipe',
    'set -o pipefail; cat large.txt | head -n1; printf "status:%s\\n" "$?"',
    [],
  ],
  [
    'ignored-sigpipe',
    'trap \'\' PIPE; set -o pipefail; cat large.txt | head -n1; printf "status:%s\\n" "$?"',
    [],
  ],
  ['errexit', 'set -e; cat missing.txt; printf should-not-run', []],
  [
    'errexit-guard',
    'set -e; if cat missing.txt; then printf bad; fi; printf done',
    [],
  ],
  [
    'pipe-status',
    'set -o pipefail; cat missing.txt | cat; printf "status:%s\\n" "$?"',
    [],
  ],
  ['last-argument', 'cat a.txt >/dev/null; printf "%s\\n" "$_"', ['a.txt']],
  ['existing-function', 'function cat { printf custom; }; cat a.txt', []],
  ['existing-alias', "alias cat='printf alias'; eval 'cat a.txt'", []],
  ['path-replaced', `PATH=${shellQuote(basePath)}; cat a.txt`, []],
  ['custom-viewer', 'cat a.txt', [], { PATH: `${custom}:${basePath}` }],
  [
    'relative-custom-viewer',
    'cat a.txt',
    [],
    { PATH: `../custom:${basePath}` },
  ],
  ['empty-path-entry', 'cat a.txt', ['a.txt'], { PATH: `:${basePath}` }],
  [
    'repeated-proxy-entry',
    'cat a.txt',
    ['a.txt'],
    { proxyPath: `${viewers}:${viewers}:${basePath}` },
  ],
  [
    'unavailable-feedback',
    'cat a.txt',
    [],
    { RG_FFF_STATE_DIR: path.join(root, 'a.txt') },
  ],
];

async function compare(shell, label, command, expected, overrides = {}) {
  const session = `case-${++caseIndex}`;
  const { proxyPath, proxyDirectory = viewers, ...envOverrides } = overrides;
  const env = {
    ...baseEnv,
    CLAUDE_CODE_SESSION_ID: session,
    PATH: basePath,
    ...envOverrides,
  };
  const prefix = shell.endsWith('bash') ? 'shopt -s expand_aliases; ' : '';
  const baseline = execute(shell, prefix + command, env);
  const observedEnv = {
    ...env,
    RG_FFF_VIEWER_DIR: proxyDirectory,
    PATH: proxyPath || `${proxyDirectory}:${env.PATH}`,
  };
  const observed = execute(shell, prefix + command, observedEnv);
  for (const key of ['stdout', 'stderr', 'status', 'signal'])
    assert.deepEqual(
      observed[key],
      baseline[key],
      `${path.basename(shell)} ${label}: ${key}`
    );
  await history(
    session,
    observedEnv,
    expected,
    `${path.basename(shell)} ${label}`
  );
  comparisons++;
}

function awaitExit(child, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error('Viewer cancellation did not finish within two seconds')
      );
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal });
    });
  });
}

async function cancellation(shell, grouped, env, command, signal) {
  const child = spawn(shell, ['-c', `exec ${command}`], {
    cwd: root,
    env,
    detached: true,
    stdio: 'ignore',
  });
  try {
    const exited = awaitExit(child);
    await pause(100);
    process.kill(grouped ? -child.pid : child.pid, signal);
    const result = await exited;
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      assert.ok(
        Date.now() < deadline,
        'Cancellation left a reader process behind'
      );
      await pause(20);
    }
    return result;
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        process.stderr.write(`Reader cleanup failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    }
  }
}

try {
  for (const shell of shellNames)
    for (const [label, command, expected, overrides] of cases)
      await compare(shell, label, command, expected, overrides);
  await compare(
    '/bin/bash',
    'ERR-trap',
    'set -E; trap \'printf "ERR\\n" >&2\' ERR; cat missing.txt; printf done',
    []
  );
  let maskComparisons = 0;
  for (const [label, searchPath, expectedMask, command, learned] of [
    ['native-mask', '/usr/bin:/bin', 15, 'cat a.txt', ['a.txt']],
    ['custom-mask', `${custom}:/usr/bin:/bin`, 14, 'cat a.txt', []],
    ['plain-script-mask', `${customPlain}:/usr/bin:/bin`, 14, 'cat a.txt', []],
    ['relative-mask', '../custom:/usr/bin:/bin', 0, 'cat a.txt', []],
    ['leading-empty-mask', ':/usr/bin:/bin', 0, 'cat a.txt', []],
    [
      'empty-custom-mask',
      ':/usr/bin:/bin',
      0,
      'cd empty-custom; cat ../a.txt',
      [],
    ],
    ['later-empty-mask', '/usr/bin:/bin:', 15, 'cat a.txt', ['a.txt']],
  ]) {
    const env = { ...baseEnv, PATH: searchPath };
    const started = Date.now();
    assert.equal(
      Number(control(['--viewer-mask'], env).trim()),
      expectedMask,
      label
    );
    assert.ok(
      Date.now() - started < 2000,
      `${label}: mask selection did not finish promptly`
    );
    const directory = path.join(maskRoot, String(expectedMask));
    for (const shell of shellNames)
      await compare(shell, label, command, learned, {
        PATH: searchPath,
        proxyDirectory: directory,
      });
    maskComparisons++;
  }
  assert.equal(
    Number(
      control(['--viewer-mask'], {
        ...baseEnv,
        RG_FFF_VIEWER_DIR: viewers,
        PATH: `${viewers}:${viewers}:/usr/bin:/bin`,
      }).trim()
    ),
    15
  );
  maskComparisons++;
  assert.equal(spawnSync('mkfifo', [path.join(root, 'read.fifo')]).status, 0);
  for (const [name, command] of [
    ['fifo', 'cat read.fifo'],
    ['supervised-fifo', 'cat a.txt read.fifo'],
    ['follow', 'tail -f a.txt'],
  ])
    for (const [grouped, signal] of [
      [false, 'SIGTERM'],
      [true, 'SIGTERM'],
      [false, 'SIGINT'],
      [true, 'SIGINT'],
    ]) {
      const env = {
        ...baseEnv,
        PATH: basePath,
        CLAUDE_CODE_SESSION_ID: `cancel-${name}-${grouped}-${signal}`,
      };
      const baseline = await cancellation(
        '/bin/bash',
        grouped,
        env,
        command,
        signal
      );
      const observedEnv = {
        ...env,
        PATH: `${viewers}:${basePath}`,
        RG_FFF_VIEWER_DIR: viewers,
      };
      assert.deepEqual(
        await cancellation('/bin/bash', grouped, observedEnv, command, signal),
        baseline
      );
      await history(
        env.CLAUDE_CODE_SESSION_ID,
        observedEnv,
        [],
        `${name} ${signal} cancellation grouped=${grouped}`
      );
    }
  const rankingEnv = {
    ...baseEnv,
    RG_FFF_STATE_DIR: path.join(temp, 'ranking-state'),
    RG_FFF_VIEWER_DIR: viewers,
    PATH: `${viewers}:${basePath}`,
    CLAUDE_CODE_SESSION_ID: 'ranking-one',
  };
  assert.equal(
    execute('/bin/bash', 'cat src/AlphaService.ts >/dev/null', {
      ...rankingEnv,
      CLAUDE_CODE_SESSION_ID: 'ranking-seed',
    }).status,
    0
  );
  await history(
    'ranking-seed',
    rankingEnv,
    ['src/AlphaService.ts'],
    'ranking seed session'
  );
  const before = control(['files', 'Service'], rankingEnv);
  assert.match(
    before.split('\n').find(line => line && !line.startsWith('#')),
    /^src\/AlphaService\.ts/
  );
  const read = execute(
    '/bin/bash',
    'for i in 1 2 3 4 5 6 7 8; do cat src/ZetaService.ts >/dev/null; done; export CLAUDE_CODE_SESSION_ID=ranking-two; cat src/AlphaService.ts >/dev/null',
    rankingEnv
  );
  assert.equal(read.status, 0, read.stderr.toString());
  await history(
    'ranking-one',
    rankingEnv,
    ['src/ZetaService.ts'],
    'ranking first session'
  );
  await history(
    'ranking-two',
    rankingEnv,
    ['src/AlphaService.ts'],
    'ranking second session'
  );
  assert.match(
    control(['files', 'Service'], rankingEnv)
      .split('\n')
      .find(line => line && !line.startsWith('#')),
    /^src\/AlphaService\.ts(?: \[modified\])? -> Read/
  );
  assert.equal(
    execute('/bin/bash', 'cat src/ZetaService.ts >/dev/null', rankingEnv).status,
    0
  );
  assert.match(
    control(['files', 'Service'], rankingEnv)
      .split('\n')
      .find(line => line && !line.startsWith('#')),
    /^src\/ZetaService\.ts(?: \[modified\])? -> Read/
  );
  assert.match(
    control(['--no-fallback', '-n', 'Service', 'src'], rankingEnv),
    /^src\/ZetaService\.ts:/
  );
  process.stdout.write(
    `${comparisons} native viewer comparisons, ${maskComparisons} mask selections, 12 cancellation cases, ranking, and session separation passed\n`
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
