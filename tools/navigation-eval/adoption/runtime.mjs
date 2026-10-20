import {
  copyFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir, userInfo } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { directory, fileHash, saveJson } from './common.mjs';

export function accountAuth() {
  const result = spawnSync(
    'security',
    [
      'find-generic-password',
      '-a',
      process.env.USER ?? userInfo().username,
      '-w',
      '-s',
      'Claude Code-credentials',
    ],
    { encoding: 'utf8', timeout: 10000 }
  );
  let account;
  try {
    account = JSON.parse(result.stdout).claudeAiOauth;
  } catch {
    throw new Error(
      'Account credentials are unavailable; no refresh is performed'
    );
  }
  if (
    typeof account?.accessToken !== 'string' ||
    !account.accessToken ||
    (typeof account.expiresAt === 'number' && account.expiresAt <= Date.now())
  ) {
    throw new Error('A current account access token is required');
  }
  return {
    token: account.accessToken,
    secrets: [account.accessToken, account.refreshToken].filter(Boolean),
  };
}

export function cloneBinary(source, output) {
  copyFileSync(source, output);
  chmodSync(output, 0o700);
  return {
    path: output,
    sha256: fileHash(output),
    sourceSha256: fileHash(source),
  };
}

export function materialize(task, root) {
  const cwd = directory(join(root, 'fixture'));
  for (const [name, body] of Object.entries(task.files)) {
    const file = join(cwd, name);
    directory(dirname(file));
    writeFileSync(file, body, { mode: 0o600 });
    const timestamp = new Date('2026-10-01T00:00:00Z');
    utimesSync(file, timestamp, timestamp);
  }
  const git = spawnSync('git', ['init', '-q', cwd], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (git.status !== 0) throw new Error('Synthetic Git initialization failed');
  for (const name of [
    'claude-config',
    'tweakcc',
    'fff-state',
    'tmp',
    'cache',
    'state',
  ]) {
    directory(join(root, name));
  }
  saveJson(join(root, 'claude-config', '.claude.json'), {
    hasCompletedOnboarding: true,
    skipDangerousModePermissionPrompt: true,
  });
  saveJson(join(root, 'settings.json'), {
    disableClaudeAiConnectors: true,
    disableAllHooks: true,
    autoMemoryEnabled: false,
    enabledPlugins: {},
  });
  saveJson(join(root, 'mcp.json'), { mcpServers: {} });
  return cwd;
}

export function containment(root, outputRoot, binaries, wrappers, hiddenPaths) {
  const literal = value => JSON.stringify(realpathSync(resolve(value)));
  const tempRoots = canonicalTempRoots();
  for (const wrapper of wrappers) {
    const wrapperDirectory = realpathSync(dirname(wrapper));
    if (tempRoots.includes(wrapperDirectory) || wrapperDirectory === homedir())
      throw new Error('Wrapper read exception must be a narrow directory');
  }
  const rules = [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data file-write* (subpath ${literal(homedir())}))`,
    ...tempRoots.map(
      tempRoot =>
        `(deny file-read-data file-write* (subpath ${literal(tempRoot)}))`
    ),
    `(deny file-read-data file-write* (subpath ${literal(outputRoot)}))`,
    `(allow file-read-data file-write* (subpath ${literal(root)}))`,
    ...binaries.map(
      binary => `(allow file-read-data (literal ${literal(binary)}))`
    ),
    ...wrappers.map(
      wrapper => `(allow file-read-data (subpath ${literal(dirname(wrapper))}))`
    ),
    ...hiddenPaths.map(
      file => `(deny file-read-data (subpath ${literal(file)}))`
    ),
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
  ];
  const file = join(root, 'containment.sb');
  writeFileSync(file, rules.join('\n') + '\n', { mode: 0o600 });
  return file;
}

export function canonicalTempRoots() {
  return [...new Set(['/tmp', tmpdir()].map(path => realpathSync(path)))];
}

export function verifyContainment(profile, root) {
  const results = [];
  const roots = canonicalTempRoots();
  const canaries = roots.map(tempRoot =>
    mkdtempSync(join(tempRoot, 'fff-adoption-denied-'))
  );
  const env = { PATH: '/usr/bin:/bin', HOME: process.env.HOME };
  const invoke = (command, args, input) =>
    spawnSync('sandbox-exec', ['-f', profile, command, ...args], {
      env,
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
  const allowed = join(root, 'containment-allowed.txt');
  try {
    for (const [index, canary] of canaries.entries()) {
      const file = join(canary, 'synthetic-prior-gold.txt');
      writeFileSync(file, 'Synthetic prior gold must remain unreadable.\n');
      const read = invoke('/bin/cat', [file]);
      const write = invoke(
        '/usr/bin/tee',
        [file],
        'Unexpected canary mutation.\n'
      );
      const passed =
        read.status !== 0 &&
        read.stdout === '' &&
        write.status !== 0 &&
        readFileSync(file, 'utf8') ===
          'Synthetic prior gold must remain unreadable.\n';
      results.push({
        root: roots[index],
        readsDenied: read.status !== 0 && read.stdout === '',
        writesDenied: write.status !== 0,
        passed,
      });
      if (!passed)
        throw new Error('Prior system-temp records are not contained');
    }
    const write = invoke(
      '/usr/bin/tee',
      [allowed],
      'Current trial read/write permitted.\n'
    );
    const read = invoke('/bin/cat', [allowed]);
    if (
      write.status !== 0 ||
      read.status !== 0 ||
      read.stdout !== 'Current trial read/write permitted.\n'
    )
      throw new Error('Current trial root is not accessible');
    return { canonicalTempRoots: results, currentTrialReadWriteAllowed: true };
  } finally {
    for (const canary of canaries)
      rmSync(canary, { recursive: true, force: true });
    rmSync(allowed, { force: true });
  }
}

export function nativeEnvironment(root, port, effort, controls, token) {
  const preserved = ['HOME', 'USER', 'LOGNAME', 'LANG', 'TZ'];
  return {
    ...Object.fromEntries(
      preserved
        .filter(key => process.env[key] !== undefined)
        .map(key => [key, process.env[key]])
    ),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
    SHELL: '/bin/bash',
    CLAUDE_CODE_SHELL: '/bin/bash',
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    TWEAKCC_CONFIG_DIR: join(root, 'tweakcc'),
    RG_FFF_STATE_DIR: join(root, 'fff-state'),
    RG_FFF_LOG: join(root, 'wrapper-decisions.tsv'),
    RG_FFF_IDLE_SECONDS: '30',
    TMPDIR: join(root, 'tmp'),
    CLAUDE_CODE_TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'tweakcc'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_GROWTHBOOK: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(controls.outputTokens),
    CLAUDE_CODE_EFFORT_LEVEL: effort,
    CLAUDE_CODE_GZIP_REQUEST_BODIES: '0',
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ...(token
      ? { CLAUDE_CODE_OAUTH_TOKEN: token }
      : { ANTHROPIC_API_KEY: 'synthetic-local-probe' }),
  };
}

export function nativeArguments(binary, profile, task, root, controls) {
  return [
    '-f',
    profile,
    binary,
    '-p',
    task.prompt,
    '--model',
    controls.model,
    '--effort',
    task.effort,
    '--safe-mode',
    '--setting-sources',
    '',
    '--settings',
    join(root, 'settings.json'),
    '--strict-mcp-config',
    '--mcp-config',
    join(root, 'mcp.json'),
    '--no-session-persistence',
    '--system-prompt-snapshot',
    'off',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--max-budget-usd',
    String(controls.perRunUsd),
    '--max-turns',
    String(controls.maxTurns),
    '--no-chrome',
    '--disable-slash-commands',
  ];
}

export async function executeNative(args, cwd, env, timeoutSeconds) {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const started = performance.now();
  const status = await new Promise(resolveStatus => {
    const child = spawn('sandbox-exec', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const terminate = signal => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
    };
    child.stdout.on('data', data => {
      stdout += data;
    });
    child.stderr.on('data', data => {
      stderr += data;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 3000).unref();
    }, timeoutSeconds * 1000);
    child.once('error', () => {
      clearTimeout(timer);
      resolveStatus(null);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolveStatus(code);
    });
  });
  return {
    status,
    stdout,
    stderr,
    timedOut,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
}

export function verifyArtifacts(root, secrets) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const bytes = readFileSync(file);
        for (const secret of secrets) {
          if (bytes.includes(Buffer.from(secret))) {
            throw new Error(
              'Unexpected credential material in a trial artifact'
            );
          }
        }
      }
    }
  }
}

export function verifyFixture(task, cwd) {
  return Object.entries(task.files).every(([name, body]) => {
    const file = join(cwd, name);
    return statSync(file).isFile() && readFileSync(file, 'utf8') === body;
  });
}

export function promptPersistence(root) {
  const files = [];
  const pending = [join(root, 'claude-config')];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (
        /dump-prompts|system[-_]?prompt|\/sessions\/|\/projects\/.*\.jsonl$/.test(
          file
        )
      )
        files.push(file);
    }
  }
  return files;
}
