use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::Ordering;

use fff_search::file_picker::FilePicker;
use fff_search::grep::{GrepMatch, GrepResult};
use fff_search::types::FileItem;
use fff_search::{FFFQuery, GrepSearchOptions};

use super::definitions::line_defines;
use crate::{Mode, SearchReq};

pub const FILE_MATCH_LIMIT: usize = 50_001;
const MAX_RESULT_BYTES: usize = 32 * 1024 * 1024;

pub fn search<'a>(
    picker: &'a FilePicker,
    query: &FFFQuery<'_>,
    mut options: GrepSearchOptions,
    request: &SearchReq,
    preferred: Option<&Path>,
    keep: impl Fn(&FileItem) -> bool,
) -> Option<GrepResult<'a>> {
    let context_lines = options.before_context.checked_add(options.after_context)?;
    if context_lines > 0 {
        let per_match = context_lines.checked_add(1)?.checked_mul(2048)?;
        let limit = MAX_RESULT_BYTES / per_match;
        if limit < 2 {
            return None;
        }
        options.max_matches_per_file = options.max_matches_per_file.min(limit);
    }
    let mut result = GrepResult::default();
    let mut bytes = 0usize;
    loop {
        let page = picker.grep(query, &options);
        if page.regex_fallback_error.is_some()
            || options
                .abort_signal
                .as_ref()
                .is_some_and(|signal| signal.load(Ordering::Relaxed))
        {
            return None;
        }
        let mut counts = vec![0usize; page.files.len()];
        let mapping: Vec<_> = page
            .files
            .iter()
            .map(|file| {
                if !keep(file) {
                    return None;
                }
                let index = result.files.len();
                result.files.push(*file);
                Some(index)
            })
            .collect();
        for mut item in page.matches {
            let old = item.file_index;
            let Some(index) = mapping[old] else {
                continue;
            };
            counts[old] += 1;
            if counts[old] >= options.max_matches_per_file {
                return None;
            }
            bytes = bytes.checked_add(match_size(&item))?;
            if bytes > MAX_RESULT_BYTES {
                return None;
            }
            item.file_index = index;
            result.matches.push(item);
        }
        if matches!(request.mode, Mode::Fuzzy) || page.next_file_offset == 0 {
            break;
        }
        if page.next_file_offset <= options.file_offset {
            return None;
        }
        options.file_offset = page.next_file_offset;
    }
    if request.word
        && result
            .matches
            .iter()
            .any(|m| !m.line_content.is_ascii() || m.line_content.len() >= 509)
    {
        return None;
    }
    if !matches!(request.mode, Mode::Fuzzy) && !request.files_only && !request.count {
        restore_line_endings(picker, &mut result)?;
    }
    if !matches!(request.mode, Mode::Fuzzy) {
        rank(picker, &mut result, request, preferred);
    }
    Some(result)
}

fn match_size(item: &GrepMatch) -> usize {
    std::mem::size_of::<GrepMatch>()
        + item.line_content.len()
        + item.match_byte_offsets.len() * std::mem::size_of::<(u32, u32)>()
        + item
            .context_before
            .iter()
            .chain(&item.context_after)
            .map(|line| std::mem::size_of::<String>() + line.len())
            .sum::<usize>()
}

fn restore_line_endings(picker: &FilePicker, result: &mut GrepResult<'_>) -> Option<()> {
    let mut matches_by_file = vec![Vec::new(); result.files.len()];
    for (index, item) in result.matches.iter().enumerate() {
        matches_by_file[item.file_index].push(index);
    }
    for (index, file) in result.files.iter().enumerate() {
        let mut data = Vec::new();
        std::fs::File::open(file.absolute_path(picker, &picker.base_path))
            .ok()?
            .take(10 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .ok()?;
        if data.len() > 10 * 1024 * 1024 {
            return None;
        }
        let mut wanted = HashSet::new();
        for &match_index in &matches_by_file[index] {
            let item = &result.matches[match_index];
            let before = item
                .line_number
                .checked_sub(item.context_before.len() as u64)?;
            wanted.extend(before..=item.line_number + item.context_after.len() as u64);
        }
        let lines: HashMap<_, _> = data
            .split(|&byte| byte == b'\n')
            .enumerate()
            .map(|(index, line)| (index as u64 + 1, line))
            .filter(|(number, _)| wanted.contains(number))
            .collect();
        let restore = |line: &mut String, number: u64| -> Option<()> {
            let source = *lines.get(&number)?;
            let normalized = source.strip_suffix(b"\r").unwrap_or(source);
            if normalized != line.as_bytes() {
                return None;
            }
            if source.ends_with(b"\r") {
                line.push('\r');
            }
            Some(())
        };
        for &match_index in &matches_by_file[index] {
            let item = &mut result.matches[match_index];
            restore(&mut item.line_content, item.line_number)?;
            let before = item
                .line_number
                .checked_sub(item.context_before.len() as u64)?;
            for (offset, line) in item.context_before.iter_mut().enumerate() {
                restore(line, before + offset as u64)?;
            }
            for (offset, line) in item.context_after.iter_mut().enumerate() {
                restore(line, item.line_number + 1 + offset as u64)?;
            }
        }
    }
    Some(())
}

fn rank(
    picker: &FilePicker,
    result: &mut GrepResult<'_>,
    request: &SearchReq,
    preferred: Option<&Path>,
) {
    let defined = |item: &GrepMatch| {
        request
            .symbol
            .as_deref()
            .is_some_and(|symbol| line_defines(&item.line_content, symbol, request.ignore_case))
    };
    let mut definitions = vec![false; result.files.len()];
    for item in &result.matches {
        definitions[item.file_index] |= defined(item);
    }
    let mut order: Vec<_> = (0..result.files.len()).collect();
    order.sort_by(|&a, &b| {
        let left = result.files[a];
        let right = result.files[b];
        definitions[b]
            .cmp(&definitions[a])
            .then_with(|| {
                let selected = |file: &FileItem| {
                    preferred
                        .is_some_and(|path| file.absolute_path(picker, &picker.base_path) == path)
                };
                selected(right).cmp(&selected(left))
            })
            .then_with(|| {
                right
                    .total_frecency_score()
                    .cmp(&left.total_frecency_score())
            })
            .then_with(|| right.modified.cmp(&left.modified))
            .then_with(|| left.relative_path(picker).cmp(&right.relative_path(picker)))
    });
    let mut mapping = vec![0usize; order.len()];
    let files: Vec<_> = order
        .iter()
        .enumerate()
        .map(|(new, &old)| {
            mapping[old] = new;
            result.files[old]
        })
        .collect();
    for item in &mut result.matches {
        item.file_index = mapping[item.file_index];
    }
    result.files = files;
    result
        .matches
        .sort_by_key(|item| (item.file_index, !defined(item), item.line_number));
}
