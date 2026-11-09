//! Slack Heartbeat Trigger Service
//!
//! CRUD service for per-agent Slack heartbeat trigger config.
//! Each agent can have at most one trigger. When configured, messages
//! in the designated Slack channel trigger the agent's heartbeat.
//!
//! Includes throttle logic: an atomic compare-and-set claim prevents
//! race conditions across multiple instances.

use std::sync::LazyLock;

use chrono::Utc;
use diesel::SqliteConnection;
use diesel::prelude::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::config::CONFIG;
use crate::db::models::{NewSlackHeartbeatTrigger, SlackHeartbeatTrigger};
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::db::schema::slack_heartbeat_triggers::dsl as t;
use crate::db::sql_types::DbDateTime;
use crate::lib::telemetry::track_event;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResult {
    pub claimed: bool,
    /// Seconds remaining until cooldown expires (only set when not claimed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<i64>,
}

/// The agent a trigger belongs to, as the trigger list names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerAgentName {
    pub name: String,
}

/// A trigger row with its agent's name, as `GET /agents/slack-heartbeat-trigger`
/// serves it: the row's fields, then `agentWorkspace: { name }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackHeartbeatTriggerWithAgent {
    #[serde(flatten)]
    pub trigger: SlackHeartbeatTrigger,
    pub agent_workspace: TriggerAgentName,
}

/// Whether a Slack channel is a heartbeat trigger, and whose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerChannelCheck {
    pub is_trigger: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// `{ 'agent.id': config.agentId }` when an agent id is set.
fn agent_props() -> IndexMap<String, String> {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props
}

pub struct SlackHeartbeatTriggerService;

impl SlackHeartbeatTriggerService {
    pub fn new() -> Self {
        SlackHeartbeatTriggerService
    }

    /// Get all active triggers for a specific user, newest first.
    pub async fn get_active_triggers(
        &self,
        user_id: &str,
    ) -> anyhow::Result<Vec<SlackHeartbeatTriggerWithAgent>> {
        let user_id = user_id.to_string();
        let rows: Vec<(SlackHeartbeatTrigger, String)> = crate::db::read(move |conn| {
            Ok(t::slack_heartbeat_triggers
                .inner_join(aw::agent_workspaces)
                .filter(t::user_id.eq(&user_id))
                .filter(t::is_active.eq(true))
                .order(t::created_at.desc())
                .select((SlackHeartbeatTrigger::as_select(), aw::name))
                .load(conn)?)
        })
        .await?;
        Ok(rows
            .into_iter()
            .map(|(trigger, name)| SlackHeartbeatTriggerWithAgent {
                trigger,
                agent_workspace: TriggerAgentName { name },
            })
            .collect())
    }

