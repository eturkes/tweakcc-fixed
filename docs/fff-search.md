# fff search

Enable **fff search and file autocomplete** in the miscellaneous settings, then
apply the patch. This is opt-in. It affects Claude Code's Bash search functions,
embedded ripgrep resolver, and normal `@` file suggestions.

Eligible searches use fff 0.11 with file-access history and Git activity for
ranking. Count and context output retain that file order. Successful Read, Edit,
and Write operations update the local history; a search followed by reading one
of its results also teaches the query-to-file preference.

The wrapper supports literal/regex searches, case-insensitive matching, context,
counts, filenames, multiple `-e` patterns, `-F`, and common `-o`/`-w` queries.
Ripgrep globs use the real engine's file inventory to preserve their inclusion
rules. Binary files, ignored scopes, Unicode word boundaries, long lines, or
unsupported options can require fallback. PCRE, multiline search, stdin filters,
and individual-file searches continue through the original embedded tool.
`find` retains its original results, with optional fuzzy suggestions on an empty
simple filename lookup.

By default, grep patterns use ripgrep-style syntax. Set `RG_FFF_FIRST=0` to request
the embedded grep dialect instead. Fuzzy content suggestions are approximate and
marked accordingly. `[def]` is a navigation hint; read the code to confirm it.

Inside Claude Code's Bash shell:

```sh
fff files UserService
fff files UserService 10
fff --stats
```

`fff files` searches filenames, includes directories, marks Git-modified files,
and suggests reading the candidates. It can scan locally when a daemon is not
ready. The same backend supplements normal `@` autocomplete while preserving
native commands, directory browsing, external configuration entries, and the
15-item limit. Autocomplete uses a short timeout and native fallback.

Daemons are shared by Git worktree root while each request stays scoped to its
working directory. Shell setup starts warming the index. The daemon requires a
completed scan and ready watcher before serving, holds a process lock, limits
concurrent requests and protocol sizes, caps cached content at 64 MiB, and exits
when its RSS budget is exceeded. The default RSS budget is 256 MiB; it is a
monitored circuit breaker, not a kernel allocation limit. An over-budget root
has a short restart cooldown. Dead sockets are cleaned up.

History and aggregate metrics stay under `~/.tweakcc/fff/state`, with a private
directory and private receipt/metric files. Metrics contain tool and decision
categories, not search patterns or result content. `RG_FFF_STATE_DIR` selects a
different local state directory. `RG_FFF_NO_DAEMON=1` disables persistent daemons;
`RG_FFF_MAX_RSS_MB` and `RG_FFF_IDLE_SECONDS` adjust their budgets. Detailed
`RG_FFF_LOG` logging is an explicit opt-in and can contain search patterns.

# Local verification

```sh
cargo build --release --manifest-path tools/rg-fff/Cargo.toml
cargo test --manifest-path tools/rg-fff/Cargo.toml
node tools/rg-fff/integration.mjs
node tools/rg-fff/daemon-integration.mjs
python3 tools/rg-fff/test_export_transcripts.py
```

The integration scripts use the debug build; run `cargo build` too when testing
locally. CI builds it and tests only synthetic repositories and queries.

Real transcript replay is local-only:

```sh
python3 tools/rg-fff/export-transcripts.py --output /tmp/fff-private-replay.json
node tools/rg-fff/replay.mjs /tmp/fff-private-replay.json
```

The exporter refuses output inside Git repositories and creates a private file.
The replay harness executes argument arrays without a shell, skips options that
can execute other programs, disables query logging/configuration inheritance,
and prints aggregate counts only. For native Claude Code, pass the wrapper and
Claude binary as the third and fourth arguments. Unavailable working directories
are skipped; slow searches are reported separately. Do not commit transcript
datasets, replay output, paths, patterns, or real result fixtures.
