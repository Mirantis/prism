//! Slack routes.
//!
//! One area, one router (AGENTS.md: a new HTTP route gets its own file). Merged
//! beside the other route modules in `server.rs`. The REST surface the Web UI's
//! Channels page and the CLI use for Slack links, the Slack heartbeat triggers,
//! and the Slack adapter's lifecycle.
//!
//! Heartbeat:
//!   POST   /agents/heartbeat/slack-trigger                     - Trigger from Slack channel
//!
//! Slack heartbeat trigger management:
//!   GET    /agents/slack-heartbeat-trigger/channel/{channelId} - Check if channel is a trigger
//!   GET    /agents/slack-heartbeat-trigger                     - List active triggers
//!   POST   /agents/slack-heartbeat-trigger                     - Create trigger
//!   PATCH  /agents/slack-heartbeat-trigger                     - Update throttle
//!   DELETE /agents/slack-heartbeat-trigger/{id}                - Delete trigger
//!   POST   /agents/slack-heartbeat-trigger/claim               - Try claim trigger
//!
//! Conversation threads:
//!   POST   /agents/threads/get-or-create-by-external-id        - Get/create by external id
//!
//! Slack verification + mappings:
//!   POST   /agents/slack/create-verification-code              - Generate link code
//!   POST   /agents/slack/verify-link-code                      - Verify DM link code
//!   POST   /agents/slack/verify-channel-link-code              - Verify channel link code
//!   GET    /agents/slack/workspaces                            - List connected workspaces
//!   GET    /agents/slack-link-status                           - DM/channel mapping existence
//!   GET    /agents/slack-channel-mappings                      - List channel mappings
//!   GET    /agents/slack/channel-mapping/{channelId}           - Find mapping by channel id
//!   DELETE /agents/slack/channel-mapping/{channelId}           - Delete channel mapping
//!   PUT    /agents/slack/channel-mapping/{channelId}/main      - Flag the main channel
//!   DELETE /agents/slack/dm-mapping                            - Delete DM mappings
//!   GET    /agents/slack-connection-id                         - Lookup connection id
//!
//! Slack adapter:
//!   POST   /agents/slack/deliver                               - Deliver a message
//!   POST   /agents/slack/{initialize,shutdown}                 - Slack adapter lifecycle
//!   POST   /agents/slack/add-connection                        - Slack connection wiring
//!   DELETE /agents/slack/remove-connection                     - Slack connection wiring
//!   POST   /agents/slack/link-user                             - Slack user link
//!   GET    /agents/slack/is-connected/{userId}                 - Connection check
//!   GET    /agents/slack/channel-name                          - Resolve channel id → name
//!
//! Every handler answers a failure with 500 `{ error: <message> }` after logging
//! `[Management] <what failed>: <message>` at error level, unless its doc says
//! otherwise. Body fields are checked with JavaScript truthiness: an empty string
//! counts as missing.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query};
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn router() -> Router {
    Router::new()
        .route("/agents/heartbeat/slack-trigger", post(trigger_heartbeat))
        .route(
            "/agents/slack-heartbeat-trigger/channel/{channelId}",
            get(is_trigger_channel),
        )
        .route(
            "/agents/slack-heartbeat-trigger",
            get(list_triggers)
                .post(create_trigger)
                .patch(update_trigger_throttle),
        )
        .route(
            "/agents/slack-heartbeat-trigger/{id}",
            delete(delete_trigger),
        )
        .route("/agents/slack-heartbeat-trigger/claim", post(claim_trigger))
        .route(
            "/agents/threads/get-or-create-by-external-id",
            post(get_or_create_thread_by_external_id),
        )
        .route("/agents/slack/verify-link-code", post(verify_link_code))
        .route(
            "/agents/slack/verify-channel-link-code",
            post(verify_channel_link_code),
        )
        .route(
            "/agents/slack/create-verification-code",
            post(create_verification_code),
        )
        .route("/agents/slack/workspaces", get(list_workspaces))
        .route("/agents/slack-link-status", get(link_status))
        .route("/agents/slack-channel-mappings", get(list_channel_mappings))
        .route(
            "/agents/slack/channel-mapping/{channelId}",
            get(find_channel_mapping).delete(delete_channel_mapping),
        )
        .route(
            "/agents/slack/channel-mapping/{channelId}/main",
            put(set_main_channel),
        )
        .route("/agents/slack/dm-mapping", delete(delete_dm_mapping))
        .route("/agents/slack-connection-id", get(connection_id))
        .route("/agents/slack/deliver", post(deliver))
        .route("/agents/slack/initialize", post(initialize))
        .route("/agents/slack/shutdown", post(shutdown))
        .route("/agents/slack/add-connection", post(add_connection))
        .route("/agents/slack/remove-connection", delete(remove_connection))
        .route("/agents/slack/link-user", post(link_user))
        .route("/agents/slack/is-connected/{userId}", get(is_connected))
        .route("/agents/slack/channel-name", get(channel_name))
}

