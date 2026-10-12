use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fff_search::query_tracker::QueryTracker;
use serde::{Deserialize, Serialize};

use crate::{ranking, SearchReq};

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
    let data = serde_json::to_vec(&receipts).ok()?;
    file.seek(SeekFrom::Start(0)).ok()?;
    file.set_len(0).ok()?;
    file.write_all(&data).ok()?;
    Some(())
}

pub fn remember(root: &Path, req: &SearchReq, output: &str) {
    if matches!(req.mode, crate::Mode::Fuzzy) {
        return;
    }
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let files = output
        .lines()
        .filter(|l| !l.starts_with('#') && *l != "--")
        .filter_map(|l| {
            let name = if req.files_only {
                l
            } else {
                l.split_once(':')?.0
            };
            fs::canonicalize(root.join(name.strip_prefix("./").unwrap_or(name))).ok()
        })
        .take(256)
        .collect();
    let _ = with_receipts(&req.session, |receipts| {
        receipts.push(Receipt {
            time: now(),
            query: req.pattern.clone(),
            root,
            files,
        })
    });
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
    QueryTracker::open(ranking::state_dir()?.join("queries"))
        .ok()?
        .get_last_query_entry(query, root, 1)
        .ok()
        .flatten()
        .map(|entry| entry.file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_sessions_do_not_share_query_history() {
        assert!(receipt_path("").is_none());
        assert_ne!(receipt_path("first"), receipt_path("second"));
    }
}
