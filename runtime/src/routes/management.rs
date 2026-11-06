//! Management routes.
//!
//! The runtime's REST surface: the agent-runtime owns its own data, so these routes
//! are the canonical CRUD layer for heartbeat, cron, threads, agent identity, and
//! subagent wiring. Each channel's routes are in its own router. Called by the
//! bundled Web UI. Lens Agents inbound routing terminates auth in front of the
//! container; routes are not protected by an internal secret.
//!
//! Agent identity:
//! - `GET    /agents/me`: agent identity (Web UI bootstrap)
//! - `PATCH  /agents/name`: rename agent
//! - `GET    /agents/model`: effective model (override or env default)
//! - `PATCH  /agents/model`: set/clear per-agent LLM model override
//! - `GET    /agents/heartbeat-model`: heartbeat model override + resolved effective
//! - `PATCH  /agents/heartbeat-model`: set/clear heartbeat model override
//! - `GET    /agents/cron-model`: cron model override + resolved effective
//! - `PATCH  /agents/cron-model`: set/clear cron model override
//! - `PATCH  /agents/verbose`: set per-step delivery flag
//! - `GET    /agents/details`: full agent record (markdown fields, verbose, lockedIn)
//! - `DELETE /agents`: delete agent
//!
//! Backup / restore:
//! - `GET    /agents/export`: gzipped snapshot of live SQLite
//! - `POST   /agents/import`: upload + restart-to-apply
//!
//! Heartbeat management:
//! - `POST   /agents/heartbeat/start`: start/restart heartbeat timer (force-enables)
//! - `POST   /agents/heartbeat/stop`: stop heartbeat timer
//! - `POST   /agents/heartbeat/trigger`: execute heartbeat immediately
//! - `GET    /agents/heartbeat/status`: get heartbeat state (incl. intervalMs)
//! - `PATCH  /agents/heartbeat/interval`: update interval + re-register timer
//!
//! Webhook subscriptions (inbound ingestion lives in `routes/webhook.rs`):
//! - `GET    /agents/webhooks/receiver`: receiver enabled state
//! - `PATCH  /agents/webhooks/receiver`: enable/disable the receiver
//! - `GET    /agents/webhook-subscriptions`: list subscriptions
//! - `POST   /agents/webhook-subscriptions`: create subscription
//! - `PATCH  /agents/webhook-subscriptions/{id}`: update (toggle/edit) subscription
//! - `DELETE /agents/webhook-subscriptions/{id}`: delete subscription
//!
//! Skills (Agent Skills, agentskills.io):
//! - `GET    /agents/skills`: list available skills (name + description + source)
//! - `POST   /agents/skills/{name}/run`: manually trigger a skill (streams over WS)
//!
//! Plugins (Agent Plugins, agent-plugins.org):
//! - `GET    /agents/plugins`: list installed plugins and what each contributes
//!
//! Conversation threads:
//! - `POST   /agents/threads`: create a thread (reuses an untouched one)
//! - `POST   /agents/threads/get-or-create-latest`: get or create latest thread
//! - `GET    /agents/threads`: list threads
//! - `GET    /agents/threads/{threadId}`: fetch thread + messages
//! - `POST   /agents/threads/{threadId}/messages`: add message
//! - `POST   /agents/threads/{threadId}/set-external-id`: set external id
//!
//! Subagents:
//! - `GET    /agents/{agentId}/subagents`: list
//! - `POST   /agents/{agentId}/subagents`: add child agent
//! - `DELETE /agents/{agentId}/subagents/{childAgentId}`: remove
//!
//! Misc:
//! - `POST   /agents/chat`: synchronous chat invoke
//! - `POST   /agents`: bootstrap agent

use std::sync::LazyLock;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query};
use axum::response::Response;
use axum::routing::{delete, get, patch, post};
use indexmap::IndexMap;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::config::ThreadMode;
use crate::db::models::WebhookSubscription;
use crate::lib::webhook_signature::{WebhookAuthAlgorithm, WebhookAuthEncoding, WebhookAuthType};
use crate::services::attachment_service::AttachmentCategory;
use crate::services::message_delivery_service::{MESSAGE_TRIGGERS, MessageTrigger};
use crate::services::skill_catalog_service::SkillSource;

/// 100 MiB cap on an uploaded `.prism` archive: agent DBs are tens of MB in practice;
/// this keeps a malformed or oversized upload from filling memory before validation
/// runs. It bounds the `file` part, as multer's `fileSize` limit does.
pub const ARCHIVE_UPLOAD_MAX_BYTES: usize = 100 * 1024 * 1024;

/// Room for the multipart envelope (boundaries, part headers, the `threadId` field)
/// above a route's file limit, so the body limit never refuses a file the per-file
/// limit accepts. The handler enforces the per-file limit itself.
const MULTIPART_ENVELOPE_BYTES: usize = 64 * 1024;

/// Display text of the heartbeat interval bounds in the 400 answer.
const MIN_INTERVAL: &str = "1 minute";
const MAX_INTERVAL: &str = "1 week";

/// The request keys that edit a subscription's sender auth.
const WEBHOOK_AUTH_KEYS: [&str; 7] = [
    "authType",
    "authHeader",
    "authPrefix",
    "authAlgorithm",
    "authEncoding",
    "authSignedUrl",
    "secret",
];

/// The triggers a client may add a message under. Not `AGENT_MESSAGE`: the model
/// reads that as another agent's message, and the web UI and CLI label it as one, so
/// only `POST /agents/agent-messages` stores one.
static CLIENT_MESSAGE_TRIGGERS: LazyLock<Vec<MessageTrigger>> = LazyLock::new(|| {
    MESSAGE_TRIGGERS
        .iter()
        .copied()
        .filter(|trigger| *trigger != MessageTrigger::AgentMessage)
        .collect()
});

