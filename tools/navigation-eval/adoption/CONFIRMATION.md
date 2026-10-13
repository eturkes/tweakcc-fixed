# Native instruction integration confirmation

The candidate invoked `fff files` in both sampled sessions; the
baseline invoked it in neither. Both candidate sessions received ranked paths and
then inspected returned candidates. All four answers got the requested facts
right. Extra claims and fixture gaps are assessed separately below.

These are two single-run pairs on small synthetic projects, with approximate
proration at low effort and the unhelpful Pause filename cue at medium effort.
They do not establish a general adoption rate, accuracy improvement, cost saving
or speed improvement. `confirmation.v1.json` contains the answers, calls, complete
tool results, source evidence, fact checks and immutable raw hashes.

| Task / effort                | Condition | fff calls | Returned / later inspected paths | Requested facts | Reported USD |
| ---------------------------- | --------- | --------: | -------------------------------- | --------------- | -----------: |
| Approximate proration / low  | Baseline  |         0 | —                                | Pass            |    0.2573484 |
| Approximate proration / low  | Candidate |         1 | 3 / 1                            | Pass            |    0.2578476 |
| Unhelpful Pause cue / medium | Candidate |         1 | 3 / 3                            | Pass            |    0.0801086 |
| Unhelpful Pause cue / medium | Baseline  |         0 | —                                | Pass            |    0.0663112 |

The four sessions made 15 main-model requests, spawned no subagents, and reported
USD 0.6616158. Including the initial eight exploratory sessions, the reported
total is USD 1.1166676. These are native list-price estimates. Every session
completed successfully, all fixture contents stayed unchanged, and there were no
outcome retries. Timing is stored separately without a comparison claim.

## What the agent actually did

For proration, the candidate's first Bash command invoked
`fff files 'billing proration policy'` and also ran content grep. FFF returned
`ProrationPolicy.ts`, `AllocationPolicy.ts` and `CancelSubscription.ts`. Its next
command read the real policy and the invoice handler. The observed inspection is
clear; the combined FFF/grep command leaves the causal source of the policy choice
ambiguous. The baseline searched content and read the same implementation.

For Pause, FFF returned `docs/pause.md`, `src/old/pause.ts` and
`src/ui/PauseButton.ts`. The candidate read all three, then read the active
`holdJob` and `transition` files and ran a final content Grep. The returned names
did not directly identify the active backend files. Candidate inspection and
subsequent source verification kept the obsolete implementation distinct from the
current ownership/revision checks. The baseline used content search and `find`,
then read those active files too.

Both Pause sessions attempted `git ls-files` and received Apple Git/xcrun cache
permission warnings from the temp containment boundary. The full warnings remain
in the tool results. Both recovered with `find` and source reads; these warnings
are separate from FFF success and terminal session status.

## Facts, extra claims and evidence

Both proration answers correctly identify the invoice import, calculate
`ceil(999 × 7 / 30) = 234`, explain `Math.ceil`, and identify the zero-period
`INVALID_PERIOD` error. Both also claim the charge can never exceed the monthly
amount. That claim needs an integer-price constraint the number-typed fixture
does not enforce: a full period with `monthlyCents = 999.5` returns 1000.

Both Pause answers correctly explain owner-first, revision-second checks and
return `{ ok: false, reason: 'STALE_REVISION' }` without `repository.put` for owner
`worker-b`, stored revision 8 and expected revision 7. Both distinguish the
obsolete unchecked implementation. The fixture has a UI action string and
documentation naming `holdJob`, but no router registration. The candidate says
this explicitly. The baseline describes that UI action as an active sending edge
without acknowledging the missing runtime wiring.

Filename listings receive no code-behavior evidence credit. Source evidence comes
from explicit viewers or path-attributed content output. The baseline proration
viewer used `ProrationPolicy*`; the frozen literal-operand evaluator did not
resolve that glob. A separate manual supplement resolves its sole fixture match
and verifies the printed informative source lines. The original evaluator output
and raw traces remain unchanged.

## Frozen protocol and subsequent corrections

Both conditions used the same corrected Rust wrapper. The baseline binary used
committed instruction placement and description additions; the candidate used
the compiled final-API and automatic-instruction render hooks, retained native
tool descriptions and received no CLI appendix. Main model, effort, corpus,
budgets, fresh state and native default tools matched within each pair. The frozen
task questions name no search tools. The OAuth catalog contained 22 native tools,
including Agent and RemoteTrigger.

The first attempted launch was blocked by an exact catalog guard before any
forwarding: the synthetic-auth probe exposed 21 tools, while OAuth exposed the
additional RemoteTrigger tool. All four zero-paid attempts remain distinct in
`guard-failure.v1.json`. An authorized local OAuth-matching probe corrected the
protocol; its report hash is
`787ad8c932a4ab7509d47c02136226f10d33130db59ae425fe97e6d0ef5c254b`.
`capability.v1.json` records the matching main catalogs, native Explore inheritance
and child Read provenance. Those forced local mock capabilities are not paid
adoption outcomes.

After the model trials, one additional exact single-newline legacy Bash suffix
was added to cleanup compatibility coverage. The tested candidate binary
predates that string matcher. Guidance, automatic rendering and runtime helper
code did not change. The fresh trial sessions reused no recorded prompts, and
the candidate's API descriptions contained no owned guide suffixes. This legacy
compatibility addition does not change those observed fresh inputs; the model
outcomes were not repeated.

The published proxy was also hardened after the trials to pin forwarding to
`https://api.anthropic.com/v1/messages` and reject absolute, protocol-relative and
off-origin request targets. Fifteen local guard cases pass with zero forwarding
for the negative targets. The frozen trial proxy predates that security change;
normal native relative message traffic keeps the same destination and bytes.
The raw trial source hashes and snapshots are retained, and the paid outcomes
were not repeated.
