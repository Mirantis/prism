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

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};

use crate::config::CONFIG;
use crate::db::models::{NewSlackVerificationCode, SlackMapping, SlackVerificationType};
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::db::schema::slack_mappings::dsl as m;
use crate::db::schema::slack_verification_codes::dsl as vc;
use crate::db::sql_types::DbDateTime;
use crate::lib::telemetry::track_event;
use crate::services::channel_adapter_interface::{ChannelContext, DeliverableMessage};
use crate::services::conversation_service::{CONVERSATION_SERVICE, LiveThread};
use crate::services::heartbeat_service::{HEARTBEAT_SERVICE, TriggerOutcome};
use crate::services::slack_adapter_service::{
    ChannelCodeOutcome, DmCodeOutcome, SLACK_ADAPTER_SERVICE, redeem_channel_code, redeem_dm_code,
};
use crate::services::slack_heartbeat_trigger_service::SLACK_HEARTBEAT_TRIGGER_SERVICE;
use crate::services::slack_mapping_service::SLACK_MAPPING_SERVICE;
use crate::services::slack_message_queue_service::slack_trigger_source;
use crate::support::http::{JsonBody, QueryParams, error_json, json};
use crate::support::js::truthy;
use crate::{log_debug, log_error, log_info, log_warn};

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

const CODE_NOT_VALID: &str =
    "That code is not valid. Generate a new code in Prism Agent, under Settings → Channels.";
const CODE_EXPIRED: &str =
    "That code has expired. Generate a new code in Prism Agent, under Settings → Channels.";

// ============================================================================
// Request helpers
// ============================================================================

/// The fields of `req.body`, which destructuring needs to be an object: an
/// absent body fails as JavaScript fails to destructure `undefined`.
struct Body(serde_json::Map<String, Value>);

impl Body {
    fn of(body: JsonBody, first_key: &str) -> anyhow::Result<Body> {
        match body.0 {
            None => anyhow::bail!(
                "Cannot destructure property '{first_key}' of 'req.body' as it is undefined."
            ),
            Some(Value::Object(map)) => Ok(Body(map)),
            Some(_) => Ok(Body(serde_json::Map::new())),
        }
    }

    /// The field, `null` when absent.
    fn get(&self, key: &str) -> Value {
        self.0.get(key).cloned().unwrap_or(Value::Null)
    }

    /// Whether the field is truthy.
    fn has(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(truthy)
    }

    /// The field as text, failing as Prisma refuses a value that is not a string.
    fn text(&self, key: &str) -> anyhow::Result<String> {
        text_field(key, &self.get(key))
    }

    /// The field as text when it is truthy.
    fn optional_text(&self, key: &str) -> anyhow::Result<Option<String>> {
        if self.has(key) {
            Ok(Some(self.text(key)?))
        } else {
            Ok(None)
        }
    }
}

/// A field that has to be text, as Prisma requires it.
fn text_field(name: &str, value: &Value) -> anyhow::Result<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        other => anyhow::bail!(
            "Invalid value for argument `{name}`: expected String, provided {}.",
            match other {
                Value::Number(_) => "Int",
                Value::Bool(_) => "Boolean",
                Value::Array(_) => "List",
                Value::Null => "Null",
                _ => "Object",
            }
        ),
    }
}

/// An integer field, failing as Prisma refuses a value that is not an Int.
fn int_field(name: &str, value: &Value) -> anyhow::Result<i64> {
    match value.as_i64() {
        Some(n) => Ok(n),
        None => anyhow::bail!("Invalid value for argument `{name}`: expected Int."),
    }
}

/// `new Date(value)`: ISO text or epoch milliseconds.
fn parse_date(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::String(text) => crate::support::parse_iso(text),
        Value::Number(n) => n
            .as_f64()
            .filter(|ms| ms.is_finite() && ms.abs() <= 8.64e15)
            .map(|ms| crate::support::from_ms(ms.trunc() as i64)),
        _ => None,
    }
}

/// `req.query[key] as string`, present and non-empty.
fn query_text(query: &QueryParams, key: &str) -> Option<String> {
    query.text(key).filter(|value| !value.is_empty())
}

/// Whether a database error is a unique-constraint violation (Prisma's P2002).
fn is_unique_violation(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<diesel::result::Error>(),
        Some(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _
        ))
    )
}

