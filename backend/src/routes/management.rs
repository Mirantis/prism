//! Management routes.
//!
//! The runtime's REST surface: the agent-runtime owns its own data, so these routes
//! are the canonical CRUD layer for heartbeat, cron, threads, agent identity, and
//! subagent wiring. Each channel's routes are in its own router. Called by the
//! bundled Web UI. Mirantis Agent Platform inbound routing terminates auth in front of the
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

use std::convert::Infallible;
use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Request};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use bytes::Bytes;
use diesel::prelude::*;
use futures::StreamExt;
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use indexmap::IndexMap;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

use crate::config::{CONFIG, ThreadMode};
use crate::constants::{
    GOAL_MAX_OBJECTIVE_CHARS, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB, MAX_HEARTBEAT_INTERVAL_MS,
    MAX_MESSAGE_PAGE, MIN_HEARTBEAT_INTERVAL_MS,
};
use crate::db::models::{
    AgentHeartbeatStatus, AgentType, AgentWorkspace, AgentWorkspaceChangeset, MessageRole,
    NewWebhookSubscription, ThreadSource, WebhookAuthAlgorithm, WebhookAuthEncoding,
    WebhookAuthType, WebhookSubscription, WebhookSubscriptionChangeset,
};
use crate::db::schema::{agent_workspaces, webhook_subscriptions};
use crate::lib::execution_environments::get_execution_environment::{
    files_for, get_execution_environment,
};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::lib::webhook_signature::{
    WEBHOOK_AUTH_ALGORITHMS, WEBHOOK_AUTH_ENCODINGS, WEBHOOK_AUTH_TYPES, is_valid_auth_algorithm,
    is_valid_auth_encoding, is_valid_auth_type,
};
use crate::services::agent_archive_service::{
    ArchiveValidationError, ExportedAgent, export_agent as export_agent_archive,
    import_agent as import_agent_archive,
};
use crate::services::agent_workspace_service::{
    AGENT_WORKSPACE_SERVICE, AddSubagentResult, CreateAgentInput, DeleteAgentOptions,
    RemoveSubagentResult, ValidationError,
};
use crate::services::attachment_service::{
    ATTACHMENT_SERVICE, AttachmentCategory, AttachmentSource, CreateAttachmentInput,
    classify_media_type, detect_media_type,
};
use crate::services::channel_adapter_interface::{ChannelName, is_chat_platform};
use crate::services::compaction_service::{COMPACTION_SERVICE, IdleInput};
use crate::services::computer::supported::has_computer;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChannelLabelFor, ChatInput, ChatMetadata,
};
use crate::services::conversation_service::{
    CONVERSATION_SERVICE, ListThreadsOptions, MessageInput, MessagePage,
};
use crate::services::delivery_target_service::{
    DELIVER_TARGETS, DELIVERY_TARGET_SERVICE, is_valid_deliver_to, parse_comma_list,
};
use crate::services::goal_service::{GOAL_SERVICE, StartGoalInput};
use crate::services::heartbeat_service::{HEARTBEAT_SERVICE, HeartbeatSchedule};
use crate::services::message_delivery_service::{
    MESSAGE_DELIVERY_SERVICE, MESSAGE_TRIGGERS, MessageTrigger,
};
use crate::services::plugin_catalog_service::PLUGIN_CATALOG_SERVICE;
use crate::services::plugin_mcp_config::{McpParseContext, parse_mcp_json};
use crate::services::plugin_mcp_service::{PLUGIN_MCP_SERVICE, ServerStatusKind};
use crate::services::skill_catalog_service::{SKILL_CATALOG_SERVICE, SkillSource};
use crate::services::web_chat_label::web_chat_label;
use crate::services::webhook_receiver_service::WEBHOOK_RECEIVER_SERVICE;
use crate::services::webhook_service::{
    WEBHOOK_NAME_RE, normalize_webhook_name, to_public_subscription,
};
use crate::support::http::{JsonBody, QueryParams, error_json, json};
use crate::support::js;
use crate::{log_error, log_info, log_warn};

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
        .route("/agents/model", get(get_model).patch(update_model))
        .route(
            "/agents/heartbeat-model",
            get(get_heartbeat_model).patch(update_heartbeat_model),
        )
        .route(
            "/agents/cron-model",
            get(get_cron_model).patch(update_cron_model),
        )
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
                MAX_FILE_SIZE_BYTES as usize + MULTIPART_ENVELOPE_BYTES,
            )),
        )
        .route(
            "/agents/attachments/{id}",
            get(get_attachment).delete(delete_attachment),
        )
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
        .route(
            "/agents/webhooks/receiver",
            get(get_webhook_receiver).patch(update_webhook_receiver),
        )
        .route(
            "/agents/webhook-subscriptions",
            get(list_webhook_subscriptions).post(create_webhook_subscription),
        )
        .route(
            "/agents/webhook-subscriptions/{id}",
            patch(update_webhook_subscription).delete(delete_webhook_subscription),
        )
        // Goal management
        .route("/agents/goals", get(list_goals).post(start_goal))
        .route("/agents/threads/{threadId}/goal", get(get_thread_goal))
        .route("/agents/goals/{goalId}", delete(stop_goal))
        .route("/agents/goals/{goalId}/pause", post(pause_goal))
        .route("/agents/goals/{goalId}/resume", post(resume_goal))
        // Conversation
        .route(
            "/agents/threads/get-or-create-latest",
            post(get_or_create_latest_thread),
        )
        .route("/agents/threads", post(create_thread).get(list_threads))
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
        .route("/agents", post(create_agent).delete(delete_agent))
        .route("/agents/details", get(get_agent_details))
        .route(
            "/agents/{agentId}/subagents",
            get(list_subagents).post(add_subagent),
        )
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
// Shared helpers
// ============================================================================

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

/// A failure logged as `[Management] <context>: <message>` and answered 500 with
/// its message.
fn fail(err: anyhow::Error, context: &str) -> Response {
    let msg = err.to_string();
    log_error!("[Management] {}: {}", context, msg);
    error_json(500, msg)
}

/// A `ValidationError` answered 400 with its message, anything else as [`fail`].
fn refuse_or_fail(err: anyhow::Error, context: &str) -> Response {
    if let Some(validation) = err.downcast_ref::<ValidationError>() {
        return error_json(400, validation.to_string());
    }
    fail(err, context)
}

/// `const { key } = req.body`: a request with no JSON body throws there.
fn destructure(body: &JsonBody, first_key: &str) -> anyhow::Result<()> {
    if body.0.is_none() {
        anyhow::bail!(
            "Cannot destructure property '{first_key}' of 'req.body' as it is undefined."
        );
    }
    Ok(())
}

/// JavaScript truthiness of an optional field.
fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(js::truthy)
}

/// `String(value)`, as a template literal writes a value.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number
            .as_f64()
            .map(js::number_text)
            .unwrap_or_else(|| number.to_string()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// A field read as the string it is, or as `String(value)` when a client sent
/// another type.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        other => js_string(other),
    }
}

/// A field that is a string, as `typeof x === 'string' ? x : undefined` reads it.
fn string_field(body: &JsonBody, key: &str) -> Option<String> {
    body.field(key).and_then(Value::as_str).map(str::to_string)
}

/// The agent id, unless unset or empty.
fn configured_agent_id() -> Option<String> {
    CONFIG.agent_id().filter(|id| !id.is_empty())
}

/// The error's `name`, for a log line that must not carry its message.
fn error_name(err: &anyhow::Error) -> String {
    err_json(err)
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Error")
        .to_string()
}

fn telemetry_props(pairs: Vec<(&str, String)>) -> IndexMap<String, String> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
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

/// `{ verbose }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerboseResponse {
    pub verbose: bool,
}

const MISSING_MODEL: &str = "missing required field 'model' (use null to clear)";

/// GET /agents/me
///
/// The identity of the single agent this runtime owns. The Web UI calls this on
/// boot to resolve `agentId` and `userId` without needing them in the URL.
async fn get_me() -> Response {
    match AGENT_WORKSPACE_SERVICE.get_agent().await {
        Ok(agent) => json(
            200,
            MeResponse {
                agent_id: agent.id,
                user_id: agent.user_id,
                name: agent.name,
                has_computer: has_computer(),
                thread_mode: CONFIG.thread_mode,
            },
        ),
        Err(err) => fail(err, "Failed to get /me"),
    }
}

/// PATCH /agents/name
///
/// Rename the agent. Body: `{ name }`. Holds the name to the rule for names
/// (`lib/agent_name.rs`). The new name is read when the next turn builds its
/// context, so the agent picks up its new identity on the next chat turn.
async fn rename_agent(body: JsonBody) -> Response {
    let name = body.field("name").cloned().unwrap_or(Value::Null);
    match AGENT_WORKSPACE_SERVICE.rename_agent(&name).await {
        Ok(updated) => json(
            200,
            AgentIdentityResponse {
                agent_id: updated.id,
                user_id: updated.user_id,
                name: updated.name,
            },
        ),
        Err(err) => refuse_or_fail(err, "Failed to rename agent"),
    }
}

/// GET /agents/model
///
/// The **effective** model: the per-agent override when one is set, otherwise the
/// runtime's env-configured default. The caller doesn't need to know about the
/// override/default distinction; the server resolves it.
async fn get_model() -> Response {
    match AGENT_WORKSPACE_SERVICE.get_effective_model().await {
        Ok(model) => json(200, ModelResponse { model }),
        Err(err) => fail(err, "Failed to read model for agent"),
    }
}

/// PATCH /agents/model
///
/// Set or clear the per-agent LLM model override. Body: `{ model: string | null }`.
/// `null` clears the override (falls back to the runtime default). Answers the
/// **resolved** effective model, the same shape as the GET, so the UI can prime its
/// cache from the mutation response without a refetch. The model string is
/// validated for format only.
async fn update_model(body: JsonBody) -> Response {
    let Some(model) = body.field("model") else {
        return error_json(400, MISSING_MODEL);
    };
    match AGENT_WORKSPACE_SERVICE.update_model(model).await {
        Ok(model) => json(200, ModelResponse { model }),
        Err(err) => refuse_or_fail(err, "Failed to update model for agent"),
    }
}

