use std::path::{Path, PathBuf};

use fff_search::types::MixedItemRef;
use fff_search::{
    file_picker::FilePicker, query_tracker::QueryTracker, Constraint, FFFQuery, FuzzyQuery,
    FuzzySearchOptions, PaginationArgs,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct FileRequest {
    pub cwd: PathBuf,
    pub query: String,
    pub limit: usize,
}

#[derive(Serialize, Deserialize)]
pub struct Suggestion {
    pub path: String,
    pub score: f64,
    pub directory: bool,
    pub dirty: bool,
}

pub fn suggest(picker: &FilePicker, request: &FileRequest) -> Option<Vec<Suggestion>> {
    let cwd = std::fs::canonicalize(&request.cwd).ok()?;
    let relative = cwd.strip_prefix(&picker.base_path).ok()?;
    if !relative.as_os_str().is_empty()
        && git2::Repository::discover(&picker.base_path)
            .ok()
            .and_then(|repo| repo.status_should_ignore(relative).ok())
            .unwrap_or(true)
    {
        return None;
    }
    let mut needle = request.query.trim_start_matches("./").to_string();
    if Path::new(&needle).is_absolute() {
        needle = Path::new(&needle)
            .strip_prefix(&cwd)
            .ok()?
            .to_string_lossy()
            .into_owned();
    }
    let scope = format!("{}/**", globset::escape(&relative.to_string_lossy()));
    let constraints = if relative.as_os_str().is_empty() {
        Vec::new()
    } else {
        vec![Constraint::Glob(&scope)]
    };
    let query = FFFQuery {
        raw_query: &needle,
        fuzzy_query: FuzzyQuery::Text(&needle),
        constraints,
        location: None,
    };
    let tracker =
        crate::ranking::state_dir().and_then(|dir| QueryTracker::open(dir.join("queries")).ok());
    let result = picker.fuzzy_search_mixed(
        &query,
        tracker.as_ref(),
        FuzzySearchOptions {
            project_path: Some(&cwd),
            combo_boost_score_multiplier: 100,
            min_combo_count: 1,
            pagination: PaginationArgs {
                offset: 0,
                limit: request.limit.clamp(1, 100),
            },
            ..Default::default()
        },
    );
    let mut suggestions = Vec::new();
    for (index, (item, score)) in result.items.iter().zip(&result.scores).enumerate() {
        let (path, directory, dirty) = match item {
            MixedItemRef::File(file) => (
                file.absolute_path(picker, &picker.base_path),
                false,
                file.git_status
                    .is_some_and(fff_search::git::is_modified_status),
            ),
            MixedItemRef::Dir(dir) => (dir.absolute_path(picker, &picker.base_path), true, false),
        };
        let Ok(path) = path.strip_prefix(&cwd) else {
            continue;
        };
        if path.as_os_str().is_empty() {
            continue;
        }
        let mut path = path.to_string_lossy().into_owned();
        if directory {
            path.push('/');
        }
        let quality =
            1.0 / (1.0 + f64::from(score.total.max(0)) / needle.chars().count().max(1) as f64);
        suggestions.push(Suggestion {
            path,
            score: quality * 0.99 + index as f64 * 0.000001,
            directory,
            dirty,
        });
    }
    Some(suggestions)
}

pub fn query(cwd: &Path, needle: &str, limit: usize) -> Option<Vec<Suggestion>> {
    let request = FileRequest {
        cwd: std::fs::canonicalize(cwd).ok()?,
        query: needle.to_string(),
        limit,
    };
    let payload = serde_json::to_string(&request).ok()?;
    let (body, status) = crate::daemon::rpc(cwd, "suggest", &payload)?;
    if status != 0 {
        return None;
    }
    serde_json::from_str(&body).ok()
}
