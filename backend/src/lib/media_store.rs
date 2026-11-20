//! Media store — the sole reader/writer of attachment content files.
//!
//! Attachment bytes live as files under `<dataDir>/media` (`/data/media` in the
//! container, on the persistent volume); the `MessageAttachment` row keeps only
//! metadata plus `storagePath`, the file's basename. The basename is relative on
//! purpose: the store survives a data-dir relocation, and a stored path can
//! never point outside the media dir.
//!
//! Writes are atomic (temp sibling + rename) so a crash mid-write never leaves
//! a half-file behind under the final name. A file written for a row whose
//! DB insert then failed is invisible to every reader (nothing references it)
//! and is removed by `reap_stray_media_files`, whose grace period covers the
//! write-file-then-create-row window.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::lib::data_dir::resolve_media_dir;

const MAX_FILENAME_BYTES: usize = 255;

// Room for `<uuid>-` (37 bytes) + the `.tmp` suffix inside a 255-byte basename.
const MAX_STORED_NAME_BYTES: usize = 200;

static UNSAFE_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x1f\x7f/\\]").unwrap());

/// Make an untrusted filename safe to use as (part of) a real file's name:
/// basename only, no control chars, no traversal, byte-capped.
pub fn sanitize_filename(raw: &str, fallback: &str) -> String {
    let name = posix_basename(raw);
    // Strip control chars and path separators that snuck past basename
    let name = UNSAFE_CHARS.replace_all(name, "_");
    // Reject directory traversal remnants
    let mut name = name.replace("..", "_");
    // Cap length in bytes (UTF-8 aware)
    if name.len() > MAX_FILENAME_BYTES {
        name = String::from_utf8_lossy(&name.as_bytes()[..MAX_FILENAME_BYTES]).into_owned();
    }
    let name = js_trim(&name);
    // basename('.') is '.', which would resolve to the containing directory
    // itself — as unusable as an empty name.
    if name == "." || name.is_empty() {
        return fallback.to_string();
    }
    name.to_string()
}

/// A storagePath is valid only as a plain basename — anything that could
/// escape the media dir (separators, traversal, absolute paths) is rejected.
/// Guards readers against a tampered DB value.
fn is_safe_storage_path(storage_path: &str) -> bool {
    !storage_path.is_empty()
        && !storage_path.contains('/')
        && !storage_path.contains('\\')
        && !storage_path.contains("..")
        && storage_path == posix_basename(storage_path)
}

/// Byte-cap a sanitized name so `<id>-<name>` stays a legal basename.
fn cap_stored_name(name: &str) -> String {
    if name.len() <= MAX_STORED_NAME_BYTES {
        return name.to_string();
    }
    String::from_utf8_lossy(&name.as_bytes()[..MAX_STORED_NAME_BYTES]).into_owned()
}

/// Write attachment content to the media dir as `<id>-<sanitized filename>`.
/// Atomic: writes a `.tmp` sibling, then renames into place. Returns the
/// basename to persist as the row's `storagePath`.
///
/// Creates the media dir first: `ensure_data_dirs()` creates it at boot, but
/// the temp-dir fallback can repin `PRISM_DATA_DIR` after that.
pub async fn write_media_file(id: &str, filename: &str, data: &[u8]) -> anyhow::Result<String> {
    let media_dir = resolve_media_dir();
    tokio::fs::create_dir_all(&media_dir).await?;

    let storage_path = format!(
        "{id}-{}",
        cap_stored_name(&sanitize_filename(filename, "file"))
    );
    let final_path = Path::new(&media_dir).join(&storage_path);
    let tmp_path = Path::new(&media_dir).join(format!("{storage_path}.tmp"));
    tokio::fs::write(&tmp_path, data).await?;
    tokio::fs::rename(&tmp_path, &final_path).await?;
    Ok(storage_path)
}

