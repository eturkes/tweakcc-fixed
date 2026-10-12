use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub(super) const MAX_OPERANDS: usize = 64;
pub(super) const MAX_PAYLOAD: usize = 32 * 1024;

#[derive(Serialize, Deserialize)]
pub(super) struct FileReceipt {
    pub(super) operand: PathBuf,
    pub(super) path: PathBuf,
    pub(super) device: u64,
    pub(super) inode: u64,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Recording {
    pub(super) cwd: PathBuf,
    pub(super) root: PathBuf,
    pub(super) session: String,
    pub(super) receipt_session: String,
    pub(super) files: Vec<FileReceipt>,
}

fn valid_identity(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub(super) fn capture(files: &[OsString], cwd: &Path, root: &Path) -> Vec<FileReceipt> {
    if files.len() > MAX_OPERANDS {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    files
        .iter()
        .filter_map(|file| {
            let operand = cwd.join(file);
            if operand.to_str().is_none() {
                return None;
            }
            let path = fs::canonicalize(&operand).ok()?;
            if !path.starts_with(root) || path.to_str().is_none() || !seen.insert(path.clone()) {
                return None;
            }
            let metadata = fs::metadata(&path).ok()?;
            metadata.is_file().then_some(FileReceipt {
                operand,
                path,
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        })
        .collect()
}

pub(super) fn recording(files: &[OsString], cwd: &Path) -> Option<Recording> {
    let root = fs::canonicalize(std::env::var_os("RG_FFF_CONTEXT_ROOT")?).ok()?;
    let session = std::env::var("CLAUDE_CODE_SESSION_ID").ok()?;
    let receipt_session = std::env::var("CLAUDE_PID").ok()?;
    if !root.is_dir()
        || root.to_str().is_none()
        || cwd.to_str().is_none()
        || !valid_identity(&session, 128)
        || !valid_identity(&receipt_session, 256)
    {
        return None;
    }
    let files = capture(files, cwd, &root);
    (!files.is_empty()).then_some(Recording {
        cwd: cwd.to_path_buf(),
        root,
        session,
        receipt_session,
        files,
    })
}

pub(super) fn record_worker(payload: &str) {
    if payload.len() > MAX_PAYLOAD {
        return;
    }
    let Ok(record): Result<Recording, _> = serde_json::from_str(payload) else {
        return;
    };
    if record.files.len() > MAX_OPERANDS
        || !valid_identity(&record.session, 128)
        || !valid_identity(&record.receipt_session, 256)
    {
        return;
    }
    let Ok(root) = fs::canonicalize(&record.root) else {
        return;
    };
    if root != record.root || !root.is_dir() {
        return;
    }
    for file in record.files {
        if fs::canonicalize(&file.operand).ok().as_ref() != Some(&file.path) {
            continue;
        }
        let Ok(path) = fs::canonicalize(&file.path) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if path != file.path
            || !path.starts_with(&root)
            || !metadata.is_file()
            || metadata.dev() != file.device
            || metadata.ino() != file.inode
        {
            continue;
        }
        crate::feedback::record_access(&record.cwd, &path, &record.receipt_session);
        crate::navigation::record(&root, &path, &record.session);
    }
}
