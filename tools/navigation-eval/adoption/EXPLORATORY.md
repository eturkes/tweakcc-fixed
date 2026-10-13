# Exploratory appendix observations

Eight fresh native Opus 5.5 sessions used four frozen synthetic tasks, with one
baseline and one appendix condition per task. Low and medium efforts were fixed
by task. Both conditions used the same feature-enabled 2.1.296 binary, wrapper,
corpus, settings, explicit four-tool selection, 4,096 output-token limit,
12-turn limit, 150-second guard, and USD 1.10 per-session budget. Reported total
cost was USD 0.4550518 across 32 main-model requests. There were no outcome
retries, private instruction inputs, or fixture changes.

The explicit `--tools Bash,Glob,Grep,Read` selection opts into native search and
suppresses the default Bash-first selection. These sessions therefore evaluate
the CLI appendix under a controlled catalog. They do not confirm the final
integration under native default tools.

| Task                           | Effort | Baseline fff invocation | Appendix fff invocation | Appendix returned candidate paths | Candidate source inspected               | Core requested facts |
| ------------------------------ | ------ | ----------------------- | ----------------------- | --------------------------------- | ---------------------------------------- | -------------------- |
| Approximate proration filename | low    | no                      | yes                     | yes                               | yes                                      | passed in both       |
| Unhelpful filename cue         | medium | no                      | yes                     | yes                               | yes                                      | passed in both       |
| Lease renewal                  | medium | no                      | yes                     | no                                | not attributable to a returned candidate | passed in both       |
| Webhook retry                  | low    | no                      | no                      | not invoked                       | not applicable                           | passed in both       |

The proration appendix session combined `fff files` and content search in its
first Bash command, then read the policy and invoice implementation. The traces
establish candidate inspection but cannot identify which search caused the file
choice. The unhelpful filename session read the pause candidates, followed their
documentation to the active hold operation, and read that implementation.

The lease session received a successful fff header without candidate paths,
then used native file listing and source reads. The webhook session began with
an exact content search for `429` and related terms. That is a reasonable content
cue for this task; a filename-first instruction is not evidence that every
content-led choice is a failure.

All eight answers gave the requested outcomes and exposed the relevant source
code. That is narrower than saying every answer was correct. The extra claims
were reviewed separately:

| Answers                            | Unsupported extra claim                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both proration answers             | The charge can never exceed `monthlyCents`. This needs an integer-cents constraint that the function does not enforce. A full period at 999.5 cents returns 1000.         |
| Baseline unhelpful-filename answer | It asserts a router connection from `POST /hold` to `holdJob`, but this fixture contains no route registration. The button action and documentation support an inference. |
| Appendix unhelpful-filename answer | It explicitly identifies the missing router registration and distinguishes the inference from code it inspected.                                                          |

`exploratory.v1.json` preserves anonymized commands, results, answers, source
evidence, and these fact assessments. The task and appendix hashes remain the
original frozen values in `integrity.v1.json`. Timing is excluded from this
report. Four small, manually selected synthetic tasks with one observation per
condition cannot establish general performance or reliability.