/// How many fresh codes `POST /agents/slack/create-verification-code` tries
/// before it gives up on a unique one.
const MAX_CODE_ATTEMPTS: u32 = 5;

// ============================================================================
// Request bodies and queries
// ============================================================================

/// `?userId=` of the trigger list and the trigger delete.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerUserQuery {
    pub user_id: Option<String>,
}

/// The body of `POST /agents/slack-heartbeat-trigger`:
/// `{ connectionId, channelId, channelName, userId, throttleSeconds? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTriggerBody {
    pub connection_id: Option<String>,
    pub channel_id: Option<String>,
    /// Absent or `null` is stored as `null`.
    pub channel_name: Option<String>,
    pub user_id: Option<String>,
    /// Passed to the service as it came; absent takes the service's default.
    #[serde(default)]
    pub throttle_seconds: Option<Value>,
}

/// The body of `PATCH /agents/slack-heartbeat-trigger`:
/// `{ triggerId, userId, throttleSeconds }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTriggerBody {
    pub trigger_id: Option<String>,
    pub user_id: Option<String>,
    /// Required by presence (`=== undefined`), not by truthiness: outer `None` is
    /// the missing key, and an explicit `null` passes the check.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub throttle_seconds: Option<Option<Value>>,
}

/// The body of `POST /agents/threads/get-or-create-by-external-id`:
/// `{ userId, agentId, externalThreadId, channelId? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalThreadBody {
    pub user_id: Option<String>,
    pub agent_id: Option<String>,
    /// The external thread id, such as a Slack thread timestamp.
    pub external_thread_id: Option<String>,
    /// When given, the thread is bound to this Slack channel (`ThreadSource::SLACK`).
    pub channel_id: Option<String>,
}

/// The body of `POST /agents/slack/verify-link-code`:
/// `{ code, slackUserId, dmChannelId }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyLinkCodeBody {
    /// Matched in upper case.
    pub code: Option<String>,
    pub slack_user_id: Option<String>,
    pub dm_channel_id: Option<String>,
}

/// The body of `POST /agents/slack/verify-channel-link-code`:
/// `{ code, channelId, channelName? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyChannelLinkCodeBody {
    /// Matched in upper case.
    pub code: Option<String>,
    pub channel_id: Option<String>,
    /// Stored as `null` when absent or empty.
    pub channel_name: Option<String>,
}

/// The body of `POST /agents/slack/create-verification-code`:
/// `{ type, lensUserId, connectionId, agentId, agentName?, expiresAt }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVerificationCodeBody {
    /// `DM` or `CHANNEL`, the stored verification type.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub lens_user_id: Option<String>,
    pub connection_id: Option<String>,
    pub agent_id: Option<String>,
    /// Stored only when given and not empty.
    pub agent_name: Option<String>,
    /// Read as `new Date(expiresAt)`: ISO text or epoch milliseconds.
    #[serde(default)]
    pub expires_at: Option<Value>,
}

