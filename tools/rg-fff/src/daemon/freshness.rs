use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fingerprint {
    device: u64,
    inode: u64,
    size: u64,
    modified: i64,
    modified_nanos: i64,
    changed: i64,
    changed_nanos: i64,
}

impl Fingerprint {
    fn read(path: &Path) -> Option<Self> {
        let metadata = fs::symlink_metadata(path).ok()?;
        if !metadata.is_file()
            || metadata.len() > 10 * 1024 * 1024
            || fs::canonicalize(path).ok()?.as_path() != path
        {
            return None;
        }
        Some(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified: metadata.mtime(),
            modified_nanos: metadata.mtime_nsec(),
            changed: metadata.ctime(),
            changed_nanos: metadata.ctime_nsec(),
        })
    }

    fn reusable(self) -> bool {
        (1..1_000_000_000).contains(&self.changed_nanos)
    }
}

#[derive(Default)]
pub(super) struct FreshnessCache {
    files: HashMap<PathBuf, Fingerprint>,
}

impl FreshnessCache {
    pub(super) fn refresh(
        &mut self,
        paths: &[PathBuf],
        refresh: impl FnMut(&Path) -> Option<()>,
    ) -> Option<()> {
        self.refresh_with(paths, Fingerprint::read, refresh)
    }

    fn refresh_with(
        &mut self,
        paths: &[PathBuf],
        mut fingerprint: impl FnMut(&Path) -> Option<Fingerprint>,
        mut refresh: impl FnMut(&Path) -> Option<()>,
    ) -> Option<()> {
        let inventory: Vec<_> = paths
            .iter()
            .map(|path| Some((path, fingerprint(path)?)))
            .collect::<Option<_>>()?;
        let current: HashSet<_> = paths.iter().collect();
        self.files.retain(|path, _| current.contains(path));
        for (path, before) in inventory {
            if !before.reusable() || self.files.get(path) != Some(&before) {
                if refresh(path).is_none() {
                    self.files.remove(path);
                    return None;
                }
            }
            if fingerprint(path) != Some(before) {
                self.files.remove(path);
                return None;
            }
            if before.reusable() {
                self.files.insert(path.clone(), before);
            } else {
                self.files.remove(path);
            }
        }
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = PathBuf::from("/tmp").join(format!(
                "fff-freshness-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }

        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, "original\n").unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn refresh(cache: &mut FreshnessCache, paths: &[PathBuf], calls: &mut usize) -> Option<()> {
        cache.refresh(paths, |_| {
            *calls += 1;
            Some(())
        })
    }

    fn restore_times(path: &Path, metadata: &fs::Metadata) {
        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let times = [
            libc::timespec {
                tv_sec: metadata.atime(),
                tv_nsec: metadata.atime_nsec(),
            },
            libc::timespec {
                tv_sec: metadata.mtime(),
                tv_nsec: metadata.mtime_nsec(),
            },
        ];
        assert_eq!(
            unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), 0) },
            0
        );
    }

    #[test]
    fn unchanged_inventory_preserves_sdk_cache_and_prunes_unselected_paths() {
        let fixture = Fixture::new();
        let first = fixture.file("first.txt");
        let second = fixture.file("second.txt");
        let mut cache = FreshnessCache::default();
        let mut calls = 0;
        let paths = [first.clone(), second.clone()];
        assert_eq!(refresh(&mut cache, &paths, &mut calls), Some(()));
        assert_eq!(calls, 2);
        assert_eq!(refresh(&mut cache, &paths, &mut calls), Some(()));
        assert_eq!(calls, 2);
        assert_eq!(refresh(&mut cache, &[first], &mut calls), Some(()));
        assert_eq!(cache.files.len(), 1);
        assert_eq!(refresh(&mut cache, &[second], &mut calls), Some(()));
        assert_eq!(calls, 3);
        assert_eq!(cache.files.len(), 1);
    }

    #[test]
    fn restored_mtime_writes_atomic_replacement_and_chmod_refresh() {
        let fixture = Fixture::new();
        let path = fixture.file("source.txt");
        let mut cache = FreshnessCache::default();
        let mut calls = 0;
        let paths = [path.clone()];
        refresh(&mut cache, &paths, &mut calls).unwrap();
        let original = fs::metadata(&path).unwrap();
        fs::write(&path, "modified\n").unwrap();
        restore_times(&path, &original);
        let updated = fs::metadata(&path).unwrap();
        assert_eq!(
            (updated.mtime(), updated.mtime_nsec()),
            (original.mtime(), original.mtime_nsec())
        );
        assert_eq!(updated.len(), original.len());
        refresh(&mut cache, &paths, &mut calls).unwrap();
        assert_eq!(calls, 2);
        let replacement = fixture.file("replacement.txt");
        restore_times(&replacement, &original);
        fs::rename(replacement, &path).unwrap();
        refresh(&mut cache, &paths, &mut calls).unwrap();
        assert_eq!(calls, 3);
        let mode = fs::metadata(&path).unwrap().mode();
        fs::set_permissions(&path, fs::Permissions::from_mode((mode & 0o777) ^ 0o100)).unwrap();
        refresh(&mut cache, &paths, &mut calls).unwrap();
        assert_eq!(calls, 4);
    }

    #[test]
    fn invalid_inventory_and_unstable_refresh_do_not_accept_cache_entries() {
        let fixture = Fixture::new();
        let path = fixture.file("source.txt");
        let missing = fixture.0.join("missing.txt");
        let mut cache = FreshnessCache::default();
        let mut calls = 0;
        assert_eq!(
            refresh(&mut cache, &[path.clone(), missing], &mut calls),
            None
        );
        assert_eq!(calls, 0);
        assert_eq!(
            cache.refresh(&[path.clone()], |path| {
                fs::write(path, "changed content\n").unwrap();
                Some(())
            }),
            None
        );
        assert!(cache.files.is_empty());
        assert_eq!(refresh(&mut cache, &[path], &mut calls), Some(()));
        assert_eq!(calls, 1);
    }

    #[test]
    fn unknown_change_time_precision_never_skips_refresh() {
        let fixture = Fixture::new();
        let path = fixture.file("source.txt");
        let mut cache = FreshnessCache::default();
        let mut calls = 0;
        for _ in 0..2 {
            assert_eq!(
                cache.refresh_with(
                    &[path.clone()],
                    |path| {
                        let mut fingerprint = Fingerprint::read(path)?;
                        fingerprint.changed_nanos = 0;
                        Some(fingerprint)
                    },
                    |_| {
                        calls += 1;
                        Some(())
                    }
                ),
                Some(())
            );
        }
        assert_eq!(calls, 2);
        assert!(cache.files.is_empty());
    }
}