/// GET /agents/heartbeat-model
///
/// `{ model, effective }`: the raw heartbeat override (`null` when unset, so the UI
/// can show "empty → falls back") and the model a heartbeat run would actually use
/// (heartbeat override → main override → env default).
async fn get_heartbeat_model() -> Response {
    match AGENT_WORKSPACE_SERVICE.get_heartbeat_model_info().await {
        Ok(info) => json(
            200,
            ModelOverrideResponse {
                model: info.r#override,
                effective: info.effective,
            },
        ),
        Err(err) => fail(err, "Failed to read heartbeat model for agent"),
    }
}

/// PATCH /agents/heartbeat-model
///
/// Set or clear the heartbeat model override. Body: `{ model: string | null }`.
/// `null` clears it (falls back to the main model, then env default). Answers
/// `{ model, effective }`, the same shape as the GET so the UI can prime its cache.
async fn update_heartbeat_model(body: JsonBody) -> Response {
    let Some(model) = body.field("model") else {
        return error_json(400, MISSING_MODEL);
    };
    match AGENT_WORKSPACE_SERVICE.update_heartbeat_model(model).await {
        Ok(info) => json(
            200,
            ModelOverrideResponse {
                model: info.r#override,
                effective: info.effective,
            },
        ),
        Err(err) => refuse_or_fail(err, "Failed to update heartbeat model for agent"),
    }
}

/// GET /agents/cron-model
async fn get_cron_model() -> Response {
    match AGENT_WORKSPACE_SERVICE.get_cron_model_info().await {
        Ok(info) => json(
            200,
            ModelOverrideResponse {
                model: info.r#override,
                effective: info.effective,
            },
        ),
        Err(err) => fail(err, "Failed to read cron model for agent"),
    }
}

/// PATCH /agents/cron-model
async fn update_cron_model(body: JsonBody) -> Response {
    let Some(model) = body.field("model") else {
        return error_json(400, MISSING_MODEL);
    };
    match AGENT_WORKSPACE_SERVICE.update_cron_model(model).await {
        Ok(info) => json(
            200,
            ModelOverrideResponse {
                model: info.r#override,
                effective: info.effective,
            },
        ),
        Err(err) => refuse_or_fail(err, "Failed to update cron model for agent"),
    }
}

/// PATCH /agents/verbose
///
/// Set the verbose (per-step delivery) flag. Body: `{ verbose: boolean }`.
async fn update_verbose(body: JsonBody) -> Response {
    let Some(verbose) = body.field("verbose") else {
        return error_json(400, "missing required field 'verbose'");
    };
    match AGENT_WORKSPACE_SERVICE.update_verbose(verbose).await {
        Ok(verbose) => json(200, VerboseResponse { verbose }),
        Err(err) => refuse_or_fail(err, "Failed to update verbose for agent"),
    }
}

// ============================================================================
// Multipart uploads
// ============================================================================

/// A file part of an upload, as multer's memory storage keeps it.
struct UploadedFile {
    bytes: Vec<u8>,
    /// `originalname`: the part's filename as busboy reads it.
    original_name: String,
    /// The part's declared type, `text/plain` when it declares none.
    mime_type: String,
}

/// An upload read as `multer.single('file')` reads it: the one `file` part and the
/// text fields (a repeated field holds every value).
#[derive(Default)]
struct Upload {
    file: Option<UploadedFile>,
    fields: IndexMap<String, Vec<String>>,
}

impl Upload {
    /// `req.body?.[name]` when it is one non-empty string.
    fn text_field(&self, name: &str) -> Option<String> {
        match self.fields.get(name).map(Vec::as_slice) {
            Some([value]) if !value.is_empty() => Some(value.clone()),
            _ => None,
        }
    }
}

/// Why an upload was refused: a `MulterError` (its code's message), or another
/// failure of the multipart parser.
enum UploadError {
    FileTooLarge,
    UnexpectedFile,
    Other(String),
}

impl UploadError {
    /// The `MulterError` message, or `None` for another failure.
    fn multer_message(&self) -> Option<&'static str> {
        match self {
            UploadError::FileTooLarge => Some("File too large"),
            UploadError::UnexpectedFile => Some("Unexpected file field"),
            UploadError::Other(_) => None,
        }
    }
}

/// busboy's `basename`: the part after the last `/` or `\`, and nothing for `.`
/// or `..`.
fn busboy_basename(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    if base == "." || base == ".." {
        String::new()
    } else {
        base.to_string()
    }
}

/// Multer reverses the three escapes the HTML spec applies to a form-data name.
fn decode_form_data_name(text: &str) -> String {
    static ESCAPES: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)%0A|%0D|%22").expect("valid regex"));
    ESCAPES
        .replace_all(text, |caps: &regex::Captures| {
            match caps[0].to_uppercase().as_str() {
                "%0A" => "\n".to_string(),
                "%0D" => "\r".to_string(),
                _ => "\"".to_string(),
            }
        })
        .into_owned()
}

/// A filename parameter as busboy reads one with no charset of its own: each
/// byte as a latin-1 character.
fn latin1(text: &str) -> String {
    text.bytes().map(char::from).collect()
}

/// The declared type of a part, as busboy reports it: `type/subtype` lowercased,
/// without parameters, `text/plain` when absent.
fn part_type(content_type: Option<&str>) -> String {
    content_type
        .map(|value| value.split(';').next().unwrap_or("").trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "text/plain".to_string())
}

/// Read a `multipart/*` request as `multer.single('file')` with memory storage and
/// a `fileSize` limit of `max_file_bytes`. A request of another content type has no
/// file and no fields.
async fn read_upload(req: Request, max_file_bytes: usize) -> Result<Upload, UploadError> {
    let is_multipart = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start().to_lowercase().starts_with("multipart/"));
    if !is_multipart {
        return Ok(Upload::default());
    }
    let mut multipart = Multipart::from_request(req, &())
        .await
        .map_err(|rejection| UploadError::Other(rejection.body_text()))?;
    let mut upload = Upload::default();
    loop {
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(err) => return Err(UploadError::Other(err.body_text())),
        };
        let name = decode_form_data_name(field.name().unwrap_or(""));
        let filename = field
            .file_name()
            .map(|raw| decode_form_data_name(&busboy_basename(&latin1(raw))));
        match filename {
            None => {
                let value = field
                    .text()
                    .await
                    .map_err(|err| UploadError::Other(err.body_text()))?;
                upload.fields.entry(name).or_default().push(value);
            }
            // A part with an empty filename carries no file.
            Some(filename) if filename.is_empty() => while let Ok(Some(_)) = field.chunk().await {},
            Some(filename) => {
                if name != "file" || upload.file.is_some() {
                    return Err(UploadError::UnexpectedFile);
                }
                let mime_type = part_type(field.content_type());
                let mut bytes = Vec::new();
                loop {
                    match field.chunk().await {
                        Ok(Some(chunk)) => {
                            bytes.extend_from_slice(&chunk);
                            if bytes.len() > max_file_bytes {
                                return Err(UploadError::FileTooLarge);
                            }
                        }
                        Ok(None) => break,
                        Err(err) => return Err(UploadError::Other(err.body_text())),
                    }
                }
                upload.file = Some(UploadedFile {
                    bytes,
                    original_name: filename,
                    mime_type,
                });
            }
        }
    }
    Ok(upload)
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

/// Runs an export's cleanup once, when the stream fails or is dropped.
struct Cleanup(Option<Box<dyn FnOnce() + Send>>);

impl Cleanup {
    fn run(&mut self) {
        if let Some(cleanup) = self.0.take() {
            cleanup();
        }
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.run();
    }
}

/// GET /agents/export
///
/// Stream a gzipped snapshot of the agent's SQLite DB as a `.prism` file. The
/// snapshot is taken with `VACUUM INTO` so heartbeat and cron writes in flight
/// don't tear the file. The cleanup runs once the response is done with the stream.
async fn export_agent() -> Response {
    let exported = async {
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        export_agent_archive(&agent.name).await
    }
    .await;
    let ExportedAgent {
        stream,
        filename,
        cleanup,
    } = match exported {
        Ok(exported) => exported,
        Err(err) => return fail(err, "Failed to export agent"),
    };
    let mut cleanup = Cleanup(Some(cleanup));
    let body = ReaderStream::new(stream).map(move |chunk| match chunk {
        Ok(bytes) => Ok(bytes),
        Err(err) => {
            let logged = anyhow::Error::new(std::io::Error::new(err.kind(), err.to_string()));
            log_error!(
                json!({ "err": err_json(&logged) }),
                "[Management] export stream error"
            );
            cleanup.run();
            Err(err)
        }
    });
    let response = Response::builder()
        .status(200)
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from_stream(body));
    match response {
        Ok(response) => response,
        Err(err) => fail(err.into(), "Failed to export agent"),
    }
}

/// Exits the process 100 ms after the response that holds it has been sent, so the
/// client sees `{ ok: true, restarting: true }` and knows to poll `/health`.
struct ExitAfterResponse;

impl Drop for ExitAfterResponse {
    fn drop(&mut self) {
        log_info!("[Management] import staged — exiting to apply on restart");
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::process::exit(0);
        });
    }
}

