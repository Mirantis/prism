//! Tool Output Store
//!
//! The saved copy of a tool result that was too big to show the model whole. The
//! model is shown the head and the tail with a notice naming the copy's path; the
//! whole text lives here as a file, and the agent reads the part it could not see
//! with `shell_exec`.
//!
//! A sibling of `lib/media_store.rs` rather than a client of it. The two look alike
//! — atomic write, containment guard, a missing file means "gone, not broken" — but
//! their lifecycles differ in the way that matters: an attachment is referenced by
//! a DB row, so its reaper works from a live set and needs boot reconciliation,
//! while nothing points at a spill. A spill's entire lifecycle is its mtime against
//! the TTL.
//!
//! The agent reads a saved copy with `shell_exec`, so the notice carries the file's
//! path and the agent brings its own tool — `jq` for the JSON these payloads
//! usually are, `grep` or `sed` otherwise. A path in stored history goes stale if
//! the data dir moves between a container and local dev; the read then fails the
//! same way an expired copy does, which is the behaviour either way.

use crate::lib::execution_environments::execution_environment::ExecutionFiles;
use crate::lib::execution_environments::get_execution_environment::{
    get_execution_environment, get_execution_environment_for, get_host_environment,
};
use crate::lib::execution_environments::workspace::resolve_workspace;
use crate::support::now_ms;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};
use uuid::Uuid;

/// One place saved copies are kept, and the filesystem that reaches it.
struct Store {
    dir: String,
    files: Arc<dyn ExecutionFiles>,
}

/// Where a thread's saved copies go: beside the shell that reads them back. A
/// thread rooted in a host repository runs its commands on the host even while
/// the deployment runs in a container, so its copies go to the host too.
///
/// `get_execution_environment_for(resolve_workspace(workspace_root))`, its
/// `paths().tool_output_dir` and its `files()`.
fn store_for(workspace_root: Option<&str>) -> Store {
    let workspace = resolve_workspace(workspace_root);
    let environment = get_execution_environment_for(Some(&workspace));
    Store {
        dir: environment.paths().tool_output_dir,
        files: environment.files(),
    }
}

/// Every place a saved copy can be, for the reads and sweeps that do not know
/// which thread wrote it: the deployment's environment, then the host's, each
/// directory once. One entry when the deployment runs on this machine.
fn all_stores() -> Vec<Store> {
    let mut stores: Vec<Store> = Vec::new();
    for environment in [get_execution_environment(), get_host_environment()] {
        let dir = environment.paths().tool_output_dir;
        if !stores.iter().any(|store| store.dir == dir) {
            stores.push(Store {
                dir,
                files: environment.files(),
            });
        }
    }
    stores
}

/// `path.posix.join(dir, name)`: the two joined with `/` and normalized.
fn posix_join(dir: &str, name: &str) -> String {
    let joined = if dir.is_empty() {
        name.to_string()
    } else if name.is_empty() {
        dir.to_string()
    } else {
        format!("{dir}/{name}")
    };
    posix_normalize(&joined)
}

/// `path.posix.normalize`: `.` and empty segments dropped, `..` resolved.
fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_string();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() && !absolute {
        out.push('.');
    }
    if trailing && !out.is_empty() {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// Ceiling on one saved copy. Paired with `MAX_EXEC_OUTPUT_BYTES` in
/// `tools/shell/config.rs` — keep them equal. Past it the copy holds the first
/// 10 MiB and says so, because a pathological result must fill neither the row nor
/// the volume.
pub const MAX_SPILL_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpillResult {
    /// Identifies the copy: the file's name, and what the record stores.
    pub id: String,
    /// Absolute path, for the notice that sends the agent to it.
    pub path: String,
    /// Bytes actually written.
    pub bytes: usize,
    /// True when the saved copy is itself only the first `MAX_SPILL_BYTES`.
    pub capped: bool,
}

static TOOL_OUTPUT_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("tool output id pattern")
});

/// An id is ours and never user-supplied, so this is stricter than a path check:
/// only the exact uuid shape passes, which leaves no room for a separator or a
/// traversal to be argued about.
pub fn is_tool_output_id(id: &str) -> bool {
    TOOL_OUTPUT_ID.is_match(id)
}

