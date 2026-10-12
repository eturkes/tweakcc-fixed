use std::ffi::{CString, OsStr, OsString};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::learning::{Recording, MAX_PAYLOAD};
use super::{RECORD_TIMEOUT, WORKER_FLAG};

ctor_lite::ctor! {
    unsafe static INHERITED_PIPE: libc::sigaction = {
        let mut action: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGPIPE, std::ptr::null(), &mut action);
        action
    };
}
const RELAY_SIGNALS: &[libc::c_int] = &[
    libc::SIGHUP,
    libc::SIGINT,
    libc::SIGQUIT,
    libc::SIGTERM,
    libc::SIGUSR1,
    libc::SIGUSR2,
    libc::SIGALRM,
    libc::SIGPIPE,
    libc::SIGTSTP,
    libc::SIGTTIN,
    libc::SIGTTOU,
    libc::SIGCONT,
    libc::SIGXCPU,
    libc::SIGXFSZ,
];
struct RelayEntry {
    signal: libc::c_int,
    original: libc::sigaction,
    installed: libc::sigaction,
    registration: signal_hook_registry::SigId,
}

pub(super) struct SignalRelay {
    child: Arc<AtomicI32>,
    received: Arc<AtomicU64>,
    entries: Vec<RelayEntry>,
    original_child: libc::sigaction,
}