/// POST /agents/import
///
/// Multipart upload of a `.prism` file in the `file` field. Validates the archive,
/// stages it for the next process restart, then exits the process: bootstrap
/// pickup swaps the file into place before the database is opened.
async fn import_agent(req: Request) -> Response {
    let upload = match read_upload(req, ARCHIVE_UPLOAD_MAX_BYTES).await {
        Ok(upload) => upload,
        Err(err) => {
            return match (err.multer_message(), err) {
                (Some(message), _) => error_json(400, format!("Upload rejected: {message}")),
                (None, UploadError::Other(message)) => error_json(400, message),
                (None, _) => error_json(400, "Upload failed"),
            };
        }
    };
    let staged: anyhow::Result<bool> = async {
        AGENT_WORKSPACE_SERVICE.get_agent().await?;
        let Some(file) = upload.file.filter(|file| !file.bytes.is_empty()) else {
            return Ok(false);
        };
        import_agent_archive(&file.bytes).await?;
        Ok(true)
    }
    .await;
    match staged {
        Ok(false) => error_json(400, "Missing `file` field in multipart body"),
        Ok(true) => {
            // Restart so the database is opened again on the freshly-promoted file.
            // The exit waits for the response to be sent.
            let exit = ExitAfterResponse;
            let body = serde_json::to_vec(&ImportResponse {
                ok: true,
                restarting: true,
            })
            .unwrap_or_default();
            let stream = futures::stream::iter([Ok::<Bytes, Infallible>(Bytes::from(body))]).map(
                move |chunk| {
                    let _ = &exit;
                    chunk
                },
            );
            let mut response = (http::StatusCode::OK, Body::from_stream(stream)).into_response();
            response.headers_mut().insert(
                CONTENT_TYPE,
                http::HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
        }
        Err(err) => {
            if let Some(invalid) = err.downcast_ref::<ArchiveValidationError>() {
                return error_json(400, invalid.to_string());
            }
            fail(err, "Failed to import agent")
        }
    }
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
    pub category: String,
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
    let cut = js::slice16(js::trim(&out), 0, 255);
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
/// Multipart upload of one shared file (web drag-and-drop). Stores the bytes and
/// answers metadata only (never the bytes). The attachment is created unlinked; the
/// chat send links it to the user message via `attachmentIds`.
async fn upload_attachment(req: Request) -> Response {
    let upload = match read_upload(req, MAX_FILE_SIZE_BYTES as usize).await {
        Ok(upload) => upload,
        Err(UploadError::FileTooLarge) => {
            return error_json(
                400,
                format!("Upload rejected: File too large (max {MAX_FILE_SIZE_MB} MB)"),
            );
        }
        Err(UploadError::Other(message)) => return error_json(400, message),
        Err(err) => {
            let message = err.multer_message().unwrap_or("Upload failed");
            return error_json(400, format!("Upload rejected: {message}"));
        }
    };
    let thread_id = upload.text_field("threadId");
    let Some(file) = upload.file.filter(|file| !file.bytes.is_empty()) else {
        return error_json(400, "Missing or empty `file` field in multipart body");
    };
    // Defense-in-depth: the reader already enforces the limit, but re-check.
    if file.bytes.len() as i64 > MAX_FILE_SIZE_BYTES {
        return error_json(400, format!("File too large (max {MAX_FILE_SIZE_MB} MB)"));
    }

    let media_type = detect_media_type(&file.bytes, &file.original_name, Some(&file.mime_type));
    let category = classify_media_type(&media_type);
    let size_bytes = file.bytes.len() as i64;
    let created = ATTACHMENT_SERVICE
        .create(CreateAttachmentInput {
            filename: if file.original_name.is_empty() {
                "file".to_string()
            } else {
                file.original_name
            },
            media_type,
            size_bytes,
            data: file.bytes,
            category,
            source: AttachmentSource::Web,
            thread_id,
            message_id: None,
            external_file_id: None,
            external_ts: None,
        })
        .await;
    match created {
        Ok(row) => json(
            201,
            AttachmentUploadResponse {
                id: row.id,
                filename: row.filename,
                media_type: row.media_type,
                size_bytes: row.size_bytes,
                category: row.category,
            },
        ),
        Err(err) => fail(err, "Failed to store attachment"),
    }
}

/// GET /agents/attachments/{id}
///
/// Stream a stored file's bytes back for download or preview. `inline` lets the
/// browser preview images and PDFs; the web UI's `<a download>` still forces a save.
async fn get_attachment(Path(id): Path<String>) -> Response {
    let found = async {
        let Some(att) = ATTACHMENT_SERVICE.get_by_id(&id).await? else {
            return Ok(None);
        };
        let bytes = ATTACHMENT_SERVICE.load_bytes(&att).await?;
        Ok(Some((att, bytes)))
    }
    .await;
    let (att, bytes) = match found {
        Ok(Some(found)) => found,
        Ok(None) => return error_json(404, "Attachment not found"),
        Err(err) => return fail(err, &format!("Failed to fetch attachment {id}")),
    };
    let Some(bytes) = bytes else {
        // Metadata row outlives its content (the TTL) — Gone, not Not Found.
        return error_json(410, "Attachment content expired");
    };
    // Inline only types a browser renders without running script under nosniff; the rest download.
    let category = classify_media_type(&att.media_type);
    let is_previewable = matches!(
        category,
        AttachmentCategory::Image | AttachmentCategory::Pdf
    );
    let response = Response::builder()
        .status(200)
        .header("x-content-type-options", "nosniff")
        .header(
            CONTENT_TYPE,
            if is_previewable {
                att.media_type.as_str()
            } else {
                "application/octet-stream"
            },
        )
        .header(
            CONTENT_DISPOSITION,
            content_disposition(
                if is_previewable {
                    ContentDispositionKind::Inline
                } else {
                    ContentDispositionKind::Attachment
                },
                &att.filename,
            ),
        )
        .body(Body::from(bytes));
    match response {
        Ok(response) => response,
        Err(err) => fail(err.into(), &format!("Failed to fetch attachment {id}")),
    }
}

/// DELETE /agents/attachments/{id}
///
/// Remove a pre-send (unlinked) attachment — used when the user removes a chip
/// before sending. Linked attachments are immutable here (they cascade with messages).
async fn delete_attachment(Path(id): Path<String>) -> Response {
    match ATTACHMENT_SERVICE.delete_unlinked(&id).await {
        Ok(0) => error_json(404, "Attachment not found or already linked to a message"),
        Ok(_) => json(200, SuccessResponse { success: true }),
        Err(err) => fail(err, &format!("Failed to delete attachment {id}")),
    }
}

// ============================================================================
// Heartbeat management
// ============================================================================

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
    pub interval_ms: Option<Value>,
}

/// `{ success: true, result }`, the answer of `POST /agents/heartbeat/trigger`.
#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatTriggerResponse<T: Serialize> {
    pub success: bool,
    pub result: T,
}

/// POST /agents/heartbeat/start
///
/// Start or restart the heartbeat timer. Body: `{ agent }`, kept as the request's
/// shape; the config is read from the database.
async fn start_heartbeat(body: JsonBody) -> Response {
    let started = async {
        destructure(&body, "agent")?;
        if !truthy(body.field("agent")) {
            return Ok(false);
        }
        // The schedule comes off the persisted row, not the body: a client sends the
        // agent as JSON, where a timestamp is an ISO string rather than a date, and
        // the interval, the last run and the stored deadline all decide it.
        let persisted = AGENT_WORKSPACE_SERVICE.get_agent().await?;

        // Force-enable: this endpoint's whole purpose is to turn the heartbeat on,
        // regardless of what status the persisted row happens to carry. The STOPPED
        // short-circuit in `start_heartbeat` is for the boot-time loader.
        let agent = AgentWorkspace {
            heartbeat_status: AgentHeartbeatStatus::Enabled,
            ..persisted
        };
        HEARTBEAT_SERVICE.start_heartbeat(&agent, HeartbeatSchedule::KeepSchedule);
        Ok(true)
    }
    .await;
    match started {
        Ok(true) => json(
            200,
            SuccessMessageResponse {
                success: true,
                message: "Heartbeat started".to_string(),
            },
        ),
        Ok(false) => error_json(400, "Missing agent in request body"),
        Err(err) => fail(err, "Failed to start heartbeat for agent"),
    }
}

/// POST /agents/heartbeat/stop
async fn stop_heartbeat() -> Response {
    HEARTBEAT_SERVICE.stop_heartbeat();
    json(
        200,
        SuccessMessageResponse {
            success: true,
            message: "Heartbeat stopped".to_string(),
        },
    )
}

/// POST /agents/heartbeat/trigger
///
/// Execute a heartbeat immediately.
async fn trigger_heartbeat() -> Response {
    let result = HEARTBEAT_SERVICE.trigger_heartbeat().await;
    json(
        200,
        HeartbeatTriggerResponse {
            success: true,
            result,
        },
    )
}

/// GET /agents/heartbeat/status
async fn heartbeat_status() -> Response {
    match HEARTBEAT_SERVICE.get_status() {
        Some(status) => json(200, status),
        None => json(
            200,
            HeartbeatStatusFallback {
                is_active: false,
                last_run: None,
                is_running: false,
                consecutive_errors: 0,
                interval_ms: None,
            },
        ),
    }
}

/// PATCH /agents/heartbeat/interval
///
/// Update the heartbeat interval. Persists to the agent row and restarts the
/// in-process timer with the new interval. Body: `{ intervalMs: number }`.
async fn update_heartbeat_interval(body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "intervalMs")?;
        let raw = body.field("intervalMs");
        let Some(interval) = raw.and_then(Value::as_f64) else {
            return Ok(error_json(400, "intervalMs must be a finite number"));
        };
        if interval < MIN_HEARTBEAT_INTERVAL_MS as f64 || interval > MAX_HEARTBEAT_INTERVAL_MS as f64
        {
            return Ok(error_json(
                400,
                format!(
                    "intervalMs must be between {MIN_HEARTBEAT_INTERVAL_MS} ({MIN_INTERVAL}) and {MAX_HEARTBEAT_INTERVAL_MS} ({MAX_INTERVAL})"
                ),
            ));
        }
        if interval.fract() != 0.0 {
            anyhow::bail!(
                "Invalid value for argument `heartbeatIntervalMs`: Expected Int, provided Float."
            );
        }

        let existing = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        let changes = AgentWorkspaceChangeset {
            heartbeat_interval_ms: Some(interval as i64),
            ..AgentWorkspaceChangeset::default()
        };
        let updated = crate::db::run(move |conn| {
            Ok(diesel::update(agent_workspaces::table.find(&existing.id))
                .set(&changes)
                .returning(AgentWorkspace::as_returning())
                .get_result::<AgentWorkspace>(conn)?)
        })
        .await?;

        // Re-register the timer with the new interval, which starts from now: a user
        // changing the cadence asks for the next check one new interval away.
        // `start_heartbeat` short-circuits if heartbeatStatus is STOPPED, so the
        // user's start/stop preference is respected without racing the persisted
        // heartbeat-status flag.
        HEARTBEAT_SERVICE.start_heartbeat(&updated, HeartbeatSchedule::NewInterval);

        Ok(match HEARTBEAT_SERVICE.get_status() {
            Some(status) => json(200, status),
            None => json(
                200,
                HeartbeatStatusFallback {
                    is_active: false,
                    last_run: None,
                    is_running: false,
                    consecutive_errors: 0,
                    interval_ms: raw.cloned(),
                },
            ),
        })
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to update heartbeat interval for agent"))
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

