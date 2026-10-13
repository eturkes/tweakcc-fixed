# Native handler pair for Claude Code 2.1.296

The interleaving candidate was rejected. Production retains native Grep
ordering, with no interleaving runtime or toggle. The standalone candidate in
`candidates/` exists only to reproduce this evaluation. It is not imported by
the application or shipped in `dist`.

This adapter executes the Grep handler and result mapper extracted from two
local Claude Code sources. The candidate must differ only inside the actual
`Foo` handler. It uses the frozen questions, corpus, evidence, scoring, and byte
budgets described in [README.md](README.md).

The extractor is specific to the inspected 2.1.296 build. It requires the
module markers produced by tweakcc's native extraction, including module 415,
`/$bunfs/root/chunk-sfn1dbxq.js`. Names are resolved inside their module because
the bundle reuses minified identifiers. Acorn identifies complete function and
method boundaries. The adapter uses the repository's existing `acorn` and
`which` dependencies.

Generate the rejected candidate from a local pristine extraction into a new
file. The input is never modified and an existing output is refused:

```sh
timeout 30 node tools/navigation-eval/candidates/generate-native-interleaving.mjs \
  --pristine /tmp/cli-2.1.296.js \
  --out /tmp/navigation-eval-rejected-candidate.js
```

If the previously evaluated source is available locally, add
`--reference /tmp/fff-native-format-after.js`. Generation then verifies that
the actual generated and evaluated `Foo` handlers have identical Acorn ASTs
after removing source locations and literal spelling. The preserved algorithm
and match anchors are unchanged; the standalone helper has different whitespace
from the previously minified helper. The command records source and handler
hashes and whether the handler bytes match exactly. It rejects any change
outside the actual handler.

Prepare the two conditions from the local pristine and generated sources:

```sh
node tools/navigation-eval/prepare-native-pair.mjs \
  --pristine /tmp/cli-2.1.296.js \
  --candidate /tmp/navigation-eval-rejected-candidate.js \
  --out /tmp/navigation-eval-native-pair

node tools/navigation-eval/validate-native-pair.mjs \
  --before /tmp/navigation-eval-native-pair/native-grep-before.json \
  --after /tmp/navigation-eval-native-pair/native-grep-after.json \
  --out /tmp/navigation-eval-native-pair

node tools/navigation-eval/run.mjs \
  --adapter /tmp/navigation-eval-native-pair/native-grep-before.json \
  --adapter /tmp/navigation-eval-native-pair/native-grep-after.json \
  --out /tmp/navigation-eval-native-pair/results

pnpm exec vitest run tools/navigation-eval/native-handler.test.mjs
pnpm exec vitest run tools/navigation-eval/candidates/native-search-interleaving.test.mjs
```

`--ripgrep /absolute/path/to/rg` optionally selects the native executable during
preparation. Preparation records its real path, version, and binary SHA-256.
Each adapter invocation checks that binary and the complete source SHA-256.
Pair metadata also records the Node version, module hash, actual handler hash,
each extracted component hash, adapter dependency hashes, and shared cache
location. Regenerate the configs after changing adapter code.

The source bundles stay in the supplied local paths. They are never copied into
the repository or included in reports. The corpus and captured search text
contain only the pinned public repository and generated fixtures. The
preparation script does not patch a bundle, install software, or change Claude
settings.

## Executed source and supplied environment

The runtime evaluates these exact extracted components:

| Component                                | Role                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `Foo`                                    | Native argument construction, result handling, pagination, and presentation |
| `Hoo`, `Uoo`                             | Native ripgrep JSON parsing and content line handling                       |
| `$oo`, `yMt`                             | Native path rewriting and relative path display                             |
| `$Fe`, `BFe`                             | Native pagination and visible pagination message                            |
| `EI.mapToolResultToToolResultBlockParam` | Native model-visible result text                                            |
| `Mmr`, `I`                               | Native NUL output parsing and plural text helper                            |
| `voo`, `xoo`                             | Native VCS exclusions and default 250-line limit                            |

The candidate runs its patched `Foo` function in this same runtime. The
adapter does not import or call a replacement ranking helper. Pair preparation
proves that replacing the pristine `Foo` span with the candidate span recreates
the complete candidate source, and that the other extracted components agree.

