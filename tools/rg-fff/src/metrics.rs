use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;

pub fn record(tool: &str, decision: &str) {
    let Some(dir) = crate::ranking::state_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir.join("metrics.tsv"))
    else {
        return;
    };
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return;
    }
    if file
        .metadata()
        .map(|m| m.len() > 128 * 1024)
        .unwrap_or(false)
    {
        let _ = file.set_len(0);
    }
    let _ = writeln!(file, "{tool}\t{decision}");
}

pub fn stats() -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    if let Some(dir) = crate::ranking::state_dir() {
        if let Ok(body) = std::fs::read_to_string(dir.join("metrics.tsv")) {
            for line in body.lines() {
                *counts.entry(line.to_string()).or_default() += 1;
            }
        }
    }
    counts
}