    /// Create a new heartbeat trigger for the user. Fails with
    /// `AGENT_ID not configured` when the runtime has no agent id. Emits
    /// `slack heartbeat trigger created`.
    pub async fn create_trigger(
        &self,
        connection_id: &str,
        channel_id: &str,
        channel_name: Option<&str>,
        user_id: &str,
        throttle_seconds: Option<i64>,
    ) -> anyhow::Result<SlackHeartbeatTrigger> {
        let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
            anyhow::bail!("AGENT_ID not configured");
        };
        let mut row = NewSlackHeartbeatTrigger::new(connection_id, channel_id, agent_id, user_id);
        row.slack_channel_name = channel_name.map(str::to_string);
        row.is_active = true;
        if let Some(throttle_seconds) = throttle_seconds {
            row.throttle_seconds = throttle_seconds;
        }
        let trigger: SlackHeartbeatTrigger = crate::db::run(move |conn| {
            diesel::insert_into(t::slack_heartbeat_triggers)
                .values(&row)
                .execute(conn)?;
            Ok(t::slack_heartbeat_triggers
                .filter(t::id.eq(&row.id))
                .select(SlackHeartbeatTrigger::as_select())
                .first(conn)?)
        })
        .await?;
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), trigger.agent_id.clone());
        props.insert("trigger.id".to_string(), trigger.id.clone());
        props.insert(
            "slack.channel.id".to_string(),
            trigger.slack_channel_id.clone(),
        );
        props.insert(
            "trigger.throttle_seconds".to_string(),
            trigger.throttle_seconds.to_string(),
        );
        track_event(
            "slack heartbeat trigger created",
            Some(user_id),
            Some(props),
        );
        Ok(trigger)
    }

    /// Remove a specific trigger by ID, scoped to the user. Emits
    /// `slack heartbeat trigger deleted` when a row was removed.
    pub async fn delete_trigger(&self, trigger_id: &str, user_id: &str) -> anyhow::Result<()> {
        let id = trigger_id.to_string();
        let user = user_id.to_string();
        let count = crate::db::run(move |conn| {
            Ok(diesel::delete(
                t::slack_heartbeat_triggers
                    .filter(t::id.eq(&id))
                    .filter(t::user_id.eq(&user)),
            )
            .execute(conn)?)
        })
        .await?;
        if count > 0 {
            let mut props = agent_props();
            props.insert("trigger.id".to_string(), trigger_id.to_string());
            track_event(
                "slack heartbeat trigger deleted",
                Some(user_id),
                Some(props),
            );
        }
        Ok(())
    }

    /// Delete all triggers for a given connection. Used when a SlackConnection
    /// is removed — no FK cascade exists because SlackConnection lives outside
    /// this database.
    pub async fn delete_by_connection_id(&self, connection_id: &str) -> anyhow::Result<i64> {
        let connection_id = connection_id.to_string();
        crate::db::run(move |conn| {
            SLACK_HEARTBEAT_TRIGGER_SERVICE.delete_by_connection_id_in(conn, &connection_id)
        })
        .await
    }

    /// `delete_by_connection_id` inside a caller's transaction, so the caller can
    /// batch it with other deletes for all-or-nothing semantics.
    pub fn delete_by_connection_id_in(
        &self,
        conn: &mut SqliteConnection,
        connection_id: &str,
    ) -> anyhow::Result<i64> {
        let deleted =
            diesel::delete(t::slack_heartbeat_triggers.filter(t::connection_id.eq(connection_id)))
                .execute(conn)?;
        Ok(deleted as i64)
    }

    /// Update throttle settings for a trigger. `None` when the user has no such
    /// trigger. Emits `slack heartbeat trigger updated`.
    pub async fn update_throttle(
        &self,
        trigger_id: &str,
        user_id: &str,
        throttle_seconds: i64,
    ) -> anyhow::Result<Option<SlackHeartbeatTrigger>> {
        let id = trigger_id.to_string();
        let user = user_id.to_string();
        let count = crate::db::run(move |conn| {
            Ok(diesel::update(
                t::slack_heartbeat_triggers
                    .filter(t::id.eq(&id))
                    .filter(t::user_id.eq(&user)),
            )
            .set((
                t::throttle_seconds.eq(throttle_seconds),
                t::updated_at.eq(DbDateTime::now()),
            ))
            .execute(conn)?)
        })
        .await?;
        if count == 0 {
            return Ok(None);
        }
        let mut props = agent_props();
        props.insert("trigger.id".to_string(), trigger_id.to_string());
        props.insert(
            "trigger.throttle_seconds".to_string(),
            throttle_seconds.to_string(),
        );
        track_event(
            "slack heartbeat trigger updated",
            Some(user_id),
            Some(props),
        );
        let id = trigger_id.to_string();
        crate::db::read(move |conn| {
            Ok(t::slack_heartbeat_triggers
                .filter(t::id.eq(&id))
                .select(SlackHeartbeatTrigger::as_select())
                .first(conn)
                .optional()?)
        })
        .await
    }

    /// Try to claim a trigger for firing.
    ///
    /// Read, check, then a compare-and-set update: the cooldown comparison
    /// ("lastTriggered + throttle <= now") is checked in code, and the update's
    /// predicate on the `lastTriggeredAt` read keeps a single claimer: if a
    /// concurrent writer claimed between the read and the update, no row
    /// changes and the claim reads as throttled. Emits
    /// `slack heartbeat trigger claimed` on a successful claim only.
    pub async fn try_claim_trigger(&self) -> anyhow::Result<ClaimResult> {
        let trigger: Option<SlackHeartbeatTrigger> = crate::db::read(move |conn| {
            Ok(t::slack_heartbeat_triggers
                .filter(t::is_active.eq(true))
                .select(SlackHeartbeatTrigger::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;

        let Some(trigger) = trigger else {
            return Ok(ClaimResult {
                claimed: false,
                remaining_seconds: Some(0),
            });
        };

        let now = Utc::now();
        let now_ms = now.timestamp_millis();
        let throttle_ms = trigger.throttle_seconds * 1000;
        if let Some(last) = trigger.last_triggered_at {
            let last_ms = last.timestamp_millis();
            if last_ms + throttle_ms > now_ms {
                let elapsed_ms = now_ms - last_ms;
                let remaining = ((throttle_ms - elapsed_ms) as f64 / 1000.0).ceil() as i64;
                return Ok(ClaimResult {
                    claimed: false,
                    remaining_seconds: Some(remaining.max(0)),
                });
            }
        }

        let id = trigger.id.clone();
        let previous = trigger.last_triggered_at;
        let count = crate::db::run(move |conn| {
            let target = t::slack_heartbeat_triggers
                .filter(t::id.eq(&id))
                .filter(t::is_active.eq(true));
            let values = (
                t::last_triggered_at.eq(Some(DbDateTime(now))),
                t::updated_at.eq(DbDateTime(now)),
            );
            let count = match previous {
                Some(previous) => diesel::update(
                    target.filter(t::last_triggered_at.eq(Some(DbDateTime(previous)))),
                )
                .set(values)
                .execute(conn)?,
                None => diesel::update(target.filter(t::last_triggered_at.is_null()))
                    .set(values)
                    .execute(conn)?,
            };
            Ok(count)
        })
        .await?;

        if count > 0 {
            // Only successful claims are tracked — failed attempts are throttle
            // noise proportional to channel traffic.
            let mut props = agent_props();
            props.insert("trigger.id".to_string(), trigger.id.clone());
            track_event("slack heartbeat trigger claimed", None, Some(props));
            return Ok(ClaimResult {
                claimed: true,
                remaining_seconds: None,
            });
        }

        Ok(ClaimResult {
            claimed: false,
            remaining_seconds: Some(trigger.throttle_seconds),
        })
    }

    /// Fast check used by the Slack adapter to see if a channel is a heartbeat trigger.
    pub async fn is_heartbeat_trigger_channel(
        &self,
        channel_id: &str,
    ) -> anyhow::Result<TriggerChannelCheck> {
        let channel_id = channel_id.to_string();
        let trigger: Option<SlackHeartbeatTrigger> = crate::db::read(move |conn| {
            Ok(t::slack_heartbeat_triggers
                .filter(t::slack_channel_id.eq(&channel_id))
                .filter(t::is_active.eq(true))
                .select(SlackHeartbeatTrigger::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;

        Ok(match trigger {
            None => TriggerChannelCheck {
                is_trigger: false,
                user_id: None,
                agent_id: None,
            },
            Some(trigger) => TriggerChannelCheck {
                is_trigger: true,
                user_id: Some(trigger.user_id),
                agent_id: Some(trigger.agent_id),
            },
        })
    }
}

impl Default for SlackHeartbeatTriggerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static SLACK_HEARTBEAT_TRIGGER_SERVICE: LazyLock<SlackHeartbeatTriggerService> =
    LazyLock::new(SlackHeartbeatTriggerService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testing::test_db;
    use crate::services::slack_mapping_service::testing::insert_agent;

    async fn insert_trigger(last_triggered_ms_ago: Option<i64>, throttle_seconds: i64) -> String {
        let mut row = NewSlackHeartbeatTrigger::new("T1", "C1", "agent-1", "owner");
        row.throttle_seconds = throttle_seconds;
        row.last_triggered_at =
            last_triggered_ms_ago.map(|ago| Utc::now() - chrono::Duration::milliseconds(ago));
        let id = row.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(t::slack_heartbeat_triggers)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_missing_trigger_claims_nothing() {
        let _db = test_db();
        let result = SlackHeartbeatTriggerService::new()
            .try_claim_trigger()
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::json!({ "claimed": false, "remainingSeconds": 0 })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn claims_once_then_reports_the_cooldown_left() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        insert_trigger(None, 60).await;
        let service = SlackHeartbeatTriggerService::new();
        let first = service.try_claim_trigger().await.unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::json!({ "claimed": true })
        );
        let second = service.try_claim_trigger().await.unwrap();
        assert!(!second.claimed);
        let remaining = second.remaining_seconds.unwrap();
        assert!((59..=60).contains(&remaining), "{remaining}");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn claims_again_after_the_cooldown() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        insert_trigger(Some(61_000), 60).await;
        let result = SlackHeartbeatTriggerService::new()
            .try_claim_trigger()
            .await
            .unwrap();
        assert!(result.claimed);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn checks_a_trigger_channel_and_scopes_updates_to_the_user() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        let id = insert_trigger(None, 60).await;
        let service = SlackHeartbeatTriggerService::new();
        let check = service.is_heartbeat_trigger_channel("C1").await.unwrap();
        assert_eq!(
            serde_json::to_value(&check).unwrap(),
            serde_json::json!({ "isTrigger": true, "userId": "owner", "agentId": "agent-1" })
        );
        assert_eq!(
            serde_json::to_value(service.is_heartbeat_trigger_channel("C2").await.unwrap())
                .unwrap(),
            serde_json::json!({ "isTrigger": false })
        );
        assert!(
            service
                .update_throttle(&id, "intruder", 5)
                .await
                .unwrap()
                .is_none()
        );
        let updated = service
            .update_throttle(&id, "owner", 5)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.throttle_seconds, 5);
        let listed = service.get_active_triggers("owner").await.unwrap();
        assert_eq!(listed[0].agent_workspace.name, "Agent");
        service.delete_trigger(&id, "owner").await.unwrap();
        assert!(
            service
                .get_active_triggers("owner")
                .await
                .unwrap()
                .is_empty()
        );
    }
}