/// The management routes, with their full `/agents/...` paths, in the order the
/// TypeScript router registered them.
pub fn router() -> Router {
    Router::new()
        // Agent identity
        .route("/agents/me", get(get_me))
        .route("/agents/name", patch(rename_agent))
        .route("/agents/model", get(get_model))
        .route("/agents/model", patch(update_model))
        .route("/agents/heartbeat-model", get(get_heartbeat_model))
        .route("/agents/heartbeat-model", patch(update_heartbeat_model))
        .route("/agents/cron-model", get(get_cron_model))
        .route("/agents/cron-model", patch(update_cron_model))
        .route("/agents/verbose", patch(update_verbose))
        // Backup / restore
        .route("/agents/export", get(export_agent))
        .route(
            "/agents/import",
            post(import_agent).layer(DefaultBodyLimit::max(
                ARCHIVE_UPLOAD_MAX_BYTES + MULTIPART_ENVELOPE_BYTES,
            )),
        )
        // Attachments (shared files)
        .route(
            "/agents/attachments",
            post(upload_attachment).layer(DefaultBodyLimit::max(
                crate::constants::MAX_FILE_SIZE_BYTES as usize + MULTIPART_ENVELOPE_BYTES,
            )),
        )
        .route("/agents/attachments/{id}", get(get_attachment))
        .route("/agents/attachments/{id}", delete(delete_attachment))
        // Heartbeat management
        .route("/agents/heartbeat/start", post(start_heartbeat))
        .route("/agents/heartbeat/stop", post(stop_heartbeat))
        .route("/agents/heartbeat/trigger", post(trigger_heartbeat))
        .route("/agents/heartbeat/status", get(heartbeat_status))
        .route(
            "/agents/heartbeat/interval",
            patch(update_heartbeat_interval),
        )
        // Webhook management
        .route("/agents/webhooks/receiver", get(get_webhook_receiver))
        .route("/agents/webhooks/receiver", patch(update_webhook_receiver))
        .route(
            "/agents/webhook-subscriptions",
            get(list_webhook_subscriptions),
        )
        .route(
            "/agents/webhook-subscriptions",
            post(create_webhook_subscription),
        )
        .route(
            "/agents/webhook-subscriptions/{id}",
            patch(update_webhook_subscription),
        )
        .route(
            "/agents/webhook-subscriptions/{id}",
            delete(delete_webhook_subscription),
        )
        // Goal management
        .route("/agents/goals", get(list_goals))
        .route("/agents/threads/{threadId}/goal", get(get_thread_goal))
        .route("/agents/goals", post(start_goal))
        .route("/agents/goals/{goalId}", delete(stop_goal))
        .route("/agents/goals/{goalId}/pause", post(pause_goal))
        .route("/agents/goals/{goalId}/resume", post(resume_goal))
        // Conversation
        .route(
            "/agents/threads/get-or-create-latest",
            post(get_or_create_latest_thread),
        )
        .route("/agents/threads", post(create_thread))
        .route("/agents/threads", get(list_threads))
        .route("/agents/threads/{threadId}", get(get_thread))
        .route(
            "/agents/threads/{threadId}/messages",
            post(add_thread_message),
        )
        .route(
            "/agents/threads/{threadId}/set-external-id",
            post(set_thread_external_id),
        )
        // Chat
        .route("/agents/chat", post(chat))
        // Agent CRUD
        .route("/agents", post(create_agent))
        .route("/agents/details", get(get_agent_details))
        .route("/agents", delete(delete_agent))
        .route("/agents/{agentId}/subagents", get(list_subagents))
        .route("/agents/{agentId}/subagents", post(add_subagent))
        .route(
            "/agents/{agentId}/subagents/{childAgentId}",
            delete(remove_subagent),
        )
        // Skills
        .route("/agents/skills", get(list_skills))
        .route("/agents/skills/{name}/run", post(run_skill))
        // Plugins
        .route("/agents/plugins", get(list_plugins))
        // Compaction
        .route("/agents/threads/{threadId}/compact", post(compact_thread))
}

// ============================================================================
// Wire types shared by several routes
// ============================================================================

/// Deserializes a field so that a key present with `null` reads as
/// `Some(Value::Null)`; with `#[serde(default)]` an absent key reads as `None`. This
/// keeps the TypeScript's `=== undefined` and `'key' in body` tests exact.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// `{ error }`, the error body of most routes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: String,
}

/// `{ error, fieldErrors }`: a 400 (or 409) whose message also names the form field
/// it belongs to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldErrorBody {
    pub error: String,
    pub field_errors: IndexMap<String, String>,
}

/// `{ success: true }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse {
    pub success: bool,
}

/// `{ success: true, message }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessMessageResponse {
    pub success: bool,
    pub message: String,
}

/// `{ threadId }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdResponse {
    pub thread_id: String,
}

/// `{ agent }`: an agent row or the service's answer about one.
#[derive(Debug, Clone, Serialize)]
pub struct AgentResponse<T: Serialize> {
    pub agent: T,
}

/// `{ result }`.
#[derive(Debug, Clone, Serialize)]
pub struct ResultResponse<T: Serialize> {
    pub result: T,
}

// ============================================================================
// Agent identity
// ============================================================================

/// The answer of `GET /agents/me`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub agent_id: String,
    pub user_id: String,
    pub name: String,
    /// The Web UI leaves the Computer page out where this host has no desktop for one.
    pub has_computer: bool,
    /// `single`: clients offer no way to start or switch a conversation.
    pub thread_mode: ThreadMode,
}

/// The answer of `PATCH /agents/name`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentityResponse {
    pub agent_id: String,
    pub user_id: String,
    pub name: String,
}

/// The body of `PATCH /agents/name`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBody {
    /// Handed to the service unchecked; the service holds it to the rule for names
    /// and answers a validation error (400) otherwise.
    pub name: Option<Value>,
}

/// `{ model }`, the answer of `GET` and `PATCH /agents/model`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponse {
    pub model: String,
}

/// `{ model, effective }`: a scoped model override (`null` when unset) and the model
/// a run would use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverrideResponse {
    pub model: Option<String>,
    pub effective: String,
}

/// The body of the `PATCH` model routes: `{ model: string | null }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBody {
    /// Required key: `None` (absent) answers 400
    /// `missing required field 'model' (use null to clear)`; `Some(Null)` clears the
    /// override. The value is handed to the service, which validates its format.
    #[serde(default, deserialize_with = "present")]
    pub model: Option<Value>,
}

/// The body of `PATCH /agents/verbose`: `{ verbose: boolean }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerboseBody {
    /// Required key: absent answers 400 `missing required field 'verbose'`. The value
    /// is handed to the service, which validates it.
    #[serde(default, deserialize_with = "present")]
    pub verbose: Option<Value>,
}

/// `{ verbose }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerboseResponse {
    pub verbose: bool,
}

/// GET /agents/me
///
/// The identity of the single agent this runtime owns. The Web UI calls this on
/// boot to resolve `agentId` and `userId` without needing them in the URL. 500
/// `{ error }` on failure, logged as `[Management] Failed to get /me: <msg>`.
async fn get_me() -> Response {
    todo!()
}

/// PATCH /agents/name
///
/// Rename the agent. Body: `{ name }`. Holds the name to the rule for names
/// (`lib/agent_name.rs`). The new name is read when the next turn builds its
/// context, so the agent picks up its new identity on the next chat turn. Answers
/// `{ agentId, userId, name }`; a validation error is 400 `{ error }`; anything else
/// is 500, logged as `[Management] Failed to rename agent: <msg>`.
async fn rename_agent(body: Option<Json<RenameBody>>) -> Response {
    todo!()
}

/// GET /agents/model
///
/// The **effective** model: the per-agent override when one is set, otherwise the
/// runtime's env-configured default. The caller doesn't need to know about the
/// override/default distinction; the server resolves it. Answers `{ model }`; 500
/// logged as `[Management] Failed to read model for agent: <msg>`.
async fn get_model() -> Response {
    todo!()
}

/// PATCH /agents/model
///
/// Set or clear the per-agent LLM model override. Body: `{ model: string | null }`.
/// `null` clears the override (falls back to the runtime default). Answers the
/// **resolved** effective model, the same shape as the GET, so the UI can prime its
/// cache from the mutation response without a refetch. The model string is
/// validated for format only (`AGENT_WORKSPACE_SERVICE.update_model`); a validation
/// error is 400; 500 logged as `[Management] Failed to update model for agent: <msg>`.
async fn update_model(body: Option<Json<ModelBody>>) -> Response {
    todo!()
}