/// The `channelContext` of `POST /agents/slack/deliver`:
/// `{ channel, channelId?, threadTs?, threadId }`. The body names the thread
/// `threadTs`, as Slack does; the adapter receives it as `channel_thread_id`, and
/// every other field as it came.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackDeliverChannelContext {
    pub channel: Option<String>,
    pub channel_id: Option<String>,
    pub thread_ts: Option<String>,
    pub thread_id: Option<String>,
    pub include_feedback: Option<bool>,
}

/// The body of `POST /agents/slack/deliver`:
/// `{ userId, message, channelContext? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackDeliverBody {
    pub user_id: Option<String>,
    /// The `DeliverableMessage` the adapter posts.
    #[serde(default)]
    pub message: Option<Value>,
    pub channel_context: Option<SlackDeliverChannelContext>,
}

/// The body of `POST /agents/slack/add-connection` and
/// `DELETE /agents/slack/remove-connection`: `{ connectionId }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionBody {
    pub connection_id: Option<String>,
}

/// The body of `POST /agents/slack/link-user`:
/// `{ connectionId, slackUserId, lensUserId, agentId, dmChannelId? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkUserBody {
    pub connection_id: Option<String>,
    pub slack_user_id: Option<String>,
    pub lens_user_id: Option<String>,
    pub agent_id: Option<String>,
    pub dm_channel_id: Option<String>,
}

/// The query of `GET /agents/slack/channel-name`: `{ channelId, teamId }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelNameQuery {
    pub channel_id: Option<String>,
    pub team_id: Option<String>,
}

// ============================================================================
// Response bodies
// ============================================================================

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// `{ success: true }`.
#[derive(Debug, Clone, Serialize)]
pub struct SuccessBody {
    pub success: bool,
}

/// The body of a heartbeat the Slack trigger started: `{ success: true, status }`,
/// `status` being `queued`.
#[derive(Debug, Clone, Serialize)]
pub struct TriggerFiredBody {
    pub success: bool,
    pub status: String,
}

/// The answer to a link code: whether it linked, and the text the Slack user
/// reads. `agentName` comes with a channel link alone, and only when the code
/// named the agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCodeOutcome {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

/// `{ code }`: a new 6-character upper-case hex link code.
#[derive(Debug, Clone, Serialize)]
pub struct VerificationCodeBody {
    pub code: String,
}

/// One connected Slack workspace, as the Channels page header shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackWorkspace {
    pub team_id: String,
    pub team_name: String,
    pub bot_user_id: String,
}

/// `{ workspaces }`.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspacesBody {
    pub workspaces: Vec<SlackWorkspace>,
}

/// Whether the agent has a DM and/or channel mapping.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackLinkStatus {
    pub has_dm_mapping: bool,
    pub has_channel_mapping: bool,
    /// The linked DM user, or `null`.
    pub slack_user_id: Option<String>,
}

/// One linked channel, as the Channels page lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSlackChannel {
    /// The mapping row's id.
    pub id: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub agent_name: String,
    /// The mapping row's `createdAt`.
    #[serde(with = "crate::support::serde_iso")]
    pub linked_at: DateTime<Utc>,
    pub is_main: bool,
}

/// `{ channels }`.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelMappingsBody {
    pub channels: Vec<LinkedSlackChannel>,
}

/// The mapping of one channel: `{ id, agentId, slackChannelId }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMappingRef {
    pub id: String,
    pub agent_id: String,
    pub slack_channel_id: Option<String>,
}

/// `{ mapping }`.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelMappingBody {
    pub mapping: ChannelMappingRef,
}

/// `{ deleted }`: how many mapping rows a delete removed.
#[derive(Debug, Clone, Serialize)]
pub struct DeletedBody {
    pub deleted: i64,
}

/// `{ ok: true }`.
#[derive(Debug, Clone, Serialize)]
pub struct OkBody {
    pub ok: bool,
}

/// `{ connectionId }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdBody {
    pub connection_id: String,
}

