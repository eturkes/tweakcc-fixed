# fff search

Enable **fff search and file autocomplete** in the miscellaneous settings, then
apply the patch. This is opt-in. It affects Claude Code's Bash search functions,
embedded ripgrep resolver, and normal `@` file suggestions.

Development checkouts use the newest executable local build and compare its
content before installing it. Local builds have separate provenance from
published releases, so a development binary cannot satisfy a release-version
check. Bash-read learning also requires the main fff patch to apply successfully.

Eligible searches use fff 0.11. Exact symbol searches collect all result pages
before ordering files: declarations of the queried symbol come first, followed
by query-to-file preferences, access/Git activity, modification time, and path.
Declaration lines and their context blocks lead within each file. Counts and
filename-only output retain the same file ordering. Declaration recognition is
conservative and covers common function, type, and variable declarations; it is
not a language parser or semantic index. Fuzzy searches retain fff's fuzzy order.

Managed grep counts use the original engine to preserve zero counts, empty
files, and option precedence. Successful Read, Edit, and Write operations update
local history. Reading a result from content search or explicit `fff files`
discovery also teaches its query-to-file preference. Receipts store structured
file paths, so repeated matches and colons in filenames do not distort learning.

The separate **fff: learn from Bash file reads** setting is enabled by default
and requires the main fff setting. Supported successful `cat`, `head`, `tail`,
and single-file `sed` commands also teach file ranking, query preference, and
session navigation. File operands are resolved after shell expansion against
the command's actual working directory and must remain within its initial
project scope. This observation stores paths and usage metadata, without adding
file contents or raw Bash commands to history.

At each Bash command's start, a bounded selector enables private executable
proxies only for recognized native GNU/BSD viewers. Custom viewers retain their
normal shell handling, and selection skips earlier relative/empty PATH entries
whose meaning could change after `cd`. The proxies run the original viewer
with its normal input, output, exit status, and inherited signal behavior.
Custom shell functions and aliases keep precedence; supported viewers launched through `command`,
`env`, `xargs`, or scripts can also contribute history. Learning recognizes
supported system/package GNU viewers and macOS BSD viewers. Custom binaries,
unknown options, failed commands, zero-count requests, follow/edit modes,
multi-file `sed`, and stdin-only reads are left unlearned. Absolute executable
paths or explicit PATH replacement can bypass the proxies. Successful viewer
execution is a conservative usage signal, rather than syscall-level read
tracing. Disabling this setting preserves all other fff features; disabling
the main fff setting also disables Bash-read learning. Apply after changing
either setting. Your terminal outside Claude Code retains its normal viewers.

The wrapper supports literal/regex searches, case-insensitive matching, context,
counts, filenames, multiple `-e` patterns, `-F`, and common `-o`/`-w` queries.
Ripgrep globs use the real engine's file inventory to preserve their inclusion
rules. BOM-encoded files, binary files, ignored scopes, unsupported word-boundary behavior, long lines, or
unsupported options can require fallback. PCRE, multiline search, stdin filters,
overlapping directory scopes, conflicting grep matcher flags,
regular-file stdin, matching-only output with context, and individual-file searches
continue through the original embedded tool. Invalid or unsupported options also
reach that tool, preserving its diagnostics and exit status.
`find` retains its original results, with optional fuzzy suggestions on an empty
simple filename lookup.

Grep preserves its native basic-regex syntax; use `grep -E` for extended regex
or `grep -F` for literal punctuation. Ripgrep retains ripgrep syntax. Unsupported
regex dialect features use the original engine. Exact searches preserve Unicode
matching and CRLF content. Searches exceeding the collector budget or reaching
the per-file match ceiling fall back rather than silently omit results. Rendered
output has its own 32 MiB budget, including repeated path prefixes; exceeding it
falls back before any partial output is printed. The legacy `RG_FFF_FIRST`
environment variable no longer overrides command semantics. Fuzzy content suggestions are approximate and
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

After a successful main-session reactive compaction, fff can append up to eight
recently used file pointers, ranked by fff's access history. The note contains
paths only and is capped at 2,048 characters. Candidates must belong to the same
session and current directory and still exist. Subagent compactions retain their
own summaries. The bounded local navigation history holds at most 64 files per
session, with a 24-hour eligibility window.

The Jev effort router can use cached aggregate counts of indexed files, Git
modifications, and recent session files/directories as weak breadth evidence.
This metadata adds no paths, patterns, or file contents to the routing request.
The router does not wait for fff; unavailable or stale data is omitted, and
optional counts are discarded before task context is trimmed for its budget.
Counts describe partial coverage and observed navigation, rather than predicting
how many files a new task will require. Routing criteria remain unchanged.

Daemons are shared by Git worktree root while each request stays scoped to its
working directory. Shell setup starts warming the index. The daemon requires a
completed scan and ready watcher before serving. Exact searches also enumerate
the current scope with the native tool and check each file before matching,
including files that previously had no matches. Changed files are synchronously
refreshed; unchanged entries retain their index and content cache. Cache reuse
requires matching file identity, size, and nanosecond modification/change times;
coarse change timestamps force a refresh. This prevents watcher lag from hiding
recent edits. The daemon holds a process lock, limits
concurrent requests and protocol sizes, caps cached content at 64 MiB, and exits
when its RSS budget is exceeded. The default RSS budget is 256 MiB; it is a
monitored circuit breaker, not a kernel allocation limit. An over-budget root
has a short restart cooldown. Dead sockets are cleaned up.

History learning is best-effort: a busy receipt lock is skipped so a history
writer cannot hold up search output.

History and aggregate metrics stay under `~/.tweakcc/fff/state`, with a private
directory and private receipt/metric/navigation files. Metrics contain tool and decision
categories, not search patterns or result content. `RG_FFF_STATE_DIR` selects a
different local state directory. `RG_FFF_NO_DAEMON=1` disables persistent daemons;
`RG_FFF_MAX_RSS_MB` and `RG_FFF_IDLE_SECONDS` adjust their budgets. Detailed
`RG_FFF_LOG` logging is an explicit opt-in and can contain search patterns.

# Local verification

```sh
cargo build --release --manifest-path tools/rg-fff/Cargo.toml
cargo test --manifest-path tools/rg-fff/Cargo.toml
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