/// `{ 'agent.id': config.agentId }` when an agent id is set.
fn agent_props() -> IndexMap<String, String> {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props
}

/// The answer, or the 500 `{ error }` a failure gets, logged as
/// `[Management] <what>: <message>`.
fn answer(result: anyhow::Result<Response>, what: &str) -> Response {
    result.unwrap_or_else(|err| {
        let msg = err.to_string();
        log_error!("[Management] {}: {}", what, msg);
        error_json(500, msg)
    })
}

// ============================================================================
// Response bodies
// ============================================================================

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

impl LinkCodeOutcome {
    fn refused(message: &str) -> Self {
        LinkCodeOutcome {
            success: false,
            message: message.to_string(),
            agent_name: None,
        }
    }
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

/// The mapping of one channel: `{ id, agentId, slackChannelId }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMappingRef {
    pub id: String,
    pub agent_id: String,
    pub slack_channel_id: Option<String>,
}

// ============================================================================
// Heartbeat
// ============================================================================

/// POST /agents/heartbeat/slack-trigger
///
/// Notify the runtime that new Slack messages are queued in the database. No body
/// required — the heartbeat reads them from the Slack message queue
/// (`HEARTBEAT_SERVICE.trigger_from`). `ignored` answers 404
/// `No active heartbeat`; `queued` answers `{ success: true, status }`.
async fn trigger_heartbeat() -> Response {
    match HEARTBEAT_SERVICE.trigger_from(&slack_trigger_source()) {
        TriggerOutcome::Ignored => error_json(404, "No active heartbeat"),
        status => json(200, json!({ "success": true, "status": status.as_str() })),
    }
}

// ============================================================================
// Slack Heartbeat Trigger Management
// ============================================================================

/// GET /agents/slack-heartbeat-trigger/channel/{channelId}
///
/// Check if a Slack channel is a heartbeat trigger channel:
/// `{ isTrigger, userId?, agentId? }`.
async fn is_trigger_channel(Path(channel_id): Path<String>) -> Response {
    let result = SLACK_HEARTBEAT_TRIGGER_SERVICE
        .is_heartbeat_trigger_channel(&channel_id)
        .await
        .map(|check| json(200, check));
    answer(
        result,
        &format!("Failed to check heartbeat trigger channel {channel_id}"),
    )
}

/// GET /agents/slack-heartbeat-trigger
///
/// Get active heartbeat triggers for a specific agent. Query: `?userId=...`; a
/// missing one answers 400 `Missing userId query parameter`.
async fn list_triggers(query: QueryParams) -> Response {
    let Some(user_id) = query_text(&query, "userId") else {
        return error_json(400, "Missing userId query parameter");
    };
    let result = SLACK_HEARTBEAT_TRIGGER_SERVICE
        .get_active_triggers(&user_id)
        .await
        .map(|triggers| json(200, triggers));
    answer(result, "Failed to get heartbeat triggers for agent")
}

/// POST /agents/slack-heartbeat-trigger
///
/// Create a new heartbeat trigger. Body:
/// `{ connectionId, channelId, channelName, userId, throttleSeconds? }`. A missing
/// connectionId, channelId or userId answers 400. Answers 201 with the created
/// row. A unique-constraint violation (one trigger per agent) answers 409.
async fn create_trigger(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "connectionId")?;
        if !body.has("connectionId") || !body.has("channelId") || !body.has("userId") {
            return Ok(error_json(
                400,
                "Missing required fields: connectionId, channelId, userId",
            ));
        }
        let channel_name = match body.get("channelName") {
            Value::Null => None,
            value => Some(text_field("channelName", &value)?),
        };
        let throttle_seconds = match body.0.get("throttleSeconds") {
            None => None,
            Some(value) => Some(int_field("throttleSeconds", value)?),
        };
        let user_id = body.text("userId")?;
        let created = SLACK_HEARTBEAT_TRIGGER_SERVICE
            .create_trigger(
                &body.text("connectionId")?,
                &body.text("channelId")?,
                channel_name.as_deref(),
                &user_id,
                throttle_seconds,
            )
            .await;
        match created {
            Ok(trigger) => Ok(json(201, trigger)),
            // Unique constraint violation (agentId is unique)
            Err(err) if is_unique_violation(&err) => Ok(error_json(
                409,
                "Agent already has a heartbeat trigger configured. Delete the existing one first.",
            )),
            Err(err) => Err(err),
        }
    }
    .await;
    answer(result, "Failed to create heartbeat trigger for agent")
}