/// GET /agents/heartbeat-model
///
/// Answers `{ model, effective }`: the raw heartbeat override (`null` when unset, so
/// the UI can show "empty → falls back") and the model a heartbeat run would
/// actually use (heartbeat override → main override → env default). 500 logged as
/// `[Management] Failed to read heartbeat model for agent: <msg>`.
async fn get_heartbeat_model() -> Response {
    todo!()
}

/// PATCH /agents/heartbeat-model
///
/// Set or clear the heartbeat model override. Body: `{ model: string | null }`.
/// `null` clears it (falls back to the main model, then env default). Answers
/// `{ model, effective }`, the same shape as the GET so the UI can prime its cache.
/// 400 for a missing key or a validation error; 500 logged as
/// `[Management] Failed to update heartbeat model for agent: <msg>`.
async fn update_heartbeat_model(body: Option<Json<ModelBody>>) -> Response {
    todo!()
}

/// GET /agents/cron-model
///
/// `{ model, effective }` for the cron model override. 500 logged as
/// `[Management] Failed to read cron model for agent: <msg>`.
async fn get_cron_model() -> Response {
    todo!()
}

/// PATCH /agents/cron-model
///
/// Set or clear the cron model override, as `PATCH /agents/heartbeat-model` does for
/// the heartbeat. 500 logged as
/// `[Management] Failed to update cron model for agent: <msg>`.
async fn update_cron_model(body: Option<Json<ModelBody>>) -> Response {
    todo!()
}

/// PATCH /agents/verbose
///
/// Set the verbose (per-step delivery) flag. Body: `{ verbose: boolean }`. Answers
/// `{ verbose }`; 400 for a missing key or a validation error; 500 logged as
/// `[Management] Failed to update verbose for agent: <msg>`.
async fn update_verbose(body: Option<Json<VerboseBody>>) -> Response {
    todo!()
}

// ============================================================================
// Backup / restore
// ============================================================================

/// `{ ok: true, restarting: true }`, the answer of `POST /agents/import`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub ok: bool,
    pub restarting: bool,
}

/// GET /agents/export
///
/// Stream a gzipped snapshot of the agent's SQLite DB as a `.prism` file, with
/// `Content-Type: application/octet-stream` and
/// `Content-Disposition: attachment; filename="<filename>"`. The snapshot is taken
/// with `VACUUM INTO` so heartbeat and cron writes in flight don't tear the file.
/// The archive's `cleanup` runs when the response closes. A stream error is logged
/// as `[Management] export stream error`, runs `cleanup`, and answers a bare 500
/// before the headers went out, else ends the connection. A failure before
/// streaming answers 500 `{ error }`, logged as
/// `[Management] Failed to export agent: <msg>`.
async fn export_agent() -> Response {
    todo!()
}

/// POST /agents/import
///
/// Multipart upload of a `.prism` file in the `file` field. Validates the archive,
/// stages it for the next process restart, then exits the process: bootstrap
/// pickup swaps the file into place before the database is opened.
///
/// The upload is read as multer read it: a file part over
/// `ARCHIVE_UPLOAD_MAX_BYTES`, an unexpected file field (`Unexpected field`) or a
/// malformed body answers 400 `Upload rejected: <multer message>` as JSON (another
/// upload failure: 400 with its message, or `Upload failed`). The agent is read
/// first (a missing agent is a 500). A missing or empty file is 400
/// ``Missing `file` field in multipart body``; an archive validation error is 400
/// with its message; anything else 500, logged as
/// `[Management] Failed to import agent: <msg>`.
///
/// On success answers 200 `{ ok: true, restarting: true }` and, once the response
/// has been sent, logs `[Management] import staged — exiting to apply on restart`
/// and exits the process with code 0 after 100 ms, so the client knows to poll
/// `/health`.
async fn import_agent(multipart: Multipart) -> Response {
    todo!()
}

// ============================================================================
// Attachments (shared files)
// ============================================================================

/// The answer of `POST /agents/attachments` (201): metadata only, never the bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadResponse {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: AttachmentCategory,
}

/// Which `Content-Disposition` a download gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentDispositionKind {
    Inline,
    Attachment,
}

impl ContentDispositionKind {
    fn as_str(self) -> &'static str {
        match self {
            ContentDispositionKind::Inline => "inline",
            ContentDispositionKind::Attachment => "attachment",
        }
    }
}

/// Whether `c` is whitespace to JavaScript's `String.prototype.trim`.
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// Strip CR/LF, quotes, backslashes and control chars from a header value.
fn sanitize_filename(name: &str) -> String {
    let out: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\r' | '\n' | '"' | '\\') {
                '_'
            } else {
                c
            }
        })
        .filter(|c| (*c as u32) >= 0x20)
        .collect();
    let trimmed = out.trim_matches(is_js_whitespace);
    let cut = crate::support::js::slice16(trimmed, 0, 255);
    if cut.is_empty() {
        "file".to_string()
    } else {
        cut
    }
}

/// `encodeURIComponent`'s unescaped set, less `'()*`, which RFC 5987 attr-chars
/// leave out: what stays bare is `A-Z a-z 0-9 - _ . ! ~`.
const RFC5987: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~');

/// Build a `Content-Disposition` value that survives non-latin1 filenames.
///
/// A header value outside latin-1 is refused outright, so `filename=` carries an
/// ASCII-only fallback while the real name travels RFC 5987-encoded in `filename*`
/// (which modern clients prefer).
fn content_disposition(disposition: ContentDispositionKind, filename: &str) -> String {
    let sanitized = sanitize_filename(filename);
    let ascii: String = sanitized
        .encode_utf16()
        .map(|unit| {
            if (0x20..=0x7e).contains(&unit) {
                char::from(unit as u8)
            } else {
                '_'
            }
        })
        .collect();
    let rfc5987 = utf8_percent_encode(&sanitized, RFC5987).to_string();
    format!(
        "{}; filename=\"{}\"; filename*=UTF-8''{}",
        disposition.as_str(),
        ascii,
        rfc5987
    )
}

/// POST /agents/attachments
///
/// Multipart upload of one shared file (web drag-and-drop) in the `file` field,
/// with an optional `threadId` text field. Stores the bytes and answers 201 with
/// metadata only (never the bytes). The attachment is created unlinked; the chat
/// send links it to the user message via `attachmentIds`.
///
/// The upload is read as multer read it, with `MAX_FILE_SIZE_BYTES` per file: a
/// file over it answers 400 `Upload rejected: File too large (max <MAX_FILE_SIZE_MB>
/// MB)`, another multer error 400 `Upload rejected: <message>`, another failure 400
/// with its message or `Upload failed`. A missing or empty file is 400
/// ``Missing or empty `file` field in multipart body``; a file over the limit after
/// reading is 400 `File too large (max <MAX_FILE_SIZE_MB> MB)`. The media type is
/// detected from the bytes, the original name and the declared type, and the
/// category classified from it; the row is stored with `source: 'web'`, filename
/// `file` when the part has none. 500 logged as
/// `[Management] Failed to store attachment: <msg>`.
async fn upload_attachment(multipart: Multipart) -> Response {
    todo!()
}