/// The generic sender-auth fields, as stored on a subscription row.
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

impl WebhookAuthFields {
    fn of(row: &WebhookSubscription) -> Self {
        WebhookAuthFields {
            auth_type: row.auth_type,
            auth_header: row.auth_header.clone(),
            auth_prefix: row.auth_prefix.clone(),
            auth_algorithm: row.auth_algorithm,
            auth_encoding: row.auth_encoding,
            auth_signed_url: row.auth_signed_url.clone(),
            secret: row.secret.clone(),
        }
    }
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
/// silently unverifiable endpoint).
///
/// Unlike the loosely-typed descriptive fields, a non-string credential is an
/// explicit error rather than an ignored value: silently dropping a secret would
/// leave the sender thinking it configured auth when it hasn't.
fn read_webhook_auth_fields(
    body: &JsonBody,
    current: &WebhookAuthFields,
) -> Result<WebhookAuthFields, FieldErrorBody> {
    // The auth fields alone, never the rest of a row: an update must not write back
    // stale reads of its other columns.
    let mut values = current.clone();

    if let Some(raw) = body.field("authType") {
        let Some(auth_type) = raw
            .as_str()
            .filter(|v| is_valid_auth_type(v))
            .and_then(|v| v.parse::<WebhookAuthType>().ok())
        else {
            return Err(field_error(
                "authType",
                &format!("authType must be one of: {}", WEBHOOK_AUTH_TYPES.join(", ")),
            ));
        };
        values.auth_type = auth_type;
    }
    if let Some(raw) = body.field("authAlgorithm") {
        let Some(algorithm) = raw
            .as_str()
            .filter(|v| is_valid_auth_algorithm(v))
            .and_then(|v| v.parse::<WebhookAuthAlgorithm>().ok())
        else {
            return Err(field_error(
                "authAlgorithm",
                &format!(
                    "authAlgorithm must be one of: {}",
                    WEBHOOK_AUTH_ALGORITHMS.join(", ")
                ),
            ));
        };
        values.auth_algorithm = algorithm;
    }
    if let Some(raw) = body.field("authEncoding") {
        let Some(encoding) = raw
            .as_str()
            .filter(|v| is_valid_auth_encoding(v))
            .and_then(|v| v.parse::<WebhookAuthEncoding>().ok())
        else {
            return Err(field_error(
                "authEncoding",
                &format!(
                    "authEncoding must be one of: {}",
                    WEBHOOK_AUTH_ENCODINGS.join(", ")
                ),
            ));
        };
        values.auth_encoding = encoding;
    }
    // Header, prefix, signed URL and secret: '' clears, non-strings are rejected.
    // The prefix keeps its inner spacing ('Bearer '); the others are trimmed.
    for key in ["authHeader", "authPrefix", "authSignedUrl", "secret"] {
        let raw = match body.field(key) {
            None => continue,
            Some(Value::Null) => "",
            Some(Value::String(text)) => text.as_str(),
            Some(_) => return Err(field_error(key, &format!("{key} must be a string"))),
        };
        let normalized = if key == "authPrefix" {
            raw
        } else {
            js::trim(raw)
        };
        let value = (!normalized.is_empty()).then(|| normalized.to_string());
        match key {
            "authHeader" => values.auth_header = value,
            "authPrefix" => values.auth_prefix = value,
            "authSignedUrl" => values.auth_signed_url = value,
            _ => values.secret = value,
        }
    }

    // Only an HMAC signs a URL.
    if values.auth_type != WebhookAuthType::Hmac {
        values.auth_signed_url = None;
    }
    if let Some(url) = &values.auth_signed_url
        && !is_http_url(url)
    {
        return Err(field_error(
            "authSignedUrl",
            "The signed URL must be an absolute http or https URL",
        ));
    }

    if values.auth_type == WebhookAuthType::None {
        // Don't leave an orphan credential behind when verification is turned off.
        values.auth_header = None;
        values.auth_prefix = None;
        values.secret = None;
        return Ok(values);
    }
    let auth_type = values.auth_type.as_str();
    if values.secret.is_none() {
        return Err(field_error(
            "secret",
            &format!("A secret is required for '{auth_type}' authentication"),
        ));
    }
    if values.auth_header.is_none() {
        return Err(field_error(
            "authHeader",
            &format!(
                "A header name is required for '{auth_type}' authentication (e.g. X-Hub-Signature-256)"
            ),
        ));
    }
    Ok(values)
}

/// Read a subscription's Slack channel list, its error keyed to the
/// `slackChannelIds` field. `Ok(None)` clears the list.
async fn read_slack_channel_ids(
    raw: &Value,
    deliver_to: &str,
    agent_id: &str,
    stored: &[String],
) -> anyhow::Result<Result<Option<String>, FieldErrorBody>> {
    let read = DELIVERY_TARGET_SERVICE
        .read_channel_ids(raw, deliver_to, agent_id, stored)
        .await?;
    Ok(read.map_err(|error| field_error("slackChannelIds", &error)))
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

/// The refusal of a `deliverTo` that is not one of `DELIVER_TARGETS`.
fn invalid_deliver_to() -> FieldErrorBody {
    let targets = DELIVER_TARGETS.join(", ");
    let mut body = field_error("deliverTo", &format!("Must be one of: {targets}"));
    body.error = format!("deliverTo must be one of: {targets}");
    body
}

/// The update route's one telemetry event, sent on every terminal outcome with the
/// stored state on success.
fn track_subscription_update(
    subscription_id: &str,
    outcome: SubscriptionUpdateOutcome,
    stored: Option<&WebhookSubscription>,
) {
    let mut props = IndexMap::new();
    if let Some(agent_id) = configured_agent_id() {
        props.insert("agent.id".to_string(), agent_id);
    }
    props.insert(
        "webhook.subscription_id".to_string(),
        subscription_id.to_string(),
    );
    props.insert("webhook.outcome".to_string(), outcome.as_str().to_string());
    if let Some(stored) = stored {
        props.insert(
            "webhook.is_active".to_string(),
            stored.is_active.to_string(),
        );
        props.insert("webhook.deliver_to".to_string(), stored.deliver_to.clone());
        props.insert(
            "webhook.slack_channels".to_string(),
            parse_comma_list(stored.slack_channel_ids.as_deref())
                .len()
                .to_string(),
        );
        props.insert(
            "webhook.deliver_only".to_string(),
            stored.deliver_only.to_string(),
        );
        props.insert(
            "webhook.auth_type".to_string(),
            stored.auth_type.as_str().to_string(),
        );
    }
    track_event(
        "webhook subscription updated",
        Some(CONFIG.owner_user_id().as_str()),
        Some(props),
    );
}

/// Whether a database error is the unique constraint (Prisma's P2002).
fn is_unique_violation(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<diesel::result::Error>(),
        Some(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _
        ))
    )
}

/// GET /agents/webhooks/receiver
///
/// Whether the inbound webhook receiver is enabled, and where senders reach it: the
/// webhook port, plus its public origin when the deployment exposes one.
async fn get_webhook_receiver() -> Response {
    json(
        200,
        WebhookReceiverState {
            enabled: WEBHOOK_RECEIVER_SERVICE.enabled(),
            port: CONFIG.webhook_port,
            public_url: CONFIG.webhook_public_url.clone(),
        },
    )
}

/// PATCH /agents/webhooks/receiver
///
/// Enable or disable the inbound webhook receiver (hot toggle, no restart). Body:
/// `{ enabled: boolean }`.
async fn update_webhook_receiver(body: JsonBody) -> Response {
    let Some(enabled) = body.field("enabled").and_then(Value::as_bool) else {
        return error_json(400, "enabled must be a boolean");
    };
    match WEBHOOK_RECEIVER_SERVICE.set_enabled(enabled).await {
        Ok(()) => json(
            200,
            WebhookReceiverEnabled {
                enabled: WEBHOOK_RECEIVER_SERVICE.enabled(),
            },
        ),
        Err(err) => fail(err, "Failed to toggle webhook receiver"),
    }
}

/// GET /agents/webhook-subscriptions
///
/// Every subscription, newest first.
async fn list_webhook_subscriptions() -> Response {
    let rows = crate::db::run(|conn| {
        Ok(webhook_subscriptions::table
            .order(webhook_subscriptions::created_at.desc())
            .select(WebhookSubscription::as_select())
            .load::<WebhookSubscription>(conn)?)
    })
    .await;
    match rows {
        Ok(rows) => json(
            200,
            rows.iter().map(to_public_subscription).collect::<Vec<_>>(),
        ),
        Err(err) => fail(err, "Failed to list webhook subscriptions"),
    }
}

