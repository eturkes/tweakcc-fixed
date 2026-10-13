# fff agent navigation: Pi and Claude Code

The useful transfer from pi-fff is a model-visible workflow: discover plausible
paths, read their code, and fall back to exact content search when filenames
are unhelpful. Installing a filename backend or exposing native tools alone
does not establish that an agent will choose it.

## What the Pi extensions actually do

The official `@ff-labs/pi-fff` 0.11.0 registers `fffind` and `ffgrep`, attaching
`promptSnippet` and `promptGuidelines` to those tools. Its default mode keeps
Pi's native tools; its optional override mode replaces `find` and `grep`.
The guidance prefers fuzzy file discovery for approximate filenames, feature
names, and exploration, and encourages reading candidates after a few locating
searches. Multiword filename terms are fuzzy AND matches in either order.
These behaviors are visible in the
[released tool registrations](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts#L650-L859)
and [tool instructions](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts#L955-L1291).

`@bacnh85/pi-fff` 0.9.0 goes further: its `before_agent_start` hook adds a
system-prompt paragraph preferring fff over Bash searches when fff tools are
active. See the
[system-prompt hook](https://github.com/bacnh85/pi-extensions/blob/0f80f62fac030ad093e0c72868a519ac512a0d29/pi-fff/extensions/index.ts#L967-L981).
This is an explicit instruction layer, not a consequence of filename ranking.

The variants are not interchangeable. The official package's multi-pattern
grep is opt-in in its released source. ShpetimA's 0.1.13 variant also resolves
approximate Read paths. Neither behavior is copied into Claude's existing
content-search or Read handlers: those tools have exact matching, file
permissions, and result contracts that fuzzy suggestions cannot replace.
Sources: the official
[multi-grep gate](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts#L1297-L1337)
and the alternative
[registrations](https://github.com/ShpetimA/pi-fff/blob/bb35f3659f3090534c859223200feafb2897a2a6/src/register-tools.ts).

The official project's Claude benchmark also steers its two conditions with
prompt prefixes; its source records that Claude otherwise prefers native
tools. It tests fixed tasks on one project, so it does not prove spontaneous
adoption or a general relevance improvement. See the
[benchmark protocol](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/scripts/benchmark-claude.sh#L118-L166).

## The binary integration

Claude can use the same workflow through `fff files` in its existing Bash tool.
The patch attaches an explicit navigation paragraph to the final API system
prompt after native live/saved prompt selection. It also corrects the search
clause in native auto-mode messages after rendering. These additions are
conditional on the feature and Bash availability; custom prompt content and
native permission instructions are preserved.

Attaching the paragraph earlier in prompt assembly was insufficient: saved
prompt selection could discard it. Appending instructions to tool descriptions
also created an undo problem: native snapshots store those descriptions and
can replay them after the feature is disabled.

The final approach keeps additions transient. It leaves native tool descriptions
unchanged and cleans exact previously owned fff additions from selected saved
Bash/Grep descriptions and schemas at runtime. That cleanup remains available
when the discovery feature is off. It preserves other text, schema fields,
tool names, snapshot records, and permission selection, without rewriting
historical transcripts. `/context` uses the same selected-description cleanup
and system appendix for token accounting.

No `CLAUDE.md` or user override file receives an append. Changing the main
setting and applying rebuilds the binary from its pristine backup. Restart
Claude Code to use that rebuilt binary, including when resuming a session.
There are no instruction-file edits to undo. The native insertion sites are
verified on Claude Code 2.1.296; ambiguous sites fail instead of guessing a
neighboring function. The always-applied cleanup can also fail apply on an
older snapshot-enabled build with different sites, even when fff is off.

## Concrete benefits and limits

An approximate filename or several path words can locate a file without
knowing its exact spelling or the order of those words. For example,
`fff files 'lease renew'` can return `renewLease.ts`. The adapter now uses
fff's maintained query parser for those separate terms; its earlier one-string
adapter returned no candidates for that query on the synthetic lease task.

Local file usage and Git activity can rank plausible paths, and reading a
discovered file can teach a query-to-file preference. Those are usage signals,
not proof that a frequently accessed file is the right implementation. Fuzzy
matching can return extra candidates. A UI term such as `pause` may not help
find implementation files named `hold`; exact content searches and code reading
remain necessary.

Native Grep ordering, pagination, matching, Glob patterns, Read authorization,
and ordinary Bash searches retain their behavior. The
[interleaving evaluation](../tools/navigation-eval/RESULTS.md) rejected a content
presentation change that exposed more files but sometimes hid needed source
details. The [adoption evaluation](../tools/navigation-eval/adoption/README.md)
separately measures whether the model calls fff, whether returned paths are
inspected, and whether the requested facts are supported. These outcomes must
not be collapsed into a single claim that answers are better.

In the final comparison with native default tools, Opus 5.5 used fff and
inspected returned paths in both guided tasks, compared with neither baseline
task. The low-effort proration task returned the policy first; the medium-effort
pause task needed a fallback because its implementation was named `hold`.
Both conditions answered the requested facts correctly. Two single-run task
pairs demonstrate adoption in those cases, without establishing a general
answer-quality gain.
