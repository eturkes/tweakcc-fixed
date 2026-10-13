mod collect;
mod definitions;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

use fff_search::file_picker::FilePicker;
use fff_search::{AiGrepConfig, FFFQuery, FuzzyQuery, GrepMode, GrepSearchOptions, QueryParser};

use crate::{
    feedback, Mode, SearchOutput, SearchReq, APPROX_MARK, DEF_MARK, FUZZY_HDR, TRUNC_MARK,
};
pub(crate) use definitions::{is_symbol, line_defines};

/// Grep `picker` per `req` and render tool-compatible output. Shared verbatim by
/// the cold path and the daemon. Returns None when fff can't serve faithfully.
pub fn format_results(picker: &FilePicker, req: &SearchReq) -> Option<SearchOutput> {
    let cwd = if req.cwd.is_empty() {
        &picker.base_path
    } else {
        Path::new(&req.cwd)
    };
    if !cwd.starts_with(&picker.base_path) {
        return None;
    }
    let scoped_path = |file: &fff_search::types::FileItem| {
        file.absolute_path(picker, &picker.base_path)
            .strip_prefix(cwd)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    };
    let expected: Option<HashSet<&str>> = req
        .expected_files
        .as_ref()
        .map(|v| v.iter().map(String::as_str).collect());
    if let Some(files) = &expected {
        if files
            .iter()
            .any(|path| picker.get_file_by_path(cwd.join(path)).is_none())
        {
            return None;
        }
    }
    if cwd != picker.base_path
        && git2::Repository::discover(&picker.base_path)
            .ok()
            .and_then(|repo| {
                repo.status_should_ignore(cwd.strip_prefix(&picker.base_path).ok()?)
                    .ok()
            })
            .unwrap_or(true)
    {
        return None;
    }
    let preferred = feedback::preferred(cwd, &req.pattern);
    let gmode = match req.mode {
        Mode::Plain => GrepMode::PlainText,
        Mode::Regex => GrepMode::Regex,
        Mode::Fuzzy => GrepMode::Fuzzy,
    };
    let is_fuzzy = matches!(req.mode, Mode::Fuzzy);
    // Definition hinting is meaningful only when the pattern is a literal symbol.
    let is_plain = req.symbol.is_some();

    // Non-git directories: fff scans with `.hidden(!is_git_repo)` (file_picker.rs:1802),
    // so OUTSIDE a git repo it prunes dotfiles at the filesystem walk — and keep()
    // operates only over the already-scanned index, so it can never re-add a pruned
    // file. CC always injects `--hidden` (req.hidden=true), so in a non-git dir we
    // would silently under-report matches inside dotfiles vs the real ugrep/rg
    // `--hidden`. Defer so the embedded tool handles it faithfully. (In a git repo
    // fff scans hidden, so keep() can honor --hidden correctly and we serve.)
    if req.hidden && picker.git_root().is_none() {
        return None;
    }
    // -i is baked into the pattern as (?i) for Regex; Plain is case-sensitive;
    // only Fuzzy still relies on smart_case for case-insensitivity.
    let smart = is_fuzzy && req.ignore_case;

    // Directory scoping + path echoing. grep prints join(pathArg, relPath); fff
    // returns cwd-relative paths. So scope by the CANONICAL dir (leading "./" and
    // trailing "/" stripped), and re-prepend the "./" grep emits when the path
    // arg is "." or "./...".
    //  * Plain/Fuzzy go through fff's DSL ("dir/ " is a path constraint, the
    //    simple pattern stays literal).
    //  * Regex MUST bypass the DSL (it misreads `obj.method` as a filename, drops
    //    `|`/`^`/`\b`), so we build the query directly and scope by post-filter.
    // Canonical dir for scoping ("." and trailing "/" -> ""); "./..."/absolute
    // args never reach here (deferred in search_mode). out_prefix is precomputed
    // per-tool in to_req (rg echoes "./" for a "." arg; ugrep does not).
    let out_prefix = req.path_prefix.as_str();
    // Dir scoping is ALWAYS the anchored post-filter (relative_path starts_with a
    // "dir/" prefix), never fff's DSL "dir/" constraint — that matches the segment
    // (e.g. "src") ANYWHERE in a path (tools/x/src/…), diverging from grep's
    // root-anchored path arg. `req.dir_prefixes` holds the canonical "app/","lib/"
    // prefixes (empty = whole cwd / "." arg); multi-path keeps a result iff it's
    // under ANY prefix. So the query carries only the pattern.
    let dir_prefixes = &req.dir_prefixes;

    let parser = QueryParser::new(AiGrepConfig);
    let parsed: FFFQuery = if !is_fuzzy {
        FFFQuery {
            raw_query: &req.pattern,
            constraints: Vec::new(),
            fuzzy_query: FuzzyQuery::Text(&req.pattern),
            location: None,
        }
    } else {
        // QueryParser::parse borrows its input; req.pattern outlives `parsed`, so
        // borrow it directly instead of cloning into a throwaway String.
        parser.parse(&req.pattern)
    };

    let keep = |path: &str| -> bool {
        if let Some(files) = &expected {
            return files.contains(path);
        }
        // VCS metadata dirs: CC's shadow always injects
        // `--exclude-dir=.git/.svn/.hg/.bzr/.jj/.sl`. fff only auto-excludes .git,
        // and in a git repo it scans the other hidden VCS dirs — so without this,
        // matches inside a non-gitignored .svn/.hg/etc. would diverge from ugrep
        // (which --exclude-dirs them). Mirror CC's fixed VCS set here.
        if path
            .split('/')
            .any(|s| matches!(s, ".git" | ".svn" | ".hg" | ".bzr" | ".jj" | ".sl"))
        {
            return false;
        }
        // -g/--include "*.ext" filter: keep only the requested extensions. Path
        // ends-with is byte-identical to rg's `-g '*.ts'` (path glob) and grep's
        // `--include=*.ts` (basename glob) for extension globs (the ext is at the
        // path tail either way). Non-extension globs never reach here (deferred).
        if !req.include_exts.is_empty()
            && !req.include_exts.iter().any(|e| path.ends_with(e.as_str()))
        {
            return false;
        }
        // dir scoping: keep iff under ANY requested dir prefix (empty = whole cwd)
        if !dir_prefixes.is_empty() && !dir_prefixes.iter().any(|p| path.starts_with(p.as_str())) {
            return false;
        }
        // hidden-file handling: unless --hidden, skip dotfiles like the tool does
        // — but only relative to the matching search root, so an explicit hidden
        // dir arg (e.g. `grep X .github`) is still searched.
        if req.hidden {
            return true;
        }
        let rel = dir_prefixes
            .iter()
            .find_map(|p| path.strip_prefix(p.as_str()))
            .unwrap_or(path);
        !rel.split('/').any(|s| s.starts_with('.'))
    };

    if picker
        .get_files()
        .iter()
        .chain(picker.get_overflow_files())
        .any(|file| {
            file.size > 10 * 1024 * 1024 && scoped_path(file).map(|p| keep(&p)).unwrap_or(false)
        })
    {
        return None;
    }

    if !is_fuzzy && parsed.grep_text() != req.pattern {
        return None;
    }
    let result = collect::search(
        picker,
        &parsed,
        GrepSearchOptions {
            before_context: req.before_context,
            after_context: req.after_context,
            ..grep_opts(gmode, smart)
        },
        req,
        preferred.as_deref(),
        |file| scoped_path(file).is_some_and(|path| keep(&path)),
    )?;

    let files = result
        .files
        .iter()
        .filter_map(|file| scoped_path(file))
        .collect();
    let mut out = String::new();
    if is_fuzzy {
        let _ = writeln!(out, "{FUZZY_HDR}");
    }

    if req.count {
        let mut counts: Vec<(String, usize)> = Vec::new();
        let mut indexes = HashMap::new();
        for m in &result.matches {
            let f = result.files[m.file_index];
            let Some(path) = scoped_path(f) else {
                continue;
            };
            if keep(&path) {
                let index = *indexes.entry(path.clone()).or_insert_with(|| {
                    counts.push((path, 0));
                    counts.len() - 1
                });
                counts[index].1 += 1;
            }
        }
        let any = !counts.is_empty();
        for (f, c) in &counts {
            let _ = writeln!(out, "{out_prefix}{f}:{c}");
        }
        return Some(SearchOutput {
            body: out,
            code: if any { 0 } else { 1 },
            files,
        });
    }

    // -A/-B/-C context: collect every (match + context) line per file, merge
    // overlapping windows by line number, then emit with grep's separators.
    // (to_req zeroes context for -l/-c/fuzzy, so this is content mode only.)
    if req.before_context > 0 || req.after_context > 0 {
        // Per line: U+FFFD (non-UTF-8) -> defer the whole query (None); a >=509 B
        // line gets the truncation marker; otherwise pass through unchanged.
        let mark = |s: &str| -> Option<String> {
            if s.contains('\u{FFFD}') || s.len() >= 509 {
                return None;
            }
            Some(s.to_string())
        };
        // path -> (line_no -> (is_match, content)); BTreeMap keeps line order.
        let mut per_file: Vec<(String, BTreeMap<u64, (bool, String)>)> = Vec::new();
        let mut indexes = HashMap::new();
        for m in &result.matches {
            let f = result.files[m.file_index];
            let Some(path) = scoped_path(f) else {
                continue;
            };
            if !keep(&path) {
                continue;
            }
            let mln = match mark(&m.line_content) {
                Some(x) => x,
                None => return None, // non-UTF-8 -> defer
            };
            let index = *indexes.entry(path.clone()).or_insert_with(|| {
                per_file.push((path, BTreeMap::new()));
                per_file.len() - 1
            });
            let fmap = &mut per_file[index].1;
            let ln = m.line_number;
            // fff returns only the context lines that exist, so the first
            // before-context line sits at ln - context_before.len().
            let blen = m.context_before.len() as u64;
            for (i, c) in m.context_before.iter().enumerate() {
                let cm = match mark(c) {
                    Some(x) => x,
                    None => return None,
                };
                fmap.entry(ln - blen + i as u64).or_insert((false, cm));
            }
            // The match line wins over any context tag for the same line.
            fmap.insert(ln, (true, mln));
            for (i, c) in m.context_after.iter().enumerate() {
                let cm = match mark(c) {
                    Some(x) => x,
                    None => return None,
                };
                fmap.entry(ln + 1 + i as u64).or_insert((false, cm));
            }
        }
        let mut any = false;
        let mut first_group = true;
        for (path, lines) in &per_file {
            let mut groups: Vec<Vec<_>> = Vec::new();
            let mut last = None;
            for (&number, line) in lines {
                if last != number.checked_sub(1) || groups.is_empty() {
                    groups.push(Vec::new());
                }
                groups.last_mut().unwrap().push((number, line));
                last = Some(number);
            }
            groups.sort_by_key(|group| {
                !group.iter().any(|(_, (matched, content))| {
                    *matched
                        && req
                            .symbol
                            .as_deref()
                            .is_some_and(|symbol| line_defines(content, symbol, req.ignore_case))
                })
            });
            let mut prev: Option<u64> = None;
            for (ln, (is_match, content)) in groups.into_iter().flatten() {
                let new_group = prev.map(|p| ln != p + 1).unwrap_or(true);
                if new_group && !first_group {
                    // within-file gap -> always `--`; across files -> only rg.
                    let cross_file = prev.is_none();
                    if !cross_file || req.sep_between_files {
                        let _ = writeln!(out, "--");
                    }
                }
                let sep = if *is_match { ':' } else { '-' };
                // Advisory def hint on MATCH lines only (never context lines),
                // and only where the searched literal symbol is defined.
                let def = if is_plain
                    && *is_match
                    && line_defines(
                        content,
                        req.symbol.as_deref().unwrap_or(""),
                        req.ignore_case,
                    ) {
                    DEF_MARK
                } else {
                    ""
                };
                if req.line_numbers {
                    let _ = writeln!(out, "{out_prefix}{path}{sep}{ln}{sep}{content}{def}");
                } else {
                    let _ = writeln!(out, "{out_prefix}{path}{sep}{content}{def}");
                }
                prev = Some(ln);
                first_group = false;
                any = true;
            }
        }
        return Some(SearchOutput {
            body: out,
            code: if any { 0 } else { 1 },
            files,
        });
    }

    let mut any = false;
    if req.files_only {
        for f in &result.files {
            let Some(path) = scoped_path(f) else {
                continue;
            };
            if keep(&path) {
                let _ = writeln!(out, "{out_prefix}{path}");
                any = true;
            }
        }
    } else {
        for m in &result.matches {
            let f = result.files[m.file_index];
            let Some(path) = scoped_path(f) else {
                continue;
            };
            if !keep(&path) {
                continue;
            }
            if req.only_matching {
                if m.line_content.len() >= 509 || m.line_content.contains('�') {
                    return None;
                }
                for &(start, end) in &m.match_byte_offsets {
                    let text = m.line_content.get(start as usize..end as usize)?;
                    if req.line_numbers {
                        let _ = writeln!(out, "{out_prefix}{path}:{}:{text}", m.line_number);
                    } else {
                        let _ = writeln!(out, "{out_prefix}{path}:{text}");
                    }
                    any = true;
                }
                continue;
            }
            // fff caps line_content at 512 B (MAX_LINE_DISPLAY_LEN, backed up
            // to a char boundary -> [509,512]) and lossily replaces invalid
            // UTF-8 with U+FFFD. A 512-byte preview is the right thing for an
            // agent (a full minified line is context-noise) — so serve it with
            // an explicit marker (parser-safe trailing text) rather than the
            // silent cut fff/OpenCode emit. Non-UTF-8 (U+FFFD) still defers:
            // raw bytes can't be represented as a String.
            if !is_fuzzy && (m.line_content.contains('\u{FFFD}') || m.line_content.len() >= 509) {
                return None;
            }
            let mark = if m.line_content.len() >= 509 {
                TRUNC_MARK
            } else {
                ""
            };
            // Fuzzy matches are approximate — tag every line so a copied line
            // still reads as approximate (reinforces the header).
            let approx = if is_fuzzy { APPROX_MARK } else { "" };
            // Advisory definition hint (navigation), like fff-mcp's def hinting
            // — only where the searched literal symbol is actually defined.
            let def = if is_plain
                && line_defines(
                    &m.line_content,
                    req.symbol.as_deref().unwrap_or(""),
                    req.ignore_case,
                ) {
                DEF_MARK
            } else {
                ""
            };
            if req.line_numbers {
                let _ = writeln!(
                    out,
                    "{}{}:{}:{}{}{}{}",
                    out_prefix, path, m.line_number, m.line_content, mark, def, approx
                );
            } else {
                let _ = writeln!(
                    out,
                    "{}{}:{}{}{}{}",
                    out_prefix, path, m.line_content, mark, def, approx
                );
            }
            any = true;
        }
    }
    Some(SearchOutput {
        body: out,
        code: if any { 0 } else { 1 },
        files,
    })
}

fn grep_opts(mode: GrepMode, smart_case: bool) -> GrepSearchOptions {
    GrepSearchOptions {
        max_file_size: 10 * 1024 * 1024,
        max_matches_per_file: collect::FILE_MATCH_LIMIT,
        smart_case,
        page_limit: 2048,
        mode,
        time_budget_ms: 0,
        before_context: 0,
        after_context: 0,
        classify_definitions: false,
        trim_whitespace: false,
        abort_signal: Some(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        ))),
        ..Default::default()
    }
}