/// Save a tool result whole and return its id. Atomic: writes a `.tmp` sibling,
/// then renames, so a reader never sees a half-written copy.
///
/// Creates the directory first (defensive: `ensure_data_dirs()` creates it at
/// boot, but its temp-dir fallback can repin `PRISM_DATA_DIR` afterwards), cuts
/// the UTF-8 bytes at [`MAX_SPILL_BYTES`] on a character boundary, names the copy
/// with a random uuid and joins paths POSIX-style, because a container path is
/// POSIX whatever this host is.
pub async fn write_tool_output(
    text: &str,
    workspace_root: Option<&str>,
) -> anyhow::Result<SpillResult> {
    let Store { dir, files } = store_for(workspace_root);
    // Defensive: `ensure_data_dirs()` creates this at boot, but its temp-dir
    // fallback can repin PRISM_DATA_DIR afterwards.
    files.mkdir(&dir).await?;

    let buf = text.as_bytes();
    let capped = buf.len() > MAX_SPILL_BYTES;
    // Back off the cut to a character boundary. Slicing mid-character leaves a
    // replacement char at the end of the copy, which a search near the cap would
    // then fail to match.
    let data = if capped {
        &buf[..char_boundary_at_or_before(buf, MAX_SPILL_BYTES)]
    } else {
        buf
    };

    let id = Uuid::new_v4().to_string();
    // POSIX, because a container path is POSIX whatever this host is.
    let final_path = posix_join(&dir, &id);
    let tmp_path = format!("{final_path}.tmp");
    files.write_bytes(&tmp_path, data).await?;
    files.rename(&tmp_path, &final_path).await?;

    Ok(SpillResult {
        id,
        path: final_path,
        bytes: data.len(),
        capped,
    })
}

/// The largest cut at or before `limit` that does not split a UTF-8 character.
/// A continuation byte is `10xxxxxx`; a character starts at anything else, and no
/// character is longer than four bytes.
///
/// Reading past the end counts as a character start, as `buf[end]` is `undefined`
/// in JavaScript.
fn char_boundary_at_or_before(buf: &[u8], limit: usize) -> usize {
    let mut end = limit;
    let mut back = 0;
    while back < 4 && end > 0 {
        let byte = buf.get(end).copied();
        if byte.is_none_or(|b| (b & 0xc0) != 0x80) {
            return end;
        }
        end -= 1;
        back += 1;
    }
    end
}

/// Where a saved output of this thread lives, for the notice that points the
/// agent at it.
///
/// Absolute, because the agent reads it with `shell_exec`, whose commands are not
/// resolved against the shell workspace.
pub fn tool_output_path(id: &str, workspace_root: Option<&str>) -> String {
    posix_join(&store_for(workspace_root).dir, id)
}

/// Read a saved output back. `None` when the id is unknown or the copy has expired
/// — a stub outlives its file by design, so callers report that as "no longer
/// stored" rather than as a failure. A copy that exists but cannot be read is an
/// error.
pub async fn read_tool_output(id: &str) -> anyhow::Result<Option<String>> {
    if !is_tool_output_id(id) {
        return Ok(None);
    }
    for Store { dir, files } in all_stores() {
        let full = posix_join(&dir, id);
        if files.lstat(&full).await.is_err() {
            continue;
        }
        return files.read_text(&full, None).await.map(Some);
    }
    Ok(None)
}

