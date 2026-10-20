# Native fff navigation adoption

This suite compares how an actual native Claude Code agent navigates a frozen
synthetic project. It records model requests, tool calls, visible source evidence,
answer facts, errors, and reported cost. Filename suggestions alone receive no
code-evidence credit. Timing is retained separately without a speed claim.

The four tasks and the exploratory appendix were frozen before model calls.
`integrity.v1.json` records their hashes. Neither the expected facts nor the
required-file lists are sent to the model. Each session receives only its task
question and synthetic project files.

## Protocols

The initial eight sessions used one feature-enabled native 2.1.296 binary,
explicit `Bash,Glob,Grep,Read` selection, and a CLI appendix for the guidance
condition. That explicit tool selection changes native search mode and suppresses
the model's default Bash-first selection. Its results are exploratory evidence
about the appendix, not confirmation of production behavior. See
`EXPLORATORY.md` and `exploratory.v1.json`.

The completed native-default-tool confirmation is in `CONFIRMATION.md` and
`confirmation.v1.json`. The candidate invoked `fff files` in 2/2 sampled sessions,
the baseline in 0/2, and all four got the requested facts right. Extra claims,
fixture gaps, warnings and protocol corrections are recorded separately.

The confirmation runner uses two independently prepared native binaries and
leaves tool selection at native defaults. The baseline uses the committed
instruction placement and description additions; the candidate integrates
guidance into the final API and automatic-instruction rendering hooks while
retaining native and custom tool descriptions. A separate hygiene pass removes
only exact owned suffixes from legacy recorded descriptions. Both use the same
corrected Rust wrapper bytes. The candidate
receives no CLI appendix. This comparison isolates
instruction integration; it does not compare old and corrected filename parsers.

The confirmation subset is approximate-proration at low effort and the
unhelpful-filename cue at medium effort, with one fresh session per condition per
task. Pair order is seeded and balanced. The task content is identical to the
initial frozen suite.

## Native recording, disable and resume

`lifecycle.check.mjs` tests saved-session behavior independently of model
adoption. It captures an old baseline session, resumes that same session with
the feature-disabled binary, and records a fresh enabled session. Its local
endpoint uses a synthetic API key and fixed `end_turn` responses. It reads no
account credentials and forwards no requests.

```sh
node tools/navigation-eval/adoption/lifecycle.check.mjs \
  --baseline-binary /tmp/baseline/claude \
  --candidate-binary /tmp/candidate/claude \
  --disabled-binary /tmp/disabled/claude \
  --wrapper /tmp/baseline/fff/rg-fff \
  --wrapper /tmp/candidate/fff/rg-fff \
  --contain-home --out /tmp/adoption-lifecycle
```

Supply every embedded wrapper path; `--out` must be a fresh system-temp path.
Unlike the adoption protocol, this check enables native prompt recording and
session persistence in its isolated configuration. It compares original
transcript bytes and snapshot rows after resume, selected tool descriptions,
native tool filtering, and input schema hashes.

The 2.1.296 proof in `lifecycle.v1.json` records three successful local requests
and zero paid requests. Disabled resume removed active owned guidance, retained
the original two snapshot rows byte for byte, and removed only Grep/Glob from
the native tool catalog. A fresh enabled request sent the system appendix while
its two stored snapshots contained no owned appendix or tool-description block.
Source binaries, wrappers, and existing instruction files stayed unchanged.

## Prepare and inspect

Use Node 22 or newer, Python 3, Git, and macOS `sandbox-exec`. The runner makes
temporary copies of explicitly supplied binaries and records their hashes.
Supply every wrapper path embedded in those binaries. Their hashes must match.
It does not patch the installed binary or use installed tweakcc settings.

```sh
node tools/navigation-eval/adoption/evidence.check.mjs
node tools/navigation-eval/adoption/proxy.check.mjs
node tools/navigation-eval/adoption/run.mjs plan \
  --baseline-binary /tmp/baseline/claude \
  --candidate-binary /tmp/candidate/claude \
  --wrapper /tmp/baseline/fff/rg-fff \
  --wrapper /tmp/candidate/fff/rg-fff \
  --contain-home
```

The `plan` command does not read credentials or make model calls. `probe` starts
a local mock endpoint and separately verifies the native `fff files` function and
an Agent/Explore branch. It records actual default and child tool catalogs, checks
main and inherited child model/effort/output controls, and links child Read
evidence to its parent Agent call. Only the candidate sends the integrated system
guidance; its Grep and Bash descriptions have no owned guidance additions. The
proxy never forwards probe requests. These capability checks use synthetic mock
responses and are separate from adoption outcomes. Use `--probe-account-auth` to
match the live OAuth catalog: OAuth exposes a native RemoteTrigger tool that is
absent under synthetic API-key authentication. The default synthetic-auth probe
is useful without account access but does not authorize live OAuth sessions.

