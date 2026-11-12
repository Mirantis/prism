//! Attachment tools — hydrate stored attachments to the workspace so the agent
//! can inspect them with shell tools (file, hexdump, pdftotext, etc.), or view
//! images inline via multimodal tool output.
//!
//! Security: strict RBAC via threadId — an attachment is only accessible if its
//! threadId matches the closed-over threadId of the invocation. This prevents
//! cross-thread data leakage even when the model hallucinates attachment ids.

use std::collections::HashSet;
use std::sync::Arc;

use base64::Engine;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::provider::{ToolResultContentPart, ToolResultOutput};
use crate::ai::{
    FilePart, ModelMessage, TextPart, Tool, ToolSet, UserContent, UserContentPart,
    UserModelMessage, execute_fn, to_model_output_fn, tool, zod_schema,
};
use crate::constants::MAX_FILE_SIZE_BYTES;
use crate::lib::execution_environments::get_execution_environment::files_for;
use crate::lib::execution_environments::workspace::{path_resolve, resolve_workspace};
use crate::lib::media_store::sanitize_filename;
use crate::lib::telemetry::track_event;
use crate::services::attachment_service::{
    ATTACHMENT_SERVICE, attachment_retention, classify_media_type, is_bedrock_image_type,
};

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
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "attachmentId": {
                "type": "string",
                "description": "The id of the attachment to hydrate (from the message metadata)."
            }
        },
        "required": ["attachmentId"],
        "additionalProperties": false
    })
}

pub fn view_attachment_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "attachmentId": {
                "type": "string",
                "description": "The id of the image or PDF attachment to view (from the message metadata)."
            }
        },
        "required": ["attachmentId"],
        "additionalProperties": false
    })
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

/// Telemetry props, in the order given.
fn props(pairs: &[(&str, String)]) -> Option<IndexMap<String, String>> {
    Some(
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    )
}

/// `attachment hydrate failed`, and the refusal the model reads.
fn hydrate_failed(
    user_id: &str,
    agent_id: &str,
    attachment_id: &str,
    error: String,
) -> HydrateAttachmentResult {
    track_event(
        "attachment hydrate failed",
        Some(user_id),
        props(&[
            ("agent.id", agent_id.to_string()),
            ("attachment.id", attachment_id.to_string()),
        ]),
    );
    HydrateAttachmentResult::Failure(HydrateAttachmentFailure {
        success: false,
        error,
    })
}

/// The error for an attachment whose content the retention sweep removed.
fn expired_error(filename: &str) -> String {
    format!(
        "The content of \"{filename}\" has expired (attachments are kept for {}). Ask the user to share the file again if you need it.",
        attachment_retention()
    )
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
    let attachment_id = input.attachment_id;
    let not_found = || "Attachment not found.".to_string();

    let Some(thread_id) = thread_id else {
        return Ok(hydrate_failed(
            user_id,
            agent_id,
            &attachment_id,
            not_found(),
        ));
    };

    let row = ATTACHMENT_SERVICE.get_by_id(&attachment_id).await?;
    let Some(row) = row.filter(|r| r.thread_id.as_deref() == Some(thread_id)) else {
        return Ok(hydrate_failed(
            user_id,
            agent_id,
            &attachment_id,
            not_found(),
        ));
    };

    let Some(bytes) = ATTACHMENT_SERVICE.load_bytes(&row).await? else {
        return Ok(hydrate_failed(
            user_id,
            agent_id,
            &attachment_id,
            expired_error(&row.filename),
        ));
    };

    let ws = resolve_workspace(workspace_root);
    let scratch_dir = path_resolve(&format!("{ws}/.attachments/{thread_id}/{attachment_id}"));
    files_for(&scratch_dir).mkdir(&scratch_dir).await?;

    let filename = sanitize_filename(&row.filename, &attachment_id);
    let dest_path = path_resolve(&format!("{scratch_dir}/{filename}"));

    // Final guard: resolved path must stay inside scratchDir
    if !dest_path.starts_with(&format!("{scratch_dir}/")) && dest_path != scratch_dir {
        return Ok(hydrate_failed(
            user_id,
            agent_id,
            &attachment_id,
            not_found(),
        ));
    }

    files_for(&dest_path)
        .write_bytes(&dest_path, &bytes)
        .await?;

    let category = classify_media_type(&row.media_type);
    track_event(
        "attachment hydrated",
        Some(user_id),
        props(&[
            ("agent.id", agent_id.to_string()),
            ("attachment.id", attachment_id.clone()),
            ("attachment.category", category.as_str().to_string()),
            ("attachment.size_bytes", row.size_bytes.to_string()),
        ]),
    );

    Ok(HydrateAttachmentResult::Success(HydrateAttachmentSuccess {
        success: true,
        hint: format!(
            "File written to {dest_path}. You can now inspect it with shell tools (e.g. file, cat, hexdump, pdftotext, exiftool)."
        ),
        path: dest_path,
        filename,
        media_type: row.media_type,
        size_bytes: row.size_bytes,
    }))
}

