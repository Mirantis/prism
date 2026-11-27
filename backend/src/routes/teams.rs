//! Teams mapping management routes.
//!
//! One area, one router. Mounted under `/agents` beside the other route modules.
//! The REST surface the Web UI's Channels page and the CLI use for Teams links.
//!
//! One env-sourced Teams connection (see `lib/teams_config.rs`), so reads and
//! deletes are not scoped by connection id. Conversation ids contain `:` and `@`
//! (`19:…@thread.tacv2`): clients percent-encode path parameters.

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::db::models::{NewTeamsVerificationCode, TeamsMapping, TeamsVerificationType};
use crate::db::schema::{
    agent_workspaces as aw, teams_mappings as tm, teams_verification_codes as tvc,
};
use crate::db::sql_types::DbDateTime;
use crate::lib::teams_config::get_teams_config;
use crate::lib::telemetry::{agent_props, track_event};
use crate::services::teams::teams_mapping_service::TEAMS_MAPPING_SERVICE;
use crate::support::http::{JsonBody, error_json, json};
use crate::support::js::truthy;
use crate::{log_error, log_info, log_warn};

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
/// disabled. Used by the Web UI's Channels page to gate the Teams section.
async fn list_workspaces() -> Response {
    let connection = get_teams_config().await;
    json(
        200,
        TeamsWorkspacesResponse {
            workspaces: connection
                .map(|c| TeamsWorkspace {
                    tenant_id: c.tenant_id,
                    client_id: c.client_id,
                    name: c.name,
                })
                .into_iter()
                .collect(),
        },
    )
}

/// GET /agents/teams-link-status
///
/// Whether the agent has a Teams DM and/or channel mapping. 500 `{ error }` on
/// failure, logged as `[Management] Failed to get teams link status for agent: <msg>`.
async fn link_status() -> Response {
    let read = crate::db::run(|conn| {
        let dm_mapping: Option<Option<String>> = tm::table
            .filter(tm::teams_user_id.is_not_null())
            .select(tm::teams_user_id)
            .first(conn)
            .optional()?;
        let channel: Option<String> = tm::table
            .filter(tm::channel_conversation_id.is_not_null())
            .select(tm::id)
            .first(conn)
            .optional()?;
        Ok((dm_mapping, channel.is_some()))
    })
    .await;
    match read {
        Ok((dm_mapping, has_channel_mapping)) => json(
            200,
            TeamsLinkStatus {
                has_dm_mapping: dm_mapping.is_some(),
                has_channel_mapping,
                teams_user_id: dm_mapping.flatten(),
            },
        ),
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Management] Failed to get teams link status for agent: {}",
                msg
            );
            error_json(500, msg)
        }
    }
}

/// GET /agents/teams-channel-mappings
///
/// The agent's Teams channel mappings, oldest first, with the effective main
/// channel resolved the same way delivery does (flagged, else oldest). 500
/// `{ error }` on failure, logged as
/// `[Management] Failed to get teams channel mappings for agent: <msg>`.
async fn list_channel_mappings() -> Response {
    let read = crate::db::run(|conn| {
        Ok(tm::table
            .inner_join(aw::table)
            .filter(tm::channel_conversation_id.is_not_null())
            .order(tm::created_at.asc())
            .select((TeamsMapping::as_select(), aw::name))
            .load::<(TeamsMapping, String)>(conn)?)
    })
    .await;
    let mappings = match read {
        Ok(mappings) => mappings,
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Management] Failed to get teams channel mappings for agent: {}",
                msg
            );
            return error_json(500, msg);
        }
    };

    let main_id = mappings
        .iter()
        .find(|(m, _)| m.is_main_channel)
        .or_else(|| mappings.first())
        .map(|(m, _)| m.id.clone());

    let channels = mappings
        .into_iter()
        .map(|(m, agent_name)| TeamsChannelMapping {
            is_main: Some(&m.id) == main_id.as_ref(),
            id: m.id,
            conversation_id: m.channel_conversation_id,
            channel_name: m.channel_name,
            agent_name,
            linked_at: m.created_at,
        })
        .collect();

    json(200, TeamsChannelMappingsResponse { channels })
}

