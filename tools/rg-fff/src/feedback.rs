use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fff_search::query_tracker::QueryTracker;
use serde::{Deserialize, Serialize};

use crate::ranking;

#[derive(Serialize, Deserialize)]
struct Receipt {
    time: u64,
    query: String,
    root: PathBuf,
    files: HashSet<PathBuf>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn receipt_path(session: &str) -> Option<PathBuf> {
    if session.is_empty() || session.len() > 256 {
        return None;
    }
    let key = session.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    Some(
        ranking::state_dir()?
            .join("receipts")
            .join(format!("{key:016x}.json")),
    )
}

fn with_receipts(session: &str, update: impl FnOnce(&mut Vec<Receipt>)) -> Option<()> {
    let path = receipt_path(session)?;
    fs::create_dir_all(path.parent()?).ok()?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .ok()?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return None;
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(2 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let mut receipts: Vec<Receipt> = serde_json::from_slice(&bytes).unwrap_or_default();
    receipts.retain(|r| now().saturating_sub(r.time) < 300);
    update(&mut receipts);
    if receipts.len() > 32 {
        receipts.drain(..receipts.len() - 32);
    }
    let mut data = serde_json::to_vec(&receipts).ok()?;
    while data.len() > 2 * 1024 * 1024 && !receipts.is_empty() {
        receipts.remove(0);
        data = serde_json::to_vec(&receipts).ok()?;
    }
    file.seek(SeekFrom::Start(0)).ok()?;
    file.set_len(0).ok()?;
    file.write_all(&data).ok()?;
    Some(())
}

fn remember_paths<'a>(
    root: &Path,
    query: &str,
    session: &str,
    names: impl Iterator<Item = &'a str>,
) {
    if session.is_empty() || session.len() > 256 {
        return;
    }
    let Ok(root) = fs::canonicalize(root) else {
        return;
    };
    if !root.is_dir() || root.to_str().is_none() {
        return;
    }
    let mut seen = HashSet::new();
    let mut files = HashSet::new();
    for name in names {
        if !seen.insert(name) {
            continue;
        }
        let Ok(path) = fs::canonicalize(root.join(name)) else {
            continue;
        };
        if path.starts_with(&root) && path.to_str().is_some() && path.is_file() {
            files.insert(path);
            if files.len() == 256 {
                break;
            }
        }
    }
    let _ = with_receipts(session, |receipts| {
        receipts.push(Receipt {
            time: now(),
            query: query.to_string(),
            root,
            files,
        })
    });
}

pub fn remember_files(root: &Path, query: &str, session: &str, files: &[String]) {
    remember_paths(root, query, session, files.iter().map(String::as_str));
}

pub fn record_access(root: &Path, path: &Path, session: &str) {
    let Ok(path) = fs::canonicalize(root.join(path)) else {
        return;
    };
    if !path.is_file() {
        return;
    }
    let shared = ranking::shared_frecency();
    if let Ok(guard) = shared.read() {
        if let Some(tracker) = guard.as_ref() {
            let _ = tracker.track_access(&path);
        }
    }
    let _ = with_receipts(session, |receipts| {
        if let Some(receipt) = receipts.iter().rev().find(|r| r.files.contains(&path)) {
            if let Some(dir) = ranking::state_dir() {
                if let Ok(mut tracker) = QueryTracker::open(dir.join("queries")) {
                    let _ = tracker.track_query_completion(&receipt.query, &receipt.root, &path);
                }
            }
        }
    });
    crate::daemon::refresh_access(root, &path);
}

pub fn preferred(root: &Path, query: &str) -> Option<PathBuf> {
    let root = fs::canonicalize(root).ok()?;
    QueryTracker::open(ranking::state_dir()?.join("queries"))
        .ok()?
        .get_last_query_entry(query, &root, 1)
        .ok()
        .flatten()
        .map(|entry| entry.file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = PathBuf::from("/tmp").join(format!(
                "ffh-{}-{}",
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

    fn isolated(name: &str) -> bool {
        let name = format!("feedback::tests::{name}");
        if std::env::var("RG_FFF_FEEDBACK_TEST_CASE").as_deref() == Ok(&name) {
            return false;
        }
        let fixture = Fixture::new();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env("RG_FFF_FEEDBACK_TEST_CASE", &name)
            .env("RG_FFF_STATE_DIR", fixture.0.join("state"))
            .env("RG_FFF_NO_DAEMON", "1")
            .status()
            .unwrap();
        assert!(status.success());
        true
    }

    #[test]
    fn empty_sessions_do_not_share_query_history() {
        if isolated("empty_sessions_do_not_share_query_history") {
            return;
        }
        assert!(receipt_path("").is_none());
        assert_ne!(receipt_path("first"), receipt_path("second"));
    }

    #[test]
    fn typed_receipts_deduplicate_hits_preserve_colons_and_restrict_scope() {
        if isolated("typed_receipts_deduplicate_hits_preserve_colons_and_restrict_scope") {
            return;
        }
        let fixture = Fixture::new();
        let root = fixture.0.join("repo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("first.rs"), "synthetic\n").unwrap();
        fs::write(root.join("colon:name.rs"), "synthetic\n").unwrap();
        fs::write(fixture.0.join("outside.rs"), "synthetic\n").unwrap();
        fs::create_dir(root.join("directory")).unwrap();
        symlink(root.join("first.rs"), root.join("alias.rs")).unwrap();
        symlink(fixture.0.join("outside.rs"), root.join("foreign.rs")).unwrap();
        let mut files = vec!["first.rs".to_string(); 300];
        files.extend(
            [
                "alias.rs",
                "colon:name.rs",
                "directory",
                "foreign.rs",
                "../outside.rs",
                "missing.rs",
            ]
            .map(String::from),
        );
        remember_files(&root, "synthetic query", "synthetic-session", &files);
        with_receipts("synthetic-session", |receipts| {
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].files.len(), 2);
            assert!(receipts[0].files.contains(&root.join("colon:name.rs")));
        })
        .unwrap();
        assert_eq!(preferred(&root, "synthetic query"), None);
        record_access(&root, Path::new("colon:name.rs"), "synthetic-session");
        assert_eq!(
            preferred(&root, "synthetic query"),
            Some(root.join("colon:name.rs"))
        );
    }

    #[test]
    fn receipt_limit_counts_distinct_files_and_unseen_reads_do_not_complete_queries() {
        if isolated("receipt_limit_counts_distinct_files_and_unseen_reads_do_not_complete_queries")
        {
            return;
        }
        let fixture = Fixture::new();
        let mut files = Vec::new();
        for index in 0..300 {
            let name = format!("file{index:03}.rs");
            fs::write(fixture.0.join(&name), "synthetic\n").unwrap();
            files.push(name);
        }
        remember_files(&fixture.0, "bounded query", "bounded-session", &files);
        with_receipts("bounded-session", |receipts| {
            assert_eq!(receipts[0].files.len(), 256);
            assert!(receipts[0].files.contains(&fixture.0.join("file255.rs")));
            assert!(!receipts[0].files.contains(&fixture.0.join("file256.rs")));
        })
        .unwrap();
        record_access(&fixture.0, Path::new("file299.rs"), "bounded-session");
        assert_eq!(preferred(&fixture.0, "bounded query"), None);
        record_access(&fixture.0, Path::new("file255.rs"), "bounded-session");
        assert_eq!(
            preferred(&fixture.0, "bounded query"),
            Some(fixture.0.join("file255.rs"))
        );
    }
}
