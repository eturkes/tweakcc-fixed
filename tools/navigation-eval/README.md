# Native Grep evidence evaluation

This suite measures the source evidence visible within a fixed result budget.
It was frozen before the native Claude Grep presentation change. Ten public,
multi-file investigations use `skrabe/tweakcc-fixed` at
`85ae46fe322de92aa909dadc28847556a6d53a63`; five synthetic cases probe known
failure modes. It contains no private session transcripts or installed settings.

Install the repository dependencies, then run it with Node 22 or newer, Git,
tar, and native ripgrep on `PATH`:

```sh
pnpm exec vitest run tools/navigation-eval/core.test.mjs
node tools/navigation-eval/run.mjs --verify
node tools/navigation-eval/run.mjs --out /tmp/navigation-eval-baseline
```

The runner creates a temporary corpus with `git archive`, using the pinned
commit's complete `src/` tree and `.gitignore`. These are the complete public
query scopes in the manifest. Synthetic files are generated under `cases/` in
that temporary corpus. Changes to the working tree cannot change the searched
source. The corpus is deleted after the run unless `--keep-corpus` is supplied.
The output directory contains `results.json`, `report.md`, and model input
packets. No model calls are made.

`manifest.json` freezes each question, query, scope, required source location,
expected answer fact, result budget, and common answer instruction. The
integrity lock checks its SHA-256, all 24 evidence-bearing public source files,
and the complete generated synthetic data and tasks. Intentional revisions to
the task set need a new named manifest and an explanation; changing gold
evidence after seeing candidate results invalidates that comparison.

The questions were selected by reading ten different repository behaviors:
release-pinned downloads, configuration precedence, settings merging, patch
filter validation, native bytecode, theme bindings, bundle regions, preflight,
backup integrity, and remote body limits. This is a manually selected suite
from one public repository, not a representative or blinded quality estimate.
The synthetic cases are reported separately: complete caller enumeration,
production code among misleading declarations, a match-dense first file,
no shared query text, and Unicode byte accounting.

## Conditions and adapters

`native-raw-rg` executes plain ripgrep, with deterministic path sorting and no
ranking. It is a transparent retrieval reference. It is not a substitute for
testing Claude's actual native Grep handler. A claim about that handler needs
both unpatched and patched handler adapters, extracted from the same Claude
Code build and using the same native ripgrep binary.

An adapter config is a JSON file with a name and executable argument vector:

```json
{
  "name": "native-grep-before",
  "command": ["node", "/absolute/path/to/native-handler-adapter.mjs"],
  "metadata": {
    "claudeVersion": "record-the-exact-build",
    "binarySha256": "record-the-exact-binary-hash",
    "handlerSha256": "record-the-extracted-handler-hash",
    "condition": "unpatched"
  }
}
```

The adapter receives this JSON on stdin and runs with the corpus as its working
directory:

```json
{
  "schemaVersion": 1,
  "corpusDir": "/tmp/navigation-eval-corpus-EXAMPLE",
  "query": {
    "pattern": "clearBytecode",
    "path": "src",
    "context": 0
  },
  "byteBudget": 2048,
  "offset": 0
}
```

It returns one JSON record on stdout:

```json
{
  "output": "src/example.ts:12:clearBytecode\n",
  "exitCode": 0,
  "totalFiles": 1,
  "totalMatches": 1,
  "totalMatchedLines": 1,
  "complete": true,
  "nextOffset": null
}
```

Only `output` and `exitCode` are required. `output` must contain the handler's
actual visible result text, including its own warnings and formatting. The
adapter must not add source excerpts, rerank output, read the answer key, or
implement a substitute search algorithm. If a handler does not report a count
or continuation field, omit that field. Do not fill it from the evaluator's
oracle. Transport failures must fail the adapter process; a failed tool call
must have `exitCode: 2`, optionally with an `error` string.

```sh
node tools/navigation-eval/run.mjs \
  --adapter /tmp/native-grep-before.json \
  --adapter /tmp/native-grep-after.json \
  --out /tmp/navigation-eval-native-pair
```

Adapter names and configuration hashes are retained in the report. Metadata is
recorded, not independently attested: the harness that extracts the native
handler must prove which bytes and handler it executes. Absolute executable
and script paths avoid ambiguity after the runner changes its working
directory. No shell string is evaluated.

## What receives credit

Every condition receives exactly the same fixed regex, scope, context request,
and UTF-8 byte budget. The evaluator clips each result at the same byte limit
without splitting a Unicode scalar. Only those visible bytes receive credit.
The two frozen budgets are 2,048 and 8,192 bytes per query; tasks with two fixed
queries get two equally bounded results in every condition. Query and system
instruction text is identical across conditions and excluded from the result
budget. No elapsed-time or speed score is computed.

Required-file coverage means the required path appeared as a source location
or standalone filename. Required-evidence coverage additionally requires the
correct path, 1-based source line, and exact frozen snippet. Merely naming a
file, printing the same snippet on a different line, or placing the snippet
after the byte boundary earns no evidence credit. A failed command receives
no coverage credit even if its partial stdout contains a relevant line.

The parser accepts native `path:line:text` match lines and `path-line-text`
context lines, including absolute paths inside the corpus. An adapter using
another native rendering needs a parser extension that extracts only locations
already visible in that rendering. Do not rewrite its text into a more
informative representation merely to satisfy the scorer.

Numeric colon or dash sequences can occur in both filenames and source text.
The parser checks every possible boundary against regular files in the frozen
corpus. It accepts a unique interpretation and gives ambiguous rows no credit.
Without a corpus path, it accepts only a single syntactic interpretation.

An independent full native `rg --json` search supplies count truth.
`totalMatches` means regex submatches, while `totalMatchedLines` means match
records; these differ when a line matches twice. Any supplied count is checked.
`complete: true` claims that every matching source line is visible and is
rejected when lines are missing or clipped. A continuation must advance; an
empty search or a complete result cannot also claim a continuation. Missing
metadata remains unreported, rather than being treated as an honest claim.
The first-stage runner scores the initial result only. It does not establish
that a continuation actually retrieves all omitted matches.

Each task/budget/condition has its own row. Missing paths and evidence IDs,
query failures, truncation, exact commands, and count/completeness violations
remain inspectable in `results.json`. There is no overall winner score.

## Answer evaluation

Retrieval coverage is an intermediate measure. The runner reports
`modelAnswersEvaluated: false`; finding a path does not prove a correct answer.
Some frozen snippets require a source read beyond the fixed grep matches, and
the no-shared-text case deliberately cannot supply its implementation through
the chosen query. These ceilings remain part of the benchmark.

Files in `packets/` contain the question, the identical common instruction,
fixed queries, tool exit codes, and only each condition's bounded visible
results. They contain no gold facts, required-file list, or oracle counts.
Use the same model binary, model, effort, system instructions, tool permissions,
sampling settings, and fresh context for both conditions. Randomize condition
order and retain complete run metadata. If adding subsequent source reads or
LSP calls, give both conditions the same access and budgets, and record the
actual visible results; these packets alone do not execute that workflow.

Grade answers against every `expectedAnswerFacts` entry, checking cited source
locations against the pinned corpus. Record omitted constraints, unsupported
confident claims, and incorrect statements separately. Have the same grading
procedure inspect anonymized outputs from both conditions. Correctly reporting
insufficient evidence in the no-shared-text case is preferable to inventing the
policy. Report actual answer correctness separately from retrieval coverage.
