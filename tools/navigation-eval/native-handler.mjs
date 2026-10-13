import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import which from 'which';
import { sha256 } from './core.mjs';

export function ripgrepIdentity(command = 'rg') {
  const path = realpathSync(
    isAbsolute(command) ? command : which.sync(command)
  );
  const version = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (
    version.error ||
    version.status !== 0 ||
    !version.stdout.startsWith('ripgrep ')
  ) {
    throw new Error('The adapter needs a working native ripgrep executable');
  }
  return {
    path,
    sha256: sha256(readFileSync(path)),
    version: version.stdout.trim(),
  };
}

function validateCapture(capture, identity) {
  if (JSON.stringify(capture.identity) !== JSON.stringify(identity)) {
    throw new Error('Captured ripgrep identity does not match the request');
  }
  const expected = sha256(
    JSON.stringify({
      identity: capture.identity,
      exitCode: capture.exitCode,
      stdout: capture.stdout,
      stderr: capture.stderr,
    })
  );
  if (capture.sha256 !== expected)
    throw new Error('Captured ripgrep bytes changed');
  return capture;
}

export async function captureRipgrep({
  args,
  target,
  cwd,
  cacheDir,
  ripgrep,
  beforeSpawn,
}) {
  beforeSpawn();
  const identity = {
    schemaVersion: 1,
    args,
    cwd,
    target,
    ripgrepSha256: ripgrep.sha256,
  };
  const key = sha256(JSON.stringify(identity));
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `${key}.json`);
  const lockPath = join(cacheDir, `${key}.lock`);
  const read = () =>
    validateCapture(JSON.parse(readFileSync(cachePath, 'utf8')), identity);
  const deadline = Date.now() + 25000;
  let lock;
  for (;;) {
    if (existsSync(cachePath)) return { ...read(), key, cacheHit: true };
    try {
      lock = openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for shared ripgrep capture');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const temporary = `${cachePath}.${process.pid}.tmp`;
  try {
    if (existsSync(cachePath)) return { ...read(), key, cacheHit: true };
    const run = spawnSync(ripgrep.path, [...args, target], {
      cwd,
      env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
      encoding: 'utf8',
      timeout: 20000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error || ![0, 1].includes(run.status)) {
      throw new Error(
        `Native ripgrep failed: ${run.error?.message ?? run.stderr ?? run.status}`
      );
    }
    const capture = {
      identity,
      exitCode: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
    };
    capture.sha256 = sha256(JSON.stringify(capture));
    writeFileSync(temporary, JSON.stringify(capture) + '\n');
    renameSync(temporary, cachePath);
    return { ...capture, key, cacheHit: false };
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function corpusPath(corpusDir, requested) {
  const root = realpathSync(corpusDir);
  const lexical = resolve(root, requested ?? '.');
  const canonical = realpathSync(lexical);
  for (const path of [lexical, canonical]) {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
      throw new Error(
        'Native handler test scope must remain inside the public corpus'
      );
    }
  }
  return { root, lexical, canonical };
}

export async function executeNative(extracted, input, settings) {
  const { corpusDir, query } = input;
  if (typeof query?.pattern !== 'string')
    throw new Error('A native regex query is required');
  const { root, lexical, canonical } = corpusPath(corpusDir, query.path);
  const captures = [];
  let pathRechecks = 0;
  let permissionRechecks = 0;
  const recheck = () => {
    if (realpathSync(lexical) !== canonical)
      throw new Error('Corpus target changed before spawn');
    pathRechecks++;
  };
  const globals = {
    Buffer,
    LL: sep,
    A: relative,
    se: () => root,
    Fo: JSON.parse,
    ie: () => ({ stat }),
    yRt: () => new Set(),
    RHn: () => [],
    Imr: () => false,
    kae: async () => [],
    xYt: () => false,
    Wlo: () => [],
    xmr: () => {
      permissionRechecks++;
    },
    Sre: async (args, target, signal, options) => {
      if (signal.aborted) throw new Error('Native handler request aborted');
      if (
        options.stdin !== undefined ||
        options.inheritFd !== undefined ||
        options.rawLines !== true ||
        options.rejectOnInputError !== true
      ) {
        throw new Error('Unexpected native Sre transport options');
      }
      const capture = await captureRipgrep({
        args,
        target,
        cwd: options.cwd,
        cacheDir: settings.cacheDir,
        ripgrep: settings.ripgrep,
        beforeSpawn: options.beforeSpawn,
      });
      captures.push(capture);
      return capture.exitCode === 1 || capture.stdout === ''
        ? []
        : capture.stdout.replace(/\n$/, '').split('\n');
    },
  };
  const code = [
    ...Object.values(extracted.functions).map(value => value.source),
    ...Object.entries(extracted.constants).map(
      ([name, value]) => `var ${name}=${value};`
    ),
    `const EI={${extracted.mapper}};`,
    'return {Foo,EI,Hoo,$Fe,BFe};',
  ].join('\n');
  const runtime = new Function(...Object.keys(globals), code)(
    ...Object.values(globals)
  );
  const descriptor = {
    lexical,
    canonical,
    target: canonical,
    spawnCwd: root,
    relativeOutput: false,
    isDirectory: statSync(canonical).isDirectory(),
    judgeEveryResult: false,
    recheckBeforeSpawn: recheck,
  };
  const parameters = {
    ...query,
    output_mode: query.output_mode ?? 'content',
    offset: input.offset ?? query.offset ?? 0,
  };
  const result = await runtime.Foo(descriptor, parameters, {
    signal: new AbortController().signal,
    permissions: () => ({}),
  });
  const mapped = runtime.EI.mapToolResultToToolResultBlockParam(
    result.data,
    'navigation-eval'
  );
  if (typeof mapped.content !== 'string')
    throw new Error('Unexpected native model-visible result shape');
  if (captures.length !== 1 || pathRechecks !== 1 || permissionRechecks !== 1) {
    throw new Error(
      'The native handler did not exercise exactly one rechecked ripgrep request'
    );
  }
  return {
    output: mapped.content,
    data: result.data,
    captures,
    pathRechecks,
    permissionRechecks,
  };
}
