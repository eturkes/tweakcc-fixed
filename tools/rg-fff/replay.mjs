import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function normalize(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => line.replace(/ \[def\]$/, ''))
    .filter(line => line !== '--')
    .sort();
}

export function replay(
  records,
  { wrapper, claude, state, timeout = 3000, onMismatch, onError }
) {
  const summary = {
    searches: 0,
    served: 0,
    fallback: 0,
    mismatches: 0,
    skipped: 0,
    timeouts: 0,
  };
  const env = {
    ...process.env,
    RG_FFF_STATE_DIR: state,
    RG_FFF_LOG: '',
    RG_FFF_DEBUG: '',
    RG_FFF_SESSION: '',
    RG_FFF_NO_DAEMON: '1',
    RG_FFF_FIRST: '0',
    RG_FFF_NO_FUZZY_FALLBACK: '1',
  };
  if (!Array.isArray(records)) throw new Error('Invalid private replay data');
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      !['rg', 'grep'].includes(record.tool) ||
      !Array.isArray(record.argv) ||
      !record.argv.every(
        a =>
          typeof a === 'string' &&
          !/^(--pre|--hostname-bin|--filter|--fff-|--record-access|--daemon|--config|-@)/.test(
            a
          )
      ) ||
      typeof record.cwd !== 'string' ||
      !existsSync(record.cwd)
    ) {
      summary.skipped++;
      continue;
    }
    const argv0 = record.tool === 'grep' ? 'ugrep' : 'rg';
    const presets =
      record.tool === 'grep' && claude
        ? [
            '-G',
            '--hidden',
            '--ignore-files',
            '--exclude-dir=.git',
            '--exclude-dir=.svn',
            '--exclude-dir=.hg',
            '--exclude-dir=.bzr',
            '--exclude-dir=.jj',
            '--exclude-dir=.sl',
          ]
        : record.tool === 'rg'
          ? ['--no-config']
          : [];
    const args = [...presets, ...record.argv];
    const options = {
      cwd: record.cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    };
    const reference = spawnSync(claude || record.tool, args, {
      ...options,
      argv0: claude ? argv0 : record.tool,
    });
    const actual = spawnSync(
      wrapper,
      [...(claude ? [`--fff-claude-bin=${claude}`] : []), ...args],
      { ...options, argv0 }
    );
    if (reference.error || actual.error) {
      summary.timeouts++;
      onError?.(record, reference.error?.code, actual.error?.code);
      continue;
    }
    summary.searches++;
    if (
      reference.status !== actual.status ||
      JSON.stringify(normalize(reference.stdout)) !==
        JSON.stringify(normalize(actual.stdout))
    ) {
      summary.mismatches++;
      onMismatch?.(record, reference, actual);
    }
    const probe = spawnSync(
      wrapper,
      [
        ...(claude ? [`--fff-claude-bin=${claude}`] : []),
        '--no-fallback',
        ...args,
      ],
      {
        ...options,
        argv0,
      }
    );
    if (probe.status === 0 || probe.status === 1) summary.served++;
    else summary.fallback++;
  }
  return summary;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dataset = process.argv[2];
  if (!dataset)
    throw new Error(
      'Usage: replay.mjs <local-private-json> [wrapper] [claude]'
    );
  const state = mkdtempSync(path.join(os.tmpdir(), 'fff-replay-state-'));
  try {
    const summary = replay(JSON.parse(readFileSync(dataset, 'utf8')), {
      wrapper: path.resolve(
        process.argv[3] || path.join(here, 'target/debug/rg-fff')
      ),
      claude: process.argv[4] ? path.resolve(process.argv[4]) : undefined,
      state,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = summary.mismatches || summary.timeouts ? 1 : 0;
  } catch {
    process.stdout.write('{"error":"private_replay_failed"}\n');
    process.exitCode = 1;
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}
