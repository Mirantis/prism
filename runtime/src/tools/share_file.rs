//! share_file tool — deliver a workspace file to the user as a downloadable
//! attachment.
//!
//! The agent already CREATES files on disk via the shell tools
//! (`shell_write_file`, `shell_exec`, `coding_agent`, …) inside its workspace
//! (`SHELL_WORKSPACE_ROOT`, default `/home/node`). This tool is the OUTBOUND
//! half: it reads such a file, stores it as a `MessageAttachment`
//! (`source: 'agent'`, unlinked), and returns its `attachmentId`. The invoke
//! loop collects those ids onto the `InvokeStep`; the conversation engine /
//! heartbeat / cron then link them to the delivered message, and each channel
//! adapter renders them its own way.
//!
//! A share is sequenced against the writes in its own step. The model routinely
//! asks for the edit and the share in one assistant message, and a step's tool
//! calls run concurrently, so reading here would capture the file as it was
//! before the edit — the bytes are copied eagerly into the media store, so the
//! user then downloads a revision the reply does not describe. `PendingFileWrites`
//! makes the read wait for the writes to this same path first; see that module for
//! why the ordering holds. Waiting is free: the step already joins on every tool
//! promise before the next model call.
//!
//! Security model is inherited from the shell file tools: `resolve_path`
//! resolves relative paths against the workspace root and normalizes absolute
//! paths; `is_inside_workspace` then rejects anything that escapes the workspace
//! (relative `..` traversal AND absolute paths outside it). Media type is
//! sniffed from magic bytes (clients/extensions lie), and the 10 MB cap mirrors
//! the inbound upload limit.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ai::ToolSet;
use crate::lib::execution_environments::execution_environment::FileStat;
use crate::lib::pending_file_writes::PendingFileWrites;

pub const SHARE_FILE_TOOL_NAME: &str = "share_file";
pub const SHARE_FILE_DESCRIPTION: &str = "Share a file from your workspace with the user as a downloadable attachment. Use this whenever the user asks for a file, report, export, document, image, or generated artifact — first create it on disk (e.g. with shell_write_file or shell_exec), then call share_file with its path. Announcing a file you have not shared yet leaves the user with nothing to open. The file is delivered as a download in the web/CLI chat and uploaded natively to Slack. Max 10 MB per file. Do not paste large file contents into your reply or invent download links — use this tool.";

#[derive(Debug, Clone, Deserialize)]
pub struct ShareFileInput {
    /// Path to the file to share. Relative paths resolve from the workspace root.
    pub path: String,
    /// Optional display name shown to the user (defaults to the file's base name).
    #[serde(default)]
    pub filename: Option<String>,
}

pub fn share_file_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileSuccess {
    /// Always true.
    pub success: bool,
    pub attachment_id: String,
    pub filename: String,
    pub size_bytes: i64,
    pub media_type: String,
    pub category: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareFileFailure {
    /// Always false.
    pub success: bool,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ShareFileResult {
    Success(ShareFileSuccess),
    Failure(ShareFileFailure),
}

#[derive(Clone, Default)]
pub struct ShareFileDeps {
    /// The step's announced writes. Absent means no sequencing — today's behaviour.
    pub pending_writes: Option<Arc<dyn PendingFileWrites>>,
    /// This call's id, the key both the barrier and the canary are looked up by.
    pub tool_call_id: Option<String>,
    /// The turn's signal, so a cancelled turn stops waiting instead of timing out.
    pub abort_signal: Option<CancellationToken>,
    /// Overridable for tests.
    pub pending_write_timeout_ms: Option<u64>,
}

/// Whether the file changed across a read: either it no longer matches the bytes
/// just read, or its mtime has moved on from the stat taken before that read.
/// Both halves matter — an edit that keeps the length is still a different file.
fn moved(before: &FileStat, after: &FileStat, data: &[u8]) -> bool {
    after.size != data.len() as u64 || after.mtime_ms != before.mtime_ms
}

/// How long to wait for a sibling write before refusing to share. Covers the
/// write itself plus the tool risk gate's own pre-execute model call, which can
/// delay a write by up to `RISK_EVALUATION_TIMEOUT_MS` after this read begins. A
/// constant rather than a setting: an operator has no way to know a better
/// value, and the wait costs no wall-clock in the normal case.
pub const PENDING_WRITE_TIMEOUT_MS: u64 = 20_000;

/// Read a workspace file and persist it as an agent-sourced attachment.
/// Pure (no closure over user/agent) so it's unit-testable; `workspace`
/// defaults to the environment's workspace root.
///
/// The step's pending writes are waited for before the stat, so a batched
/// create-and-share finds the file. The read is confirmed against a second stat
/// and retried once; a second change refuses the share. The size and emptiness
/// guards are checked again against the bytes actually read.
pub async fn run_share_file(
    input: ShareFileInput,
    workspace: Option<&str>,
    deps: ShareFileDeps,
) -> anyhow::Result<ShareFileResult> {
    todo!()
}

/// Wait for the step's writes that can change `full_path`. Returns a failure to
/// hand straight back to the model, or `None` to carry on with the read.
///
/// The canary is the `was_announced` check. An empty registry is ambiguous — it
/// means either "no writes in this step" or "the announce hook never ran" — and
/// those must not be treated alike, or a future SDK change would silently restore
/// the defect. A share that cannot find its own id gives up on sequencing loudly
/// rather than concluding the step is clear.
async fn await_pending_writes(full_path: &str, deps: &ShareFileDeps) -> Option<ShareFileFailure> {
    todo!()
}

/// `workspace_root` must be the same per-thread root the shell tools resolve, or a
/// relative path means two different files to the two halves of write-then-share —
/// and the barrier's path comparison would never match. The tool announces its
/// call when its input is available, so it can tell "no pending writes" from
/// "the hook that records them never ran".
pub fn get_share_file_tools(
    workspace_root: Option<&str>,
    pending_writes: Option<Arc<dyn PendingFileWrites>>,
) -> ToolSet {
    todo!()
}