/// Reap stale scratch dirs under `<workspace_root>/.attachments/`.
/// Walks `<threadId>/<attachmentId>/` dirs and removes those whose mtime is
/// older than `older_than_ms`. Does NOT follow symlinks. Empty thread dirs are
/// removed too. Returns how many attachment dirs were removed; a dir that cannot
/// be removed fails the sweep.
pub async fn reap_scratch_dirs(
    workspace_root: Option<&str>,
    older_than_ms: i64,
) -> anyhow::Result<i64> {
    let ws = resolve_workspace(workspace_root);
    let base_dir = path_resolve(&format!("{ws}/.attachments"));

    let Ok(thread_dirs) = files_for(&base_dir).read_dir(&base_dir).await else {
        return Ok(0);
    };

    let cutoff = (crate::support::now_ms() - older_than_ms) as f64;
    let mut reaped = 0;

    for thread_dir in thread_dirs {
        let thread_path = path_resolve(&format!("{base_dir}/{}", thread_dir.name));
        let files = files_for(&thread_path);
        let is_dir = files
            .lstat(&thread_path)
            .await
            .is_ok_and(|stat| stat.is_directory);
        if !is_dir {
            continue;
        }

        let Ok(attachment_dirs) = files.read_dir(&thread_path).await else {
            continue;
        };

        for att_dir in attachment_dirs {
            let att_path = path_resolve(&format!("{thread_path}/{}", att_dir.name));
            let att_files = files_for(&att_path);
            let Ok(att_stat) = att_files.lstat(&att_path).await else {
                continue;
            };
            if !att_stat.is_directory {
                continue;
            }

            if att_stat.mtime_ms < cutoff {
                att_files.remove(&att_path).await?;
                reaped += 1;
            }
        }

        // Clean up empty thread dirs
        let empty = files
            .read_dir(&thread_path)
            .await
            .is_ok_and(|remaining| remaining.is_empty());
        if empty {
            let _ = files.remove_dir(&thread_path).await;
        }
    }

    Ok(reaped)
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

/// `attachment view failed`, and the refusal the model reads.
fn view_failed(
    user_id: &str,
    agent_id: &str,
    attachment_id: &str,
    error: &str,
) -> ViewAttachmentResult {
    track_event(
        "attachment view failed",
        Some(user_id),
        props(&[
            ("agent.id", agent_id.to_string()),
            ("attachment.id", attachment_id.to_string()),
        ]),
    );
    ViewAttachmentResult::Failure(ViewAttachmentFailure {
        success: false,
        error: error.to_string(),
    })
}

/// `attachment viewed` for a view that went to the model.
fn track_viewed(
    user_id: &str,
    agent_id: &str,
    attachment_id: &str,
    category: &str,
    media_type: &str,
    size_bytes: i64,
) {
    track_event(
        "attachment viewed",
        Some(user_id),
        props(&[
            ("agent.id", agent_id.to_string()),
            ("attachment.id", attachment_id.to_string()),
            ("attachment.category", category.to_string()),
            ("attachment.media_type", media_type.to_string()),
            ("attachment.size_bytes", size_bytes.to_string()),
        ]),
    );
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
    let attachment_id = input.attachment_id;

    let Some(thread_id) = thread_id else {
        return Ok(view_failed(
            user_id,
            agent_id,
            &attachment_id,
            "Attachment not found.",
        ));
    };

    let row = ATTACHMENT_SERVICE.get_by_id(&attachment_id).await?;
    let Some(row) = row.filter(|r| r.thread_id.as_deref() == Some(thread_id)) else {
        return Ok(view_failed(
            user_id,
            agent_id,
            &attachment_id,
            "Attachment not found.",
        ));
    };

    let is_pdf = row.media_type == "application/pdf" && ctx.register_injection.is_some();

    // Everything that is neither a Bedrock-safe image nor an injectable PDF
    // goes to hydrate_attachment + shell tools.
    if !is_bedrock_image_type(&row.media_type) && !is_pdf {
        return Ok(view_failed(
            user_id,
            agent_id,
            &attachment_id,
            "This file type cannot be viewed inline. Use hydrate_attachment to write the file to disk, then inspect with shell tools.",
        ));
    }

    // Size guards. Images: base64 expands ~33%, but we check raw size against
    // the ceiling since it accounts for the expansion on Bedrock's side. PDFs:
    // the upload cap is the proven bound for user-message file parts.
    let size_ceiling = if is_pdf {
        MAX_FILE_SIZE_BYTES
    } else {
        IMAGE_SIZE_CEILING_BYTES
    };
    if row.size_bytes > size_ceiling {
        let error = format!(
            "{} exceeds the {:.2} MB size limit for inline viewing. Use hydrate_attachment to write it to disk and inspect with shell tools{}.",
            if is_pdf { "Document" } else { "Image" },
            size_ceiling as f64 / 1_000_000.0,
            if is_pdf { " (e.g. pdftotext)" } else { "" }
        );
        return Ok(view_failed(user_id, agent_id, &attachment_id, &error));
    }

    let success = |category: ViewCategory, note: String| {
        ViewAttachmentResult::Success(ViewAttachmentSuccess {
            success: true,
            attachment_id: attachment_id.clone(),
            filename: row.filename.clone(),
            media_type: row.media_type.clone(),
            size_bytes: row.size_bytes,
            category,
            note,
        })
    };

    if is_pdf {
        // Idempotent per invocation — the injected document is re-spliced into
        // every subsequent step, so it is still in view.
        if let Some(ids) = &ctx.injected_document_ids {
            // Claim the id BEFORE the await: a step's tool calls run concurrently,
            // and a check-then-add spanning the read would let two parallel calls
            // for the same id both inject a multi-MB copy.
            let claimed = ids.lock().insert(attachment_id.clone());
            if !claimed {
                return Ok(success(
                    ViewCategory::Pdf,
                    format!(
                        "\"{}\" is already attached to this turn from an earlier view_attachment call — its content is still visible above.",
                        row.filename
                    ),
                ));
            }
        }

        let Some(bytes) = ATTACHMENT_SERVICE.load_bytes(&row).await? else {
            if let Some(ids) = &ctx.injected_document_ids {
                ids.lock().remove(&attachment_id);
            }
            return Ok(view_expired_failure(
                &row.filename,
                user_id,
                agent_id,
                &attachment_id,
            ));
        };

        let register = ctx
            .register_injection
            .as_ref()
            .expect("a PDF is viewed only with a registrar");
        let citations = json!({ "bedrock": { "citations": { "enabled": true } } });
        register(ModelMessage::User(UserModelMessage {
            content: UserContent::Parts(vec![
                UserContentPart::File(FilePart {
                    data: bytes.into(),
                    filename: Some(row.filename.clone()),
                    media_type: "application/pdf".to_string(),
                    // Bedrock Converse text-extracts a document unless citations are
                    // enabled; enabling them gives Claude the full visual pages. Other
                    // providers ignore the bedrock namespace.
                    provider_options: citations.as_object().cloned(),
                }),
                UserContentPart::Text(TextPart::new(format!(
                    "[Document \"{}\" (id={attachment_id}) attached for analysis via view_attachment]",
                    row.filename
                ))),
            ]),
            provider_options: None,
        }));

        track_viewed(
            user_id,
            agent_id,
            &attachment_id,
            "pdf",
            &row.media_type,
            row.size_bytes,
        );

        // Turn-scoped on purpose: this note is persisted into the tool-call record
        // and replayed verbatim in later turns' history — where no document
        // follows. Overclaiming here would invite confabulated answers later.
        return Ok(success(
            ViewCategory::Pdf,
            format!(
                "Attached \"{}\" as a document for this turn — its full content follows this tool result. In a later turn, call view_attachment again if you need it back.",
                row.filename
            ),
        ));
    }

    // Image: verify the content is still there so the failure is a clear tool
    // error; the bytes themselves are loaded again in to_model_output.
    if ATTACHMENT_SERVICE.load_bytes(&row).await?.is_none() {
        return Ok(view_expired_failure(
            &row.filename,
            user_id,
            agent_id,
            &attachment_id,
        ));
    }

    track_viewed(
        user_id,
        agent_id,
        &attachment_id,
        "image",
        &row.media_type,
        row.size_bytes,
    );

    // Turn-scoped for the same reason as the PDF note above.
    Ok(success(
        ViewCategory::Image,
        format!(
            "Image \"{}\" is attached to this tool result for this turn. In a later turn, call view_attachment again if you need it back.",
            row.filename
        ),
    ))
}

fn view_expired_failure(
    filename: &str,
    user_id: &str,
    agent_id: &str,
    attachment_id: &str,
) -> ViewAttachmentResult {
    view_failed(user_id, agent_id, attachment_id, &expired_error(filename))
}

/// The view tool's result as the model sees it. Images ride the tool result as
/// multimodal content, their bytes loaded here — at prompt-conversion time — so
/// the (persisted, UI-visible) execute result stays metadata-sized. PDFs already
/// went out as a user-message injection, so their result is the plain note.
async fn view_model_output(output: Value) -> anyhow::Result<ToolResultOutput> {
    let text = |key: &str| {
        output
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    if output.get("success") != Some(&Value::Bool(true)) {
        return Ok(ToolResultOutput::text(text("error")));
    }
    if output.get("category").and_then(Value::as_str) != Some("image") {
        return Ok(ToolResultOutput::text(text("note")));
    }
    let row = ATTACHMENT_SERVICE.get_by_id(&text("attachmentId")).await?;
    let bytes = match &row {
        Some(row) => ATTACHMENT_SERVICE.load_bytes(row).await?,
        None => None,
    };
    let filename = text("filename");
    let Some(bytes) = bytes else {
        // Expired between the tool call and this conversion — rare, benign.
        return Ok(ToolResultOutput::text(format!(
            "The content of \"{filename}\" is no longer available (expired)."
        )));
    };
    Ok(ToolResultOutput::Content {
        value: vec![
            ToolResultContentPart::Text {
                text: format!("[Viewing {filename}]"),
                provider_options: None,
            },
            ToolResultContentPart::ImageData {
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
                media_type: text("mediaType"),
                provider_options: None,
            },
        ],
    })
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
    let injected_document_ids = Arc::new(Mutex::new(HashSet::new()));
    let mut tools = ToolSet::new();

    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    let thread = thread_id.map(str::to_string);
    let root = workspace_root.map(str::to_string);
    tools.insert(
        "hydrate_attachment".to_string(),
        tool(Tool {
            description: Some(HYDRATE_ATTACHMENT_DESCRIPTION.to_string()),
            input_schema: zod_schema(hydrate_attachment_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let (user, agent, thread, root) =
                    (user.clone(), agent.clone(), thread.clone(), root.clone());
                async move {
                    let input: AttachmentIdInput = serde_json::from_value(input)?;
                    let result = run_hydrate_attachment(
                        input,
                        &user,
                        &agent,
                        thread.as_deref(),
                        root.as_deref(),
                    )
                    .await?;
                    Ok(serde_json::to_value(result)?)
                }
            })),
            ..Default::default()
        }),
    );

    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    let thread = thread_id.map(str::to_string);
    let ctx = ViewAttachmentContext {
        register_injection,
        injected_document_ids: Some(injected_document_ids),
    };
    tools.insert(
        "view_attachment".to_string(),
        tool(Tool {
            description: Some(VIEW_ATTACHMENT_DESCRIPTION.to_string()),
            input_schema: zod_schema(view_attachment_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let (user, agent, thread, ctx) =
                    (user.clone(), agent.clone(), thread.clone(), ctx.clone());
                async move {
                    let input: AttachmentIdInput = serde_json::from_value(input)?;
                    let result =
                        run_view_attachment(input, &user, &agent, thread.as_deref(), ctx).await?;
                    Ok(serde_json::to_value(result)?)
                }
            })),
            to_model_output: Some(to_model_output_fn(|options| {
                view_model_output(options.output)
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
    use crate::ai::ToModelOutputOptions;
    use crate::db::models::NewMessageAttachment;
    use crate::db::schema::message_attachments;

    const THREAD_ID: &str = "thread-001";
    const AGENT_ID: &str = "agent-001";
    const USER_ID: &str = "user-001";

    /// Stores an attachment of the test thread with its bytes in the legacy column,
    /// so `load_bytes` serves them without a media file. Returns its id.
    async fn insert(
        filename: &str,
        media_type: &str,
        data: Option<&[u8]>,
        size_bytes: Option<i64>,
        thread_id: &str,
    ) -> String {
        let size = size_bytes.unwrap_or(data.map_or(1024, |d| d.len() as i64));
        let mut row = NewMessageAttachment::new(filename, media_type, size, "text", "web");
        row.thread_id = Some(thread_id.to_string());
        row.data = data.map(<[u8]>::to_vec);
        let id = row.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(message_attachments::table)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        id
    }

    fn input(id: &str) -> AttachmentIdInput {
        AttachmentIdInput {
            attachment_id: id.to_string(),
        }
    }

    fn failure(result: ViewAttachmentResult) -> String {
        match result {
            ViewAttachmentResult::Failure(f) => f.error,
            ViewAttachmentResult::Success(s) => panic!("expected a failure, got {s:?}"),
        }
    }

    fn view_success(result: ViewAttachmentResult) -> ViewAttachmentSuccess {
        match result {
            ViewAttachmentResult::Success(s) => s,
            ViewAttachmentResult::Failure(f) => panic!("expected a success, got {f:?}"),
        }
    }

    fn pdf_ctx() -> (ViewAttachmentContext, Arc<Mutex<Vec<ModelMessage>>>) {
        let registered = Arc::new(Mutex::new(Vec::new()));
        let sink = registered.clone();
        let ctx = ViewAttachmentContext {
            register_injection: Some(Arc::new(move |m| sink.lock().push(m))),
            injected_document_ids: Some(Arc::new(Mutex::new(HashSet::new()))),
        };
        (ctx, registered)
    }

    #[test]
    fn the_definitions_match_the_typescript_runtime() {
        let tools = get_attachment_tools("user-1", "agent-1", Some("thread-1"), None, None);
        crate::tools::schema_fixture::assert_matches_fixture("attachments", &tools);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hydrate_returns_not_found_without_a_thread() {
        let _db = crate::db::testing::test_db();
        let workspace = tempfile::tempdir().unwrap();
        let result = run_hydrate_attachment(
            input("att-001"),
            USER_ID,
            AGENT_ID,
            None,
            workspace.path().to_str(),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "success": false, "error": "Attachment not found." })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hydrate_returns_not_found_for_another_threads_attachment() {
        let _db = crate::db::testing::test_db();
        let workspace = tempfile::tempdir().unwrap();
        let id = insert(
            "report.pdf",
            "application/pdf",
            Some(b"x"),
            None,
            "other-thread",
        )
        .await;
        let result = run_hydrate_attachment(
            input(&id),
            USER_ID,
            AGENT_ID,
            Some(THREAD_ID),
            workspace.path().to_str(),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "success": false, "error": "Attachment not found." })
        );
        let missing = run_hydrate_attachment(
            input("nonexistent"),
            USER_ID,
            AGENT_ID,
            Some(THREAD_ID),
            workspace.path().to_str(),
        )
        .await
        .unwrap();
        assert!(matches!(missing, HydrateAttachmentResult::Failure(_)));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hydrate_names_the_retention_when_the_content_expired() {
        let _db = crate::db::testing::test_db();
        let workspace = tempfile::tempdir().unwrap();
        let id = insert("report.pdf", "application/pdf", None, None, THREAD_ID).await;
        let result = run_hydrate_attachment(
            input(&id),
            USER_ID,
            AGENT_ID,
            Some(THREAD_ID),
            workspace.path().to_str(),
        )
        .await
        .unwrap();
        let HydrateAttachmentResult::Failure(failure) = result else {
            panic!("expected a failure");
        };
        assert_eq!(
            failure.error,
            format!(
                "The content of \"report.pdf\" has expired (attachments are kept for {}). Ask the user to share the file again if you need it.",
                attachment_retention()
            )
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hydrate_writes_the_file_to_its_scratch_path() {
        let _db = crate::db::testing::test_db();
        let workspace = tempfile::tempdir().unwrap();
        let root = path_resolve(workspace.path().to_str().unwrap());
        let id = insert(
            "notes.txt",
            "text/plain",
            Some(b"hello world"),
            None,
            THREAD_ID,
        )
        .await;

        let result =
            run_hydrate_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), Some(&root))
                .await
                .unwrap();

        let HydrateAttachmentResult::Success(success) = result else {
            panic!("expected a success");
        };
        let expected = format!("{root}/.attachments/{THREAD_ID}/{id}/notes.txt");
        assert_eq!(success.path, expected);
        assert_eq!(success.filename, "notes.txt");
        assert_eq!(success.media_type, "text/plain");
        assert_eq!(success.size_bytes, 11);
        assert_eq!(
            success.hint,
            format!(
                "File written to {expected}. You can now inspect it with shell tools (e.g. file, cat, hexdump, pdftotext, exiftool)."
            )
        );
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), "hello world");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hydrate_sanitizes_a_filename_that_traverses() {
        let _db = crate::db::testing::test_db();
        let workspace = tempfile::tempdir().unwrap();
        let root = path_resolve(workspace.path().to_str().unwrap());
        for name in ["../../etc/passwd", "foo\\bar\\..\\..\\secret.txt"] {
            let id = insert(name, "text/plain", Some(b"malicious"), None, THREAD_ID).await;
            let result =
                run_hydrate_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), Some(&root))
                    .await
                    .unwrap();
            let HydrateAttachmentResult::Success(success) = result else {
                panic!("expected a success");
            };
            assert!(
                success
                    .path
                    .starts_with(&format!("{root}/.attachments/{THREAD_ID}/{id}"))
            );
            assert!(!success.filename.contains(".."));
            assert!(!success.filename.contains('/'));
            assert!(!success.filename.contains('\\'));
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn hydrate_falls_back_to_the_attachment_id_for_an_empty_name() {
        let _db = crate::db::testing::test_db();
        let workspace = tempfile::tempdir().unwrap();
        let id = insert("   ", "text/plain", Some(b"x"), None, THREAD_ID).await;
        let result = run_hydrate_attachment(
            input(&id),
            USER_ID,
            AGENT_ID,
            Some(THREAD_ID),
            workspace.path().to_str(),
        )
        .await
        .unwrap();
        let HydrateAttachmentResult::Success(success) = result else {
            panic!("expected a success");
        };
        assert_eq!(success.filename, id);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_returns_not_found_without_a_thread_or_for_another_thread() {
        let _db = crate::db::testing::test_db();
        let error = failure(
            run_view_attachment(
                input("att-001"),
                USER_ID,
                AGENT_ID,
                None,
                Default::default(),
            )
            .await
            .unwrap(),
        );
        assert_eq!(error, "Attachment not found.");
        let id = insert("a.png", "image/png", Some(b"x"), None, "other-thread").await;
        let error = failure(
            run_view_attachment(
                input(&id),
                USER_ID,
                AGENT_ID,
                Some(THREAD_ID),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        assert_eq!(error, "Attachment not found.");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_returns_metadata_and_never_bytes_for_an_image() {
        let _db = crate::db::testing::test_db();
        let id = insert(
            "screenshot.png",
            "image/png",
            Some(b"fake-png-bytes"),
            None,
            THREAD_ID,
        )
        .await;
        let result = run_view_attachment(
            input(&id),
            USER_ID,
            AGENT_ID,
            Some(THREAD_ID),
            Default::default(),
        )
        .await
        .unwrap();
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            format!(
                r#"{{"success":true,"attachmentId":"{id}","filename":"screenshot.png","mediaType":"image/png","sizeBytes":14,"category":"image","note":"Image \"screenshot.png\" is attached to this tool result for this turn. In a later turn, call view_attachment again if you need it back."}}"#
            )
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_reports_expired_content_and_oversize_images() {
        let _db = crate::db::testing::test_db();
        let gone = insert("screenshot.png", "image/png", None, None, THREAD_ID).await;
        let error = failure(
            run_view_attachment(
                input(&gone),
                USER_ID,
                AGENT_ID,
                Some(THREAD_ID),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        assert!(error.contains("expired"), "{error}");

        let huge = insert(
            "huge.png",
            "image/png",
            Some(b"x"),
            Some(4_000_000),
            THREAD_ID,
        )
        .await;
        let error = failure(
            run_view_attachment(
                input(&huge),
                USER_ID,
                AGENT_ID,
                Some(THREAD_ID),
                Default::default(),
            )
            .await
            .unwrap(),
        );
        assert_eq!(
            error,
            "Image exceeds the 3.75 MB size limit for inline viewing. Use hydrate_attachment to write it to disk and inspect with shell tools."
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_directs_a_pdf_to_hydrate_without_a_registrar_and_refuses_other_types() {
        let _db = crate::db::testing::test_db();
        for (name, media_type) in [
            ("doc.pdf", "application/pdf"),
            ("archive.zip", "application/zip"),
        ] {
            let id = insert(name, media_type, Some(b"x"), None, THREAD_ID).await;
            let error = failure(
                run_view_attachment(
                    input(&id),
                    USER_ID,
                    AGENT_ID,
                    Some(THREAD_ID),
                    Default::default(),
                )
                .await
                .unwrap(),
            );
            assert_eq!(
                error,
                "This file type cannot be viewed inline. Use hydrate_attachment to write the file to disk, then inspect with shell tools."
            );
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_attaches_a_pdf_as_a_user_message_document_once() {
        let _db = crate::db::testing::test_db();
        let data = b"%PDF-1.7 fake";
        let id = insert("report.pdf", "application/pdf", Some(data), None, THREAD_ID).await;
        let (ctx, registered) = pdf_ctx();

        let first = view_success(
            run_view_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), ctx.clone())
                .await
                .unwrap(),
        );
        assert_eq!(first.category, ViewCategory::Pdf);
        assert!(first.note.contains("report.pdf"));

        {
            let registered = registered.lock();
            assert_eq!(registered.len(), 1);
            let ModelMessage::User(message) = &registered[0] else {
                panic!("expected a user message");
            };
            let UserContent::Parts(parts) = &message.content else {
                panic!("expected parts");
            };
            let UserContentPart::File(file) = &parts[0] else {
                panic!("expected a file part");
            };
            assert_eq!(file.media_type, "application/pdf");
            assert_eq!(file.filename.as_deref(), Some("report.pdf"));
            assert_eq!(
                Value::Object(file.provider_options.clone().unwrap()),
                json!({ "bedrock": { "citations": { "enabled": true } } })
            );
            let UserContentPart::Text(text) = &parts[1] else {
                panic!("expected a text part");
            };
            assert_eq!(
                text.text,
                format!(
                    "[Document \"report.pdf\" (id={id}) attached for analysis via view_attachment]"
                )
            );
        }

        let (a, b) = tokio::join!(
            run_view_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), ctx.clone()),
            run_view_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), ctx.clone()),
        );
        let second = view_success(a.unwrap());
        view_success(b.unwrap());
        assert!(second.note.contains("already attached"));
        assert_eq!(registered.lock().len(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_releases_the_claim_when_the_pdf_content_expired() {
        let _db = crate::db::testing::test_db();
        let id = insert("gone.pdf", "application/pdf", None, None, THREAD_ID).await;
        let (ctx, registered) = pdf_ctx();
        let error = failure(
            run_view_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), ctx.clone())
                .await
                .unwrap(),
        );
        assert!(error.contains("expired"));
        assert!(ctx.injected_document_ids.unwrap().lock().is_empty());
        assert!(registered.lock().is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn view_rejects_an_oversized_pdf_with_a_hydrate_hint() {
        let _db = crate::db::testing::test_db();
        let id = insert(
            "huge.pdf",
            "application/pdf",
            Some(b"x"),
            Some(11 * 1024 * 1024),
            THREAD_ID,
        )
        .await;
        let (ctx, _) = pdf_ctx();
        let error = failure(
            run_view_attachment(input(&id), USER_ID, AGENT_ID, Some(THREAD_ID), ctx)
                .await
                .unwrap(),
        );
        assert_eq!(
            error,
            "Document exceeds the 10.49 MB size limit for inline viewing. Use hydrate_attachment to write it to disk and inspect with shell tools (e.g. pdftotext)."
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_model_output_loads_an_image_at_conversion_time() {
        let _db = crate::db::testing::test_db();
        let id = insert("photo.jpg", "image/jpeg", Some(b"hello"), None, THREAD_ID).await;
        let tools = get_attachment_tools(USER_ID, AGENT_ID, Some(THREAD_ID), Some("/tmp"), None);
        let to_model = tools["view_attachment"].to_model_output.clone().unwrap();
        let output = json!({
            "success": true,
            "attachmentId": id,
            "filename": "photo.jpg",
            "mediaType": "image/jpeg",
            "sizeBytes": 5,
            "category": "image",
            "note": "Image \"photo.jpg\" is attached to this tool result.",
        });
        let shown = to_model(ToModelOutputOptions {
            tool_call_id: "call-1".to_string(),
            input: json!({}),
            output: output.clone(),
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(shown).unwrap(),
            json!({
                "type": "content",
                "value": [
                    { "type": "text", "text": "[Viewing photo.jpg]" },
                    { "type": "image-data", "data": "aGVsbG8=", "mediaType": "image/jpeg" }
                ]
            })
        );

        let mut expired = output.clone();
        expired["attachmentId"] = json!("gone");
        let shown = to_model(ToModelOutputOptions {
            tool_call_id: "call-2".to_string(),
            input: json!({}),
            output: expired,
        })
        .await
        .unwrap();
        assert_eq!(
            shown,
            ToolResultOutput::text(
                "The content of \"photo.jpg\" is no longer available (expired)."
            )
        );

        let mut pdf = output.clone();
        pdf["category"] = json!("pdf");
        pdf["note"] = json!("Attached \"photo.jpg\" to the conversation.");
        let shown = to_model(ToModelOutputOptions {
            tool_call_id: "call-3".to_string(),
            input: json!({}),
            output: pdf,
        })
        .await
        .unwrap();
        assert_eq!(
            shown,
            ToolResultOutput::text("Attached \"photo.jpg\" to the conversation.")
        );

        let shown = to_model(ToModelOutputOptions {
            tool_call_id: "call-4".to_string(),
            input: json!({}),
            output: json!({ "success": false, "error": "Attachment not found." }),
        })
        .await
        .unwrap();
        assert_eq!(shown, ToolResultOutput::text("Attachment not found."));
    }

    #[tokio::test]
    async fn reaping_without_an_attachments_dir_removes_nothing() {
        let workspace = tempfile::tempdir().unwrap();
        assert_eq!(
            reap_scratch_dirs(workspace.path().to_str(), 1000)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn reaps_only_dirs_older_than_the_threshold() {
        let workspace = tempfile::tempdir().unwrap();
        let base = workspace.path().join(".attachments");
        let old_dir = base.join("thread-1").join("att-old");
        let new_dir = base.join("thread-1").join("att-new");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(old_dir.join("file.txt"), "old").unwrap();
        std::fs::write(new_dir.join("file.txt"), "new").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);
        std::fs::File::open(&old_dir)
            .unwrap()
            .set_modified(past)
            .unwrap();

        let count = reap_scratch_dirs(workspace.path().to_str(), 24 * 60 * 60 * 1000)
            .await
            .unwrap();

        assert_eq!(count, 1);
        assert!(!old_dir.exists());
        assert!(new_dir.exists());
    }
}