/// GET /agents/attachments/{id}
///
/// Stream a stored file's bytes back for download or preview. 404
/// `Attachment not found`; 410 `Attachment content expired` when the metadata row
/// outlived its content (the TTL). Only images and PDFs are served `inline` with
/// their own `Content-Type` (types a browser renders without running script under
/// nosniff); the rest are `attachment` with `application/octet-stream`. Always
/// `X-Content-Type-Options: nosniff`, and `Content-Disposition` from
/// `content_disposition`. The web UI's `<a download>` still forces a save. 500
/// logged as `[Management] Failed to fetch attachment <id>: <msg>`.
async fn get_attachment(Path(id): Path<String>) -> Response {
    todo!()
}

/// DELETE /agents/attachments/{id}
///
/// Remove a pre-send (unlinked) attachment, used when the user removes a chip before
/// sending. Linked attachments are immutable here (they cascade with messages). 404
/// `Attachment not found or already linked to a message` when nothing was deleted;
/// otherwise `{ success: true }`. 500 logged as
/// `[Management] Failed to delete attachment <id>: <msg>`.
async fn delete_attachment(Path(id): Path<String>) -> Response {
    todo!()
}

// ============================================================================
// Heartbeat management
// ============================================================================

/// The body of `POST /agents/heartbeat/start`: `{ agent }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatStartBody {
    /// Kept as the request's shape: a falsy value answers 400
    /// `Missing agent in request body`, and the config is read from the database.
    pub agent: Option<Value>,
}

/// The body of `PATCH /agents/heartbeat/interval`: `{ intervalMs: number }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatIntervalBody {
    /// A finite JSON number, else 400 `intervalMs must be a finite number`; between
    /// `MIN_HEARTBEAT_INTERVAL_MS` and `MAX_HEARTBEAT_INTERVAL_MS` inclusive, else 400.
    pub interval_ms: Option<Value>,
}

/// `{ success: true, result }`, the answer of `POST /agents/heartbeat/trigger`, with
/// the heartbeat's result.
#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatTriggerResponse<T: Serialize> {
    pub success: bool,
    pub result: T,
}

/// The heartbeat status answered when no heartbeat is registered.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatStatusFallback {
    pub is_active: bool,
    /// Always null here.
    pub last_run: Option<String>,
    pub is_running: bool,
    pub consecutive_errors: i64,
    /// Only `PATCH /agents/heartbeat/interval` adds it: the interval just written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<i64>,
}

/// POST /agents/heartbeat/start
///
/// Start or restart the heartbeat timer. Body: `{ agent }`, kept as the request's
/// shape; the config is read from the database. The schedule comes off the
/// persisted row, not the body: a client sends the agent as JSON, where a timestamp
/// is an ISO string rather than a date, and the interval, the last run and the
/// stored deadline all decide it.
///
/// Force-enables: this endpoint's whole purpose is to turn the heartbeat on,
/// regardless of what status the persisted row carries (the persisted row with
/// `heartbeatStatus: ENABLED`, `keep-schedule`). The STOPPED short-circuit in
/// `start_heartbeat` is for the boot-time loader. Answers
/// `{ success: true, message: 'Heartbeat started' }`; 500 logged as
/// `[Management] Failed to start heartbeat for agent: <msg>`.
async fn start_heartbeat(body: Option<Json<HeartbeatStartBody>>) -> Response {
    todo!()
}

/// POST /agents/heartbeat/stop
///
/// Stop the heartbeat timer. Answers `{ success: true, message: 'Heartbeat stopped' }`;
/// 500 logged as `[Management] Failed to stop heartbeat for agent: <msg>`.
async fn stop_heartbeat() -> Response {
    todo!()
}

/// POST /agents/heartbeat/trigger
///
/// Execute a heartbeat immediately and answer `{ success: true, result }` with the
/// heartbeat's result. 500 logged as
/// `[Management] Failed to trigger heartbeat for agent: <msg>`.
async fn trigger_heartbeat() -> Response {
    todo!()
}

/// GET /agents/heartbeat/status
///
/// The heartbeat state (`HEARTBEAT_SERVICE.get_status()`), or
/// `{ isActive: false, lastRun: null, isRunning: false, consecutiveErrors: 0 }` when
/// none is registered. 500 logged as
/// `[Management] Failed to get heartbeat status for agent: <msg>`.
async fn heartbeat_status() -> Response {
    todo!()
}

/// PATCH /agents/heartbeat/interval
///
/// Update the heartbeat interval. Persists `heartbeatIntervalMs` to the agent row
/// and re-registers the timer with the new interval, which starts from now
/// (`new-interval`): a user changing the cadence asks for the next check one new
/// interval away. `start_heartbeat` short-circuits when `heartbeatStatus` is
/// STOPPED, so the user's start/stop preference is respected without racing the
/// persisted heartbeat-status flag.
///
/// Body: `{ intervalMs }`. 400 `intervalMs must be a finite number`; 400
/// `intervalMs must be between <MIN> (1 minute) and <MAX> (1 week)`. Answers the
/// heartbeat status, or the fallback with `intervalMs` when none is registered.
/// 500 logged as `[Management] Failed to update heartbeat interval for agent: <msg>`.
async fn update_heartbeat_interval(body: Option<Json<HeartbeatIntervalBody>>) -> Response {
    todo!()
}

// ============================================================================
// Webhook management
// ============================================================================
//
// CRUD for inbound webhook subscriptions + the receiver master switch, consumed by
// the Webhooks page in the web SPA. The ingestion endpoint
// (POST /agents/webhooks/{name}) lives in routes/webhook.rs.
//
// Responses always go through `to_public_subscription()`: the stored sender secret
// must never travel back out, so clients see `hasSecret` instead.

/// The generic sender-auth fields, as stored on a subscription row. The three
/// enumerated ones are typed by `lib::webhook_signature`'s enums, which have the
/// same members as the database enums, so validated values drop straight into a
/// create or update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookAuthFields {
    pub auth_type: WebhookAuthType,
    pub auth_header: Option<String>,
    pub auth_prefix: Option<String>,
    pub auth_algorithm: WebhookAuthAlgorithm,
    pub auth_encoding: WebhookAuthEncoding,
    pub auth_signed_url: Option<String>,
    pub secret: Option<String>,
}

/// The auth fields of a new subscription before the request's own.
fn webhook_auth_defaults() -> WebhookAuthFields {
    WebhookAuthFields {
        auth_type: WebhookAuthType::Token,
        auth_header: None,
        auth_prefix: None,
        auth_algorithm: WebhookAuthAlgorithm::Sha256,
        auth_encoding: WebhookAuthEncoding::Hex,
        auth_signed_url: None,
        secret: None,
    }
}