/// A descriptive field: trimmed when a non-blank string, else null.
fn descriptive(body: &JsonBody, key: &str) -> Option<String> {
    body.field(key)
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// POST /agents/webhook-subscriptions
///
/// Create a webhook subscription. Body: `{ name, description?, events?, prompt?,
/// deliverTo?, slackChannelIds?, deliverOnly?, authType?, authHeader?, authPrefix?,
/// authAlgorithm?, authEncoding?, authSignedUrl?, secret? }`.
async fn create_webhook_subscription(body: JsonBody) -> Response {
    match create_subscription(&body).await {
        Ok(response) => response,
        Err(err) => {
            log_error!(
                json!({ "errorName": error_name(&err) }),
                "[Management] Failed to create webhook subscription"
            );
            error_json(500, "Failed to create webhook subscription")
        }
    }
}

async fn create_subscription(body: &JsonBody) -> anyhow::Result<Response> {
    let name = normalize_webhook_name(body.field("name").unwrap_or(&Value::Null));
    if name.is_empty() {
        return Ok(json(
            400,
            field_error_with("name is required", "name", "Name is required"),
        ));
    }
    if !WEBHOOK_NAME_RE.is_match(&name) {
        return Ok(json(
            400,
            field_error_with(
                &format!("Invalid name: {name}"),
                "name",
                "Use lowercase letters, digits, hyphens, and underscores (must start with a letter or digit)",
            ),
        ));
    }
    let deliver_to = match body.field("deliverTo") {
        None | Some(Value::Null) => Value::String("all".to_string()),
        Some(value) => value.clone(),
    };
    if !is_valid_deliver_to(&deliver_to) {
        return Ok(json(400, invalid_deliver_to()));
    }
    let deliver_to = deliver_to.as_str().unwrap_or("all").to_string();
    let deliver_only = body.field("deliverOnly") == Some(&Value::Bool(true));
    if deliver_only && deliver_to == "none" {
        return Ok(json(400, deliver_only_needs_target()));
    }

    let auth = match read_webhook_auth_fields(body, &webhook_auth_defaults()) {
        Ok(auth) => auth,
        Err(refusal) => return Ok(json(400, refusal)),
    };

    let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
    let channels = match body.field("slackChannelIds") {
        None => None,
        Some(raw) => match read_slack_channel_ids(raw, &deliver_to, &agent.id, &[]).await? {
            Ok(channels) => channels,
            Err(refusal) => return Ok(json(400, refusal)),
        },
    };

    let mut row = NewWebhookSubscription::new(agent.id.clone(), name.clone());
    row.description = descriptive(body, "description");
    row.events = descriptive(body, "events");
    row.prompt = descriptive(body, "prompt");
    row.deliver_to = deliver_to;
    row.slack_channel_ids = channels;
    row.deliver_only = deliver_only;
    row.auth_type = auth.auth_type;
    row.auth_header = auth.auth_header;
    row.auth_prefix = auth.auth_prefix;
    row.auth_algorithm = auth.auth_algorithm;
    row.auth_encoding = auth.auth_encoding;
    row.auth_signed_url = auth.auth_signed_url;
    row.secret = auth.secret;
    let created = crate::db::run(move |conn| {
        Ok(diesel::insert_into(webhook_subscriptions::table)
            .values(&row)
            .returning(WebhookSubscription::as_returning())
            .get_result::<WebhookSubscription>(conn)?)
    })
    .await;
    let subscription = match created {
        Ok(subscription) => subscription,
        Err(err) if is_unique_violation(&err) => {
            return Ok(json(
                409,
                field_error_with(
                    &format!("A subscription named \"{name}\" already exists"),
                    "name",
                    &format!("\"{name}\" is already taken"),
                ),
            ));
        }
        Err(err) => return Err(err),
    };

    track_event(
        "webhook subscription created",
        Some(agent.user_id.as_str()),
        Some(telemetry_props(vec![
            ("agent.id", agent.id.clone()),
            ("webhook.subscription_id", subscription.id.clone()),
            ("webhook.deliver_to", subscription.deliver_to.clone()),
            (
                "webhook.slack_channels",
                parse_comma_list(subscription.slack_channel_ids.as_deref())
                    .len()
                    .to_string(),
            ),
            (
                "webhook.deliver_only",
                subscription.deliver_only.to_string(),
            ),
            (
                "webhook.auth_type",
                subscription.auth_type.as_str().to_string(),
            ),
        ])),
    );
    Ok(json(201, to_public_subscription(&subscription)))
}

/// `{ error, fieldErrors: { [field]: fieldMessage } }`.
fn field_error_with(error: &str, field: &str, field_message: &str) -> FieldErrorBody {
    let mut body = field_error(field, field_message);
    body.error = error.to_string();
    body
}

/// PATCH /agents/webhook-subscriptions/{id}
///
/// Update a subscription (`isActive` toggle and/or editable fields). Auth fields are
/// validated against the row's current state, so the *result* of the update has to
/// be verifiable — and switching authType to 'none' clears the stored credential.
/// The Slack channel list is validated against the effective target, and a target
/// whose channel has no linked channels clears it.
async fn update_webhook_subscription(Path(id): Path<String>, body: JsonBody) -> Response {
    match update_subscription(&id, &body).await {
        Ok(response) => response,
        Err(err) => {
            log_error!(
                json!({ "errorName": error_name(&err) }),
                "[Management] Failed to update webhook subscription"
            );
            track_subscription_update(&id, SubscriptionUpdateOutcome::Error, None);
            error_json(500, "Failed to update webhook subscription")
        }
    }
}

async fn update_subscription(id: &str, body: &JsonBody) -> anyhow::Result<Response> {
    let reject = |status: u16, body: Value| {
        track_subscription_update(
            id,
            if status == 404 {
                SubscriptionUpdateOutcome::NotFound
            } else {
                SubscriptionUpdateOutcome::Invalid
            },
            None,
        );
        json(status, body)
    };
    let to_value = |body: FieldErrorBody| serde_json::to_value(body).unwrap_or(Value::Null);

    let mut data = WebhookSubscriptionChangeset::default();
    let mut changed = false;
    if let Some(is_active) = body.field("isActive").and_then(Value::as_bool) {
        data.is_active = Some(is_active);
        changed = true;
    }
    for key in ["description", "events", "prompt"] {
        let Some(text) = body.field(key).and_then(Value::as_str) else {
            continue;
        };
        let trimmed = js::trim(text);
        let value = (!trimmed.is_empty()).then(|| trimmed.to_string());
        match key {
            "description" => data.description = Some(value),
            "events" => data.events = Some(value),
            _ => data.prompt = Some(value),
        }
        changed = true;
    }
    if let Some(deliver_to) = body.field("deliverTo") {
        if !is_valid_deliver_to(deliver_to) {
            return Ok(reject(400, to_value(invalid_deliver_to())));
        }
        data.deliver_to = deliver_to.as_str().map(str::to_string);
        changed = true;
    }
    if let Some(deliver_only) = body.field("deliverOnly").and_then(Value::as_bool) {
        data.deliver_only = Some(deliver_only);
        changed = true;
    }

    // Auth, delivery and Slack channel fields need the current row to validate the
    // effective result.
    let edits_auth = WEBHOOK_AUTH_KEYS
        .iter()
        .any(|key| body.field(key).is_some());
    let edits_delivery = data.deliver_to.is_some() || data.deliver_only.is_some();
    let edits_channels = body.field("slackChannelIds").is_some();
    if edits_auth || edits_delivery || edits_channels {
        let lookup = id.to_string();
        let current = crate::db::run(move |conn| {
            Ok(webhook_subscriptions::table
                .find(&lookup)
                .select(WebhookSubscription::as_select())
                .first::<WebhookSubscription>(conn)
                .optional()?)
        })
        .await?;
        let Some(current) = current else {
            return Ok(reject(
                404,
                json!({ "error": "Webhook subscription not found" }),
            ));
        };
        let deliver_to = data
            .deliver_to
            .clone()
            .unwrap_or_else(|| current.deliver_to.clone());
        let deliver_only = data.deliver_only.unwrap_or(current.deliver_only);
        if deliver_only && deliver_to == "none" {
            return Ok(reject(400, to_value(deliver_only_needs_target())));
        }
        if edits_auth {
            let auth = match read_webhook_auth_fields(body, &WebhookAuthFields::of(&current)) {
                Ok(auth) => auth,
                Err(refusal) => return Ok(reject(400, to_value(refusal))),
            };
            data.auth_type = Some(auth.auth_type);
            data.auth_header = Some(auth.auth_header);
            data.auth_prefix = Some(auth.auth_prefix);
            data.auth_algorithm = Some(auth.auth_algorithm);
            data.auth_encoding = Some(auth.auth_encoding);
            data.auth_signed_url = Some(auth.auth_signed_url);
            data.secret = Some(auth.secret);
            changed = true;
        }
        if edits_channels {
            let raw = body.field("slackChannelIds").unwrap_or(&Value::Null);
            let stored = parse_comma_list(current.slack_channel_ids.as_deref());
            match read_slack_channel_ids(raw, &deliver_to, &current.agent_id, &stored).await? {
                Ok(channels) => data.slack_channel_ids = Some(channels),
                Err(refusal) => return Ok(reject(400, to_value(refusal))),
            }
            changed = true;
        } else if data.deliver_to.is_some() {
            let links_channels = match MESSAGE_DELIVERY_SERVICE.get_adapter(&deliver_to) {
                Some(adapter) => adapter
                    .linked_channel_ids(&current.agent_id)
                    .await
                    .is_some(),
                None => false,
            };
            if !links_channels {
                data.slack_channel_ids = Some(None);
            }
        }
    }

    if !changed {
        return Ok(reject(
            400,
            json!({ "error": "No updatable fields provided" }),
        ));
    }

    let target = id.to_string();
    let updated = crate::db::run(move |conn| {
        Ok(diesel::update(webhook_subscriptions::table.find(&target))
            .set(&data)
            .returning(WebhookSubscription::as_returning())
            .get_result::<WebhookSubscription>(conn)
            .optional()?)
    })
    .await?;
    let Some(subscription) = updated else {
        return Ok(reject(
            404,
            json!({ "error": "Webhook subscription not found" }),
        ));
    };
    track_subscription_update(id, SubscriptionUpdateOutcome::Success, Some(&subscription));
    Ok(json(200, to_public_subscription(&subscription)))
}

/// DELETE /agents/webhook-subscriptions/{id}
///
/// Delete a subscription.
async fn delete_webhook_subscription(Path(id): Path<String>) -> Response {
    let target = id.clone();
    let deleted = crate::db::run(move |conn| {
        Ok(diesel::delete(webhook_subscriptions::table.find(&target))
            .returning(WebhookSubscription::as_returning())
            .get_result::<WebhookSubscription>(conn)
            .optional()?)
    })
    .await;
    let subscription = match deleted {
        Ok(Some(subscription)) => subscription,
        Ok(None) => return error_json(404, "Webhook subscription not found"),
        Err(err) => return fail(err, &format!("Failed to delete webhook subscription {id}")),
    };
    // Telemetry is best-effort: the row is already gone, so a failure here must not
    // turn the response into a 500.
    match AGENT_WORKSPACE_SERVICE.get_agent().await {
        Ok(agent) => track_event(
            "webhook subscription deleted",
            Some(agent.user_id.as_str()),
            Some(telemetry_props(vec![
                ("agent.id", agent.id.clone()),
                ("webhook.subscription_id", subscription.id.clone()),
            ])),
        ),
        Err(err) => log_warn!(
            "[Management] webhook-subscription-deleted telemetry failed: {}",
            err
        ),
    }
    json(200, SuccessResponse { success: true })
}

// ============================================================================
// Goal management
// ============================================================================

/// GET /agents/goals
///
/// All goals for the agent (newest first).
async fn list_goals() -> Response {
    let goals = async {
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        GOAL_SERVICE.list_goals(&agent.id).await
    }
    .await;
    match goals {
        Ok(goals) => json(200, goals),
        Err(err) => fail(err, "Failed to list goals"),
    }
}

/// GET /agents/threads/{threadId}/goal
///
/// The current active (or paused) goal for a thread, or `null`.
async fn get_thread_goal(Path(thread_id): Path<String>) -> Response {
    match GOAL_SERVICE.get_goal_for_thread(&thread_id).await {
        Ok(goal) => json(200, goal),
        Err(err) => fail(err, &format!("Failed to get goal for thread {thread_id}")),
    }
}

/// POST /agents/goals
///
/// Start (or replace) the active goal on a thread. One active goal per thread.
/// Body: `{ threadId, objective, tokenBudget?, originChannel?, originChannelId? }`.
async fn start_goal(body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "threadId")?;
        let objective = body.field("objective").and_then(Value::as_str);
        let Some(objective) =
            objective.filter(|text| truthy(body.field("threadId")) && !js::trim(text).is_empty())
        else {
            return Ok(error_json(
                400,
                "Missing required fields: threadId, objective",
            ));
        };
        if js::len16(objective) > GOAL_MAX_OBJECTIVE_CHARS {
            return Ok(error_json(
                400,
                format!("Objective is too long (max {GOAL_MAX_OBJECTIVE_CHARS} characters)"),
            ));
        }
        // tokenBudget is optional, but when present must be a positive integer —
        // reject negatives / non-integers rather than passing them through to a
        // surprising immediate stop or a database error.
        let token_budget = match body.field("tokenBudget") {
            None | Some(Value::Null) => None,
            Some(Value::Number(number)) => match number.as_f64() {
                Some(budget) if budget.fract() == 0.0 && budget > 0.0 => Some(budget as i64),
                _ => return Ok(error_json(400, "tokenBudget must be a positive integer")),
            },
            Some(_) => return Ok(error_json(400, "tokenBudget must be a positive integer")),
        };

        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        let origin_channel = body
            .field("originChannel")
            .and_then(Value::as_str)
            .filter(|channel| is_chat_platform(channel))
            .unwrap_or("websocket")
            .to_string();
        let goal = GOAL_SERVICE
            .start_goal(StartGoalInput {
                user_id: agent.user_id,
                agent_id: agent.id,
                thread_id: text_of(body.field("threadId")),
                objective: objective.to_string(),
                token_budget,
                origin_channel,
                origin_channel_id: string_field(&body, "originChannelId"),
            })
            .await?;
        Ok(json(201, goal))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to start goal"))
}