/// PATCH /agents/slack-heartbeat-trigger
///
/// Update throttle settings for a trigger. Body:
/// `{ triggerId, userId, throttleSeconds }`; `throttleSeconds` is required by
/// presence. Sends the updated row, or 404 `Trigger not found`.
async fn update_trigger_throttle(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "triggerId")?;
        if !body.has("triggerId") || !body.has("userId") || !body.0.contains_key("throttleSeconds")
        {
            return Ok(error_json(
                400,
                "Missing required fields: triggerId, userId, throttleSeconds",
            ));
        }
        let updated = SLACK_HEARTBEAT_TRIGGER_SERVICE
            .update_throttle(
                &body.text("triggerId")?,
                &body.text("userId")?,
                int_field("throttleSeconds", &body.get("throttleSeconds"))?,
            )
            .await?;
        Ok(match updated {
            Some(trigger) => json(200, trigger),
            None => error_json(404, "Trigger not found"),
        })
    }
    .await;
    answer(
        result,
        "Failed to update heartbeat trigger throttle for agent",
    )
}

/// DELETE /agents/slack-heartbeat-trigger/{id}
///
/// Delete a heartbeat trigger. Query: `?userId=...`; a missing one answers 400.
/// Answers `{ success: true }`.
///
/// Express also matches `DELETE /agents/slack-heartbeat-trigger/claim` here, with
/// `id` `claim`; axum's matcher sends that path to the static `claim` route, which
/// has no DELETE.
async fn delete_trigger(Path(id): Path<String>, query: QueryParams) -> Response {
    let Some(user_id) = query_text(&query, "userId") else {
        return error_json(400, "Missing userId query parameter");
    };
    let result = SLACK_HEARTBEAT_TRIGGER_SERVICE
        .delete_trigger(&id, &user_id)
        .await
        .map(|()| json(200, json!({ "success": true })));
    answer(result, &format!("Failed to delete heartbeat trigger {id}"))
}

/// POST /agents/slack-heartbeat-trigger/claim
///
/// Atomically try to claim a trigger for firing: sends the `ClaimResult`.
async fn claim_trigger() -> Response {
    let result = SLACK_HEARTBEAT_TRIGGER_SERVICE
        .try_claim_trigger()
        .await
        .map(|claim| json(200, claim));
    answer(result, "Failed to claim heartbeat trigger for agent")
}

/// POST /agents/threads/get-or-create-by-external-id
///
/// Get or create a thread bound to an external thread ID (e.g. Slack thread
/// timestamp). Body: `{ userId, agentId, externalThreadId, channelId? }`. A
/// `channelId` binds the thread to that Slack channel. Sends the thread row.
async fn get_or_create_thread_by_external_id(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "userId")?;
        if !body.has("userId") || !body.has("agentId") || !body.has("externalThreadId") {
            return Ok(error_json(
                400,
                "Missing required fields: userId, agentId, externalThreadId",
            ));
        }
        let live = body
            .optional_text("channelId")?
            .map(|channel_id| LiveThread {
                source: crate::db::models::ThreadSource::Slack,
                channel_id,
            });
        let thread = CONVERSATION_SERVICE
            .get_or_create_thread_by_external_id(
                &body.text("userId")?,
                &body.text("agentId")?,
                &body.text("externalThreadId")?,
                live,
            )
            .await?;
        Ok(json(200, thread))
    }
    .await;
    answer(result, "Failed to get or create thread by external ID")
}

// ============================================================================
// Slack Verification
// ============================================================================