/// The body of `POST /agents/webhook-subscriptions` and
/// `PATCH /agents/webhook-subscriptions/{id}`. Every field is read loosely, by hand,
/// as the TypeScript read it: `None` is an absent key, `Some(Value::Null)` an explicit
/// `null`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSubscriptionBody {
    /// POST only: normalized by `normalize_webhook_name`; required, and must match
    /// `WEBHOOK_NAME_RE`.
    #[serde(default, deserialize_with = "present")]
    pub name: Option<Value>,
    /// PATCH only: applied when a boolean.
    #[serde(default, deserialize_with = "present")]
    pub is_active: Option<Value>,
    /// Applied when a string; trimmed, empty is null.
    #[serde(default, deserialize_with = "present")]
    pub description: Option<Value>,
    /// Applied when a string; trimmed, empty is null.
    #[serde(default, deserialize_with = "present")]
    pub events: Option<Value>,
    /// Applied when a string; trimmed, empty is null.
    #[serde(default, deserialize_with = "present")]
    pub prompt: Option<Value>,
    /// One of `DELIVER_TARGETS`; POST defaults to `all` when absent or null.
    #[serde(default, deserialize_with = "present")]
    pub deliver_to: Option<Value>,
    /// The Slack channel list, validated against the effective target.
    #[serde(default, deserialize_with = "present")]
    pub slack_channel_ids: Option<Value>,
    /// Applied when a boolean (POST: only `true` turns it on).
    #[serde(default, deserialize_with = "present")]
    pub deliver_only: Option<Value>,
    /// One of `WEBHOOK_AUTH_TYPES`.
    #[serde(default, deserialize_with = "present")]
    pub auth_type: Option<Value>,
    /// String or null; `''` and null clear; trimmed.
    #[serde(default, deserialize_with = "present")]
    pub auth_header: Option<Value>,
    /// String or null; `''` and null clear; keeps its inner spacing (`Bearer `).
    #[serde(default, deserialize_with = "present")]
    pub auth_prefix: Option<Value>,
    /// One of `WEBHOOK_AUTH_ALGORITHMS`.
    #[serde(default, deserialize_with = "present")]
    pub auth_algorithm: Option<Value>,
    /// One of `WEBHOOK_AUTH_ENCODINGS`.
    #[serde(default, deserialize_with = "present")]
    pub auth_encoding: Option<Value>,
    /// String or null; `''` and null clear; trimmed; an absolute http(s) URL.
    #[serde(default, deserialize_with = "present")]
    pub auth_signed_url: Option<Value>,
    /// String or null; `''` and null clear; trimmed.
    #[serde(default, deserialize_with = "present")]
    pub secret: Option<Value>,
}

impl WebhookSubscriptionBody {
    /// The value under one of `WEBHOOK_AUTH_KEYS`, as `body[key]` read it.
    fn auth_key(&self, key: &str) -> Option<&Value> {
        match key {
            "authType" => self.auth_type.as_ref(),
            "authHeader" => self.auth_header.as_ref(),
            "authPrefix" => self.auth_prefix.as_ref(),
            "authAlgorithm" => self.auth_algorithm.as_ref(),
            "authEncoding" => self.auth_encoding.as_ref(),
            "authSignedUrl" => self.auth_signed_url.as_ref(),
            "secret" => self.secret.as_ref(),
            _ => None,
        }
    }
}

/// The body of `PATCH /agents/webhooks/receiver`: `{ enabled: boolean }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookReceiverBody {
    /// A boolean, else 400 `enabled must be a boolean`.
    pub enabled: Option<Value>,
}

/// The answer of `GET /agents/webhooks/receiver`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookReceiverState {
    pub enabled: bool,
    /// The webhook port.
    pub port: u16,
    /// Its public origin when the deployment exposes one, else null.
    pub public_url: Option<String>,
}

/// `{ enabled }`, the answer of `PATCH /agents/webhooks/receiver`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookReceiverEnabled {
    pub enabled: bool,
}

/// The update route's terminal outcome, as telemetry names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubscriptionUpdateOutcome {
    Success,
    Invalid,
    NotFound,
    Error,
}

impl SubscriptionUpdateOutcome {
    fn as_str(self) -> &'static str {
        match self {
            SubscriptionUpdateOutcome::Success => "success",
            SubscriptionUpdateOutcome::Invalid => "invalid",
            SubscriptionUpdateOutcome::NotFound => "not_found",
            SubscriptionUpdateOutcome::Error => "error",
        }
    }
}