/// `{ success: true, connectionId }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionAddedBody {
    pub success: bool,
    pub connection_id: String,
}

/// `{ connected }`.
#[derive(Debug, Clone, Serialize)]
pub struct ConnectedBody {
    pub connected: bool,
}

/// `{ name }`: the channel's name, or `null`.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelNameBody {
    pub name: Option<String>,
}

// ============================================================================
// Heartbeat
// ============================================================================

/// POST /agents/heartbeat/slack-trigger
///
/// Notify the runtime that new Slack messages are queued in the database. No body
/// required — the heartbeat reads them from `SLACK_MESSAGE_QUEUE_SERVICE`
/// (`HEARTBEAT_SERVICE.trigger_from`). `ignored` answers 404
/// `No active heartbeat`; `queued` answers `TriggerFiredBody`. A failure logs
/// `[Management] Failed to trigger heartbeat from Slack for agent: <message>`.
async fn trigger_heartbeat() -> Response {
    todo!()
}

// ============================================================================
// Slack Heartbeat Trigger Management
// ============================================================================

/// GET /agents/slack-heartbeat-trigger/channel/{channelId}
///
/// Check if a Slack channel is a heartbeat trigger channel: sends
/// `is_heartbeat_trigger_channel(channelId)` (`{ isTrigger, userId?, agentId? }`)
/// unchanged. A failure logs `[Management] Failed to check heartbeat trigger
/// channel <channelId>: <message>`.
async fn is_trigger_channel(Path(channel_id): Path<String>) -> Response {
    todo!()
}

/// GET /agents/slack-heartbeat-trigger
///
/// Get active heartbeat triggers for a specific agent. Query: `?userId=...`; a
/// missing one answers 400 `Missing userId query parameter`. Sends
/// `get_active_triggers(userId)` (the rows with `agentWorkspace: { name }`)
/// unchanged. A failure logs `[Management] Failed to get heartbeat triggers for
/// agent: <message>`.
async fn list_triggers(Query(query): Query<TriggerUserQuery>) -> Response {
    todo!()
}

/// POST /agents/slack-heartbeat-trigger
///
/// Create a new heartbeat trigger. Body:
/// `{ connectionId, channelId, channelName, userId, throttleSeconds? }`. A missing
/// connectionId, channelId or userId answers 400
/// `Missing required fields: connectionId, channelId, userId`. Answers 201 with the
/// created row. A unique-constraint violation (one trigger per agent) answers 409
/// `Agent already has a heartbeat trigger configured. Delete the existing one
/// first.`. A failure logs `[Management] Failed to create heartbeat trigger for
/// agent: <message>`.
async fn create_trigger(Json(body): Json<CreateTriggerBody>) -> Response {
    todo!()
}

/// PATCH /agents/slack-heartbeat-trigger
///
/// Update throttle settings for a trigger. Body:
/// `{ triggerId, userId, throttleSeconds }`; a missing field answers 400
/// `Missing required fields: triggerId, userId, throttleSeconds`. Sends the updated
/// row, or 404 `Trigger not found`. A failure logs `[Management] Failed to update
/// heartbeat trigger throttle for agent: <message>`.
async fn update_trigger_throttle(Json(body): Json<UpdateTriggerBody>) -> Response {
    todo!()
}

/// DELETE /agents/slack-heartbeat-trigger/{id}
///
/// Delete a heartbeat trigger. Query: `?userId=...`; a missing one answers 400
/// `Missing userId query parameter`. Answers `{ success: true }`. A failure logs
/// `[Management] Failed to delete heartbeat trigger <id>: <message>`.
///
/// Express also matches `DELETE /agents/slack-heartbeat-trigger/claim` here, with
/// `id` `claim`; axum's matcher sends that path to the static `claim` route, which
/// has no DELETE, and answers 405.
async fn delete_trigger(Path(id): Path<String>, Query(query): Query<TriggerUserQuery>) -> Response {
    todo!()
}