/// POST /agents/slack/verify-link-code
///
/// Verify a DM linking code from Slack. Body: `{ code, slackUserId, dmChannelId }`.
/// Every outcome answers 200 `LinkCodeOutcome`. A link logs
/// `Slack account linked via code: <slackUserId> -> <lensUserId>` and emits
/// `slack dm linked`.
async fn verify_link_code(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "code")?;
        if !body.has("code") || !body.has("slackUserId") || !body.has("dmChannelId") {
            return Ok(error_json(
                400,
                "Missing required fields: code, slackUserId, dmChannelId",
            ));
        }
        let slack_user_id = body.text("slackUserId")?;
        let outcome =
            redeem_dm_code(&body.text("code")?, &slack_user_id, &body.text("dmChannelId")?)
                .await?;
        let reply = match outcome {
            DmCodeOutcome::Invalid => LinkCodeOutcome::refused(CODE_NOT_VALID),
            DmCodeOutcome::Expired => LinkCodeOutcome::refused(CODE_EXPIRED),
            DmCodeOutcome::LinkedToSameUser => LinkCodeOutcome::refused(
                "Your Slack account is already linked to another agent. Unlink it first from that agent's settings.",
            ),
            DmCodeOutcome::LinkedToOtherUser => LinkCodeOutcome::refused(
                "This Slack account is already linked to another Prism Agent user.",
            ),
            DmCodeOutcome::Linked(verification) => {
                log_info!(
                    json!({ "slackUserId": slack_user_id, "lensUserId": verification.lens_user_id }),
                    "Slack account linked via code: {} -> {}",
                    slack_user_id,
                    verification.lens_user_id
                );
                let mut props = IndexMap::new();
                props.insert("agent.id".to_string(), verification.agent_id.clone());
                props.insert("slack.user.id".to_string(), slack_user_id.clone());
                track_event(
                    "slack dm linked",
                    Some(&verification.lens_user_id),
                    Some(props),
                );
                LinkCodeOutcome {
                    success: true,
                    message: format!(
                        "Your Slack account is now linked. You can chat with {} here.",
                        verification
                            .agent_name
                            .filter(|name| !name.is_empty())
                            .unwrap_or_else(|| "your agent".to_string())
                    ),
                    agent_name: None,
                }
            }
        };
        Ok(json(200, reply))
    }
    .await;
    answer(result, "Failed to verify Slack link code")
}

/// POST /agents/slack/verify-channel-link-code
///
/// Verify a channel linking code from Slack. Body: `{ code, channelId, channelName? }`.
/// Every outcome answers 200 `LinkCodeOutcome`. A link logs
/// `Slack channel linked via code: <channelId> -> <lensUserId>'s agent` and emits
/// `slack channel linked`.
async fn verify_channel_link_code(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "code")?;
        if !body.has("code") || !body.has("channelId") {
            return Ok(error_json(400, "Missing required fields: code, channelId"));
        }
        let channel_id = body.text("channelId")?;
        let outcome = redeem_channel_code(
            &body.text("code")?,
            &channel_id,
            body.optional_text("channelName")?,
        )
        .await?;
        let reply = match outcome {
            ChannelCodeOutcome::Invalid => LinkCodeOutcome::refused(CODE_NOT_VALID),
            ChannelCodeOutcome::Expired => LinkCodeOutcome::refused(CODE_EXPIRED),
            ChannelCodeOutcome::AlreadyLinked => {
                LinkCodeOutcome::refused("This channel is already linked to an agent.")
            }
            ChannelCodeOutcome::Linked(verification) => {
                log_info!(
                    json!({ "channelId": channel_id, "lensUserId": verification.lens_user_id }),
                    "Slack channel linked via code: {} -> {}'s agent",
                    channel_id,
                    verification.lens_user_id
                );
                let mut props = IndexMap::new();
                props.insert("agent.id".to_string(), verification.agent_id.clone());
                props.insert("slack.channel.id".to_string(), channel_id.clone());
                track_event(
                    "slack channel linked",
                    Some(&verification.lens_user_id),
                    Some(props),
                );
                LinkCodeOutcome {
                    success: true,
                    message: "Your Slack channel is now linked. Mention me anytime you need help!"
                        .to_string(),
                    agent_name: verification.agent_name,
                }
            }
        };
        Ok(json(200, reply))
    }
    .await;
    answer(result, "Failed to verify channel link code")
}