/// Whether `value` is an absolute http(s) URL, the only kind a sender can sign.
fn is_http_url(value: &str) -> bool {
    url::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

/// A field error: `{ error: message, fieldErrors: { [field]: message } }`.
fn field_error(field: &str, message: &str) -> FieldErrorBody {
    let mut field_errors = IndexMap::new();
    field_errors.insert(field.to_string(), message.to_string());
    FieldErrorBody {
        error: message.to_string(),
        field_errors,
    }
}

/// Read and validate the generic auth fields from a request body against the
/// subscription's current state, so a PATCH is judged on the **effective** result
/// (switching an existing row to `hmac` without a stored secret is a 400, not a
/// silently unverifiable endpoint). PATCH passes the row's auth fields as `current`.
///
/// Unlike the loosely-typed descriptive fields, a non-string credential is an
/// explicit error rather than an ignored value: silently dropping a secret would
/// leave the sender thinking it configured auth when it hasn't.
///
/// The result starts from `current`'s auth fields alone, never the rest of the row,
/// so an update never writes back stale columns. In order: `authType`,
/// `authAlgorithm`, `authEncoding` (each `<key> must be one of: <list>`); then
/// `authHeader`, `authPrefix`, `authSignedUrl`, `secret` (`<key> must be a string`;
/// null and `''` clear; only the prefix keeps its spacing). Only an HMAC signs a URL,
/// so another type clears `authSignedUrl`; a signed URL must pass `is_http_url`
/// (`The signed URL must be an absolute http or https URL`). Type `none` clears the
/// header, prefix and secret and succeeds. Otherwise a secret is required
/// (`A secret is required for '<type>' authentication`) and then a header
/// (`A header name is required for '<type>' authentication (e.g. X-Hub-Signature-256)`).
fn read_webhook_auth_fields(
    body: &WebhookSubscriptionBody,
    current: &WebhookAuthFields,
) -> Result<WebhookAuthFields, FieldErrorBody> {
    todo!()
}

/// Read a subscription's Slack channel list
/// (`DELIVERY_TARGET_SERVICE.read_channel_ids`), its error keyed to the
/// `slackChannelIds` field. `Ok(None)` clears the list.
async fn read_slack_channel_ids(
    raw: &Value,
    deliver_to: &str,
    agent_id: &str,
    stored: &[String],
) -> Result<Option<String>, FieldErrorBody> {
    todo!()
}

/// Deliver only posts the message template, and `none` would discard it.
fn deliver_only_needs_target() -> FieldErrorBody {
    let mut field_errors = IndexMap::new();
    field_errors.insert(
        "deliverOnly".to_string(),
        "Deliver only needs a target. Choose a target other than None.".to_string(),
    );
    FieldErrorBody {
        error: "deliverOnly needs a deliverTo other than 'none'".to_string(),
        field_errors,
    }
}

/// The update route's one telemetry event, `webhook subscription updated`, sent on
/// every terminal outcome for `config.owner_user_id`: `agent.id` (when set),
/// `webhook.subscription_id`, `webhook.outcome`, and with the stored state on
/// success `webhook.is_active`, `webhook.deliver_to`, `webhook.slack_channels` (the
/// count), `webhook.deliver_only` and `webhook.auth_type`.
fn track_subscription_update(
    subscription_id: &str,
    outcome: SubscriptionUpdateOutcome,
    stored: Option<&WebhookSubscription>,
) {
    todo!()
}

/// GET /agents/webhooks/receiver
///
/// Whether the inbound webhook receiver is enabled, and where senders reach it: the
/// webhook port, plus its public origin when the deployment exposes one. 500 logged
/// as `[Management] Failed to read webhook receiver state: <msg>`.
async fn get_webhook_receiver() -> Response {
    todo!()
}

/// PATCH /agents/webhooks/receiver
///
/// Enable or disable the inbound webhook receiver (hot toggle, no restart). Body:
/// `{ enabled: boolean }`. Answers `{ enabled }` as the receiver reports it after
/// the change. 500 logged as `[Management] Failed to toggle webhook receiver: <msg>`.
async fn update_webhook_receiver(body: Option<Json<WebhookReceiverBody>>) -> Response {
    todo!()
}

/// GET /agents/webhook-subscriptions
///
/// Every subscription, newest first, each through `to_public_subscription`. 500
/// logged as `[Management] Failed to list webhook subscriptions: <msg>`.
async fn list_webhook_subscriptions() -> Response {
    todo!()
}

/// POST /agents/webhook-subscriptions
///
/// Create a webhook subscription. Body: `{ name, description?, events?, prompt?,
/// deliverTo?, slackChannelIds?, deliverOnly?, authType?, authHeader?, authPrefix?,
/// authAlgorithm?, authEncoding?, authSignedUrl?, secret? }`.
///
/// 400 `{ error, fieldErrors }` in this order: a missing name
/// (`name is required` / `Name is required`); a name failing `WEBHOOK_NAME_RE`
/// (`Invalid name: <name>` / `Use lowercase letters, digits, hyphens, and
/// underscores (must start with a letter or digit)`); a bad `deliverTo`
/// (`deliverTo must be one of: <list>` / `Must be one of: <list>`); `deliverOnly`
/// with `none` (`deliver_only_needs_target`); the auth fields against
/// `webhook_auth_defaults`; the Slack channel list (only when the key is present,
/// with no stored channels). A name already taken (P2002) is 409
/// `A subscription named "<name>" already exists` /
/// `"<name>" is already taken`. On success emits `webhook subscription created` and
/// answers 201 with the public subscription. Any other failure is logged with only
/// its error name (`errorName`) as `[Management] Failed to create webhook
/// subscription` and answers 500 `Failed to create webhook subscription`.
async fn create_webhook_subscription(body: Option<Json<WebhookSubscriptionBody>>) -> Response {
    todo!()
}

/// PATCH /agents/webhook-subscriptions/{id}
///
/// Update a subscription (`isActive` toggle and/or editable fields). Body: any of
/// `{ isActive, description, events, prompt, deliverTo, slackChannelIds,
/// deliverOnly, authType, authHeader, authPrefix, authAlgorithm, authEncoding,
/// authSignedUrl, secret }`.
///
/// Auth fields are validated against the row's current state, so the *result* of
/// the update has to be verifiable, and switching `authType` to `none` clears the
/// stored credential. The Slack channel list is validated against the effective
/// target, and a target whose adapter has no linked channel ids clears it. 404
/// `Webhook subscription not found`; 400 `No updatable fields provided` when nothing
/// applies. Every terminal outcome emits `track_subscription_update` once. Any other
/// failure is logged with its error name as
/// `[Management] Failed to update webhook subscription` and answers 500
/// `Failed to update webhook subscription`.
async fn update_webhook_subscription(
    Path(id): Path<String>,
    body: Option<Json<WebhookSubscriptionBody>>,
) -> Response {
    todo!()
}

/// DELETE /agents/webhook-subscriptions/{id}
///
/// Delete a subscription and answer `{ success: true }`. 404
/// `Webhook subscription not found` (P2025). Telemetry
/// (`webhook subscription deleted`) is best-effort: the row is already gone, so a
/// failure there is logged as a warning,
/// `[Management] webhook-subscription-deleted telemetry failed: <msg>`, and the
/// answer stays a success. 500 logged as
/// `[Management] Failed to delete webhook subscription <id>: <msg>`.
async fn delete_webhook_subscription(Path(id): Path<String>) -> Response {
    todo!()
}

// ============================================================================
// Goal management
// ============================================================================

/// The body of `POST /agents/goals`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartGoalBody {
    /// Required (truthy).
    pub thread_id: Option<String>,
    /// A non-blank string, else 400 `Missing required fields: threadId, objective`;
    /// at most `GOAL_MAX_OBJECTIVE_CHARS` UTF-16 units, else 400
    /// `Objective is too long (max <n> characters)`.
    pub objective: Option<Value>,
    /// Optional; when present and not null, a positive integer, else 400
    /// `tokenBudget must be a positive integer`.
    pub token_budget: Option<Value>,
    /// A chat platform name, else `websocket`.
    pub origin_channel: Option<Value>,
    /// Used when a string, else null.
    pub origin_channel_id: Option<Value>,
}

/// GET /agents/goals
///
/// All goals for the agent (newest first), as `GOAL_SERVICE.list_goals` answers.
/// 500 logged as `[Management] Failed to list goals: <msg>`.
async fn list_goals() -> Response {
    todo!()
}

/// GET /agents/threads/{threadId}/goal
///
/// The current active (or paused) goal for a thread, or `null`. 500 logged as
/// `[Management] Failed to get goal for thread <threadId>: <msg>`.
async fn get_thread_goal(Path(thread_id): Path<String>) -> Response {
    todo!()
}

/// POST /agents/goals
///
/// Start (or replace) the active goal on a thread. One active goal per thread.
/// Body: `{ threadId, objective, tokenBudget?, originChannel?, originChannelId? }`.
/// Answers 201 with the goal. 500 logged as `[Management] Failed to start goal: <msg>`.
async fn start_goal(body: Option<Json<StartGoalBody>>) -> Response {
    todo!()
}

/// DELETE /agents/goals/{goalId}
///
/// Stop a goal (aborts its loop) and answer it. 404 `Goal not found`. 500 logged as
/// `[Management] Failed to stop goal <goalId>: <msg>`.
async fn stop_goal(Path(goal_id): Path<String>) -> Response {
    todo!()
}

/// POST /agents/goals/{goalId}/pause
///
/// Pause an active goal (the loop exits after the current turn) and answer it. 404
/// `Goal not found`. 500 logged as `[Management] Failed to pause goal <goalId>: <msg>`.
async fn pause_goal(Path(goal_id): Path<String>) -> Response {
    todo!()
}

/// POST /agents/goals/{goalId}/resume
///
/// Resume a paused goal (restarts its loop) and answer it. 404 `Goal not found`. 500
/// logged as `[Management] Failed to resume goal <goalId>: <msg>`.
async fn resume_goal(Path(goal_id): Path<String>) -> Response {
    todo!()
}

// ============================================================================
// Conversation
// ============================================================================

/// `{ agentId, userId }`, the body of the thread-creating routes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserBody {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
}

