//! Warm-index daemon: a per-root, long-lived fff `FilePicker` behind a Unix
//! domain socket. fff's background watcher keeps the index fresh, so the daemon
//! answers grep queries instantly without paying the cold directory scan each
//! time.
//!
//! Strictly an optimization. If no daemon is running, the socket is stale, or
//! anything fails, the client cold-scans (and lazily spawns a daemon for next
//! time). Correctness never depends on the daemon — only latency.
//!
//! Protocol (client -> daemon), 9 newline-terminated lines:
//!   v5
//!   plain|regex|fuzzy
//!   flags: files_only(l) line_numbers(n) count(c) ignore_case(i) hidden(h)
//!          sep_between_files(s) — each char or '-'    e.g. "-n--hs"
//!   <dir_prefixes comma-joined, e.g. "app/,lib/" or empty=cwd>
//!   <pattern>
//!   <path_prefix>
//!   <before_context>
//!   <after_context>
//!   <include_exts comma-joined, e.g. ".ts,.tsx" or empty>
//! Response (daemon -> client): the literal "FALLBACK\n" (daemon can't serve ->
//! client cold-scans), OR `<exit_code>\n<body_byte_len>\n<body>` — the client
//! verifies it received exactly body_byte_len bytes, so a daemon killed mid-write
//! is detected (short read -> cold-scan) rather than silently under-reporting.
//! The version tag ("v5") makes an older daemon reject a newer client cleanly, and
//! is embedded in the socket filename so versions never share a socket.

use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{fs, thread};

mod freshness;

use fff_search::file_picker::FilePicker;
use fff_search::SharedFilePicker;

use crate::{format_results, Mode, SearchOutput, SearchReq};

const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const QUERY_READ_TIMEOUT: Duration = Duration::from_secs(3);
const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const WATCHER_TIMEOUT: Duration = Duration::from_secs(10);
const WATCHDOG_TICK: Duration = Duration::from_secs(5);
const MAX_REQUEST: usize = 2 * 1024 * 1024;
const MAX_RESPONSE: usize = 32 * 1024 * 1024;

/// FNV-1a — deterministic across processes (DefaultHasher is not), so client and
/// daemon agree on the socket name for a given root.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn daemons_dir() -> Option<PathBuf> {
    let state = crate::ranking::state_dir()?;
    let normal = state.join("daemons");
    let dir = if normal.as_os_str().len() > 65 {
        PathBuf::from("/tmp")
            .join(format!(".rg-fff-{}", unsafe { libc::geteuid() }))
            .join(format!("{:016x}", fnv1a(&state.to_string_lossy())))
    } else {
        normal
    };
    if dir.starts_with("/tmp") {
        crate::ranking::private_dir(dir.parent()?)?;
    }
    crate::ranking::private_dir(&dir)?;
    Some(dir)
}

pub fn repository_root(cwd: &Path) -> PathBuf {
    git2::Repository::discover(cwd)
        .ok()
        .and_then(|repo| repo.workdir().map(Path::to_path_buf))
        .and_then(|p| fs::canonicalize(p).ok())
        .unwrap_or_else(|| fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf()))
}

fn connect_result(path: &Path, timeout: Duration) -> std::io::Result<UnixStream> {
    let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
    socket.connect_timeout(&socket2::SockAddr::unix(path)?, timeout)?;
    let owned: std::os::fd::OwnedFd = socket.into();
    Ok(UnixStream::from(owned))
}

fn connect(path: &Path, timeout: Duration) -> Option<UnixStream> {
    connect_result(path, timeout).ok()
}

fn lock_file(sock: &Path) -> Option<fs::File> {
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .mode(0o600)
        .open(sock.with_extension("lock"))
        .ok()?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return None;
    }
    Some(file)
}

fn bounded_read(stream: &mut UnixStream, limit: usize, timeout: Duration) -> Option<Vec<u8>> {
    stream.set_nonblocking(true).ok()?;
    let deadline = Instant::now() + timeout;
    let mut data = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    while Instant::now() < deadline {
        match stream.read(&mut buffer) {
            Ok(0) => return Some(data),
            Ok(n) => {
                if data.len() + n > limit {
                    return None;
                }
                data.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2))
            }
            Err(_) => return None,
        }
    }
    None
}