/// A goal answered, or 404 `Goal not found`.
fn goal_or_404<T: Serialize>(
    result: anyhow::Result<Option<T>>,
    context: &str,
    goal_id: &str,
) -> Response {
    match result {
        Ok(Some(goal)) => json(200, goal),
        Ok(None) => error_json(404, "Goal not found"),
        Err(err) => fail(err, &format!("{context} {goal_id}")),
    }
}

/// DELETE /agents/goals/{goalId}
///
/// Stop a goal (aborts its loop).
async fn stop_goal(Path(goal_id): Path<String>) -> Response {
    goal_or_404(
        GOAL_SERVICE.stop_goal(&goal_id).await,
        "Failed to stop goal",
        &goal_id,
    )
}

/// POST /agents/goals/{goalId}/pause
///
/// Pause an active goal (the loop exits after the current turn).
async fn pause_goal(Path(goal_id): Path<String>) -> Response {
    goal_or_404(
        GOAL_SERVICE.pause_goal(&goal_id, None).await,
        "Failed to pause goal",
        &goal_id,
    )
}

/// POST /agents/goals/{goalId}/resume
///
/// Resume a paused goal (restarts its loop).
async fn resume_goal(Path(goal_id): Path<String>) -> Response {
    goal_or_404(
        GOAL_SERVICE.resume_goal(&goal_id).await,
        "Failed to resume goal",
        &goal_id,
    )
}

// ============================================================================
// Conversation
// ============================================================================

/// The `agentId` and `userId` of a thread-creating request, or `None` when either
/// is falsy.
fn agent_and_user(body: &JsonBody) -> anyhow::Result<Option<(String, String)>> {
    destructure(body, "agentId")?;
    let (agent_id, user_id) = (body.field("agentId"), body.field("userId"));
    if !truthy(agent_id) || !truthy(user_id) {
        return Ok(None);
    }
    Ok(Some((text_of(agent_id), text_of(user_id))))
}

/// POST /agents/threads/get-or-create-latest
///
/// Get or create the latest thread for a user and agent pair. Body: `{ agentId, userId }`.
async fn get_or_create_latest_thread(body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        let Some((agent_id, user_id)) = agent_and_user(&body)? else {
            return Ok(error_json(400, "Missing required fields: agentId, userId"));
        };
        let thread = CONVERSATION_SERVICE
            .get_or_create_latest_thread(&agent_id, &user_id)
            .await?;
        Ok(json(200, thread))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to get or create latest thread"))
}

/// POST /agents/threads
///
/// Start a fresh conversation (web "new conversation" button). Reuses the newest
/// thread when it is still untouched instead of creating another.
/// Body: `{ agentId, userId }`.
async fn create_thread(body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        let Some((agent_id, user_id)) = agent_and_user(&body)? else {
            return Ok(error_json(400, "Missing required fields: agentId, userId"));
        };
        let thread = CONVERSATION_SERVICE
            .get_or_create_fresh_thread(&agent_id, &user_id)
            .await?;
        Ok(json(200, thread))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to create thread"))
}

/// A query param as `!x` reads it: absent or empty is missing.
fn query_text(query: &QueryParams, key: &str) -> Option<String> {
    query
        .text(key)
        .filter(|text| !text.is_empty() || query.str(key).is_none())
}

