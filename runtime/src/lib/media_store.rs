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
    todo!()
}

/// Read attachment content by its stored basename. Returns `None` when the
/// file is gone (expired / never written / lost) — callers treat that as
/// "content no longer available", not an error. Any other read error is returned.
pub async fn read_media_file(storage_path: &str) -> anyhow::Result<Option<Vec<u8>>> {
    todo!()
}

/// Basenames of every file currently in the media dir (empty when absent).
pub async fn list_media_files() -> HashSet<String> {
    todo!()
}

/// Best-effort unlink. True when the file is gone afterwards.
pub async fn remove_media_file(storage_path: &str) -> bool {
    todo!()
}

/// Delete media files no DB row references. Covers rows removed by cascade
/// (message/thread deletion), rows from a `.prism` import pointing at another
/// install's files, and orphaned `.tmp` siblings. `grace_ms` spares files
/// younger than the write-file-then-create-row window — never shorten it below
/// the hourly sweep interval's safety margin (1 h). Only regular files (by
/// `lstat`) whose mtime is older than now minus `grace_ms` are removed; a
/// missing media dir reaps nothing.
pub async fn reap_stray_media_files(live_storage_paths: &HashSet<String>, grace_ms: i64) -> usize {
    todo!()
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
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}