/// POST /agents/slack/create-verification-code
///
/// Generate a 6-char hex verification code and persist it, retrying on unique
/// constraint collision. Body:
/// `{ type, lensUserId, connectionId, agentId, agentName?, expiresAt }`. Expired
/// codes are deleted in the background first. A stored code emits
/// `slack verification code created` and answers `{ code }`.
async fn create_verification_code(body: JsonBody) -> Response {
    log_info!("[Management] Received request to create Slack verification code");

    // Cleanup expired codes opportunistically (in the background)
    tokio::spawn(async {
        let now = DbDateTime::from(Utc::now());
        let _ = crate::db::run(move |conn| {
            diesel::delete(vc::slack_verification_codes.filter(vc::expires_at.lt(now)))
                .execute(conn)?;
            Ok(())
        })
        .await;
    });

    let result = async {
        let body = Body::of(body, "type")?;
        if !body.has("type")
            || !body.has("lensUserId")
            || !body.has("connectionId")
            || !body.has("agentId")
            || !body.has("expiresAt")
        {
            log_warn!(
                "[Management] Rejecting create verification code request: missing required fields"
            );
            return Ok(error_json(
                400,
                "Missing required fields: type, lensUserId, connectionId, agentId, expiresAt",
            ));
        }
        let kind_text = body.text("type")?;
        let kind = match kind_text.as_str() {
            "DM" => SlackVerificationType::Dm,
            "CHANNEL" => SlackVerificationType::Channel,
            other => anyhow::bail!(
                "Invalid value for argument `type`. Expected SlackVerificationType, provided {other}."
            ),
        };
        let Some(expires_at) = parse_date(&body.get("expiresAt")) else {
            anyhow::bail!("Invalid value for argument `expiresAt`: Provided Date object is invalid.");
        };
        let lens_user_id = body.text("lensUserId")?;
        let mut data = NewSlackVerificationCode::new(
            "", // placeholder, set in loop
            kind,
            lens_user_id.clone(),
            body.text("connectionId")?,
            body.text("agentId")?,
            expires_at,
        );
        data.agent_name = body.optional_text("agentName")?;

        for attempt in 0..MAX_CODE_ATTEMPTS {
            log_debug!(
                "[Management] Generating verification code, attempt {}/{}",
                attempt + 1,
                MAX_CODE_ATTEMPTS
            );
            let code = hex::encode_upper(rand::random::<[u8; 3]>());
            let mut row = data.clone();
            row.id = uuid::Uuid::new_v4().to_string();
            row.code = code.clone();
            let inserted = crate::db::run(move |conn| {
                diesel::insert_into(vc::slack_verification_codes)
                    .values(&row)
                    .execute(conn)?;
                Ok(())
            })
            .await;
            match inserted {
                Ok(()) => {
                    // The code itself stays out of telemetry.
                    let mut props = IndexMap::new();
                    props.insert("agent.id".to_string(), data.agent_id.clone());
                    props.insert("verification.type".to_string(), kind_text.clone());
                    track_event(
                        "slack verification code created",
                        Some(&lens_user_id),
                        Some(props),
                    );
                    return Ok(json(200, json!({ "code": code })));
                }
                Err(err) => {
                    log_error!(
                        "[Management] Error creating verification code on attempt {}/{}: {}",
                        attempt + 1,
                        MAX_CODE_ATTEMPTS,
                        err
                    );
                    if is_unique_violation(&err) && attempt < MAX_CODE_ATTEMPTS - 1 {
                        continue; // collision — retry with a new code
                    }
                    return Err(err);
                }
            }
        }

        log_error!(
            "[Management] Failed to generate a unique verification code after {} attempts",
            MAX_CODE_ATTEMPTS
        );
        Ok(error_json(500, "Failed to generate a unique verification code"))
    }
    .await;
    answer(result, "Failed to create verification code")
}

// ============================================================================
// Slack Mapping Management
// ============================================================================

/// GET /agents/slack/workspaces
///
/// List connected Slack workspaces (teamName + botUserId). Used by the Web UI's
/// Channels page header.
async fn list_workspaces() -> Response {
    json(
        200,
        json!({ "workspaces": SLACK_ADAPTER_SERVICE.list_connected_workspaces() }),
    )
}

