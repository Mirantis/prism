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
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::ai::{Tool, ToolSet, execute_fn, on_input_available_fn, tool, zod_schema};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::execution_environments::workspace::resolve_workspace;
use crate::lib::pending_file_writes::{PendingFileWrites, PendingWaitOutcome, WaitForOptions};
use crate::lib::read_settled_file::read_settled_file;
use crate::services::attachment_service::{
    ATTACHMENT_SERVICE, AttachmentSource, CreateAttachmentInput, classify_media_type,
    detect_media_type,
};
use crate::tools::shell::workspace::{basename, is_inside_workspace, resolve_path};
use crate::{log_info, log_warn};

pub const SHARE_FILE_TOOL_NAME: &str = "share_file";
pub const SHARE_FILE_DESCRIPTION: &str = "Share a file from your workspace with the user as a downloadable attachment. Use this whenever the user asks for a file, report, export, document, or generated artifact — first create it on disk (e.g. with shell_write_file or shell_exec), then call share_file with its path. Announcing a file you have not shared yet leaves the user with nothing to open. The file is delivered as a download in the web/CLI chat and uploaded natively to Slack. Max 10 MB per file. Do not paste large file contents into your reply or invent download links — use this tool. To show an image (PNG, JPEG, GIF or WebP) inside your reply instead, write ![description](path) where it belongs: the path of an image file in your workspace, or attachment:<id> for an image in this conversation. That needs no share_file call. When your reply explains an image, such as a chart, show it inline; share it as a file when the user wants a file to keep.";

#[derive(Debug, Clone, Deserialize)]
pub struct ShareFileInput {
    /// Path to the file to share. Relative paths resolve from the workspace root.
    pub path: String,
    /// Optional display name shown to the user (defaults to the file's base name).
    #[serde(default)]
    pub filename: Option<String>,
}

pub fn share_file_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to share. Relative paths resolve from the workspace root; the file must live inside the workspace."
            },
            "filename": {
                "description": "Optional display name shown to the user (defaults to the file’s base name). Use this to give a friendlier name than the on-disk path.",
                "type": "string"
            }
        },
        "required": ["path"],
        "additionalProperties": false
    })
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