/// POST /agents/slack-heartbeat-trigger/claim
///
/// Atomically try to claim a trigger for firing: sends `try_claim_trigger()`
/// (`ClaimResult`) unchanged. A failure logs `[Management] Failed to claim
/// heartbeat trigger for agent: <message>`.
async fn claim_trigger() -> Response {
    todo!()
}

/// POST /agents/threads/get-or-create-by-external-id
///
/// Get or create a thread bound to an external thread ID (e.g. Slack thread
/// timestamp). Body: `{ userId, agentId, externalThreadId, channelId? }`; a missing
/// required field answers 400
/// `Missing required fields: userId, agentId, externalThreadId`. A `channelId`
/// binds the thread to that Slack channel. Sends the thread row. A failure logs
/// `[Management] Failed to get or create thread by external ID: <message>`.
async fn get_or_create_thread_by_external_id(Json(body): Json<ExternalThreadBody>) -> Response {
    todo!()
}

// ============================================================================
// Slack Verification
// ============================================================================

/// POST /agents/slack/verify-link-code
///
/// Verify a DM linking code from Slack. Body: `{ code, slackUserId, dmChannelId }`;
/// a missing field answers 400
/// `Missing required fields: code, slackUserId, dmChannelId`.
///
/// Every outcome below answers 200 `LinkCodeOutcome`:
/// - no `DM` code with that upper-case text: `That code is not valid. Generate a new
///   code in Prism Agent, under Settings → Channels.`
/// - an expired code, deleted (a failed delete is ignored): `That code has expired.
///   Generate a new code in Prism Agent, under Settings → Channels.`
/// - the Slack user already mapped on the code's connection, to the code's own user:
///   `Your Slack account is already linked to another agent. Unlink it first from
///   that agent's settings.`; to someone else: `This Slack account is already linked
///   to another Prism Agent user.`
///
/// Otherwise one transaction creates the DM mapping and consumes the code, the
/// route logs `Slack account linked via code: <slackUserId> -> <lensUserId>` (info,
/// with `slackUserId` and `lensUserId`), emits `slack dm linked` (user: the code's
/// lensUserId; `agent.id`, `slack.user.id`) and answers success with `Your Slack
/// account is now linked. You can chat with <agentName or 'your agent'> here.`. A
/// failure logs `[Management] Failed to verify Slack link code: <message>`.
async fn verify_link_code(Json(body): Json<VerifyLinkCodeBody>) -> Response {
    todo!()
}

/// POST /agents/slack/verify-channel-link-code
///
/// Verify a channel linking code from Slack. Body: `{ code, channelId, channelName? }`;
/// a missing field answers 400 `Missing required fields: code, channelId`.
///
/// Every outcome answers 200 `LinkCodeOutcome`: an unknown `CHANNEL` code and an
/// expired one answer as for a DM code; a channel already mapped answers
/// `This channel is already linked to an agent.`. Otherwise one transaction creates
/// the channel mapping and consumes the code, the route logs
/// `Slack channel linked via code: <channelId> -> <lensUserId>'s agent` (info, with
/// `channelId` and `lensUserId`), emits `slack channel linked` (`agent.id`,
/// `slack.channel.id`) and answers success with `Your Slack channel is now linked.
/// Mention me anytime you need help!` and the code's `agentName` when it has one.
/// A failure logs `[Management] Failed to verify channel link code: <message>`.
async fn verify_channel_link_code(Json(body): Json<VerifyChannelLinkCodeBody>) -> Response {
    todo!()
}