/// GET /agents/slack-link-status
///
/// Check whether the agent has a DM and/or channel mapping.
///
/// There is exactly one Slack connection, so there is nothing to scope by, and the
/// query does not filter by connectionId. Legacy rows hold a UUID connectionId that
/// never matches the env connection's teamId; filtering on it would hide them.
async fn link_status() -> Response {
    let result = crate::db::read(|conn| {
        let dm: Option<Option<String>> = m::slack_mappings
            .filter(m::slack_user_id.is_not_null())
            .select(m::slack_user_id)
            .first(conn)
            .optional()?;
        let has_channel_mapping = m::slack_mappings
            .filter(m::slack_channel_id.is_not_null())
            .select(m::id)
            .first::<String>(conn)
            .optional()?
            .is_some();
        Ok(json(
            200,
            json!({
                "hasDmMapping": dm.is_some(),
                "hasChannelMapping": has_channel_mapping,
                "slackUserId": dm.flatten(),
            }),
        ))
    })
    .await;
    answer(result, "Failed to get slack link status for agent")
}

/// GET /agents/slack-channel-mappings
///
/// List the agent's channel mappings, oldest first.
///
/// There is exactly one Slack connection, so the query does not filter by
/// connectionId — legacy rows hold a UUID connectionId that never matches the env
/// connection's teamId. The main channel resolves the same way delivery does: the
/// flagged one, else the oldest linked channel as the implicit default (one agent
/// per container, so a single resolution across the list is correct).
async fn list_channel_mappings() -> Response {
    let result = crate::db::read(|conn| {
        let mappings: Vec<(SlackMapping, String)> = m::slack_mappings
            .inner_join(aw::agent_workspaces)
            .filter(m::slack_channel_id.is_not_null())
            .order(m::created_at.asc())
            .select((SlackMapping::as_select(), aw::name))
            .load(conn)?;
        let main_id = mappings
            .iter()
            .find(|(mapping, _)| mapping.is_main_channel)
            .or(mappings.first())
            .map(|(mapping, _)| mapping.id.clone());
        let channels: Vec<LinkedSlackChannel> = mappings
            .into_iter()
            .map(|(mapping, agent_name)| LinkedSlackChannel {
                is_main: Some(&mapping.id) == main_id.as_ref(),
                id: mapping.id,
                channel_id: mapping.slack_channel_id,
                channel_name: mapping.slack_channel_name,
                agent_name,
                linked_at: mapping.created_at,
            })
            .collect();
        Ok(json(200, json!({ "channels": channels })))
    })
    .await;
    answer(result, "Failed to get slack channel mappings for agent")
}

/// GET /agents/slack/channel-mapping/{channelId}
///
/// Find a channel mapping by Slack channel ID: `{ mapping }`, or 404
/// `Channel mapping not found`.
async fn find_channel_mapping(Path(channel_id): Path<String>) -> Response {
    let channel = channel_id.clone();
    let result = crate::db::read(move |conn| {
        let mapping: Option<(String, String, Option<String>)> = m::slack_mappings
            .filter(m::slack_channel_id.eq(&channel))
            .select((m::id, m::agent_id, m::slack_channel_id))
            .first(conn)
            .optional()?;
        Ok(match mapping {
            None => error_json(404, "Channel mapping not found"),
            Some((id, agent_id, slack_channel_id)) => json(
                200,
                json!({
                    "mapping": ChannelMappingRef { id, agent_id, slack_channel_id },
                }),
            ),
        })
    })
    .await;
    answer(
        result,
        &format!("Failed to find channel mapping for {channel_id}"),
    )
}

/// DELETE /agents/slack/channel-mapping/{channelId}
///
/// Delete a channel mapping by Slack channel ID: `{ deleted }`, or 404
/// `Channel mapping not found` when no row went. Emits
/// `slack channel mapping deleted`.
async fn delete_channel_mapping(Path(channel_id): Path<String>) -> Response {
    let channel = channel_id.clone();
    let result = async {
        let deleted = crate::db::run(move |conn| {
            Ok(
                diesel::delete(m::slack_mappings.filter(m::slack_channel_id.eq(&channel)))
                    .execute(conn)?,
            )
        })
        .await?;
        if deleted == 0 {
            return Ok(error_json(404, "Channel mapping not found"));
        }
        let mut props = agent_props();
        props.insert("slack.channel.id".to_string(), channel_id.clone());
        track_event("slack channel mapping deleted", None, Some(props));
        Ok(json(200, json!({ "deleted": deleted })))
    }
    .await;
    answer(
        result,
        &format!("Failed to delete channel mapping for {channel_id}"),
    )
}