impl ShareFileFailure {
    fn new(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: error.into(),
        }
    }
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
    let workspace = match workspace {
        Some(workspace) => workspace.to_string(),
        None => get_execution_environment().workspace_root(),
    };
    let fail = |error: ShareFileFailure| Ok(ShareFileResult::Failure(error));

    let full_path = resolve_path(&workspace, &input.path);
    if !is_inside_workspace(&full_path, &workspace) {
        return fail(ShareFileFailure::new("Path outside workspace"));
    }

    // Before the stat, not just before the read: a write that has not yet *created*
    // the file must be waited for too, or a batched create-and-share reports "file
    // not found" for a file the same step is writing.
    if let Some(barrier) = await_pending_writes(&full_path, &deps).await {
        return fail(barrier);
    }

    let data = match read_settled_file(&full_path, &input.path).await {
        Ok(data) => data,
        Err(error) => return fail(ShareFileFailure::new(error)),
    };

    let display = input
        .filename
        .as_deref()
        .map(crate::support::js::trim)
        .filter(|name| !name.is_empty());
    let filename = match display {
        Some(name) => name.to_string(),
        None => match basename(&full_path) {
            "" => "file".to_string(),
            name => name.to_string(),
        },
    };
    let media_type = detect_media_type(&data, &filename, None);
    let category = classify_media_type(&media_type);
    let size_bytes = data.len() as i64;

    let row = ATTACHMENT_SERVICE
        .create(CreateAttachmentInput {
            filename: filename.clone(),
            media_type: media_type.clone(),
            // The bytes read, not `stat.size` from before the read: this value is what
            // every channel shows, so a stat taken earlier can label
            // the attachment with a size it does not have.
            size_bytes,
            data,
            category,
            source: AttachmentSource::Agent,
            thread_id: None,
            message_id: None,
            external_file_id: None,
            external_ts: None,
        })
        .await?;

    Ok(ShareFileResult::Success(ShareFileSuccess {
        success: true,
        attachment_id: row.id,
        filename,
        size_bytes,
        media_type,
        category: category.as_str().to_string(),
    }))
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
    let pending_writes = deps.pending_writes.as_ref()?;
    let tool_call_id = deps.tool_call_id.as_deref();

    if !pending_writes.was_announced(tool_call_id) {
        let fields = match tool_call_id {
            Some(id) => json!({ "toolCallId": id }),
            None => json!({}),
        };
        log_warn!(
            fields,
            "share_file was not announced before executing — not sequencing it against this step's writes"
        );
        return None;
    }

    let outcome = pending_writes
        .wait_for(
            full_path,
            WaitForOptions {
                timeout_ms: deps
                    .pending_write_timeout_ms
                    .unwrap_or(PENDING_WRITE_TIMEOUT_MS),
                abort_signal: deps.abort_signal.clone(),
            },
        )
        .await;
    let (tool_names, reason) = match outcome {
        PendingWaitOutcome::None => return None,
        PendingWaitOutcome::Settled {
            tool_names,
            elapsed_ms,
        } => {
            log_info!(
                json!({ "toolNames": tool_names, "elapsedMs": elapsed_ms }),
                "share_file waited for writes in its own step that can change the file"
            );
            return None;
        }
        PendingWaitOutcome::Aborted { tool_names, .. } => (tool_names, "the turn was cancelled"),
        PendingWaitOutcome::Cleared { tool_names, .. } => {
            (tool_names, "it was abandoned before it finished")
        }
        PendingWaitOutcome::Timeout { tool_names, .. } => (tool_names, "it has not returned"),
    };

    let writer = tool_names
        .first()
        .map_or("a write", String::as_str)
        .to_string();
    Some(ShareFileFailure::new(format!(
        "Not shared: {writer} can change {}, ran in this same tool block, and {reason}. share_file captures the file when it runs, so the attachment would have held the bytes from before that write. Check that write's result: if it succeeded, share the file again in your next step and the download will match what you describe; if it was rejected or failed, say so instead of describing a file you did not write.",
        basename(full_path)
    )))
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
    let workspace = resolve_workspace(workspace_root);
    let announcer = pending_writes.clone();
    let mut tools = ToolSet::new();
    tools.insert(
        SHARE_FILE_TOOL_NAME.to_string(),
        tool(Tool {
            description: Some(SHARE_FILE_DESCRIPTION.to_string()),
            input_schema: zod_schema(share_file_input_schema()),
            // Announce this call so it can tell "no pending writes" from "the hook that
            // records them never ran". See `await_pending_writes`.
            on_input_available: Some(on_input_available_fn(move |_, options| {
                if let Some(pending) = &announcer {
                    pending.announce(Some(&options.tool_call_id), SHARE_FILE_TOOL_NAME);
                }
                async { Ok(()) }
            })),
            execute: Some(execute_fn(move |input, options| {
                let workspace = workspace.clone();
                let deps = ShareFileDeps {
                    pending_writes: pending_writes.clone(),
                    tool_call_id: Some(options.tool_call_id.clone()),
                    abort_signal: options.abort_signal.clone(),
                    pending_write_timeout_ms: None,
                };
                async move {
                    let input: ShareFileInput = serde_json::from_value(input)?;
                    let result = run_share_file(input, Some(&workspace), deps).await?;
                    Ok(serde_json::to_value(result)?)
                }
            })),
            ..Default::default()
        }),
    );
    tools
}

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::constants::MAX_FILE_SIZE_BYTES;
    use crate::db::models::MessageAttachment;
    use crate::db::schema::message_attachments;
    use crate::lib::media_store::tests::DataDirGuard;
    use crate::lib::pending_file_writes::create_pending_file_writes;

    /// 8-byte PNG signature — media detection sniffs the first bytes for the type.
    const PNG_HEADER: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    struct Fixture {
        _db: crate::db::testing::TestDb,
        _data: DataDirGuard,
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Fixture {
            Fixture {
                _db: crate::db::testing::test_db(),
                _data: DataDirGuard::new(),
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn workspace(&self) -> String {
            crate::lib::execution_environments::workspace::path_resolve(
                self.dir.path().to_str().unwrap(),
            )
        }

        fn file(&self, name: &str) -> String {
            format!("{}/{name}", self.workspace())
        }

        async fn share(&self, path: &str, deps: ShareFileDeps) -> ShareFileResult {
            let input = ShareFileInput {
                path: path.to_string(),
                filename: None,
            };
            run_share_file(input, Some(&self.workspace()), deps)
                .await
                .unwrap()
        }
    }

    fn error(result: ShareFileResult) -> String {
        match result {
            ShareFileResult::Failure(f) => f.error,
            ShareFileResult::Success(s) => panic!("expected a failure, got {s:?}"),
        }
    }

    fn shared(result: ShareFileResult) -> ShareFileSuccess {
        match result {
            ShareFileResult::Success(s) => s,
            ShareFileResult::Failure(f) => panic!("expected a success, got {f:?}"),
        }
    }

    async fn stored_count() -> i64 {
        crate::db::run(|conn| Ok(message_attachments::table.count().get_result(conn)?))
            .await
            .unwrap()
    }

    async fn stored_bytes(id: &str) -> Vec<u8> {
        let id = id.to_string();
        let row: MessageAttachment = crate::db::run(move |conn| {
            Ok(message_attachments::table
                .filter(message_attachments::id.eq(&id))
                .select(MessageAttachment::as_select())
                .first(conn)?)
        })
        .await
        .unwrap();
        ATTACHMENT_SERVICE.load_bytes(&row).await.unwrap().unwrap()
    }

    fn sequenced(pending: &Arc<dyn PendingFileWrites>, timeout_ms: Option<u64>) -> ShareFileDeps {
        ShareFileDeps {
            pending_writes: Some(pending.clone()),
            tool_call_id: Some("call-share".to_string()),
            abort_signal: None,
            pending_write_timeout_ms: timeout_ms,
        }
    }

    #[test]
    fn the_definition_matches_the_typescript_runtime() {
        let tools = get_share_file_tools(Some("/tmp"), None);
        crate::tools::schema_fixture::assert_matches_fixture("share-file", &tools);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_a_path_outside_the_workspace() {
        let f = Fixture::new();
        for path in ["/etc/hosts", "../../etc/hosts"] {
            assert_eq!(
                error(f.share(path, Default::default()).await),
                "Path outside workspace"
            );
        }
        assert_eq!(stored_count().await, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_missing_file_an_empty_file_and_a_directory() {
        let f = Fixture::new();
        std::fs::write(f.file("empty.txt"), "").unwrap();
        std::fs::create_dir(f.file("sub")).unwrap();
        assert_eq!(
            error(f.share("nope.txt", Default::default()).await),
            "File not found: nope.txt"
        );
        assert_eq!(
            error(f.share("empty.txt", Default::default()).await),
            "File is empty: empty.txt"
        );
        assert_eq!(
            error(f.share("sub", Default::default()).await),
            "sub is a directory — share a single file."
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_a_file_over_the_size_cap_without_reading_it() {
        let f = Fixture::new();
        let big = std::fs::File::create(f.file("big.bin")).unwrap();
        big.set_len(MAX_FILE_SIZE_BYTES as u64 + 1).unwrap();
        assert_eq!(
            error(f.share("big.bin", Default::default()).await),
            "File too large (10.0 MB) — max 10 MB."
        );
        assert_eq!(stored_count().await, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn shares_a_png_as_an_image_from_the_agent() {
        let f = Fixture::new();
        std::fs::write(f.file("chart.png"), PNG_HEADER).unwrap();
        let result = shared(f.share("chart.png", Default::default()).await);
        assert_eq!(result.filename, "chart.png");
        assert_eq!(result.media_type, "image/png");
        assert_eq!(result.category, "image");
        assert_eq!(result.size_bytes, 8);
        assert_eq!(stored_bytes(&result.attachment_id).await, PNG_HEADER);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn honors_an_explicit_display_filename() {
        let f = Fixture::new();
        std::fs::write(f.file("out.csv"), "a,b\n1,2\n").unwrap();
        let input = ShareFileInput {
            path: "out.csv".to_string(),
            filename: Some(" report.csv ".to_string()),
        };
        let result = shared(
            run_share_file(input, Some(&f.workspace()), Default::default())
                .await
                .unwrap(),
        );
        assert_eq!(result.filename, "report.csv");
        assert_eq!(result.category, "text");
    }

    // The model asked for the edit and the share in one assistant message, the
    // steps ran concurrently, and the read must wait for the write.
    #[tokio::test]
    #[serial_test::serial]
    async fn captures_the_bytes_the_sibling_write_produced() {
        let f = Fixture::new();
        let file = f.file("draft.md");
        let rev2 = "rev 2, considerably longer than the first\n";
        std::fs::write(&file, "rev 1\n").unwrap();
        let pending = create_pending_file_writes();
        pending.register(Some("call-write"), "shell_edit_file", Some(&file));
        pending.announce(Some("call-share"), "share_file");

        let sharing = f.share("draft.md", sequenced(&pending, None));
        let writing = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            std::fs::write(&file, rev2).unwrap();
            pending.settle(Some("call-write"));
        };
        let (result, ()) = tokio::join!(sharing, writing);

        let result = shared(result);
        assert_eq!(result.size_bytes, rev2.len() as i64);
        assert_eq!(stored_bytes(&result.attachment_id).await, rev2.as_bytes());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn waits_for_a_write_that_has_not_created_the_file_yet() {
        let f = Fixture::new();
        let file = f.file("fresh.txt");
        let pending = create_pending_file_writes();
        pending.register(Some("call-write"), "shell_write_file", Some(&file));
        pending.announce(Some("call-share"), "share_file");

        let sharing = f.share("fresh.txt", sequenced(&pending, None));
        let writing = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            std::fs::write(&file, "created by the sibling write\n").unwrap();
            pending.settle(Some("call-write"));
        };
        let (result, ()) = tokio::join!(sharing, writing);
        shared(result);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn does_not_wait_on_a_write_to_a_different_file() {
        let f = Fixture::new();
        std::fs::write(f.file("draft.md"), "ready\n").unwrap();
        let pending = create_pending_file_writes();
        pending.register(
            Some("call-write"),
            "shell_write_file",
            Some(&f.file("other.md")),
        );
        pending.announce(Some("call-share"), "share_file");
        let result = shared(f.share("draft.md", sequenced(&pending, Some(50))).await);
        assert_eq!(stored_bytes(&result.attachment_id).await, b"ready\n");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_to_share_the_older_copy_when_the_write_never_lands() {
        let f = Fixture::new();
        let file = f.file("draft.md");
        std::fs::write(&file, "stale\n").unwrap();
        let pending = create_pending_file_writes();
        pending.register(Some("call-write"), "shell_edit_file", Some(&file));
        pending.announce(Some("call-share"), "share_file");

        let message = error(f.share("draft.md", sequenced(&pending, Some(20))).await);

        assert!(
            message.starts_with(
                "Not shared: shell_edit_file can change draft.md, ran in this same tool block, and it has not returned."
            ),
            "{message}"
        );
        assert!(message.contains("Check that write's result"));
        assert_eq!(stored_count().await, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stops_waiting_when_the_turn_is_cancelled() {
        let f = Fixture::new();
        let file = f.file("draft.md");
        std::fs::write(&file, "stale\n").unwrap();
        let pending = create_pending_file_writes();
        pending.register(Some("call-write"), "shell_edit_file", Some(&file));
        pending.announce(Some("call-share"), "share_file");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut deps = sequenced(&pending, None);
        deps.abort_signal = Some(cancel);

        let message = error(f.share("draft.md", deps).await);

        assert!(message.contains("the turn was cancelled"), "{message}");
        assert_eq!(stored_count().await, 0);
    }

    // The canary: a pending write on this very path, but the share was never
    // announced, so it cannot trust the registry and must not block on it.
    #[tokio::test]
    #[serial_test::serial]
    async fn shares_unsequenced_when_its_own_call_was_never_announced() {
        let f = Fixture::new();
        let file = f.file("draft.md");
        std::fs::write(&file, "plain\n").unwrap();
        let pending = create_pending_file_writes();
        pending.register(Some("call-write"), "shell_edit_file", Some(&file));

        shared(f.share("draft.md", sequenced(&pending, Some(20))).await);
        shared(f.share("draft.md", Default::default()).await);
    }
}