fn bounded_write(stream: &mut UnixStream, bytes: &[u8], timeout: Duration) -> Option<()> {
    stream.set_nonblocking(true).ok()?;
    let deadline = Instant::now() + timeout;
    let mut offset = 0;
    while offset < bytes.len() && Instant::now() < deadline {
        match stream.write(&bytes[offset..]) {
            Ok(0) => return None,
            Ok(n) => offset += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2))
            }
            Err(_) => return None,
        }
    }
    (offset == bytes.len()).then_some(())
}

pub fn rpc(root: &Path, operation: &str, payload: &str) -> Option<(String, i32)> {
    let sock = socket_path(&repository_root(root))?;
    let mut stream = connect(&sock, Duration::from_millis(150))?;
    let request = format!("{PROTO}\n{operation}\n{payload}\n");
    if request.len() > MAX_REQUEST {
        return None;
    }
    bounded_write(&mut stream, request.as_bytes(), Duration::from_secs(1))?;
    stream.shutdown(Shutdown::Write).ok()?;
    let response = bounded_read(&mut stream, MAX_RESPONSE, QUERY_READ_TIMEOUT)?;
    parse_daemon_response(std::str::from_utf8(&response).ok()?)
}

/// Wire protocol version. Bumped on any breaking change to the request/response
/// shape. Embedded in BOTH the handshake (an old daemon rejects a newer client)
/// AND the socket filename (so a post-upgrade binary opens its OWN socket instead
/// of colliding with a still-running old-format daemon that holds the old name —
/// otherwise the new daemon can't bind and the root stays cold until the old one
/// idle-times-out).
pub const PROTO: &str = "v11";

pub fn socket_path(root: &Path) -> Option<PathBuf> {
    let dir = daemons_dir()?;
    let key = format!("{:016x}", fnv1a(&root.to_string_lossy()));
    Some(dir.join(format!("{key}-{PROTO}.sock")))
}

/// Client: try to satisfy a search via a running daemon for `root`.
/// Returns None on any error / no daemon — caller then cold-scans.
pub fn query(root: &Path, req: &SearchReq) -> Option<SearchOutput> {
    // A pattern with an embedded newline can't survive the line protocol; let
    // the cold path (which never serializes it) handle that rare case.
    if req.pattern.contains('\n') || req.dir_prefixes.iter().any(|d| d.contains('\n')) {
        return None;
    }
    let (body, code) = rpc(root, "search", &serde_json::to_string(req).ok()?)?;
    let result: SearchOutput = serde_json::from_str(&body).ok()?;
    (result.code == code).then_some(result)
}

pub fn refresh_access(root: &Path, path: &Path) {
    let Some(sock) = socket_path(&repository_root(root)) else {
        return;
    };
    let Some(mut stream) = connect(&sock, Duration::from_millis(100)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    if !path.to_string_lossy().contains('\n') {
        let _ = write!(stream, "{PROTO}\naccess\n{}\n", path.display());
        let _ = stream.shutdown(Shutdown::Write);
    }
}

/// Parse a daemon response: `FALLBACK\n` -> None (cold-scan), or the length-framed
/// `<exit_code>\n<byte_len>\n<body>` -> Some((body, code)). Returns None on any
/// short/garbled read (e.g. daemon killed mid-write) so the caller cold-scans
/// instead of serving a truncated, under-reporting result.
fn parse_daemon_response(resp: &str) -> Option<(String, i32)> {
    let (first, rest) = resp.split_once('\n')?;
    if first == "FALLBACK" {
        return None;
    }
    let code: i32 = first.trim().parse().ok()?;
    let (len_line, body) = rest.split_once('\n')?;
    let expected: usize = len_line.trim().parse().ok()?;
    if !matches!(code, 0 | 1) || expected > MAX_RESPONSE || body.len() != expected {
        return None;
    }
    Some((body.to_string(), code))
}

/// Client: spawn a detached daemon for `root`. Best-effort, never blocks; null
/// stdio + setsid so it outlives the Claude Code Bash command that started it.
pub fn spawn_detached(root: &Path) {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    if std::env::var_os("RG_FFF_NO_DAEMON").is_some() {
        return;
    }
    let root = repository_root(root);
    let Some(sock) = socket_path(&root) else {
        return;
    };
    if sock
        .with_extension("backoff")
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < Duration::from_secs(60))
        .unwrap_or(false)
    {
        return;
    }
    let Some(lock) = lock_file(&sock) else {
        return;
    };
    drop(lock);
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut cmd = Command::new(exe);
    cmd.arg("--daemon")
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid in the child only detaches it into a new session; no shared
    // state is touched between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let _ = cmd.spawn();
}

struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn resident_bytes() -> Option<u64> {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return None;
    }
    #[cfg(target_os = "macos")]
    let scale = 1;
    #[cfg(not(target_os = "macos"))]
    let scale = 1024;
    Some(usage.ru_maxrss as u64 * scale)
}

fn cleanup_stale(dir: &Path) {
    let deadline = Instant::now() + Duration::from_secs(1);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if Instant::now() > deadline {
            break;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if path.extension().is_some_and(|ext| ext == "sock")
            && metadata.file_type().is_socket()
            && metadata.uid() == unsafe { libc::geteuid() }
        {
            if connect_result(&path, Duration::from_millis(50))
                .err()
                .is_some_and(|err| err.kind() == std::io::ErrorKind::ConnectionRefused)
            {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// Daemon entry point. Serves `root` until idle, then exits.
pub fn serve(root_arg: &str) {
    let root = repository_root(Path::new(root_arg));
    if !root.is_dir() {
        return;
    }
    let sock = match socket_path(&root) {
        Some(s) => s,
        None => return,
    };
    if let Some(parent) = sock.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Single daemon per root: if one already answers, step aside. The residual
    // TOCTOU between this connect() and the bind() below is benign and self-healing:
    // if two cold searches race to spawn, the last bind wins and the loser's socket
    // is unlinked, so every client reaches the live socket or cold-scans — never a
    // wrong result — and the orphaned daemon idle-times-out. A flock would close the
    // window but isn't worth it for a bounded, correctness-neutral race.
    let Some(_lock) = lock_file(&sock) else {
        return;
    };
    cleanup_stale(sock.parent().unwrap());
    if std::env::var_os("RG_FFF_STATE_DIR").is_none() {
        if let Some(home) = std::env::var_os("HOME") {
            cleanup_stale(&PathBuf::from(home).join(".tweakcc/fff/daemons"));
        }
    }
    if let Ok(metadata) = fs::symlink_metadata(&sock) {
        if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
            return;
        }
    }
    if connect(&sock, Duration::from_millis(100)).is_some() {
        return;
    }
    let _ = fs::remove_file(&sock); // clear a stale socket
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(_) => return,
    };

    let _ = fs::set_permissions(&sock, fs::Permissions::from_mode(0o600));
    let last = Arc::new(Mutex::new(Instant::now()));

    // Watchdog: self-terminate when idle or after the root disappears, so no
    // daemon is ever leaked. (Index freshness is the watcher's job, not ours.)
    {
        let last = last.clone();
        let sock = sock.clone();
        let root = root.clone();
        thread::spawn(move || loop {
            thread::sleep(WATCHDOG_TICK);
            let idle = last.lock().map(|t| t.elapsed()).unwrap_or(Duration::ZERO);
            let idle_limit = std::env::var("RG_FFF_IDLE_SECONDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(IDLE_TIMEOUT);
            let memory_limit = std::env::var("RG_FFF_MAX_RSS_MB")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(256)
                .clamp(32, 1024)
                * 1024
                * 1024;
            let exceeded = resident_bytes()
                .map(|rss| rss > memory_limit)
                .unwrap_or(false);
            if exceeded {
                let _ = fs::write(sock.with_extension("backoff"), b"memory-budget");
            }
            if idle > idle_limit || !root.exists() || exceeded {
                let _ = fs::remove_file(&sock);
                std::process::exit(0);
            }
        });
    }
    let shared = SharedFilePicker::default();
    let frecency = crate::ranking::shared_frecency();
    if FilePicker::new_with_shared_state(
        shared.clone(),
        frecency.clone(),
        crate::ranking::picker_options(&root, true),
    )
    .is_err()
    {
        let _ = fs::remove_file(&sock);
        return;
    }
    if !shared.wait_for_scan(SCAN_TIMEOUT) {
        let _ = fs::remove_file(&sock);
        return;
    }
    // The watcher must be READY before we serve, or file creates/edits made after
    // startup are missed. The accept loop below is reached only AFTER this wait, so
    // connections queued during startup are served with a ready index, and fff's
    // watcher then keeps it live (handle_create_or_modify). CAVEAT: this wait is
    // time-bounded — if a pathological watcher init TIMES OUT, the daemon proceeds
    // anyway (liveness over a hung daemon), leaving a brief window where a just-made
    // edit is missed until the watcher catches up. That is bounded and only ever
    // costs a redundant Read, never a wrong match (the scanned index is current as
    // of scan time, and any uncertainty falls back to a cold scan).
    if !shared.wait_for_watcher(WATCHER_TIMEOUT) {
        let _ = fs::remove_file(&sock);
        return;
    }

    // (No frecency keep-alive needed: new_with_shared_state cloned the Arc into the
    // background scan thread, which owns its own refcount — the local binding is not
    // load-bearing, matching the two main.rs picker sites that just drop it.)

    let active = Arc::new(AtomicUsize::new(0));
    let freshness = Arc::new(Mutex::new(freshness::FreshnessCache::default()));
    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        if active
            .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |n| {
                (n < 4).then_some(n + 1)
            })
            .is_err()
        {
            let mut stream = stream;
            let _ = bounded_write(&mut stream, b"FALLBACK\n", Duration::from_millis(50));
            continue;
        }
        let shared = shared.clone();
        let permit = Permit(active.clone());
        let last = last.clone();
        let freshness = freshness.clone();
        let _ = thread::Builder::new().spawn(move || {
            let _permit = permit;
            handle(stream, &shared, &last, &freshness);
        });
    }
}

fn refresh_inventory(
    picker: &mut FilePicker,
    request: &SearchReq,
    freshness: &mut freshness::FreshnessCache,
) -> Option<()> {
    let cwd = fs::canonicalize(&request.cwd).ok()?;
    if cwd != Path::new(&request.cwd) || !cwd.is_dir() || !cwd.starts_with(&picker.base_path) {
        return None;
    }
    let files = request.expected_files.as_ref()?;
    let mut paths = Vec::with_capacity(files.len());
    for name in files {
        let relative = Path::new(name);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || relative.components().collect::<PathBuf>().as_os_str() != relative.as_os_str()
        {
            return None;
        }
        let path = cwd.join(relative);
        paths.push(path);
    }
    freshness.refresh(&paths, |path| {
        if let Some(file) = picker.get_file_by_path(&path) {
            file.set_binary(false);
        }
        picker.handle_create_or_modify(path).map(|_| ())
    })
}

fn handle(
    mut stream: UnixStream,
    shared: &SharedFilePicker,
    last: &Mutex<Instant>,
    freshness: &Mutex<freshness::FreshnessCache>,
) {
    let Some(bytes) = bounded_read(&mut stream, MAX_REQUEST, Duration::from_secs(2)) else {
        return;
    };
    let Ok(body) = std::str::from_utf8(&bytes) else {
        return;
    };
    let lines: Vec<&str> = body.lines().collect();
    let mut out = stream;
    let _ = out.set_nonblocking(false);
    let _ = out.set_write_timeout(Some(Duration::from_secs(2)));
    if lines.len() == 3 && lines[0] == PROTO && lines[1] == "ping" {
        let _ = bounded_write(&mut out, b"0\n5\nREADY", Duration::from_millis(100));
        return;
    }
    if lines.len() == 3 && lines[0] == PROTO && lines[1] == "access" {
        let frecency = crate::ranking::shared_frecency();
        if let (Ok(mut guard), Ok(tracker)) = (shared.write(), frecency.read()) {
            if let (Some(picker), Some(tracker)) = (guard.as_mut(), tracker.as_ref()) {
                let path = Path::new(lines[2]);
                if path.starts_with(&picker.base_path) {
                    picker.handle_create_or_modify(path);
                    let _ = picker.update_single_file_frecency(path, tracker);
                }
            }
        }
        let _ = bounded_write(&mut out, b"0\n0\n", Duration::from_millis(100));
        return;
    }
    if lines.len() == 3 && lines[0] == PROTO && lines[1] == "suggest" {
        let result = serde_json::from_str::<crate::files::FileRequest>(lines[2])
            .ok()
            .and_then(|request| {
                let guard = shared.read().ok()?;
                crate::files::suggest(guard.as_ref()?, &request)
            });
        if let Some(result) = result.and_then(|items| serde_json::to_string(&items).ok()) {
            if let Ok(mut timestamp) = last.lock() {
                *timestamp = Instant::now();
            }
            let response = format!("0\n{}\n{result}", result.len());
            let _ = bounded_write(&mut out, response.as_bytes(), Duration::from_millis(250));
        } else {
            let _ = bounded_write(&mut out, b"FALLBACK\n", Duration::from_millis(100));
        }
        return;
    }
    if lines.len() == 3 && lines[0] == PROTO && lines[1] == "scope" {
        let result = serde_json::from_str::<crate::navigation::ScopeRequest>(lines[2])
            .ok()
            .and_then(|request| {
                let guard = shared.read().ok()?;
                crate::navigation::scope(guard.as_ref()?, &request)
            })
            .and_then(|scope| serde_json::to_string(&scope).ok());
        if let Some(result) = result {
            let response = format!("0\n{}\n{result}", result.len());
            let _ = bounded_write(&mut out, response.as_bytes(), Duration::from_millis(250));
        } else {
            let _ = bounded_write(&mut out, b"FALLBACK\n", Duration::from_millis(100));
        }
        return;
    }
    if lines.len() != 3 || lines[0] != PROTO || lines[1] != "search" {
        let _ = bounded_write(&mut out, b"FALLBACK\n", Duration::from_millis(100));
        return;
    }
    let req: SearchReq = match serde_json::from_str(lines[2]) {
        Ok(req) => req,
        Err(_) => {
            let _ = bounded_write(&mut out, b"FALLBACK\n", Duration::from_millis(100));
            return;
        }
    };

    if let Ok(mut timestamp) = last.lock() {
        *timestamp = Instant::now();
    }
    let result = if matches!(req.mode, Mode::Fuzzy) {
        shared
            .read()
            .ok()
            .and_then(|guard| format_results(guard.as_ref()?, &req))
    } else {
        shared.write().ok().and_then(|mut guard| {
            let picker = guard.as_mut()?;
            let mut inventory = freshness.lock().ok()?;
            refresh_inventory(picker, &req, &mut inventory)?;
            format_results(picker, &req)
        })
    };
    match result.and_then(|result| {
        serde_json::to_string(&result)
            .ok()
            .map(|body| (body, result.code))
    }) {
        Some((body, code)) if body.len() <= MAX_RESPONSE - 64 => {
            // Length-framed: `<code>\n<byte_len>\n<body>`. The client verifies it
            // received exactly byte_len bytes — if the daemon is killed mid-write
            // (OOM/pkill), the short read is detected and the client cold-scans
            // instead of silently serving a truncated (under-reporting) result.
            let response = format!("{code}\n{}\n{body}", body.len());
            let _ = bounded_write(&mut out, response.as_bytes(), Duration::from_secs(2));
        }
        _ => {
            let _ = bounded_write(&mut out, b"FALLBACK\n", Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_response_complete_is_served() {
        // <code>\n<len>\n<body>, len matches body byte length
        let body = "src/a.ts:1:hit\nsrc/b.ts:2:hit\n";
        let resp = format!("0\n{}\n{}", body.len(), body);
        assert_eq!(parse_daemon_response(&resp), Some((body.to_string(), 0)));
    }

    #[test]
    fn parse_response_no_match_empty_body() {
        // exit 1, empty body, len 0 — still a valid complete response
        assert_eq!(parse_daemon_response("1\n0\n"), Some((String::new(), 1)));
    }

    #[test]
    fn parse_response_fallback_is_none() {
        assert_eq!(parse_daemon_response("FALLBACK\n"), None);
    }

    #[test]
    fn parse_response_short_read_is_none() {
        // daemon killed mid-write: declared 100 bytes, only a few arrived ->
        // must reject (None) so the client cold-scans, never serve truncated.
        assert_eq!(parse_daemon_response("0\n100\nsrc/a.ts:1:hi"), None);
        // truncated before the length line at all
        assert_eq!(parse_daemon_response("0\n"), None);
        // garbled code line
        assert_eq!(parse_daemon_response("xx\n3\nabc"), None);
    }

    #[test]
    fn socket_path_embeds_proto_version() {
        // versions must never share a socket (post-upgrade collision guard)
        let p = socket_path(Path::new("/tmp/some/root")).unwrap();
        let name = p.file_name().unwrap().to_string_lossy();
        assert!(name.ends_with(&format!("-{PROTO}.sock")), "got {name}");
    }
}
