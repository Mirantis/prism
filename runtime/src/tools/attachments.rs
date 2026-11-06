//! Attachment tools — hydrate stored attachments to the workspace so the agent
//! can inspect them with shell tools (file, hexdump, pdftotext, etc.), or view
//! images inline via multimodal tool output.
//!
//! Security: strict RBAC via threadId — an attachment is only accessible if its
//! threadId matches the closed-over threadId of the invocation. This prevents
//! cross-thread data leakage even when the model hallucinates attachment ids.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::{ModelMessage, ToolSet};

pub const HYDRATE_ATTACHMENT_DESCRIPTION: &str = "Make a message attachment available on the workspace filesystem. Attachment bytes are not on disk until you call this: the filename in the attachment stub is not a path, so shell tools (`cat`, `grep`, `jq`, `unzip`, `python`) will fail with 'no such file' until the file is hydrated. Returns the absolute path to the hydrated file — use that path in shell commands. Use it for text, code, archives and data files, and for any file you want to inspect with `file`, `pdftotext`, `exiftool` or `hexdump`.";
pub const VIEW_ATTACHMENT_DESCRIPTION: &str = "Look at an image or read a PDF attachment without writing it to disk. Images (PNG, JPEG, GIF, WebP) are returned inline for visual inspection; a PDF is attached to the conversation as a document you can read directly. For other file types or oversized files, use hydrate_attachment instead.";

/// ~3.75 MB Bedrock per-image tool-result ceiling (base64 encoded).
pub const IMAGE_SIZE_CEILING_BYTES: i64 = 3_750_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIdInput {
    /// The id of the attachment (from the message metadata).
    pub attachment_id: String,
}

pub fn hydrate_attachment_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn view_attachment_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrateAttachmentSuccess {
    /// Always true.
    pub success: bool,
    pub path: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HydrateAttachmentFailure {
    /// Always false.
    pub success: bool,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HydrateAttachmentResult {
    Success(HydrateAttachmentSuccess),
    Failure(HydrateAttachmentFailure),
}

/// Write the attachment to `<workspace>/.attachments/<thread>/<attachment>/<name>`.
/// An attachment of another thread, an unknown one and one with no thread are
/// all `Attachment not found.`; expired content says how long attachments are
/// kept. Emits `attachment hydrated` or `attachment hydrate failed`.
pub async fn run_hydrate_attachment(
    input: AttachmentIdInput,
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    workspace_root: Option<&str>,
) -> anyhow::Result<HydrateAttachmentResult> {
    todo!()
}

/// Reap stale scratch dirs under `<workspace_root>/.attachments/`.
/// Walks `<threadId>/<attachmentId>/` dirs and removes those whose mtime is
/// older than `older_than_ms`. Does NOT follow symlinks. Empty thread dirs are
/// removed too. Returns how many attachment dirs were removed.
pub async fn reap_scratch_dirs(workspace_root: Option<&str>, older_than_ms: i64) -> i64 {
    todo!()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewCategory {
    Image,
    Pdf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewAttachmentSuccess {
    /// Always true.
    pub success: bool,
    pub attachment_id: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: ViewCategory,
    /// What actually happened, for the model. Bytes stay out of the tool's
    /// result — it is rendered into the persisted tool-call record (see
    /// `lib::tool_output_limiter`), so a base64 payload here would write
    /// megabytes into the message row. Images ride `to_model_output` (which
    /// loads bytes at prompt-conversion time); PDFs ride a registered
    /// user-message injection.
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewAttachmentFailure {
    /// Always false.
    pub success: bool,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ViewAttachmentResult {
    Success(ViewAttachmentSuccess),
    Failure(ViewAttachmentFailure),
}

/// Queues a message for injection into the running invocation at the next step
/// boundary.
pub type RegisterInjection = Arc<dyn Fn(ModelMessage) + Send + Sync>;

#[derive(Clone, Default)]
pub struct ViewAttachmentContext {
    /// Queues a message for injection into the running invocation at the next
    /// step boundary (`invoke`'s prepare step). PDFs need this: on Bedrock's
    /// Converse surface a document block is only legal in a *user* message —
    /// the converter rejects `file-data` inside a tool result — so the tool
    /// result stays text and the document follows as a user message.
    pub register_injection: Option<RegisterInjection>,
    /// Documents already injected in this invocation. An injection is re-spliced
    /// into every later step, so viewing the same PDF twice must not attach a
    /// second multi-MB copy.
    pub injected_document_ids: Option<Arc<Mutex<HashSet<String>>>>,
}

/// View an image inline, or attach a PDF to the turn as a document. The id of a
/// PDF is claimed before the read: a step's tool calls run concurrently, and a
/// check-then-add spanning the read would let two parallel calls for the same id
/// both inject a multi-MB copy. Emits `attachment viewed` or
/// `attachment view failed`.
pub async fn run_view_attachment(
    input: AttachmentIdInput,
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    ctx: ViewAttachmentContext,
) -> anyhow::Result<ViewAttachmentResult> {
    todo!()
}

fn view_expired_failure(
    filename: &str,
    user_id: &str,
    agent_id: &str,
    attachment_id: &str,
) -> ViewAttachmentFailure {
    todo!()
}

/// `hydrate_attachment` and `view_attachment`. The view tool's model output
/// carries an image as content (`[Viewing <name>]` and the image data), loaded at
/// prompt-conversion time; a failure or a PDF is its text.
pub fn get_attachment_tools(
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    workspace_root: Option<&str>,
    register_injection: Option<RegisterInjection>,
) -> ToolSet {
    todo!()
}