/// Delete saved outputs older than `ttl_ms`, by mtime. This is the whole retention
/// story — no live set to reconcile against, because nothing holds a reference.
/// Also sweeps `.tmp` files a crash left between write and rename. A directory
/// that cannot be listed, and an entry that vanished or cannot be stat'ed, are
/// skipped. Answers how many were removed.
pub async fn reap_expired_tool_outputs(ttl_ms: i64) -> usize {
    let cutoff = (now_ms() - ttl_ms) as f64;
    let mut removed = 0;
    for Store { dir, files } in all_stores() {
        // Never created, or the data dir moved: nothing to sweep.
        let Ok(entries) = files.read_dir(&dir).await else {
            continue;
        };

        for entry in entries {
            let full = posix_join(&dir, &entry.name);
            // A file that vanished under us, or one we can't stat: skip it rather
            // than abandon the rest of the sweep.
            let Ok(stat) = files.lstat(&full).await else {
                continue;
            };
            if !stat.is_file || stat.mtime_ms >= cutoff {
                continue;
            }
            if files.remove(&full).await.is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_uuid_shape() {
        assert!(is_tool_output_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!is_tool_output_id("../etc/passwd"));
        assert!(!is_tool_output_id("0F8FAD5B-D9CB-469F-A165-70867728950E"));
    }

    #[test]
    fn joins_paths_as_posix_join_does() {
        assert_eq!(
            posix_join("/data/tool-outputs", "abc"),
            "/data/tool-outputs/abc"
        );
        assert_eq!(
            posix_join("/data/tool-outputs/", "abc"),
            "/data/tool-outputs/abc"
        );
        assert_eq!(
            posix_join("/data//x/../tool-outputs", "abc"),
            "/data/tool-outputs/abc"
        );
    }

    #[test]
    fn backs_a_cut_off_to_a_character_boundary() {
        let text = "aé".as_bytes();
        assert_eq!(char_boundary_at_or_before(text, 2), 1);
        assert_eq!(char_boundary_at_or_before(text, 1), 1);
        assert_eq!(char_boundary_at_or_before(text, 3), 3);
    }

    use crate::lib::data_dir::resolve_tool_output_dir;
    use crate::lib::media_store::tests::DataDirGuard;

    const HOUR: i64 = 60 * 60 * 1000;

    fn age(path: &std::path::Path, ms: i64) {
        let file = std::fs::File::options().write(true).open(path).unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_millis(ms as u64);
        file.set_modified(when).unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_back_a_saved_output() {
        let _dir = DataDirGuard::new();
        let saved = write_tool_output("the whole payload", None).await.unwrap();
        assert!(!saved.capped);
        assert_eq!(saved.bytes, "the whole payload".len());
        assert_eq!(
            read_tool_output(&saved.id).await.unwrap().as_deref(),
            Some("the whole payload")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn creates_the_directory_when_it_is_missing() {
        let _dir = DataDirGuard::new();
        let _ = std::fs::remove_dir_all(resolve_tool_output_dir());
        let saved = write_tool_output("still works", None).await.unwrap();
        assert_eq!(
            read_tool_output(&saved.id).await.unwrap().as_deref(),
            Some("still works")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_an_unknown_id_as_gone() {
        let _dir = DataDirGuard::new();
        assert_eq!(
            read_tool_output("0f9a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_to_read_outside_its_own_directory() {
        let dir = DataDirGuard::new();
        let outside = dir.tmp.path().join("agent.db");
        std::fs::write(&outside, "secret").unwrap();
        assert_eq!(read_tool_output("../agent.db").await.unwrap(), None);
        assert_eq!(read_tool_output("a/b").await.unwrap(), None);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn caps_one_saved_copy_and_says_so() {
        let _dir = DataDirGuard::new();
        let saved = write_tool_output(&"z".repeat(MAX_SPILL_BYTES + 5000), None)
            .await
            .unwrap();
        assert!(saved.capped);
        assert_eq!(saved.bytes, MAX_SPILL_BYTES);
        assert_eq!(
            read_tool_output(&saved.id).await.unwrap().unwrap().len(),
            MAX_SPILL_BYTES
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn deletes_expired_copies_and_spares_younger_ones() {
        let _dir = DataDirGuard::new();
        let old = write_tool_output("old", None).await.unwrap();
        let fresh = write_tool_output("fresh", None).await.unwrap();
        age(
            &std::path::Path::new(&resolve_tool_output_dir()).join(&old.id),
            8 * 24 * HOUR,
        );

        assert_eq!(reap_expired_tool_outputs(7 * 24 * HOUR).await, 1);
        assert_eq!(read_tool_output(&old.id).await.unwrap(), None);
        assert_eq!(
            read_tool_output(&fresh.id).await.unwrap().as_deref(),
            Some("fresh")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sweeps_a_tmp_file_a_crash_left_behind() {
        let _dir = DataDirGuard::new();
        let dir = std::path::PathBuf::from(resolve_tool_output_dir());
        std::fs::create_dir_all(&dir).unwrap();
        let stray = dir.join("abandoned.tmp");
        std::fs::write(&stray, "partial").unwrap();
        age(&stray, 8 * 24 * HOUR);

        assert_eq!(reap_expired_tool_outputs(7 * 24 * HOUR).await, 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn tolerates_a_directory_that_was_never_created() {
        let _dir = DataDirGuard::new();
        let _ = std::fs::remove_dir_all(resolve_tool_output_dir());
        assert_eq!(reap_expired_tool_outputs(HOUR).await, 0);
    }
}
