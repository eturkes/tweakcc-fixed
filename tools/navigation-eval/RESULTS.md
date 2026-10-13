# Decision: retain native Grep ordering

The interleaving candidate is rejected. The installed integration keeps native
Grep ordering and exposes native Grep/Glob alongside fff filename discovery.
Interleaving remains an evaluation-only candidate under `candidates/`; it is
not imported by the patcher or exposed as a setting.

## Controlled retrieval comparison

The questions and gold evidence were frozen before implementation at corpus
commit `85ae46fe322de92aa909dadc28847556a6d53a63`. Manifest SHA-256:
`058a4424180cbc36b293fa6714dc3070b53cd58bc26f706e83070670fd97b719`.
The run used Claude Code 2.1.296's actual Grep handler and result mapper,
Node 22.11.0, and ripgrep 15.2.0. Both native conditions consumed the same
unsorted raw search capture, query, and byte budget. Permission and transport
stubs and reproduction instructions are documented in
[NATIVE-HANDLER.md](NATIVE-HANDLER.md).

Each cell reports native ordering → interleaving. Files mean required source
paths visible; evidence means exact required source lines visible. The budgets
are visible UTF-8 bytes per query, imposed by the evaluator, not a new native
Grep parameter. Public and synthetic tasks are listed separately. No speed or
model answer-quality score is inferred from these counts.

### Public repository

| Task                       | Files, 2,048 B | Evidence, 2,048 B | Files, 8,192 B | Evidence, 8,192 B |
| -------------------------- | -------------- | ----------------- | -------------- | ----------------- |
| release-prompt-source      | 3/3 → 3/3      | 5/5 → 5/5         | 3/3 → 3/3      | 5/5 → 5/5         |
| config-location-precedence | 2/3 → 3/3      | 3/5 → 2/5         | 3/3 → 3/3      | 4/5 → 4/5         |
| default-merge-semantics    | 3/3 → 3/3      | 4/5 → 4/5         | 3/3 → 3/3      | 4/5 → 4/5         |
| patch-filter-validation    | 3/3 → 3/3      | 2/5 → 1/5         | 3/3 → 3/3      | 3/5 → 3/5         |
| native-bytecode-roundtrip  | 2/3 → 3/3      | 3/4 → 3/4         | 3/3 → 3/3      | 4/4 → 4/4         |
| theme-binding-regression   | 2/2 → 2/2      | 3/4 → 3/4         | 2/2 → 2/2      | 3/4 → 3/4         |
| virtual-bundle-regions     | 3/3 → 3/3      | 3/4 → 3/4         | 3/3 → 3/3      | 3/4 → 3/4         |
| preflight-apply-policy     | 3/3 → 3/3      | 2/4 → 2/4         | 3/3 → 3/3      | 2/4 → 2/4         |
| backup-pristine-guard      | 2/2 → 2/2      | 5/5 → 5/5         | 2/2 → 2/2      | 5/5 → 5/5         |
| remote-response-caps       | 4/4 → 4/4      | 5/5 → 5/5         | 4/4 → 4/4      | 5/5 → 5/5         |

### Synthetic cases

| Task                             | Files, 2,048 B | Evidence, 2,048 B | Files, 8,192 B | Evidence, 8,192 B |
| -------------------------------- | -------------- | ----------------- | -------------- | ----------------- |
| synthetic-all-callers            | 12/12 → 12/12  | 12/12 → 12/12     | 12/12 → 12/12  | 12/12 → 12/12     |
| synthetic-production-distractors | 2/2 → 2/2      | 2/2 → 1/2         | 2/2 → 2/2      | 2/2 → 2/2         |
| synthetic-dense-first-file       | 1/3 → 3/3      | 1/3 → 3/3         | 1/3 → 3/3      | 1/3 → 3/3         |
| synthetic-no-shared-text         | 0/2 → 0/2      | 0/2 → 0/2         | 0/2 → 0/2      | 0/2 → 0/2         |
| synthetic-unicode-budget         | 2/2 → 2/2      | 2/2 → 2/2         | 2/2 → 2/2      | 2/2 → 2/2         |

At 2,048 bytes, two public tasks exposed another required file, but two
public tasks lost required evidence. No public task gained required evidence.
At 8,192 bytes, all ten public tasks were unchanged. The dense-first-file
synthetic case improved at both budgets; the production-distractors case lost
evidence at 2,048 bytes.

The run completed 90 task/budget/condition rows, including the separate raw-rg
reference, with no query failures. Zero reported metadata violations means
only that no supplied claim contradicted the oracle; the native mapper did
not supply optional completeness metadata. Forty-two additional contract
checks passed, including full match preservation, paging, context, unlimited
continuation, multiline, single-file, count, and filename modes.

These are small, fixed-query retrieval experiments. They do not establish a
representative effect size or whether a model would answer better. A fresh
ripgrep capture can change bounded output order. The observed tradeoff is
sufficient to reject automatic interleaving as the default; filename-only
Grep already lets the caller request distinct files explicitly.

## Native tool availability and model choice

An isolated patched native Claude Code 2.1.296 binary booted and sent Grep and
Glob in the actual Opus 5.5 API tool catalog. A prescribed smoke test completed
Glob, five Grep mode/page requests, and Read. This verifies the capability and
wiring; prescribed calls are not evidence of spontaneous adoption.

Two additional fresh synthetic tasks requested only a read-only investigation,
without naming tools. Each used `claude-opus-5-5`:

| Effort | Task                                                         | Observed tools                                | Checked answer                                               |
| ------ | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------ |
| Low    | Follow a webhook retry through the active policy             | Bash twice: find/grep, then grep source lines | Correct 17,000 ms delay and 117,000 ms due time              |
| Medium | Follow a stale lease renewal through policy and HTTP mapping | Bash twice: find/grep, then cat source files  | Correct unchanged storage and HTTP 409 with STALE_GENERATION |

Both answered the checked question correctly, and neither chose Grep, Glob,
Read, or fff. This was observational, with different tasks at each effort and
no paired baseline. It establishes neither a model-quality improvement nor an
effort-level comparison. The tested clone still contained the subsequently
rejected formatter, which these Bash-only trials never exercised. The final
integration removes that formatter and recommends filename-only discovery.

The separate viewer integration test completed 133 native-output comparisons,
eight viewer selections, and 12 cancellation cases. Its synthetic filename
check moved `ZetaService.ts` to the first `fff files Service` result after a
supported Bash read. This verifies that observed usage changes filename
ranking; it does not establish that the preferred file answers a later task.

The trials used synthetic code, not private transcripts. Source bundles,
authentication data, full model requests, and local machine paths are excluded
from this report. The real installed Claude binary and tweakcc configuration
were unchanged by clone testing.