/// `new Date(value).getTime()` is a number: a date string, or epoch milliseconds.
fn parse_date(value: &Value) -> Option<DateTime<Utc>> {
    match value {
        Value::String(text) => crate::support::parse_iso(text),
        Value::Number(n) => n
            .as_f64()
            .filter(|ms| ms.is_finite() && ms.abs() <= 8.64e15)
            .map(|ms| crate::support::from_ms(ms.trunc() as i64)),
        Value::Bool(b) => Some(crate::support::from_ms(i64::from(*b))),
        _ => None,
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
                _ => "Object",
            }
        ),
    }
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
async fn create_verification_code(body: JsonBody) -> Response {
    log_info!("[Management] Received request to create Teams verification code");

    // Cleanup expired codes opportunistically (fire-and-forget)
    tokio::spawn(async {
        let now = DbDateTime::from(Utc::now());
        let _ = crate::db::run(move |conn| {
            diesel::delete(tvc::table.filter(tvc::expires_at.lt(now))).execute(conn)?;
            Ok(())
        })
        .await;
    });

    match create_code(body).await {
        Ok(response) => response,
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Management] Failed to create teams verification code: {}",
                msg
            );
            error_json(500, msg)
        }
    }
}

async fn create_code(body: JsonBody) -> anyhow::Result<Response> {
    let Some(body) = body.0 else {
        anyhow::bail!("Cannot destructure property 'type' of 'req.body' as it is undefined.");
    };
    let field = |key: &str| body.get(key).cloned().unwrap_or(Value::Null);
    let (r#type, lens_user_id, connection_id, agent_id, agent_name, expires_at) = (
        field("type"),
        field("lensUserId"),
        field("connectionId"),
        field("agentId"),
        field("agentName"),
        field("expiresAt"),
    );
    if !truthy(&r#type)
        || !truthy(&lens_user_id)
        || !truthy(&connection_id)
        || !truthy(&agent_id)
        || !truthy(&expires_at)
    {
        log_warn!(
            "[Management] Rejecting create teams verification code request: missing required fields"
        );
        return Ok(error_json(
            400,
            "Missing required fields: type, lensUserId, connectionId, agentId, expiresAt",
        ));
    }
    // Validate up front: a bad enum or date would otherwise surface as a
    // database error echoing internal validation text.
    let verification_type = match r#type.as_str() {
        Some("DM") => TeamsVerificationType::Dm,
        Some("CHANNEL") => TeamsVerificationType::Channel,
        _ => return Ok(error_json(400, "type must be 'DM' or 'CHANNEL'")),
    };
    let Some(expires_at) = parse_date(&expires_at) else {
        return Ok(error_json(400, "expiresAt must be a valid date"));
    };

    let lens_user_id = text_field("lensUserId", &lens_user_id)?;
    let mut data = NewTeamsVerificationCode::new(
        "", // placeholder, set in loop
        verification_type,
        lens_user_id.clone(),
        text_field("connectionId", &connection_id)?,
        text_field("agentId", &agent_id)?,
        expires_at,
    );
    if truthy(&agent_name) {
        data.agent_name = Some(text_field("agentName", &agent_name)?);
    }

    for attempt in 0..MAX_CODE_ATTEMPTS {
        let code = hex::encode_upper(rand::random::<[u8; 3]>());
        let mut row = data.clone();
        row.id = uuid::Uuid::new_v4().to_string();
        row.code = code.clone();
        let inserted = crate::db::run(move |conn| {
            diesel::insert_into(tvc::table).values(&row).execute(conn)?;
            Ok(())
        })
        .await;
        match inserted {
            Ok(()) => {
                // The code itself stays out of telemetry.
                let mut props = IndexMap::new();
                props.insert("agent.id".to_string(), data.agent_id.clone());
                props.insert(
                    "verification.type".to_string(),
                    verification_type.as_str().to_string(),
                );
                track_event(
                    "teams verification code created",
                    Some(&lens_user_id),
                    Some(props),
                );
                return Ok(json(200, VerificationCodeResponse { code }));
            }
            Err(err) if is_unique_violation(&err) && attempt < MAX_CODE_ATTEMPTS - 1 => {
                continue; // collision — retry with a new code
            }
            Err(err) => return Err(err),
        }
    }

    log_error!(
        "[Management] Failed to generate a unique teams verification code after {} attempts",
        MAX_CODE_ATTEMPTS
    );
    Ok(error_json(
        500,
        "Failed to generate a unique verification code",
    ))
}