impl SignalRelay {
    pub(super) fn install() -> io::Result<Self> {
        let mut original_child: libc::sigaction = unsafe { std::mem::zeroed() };
        let mut default_child: libc::sigaction = unsafe { std::mem::zeroed() };
        default_child.sa_sigaction = libc::SIG_DFL;
        unsafe {
            libc::sigemptyset(&mut default_child.sa_mask);
        }
        if unsafe { libc::sigaction(libc::SIGCHLD, &default_child, &mut original_child) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let mut relay = Self {
            child: Arc::new(AtomicI32::new(0)),
            received: Arc::new(AtomicU64::new(0)),
            entries: Vec::new(),
            original_child,
        };
        for &signal in RELAY_SIGNALS {
            let mut original: libc::sigaction = unsafe { std::mem::zeroed() };
            if unsafe { libc::sigaction(signal, std::ptr::null(), &mut original) } != 0 {
                return Err(io::Error::last_os_error());
            }
            if original.sa_sigaction == libc::SIG_IGN {
                continue;
            }
            let child = relay.child.clone();
            let received = relay.received.clone();
            let registration = unsafe {
                signal_hook_registry::register(signal, move || {
                    received.fetch_or(1u64 << signal, Ordering::Relaxed);
                    let pid = child.load(Ordering::Relaxed);
                    if pid > 0 {
                        libc::kill(pid, signal);
                    }
                })
            }?;
            let mut installed: libc::sigaction = unsafe { std::mem::zeroed() };
            if unsafe { libc::sigaction(signal, std::ptr::null(), &mut installed) } != 0 {
                signal_hook_registry::unregister(registration);
                unsafe {
                    libc::sigaction(signal, &original, std::ptr::null_mut());
                }
                return Err(io::Error::last_os_error());
            }
            relay.entries.push(RelayEntry {
                signal,
                original,
                installed,
                registration,
            });
        }
        Ok(relay)
    }

    pub(super) fn command(&self, executable: &Path, args: &[OsString], argv0: &OsStr) -> Command {
        let executable = if executable.components().count() == 1 {
            Path::new(".").join(executable)
        } else {
            executable.to_path_buf()
        };
        let mut command = Command::new(executable);
        command
            .args(args)
            .arg0(argv0)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let mut originals: Vec<_> = self
            .entries
            .iter()
            .map(|e| (e.signal, e.original))
            .collect();
        if !originals.iter().any(|(signal, _)| *signal == libc::SIGPIPE) {
            originals.push((libc::SIGPIPE, *INHERITED_PIPE));
        }
        originals.push((libc::SIGCHLD, self.original_child));
        unsafe {
            command.pre_exec(move || {
                for (signal, original) in &originals {
                    if libc::sigaction(*signal, original, std::ptr::null_mut()) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        command
    }

    pub(super) fn attach(&self, child: &Child) {
        self.child.store(child.id() as i32, Ordering::SeqCst);
        let pending = self.received.load(Ordering::SeqCst);
        for &signal in RELAY_SIGNALS {
            if pending & (1u64 << signal) != 0 {
                unsafe {
                    libc::kill(child.id() as i32, signal);
                }
            }
        }
    }

    pub(super) fn cancelled(&self) -> Option<libc::c_int> {
        let received = self.received.load(Ordering::SeqCst);
        RELAY_SIGNALS.iter().copied().find(|s| {
            !matches!(
                *s,
                libc::SIGTSTP | libc::SIGTTIN | libc::SIGTTOU | libc::SIGCONT
            ) && received & (1u64 << s) != 0
        })
    }

    pub(super) fn wait(&self, child: &Child) -> io::Result<ExitStatus> {
        loop {
            let mut status = 0;
            let result = unsafe {
                libc::waitpid(
                    child.id() as i32,
                    &mut status,
                    libc::WUNTRACED | libc::WCONTINUED,
                )
            };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
                self.child.store(0, Ordering::SeqCst);
                return Ok(ExitStatus::from_raw(status));
            }
            if libc::WIFSTOPPED(status) {
                let signal = libc::WSTOPSIG(status);
                if let Some(entry) = self.entries.iter().find(|e| e.signal == signal) {
                    unsafe {
                        libc::sigaction(signal, &entry.original, std::ptr::null_mut());
                        libc::raise(signal);
                        libc::sigaction(signal, &entry.installed, std::ptr::null_mut());
                    }
                } else {
                    unsafe {
                        libc::raise(signal);
                    }
                }
            }
        }
    }
}

impl Drop for SignalRelay {
    fn drop(&mut self) {
        self.child.store(0, Ordering::SeqCst);
        for entry in &self.entries {
            signal_hook_registry::unregister(entry.registration);
            unsafe {
                libc::sigaction(entry.signal, &entry.original, std::ptr::null_mut());
            }
        }
        unsafe {
            libc::sigaction(libc::SIGCHLD, &self.original_child, std::ptr::null_mut());
        }
    }
}

pub(super) fn record_bounded(record: &Recording, image: &Path, relay: &SignalRelay) {
    let Ok(payload) = serde_json::to_string(record) else {
        return;
    };
    if payload.len() > MAX_PAYLOAD || relay.cancelled().is_some() {
        return;
    }
    let mut command = relay.command(
        image,
        &[OsString::from(WORKER_FLAG), payload.into()],
        OsStr::new("rg-fff"),
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return;
    };
    relay.attach(&child);
    let deadline = Instant::now() + RECORD_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline && relay.cancelled().is_none() => {
                std::thread::sleep(Duration::from_millis(2))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    relay.child.store(0, Ordering::SeqCst);
}

pub(super) fn terminate(status: ExitStatus, cancelled: Option<libc::c_int>) -> ! {
    if let Some(signal) = status.signal().or(cancelled) {
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = libc::SIG_DFL;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(signal, &action, std::ptr::null_mut());
            let mut mask: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, signal);
            libc::sigprocmask(libc::SIG_UNBLOCK, &mask, std::ptr::null_mut());
            libc::raise(signal);
            libc::_exit(128 + signal);
        }
    }
    std::process::exit(status.code().unwrap_or(1));
}

pub(super) fn execute_original(path: &Path, args: &[OsString], argv0: &OsStr) -> ! {
    let image = CString::new(path.as_os_str().as_bytes()).unwrap();
    let arguments: Vec<_> = std::iter::once(argv0)
        .chain(args.iter().map(OsString::as_os_str))
        .map(|s| CString::new(s.as_bytes()).unwrap())
        .collect();
    let environment: Vec<_> = std::env::vars_os()
        .map(|(key, value)| {
            let mut bytes = key.as_bytes().to_vec();
            bytes.push(b'=');
            bytes.extend_from_slice(value.as_bytes());
            CString::new(bytes).unwrap()
        })
        .collect();
    let pointers = |values: &[CString]| {
        values
            .iter()
            .map(|s| s.as_ptr())
            .chain(std::iter::once(std::ptr::null()))
            .collect::<Vec<_>>()
    };
    let argv = pointers(&arguments);
    let envp = pointers(&environment);
    unsafe {
        libc::execve(image.as_ptr(), argv.as_ptr(), envp.as_ptr());
    }
    let mut error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOEXEC) {
        let shell_args: Vec<_> = std::iter::once(CString::new("/bin/sh").unwrap())
            .chain(std::iter::once(image))
            .chain(arguments.into_iter().skip(1))
            .collect();
        let argv = pointers(&shell_args);
        unsafe {
            libc::execve(c"/bin/sh".as_ptr(), argv.as_ptr(), envp.as_ptr());
        }
        error = io::Error::last_os_error();
    }
    eprintln!("{}: {error}", argv0.to_string_lossy());
    std::process::exit(if error.kind() == io::ErrorKind::NotFound {
        127
    } else {
        126
    });
}

pub(super) fn restore_pipe() {
    unsafe {
        libc::sigaction(libc::SIGPIPE, &*INHERITED_PIPE, std::ptr::null_mut());
    }
}
