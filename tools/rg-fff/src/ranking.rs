use std::path::PathBuf;

use fff_search::{frecency::FrecencyTracker, SharedFrecency};

pub fn state_dir() -> Option<PathBuf> {
    std::env::var_os("RG_FFF_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".tweakcc/fff/state"))
        })
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
                let req = parse(Tool::Rg, args).to_req(Mode::Plain);
                let (out, code) = format_results(picker, &req).unwrap();
                assert_eq!(code, 0);
                assert!(out.starts_with("z.rs"), "{out}");
                assert!(out.contains("a.rs"));
            }
        }
        drop(shared);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