/// Whether a database error is a unique-constraint violation (Prisma's `P2002`).
fn is_unique_violation(err: &anyhow::Error) -> bool {
    matches!(
        err.downcast_ref::<diesel::result::Error>(),
        Some(diesel::result::Error::DatabaseError(
            diesel::result::DatabaseErrorKind::UniqueViolation,
            _
        ))
    )
}

/// DELETE /agents/teams/dm-mapping
///
/// Delete the agent's Teams DM mapping(s) and answer `{ deleted }`. When any were
/// removed, emits `teams dm mapping deleted` with `agent.id` (when set) and
/// `teams.mappings_removed`.
async fn delete_dm_mapping() -> Response {
    let deleted = crate::db::run(|conn| {
        Ok(diesel::delete(tm::table.filter(tm::teams_user_id.is_not_null())).execute(conn)?)
    })
    .await;
    match deleted {
        Ok(count) => {
            if count > 0 {
                let mut props = agent_props();
                props.insert("teams.mappings_removed".to_string(), count.to_string());
                track_event("teams dm mapping deleted", None, Some(props));
            }
            json(
                200,
                DeletedResponse {
                    deleted: count as i64,
                },
            )
        }
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Management] Failed to delete Teams DM mapping for agent: {}",
                msg
            );
            error_json(500, msg)
        }
    }
}

/// DELETE /agents/teams/channel-mapping/{conversationId}
///
/// Delete a channel mapping by its (percent-encoded) channel conversation id.
/// 404 `Channel mapping not found` when none matched; otherwise emits
/// `teams channel mapping deleted` and answers `{ deleted }`.
async fn delete_channel_mapping(Path(conversation_id): Path<String>) -> Response {
    let target = conversation_id.clone();
    let deleted = crate::db::run(move |conn| {
        Ok(
            diesel::delete(tm::table.filter(tm::channel_conversation_id.eq(&target)))
                .execute(conn)?,
        )
    })
    .await;
    match deleted {
        Ok(0) => error_json(404, "Channel mapping not found"),
        Ok(count) => {
            let mut props = agent_props();
            props.insert("teams.conversation.id".to_string(), conversation_id);
            track_event("teams channel mapping deleted", None, Some(props));
            json(
                200,
                DeletedResponse {
                    deleted: count as i64,
                },
            )
        }
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Management] Failed to delete teams channel mapping for {}: {}",
                conversation_id,
                msg
            );
            error_json(500, msg)
        }
    }
}

/// PUT /agents/teams/channel-mapping/{conversationId}/main
///
/// Mark a linked Teams channel as the agent's main channel: where heartbeat alerts
/// (and scheduled tasks with no resolvable origin channel) are posted. 404
/// `Channel mapping not found` when the channel is not linked; otherwise emits
/// `teams main channel set` and answers `{ ok: true }`.
async fn set_main_channel(Path(conversation_id): Path<String>) -> Response {
    match mark_main_channel(&conversation_id).await {
        Ok(response) => response,
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Management] Failed to set teams main channel for {}: {}",
                conversation_id,
                msg
            );
            error_json(500, msg)
        }
    }
}