/// The query of `GET /agents/threads`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListQuery {
    /// Required.
    pub user_id: Option<String>,
    /// Required.
    pub agent_id: Option<String>,
    /// `Number(limit)`: a positive integer, else 400 `limit must be a positive integer`.
    pub limit: Option<String>,
    /// A `ThreadSource` value filters by it; any other value is ignored.
    pub thread_source: Option<String>,
}

/// The query of `GET /agents/threads/{threadId}`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadQuery {
    /// Required.
    pub user_id: Option<String>,
    /// Required.
    pub agent_id: Option<String>,
    /// `parseInt`; a positive value pages the history, capped at `MAX_MESSAGE_PAGE`.
    pub limit: Option<String>,
    /// With `limit`: the page ends just before this message id. Ignored when empty.
    pub before: Option<String>,
}

/// The body of `POST /agents/threads/{threadId}/messages`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMessageBody {
    /// Required (truthy).
    pub content: Option<String>,
    /// Required; a `MessageRole` value, else 400
    /// `Invalid role: <role>. Must be one of: <values>`.
    pub role: Option<Value>,
    /// Required; one of `CLIENT_MESSAGE_TRIGGERS`, else 400
    /// `Invalid triggeredBy: <value>. Must be one of: <list>`.
    pub triggered_by: Option<Value>,
    pub tool_calls: Option<Vec<Value>>,
    pub blocks: Option<Vec<Value>>,
    pub sender_external_id: Option<String>,
    pub sender_name: Option<String>,
}

/// The body of `POST /agents/threads/{threadId}/set-external-id`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalIdBody {
    /// Required (truthy), else 400 `Missing required field: externalThreadId`.
    pub external_thread_id: Option<String>,
}

/// POST /agents/threads/get-or-create-latest
///
/// Get or create the latest thread for a user and agent pair, and answer the thread
/// row. Body: `{ agentId, userId }`; 400
/// `Missing required fields: agentId, userId`. 500 logged as
/// `[Management] Failed to get or create latest thread: <msg>`.
async fn get_or_create_latest_thread(body: Option<Json<AgentUserBody>>) -> Response {
    todo!()
}

/// POST /agents/threads
///
/// Start a fresh conversation (web "new conversation" button). Reuses the newest
/// thread when it is still untouched instead of creating another. Body:
/// `{ agentId, userId }`; 400 `Missing required fields: agentId, userId`. Answers
/// the thread row. 500 logged as `[Management] Failed to create thread: <msg>`.
async fn create_thread(body: Option<Json<AgentUserBody>>) -> Response {
    todo!()
}

/// GET /agents/threads
///
/// List threads for a user and agent (newest first), with an optional limit.
/// `threadSource=DATABASE` keeps only web/CLI threads (drops channel threads): the
/// resumable set the web chat shows. Any value other than a known `ThreadSource` is
/// ignored (no channel filter). 400 `Missing required query params: userId, agentId`.
/// 500 logged as `[Management] Failed to list threads: <msg>`.
async fn list_threads(Query(query): Query<ThreadListQuery>) -> Response {
    todo!()
}

/// GET /agents/threads/{threadId}
///
/// Fetch a thread with messages (with ownership check). With `limit`, the thread
/// holds one page of history: the newest `limit` messages, or those before the
/// message `before`. Without it, the whole history. 400
/// `Missing required query params: userId, agentId`; 404 `Thread not found`. 500
/// logged as `[Management] Failed to get thread: <msg>`.
async fn get_thread(Path(thread_id): Path<String>, Query(query): Query<ThreadQuery>) -> Response {
    todo!()
}

/// POST /agents/threads/{threadId}/messages
///
/// Add a message to a thread and answer 201 with the stored message. Body:
/// `{ content, role, triggeredBy, toolCalls?, blocks?, senderExternalId?,
/// senderName? }`. 400 `Missing required field(s): <list>` naming each falsy one of
/// `content`, `role`, `triggeredBy`. `triggeredBy` is validated against the
/// runtime's own list, not the database enum: that enum keeps SYSTEM so history
/// stays readable, and nothing produces a SYSTEM message any more. 500 logged as
/// `[Management] Failed to add message to thread <threadId>: <msg>`.
async fn add_thread_message(
    Path(thread_id): Path<String>,
    body: Option<Json<AddMessageBody>>,
) -> Response {
    todo!()
}

/// POST /agents/threads/{threadId}/set-external-id
///
/// Set the external thread id on a thread. Body: `{ externalThreadId }`. Answers
/// `{ success: true }`. 500 logged as
/// `[Management] Failed to set external ID on thread <threadId>: <msg>`.
async fn set_thread_external_id(
    Path(thread_id): Path<String>,
    body: Option<Json<SetExternalIdBody>>,
) -> Response {
    todo!()
}

// ============================================================================
// Chat (for the frontend REST API)
// ============================================================================

/// The body of `POST /agents/chat`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBody {
    /// Required.
    pub user_id: Option<String>,
    /// Required.
    pub agent_id: Option<String>,
    /// A string, non-blank unless `attachmentIds` is a non-empty array; else 400
    /// `userId, agentId, and either message text or attachmentIds are required`.
    pub message: Option<Value>,
    pub thread_id: Option<String>,
    /// `ChatInput.metadata`, handed through as the client sent it.
    pub metadata: Option<Value>,
    /// Ids of stored attachments to link; counts only when an array.
    pub attachment_ids: Option<Value>,
}

/// POST /agents/chat
///
/// Synchronous chat endpoint for the frontend REST API. Body:
/// `{ userId, agentId, message, threadId?, metadata?, attachmentIds? }`. Answers the
/// engine's chat response.
///
/// The in-flight generation is cancelled when the HTTP client hangs up before the
/// reply is written: a hang-up, not a reply that finished normally, cancels it. In
/// axum the handler future is dropped on a hang-up, so the cancellation token is
/// cancelled from a drop guard that a finished reply disarms. 500 logged as
/// `[Management] Chat failed for user <userId>: <msg>`.
async fn chat(body: Option<Json<ChatBody>>) -> Response {
    todo!()
}

// ============================================================================
// Agent CRUD
// ============================================================================

/// The body of `POST /agents`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentBody {
    pub id: Option<String>,
    pub user_id: Option<String>,
    pub name: Option<String>,
    /// An `AgentType` value, else 400
    /// `Invalid agentType. Must be one of: <values>`.
    pub agent_type: Option<Value>,
    pub team_name: Option<String>,
}

/// The body of `DELETE /agents`: `{ userId?, allowedByTeam? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentBody {
    pub user_id: Option<String>,
    /// Any truthy value allows the delete without the owner check.
    pub allowed_by_team: Option<Value>,
}

/// The body of `POST /agents/{agentId}/subagents`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSubagentBody {
    /// Required, else 400 `Missing required field: childAgentId`.
    pub child_agent_id: Option<String>,
    pub description: Option<String>,
}

/// `{ subagents }`, the answer of `GET /agents/{agentId}/subagents`.
#[derive(Debug, Clone, Serialize)]
pub struct SubagentsResponse<T: Serialize> {
    pub subagents: T,
}

/// POST /agents
///
/// Create a new agent with org/team context and default workspace files. Body:
/// `{ id, userId, name, agentType, teamName }`; 400
/// `Missing required fields: id, userId, name, agentType, teamName` when one is
/// falsy. Answers 201 `{ agent }`. 500 logged as
/// `[Management] Failed to create agent: <msg>`.
async fn create_agent(body: Option<Json<CreateAgentBody>>) -> Response {
    todo!()
}

