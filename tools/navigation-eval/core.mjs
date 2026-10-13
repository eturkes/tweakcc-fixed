import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticCorpus, writeSyntheticCorpus } from './fixtures.mjs';

export const directory = dirname(fileURLToPath(import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function readSuite() {
  const bytes = readFileSync(join(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  const integrity = JSON.parse(readFileSync(join(directory, 'integrity.json')));
  if (sha256(bytes) !== integrity.manifestSha256) {
    throw new Error('Frozen manifest hash mismatch');
  }
  if (manifest.corpus.revision !== integrity.revision) {
    throw new Error('Corpus revision differs from integrity lock');
  }
  const synthetic = syntheticCorpus();
  if (sha256(JSON.stringify(synthetic)) !== integrity.syntheticSha256) {
    throw new Error('Frozen synthetic corpus hash mismatch');
  }
  const tasks = [...manifest.tasks, ...synthetic.tasks];
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) {
    throw new Error('Duplicate task IDs');
  }
  for (const task of tasks) {
    if (
      new Set(task.requiredEvidence.map(item => item.id)).size !==
      task.requiredEvidence.length
    ) {
      throw new Error(`Duplicate evidence IDs: ${task.id}`);
    }
    for (const fact of task.expectedAnswerFacts) {
      if (
        fact.evidenceIds.some(
          id => !task.requiredEvidence.some(item => item.id === id)
        )
      ) {
        throw new Error(`Unknown fact evidence: ${fact.id}`);
      }
    }
  }
  return { manifest, integrity, tasks };
}

export function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
    ...options,
  });
  return {
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function checkedProcess(command, args, options) {
  const result = runProcess(command, args, options);
  if (result.error || result.exitCode !== 0) {
    throw new Error(
      `${command} failed: ${result.error ?? result.stderr ?? result.exitCode}`
    );
  }
  return result.stdout;
}

export function materializeCorpus(repository, suite = readSuite()) {
  const root = mkdtempSync(join(tmpdir(), 'navigation-eval-corpus-'));
  try {
    const archive = checkedProcess(
      'git',
      [
        'archive',
        '--format=tar',
        suite.integrity.revision,
        'src',
        '.gitignore',
      ],
      { cwd: repository, encoding: null }
    );
    checkedProcess('tar', ['-xf', '-', '-C', root], { input: archive });
    writeSyntheticCorpus(root);
    for (const [path, expected] of Object.entries(
      suite.integrity.sourceSha256
    )) {
      if (sha256(readFileSync(join(root, path))) !== expected) {
        throw new Error(`Pinned source hash mismatch: ${path}`);
      }
    }
    for (const task of suite.tasks) {
      for (const item of task.requiredEvidence) {
        const line = readFileSync(join(root, item.path), 'utf8').split('\n')[
          item.line - 1
        ];
        if (!line?.includes(item.snippet)) {
          throw new Error(`Missing frozen evidence: ${task.id}/${item.id}`);
        }
      }
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function clipUtf8(value, budget) {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error('Byte budget must be a nonnegative safe integer');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= budget) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = budget; end >= Math.max(0, budget - 3); end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      continue;
    }
  }
  return '';
}

const fieldText = value =>
  value.text ?? Buffer.from(value.bytes, 'base64').toString('utf8');

function safeScope(root, path) {
  const rel = relative(root, resolve(root, path));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) {
    throw new Error(`Query scope escapes corpus: ${path}`);
  }
}

export function nativeOracle(corpusDir, query) {
  safeScope(corpusDir, query.path);
  const args = [
    '--no-config',
    '--json',
    '--sort',
    'path',
    '--',
    query.pattern,
    query.path,
  ];
  const result = runProcess('rg', args, { cwd: corpusDir });
  if (result.error || ![0, 1].includes(result.exitCode)) {
    throw new Error(`Native oracle failed: ${result.error ?? result.stderr}`);
  }
  const matches = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(item => item.type === 'match')
    .map(({ data }) => ({
      path: fieldText(data.path).replace(/^\.\//, ''),
      line: data.line_number,
      text: fieldText(data.lines).replace(/\r?\n$/, ''),
      submatches: data.submatches.length,
    }));
  return {
    matches,
    totalFiles: new Set(matches.map(item => item.path)).size,
    totalMatches: matches.reduce((sum, item) => sum + item.submatches, 0),
    totalMatchedLines: matches.length,
  };
}

export function nativeRaw(corpusDir, query) {
  safeScope(corpusDir, query.path);
  const command = [
    'rg',
    '--no-config',
    '--line-number',
    '--with-filename',
    '--color',
    'never',
    '--sort',
    'path',
    '--context',
    String(query.context),
    '--',
    query.pattern,
    query.path,
  ];
  const result = runProcess(command[0], command.slice(1), { cwd: corpusDir });
  return { ...result, output: result.stdout, command };
}

export function runAdapter(adapter, corpusDir, query, byteBudget) {
  const command = adapter.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(value => typeof value !== 'string')
  ) {
    throw new Error('Adapter command must be a nonempty argv array');
  }
  const result = runProcess(command[0], command.slice(1), {
    cwd: corpusDir,
    input: JSON.stringify({
      schemaVersion: 1,
      corpusDir,
      query,
      byteBudget,
      offset: 0,
    }),
  });
  if (result.error || result.exitCode !== 0) {
    return {
      ...result,
      output: '',
      error: result.error ?? 'Adapter process failed',
    };
  }
  try {
    const response = JSON.parse(result.stdout);
    if (
      typeof response.output !== 'string' ||
      ![0, 1, 2].includes(response.exitCode)
    ) {
      throw new Error(
        'Adapter response needs output:string and exitCode:0|1|2'
      );
    }
    return {
      ...response,
      command,
      stderr: result.stderr,
      error: response.error ?? null,
    };
  } catch (error) {
    return {
      output: '',
      exitCode: 2,
      error: error.message,
      stderr: result.stderr,
    };
  }
}

export function visibleLocations(output, corpusDir = '') {
  const entries = [];
  const files = new Set();
  const root = corpusDir ? resolve(corpusDir) : '';
  const normalize = path => {
    if (!path || path.includes('\u0000')) return null;
    if (!root) return path.replace(/^\.\//, '');
    const normalized = relative(root, resolve(root, path));
    if (
      isAbsolute(normalized) ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      return null;
    }
    try {
      return lstatSync(join(root, normalized)).isFile() ? normalized : null;
    } catch {
      return null;
    }
  };
  for (const row of output.split('\n')) {
    const boundaries = [...row.matchAll(/(?=([:-])(\d+)\1)/g)];
    const candidates = boundaries.flatMap(match => {
      const path = normalize(row.slice(0, match.index));
      const line = Number(match[2]);
      if (!path || !Number.isSafeInteger(line) || line <= 0) return [];
      return [
        { path, line, text: row.slice(match.index + match[2].length + 2) },
      ];
    });
    const standalone = root || boundaries.length === 0 ? normalize(row) : null;
    if (candidates.length === 1 && !standalone) {
      entries.push(candidates[0]);
      files.add(candidates[0].path);
    } else if (candidates.length === 0 && standalone) {
      files.add(standalone);
    }
  }
  return { entries, files: [...files] };
}

export function scoreQuery(result, oracle, byteBudget, corpusDir = '') {
  const output = clipUtf8(result.output ?? '', byteBudget);
  const valid =
    !result.error &&
    (result.exitCode === 0 ||
      (result.exitCode === 1 && oracle.totalMatchedLines === 0));
  const locations = valid
    ? visibleLocations(output, corpusDir)
    : { entries: [], files: [] };
  const visibleMatches = oracle.matches.filter(match =>
    locations.entries.some(
      item =>
        item.path === match.path &&
        item.line === match.line &&
        item.text === match.text
    )
  );
  const visibleComplete =
    valid && visibleMatches.length === oracle.matches.length;
  const violations = [];
  for (const field of ['totalFiles', 'totalMatches', 'totalMatchedLines']) {
    if (result[field] !== undefined && result[field] !== oracle[field]) {
      violations.push(
        `${field}: reported ${result[field]}, actual ${oracle[field]}`
      );
    }
  }
  if (result.complete === true && !visibleComplete) {
    violations.push(
      'complete=true although matching source lines are not all visible'
    );
  }
  if (result.nextOffset !== undefined && result.nextOffset !== null) {
    if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= 0) {
      violations.push('Continuation offset does not advance');
    }
    if (result.complete === true || oracle.totalMatchedLines === 0) {
      violations.push(
        'Continuation contradicts completeness or an empty result'
      );
    }
  }
  return {
    valid,
    exitCode: result.exitCode,
    error: result.error ?? null,
    output,
    visibleBytes: Buffer.byteLength(output),
    sourceBytes: Buffer.byteLength(result.output ?? ''),
    budgetClipped: output !== (result.output ?? ''),
    totalFiles: oracle.totalFiles,
    totalMatches: oracle.totalMatches,
    totalMatchedLines: oracle.totalMatchedLines,
    visibleMatchedLines: visibleMatches.length,
    visibleComplete,
    reported: Object.fromEntries(
      [
        'totalFiles',
        'totalMatches',
        'totalMatchedLines',
        'complete',
        'nextOffset',
      ]
        .filter(field => result[field] !== undefined)
        .map(field => [field, result[field]])
    ),
    honestyViolations: violations,
    locations,
  };
}

export function scoreTask(task, queries) {
  const entries = queries.flatMap(query => query.locations.entries);
  const files = new Set(queries.flatMap(query => query.locations.files));
  const requiredFiles = [
    ...new Set(task.requiredEvidence.map(item => item.path)),
  ];
  const evidence = task.requiredEvidence.map(item => ({
    ...item,
    visible: entries.some(
      entry =>
        entry.path === item.path &&
        entry.line === item.line &&
        entry.text.includes(item.snippet)
    ),
  }));
  const covered = new Set(
    evidence.filter(item => item.visible).map(item => item.id)
  );
  return {
    requiredFiles: requiredFiles.length,
    visibleRequiredFiles: requiredFiles.filter(path => files.has(path)),
    missingRequiredFiles: requiredFiles.filter(path => !files.has(path)),
    requiredEvidence: evidence.length,
    visibleRequiredEvidence: evidence
      .filter(item => item.visible)
      .map(item => item.id),
    missingRequiredEvidence: evidence
      .filter(item => !item.visible)
      .map(item => item.id),
    fullySupportedFacts: task.expectedAnswerFacts
      .filter(
        fact =>
          fact.evidenceIds.length > 0 &&
          fact.evidenceIds.every(id => covered.has(id))
      )
      .map(fact => fact.id),
    failedQueries: queries.filter(query => !query.valid).length,
    honestyViolations: queries.flatMap(query => query.honestyViolations),
    allEvidenceVisible:
      evidence.every(item => item.visible) &&
      queries.every(query => query.valid),
  };
}

export function writeDirectory(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