/// PUT /agents/slack/channel-mapping/{channelId}/main
///
/// Mark a linked channel as the agent's main channel — where heartbeat alerts (and
/// scheduled tasks with no resolvable origin channel) are posted. An unknown
/// channel answers 404. Emits `slack main channel set` and answers `{ ok: true }`.
async fn set_main_channel(Path(channel_id): Path<String>) -> Response {
    let result = async {
        let channel = channel_id.clone();
        let agent_id: Option<String> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::slack_channel_id.eq(&channel))
                .select(m::agent_id)
                .first(conn)
                .optional()?)
        })
        .await?;
        let Some(agent_id) = agent_id else {
            return Ok(error_json(404, "Channel mapping not found"));
        };
        SLACK_MAPPING_SERVICE
            .set_main_channel(&agent_id, &channel_id)
            .await?;
        let mut props = agent_props();
        props.insert("slack.channel.id".to_string(), channel_id.clone());
        track_event("slack main channel set", None, Some(props));
        Ok(json(200, json!({ "ok": true })))
    }
    .await;
    answer(
        result,
        &format!("Failed to set main channel for {channel_id}"),
    )
}

/// DELETE /agents/slack/dm-mapping
///
/// Delete the agent's DM mapping: `{ deleted }`. There is one Slack connection,
/// so the DM mapping is deleted without connectionId scoping — legacy rows (UUID
/// connectionId) would otherwise be left undeletable.
async fn delete_dm_mapping() -> Response {
    let result = async {
        let deleted = crate::db::run(|conn| {
            Ok(
                diesel::delete(m::slack_mappings.filter(m::slack_user_id.is_not_null()))
                    .execute(conn)?,
            )
        })
        .await?;
        if deleted > 0 {
            let mut props = agent_props();
            props.insert("slack.mappings_removed".to_string(), deleted.to_string());
            track_event("slack dm mapping deleted", None, Some(props));
        }
        Ok(json(200, json!({ "deleted": deleted })))
    }
    .await;
    answer(result, "Failed to delete DM mapping for agent")
}

/// GET /agents/slack-connection-id
///
/// Find the connectionId for the agent via any SlackMapping: `{ connectionId }`, or
/// 404 `No Slack mapping found for agent`.
async fn connection_id() -> Response {
    let result = crate::db::read(|conn| {
        let connection: Option<String> = m::slack_mappings
            .select(m::connection_id)
            .first(conn)
            .optional()?;
        Ok(match connection {
            None => error_json(404, "No Slack mapping found for agent"),
            Some(connection_id) => json(200, json!({ "connectionId": connection_id })),
        })
    })
    .await;
    answer(result, "Failed to get connection ID for agent")
}

// ============================================================================
// Slack Adapter Management
// ============================================================================

/// POST /agents/slack/deliver
///
/// Deliver a message to Slack (DM or channel). Body:
/// `{ userId, message, channelContext?: { channel, channelId?, threadTs?, threadId } }`.
/// The body names the thread `threadTs`, as Slack does; the adapter receives it
/// as `channelThreadId`. Answers `{ success: true }`.
async fn deliver(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "userId")?;
        if !body.has("userId") || !body.has("message") {
            return Ok(error_json(400, "Missing required fields: userId, message"));
        }
        let message: DeliverableMessage = serde_json::from_value(body.get("message"))?;
        let channel_context = match body.get("channelContext") {
            Value::Object(mut context) => {
                let thread_ts = context.remove("threadTs");
                context.remove("channelThreadId");
                if let Some(thread_ts) = thread_ts.filter(|ts| !ts.is_null()) {
                    context.insert("channelThreadId".into(), thread_ts);
                }
                Some(serde_json::from_value::<ChannelContext>(Value::Object(
                    context,
                ))?)
            }
            _ => None,
        };
        SLACK_ADAPTER_SERVICE
            .deliver(&body.text("userId")?, &message, channel_context.as_ref())
            .await?;
        Ok(json(200, json!({ "success": true })))
    }
    .await;
    answer(result, "Failed to deliver Slack message")
}

