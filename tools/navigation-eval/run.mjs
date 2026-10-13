import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  directory,
  materializeCorpus,
  nativeOracle,
  nativeRaw,
  readSuite,
  runAdapter,
  runProcess,
  scoreQuery,
  scoreTask,
  sha256,
  writeDirectory,
} from './core.mjs';

function options(args) {
  const result = { adapters: [], only: [], keepCorpus: false, verify: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--verify') result.verify = true;
    else if (flag === '--keep-corpus') result.keepCorpus = true;
    else if (['--adapter', '--out', '--repository', '--only'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing ${flag} value`);
      if (flag === '--adapter') result.adapters.push(resolve(value));
      else if (flag === '--only') result.only.push(value);
      else result[flag.slice(2)] = resolve(value);
    } else if (flag === '--help') {
      console.log(
        'node tools/navigation-eval/run.mjs [--verify] [--out DIR] ' +
          '[--repository DIR] [--adapter FILE.json] [--only TASK_ID] [--keep-corpus]'
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return result;
}

function markdown(report) {
  const rows = report.results.map(result => {
    const score = result.score;
    return (
      `| ${result.corpus} | ${result.taskId} | ${result.byteBudget} | ` +
      `${result.condition} | ${score.visibleRequiredFiles.length}/${score.requiredFiles} | ` +
      `${score.visibleRequiredEvidence.length}/${score.requiredEvidence} | ` +
      `${score.failedQueries} | ${score.honestyViolations.length} |`
    );
  });
  return [
    '# Visible search evidence',
    '',
    `Corpus: ${report.corpus.revision}`,
    '',
    `Manifest SHA-256: ${report.manifestSha256}`,
    '',
    'These are retrieval results. Expected answer facts are frozen gold evidence; ' +
      'model answer correctness was not evaluated by this run.',
    '',
    'Budgets count visible UTF-8 bytes for each fixed query. Files and evidence ' +
      'are scored only within those bytes. No cross-task aggregate is computed.',
    '',
    '| Corpus | Task | Bytes/query | Condition | Required files visible | ' +
      'Required evidence visible | Query failures | Honesty violations |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    'Detailed missing evidence, raw output, exact commands, oracle counts, ' +
      'and reported continuation fields are in results.json. Identical model ' +
      'instructions and condition-specific visible search results are in packets/.',
    '',
    'The native-raw-rg condition is a deterministic unranked reference. ' +
      'A before/after claim about Claude Grep requires adapters that execute ' +
      'the actual unpatched and patched native tool handlers and retain their ' +
      'actual visible formatting.',
    '',
  ].join('\n');
}

const args = options(process.argv.slice(2));
const suite = readSuite();
const tasks = suite.tasks.filter(
  task => args.only.length === 0 || args.only.includes(task.id)
);
for (const id of args.only) {
  if (!tasks.some(task => task.id === id))
    throw new Error(`Unknown task: ${id}`);
}
const corpusDir = materializeCorpus(
  args.repository ?? resolve(directory, '../..'),
  suite
);
try {
  if (args.verify) {
    console.log(
      JSON.stringify(
        {
          verified: true,
          revision: suite.integrity.revision,
          publicTasks: suite.manifest.tasks.length,
          syntheticTasks: suite.tasks.length - suite.manifest.tasks.length,
          corpusDir: args.keepCorpus ? corpusDir : null,
        },
        null,
        2
      )
    );
  } else {
    const outputDir = writeDirectory(
      args.out ?? mkdtempSync(join(tmpdir(), 'navigation-eval-'))
    );
    const adapters = args.adapters.map(path => {
      const bytes = readFileSync(path);
      const adapter = JSON.parse(bytes);
      if (
        typeof adapter.name !== 'string' ||
        !/^[a-z0-9][a-z0-9-]*$/.test(adapter.name)
      ) {
        throw new Error(`Adapter needs a stable kebab-case name: ${path}`);
      }
      return { ...adapter, configSha256: sha256(bytes) };
    });
    const names = ['native-raw-rg', ...adapters.map(adapter => adapter.name)];
    if (new Set(names).size !== names.length)
      throw new Error('Duplicate condition names');
    const report = {
      schemaVersion: 1,
      corpus: suite.manifest.corpus,
      manifestSha256: suite.integrity.manifestSha256,
      syntheticSha256: suite.integrity.syntheticSha256,
      instructionsSha256: sha256(suite.manifest.policy.instructions),
      node: process.version,
      ripgrep: runProcess('rg', ['--version']).stdout.trim(),
      adapters,
      modelAnswersEvaluated: false,
      results: [],
    };
    for (const task of tasks) {
      const oracles = task.queries.map(query => nativeOracle(corpusDir, query));
      const raw = task.queries.map(query => nativeRaw(corpusDir, query));
      for (const byteBudget of suite.manifest.policy.byteBudgets) {
        for (const condition of names) {
          const adapter = adapters.find(item => item.name === condition);
          const runs = adapter
            ? task.queries.map(query =>
                runAdapter(adapter, corpusDir, query, byteBudget)
              )
            : raw;
          const queries = runs.map((run, index) => ({
            query: task.queries[index],
            command: run.command,
            stderr: run.stderr,
            ...scoreQuery(run, oracles[index], byteBudget, corpusDir),
          }));
          const score = scoreTask(task, queries);
          report.results.push({
            taskId: task.id,
            corpus: task.corpus,
            byteBudget,
            condition,
            score,
            queries,
          });
          const packet = {
            schemaVersion: 1,
            taskId: task.id,
            byteBudget,
            instructions: suite.manifest.policy.instructions,
            question: task.question,
            results: queries.map(query => ({
              query: query.query,
              exitCode: query.exitCode,
              output: query.output,
            })),
          };
          const packetDir = writeDirectory(
            join(outputDir, 'packets', task.id, String(byteBudget))
          );
          writeFileSync(
            join(packetDir, `${condition}.json`),
            JSON.stringify(packet, null, 2) + '\n'
          );
        }
      }
    }
    writeFileSync(
      join(outputDir, 'results.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
    writeFileSync(join(outputDir, 'report.md'), markdown(report));
    console.log(
      JSON.stringify(
        {
          outputDir,
          comparisons: report.results.length,
          corpusDir: args.keepCorpus ? corpusDir : null,
          queryFailures: report.results.reduce(
            (sum, item) => sum + item.score.failedQueries,
            0
          ),
          honestyViolations: report.results.reduce(
            (sum, item) => sum + item.score.honestyViolations.length,
            0
          ),
        },
        null,
        2
      )
    );
    if (
      report.results.some(
        item => item.score.failedQueries || item.score.honestyViolations.length
      )
    ) {
      process.exitCode = 1;
    }
  }
} finally {
  if (!args.keepCorpus) rmSync(corpusDir, { recursive: true, force: true });
}