/// GET /agents/threads
///
/// List threads for a user and agent (newest first), with an optional limit.
/// `threadSource=DATABASE` keeps only web/CLI threads (drops channel threads) — the
/// resumable set the web chat shows. Any value other than a known `ThreadSource` is
/// ignored (no channel filter). Query: `{ userId, agentId, limit?, threadSource? }`.
async fn list_threads(query: QueryParams) -> Response {
    let result: anyhow::Result<Response> = async {
        let (Some(user_id), Some(agent_id)) =
            (query_text(&query, "userId"), query_text(&query, "agentId"))
        else {
            return Ok(error_json(
                400,
                "Missing required query params: userId, agentId",
            ));
        };

        let mut limit = None;
        if let Some(raw) = query.text("limit") {
            match js::number_from(&raw) {
                Some(parsed) if parsed.is_finite() && parsed.fract() == 0.0 && parsed >= 1.0 => {
                    limit = Some(parsed as i64);
                }
                _ => return Ok(error_json(400, "limit must be a positive integer")),
            }
        }

        let thread_source = query.str("threadSource").and_then(|value| {
            ThreadSource::ALL
                .iter()
                .copied()
                .find(|s| s.as_str() == value)
        });

        let threads = CONVERSATION_SERVICE
            .list_threads(
                &user_id,
                &agent_id,
                Some(ListThreadsOptions {
                    limit,
                    thread_source,
                    workspace_root: None,
                }),
            )
            .await?;
        Ok(json(200, threads))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to list threads"))
}

/// GET /agents/threads/{threadId}
///
/// Fetch a thread with messages (with ownership check). With `limit`, the thread
/// holds one page of history: the newest `limit` messages, or those before the
/// message `before`. Without it, the whole history.
async fn get_thread(Path(thread_id): Path<String>, query: QueryParams) -> Response {
    let result: anyhow::Result<Response> = async {
        let (Some(user_id), Some(agent_id)) =
            (query_text(&query, "userId"), query_text(&query, "agentId"))
        else {
            return Ok(error_json(
                400,
                "Missing required query params: userId, agentId",
            ));
        };
        let page = match js::parse_int(&query.text("limit").unwrap_or_default()) {
            Some(limit) if limit > 0 => Some(MessagePage {
                limit: limit.min(MAX_MESSAGE_PAGE),
                before: query
                    .str("before")
                    .filter(|before| !before.is_empty())
                    .map(str::to_string),
            }),
            _ => None,
        };
        let thread = CONVERSATION_SERVICE
            .get_thread(&user_id, &agent_id, &thread_id, page)
            .await?;
        Ok(match thread {
            Some(thread) => json(200, thread),
            None => error_json(404, "Thread not found"),
        })
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to get thread"))
}

/// POST /agents/threads/{threadId}/messages
///
/// Add a message to a thread. Body: `{ content, role, triggeredBy, toolCalls?,
/// blocks?, senderExternalId?, senderName? }`.
async fn add_thread_message(Path(thread_id): Path<String>, body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "content")?;
        let (content, role, triggered_by) = (
            body.field("content"),
            body.field("role"),
            body.field("triggeredBy"),
        );
        let mut missing = Vec::new();
        if !truthy(content) {
            missing.push("content");
        }
        if !truthy(role) {
            missing.push("role");
        }
        if !truthy(triggered_by) {
            missing.push("triggeredBy");
        }
        if !missing.is_empty() {
            return Ok(error_json(
                400,
                format!("Missing required field(s): {}", missing.join(", ")),
            ));
        }

        let Some(role_value) = role.and_then(Value::as_str).and_then(|role| {
            MessageRole::ALL
                .iter()
                .copied()
                .find(|r| r.as_str() == role)
        }) else {
            let roles: Vec<&str> = MessageRole::ALL.iter().map(|r| r.as_str()).collect();
            return Ok(error_json(
                400,
                format!(
                    "Invalid role: {}. Must be one of: {}",
                    js_string(role),
                    roles.join(", ")
                ),
            ));
        };

        // Validated against the runtime's own list, not the database enum: that enum
        // keeps SYSTEM so history stays readable, and nothing produces a SYSTEM
        // message any more.
        let Some(trigger) = triggered_by.and_then(Value::as_str).and_then(|value| {
            CLIENT_MESSAGE_TRIGGERS
                .iter()
                .copied()
                .find(|t| t.as_str() == value)
        }) else {
            let triggers: Vec<&str> = CLIENT_MESSAGE_TRIGGERS.iter().map(|t| t.as_str()).collect();
            return Ok(error_json(
                400,
                format!(
                    "Invalid triggeredBy: {}. Must be one of: {}",
                    js_string(triggered_by),
                    triggers.join(", ")
                ),
            ));
        };

        let Some(content) = content.and_then(Value::as_str) else {
            anyhow::bail!("Invalid value provided for `content`: Expected String.");
        };
        let mut input = MessageInput::new(content, role_value, trigger);
        input.tool_calls = body.field("toolCalls").cloned();
        input.blocks = body.field("blocks").cloned();
        input.sender_external_id = string_field(&body, "senderExternalId");
        input.sender_name = string_field(&body, "senderName");
        let added = CONVERSATION_SERVICE.add_message(&thread_id, input).await?;
        Ok(json(201, added.message))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, &format!("Failed to add message to thread {thread_id}")))
}

/// POST /agents/threads/{threadId}/set-external-id
///
/// Set the external thread id on a thread. Body: `{ externalThreadId }`.
async fn set_thread_external_id(Path(thread_id): Path<String>, body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "externalThreadId")?;
        let external = body.field("externalThreadId");
        if !truthy(external) {
            return Ok(error_json(400, "Missing required field: externalThreadId"));
        }
        CONVERSATION_SERVICE
            .set_external_id(&thread_id, &text_of(external))
            .await?;
        Ok(json(200, SuccessResponse { success: true }))
    }
    .await;
    result.unwrap_or_else(|err| {
        fail(
            err,
            &format!("Failed to set external ID on thread {thread_id}"),
        )
    })
}

// ============================================================================
// Chat (for the frontend REST API)
// ============================================================================

/// POST /agents/chat
///
/// Synchronous chat endpoint for the frontend REST API. Body:
/// `{ userId, agentId, message, threadId?, metadata?, attachmentIds? }`.
///
/// The in-flight generation is cancelled when the HTTP client hangs up: the handler
/// is dropped then, and a drop guard that a finished reply disarms cancels it.
async fn chat(body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "userId")?;
        let (user_id, agent_id) = (body.field("userId"), body.field("agentId"));
        let attachment_ids = match body.field("attachmentIds") {
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|item| text_of(Some(item)))
                    .collect::<Vec<String>>(),
            ),
            _ => None,
        };
        let has_attachments = attachment_ids.as_ref().is_some_and(|ids| !ids.is_empty());
        let message = body.field("message").and_then(Value::as_str);
        let valid = truthy(user_id)
            && truthy(agent_id)
            && message.is_some_and(|text| !js::trim(text).is_empty() || has_attachments);
        let (true, Some(message)) = (valid, message) else {
            return Ok(error_json(
                400,
                "userId, agentId, and either message text or attachmentIds are required",
            ));
        };

        let token = tokio_util::sync::CancellationToken::new();
        let guard = token.clone().drop_guard();
        let response = CONVERSATION_ENGINE_SERVICE
            .chat(ChatInput {
                user_id: text_of(user_id),
                agent_id: text_of(agent_id),
                message: message.to_string(),
                thread_id: string_field(&body, "threadId"),
                metadata: body.field("metadata").and_then(|metadata| {
                    serde_json::from_value::<ChatMetadata>(metadata.clone()).ok()
                }),
                attachment_ids,
                abort_signal: Some(token),
                ..ChatInput::default()
            })
            .await;
        guard.disarm();
        Ok(json(200, response?))
    }
    .await;
    result.unwrap_or_else(|err| {
        let msg = err.to_string();
        log_error!(
            "[Management] Chat failed for user {}: {}",
            js_string(body.field("userId")),
            msg
        );
        error_json(500, msg)
    })
}

// ============================================================================
// Agent CRUD
// ============================================================================

/// `{ subagents }`, the answer of `GET /agents/{agentId}/subagents`.
#[derive(Debug, Clone, Serialize)]
pub struct SubagentsResponse<T: Serialize> {
    pub subagents: T,
}

/// POST /agents
///
/// Create a new agent with org/team context and default workspace files.
/// Body: `{ id, userId, name, agentType, teamName }`.
async fn create_agent(body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "id")?;
        let fields = ["id", "userId", "name", "agentType", "teamName"];
        if fields.iter().any(|field| !truthy(body.field(field))) {
            return Ok(error_json(
                400,
                "Missing required fields: id, userId, name, agentType, teamName",
            ));
        }
        let Some(agent_type) = body
            .field("agentType")
            .and_then(Value::as_str)
            .and_then(|value| AgentType::ALL.iter().copied().find(|t| t.as_str() == value))
        else {
            let allowed: Vec<&str> = AgentType::ALL.iter().map(|t| t.as_str()).collect();
            return Ok(error_json(
                400,
                format!("Invalid agentType. Must be one of: {}", allowed.join(", ")),
            ));
        };
        let agent = AGENT_WORKSPACE_SERVICE
            .create_agent(CreateAgentInput {
                id: text_of(body.field("id")),
                user_id: text_of(body.field("userId")),
                name: text_of(body.field("name")),
                agent_type,
                team_name: text_of(body.field("teamName")),
                documents: None,
            })
            .await?;
        Ok(json(201, AgentResponse { agent }))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to create agent"))
}

/// GET /agents/details
///
/// The agent record (no access check).
async fn get_agent_details() -> Response {
    match AGENT_WORKSPACE_SERVICE.get_agent().await {
        Ok(agent) => json(200, AgentResponse { agent }),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Management] Failed to get agent"
            );
            error_json(500, err.to_string())
        }
    }
}

/// DELETE /agents
///
/// Delete the agent with an optional ownership check. Body: `{ userId?, allowedByTeam? }`.
async fn delete_agent(body: JsonBody) -> Response {
    let options = DeleteAgentOptions {
        user_id: body
            .field("userId")
            .filter(|value| truthy(Some(value)))
            .map(|value| text_of(Some(value))),
        allowed_by_team: Some(truthy(body.field("allowedByTeam"))),
    };
    match AGENT_WORKSPACE_SERVICE.delete_agent(Some(options)).await {
        Ok(result) => json(200, ResultResponse { result }),
        Err(err) => fail(err, "Failed to delete agent"),
    }
}

/// GET /agents/{agentId}/subagents
///
/// List subagents for an agent.
async fn list_subagents(Path(agent_id): Path<String>) -> Response {
    match AGENT_WORKSPACE_SERVICE.get_subagents(&agent_id).await {
        Ok(subagents) => json(200, SubagentsResponse { subagents }),
        Err(err) => fail(err, "Failed to get subagents for agent"),
    }
}

/// POST /agents/{agentId}/subagents
///
/// Add a subagent to a parent agent. Body: `{ childAgentId, description? }`.
async fn add_subagent(Path(agent_id): Path<String>, body: JsonBody) -> Response {
    let result: anyhow::Result<Response> = async {
        destructure(&body, "childAgentId")?;
        let child = body.field("childAgentId");
        if !truthy(child) {
            return Ok(error_json(400, "Missing required field: childAgentId"));
        }
        let description = string_field(&body, "description");
        let result = AGENT_WORKSPACE_SERVICE
            .add_subagent(&agent_id, &text_of(child), description.as_deref())
            .await?;
        Ok(match result {
            AddSubagentResult::Added(agent) => json(201, AgentResponse { agent }),
            refused => {
                let code = refused.refusal().unwrap_or("");
                let status = if matches!(
                    refused,
                    AddSubagentResult::ParentNotFound | AddSubagentResult::ChildNotFound
                ) {
                    404
                } else {
                    400
                };
                error_json(status, code)
            }
        })
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "Failed to add subagent to agent"))
}