/// POST /agents/slack/create-verification-code
///
/// Generate a 6-char hex verification code and persist it, retrying on unique
/// constraint collision. Body:
/// `{ type, lensUserId, connectionId, agentId, agentName?, expiresAt }`.
///
/// Logs `[Management] Received request to create Slack verification code` (info),
/// then deletes the expired codes in the background, ignoring a failure. A missing
/// field logs a warning `[Management] Rejecting create verification code request:
/// missing required fields` and answers 400 `Missing required fields: type,
/// lensUserId, connectionId, agentId, expiresAt`. Each of `MAX_CODE_ATTEMPTS`
/// attempts logs `[Management] Generating verification code, attempt <n>/5`
/// (debug) and stores three random bytes as upper-case hex; a stored code emits
/// `slack verification code created` (user lensUserId; `agent.id`,
/// `verification.type`) and answers `{ code }`. A failed attempt logs
/// `[Management] Error creating verification code on attempt <n>/5: <message>`;
/// a collision before the last attempt retries, anything else fails the request
/// (`[Management] Failed to create verification code: <message>`, 500).
async fn create_verification_code(Json(body): Json<CreateVerificationCodeBody>) -> Response {
    todo!()
}

// ============================================================================
// Slack Mapping Management
// ============================================================================

/// GET /agents/slack/workspaces
///
/// List connected Slack workspaces (teamName + botUserId). Used by the Web UI's
/// Channels page header. A failure logs `[Management] Failed to list slack
/// workspaces: <message>`.
async fn list_workspaces() -> Response {
    todo!()
}

/// GET /agents/slack-link-status
///
/// Check whether the agent has a DM and/or channel mapping.
///
/// There is exactly one Slack connection, so there is nothing to scope by, and the
/// query does not filter by connectionId. Legacy rows hold a UUID connectionId that
/// never matches the env connection's teamId; filtering on it would hide them. A
/// failure logs `[Management] Failed to get slack link status for agent: <message>`.
async fn link_status() -> Response {
    todo!()
}

/// GET /agents/slack-channel-mappings
///
/// List the agent's channel mappings, oldest first.
///
/// There is exactly one Slack connection, so the query does not filter by
/// connectionId — legacy rows hold a UUID connectionId that never matches the env
/// connection's teamId. The main channel resolves the same way delivery does: the
/// flagged one, else the oldest linked channel as the implicit default (one agent
/// per container, so a single resolution across the list is correct). A failure
/// logs `[Management] Failed to get slack channel mappings for agent: <message>`.
async fn list_channel_mappings() -> Response {
    todo!()
}

/// GET /agents/slack/channel-mapping/{channelId}
///
/// Find a channel mapping by Slack channel ID: `{ mapping }`, or 404
/// `Channel mapping not found`.
///
/// `slackChannelId` is globally unique, and there is one Slack connection, so the
/// lookup is by channelId alone — no connectionId scoping (which would 404 legacy
/// rows). A failure logs `[Management] Failed to find channel mapping for
/// <channelId>: <message>`.
async fn find_channel_mapping(Path(channel_id): Path<String>) -> Response {
    todo!()
}

/// DELETE /agents/slack/channel-mapping/{channelId}
///
/// Delete a channel mapping by Slack channel ID: `{ deleted }`, or 404
/// `Channel mapping not found` when no row went. Keyed by the unique
/// `slackChannelId` only — no connectionId scoping, so legacy rows (UUID
/// connectionId) can be unlinked. A delete emits `slack channel mapping deleted`
/// (user `null`; `agent.id` when configured, `slack.channel.id`). A failure logs
/// `[Management] Failed to delete channel mapping for <channelId>: <message>`.
async fn delete_channel_mapping(Path(channel_id): Path<String>) -> Response {
    todo!()
}

/// PUT /agents/slack/channel-mapping/{channelId}/main
///
/// Mark a linked channel as the agent's main channel — where heartbeat alerts (and
/// scheduled tasks with no resolvable origin channel) are posted. Clears the flag
/// on the agent's other channels so exactly one is main
/// (`SLACK_MAPPING_SERVICE.set_main_channel`). An unknown channel answers 404
/// `Channel mapping not found`. Emits `slack main channel set` (user `null`;
/// `agent.id` when configured, `slack.channel.id`) and answers `{ ok: true }`. A
/// failure logs `[Management] Failed to set main channel for <channelId>: <message>`.
async fn set_main_channel(Path(channel_id): Path<String>) -> Response {
    todo!()
}