The following environment is supplied explicitly:

- `se()` returns the real public corpus root; `A` is Node's `path.relative`;
  `LL` is the platform separator; `Fo` is `JSON.parse`; `ie().stat` is Node's
  actual asynchronous file stat.
- The descriptor uses a checked lexical and canonical path inside the corpus,
  the actual directory status, and the corpus as `spawnCwd`. Its pre-spawn
  callback checks that the target still resolves to the same canonical path.
- `yRt` returns an empty permission-denial set; `RHn`, `kae`, and `Wlo` return
  no extra exclusions; `Imr` and `xYt` are false. `xmr` records the permission
  recheck call without evaluating the application permission rules.
- `Sre` executes native ripgrep with the handler-produced arguments and target,
  using the supplied `beforeSpawn` callback. It validates the expected raw-line
  transport options and returns the captured stdout split into lines, as the
  inspected native transport does. Every handler invocation must exercise one
  search, one path recheck, and one permission recheck, including cache hits.

This exercises the ordinary public directory and file paths. The application
permission engine, denial filtering, application-specific exclusions, special
file-descriptor paths, sandbox, hooks, and surrounding tool lifecycle are
stubbed or unexercised. The harness is not a full native runtime or permission
audit.

The native application transport and executable resolver are also substituted:
the adapter directly invokes the selected native `rg` instead of `ZB` and its
resolver-provided prefix arguments. It clears `RIPGREP_CONFIG_PATH`, permits
exit codes 0 and 1, uses a 20-second timeout and a 64 MiB output cap, and turns
other outcomes into explicit failures. It does not reproduce the native
transport's buffering, retry, cancellation, or error behavior. A full binary
smoke test is a separate check.

## Shared ordering and visible bytes

The first request for each exact argument vector, working directory, target,
and ripgrep binary hash captures stdout, stderr, and exit status once. Both
conditions reuse that capture without reordering it. Cache entries retain their
identity and byte checksum; corrupted entries fail. An exclusive lock and
atomic rename prevent two overlapping requests from capturing different
orders. No sort or thread-count arguments are inserted.

Native ripgrep ordering is not guaranteed across fresh captures. The paired
comparison controls that order within one run. Repeated fresh runs can produce
different bounded results and do not establish an effect size by themselves.
The frozen `native-raw-rg` reference still uses its own deterministic path
sorting; compare the two actual-handler conditions for the native patch's
effect.

The adapter returns only the actual mapper's content string and transport exit
code. It adds no excerpts, counts, completeness claims, continuation fields, or
gold facts. Native pagination messages remain in that content. Omitting an
optional metadata field means unreported, so zero honesty violations does not
prove a completeness claim.

The ordinary handler limit remains 250 lines. The evaluator applies the same
2,048- or 8,192-byte UTF-8 cap to each condition's actual visible text. This can
clip a line or the native pagination message. The byte cap is an experimental
observation budget imposed by the evaluator, not a new parameter in Claude's
native Grep API. Model packets contain only the bounded visible text and the
same question, queries, and instructions.

## Validation and interpretation

`validate-native-pair.mjs` materializes a fresh frozen corpus and checks every
frozen query. It compares unlimited native results against independently
decoded ripgrep source records, checks identical raw captures between the two
conditions, and verifies preservation of the complete result multiset. It
traverses pages in each condition's own order, checks native line totals and
pagination messages, and tests zero limits, omitted limits, offsets, and empty
tails.

Additional generated cases exercise context, multiline matches, only-matching
output, single-file scope, long lines, colon-digit filenames, count mode, and
files-with-matches mode. Guarded modes must remain unchanged. The JSON report
records 42 query and mode checks for the current frozen suite. The Vitest tests
cover module boundaries, shared captures, cache identities and corruption,
pre-spawn rechecks, and native regex errors without requiring a local Claude
bundle.

The retrieval report lists each task separately, including regressions and
unchanged results. Required-file visibility and exact evidence visibility are
different outcomes. Neither establishes that a model answered the question
correctly. Model answers require the separate, identically configured trials
and fact-by-fact grading described in the main README. Do not tune the frozen
questions after inspecting either condition.
