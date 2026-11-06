//! Teams mapping management routes.
//!
//! One area, one router. Mounted under `/agents` beside the other route modules.
//! The REST surface the Web UI's Channels page and the CLI use for Teams links.
//!
//! One env-sourced Teams connection (see `lib/teams_config.rs`), so reads and
//! deletes are not scoped by connection id. Conversation ids contain `:` and `@`
//! (`19:…@thread.tacv2`): clients percent-encode path parameters.

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Retry bound for generating a collision-free verification code.
const MAX_CODE_ATTEMPTS: u32 = 5;

/// The Teams routes, with their full `/agents/...` paths.
pub fn router() -> Router {
    Router::new()
        .route("/agents/teams/workspaces", get(list_workspaces))
        .route("/agents/teams-link-status", get(link_status))
        .route("/agents/teams-channel-mappings", get(list_channel_mappings))
        .route(
            "/agents/teams/create-verification-code",
            post(create_verification_code),
        )
        .route("/agents/teams/dm-mapping", delete(delete_dm_mapping))
        .route(
            "/agents/teams/channel-mapping/{conversationId}",
            delete(delete_channel_mapping),
        )
        .route(
            "/agents/teams/channel-mapping/{conversationId}/main",
            put(set_main_channel),
        )
}

/// The error body every handler here answers with: `{ error }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: String,
}

/// `{ workspaces }`, the answer of `GET /agents/teams/workspaces`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsWorkspacesResponse {
    /// The configured connection, or empty when Teams is disabled.
    pub workspaces: Vec<TeamsWorkspace>,
}

/// One configured Teams connection (tenant).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsWorkspace {
    pub tenant_id: String,
    pub client_id: String,
    pub name: String,
}

/// The answer of `GET /agents/teams-link-status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsLinkStatus {
    pub has_dm_mapping: bool,
    pub has_channel_mapping: bool,
    /// The Teams user of the first DM mapping, or null.
    pub teams_user_id: Option<String>,
}

/// `{ channels }`, the answer of `GET /agents/teams-channel-mappings`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelMappingsResponse {
    pub channels: Vec<TeamsChannelMapping>,
}

/// One linked Teams channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelMapping {
    pub id: String,
    pub conversation_id: Option<String>,
    pub channel_name: Option<String>,
    pub agent_name: String,
    #[serde(with = "crate::support::serde_iso")]
    pub linked_at: DateTime<Utc>,
    /// Whether this is the effective main channel: the flagged one, else the oldest.
    pub is_main: bool,
}

/// The body of `POST /agents/teams/create-verification-code`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVerificationCodeBody {
    /// Required; `DM` or `CHANNEL`, else 400 `type must be 'DM' or 'CHANNEL'`.
    #[serde(rename = "type")]
    pub r#type: Option<serde_json::Value>,
    /// Required.
    pub lens_user_id: Option<String>,
    /// Required.
    pub connection_id: Option<String>,
    /// Required.
    pub agent_id: Option<String>,
    /// Stored only when truthy.
    pub agent_name: Option<String>,
    /// Required; anything `new Date(...)` reads (text or epoch milliseconds), else
    /// 400 `expiresAt must be a valid date`.
    pub expires_at: Option<serde_json::Value>,
}

/// `{ code }`, the answer of `POST /agents/teams/create-verification-code`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCodeResponse {
    pub code: String,
}

/// `{ deleted }`: how many mappings a delete removed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedResponse {
    pub deleted: i64,
}

/// `{ ok: true }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResponse {
    pub ok: bool,
}

/// GET /agents/teams/workspaces
///
/// The configured Teams connection (tenant), or an empty list when Teams is
/// disabled. Used by the Web UI's Channels page to gate the Teams section. 500
/// `{ error }` on failure, logged as
/// `[Management] Failed to list teams workspaces: <msg>`.
async fn list_workspaces() -> Response {
    todo!()
}

/// GET /agents/teams-link-status
///
/// Whether the agent has a Teams DM and/or channel mapping. 500 `{ error }` on
/// failure, logged as `[Management] Failed to get teams link status for agent: <msg>`.
async fn link_status() -> Response {
    todo!()
}

/// GET /agents/teams-channel-mappings
///
/// The agent's Teams channel mappings, oldest first, with the effective main
/// channel resolved the same way delivery does (flagged, else oldest). 500
/// `{ error }` on failure, logged as
/// `[Management] Failed to get teams channel mappings for agent: <msg>`.
async fn list_channel_mappings() -> Response {
    todo!()
}

/// POST /agents/teams/create-verification-code
///
/// Generate a 6-character upper-case hex verification code (3 random bytes) and
/// persist it, retrying on a unique-constraint collision (P2002) up to
/// `MAX_CODE_ATTEMPTS` times. Expired codes are deleted first, fire-and-forget,
/// ignoring failure. Logs `[Management] Received request to create Teams
/// verification code` on entry.
///
/// 400 `Missing required fields: type, lensUserId, connectionId, agentId, expiresAt`
/// (logged as a warning) when one is falsy; 400 for a bad `type` or `expiresAt`. On
/// success emits `teams verification code created` for `lensUserId` with
/// `agent.id` and `verification.type` (the code stays out of telemetry) and
/// answers `{ code }`. After the last collision, 500
/// `Failed to generate a unique verification code`.
async fn create_verification_code(body: Option<Json<CreateVerificationCodeBody>>) -> Response {
    todo!()
}

/// DELETE /agents/teams/dm-mapping
///
/// Delete the agent's Teams DM mapping(s) and answer `{ deleted }`. When any were
/// removed, emits `teams dm mapping deleted` with `agent.id` (when set) and
/// `teams.mappings_removed`.
async fn delete_dm_mapping() -> Response {
    todo!()
}

/// DELETE /agents/teams/channel-mapping/{conversationId}
///
/// Delete a channel mapping by its (percent-encoded) channel conversation id.
/// 404 `Channel mapping not found` when none matched; otherwise emits
/// `teams channel mapping deleted` and answers `{ deleted }`.
async fn delete_channel_mapping(Path(conversation_id): Path<String>) -> Response {
    todo!()
}

/// PUT /agents/teams/channel-mapping/{conversationId}/main
///
/// Mark a linked Teams channel as the agent's main channel: where heartbeat alerts
/// (and scheduled tasks with no resolvable origin channel) are posted. 404
/// `Channel mapping not found` when the channel is not linked; otherwise emits
/// `teams main channel set` and answers `{ ok: true }`.
async fn set_main_channel(Path(conversation_id): Path<String>) -> Response {
    todo!()
}