The first confirmation launch used a synthetic-auth catalog and hit the exact
catalog guard because OAuth added RemoteTrigger. All four attempts were blocked
before forwarding, cost zero, and produced no model outcomes. Their raw records
remain intact, and `guard-failure.v1.json` preserves the failure and its hashes.
The account-auth local probe corrected this protocol issue without changing tasks,
gold facts, guidance, models, efforts, budgets or native tool selection.

```sh
node tools/navigation-eval/adoption/run.mjs probe \
  --baseline-binary /tmp/baseline/claude \
  --candidate-binary /tmp/candidate/claude \
  --wrapper /tmp/baseline/fff/rg-fff \
  --wrapper /tmp/candidate/fff/rg-fff \
  --contain-home --probe-account-auth --out /tmp/adoption-probe
```

## Authorized live sessions

Live mode requires an explicit switch and a successful probe for the same binary,
wrapper, model, task, and output-token hashes. Authentication is read from the
existing macOS account keychain in the parent process. Access and refresh tokens
are neither printed nor written. The child receives an inference-only access
token; the runner does not refresh credentials.

```sh
node tools/navigation-eval/adoption/run.mjs run \
  --baseline-binary /tmp/baseline/claude \
  --candidate-binary /tmp/candidate/claude \
  --wrapper /tmp/baseline/fff/rg-fff \
  --wrapper /tmp/candidate/fff/rg-fff \
  --contain-home --allow-live \
  --probe-report /tmp/adoption-probe/report.json \
  --per-run-usd 1.10 --total-usd 4 \
  --previous-spend-usd 0.4550518 \
  --max-runs 4 --max-api-requests 48 --max-turns 12 \
  --timeout-seconds 150 --output-tokens 4096 \
  --out /tmp/adoption-confirmation
```

The total gate reserves one full per-session budget before starting another
session. Unknown cost halts further sessions. USD figures are Claude Code's
reported estimates. Every main request must use the specified model and effort.
The first catalog must match the recorded default-tool probe. Native subagent and
auxiliary requests remain available with their normal model and effort choices;
they are recorded separately and use verified native model aliases. Every request
class shares the output limit, request cap, process timeguard and native session
budget. Native `total_cost_usd` includes subagent requests. The proxy records no
authorization headers. There are no automatic outcome retries.

`native-contract.v1.json` freezes the inspected 2.1.296 model aliases and request
classes. The supported `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` flag adds native scope
headers in both conditions without changing model prompts or tool catalogs. Only
request class, agent type and hashes of native agent identifiers are retained.
`parent_tool_use_id` and agent identifiers from native stream events link source
evidence to delegated work. The live runner requires the same protocol source
hashes as its successful probe and stores an exact source snapshot with results.

## Isolation and evidence

`--contain-home` is required for native execution. The native process and its
children cannot read personal home data or write there. Explicit wrapper
directories are narrow read exceptions. The runner preserves `HOME`; it does not
replace it. The child can contact only the local proxy, and cannot read the frozen
gold file or other session records. The runner uses fresh `CLAUDE_CONFIG_DIR`,
`TWEAKCC_CONFIG_DIR`, fff state, caches, and synthetic cwd for every session.

Canonical system temp roots (`/private/tmp` and the canonical `os.tmpdir()`) are
also denied for data reads and writes. The current trial root, copied binary
files, and explicit wrapper directories are the only temp exceptions. A canary
check verifies blocked prior-temp reads and writes and current-trial access
before each native session. Directory metadata listing remains available.

Custom instructions, settings sources, installed plugins, connectors, telemetry, history,
auto-memory, background tasks, updates, and transcript writes are disabled.
`--system-prompt-snapshot off` prevents saved prompt reuse in this protocol.
Possible prompt-persistence files are reported; resumed-session behavior requires
a separate test. These controls use the documented
[Claude Code CLI configuration switches](https://code.claude.com/docs/en/cli-reference)
and the inspected 2.1.296 native implementation.

Native built-in plugins remain available: the observed OAuth default catalog
includes Agent and 21 other tools, and the native init reports its built-in agents-md and
plugin-authoring plugins. No private plugin or MCP configuration is loaded.

`tool-evidence.json` preserves calls and results. Source locations come from
path-attributed Grep/Read output or source rows matched against explicit Bash
viewer operands. Closing braces and shared ambiguous lines receive no credit.
The Bash evaluator uses Python's maintained `shlex` tokenizer; it supports
literal cat/head/tail/sed/nl operands and simple for-loop file lists, and does not
claim to understand arbitrary shell expansion. Unrecognized reads remain visible
for manual review. Final facts and unsupported extra claims are graded separately
from retrieval evidence and from fff adoption.

Published traces normalize canonical and alias fixture/trial paths longest-first
to `$FIXTURE` and `$TRIAL`; system temp warnings use `$SYSTEM_TEMP`. Raw artifacts
and their hashes retain the exact original paths and bytes.

The published proxy includes a posttrial origin-pinning correction and negative
guard checks. The paid runtime snapshots predate that hardening; normal native
relative message requests keep identical forwarding behavior. `CONFIRMATION.md`
discloses this and the later narrow legacy-suffix compatibility addition. No
paid outcomes were repeated for either correction.
