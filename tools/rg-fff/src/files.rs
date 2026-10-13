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
        raw_query: &request.query,
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
    if std::env::var_os("RG_FFF_NO_DAEMON").is_some() {
        return None;
    }
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

pub fn discover(cwd: &Path, needle: &str, limit: usize) -> Option<Vec<Suggestion>> {
    if let Some(items) = query(cwd, needle, limit) {
        remember_discovery(cwd, needle, &items);
        return Some(items);
    }
    let cwd = std::fs::canonicalize(cwd).ok()?;
    let shared = fff_search::SharedFilePicker::default();
    FilePicker::new_with_shared_state(
        shared.clone(),
        crate::ranking::shared_frecency(),
        crate::ranking::picker_options(&cwd, false),
    )
    .ok()?;
    if !shared.wait_for_scan(std::time::Duration::from_secs(15)) {
        return None;
    }
    let guard = shared.read().ok()?;
    let result = suggest(
        guard.as_ref()?,
        &FileRequest {
            cwd: cwd.clone(),
            query: needle.to_string(),
            limit,
        },
    );
    if let Some(items) = &result {
        remember_discovery(&cwd, needle, items);
    }
    crate::daemon::spawn_detached(&cwd);
    result
}

fn remember_discovery(cwd: &Path, needle: &str, items: &[Suggestion]) {
    let files: Vec<_> = items
        .iter()
        .filter(|item| !item.directory)
        .map(|item| item.path.clone())
        .collect();
    let session = std::env::var("RG_FFF_SESSION").unwrap_or_default();
    crate::feedback::remember_files(cwd, needle, &session, &files);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = PathBuf::from("/tmp").join(format!(
                "fff-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn isolated(name: &str, cold: bool) -> bool {
        let name = format!("files::tests::{name}");
        if std::env::var("RG_FFF_FILES_TEST_CASE").as_deref() == Ok(&name) {
            return false;
        }
        let fixture = Fixture::new();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &name, "--nocapture"])
            .env("RG_FFF_FILES_TEST_CASE", &name)
            .env("RG_FFF_STATE_DIR", fixture.0.join("state"))
            .env("RG_FFF_SESSION", "synthetic-filename-session");
        if cold {
            command.env("RG_FFF_NO_DAEMON", "1");
        } else {
            command.env_remove("RG_FFF_NO_DAEMON");
        }
        assert!(command.status().unwrap().success());
        true
    }

    #[test]
    fn nested_filename_history_uses_request_cwd_with_a_shared_project_picker() {
        if isolated(
            "nested_filename_history_uses_request_cwd_with_a_shared_project_picker",
            true,
        ) {
            return;
        }
        let fixture = Fixture::new();
        git2::Repository::init_opts(
            &fixture.0,
            git2::RepositoryInitOptions::new().external_template(false),
        )
        .unwrap();
        let cwd = fixture.0.join("nested");
        fs::create_dir(&cwd).unwrap();
        for name in ["source_a.ts", "source_b.ts"] {
            fs::write(cwd.join(name), "synthetic\n").unwrap();
        }
        fs::write(fixture.0.join("source_other.ts"), "synthetic\n").unwrap();
        let shared = fff_search::SharedFilePicker::default();
        FilePicker::new_with_shared_state(
            shared.clone(),
            crate::ranking::shared_frecency(),
            crate::ranking::picker_options(&fixture.0, false),
        )
        .unwrap();
        assert!(shared.wait_for_scan(std::time::Duration::from_secs(5)));
        let guard = shared.read().unwrap();
        let picker = guard.as_ref().unwrap();
        let request = FileRequest {
            cwd: cwd.join("."),
            query: "./source".into(),
            limit: 100,
        };
        let items = suggest(picker, &request).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items
            .iter()
            .all(|item| !item.directory && !item.path.contains('/')));
        let selected = cwd.join(&items.last().unwrap().path);
        remember_discovery(&request.cwd, &request.query, &items);
        assert_eq!(crate::feedback::preferred(&cwd, &request.query), None);
        crate::feedback::record_access(&fixture.0, &selected, "synthetic-filename-session");
        assert_eq!(
            crate::feedback::preferred(&cwd, &request.query),
            Some(selected.clone())
        );
        assert_eq!(crate::feedback::preferred(&fixture.0, &request.query), None);
        let learned = suggest(picker, &request).unwrap();
        assert_eq!(cwd.join(&learned[0].path), selected);
    }

    #[test]
    fn cold_filename_discovery_learns_raw_query_only_after_a_selected_read() {
        if isolated(
            "cold_filename_discovery_learns_raw_query_only_after_a_selected_read",
            true,
        ) {
            return;
        }
        let fixture = Fixture::new();
        for name in ["source_a.ts", "source_b.ts", "unseen.ts"] {
            fs::write(fixture.0.join(name), "synthetic\n").unwrap();
        }
        fs::create_dir(fixture.0.join("source_dir")).unwrap();
        let query = "./source";
        let items = discover(&fixture.0, query, 100).unwrap();
        let files: Vec<_> = items.iter().filter(|item| !item.directory).collect();
        assert_eq!(files.len(), 2);
        let selected = fixture.0.join(&files.last().unwrap().path);
        assert_eq!(crate::feedback::preferred(&fixture.0, query), None);
        crate::feedback::record_access(
            &fixture.0,
            Path::new("unseen.ts"),
            "synthetic-filename-session",
        );
        assert_eq!(crate::feedback::preferred(&fixture.0, query), None);
        crate::feedback::record_access(&fixture.0, &selected, "synthetic-filename-session");
        assert_eq!(
            crate::feedback::preferred(&fixture.0, query),
            Some(selected.clone())
        );
        let learned = discover(&fixture.0, query, 100).unwrap();
        assert_eq!(
            fixture
                .0
                .join(&learned.iter().find(|item| !item.directory).unwrap().path),
            selected
        );
    }

    #[test]
    fn warm_filename_discovery_remembers_file_candidates_without_teaching_previews() {
        if isolated(
            "warm_filename_discovery_remembers_file_candidates_without_teaching_previews",
            false,
        ) {
            return;
        }
        let fixture = Fixture::new();
        for name in ["warm_a.ts", "warm_b.ts", "unseen.ts"] {
            fs::write(fixture.0.join(name), "synthetic\n").unwrap();
        }
        fs::create_dir(fixture.0.join("warm_dir")).unwrap();
        let items: Vec<_> = [
            ("warm_a.ts", false),
            ("warm_b.ts", false),
            ("warm_dir/", true),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (path, directory))| Suggestion {
            path: path.into(),
            score: index as f64,
            directory,
            dirty: false,
        })
        .collect();
        let body = serde_json::to_vec(&items).unwrap();
        let socket = crate::daemon::socket_path(&fixture.0).unwrap();
        let listener = UnixListener::bind(socket).unwrap();
        let worker = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            let mut request = String::new();
            connection.read_to_string(&mut request).unwrap();
            assert!(request.starts_with(&format!("{}\nsuggest\n", crate::daemon::PROTO)));
            write!(connection, "0\n{}\n", body.len()).unwrap();
            connection.write_all(&body).unwrap();
        });
        let result = discover(&fixture.0, "warm", 100).unwrap();
        worker.join().unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(crate::feedback::preferred(&fixture.0, "warm"), None);
        crate::feedback::record_access(
            &fixture.0,
            Path::new("warm_dir"),
            "synthetic-filename-session",
        );
        crate::feedback::record_access(
            &fixture.0,
            Path::new("unseen.ts"),
            "synthetic-filename-session",
        );
        assert_eq!(crate::feedback::preferred(&fixture.0, "warm"), None);
        crate::feedback::record_access(
            &fixture.0,
            Path::new("warm_b.ts"),
            "synthetic-filename-session",
        );
        assert_eq!(
            crate::feedback::preferred(&fixture.0, "warm"),
            Some(fixture.0.join("warm_b.ts"))
        );
    }
}