/// DELETE /agents/{agentId}/subagents/{childAgentId}
///
/// Remove a subagent from a parent agent.
async fn remove_subagent(Path((agent_id, child_agent_id)): Path<(String, String)>) -> Response {
    match AGENT_WORKSPACE_SERVICE
        .remove_subagent(&agent_id, &child_agent_id)
        .await
    {
        Ok(RemoveSubagentResult::ParentNotFound) => error_json(404, "parent_not_found"),
        Ok(RemoveSubagentResult::LinkNotFound) => error_json(404, "link_not_found"),
        Ok(result) => json(
            200,
            ResultResponse {
                result: result.as_str(),
            },
        ),
        Err(err) => fail(err, "Failed to remove subagent from agent"),
    }
}

// ============================================================================
// Skills (Agent Skills, agentskills.io). Used by both the web SPA and the CLI.
// ============================================================================

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

/// `{ threadId, skill }`, the 202 answer of `POST /agents/skills/{name}/run`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRunResponse {
    pub thread_id: String,
    pub skill: String,
}

/// GET /agents/skills
///
/// Available Agent Skills (name + description + on-disk folder + source). Bodies
/// are not included; the agent loads a skill's full SKILL.md via the `skill` tool
/// (progressive disclosure).
///
/// The listing is scoped to a thread's workspace: when that thread has a
/// `workspaceRoot` (the repo the CLI was started in), the repo's `.claude/skills` and
/// `.agents/skills` are merged in (labeled `source: "workspace"`). The thread is the
/// ownership-checked `?threadId` when given, else the latest thread (so the CLI,
/// which doesn't track its thread id, still gets its repo's skills). Web threads
/// have no `workspaceRoot`, so they list global skills only.
async fn list_skills(query: QueryParams) -> Response {
    let result: anyhow::Result<Response> = async {
        let agent_id = configured_agent_id();
        let requested = query.str("threadId").filter(|id| !id.is_empty());
        let workspace_root = match (requested, &agent_id) {
            (Some(requested), Some(agent_id)) => {
                let owned = CONVERSATION_SERVICE
                    .get_owned_thread_id(&CONFIG.owner_user_id(), agent_id, requested)
                    .await?;
                match owned {
                    Some(owned) => {
                        CONVERSATION_SERVICE
                            .get_thread_workspace_root(&owned)
                            .await?
                    }
                    None => None,
                }
            }
            _ => {
                // No explicit thread → use the latest thread's workspace, read-only
                // (never creates one). The CLI's startup thread has its launch cwd here.
                let latest = CONVERSATION_SERVICE
                    .find_latest_web_thread(&agent_id.unwrap_or_default(), &CONFIG.owner_user_id())
                    .await?;
                latest.and_then(|thread| thread.workspace_root)
            }
        };
        let skills: Vec<SkillListing> = SKILL_CATALOG_SERVICE
            .get_catalog(workspace_root.as_deref())
            .await
            .into_iter()
            .map(|skill| SkillListing {
                name: skill.name,
                description: skill.description,
                dir_name: skill.dir_name,
                source: skill.source,
                plugin_id: skill.plugin_id.filter(|id| !id.is_empty()),
            })
            .collect();
        Ok(json(200, skills))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "GET /skills failed"))
}

/// POST /agents/skills/{name}/run
///
/// Manually trigger a skill (the `/skills run` command in the web and CLI). The UI
/// parses the slash command and calls this REST endpoint (a slash command is never
/// parsed in the conversation engine). The run is dispatched as an ordinary chat
/// turn — the agent loads the skill body with the `skill` tool and follows it — so
/// the streamed reply goes out over the WebSocket channel the client is already
/// on. Fire-and-forget: answers 202 at once; engine errors surface as friendly steps.
async fn run_skill(Path(skill_name): Path<String>, body: JsonBody) -> Response {
    let Some(agent_id) = configured_agent_id() else {
        return error_json(503, "Agent not initialized (agentId unset)");
    };
    let result: anyhow::Result<Response> = async {
        // Resolve the thread (and its workspace) first: run in the thread the client
        // is viewing when given (ownership-checked), else the latest active thread —
        // same resolution as GET /messages. The workspace root is needed so a repo
        // skill can be found, not just the global ones.
        let thread_id = match body
            .field("threadId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            Some(requested) => {
                let owned = CONVERSATION_SERVICE
                    .get_owned_thread_id(&CONFIG.owner_user_id(), &agent_id, requested)
                    .await?;
                match owned {
                    Some(owned) => owned,
                    None => return Ok(error_json(404, "Thread not found")),
                }
            }
            None => {
                CONVERSATION_SERVICE
                    .get_or_create_latest_thread(&agent_id, &CONFIG.owner_user_id())
                    .await?
                    .id
            }
        };
        let workspace_root = CONVERSATION_SERVICE
            .get_thread_workspace_root(&thread_id)
            .await?;

        let Some(entry) = SKILL_CATALOG_SERVICE
            .find(&skill_name, workspace_root.as_deref())
            .await
        else {
            return Ok(error_json(
                404,
                format!("No available skill named \"{skill_name}\"."),
            ));
        };

        let directive = format!("Use the \"{}\" skill.", entry.name);
        let channel_label_for: ChannelLabelFor =
            Arc::new(|thread_id: String| Box::pin(async move { web_chat_label(&thread_id).await }));
        let input = ChatInput {
            user_id: CONFIG.owner_user_id(),
            agent_id: agent_id.clone(),
            message: directive,
            runtime_written: true,
            thread_id: Some(thread_id.clone()),
            metadata: Some(ChatMetadata {
                channel: Some(ChannelName::Websocket),
                ..ChatMetadata::default()
            }),
            channel_label_for: Some(channel_label_for),
            ..ChatInput::default()
        };
        tokio::spawn(async move {
            if let Err(err) = CONVERSATION_ENGINE_SERVICE.chat(input).await {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Management] skill run failed"
                );
            }
        });

        Ok(json(
            202,
            SkillRunResponse {
                thread_id,
                skill: entry.name,
            },
        ))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "POST /skills/:name/run failed"))
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
/// plugin actually contributed to the catalog — a skill shadowed by a workspace or
/// global one of the same name is absent, which is the truthful answer to "what is
/// this plugin giving me".
///
/// `diagnostics` has the non-fatal problems found while loading, so a half-broken
/// plugin is attributable here rather than only in the logs. A plugin whose
/// manifest was rejected outright does not appear at all.
async fn list_plugins() -> Response {
    let catalog = SKILL_CATALOG_SERVICE.get_catalog(None).await;
    // Connect anything not yet connected so a server that fails to start is
    // reported here rather than only in the logs. Idempotent and cached, so this is
    // a no-op once a turn has already collected tools.
    PLUGIN_MCP_SERVICE.get_tools().await;
    let statuses = PLUGIN_MCP_SERVICE.get_server_statuses();

    let plugin_data_root = get_execution_environment().paths().plugin_data_dir;
    let mut plugins = Vec::new();
    for plugin in PLUGIN_CATALOG_SERVICE.get_plugins().await {
        let mut diagnostics = plugin.diagnostics.clone();
        let mut mcp_servers: Vec<String> = Vec::new();

        if let Some(config_path) = &plugin.mcp_config_path {
            // Read on the side the plugin's files are, which a container path is not.
            match files_for(config_path).read_text(config_path, None).await {
                Ok(raw) => {
                    let id_base = plugin.id.rsplit('/').next().unwrap_or(&plugin.id);
                    let parsed = parse_mcp_json(
                        &raw,
                        &McpParseContext {
                            plugin_id: plugin.id.clone(),
                            plugin_root: plugin.dir.clone(),
                            plugin_data: format!(
                                "{}/{}",
                                plugin_data_root.trim_end_matches('/'),
                                id_base
                            ),
                        },
                    );
                    match parsed {
                        None => diagnostics
                            .push("mcp.json is invalid — no MCP servers loaded".to_string()),
                        Some(parsed) => {
                            mcp_servers = parsed
                                .servers
                                .iter()
                                .map(|s| s.name().to_string())
                                .collect();
                            diagnostics.extend(parsed.warnings);
                        }
                    }
                }
                Err(_) => diagnostics
                    .push("mcp.json could not be read — no MCP servers loaded".to_string()),
            }
        }

        for status in &statuses {
            if status.plugin_id == plugin.id && status.status == ServerStatusKind::Failed {
                diagnostics.push(format!(
                    "MCP server \"{}\" failed to start: {}",
                    status.server_name,
                    status.error.as_deref().unwrap_or("undefined")
                ));
            }
        }

        plugins.push(PluginListing {
            skills: catalog
                .iter()
                .filter(|skill| skill.plugin_id.as_deref() == Some(plugin.id.as_str()))
                .map(|skill| skill.name.clone())
                .collect(),
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: plugin.description,
            mcp_servers,
            diagnostics,
        });
    }
    json(200, plugins)
}

/// POST /agents/threads/{threadId}/compact
///
/// Manually compact a thread (the `/compact` command in the web and CLI). The UI
/// parses the slash command and calls this REST endpoint. Fire-and-forget: answers
/// 202 at once; progress and the result go out as `compaction` frames on the
/// WebSocket channel the client is already on.
async fn compact_thread(Path(requested): Path<String>) -> Response {
    let Some(agent_id) = configured_agent_id() else {
        return error_json(503, "Agent not initialized (agentId unset)");
    };
    let result: anyhow::Result<Response> = async {
        let Some(thread_id) = CONVERSATION_SERVICE
            .get_owned_thread_id(&CONFIG.owner_user_id(), &agent_id, &requested)
            .await?
        else {
            return Ok(error_json(404, "Thread not found"));
        };

        if !COMPACTION_SERVICE
            .has_compactable_history(&thread_id)
            .await?
        {
            return Ok(error_json(409, "Nothing to compact yet."));
        }

        let input = IdleInput {
            user_id: CONFIG.owner_user_id(),
            agent_id: agent_id.clone(),
            thread_id: thread_id.clone(),
        };
        tokio::spawn(async move { COMPACTION_SERVICE.compact_now(input).await });

        Ok(json(202, json!({ "threadId": thread_id })))
    }
    .await;
    result.unwrap_or_else(|err| fail(err, "POST /threads/:threadId/compact failed"))
}

#[cfg(test)]
mod tests;
