use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fff_search::file_picker::FilePicker;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Access {
    path: PathBuf,
    time: u64,
    count: u32,
}

#[derive(Serialize, Deserialize)]
pub struct ScopeRequest {
    pub cwd: PathBuf,
    pub session: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    indexed_files: usize,
    git_modified_files: usize,
    recent_session_files: usize,
    recent_session_directories: usize,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn history(session: &str, update: impl FnOnce(&mut Vec<Access>)) -> Option<Vec<Access>> {
    if session.is_empty()
        || session.len() > 128
        || !session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let key = session.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    let dir = crate::ranking::state_dir()?.join("navigation");
    crate::ranking::private_dir(&dir)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join(format!("{key:016x}.json")))
        .ok()?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return None;
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(256 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let mut accesses: Vec<Access> = serde_json::from_slice(&bytes).unwrap_or_default();
    accesses.retain(|a| now().saturating_sub(a.time) < 24 * 60 * 60);
    update(&mut accesses);
    if accesses.len() > 64 {
        accesses.drain(..accesses.len() - 64);
    }
    let mut data = serde_json::to_vec(&accesses).ok()?;
    while data.len() > 256 * 1024 && !accesses.is_empty() {
        accesses.remove(0);
        data = serde_json::to_vec(&accesses).ok()?;
    }
    file.seek(SeekFrom::Start(0)).ok()?;
    file.set_len(0).ok()?;
    file.write_all(&data).ok()?;
    Some(accesses)
}

pub fn record(cwd: &Path, path: &Path, session: &str) {
    let (Ok(cwd), Ok(path)) = (fs::canonicalize(cwd), fs::canonicalize(cwd.join(path))) else {
        return;
    };
    if !path.starts_with(&cwd) || !path.is_file() {
        return;
    }
    let _ = history(session, |accesses| {
        let count = accesses
            .iter()
            .find(|a| a.path == path)
            .map_or(1, |a| a.count.saturating_add(1));
        accesses.retain(|a| a.path != path);
        accesses.push(Access {
            path,
            time: now(),
            count,
        });
    });
}

pub fn pointers(cwd: &Path, session: &str) -> Vec<String> {
    let Ok(cwd) = fs::canonicalize(cwd) else {
        return Vec::new();
    };
    let mut accesses = history(session, |_| {}).unwrap_or_default();
    let frecency = crate::ranking::shared_frecency();
    let guard = frecency.read().ok();
    let tracker = guard.as_ref().and_then(|value| value.as_ref());
    accesses.sort_by(|a, b| {
        let weight = |item: &Access| {
            tracker.map_or(i64::from(item.count), |t| {
                t.get_access_score(&item.path, fff_search::FFFMode::Ai)
            })
        };
        weight(b)
            .cmp(&weight(a))
            .then_with(|| b.time.cmp(&a.time))
            .then_with(|| a.path.cmp(&b.path))
    });
    accesses
        .into_iter()
        .filter_map(|access| {
            let path = fs::canonicalize(&access.path).ok()?;
            if path != access.path || !path.is_file() {
                return None;
            }
            let relative = path.strip_prefix(&cwd).ok()?.to_str()?.to_string();
            if relative.len() > 240 || relative.chars().any(char::is_control) {
                return None;
            }
            Some(relative)
        })
        .collect()
}

pub fn scope(picker: &FilePicker, request: &ScopeRequest) -> Option<Scope> {
    let cwd = fs::canonicalize(&request.cwd).ok()?;
    if !cwd.starts_with(&picker.base_path) {
        return None;
    }
    let mut indexed_files = 0;
    let mut git_modified_files = 0;
    for file in picker.get_files() {
        if file
            .absolute_path(picker, &picker.base_path)
            .starts_with(&cwd)
        {
            indexed_files += 1;
            if file
                .git_status
                .is_some_and(fff_search::git::is_modified_status)
            {
                git_modified_files += 1;
            }
        }
    }
    let paths = pointers(&cwd, &request.session);
    let directories: std::collections::HashSet<_> =
        paths.iter().filter_map(|p| Path::new(p).parent()).collect();
    Some(Scope {
        indexed_files,
        git_modified_files,
        recent_session_files: paths.len(),
        recent_session_directories: directories.len(),
    })
}

pub fn query_scope(cwd: &Path, session: &str) -> Option<Scope> {
    if std::env::var_os("RG_FFF_NO_DAEMON").is_some() {
        return None;
    }
    let request = ScopeRequest {
        cwd: fs::canonicalize(cwd).ok()?,
        session: session.to_string(),
    };
    let (body, status) = crate::daemon::rpc(cwd, "scope", &serde_json::to_string(&request).ok()?)?;
    if status != 0 {
        return None;
    }
    serde_json::from_str(&body).ok()
}