/// GET /agents/details
///
/// The agent record (no access check), as `{ agent }`. 500 logged with the error
/// under `err` as `[Management] Failed to get agent`.
async fn get_agent_details() -> Response {
    todo!()
}

/// DELETE /agents
///
/// Delete the agent with an optional ownership check. Body:
/// `{ userId?, allowedByTeam? }` (optional). Answers `{ result }` with the service's
/// `deleted` or `forbidden`. 500 logged as `[Management] Failed to delete agent: <msg>`.
async fn delete_agent(body: Option<Json<DeleteAgentBody>>) -> Response {
    todo!()
}

/// GET /agents/{agentId}/subagents
///
/// List subagents for an agent, as `{ subagents }`. 500 logged as
/// `[Management] Failed to get subagents for agent: <msg>`.
async fn list_subagents(Path(agent_id): Path<String>) -> Response {
    todo!()
}

/// POST /agents/{agentId}/subagents
///
/// Add a subagent to a parent agent. Body: `{ childAgentId, description? }`. A
/// service refusal answers `{ error: <reason> }`: 404 for `parent_not_found` and
/// `child_not_found`, 400 for any other. Answers 201 `{ agent }`. 500 logged as
/// `[Management] Failed to add subagent to agent: <msg>`.
async fn add_subagent(
    Path(agent_id): Path<String>,
    body: Option<Json<AddSubagentBody>>,
) -> Response {
    todo!()
}

/// DELETE /agents/{agentId}/subagents/{childAgentId}
///
/// Remove a subagent from a parent agent. 404 `{ error: 'parent_not_found' }` or
/// `{ error: 'link_not_found' }`; otherwise `{ result }`. 500 logged as
/// `[Management] Failed to remove subagent from agent: <msg>`.
async fn remove_subagent(Path((agent_id, child_agent_id)): Path<(String, String)>) -> Response {
    todo!()
}

// ============================================================================
// Skills (Agent Skills, agentskills.io). Used by both the web SPA and the CLI.
// ============================================================================

/// The query of `GET /agents/skills`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsQuery {
    /// Scope the listing to this thread's workspace, when non-empty and owned.
    pub thread_id: Option<String>,
}

/// One row of `GET /agents/skills`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListing {
    pub name: String,
    pub description: String,
    pub dir_name: String,
    pub source: SkillSource,
    /// Present only on plugin-contributed skills, so a capability can be traced back
    /// to the plugin that supplied it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

/// The body of `POST /agents/skills/{name}/run` (optional).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSkillBody {
    /// The thread the client is viewing, used when a non-empty string.
    pub thread_id: Option<Value>,
}

/// `{ threadId, skill }`, the 202 answer of `POST /agents/skills/{name}/run`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRunResponse {
    pub thread_id: String,
    pub skill: String,
}

/// GET /agents/skills
///
/// Available Agent Skills (name + description + on-disk folder + source). Bodies are
/// not included; the agent loads a skill's full SKILL.md via the `skill` tool
/// (progressive disclosure). Powers the `/skills` listing.
///
/// The listing is scoped to a thread's workspace: when that thread has a
/// `workspaceRoot` (the repo the CLI was started in), the repo's `.claude/skills` and
/// `.agents/skills` are merged in (labeled `source: "workspace"`). The thread is the
/// ownership-checked `?threadId` when given (with an agent id), else the latest web
/// thread, read-only (never creates one), so the CLI, which doesn't track its thread
/// id, still gets its repo's skills. Web threads have no `workspaceRoot`, so they
/// list global skills only. 500 logged as `[Management] GET /skills failed: <msg>`.
async fn list_skills(Query(query): Query<SkillsQuery>) -> Response {
    todo!()
}

/// POST /agents/skills/{name}/run
///
/// Manually trigger a skill (the `/skills run` command in the web and CLI). The UI
/// parses the slash command and calls this REST endpoint (a slash command is never
/// parsed in the conversation engine). The run is dispatched as an ordinary chat
/// turn, with the message `Use the "<name>" skill.` on the `websocket` channel and
/// the web chat label, so the streamed reply rides out over the WebSocket channel the
/// client is already on. Fire-and-forget: answers 202 `{ threadId, skill }` at once;
/// a failed turn is logged with `err` as `[Management] skill run failed`.
///
/// The thread (and its workspace) is resolved first: the body's `threadId` when given
/// (ownership-checked, 404 `Thread not found`), else the latest thread (created when
/// there is none). 404 `No available skill named "<name>".` when the skill is not in
/// that workspace's catalog. 503 `Agent not initialized (agentId unset)` without an
/// agent id. 500 logged as `[Management] POST /skills/:name/run failed: <msg>`.
async fn run_skill(Path(name): Path<String>, body: Option<Json<RunSkillBody>>) -> Response {
    todo!()
}

// ============================================================================
// Plugins (Agent Plugins, agent-plugins.org). Used by both the web SPA and the CLI.
// ============================================================================

/// One row of `GET /agents/plugins`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListing {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The skill names this plugin contributed to the catalog.
    pub skills: Vec<String>,
    /// The names of the servers its `mcp.json` declares.
    pub mcp_servers: Vec<String>,
    pub diagnostics: Vec<String>,
}

/// GET /agents/plugins
///
/// Installed Agent Plugins and what each contributes.
///
/// Unlike skills there is no thread scoping: plugins are installed once for the
/// container, so there is no workspace to resolve. `skills` lists the names this
/// plugin actually contributed to the catalog: a skill shadowed by a workspace or
/// global one of the same name is absent.
///
/// `diagnostics` has the non-fatal problems found while loading, so a half-broken
/// plugin is attributable here rather than only in the logs: the plugin's own, then
/// `mcp.json is invalid — no MCP servers loaded` or the parse warnings, or
/// `mcp.json could not be read — no MCP servers loaded` (read through the files of
/// the plugin's own environment), then
/// `MCP server "<server>" failed to start: <error>` for each failed server. Every
/// plugin server is connected first, so a server that fails to start is reported
/// here. A plugin whose manifest was rejected outright does not appear at all. 500
/// logged as `[Management] GET /plugins failed: <msg>`.
async fn list_plugins() -> Response {
    todo!()
}

/// POST /agents/threads/{threadId}/compact
///
/// Manually compact a thread (the `/compact` command in the web and CLI). The UI
/// parses the slash command and calls this REST endpoint. Fire-and-forget: answers
/// 202 `{ threadId }` at once; progress and the result ride out as `compaction`
/// frames on the WebSocket channel the client is already on, and a failure is logged
/// with `err` and `threadId` as `[Management] compact failed`.
///
/// 503 `Agent not initialized (agentId unset)` without an agent id; 404
/// `Thread not found` when the thread is not the owner's; 409
/// `Nothing to compact yet.` when the thread has no compactable history. 500 logged
/// as `[Management] POST /threads/:threadId/compact failed: <msg>`.
async fn compact_thread(Path(thread_id): Path<String>) -> Response {
    todo!()
}
