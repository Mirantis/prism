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
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock};

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
    todo!()
}

/// Every place a saved copy can be, for the reads and sweeps that do not know
/// which thread wrote it: the deployment's environment, then the host's, each
/// directory once. One entry when the deployment runs on this machine.
fn all_stores() -> Vec<Store> {
    todo!()
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
    todo!()
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
    todo!()
}

/// Read a saved output back. `None` when the id is unknown or the copy has expired
/// — a stub outlives its file by design, so callers report that as "no longer
/// stored" rather than as a failure. A copy that exists but cannot be read is an
/// error.
pub async fn read_tool_output(id: &str) -> anyhow::Result<Option<String>> {
    todo!()
}

/// Delete saved outputs older than `ttl_ms`, by mtime. This is the whole retention
/// story — no live set to reconcile against, because nothing holds a reference.
/// Also sweeps `.tmp` files a crash left between write and rename. A directory
/// that cannot be listed, and an entry that vanished or cannot be stat'ed, are
/// skipped. Answers how many were removed.
pub async fn reap_expired_tool_outputs(ttl_ms: i64) -> usize {
    todo!()
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
    fn backs_a_cut_off_to_a_character_boundary() {
        let text = "aé".as_bytes();
        assert_eq!(char_boundary_at_or_before(text, 2), 1);
        assert_eq!(char_boundary_at_or_before(text, 1), 1);
        assert_eq!(char_boundary_at_or_before(text, 3), 3);
    }
}