async fn mark_main_channel(conversation_id: &str) -> anyhow::Result<Response> {
    let target = conversation_id.to_string();
    let mapping: Option<String> = crate::db::run(move |conn| {
        Ok(tm::table
            .filter(tm::channel_conversation_id.eq(&target))
            .select(tm::agent_id)
            .first(conn)
            .optional()?)
    })
    .await?;
    let Some(agent_id) = mapping else {
        return Ok(error_json(404, "Channel mapping not found"));
    };

    TEAMS_MAPPING_SERVICE
        .set_main_channel(&agent_id, conversation_id)
        .await?;

    let mut props = agent_props();
    props.insert(
        "teams.conversation.id".to_string(),
        conversation_id.to_string(),
    );
    track_event("teams main channel set", None, Some(props));

    Ok(json(200, OkResponse { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::TeamsVerificationCode;
    use crate::db::testing::test_db;
    use crate::services::teams::teams_mapping_service::tests::{
        insert_agent, insert_channel, insert_dm,
    };
    use crate::support::http::testing::call;
    use serde_json::json;

    const TEAMS_CONV_ID: &str = "19:abc@thread.tacv2";
    const TEAMS_CONV_ID_ENCODED: &str = "19%3Aabc%40thread.tacv2";

    async fn codes() -> Vec<TeamsVerificationCode> {
        crate::db::run(|conn| {
            Ok(tvc::table
                .select(TeamsVerificationCode::as_select())
                .load(conn)?)
        })
        .await
        .unwrap()
    }

    async fn mappings() -> Vec<TeamsMapping> {
        crate::db::run(|conn| {
            Ok(tm::table
                .order(tm::created_at.asc())
                .select(TeamsMapping::as_select())
                .load(conn)?)
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn lists_no_workspace_when_teams_is_not_configured() {
        crate::lib::teams_config::__reset_teams_config_for_tests();

        let res = call(router(), "GET", "/agents/teams/workspaces", None).await;

        assert_eq!(res.status, 200);
        assert_eq!(res.json(), json!({ "workspaces": [] }));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_dm_and_channel_mappings() {
        let _db = test_db();
        let agent = insert_agent("A").await;

        let res = call(router(), "GET", "/agents/teams-link-status", None).await;
        assert_eq!(
            res.json(),
            json!({ "hasDmMapping": false, "hasChannelMapping": false, "teamsUserId": null })
        );

        insert_dm(&agent, "aad-1", "user-1", "a:dm", 0).await;
        insert_channel(&agent, TEAMS_CONV_ID, None, Some("user-1"), false, 0).await;
        let res = call(router(), "GET", "/agents/teams-link-status", None).await;

        assert_eq!(res.status, 200);
        assert_eq!(
            res.json(),
            json!({ "hasDmMapping": true, "hasChannelMapping": true, "teamsUserId": "aad-1" })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn marks_the_flagged_channel_as_main_else_the_oldest() {
        let _db = test_db();
        let agent = insert_agent("A").await;
        insert_channel(
            &agent,
            "19:old@thread.tacv2",
            Some("general"),
            None,
            false,
            20,
        )
        .await;
        insert_channel(&agent, TEAMS_CONV_ID, Some("alerts"), None, true, 10).await;

        let res = call(router(), "GET", "/agents/teams-channel-mappings", None).await;

        assert_eq!(res.status, 200);
        let body = res.json();
        let channels = body["channels"].as_array().unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0]["isMain"], json!(false));
        assert_eq!(channels[0]["channelName"], json!("general"));
        assert_eq!(channels[0]["agentName"], json!("A"));
        assert_eq!(channels[1]["isMain"], json!(true));
        assert_eq!(channels[1]["conversationId"], json!(TEAMS_CONV_ID));
        assert!(channels[1]["linkedAt"].as_str().unwrap().ends_with('Z'));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn creates_a_six_hex_code() {
        let _db = test_db();
        let agent = insert_agent("A").await;
        let expires_at = crate::support::iso(&(Utc::now() + chrono::Duration::minutes(15)));

        let res = call(
            router(),
            "POST",
            "/agents/teams/create-verification-code",
            Some(json!({
                "type": "DM",
                "lensUserId": "user-1",
                "connectionId": "tenant-1",
                "agentId": agent,
                "expiresAt": expires_at,
            })),
        )
        .await;

        assert_eq!(res.status, 200);
        let code = res.json()["code"].as_str().unwrap().to_string();
        assert!(regex::Regex::new(r"^[A-F0-9]{6}$").unwrap().is_match(&code));
        let stored = codes().await;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].code, code);
        assert_eq!(stored[0].r#type, TeamsVerificationType::Dm);
        assert_eq!(stored[0].agent_name, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_a_request_with_missing_fields() {
        let _db = test_db();

        let res = call(
            router(),
            "POST",
            "/agents/teams/create-verification-code",
            Some(json!({ "type": "DM" })),
        )
        .await;

        assert_eq!(res.status, 400);
        assert_eq!(
            res.json()["error"],
            json!("Missing required fields: type, lensUserId, connectionId, agentId, expiresAt")
        );
        assert!(codes().await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_an_unknown_type_with_400() {
        let _db = test_db();

        let res = call(
            router(),
            "POST",
            "/agents/teams/create-verification-code",
            Some(json!({
                "type": "BOGUS",
                "lensUserId": "user-1",
                "connectionId": "tenant-1",
                "agentId": "agent-1",
                "expiresAt": crate::support::now_iso(),
            })),
        )
        .await;

        assert_eq!(res.status, 400);
        assert_eq!(res.json()["error"], json!("type must be 'DM' or 'CHANNEL'"));
        assert!(codes().await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_an_unparseable_expiry_with_400() {
        let _db = test_db();

        let res = call(
            router(),
            "POST",
            "/agents/teams/create-verification-code",
            Some(json!({
                "type": "DM",
                "lensUserId": "user-1",
                "connectionId": "tenant-1",
                "agentId": "agent-1",
                "expiresAt": "garbage",
            })),
        )
        .await;

        assert_eq!(res.status, 400);
        assert_eq!(res.json()["error"], json!("expiresAt must be a valid date"));
        assert!(codes().await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn deletes_the_dm_mapping_rows() {
        let _db = test_db();
        let agent = insert_agent("A").await;
        insert_dm(&agent, "aad-1", "user-1", "a:dm", 0).await;
        insert_channel(&agent, TEAMS_CONV_ID, None, None, false, 0).await;

        let res = call(router(), "DELETE", "/agents/teams/dm-mapping", None).await;

        assert_eq!(res.status, 200);
        assert_eq!(res.json(), json!({ "deleted": 1 }));
        assert_eq!(mappings().await.len(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn unlinks_a_channel_by_its_percent_encoded_conversation_id() {
        let _db = test_db();
        let agent = insert_agent("A").await;
        insert_channel(&agent, TEAMS_CONV_ID, None, None, false, 0).await;
        let uri = format!("/agents/teams/channel-mapping/{TEAMS_CONV_ID_ENCODED}");

        let res = call(router(), "DELETE", &uri, None).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.json(), json!({ "deleted": 1 }));
        assert!(mappings().await.is_empty());

        let res = call(router(), "DELETE", &uri, None).await;
        assert_eq!(res.status, 404);
        assert_eq!(res.json(), json!({ "error": "Channel mapping not found" }));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sets_the_channel_as_the_agents_main_channel() {
        let _db = test_db();
        let agent = insert_agent("A").await;
        insert_channel(&agent, "19:old@thread.tacv2", None, None, true, 20).await;
        insert_channel(&agent, TEAMS_CONV_ID, None, None, false, 10).await;

        let res = call(
            router(),
            "PUT",
            &format!("/agents/teams/channel-mapping/{TEAMS_CONV_ID_ENCODED}/main"),
            None,
        )
        .await;

        assert_eq!(res.status, 200);
        assert_eq!(res.json(), json!({ "ok": true }));
        let flags: Vec<bool> = mappings().await.iter().map(|m| m.is_main_channel).collect();
        assert_eq!(flags, vec![false, true]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_404_for_a_main_channel_that_is_not_linked() {
        let _db = test_db();

        let res = call(
            router(),
            "PUT",
            &format!("/agents/teams/channel-mapping/{TEAMS_CONV_ID_ENCODED}/main"),
            None,
        )
        .await;

        assert_eq!(res.status, 404);
        assert_eq!(res.json(), json!({ "error": "Channel mapping not found" }));
    }
}