/// DELETE /agents/slack/dm-mapping
///
/// Delete the agent's DM mapping: `{ deleted }`.
///
/// There is one Slack connection, so the DM mapping is deleted without connectionId
/// scoping — legacy rows (UUID connectionId) would otherwise be left undeletable.
/// A delete of at least one row emits `slack dm mapping deleted` (user `null`;
/// `agent.id` when configured, `slack.mappings_removed` as text). A failure logs
/// `[Management] Failed to delete DM mapping for agent: <message>`.
async fn delete_dm_mapping() -> Response {
    todo!()
}

/// GET /agents/slack-connection-id
///
/// Find the connectionId for the agent via any SlackMapping: `{ connectionId }`, or
/// 404 `No Slack mapping found for agent`. A failure logs `[Management] Failed to
/// get connection ID for agent: <message>`.
async fn connection_id() -> Response {
    todo!()
}

// ============================================================================
// Slack Adapter Management
// ============================================================================

/// POST /agents/slack/deliver
///
/// Deliver a message to Slack (DM or channel). Body:
/// `{ userId, message, channelContext?: { channel, channelId?, threadTs?, threadId } }`;
/// a missing userId or message answers 400 `Missing required fields: userId,
/// message`. Answers `{ success: true }`. A failure logs `[Management] Failed to
/// deliver Slack message: <message>`.
async fn deliver(Json(body): Json<SlackDeliverBody>) -> Response {
    todo!()
}

/// POST /agents/slack/initialize
///
/// Initialize all Slack connections. Answers `{ success: true }`. A failure logs
/// `[Management] Failed to initialize Slack: <message>`.
async fn initialize() -> Response {
    todo!()
}

/// POST /agents/slack/shutdown
///
/// Shutdown all Slack connections. Answers `{ success: true }`. A failure logs
/// `[Management] Failed to shutdown Slack: <message>`.
async fn shutdown() -> Response {
    todo!()
}

/// POST /agents/slack/add-connection
///
/// Initialize a Slack workspace connection that was already stored. Body:
/// `{ connectionId }`; a missing one answers 400
/// `Missing required field: connectionId`. The connection starts in the background —
/// Socket Mode startup can take 15-30s — and a failure there logs
/// `[Management] Background Slack connection init failed: <message>`. Answers
/// `{ success: true, connectionId }` at once. A failure logs
/// `[Management] Failed to add Slack connection: <message>`.
async fn add_connection(Json(body): Json<ConnectionBody>) -> Response {
    todo!()
}

/// DELETE /agents/slack/remove-connection
///
/// Remove a Slack workspace connection. Body: `{ connectionId }`; a missing one
/// answers 400 `Missing required field: connectionId`. Answers
/// `{ success: true }`. A failure logs `[Management] Failed to remove Slack
/// connection: <message>`.
async fn remove_connection(Json(body): Json<ConnectionBody>) -> Response {
    todo!()
}

/// POST /agents/slack/link-user
///
/// Link a Slack user to a Lens user. Body:
/// `{ connectionId, slackUserId, lensUserId, agentId, dmChannelId? }`; a missing
/// field answers 400 `Missing required fields`. Answers `{ success: true }`. A
/// failure logs `[Management] Failed to link Slack user: <message>`.
async fn link_user(Json(body): Json<LinkUserBody>) -> Response {
    todo!()
}

/// GET /agents/slack/is-connected/{userId}
///
/// Check if a user has an active Slack connection: `{ connected }`. A failure logs
/// `[Management] Failed to check Slack connection: <message>`.
async fn is_connected(Path(user_id): Path<String>) -> Response {
    todo!()
}

/// GET /agents/slack/channel-name
///
/// Get a channel's name from the Slack API. Query: `{ channelId, teamId }`; a
/// missing one answers 400 `Missing required query params: channelId, teamId`.
/// Answers `{ name }`. A failure logs `[Management] Failed to get channel name:
/// <message>`.
async fn channel_name(Query(query): Query<ChannelNameQuery>) -> Response {
    todo!()
}