/// POST /agents/slack/initialize
///
/// Initialize all Slack connections. Answers `{ success: true }`.
async fn initialize() -> Response {
    let result = SLACK_ADAPTER_SERVICE
        .initialize()
        .await
        .map(|()| json(200, json!({ "success": true })));
    answer(result, "Failed to initialize Slack")
}

/// POST /agents/slack/shutdown
///
/// Shutdown all Slack connections. Answers `{ success: true }`.
async fn shutdown() -> Response {
    let result = SLACK_ADAPTER_SERVICE
        .shutdown()
        .await
        .map(|()| json(200, json!({ "success": true })));
    answer(result, "Failed to shutdown Slack")
}

/// POST /agents/slack/add-connection
///
/// Initialize a Slack workspace connection that was already stored. Body:
/// `{ connectionId }`. The connection starts in the background — Socket Mode
/// startup can take 15-30s — and a failure there logs
/// `[Management] Background Slack connection init failed: <message>`. Answers
/// `{ success: true, connectionId }` at once.
async fn add_connection(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "connectionId")?;
        if !body.has("connectionId") {
            return Ok(error_json(400, "Missing required field: connectionId"));
        }
        let connection_id = body.text("connectionId")?;
        let started = connection_id.clone();
        tokio::spawn(async move {
            if let Err(err) = SLACK_ADAPTER_SERVICE.initialize_connection(&started).await {
                log_error!(
                    "[Management] Background Slack connection init failed: {}",
                    err
                );
            }
        });
        Ok(json(
            200,
            json!({ "success": true, "connectionId": connection_id }),
        ))
    }
    .await;
    answer(result, "Failed to add Slack connection")
}

/// DELETE /agents/slack/remove-connection
///
/// Remove a Slack workspace connection. Body: `{ connectionId }`. Answers
/// `{ success: true }`.
async fn remove_connection(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "connectionId")?;
        if !body.has("connectionId") {
            return Ok(error_json(400, "Missing required field: connectionId"));
        }
        SLACK_ADAPTER_SERVICE
            .disconnect_and_deactivate(&body.text("connectionId")?)
            .await?;
        Ok(json(200, json!({ "success": true })))
    }
    .await;
    answer(result, "Failed to remove Slack connection")
}

/// POST /agents/slack/link-user
///
/// Link a Slack user to a Lens user. Body:
/// `{ connectionId, slackUserId, lensUserId, agentId, dmChannelId? }`. Answers
/// `{ success: true }`.
async fn link_user(body: JsonBody) -> Response {
    let result = async {
        let body = Body::of(body, "connectionId")?;
        if !body.has("connectionId")
            || !body.has("slackUserId")
            || !body.has("lensUserId")
            || !body.has("agentId")
        {
            return Ok(error_json(400, "Missing required fields"));
        }
        let dm_channel_id = match body.get("dmChannelId") {
            Value::Null => None,
            value => Some(text_field("dmChannelId", &value)?),
        };
        SLACK_ADAPTER_SERVICE
            .link_slack_user(
                &body.text("connectionId")?,
                &body.text("slackUserId")?,
                &body.text("lensUserId")?,
                &body.text("agentId")?,
                dm_channel_id.as_deref(),
            )
            .await?;
        Ok(json(200, json!({ "success": true })))
    }
    .await;
    answer(result, "Failed to link Slack user")
}

/// GET /agents/slack/is-connected/{userId}
///
/// Check if a user has an active Slack connection: `{ connected }`.
async fn is_connected(Path(user_id): Path<String>) -> Response {
    let result = SLACK_ADAPTER_SERVICE
        .is_user_connected(&user_id)
        .await
        .map(|connected| json(200, json!({ "connected": connected })));
    answer(result, "Failed to check Slack connection")
}

/// GET /agents/slack/channel-name
///
/// Get a channel's name from the Slack API. Query: `{ channelId, teamId }`; a
/// missing one answers 400. Answers `{ name }`.
async fn channel_name(query: QueryParams) -> Response {
    let (Some(channel_id), Some(team_id)) = (
        query_text(&query, "channelId"),
        query_text(&query, "teamId"),
    ) else {
        return error_json(400, "Missing required query params: channelId, teamId");
    };
    let name = SLACK_ADAPTER_SERVICE
        .get_channel_name(&channel_id, &team_id)
        .await;
    json(200, json!({ "name": name }))
}

#[cfg(test)]
mod tests;
