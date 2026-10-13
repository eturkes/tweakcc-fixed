use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;

use fff_search::{frecency::FrecencyTracker, SharedFrecency};

pub fn state_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("RG_FFF_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".tweakcc/fff/state"))
        })?;
    private_dir(&dir)?;
    Some(dir)
}

pub fn private_dir(dir: &std::path::Path) -> Option<()> {
    std::fs::create_dir_all(dir).ok()?;
    let metadata = std::fs::symlink_metadata(dir).ok()?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).ok()
}

pub fn picker_options(root: &std::path::Path, watch: bool) -> fff_search::FilePickerOptions {
    fff_search::FilePickerOptions {
        base_path: root.to_string_lossy().into_owned(),
        mode: fff_search::FFFMode::Ai,
        watch,
        cache_budget: fff_search::types::ContentCacheBudget::from_overrides(
            2000,
            64 * 1024 * 1024,
            10 * 1024 * 1024,
        ),
        ..Default::default()
    }
}

pub fn shared_frecency() -> SharedFrecency {
    let shared = SharedFrecency::default();
    if let Some(dir) = state_dir() {
        if let Ok(tracker) = FrecencyTracker::open(dir.join("frecency")) {
            let _ = shared.init(tracker);
        }
    }
    shared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_history_survives_reopening() {
        let dir = std::env::temp_dir().join(format!("rg-fff-history-{}", std::process::id()));
        let file = dir.join("source.rs");
        {
            let tracker = FrecencyTracker::open(&dir).unwrap();
            tracker.track_access(&file).unwrap();
        }
        {
            let tracker = FrecencyTracker::open(&dir).unwrap();
            assert_eq!(tracker.access_count(&file).unwrap(), 1);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn learned_order_survives_count_and_context_rendering() {
        use crate::{format_results, parse, Mode, Tool};
        use fff_search::{file_picker::FilePicker, FFFMode, FilePickerOptions, SharedFilePicker};
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("rg-fff-order-{}", std::process::id()));
        let root = dir.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("a.rs");
        let preferred = root.join("z.rs");
        for file in [&first, &preferred] {
            std::fs::write(file, "before\nneedle\nafter\n").unwrap();
        }
        let tracker = FrecencyTracker::open(dir.join("db")).unwrap();
        for _ in 0..20 {
            tracker.track_access(&preferred).unwrap();
        }
        let frecency = SharedFrecency::default();
        frecency.init(tracker).unwrap();
        let shared = SharedFilePicker::default();
        FilePicker::new_with_shared_state(
            shared.clone(),
            frecency,
            FilePickerOptions {
                base_path: root.to_string_lossy().into_owned(),
                mode: FFFMode::Ai,
                watch: false,
                ..Default::default()
            },
        )
        .unwrap();
        shared.wait_for_scan(Duration::from_secs(5));
        {
            let guard = shared.read().unwrap();
            let picker = guard.as_ref().unwrap();
            for flags in [vec!["-n"], vec!["-c"], vec!["-n", "-C1"]] {
                let mut args: Vec<String> = flags.into_iter().map(String::from).collect();
                args.push("needle".into());
                let mut req = parse(Tool::Rg, args).to_req(Mode::Plain);
                req.cwd = root.to_string_lossy().into_owned();
                let result = format_results(picker, &req).unwrap();
                let (out, code) = (result.body, result.code);
                assert_eq!(code, 0);
                assert!(out.starts_with("z.rs"), "{out}");
                assert!(out.contains("a.rs"));
            }
        }
        drop(shared);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
