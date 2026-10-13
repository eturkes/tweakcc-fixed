# Native search and fff filename discovery

Enable **native search and fff file autocomplete** in miscellaneous settings,
then apply. The feature is experimental and opt-in. Its existing config key
`swapRipgrepForFff` and patch ID `swap-ripgrep-for-fff` remain compatible.

The patch edits Claude Code's embedded JavaScript, including native binary
installations. It makes the existing Grep and Glob tools available through the
native tool-selection path, retaining disabled-tool and permission filters.
Grep keeps its native matching, result ordering, pagination, and tool schema.

## Content search

Use Grep with `output_mode: "files_with_matches"` to find distinct files that
contain a pattern. Use Glob for filename patterns, then targeted content
searches with a small context window and Read to inspect the implementation.
When an LSP tool is available and a source position is known, use its
definitions, references, and call hierarchy for symbol questions. A textual
match alone does not distinguish a definition from a caller.

Native ripgrep performs content matching and the native Grep handler formats
results. Native `head_limit` and `offset` control pagination, including
`head_limit: 0` for unlimited output. Results can still be truncated; use
pagination to continue. File history affects fff filename discovery, not Grep
content ordering.

Automatic interleaving was evaluated and rejected: it exposed more files in
some cases but displaced useful evidence in others. The
[frozen evaluation results](../tools/navigation-eval/RESULTS.md) record both
effects. There is no interleaving toggle or formatter in the installed patch.

Bash `grep`, `rg`, and `find`, their native shell setup, and Claude's embedded
ripgrep resolver retain native behavior. The patch no longer redirects them to
fff. Tool guidance is appended at the native description call sites when the
feature is applied, so custom prompt overrides can retain their content.
It recommends filename-only discovery, inspecting current source, and
available LSP tools. Guidance does not guarantee the model will choose these
tools: two unguided Opus 5.5 trials still chose Bash and answered correctly.
File pointers are no longer appended to compaction summaries, and file-history
counts no longer affect the Jev effort router.

The native insertion points are checked against Claude Code 2.1.296. Missing or
ambiguous required tool-selection and integration boundaries fail the patch.
Older installed builds can require another verified match method. Reapply from
the pristine backup to replace a previously intercepted search configuration.

## Filename discovery and local learning

Inside Claude Code's Bash shell:

```sh
fff files UserService
fff files UserService 10
fff --stats
```

`fff files` searches filenames, includes directories, marks Git-modified files,
and suggests reading candidates. The fff 0.11 backend also supplements normal
`@` autocomplete while preserving native commands, directory browsing,
external configuration entries, and the 15-item limit. Autocomplete has a short
timeout and native fallback. Filename search can scan locally when its daemon
is not ready. Shell setup warms the index.

Successful Read, Edit, and Write operations update local filename history.
Reading a candidate from explicit `fff files` discovery can also teach its
query-to-file preference. Receipts store structured paths; repeated matches or
colons in filenames do not create extra votes. Content search does not use this
history to reorder its results.

The separate **fff: learn from Bash file reads** setting is enabled by default
and requires the main fff setting. Supported successful `cat`, `head`, `tail`,
and single-file `sed` commands also teach filename ranking. File operands are
resolved after shell expansion against the command's actual working directory
and must remain within its initial project scope. The observer records paths
and usage metadata without adding file contents or raw Bash commands to history.

At each Bash command's start, a bounded selector enables private executable
proxies only for recognized native GNU/BSD viewers. Custom viewers retain their
normal shell handling. Selection skips earlier relative or empty PATH entries
whose meaning could change after `cd`. The proxies run the original viewer
with its normal input, output, exit status, and inherited signal behavior.
Custom shell functions and aliases keep precedence; supported viewers launched
through `command`, `env`, `xargs`, or scripts can also contribute history.

Unknown binaries/options, failed commands, zero-count requests, follow/edit
modes, multi-file `sed`, and stdin-only reads do not teach history. Absolute
executable paths or explicit PATH replacement can bypass the proxies. A
successful viewer invocation is a conservative usage signal, not syscall-level
read tracing. Disable the separate setting to retain fff without observing Bash
reads; disabling the main feature also disables that observation. Apply after
changing either setting. Other terminal sessions retain their normal viewers.

## Service and compatibility

Daemons are shared by Git worktree root, while requests stay scoped to their
working directory. A completed scan and ready watcher are required before
serving. Process locks, request/protocol limits, cache budgets, and restart
cooldowns bound resource use. The default RSS budget is 256 MiB; it is a
monitored circuit breaker, not a kernel allocation limit. Dead sockets are
cleaned up. A busy history receipt lock is skipped.

History and aggregate metrics stay under `~/.tweakcc/fff/state`, with private
directory/file permissions. Metrics contain operation and decision categories,
not query patterns or source contents. `RG_FFF_STATE_DIR` changes the local
state directory; `RG_FFF_NO_DAEMON=1` disables persistent daemons.
`RG_FFF_MAX_RSS_MB` and `RG_FFF_IDLE_SECONDS` adjust service budgets. Detailed
`RG_FFF_LOG` logging is opt-in and can contain search patterns.

The standalone wrapper retains its legacy grep-compatible entry points for
explicit callers. Its regex compatibility, complete collection, fresh-file
checks, 32 MiB rendered-output cap, and native fallback remain tested. These
legacy content-ranking paths are no longer wired into Claude's native tools
or normal Bash search commands.

Development checkouts install the newest executable local build after checking
its contents. Local and published build provenance are distinct. Bash-read
learning requires the main integration to apply successfully.

## Verification

The [public evidence evaluation](../tools/navigation-eval/README.md) freezes
questions, expected evidence, and byte budgets before comparing native search
presentation. It uses a pinned public repository and synthetic cases. Retrieval
coverage and model answer correctness are separate outcomes; this work does
not establish a general answer-quality improvement over native search.

```sh
pnpm test
pnpm lint
pnpm build
node tools/navigation-eval/run.mjs --verify
cargo test --locked --manifest-path tools/rg-fff/Cargo.toml
cargo build --locked --manifest-path tools/rg-fff/Cargo.toml
node tools/rg-fff/integration.mjs
node tools/rg-fff/compatibility-integration.mjs
node tools/rg-fff/semantic-integration.mjs
node tools/rg-fff/edge-integration.mjs
node tools/rg-fff/output-integration.mjs
node tools/rg-fff/history-integration.mjs
node tools/rg-fff/relevance-integration.mjs
node tools/rg-fff/daemon-integration.mjs
node tools/rg-fff/freshness-integration.mjs
node tools/rg-fff/viewer-integration.mjs
python3 tools/rg-fff/test_export_transcripts.py
```

The integration scripts use the debug build. CI tests public/synthetic inputs.
Real transcript replay remains local-only:

```sh
python3 tools/rg-fff/export-transcripts.py --output /tmp/fff-private-replay.json
node tools/rg-fff/replay.mjs /tmp/fff-private-replay.json
```

The exporter refuses output inside Git repositories and creates a private file.
Replay uses argument arrays without a shell, skips options that execute other
programs, disables query logging/config inheritance, and prints aggregates only.
For native Claude Code, supply the wrapper and Claude binary as the third and
fourth arguments. Do not commit transcripts, replay output, private paths,
patterns, or real result fixtures.