/// Read attachment content by its stored basename. Returns `None` when the
/// file is gone (expired / never written / lost) — callers treat that as
/// "content no longer available", not an error. Any other read error is returned.
pub async fn read_media_file(storage_path: &str) -> anyhow::Result<Option<Vec<u8>>> {
    if !is_safe_storage_path(storage_path) {
        return Ok(None);
    }
    match tokio::fs::read(Path::new(&resolve_media_dir()).join(storage_path)).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Basenames of every file currently in the media dir (empty when absent).
pub async fn list_media_files() -> HashSet<String> {
    read_dir_names(&resolve_media_dir())
        .await
        .map(|names| names.into_iter().collect())
        .unwrap_or_default()
}

/// Best-effort unlink. True when the file is gone afterwards.
pub async fn remove_media_file(storage_path: &str) -> bool {
    if !is_safe_storage_path(storage_path) {
        return false;
    }
    match tokio::fs::remove_file(Path::new(&resolve_media_dir()).join(storage_path)).await {
        Ok(()) => true,
        Err(err) => err.kind() == std::io::ErrorKind::NotFound,
    }
}

/// `fs.readdir`: the entry names of a directory.
async fn read_dir_names(dir: &str) -> std::io::Result<Vec<String>> {
    let mut entries = tokio::fs::read_dir(dir).await?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// Delete media files no DB row references. Covers rows removed by cascade
/// (message/thread deletion), rows from a `.prism` import pointing at another
/// install's files, and orphaned `.tmp` siblings. `grace_ms` spares files
/// younger than the write-file-then-create-row window — never shorten it below
/// the hourly sweep interval's safety margin (1 h). Only regular files (by
/// `lstat`) whose mtime is older than now minus `grace_ms` are removed; a
/// missing media dir reaps nothing.
pub async fn reap_stray_media_files(live_storage_paths: &HashSet<String>, grace_ms: i64) -> usize {
    let media_dir = resolve_media_dir();
    let Ok(entries) = read_dir_names(&media_dir).await else {
        return 0;
    };

    let cutoff = crate::support::now_ms() - grace_ms;
    let mut reaped = 0;
    for entry in entries {
        if live_storage_paths.contains(&entry) {
            continue;
        }
        let file_path = Path::new(&media_dir).join(&entry);
        let Ok(st) = tokio::fs::symlink_metadata(&file_path).await else {
            continue;
        };
        if !st.is_file() {
            continue;
        }
        if mtime_ms(&st) >= cutoff as f64 {
            continue;
        }
        // Best effort — a vanished or locked file is someone else's win/problem.
        if tokio::fs::remove_file(&file_path).await.is_ok() {
            reaped += 1;
        }
    }
    reaped
}

/// `stats.mtimeMs`: the modification time in fractional epoch milliseconds.
pub(crate) fn mtime_ms(st: &std::fs::Metadata) -> f64 {
    match st.modified() {
        Ok(time) => match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => d.as_secs_f64() * 1000.0,
            Err(e) => -(e.duration().as_secs_f64() * 1000.0),
        },
        Err(_) => 0.0,
    }
}

/// Node's `path.basename` on POSIX: the last segment after trailing slashes are removed.
fn posix_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    trimmed.rsplit('/').next().unwrap_or("")
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
fn js_trim(text: &str) -> &str {
    crate::support::js::trim(text)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Points `PRISM_DATA_DIR` at a fresh directory for one test, and puts it back.
    /// A test that holds one runs under `#[serial_test::serial]`.
    pub(crate) struct DataDirGuard {
        saved: Option<String>,
        pub tmp: tempfile::TempDir,
    }

    impl DataDirGuard {
        pub(crate) fn new() -> DataDirGuard {
            let saved = std::env::var("PRISM_DATA_DIR").ok();
            let tmp = tempfile::Builder::new()
                .prefix("prism-media-test-")
                .tempdir()
                .unwrap();
            // SAFETY: the tests that touch the environment run serially.
            unsafe { std::env::set_var("PRISM_DATA_DIR", tmp.path()) };
            DataDirGuard { saved, tmp }
        }

        pub(crate) fn media_dir(&self) -> std::path::PathBuf {
            std::path::PathBuf::from(resolve_media_dir())
        }
    }

    impl Drop for DataDirGuard {
        fn drop(&mut self) {
            // SAFETY: the tests that touch the environment run serially.
            unsafe {
                match &self.saved {
                    Some(v) => std::env::set_var("PRISM_DATA_DIR", v),
                    None => std::env::remove_var("PRISM_DATA_DIR"),
                }
            }
        }
    }

    fn age(path: &std::path::Path, ms: u64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_millis(ms);
        file.set_modified(when).unwrap();
    }

    #[test]
    fn sanitize_strips_paths_traversal_and_control_chars() {
        assert_eq!(sanitize_filename("../../etc/passwd", "file"), "passwd");
        assert_eq!(
            sanitize_filename("a/b\\c..d\x00e.txt", "file"),
            "b_c_d_e.txt"
        );
    }

    #[test]
    fn sanitize_falls_back_when_nothing_survives() {
        assert_eq!(sanitize_filename("   ", "file"), "file");
    }

    #[test]
    fn sanitize_falls_back_for_a_dot() {
        assert_eq!(sanitize_filename(".", "file"), "file");
        assert_eq!(sanitize_filename("./", "file"), "file");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn round_trips_bytes_under_id_name_and_leaves_no_temp_file() {
        let g = DataDirGuard::new();
        let data = b"hello media".to_vec();
        let storage_path = write_media_file("abc-123", "report.pdf", &data)
            .await
            .unwrap();

        assert_eq!(storage_path, "abc-123-report.pdf");
        assert_eq!(
            std::fs::read(g.media_dir().join(&storage_path)).unwrap(),
            data
        );
        let tmps: Vec<_> = std::fs::read_dir(g.media_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(tmps.is_empty());

        assert_eq!(read_media_file(&storage_path).await.unwrap(), Some(data));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn caps_a_huge_filename_so_the_basename_stays_legal() {
        let g = DataDirGuard::new();
        let long = format!("{}.bin", "x".repeat(400));
        let storage_path = write_media_file("id-1", &long, b"x").await.unwrap();
        assert!(storage_path.len() <= 255);
        assert!(g.media_dir().join(&storage_path).exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn read_returns_none_for_a_missing_file() {
        let _g = DataDirGuard::new();
        assert_eq!(read_media_file("nope-gone.txt").await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn read_rejects_storage_paths_that_could_escape_the_media_dir() {
        let g = DataDirGuard::new();
        std::fs::create_dir_all(g.media_dir()).unwrap();
        std::fs::write(g.tmp.path().join("secret.txt"), "nope").unwrap();
        assert_eq!(read_media_file("../secret.txt").await.unwrap(), None);
        assert_eq!(read_media_file("/etc/hosts").await.unwrap(), None);
        assert_eq!(read_media_file("a/b.txt").await.unwrap(), None);
        assert_eq!(read_media_file("").await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn remove_unlinks_and_treats_already_gone_as_success() {
        let g = DataDirGuard::new();
        let storage_path = write_media_file("id-2", "x.txt", b"x").await.unwrap();
        assert!(remove_media_file(&storage_path).await);
        assert!(!g.media_dir().join(&storage_path).exists());
        assert!(remove_media_file(&storage_path).await);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn remove_refuses_unsafe_paths() {
        let _g = DataDirGuard::new();
        assert!(!remove_media_file("../outside.txt").await);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reaps_old_unreferenced_files_but_keeps_live_and_young_ones() {
        let g = DataDirGuard::new();
        let live = write_media_file("live-1", "keep.txt", b"keep")
            .await
            .unwrap();
        let stray = write_media_file("stray-1", "old.txt", b"old")
            .await
            .unwrap();
        let young = write_media_file("young-1", "new.txt", b"new")
            .await
            .unwrap();
        let tmp_stray = g.media_dir().join("stray-2-half.bin.tmp");
        std::fs::write(&tmp_stray, "partial").unwrap();

        // Age the stray files past the grace window.
        let two_hours = 2 * 60 * 60 * 1000;
        age(&g.media_dir().join(&stray), two_hours);
        age(&tmp_stray, two_hours);
        age(&g.media_dir().join(&live), two_hours);

        let reaped = reap_stray_media_files(&HashSet::from([live.clone()]), 60 * 60 * 1000).await;

        assert_eq!(reaped, 2);
        assert!(g.media_dir().join(&live).exists());
        assert!(g.media_dir().join(&young).exists());
        assert!(!g.media_dir().join(&stray).exists());
        assert!(!tmp_stray.exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reap_returns_zero_when_the_media_dir_does_not_exist_yet() {
        let _g = DataDirGuard::new();
        assert_eq!(reap_stray_media_files(&HashSet::new(), 0).await, 0);
    }
}
