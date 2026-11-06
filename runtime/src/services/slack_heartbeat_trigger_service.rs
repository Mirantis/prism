//! Slack Heartbeat Trigger Service
//!
//! CRUD service for per-agent Slack heartbeat trigger config.
//! Each agent can have at most one trigger. When configured, messages
//! in the designated Slack channel trigger the agent's heartbeat.
//!
//! Includes throttle logic: an atomic compare-and-set claim prevents
//! race conditions across multiple instances.

use std::sync::LazyLock;

use diesel::SqliteConnection;
use serde::{Deserialize, Serialize};

use crate::db::models::SlackHeartbeatTrigger;

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
        todo!()
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
        todo!()
    }

    /// Remove a specific trigger by ID, scoped to the user. Emits
    /// `slack heartbeat trigger deleted` when a row was removed.
    pub async fn delete_trigger(&self, trigger_id: &str, user_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Delete all triggers for a given connection. Used when a SlackConnection
    /// is removed — no FK cascade exists because SlackConnection lives outside
    /// this database.
    pub async fn delete_by_connection_id(&self, connection_id: &str) -> anyhow::Result<i64> {
        todo!()
    }

    /// `delete_by_connection_id` inside a caller's transaction, so the caller can
    /// batch it with other deletes for all-or-nothing semantics.
    pub fn delete_by_connection_id_in(
        &self,
        conn: &mut SqliteConnection,
        connection_id: &str,
    ) -> anyhow::Result<i64> {
        todo!()
    }

    /// Update throttle settings for a trigger. `None` when the user has no such
    /// trigger. Emits `slack heartbeat trigger updated`.
    pub async fn update_throttle(
        &self,
        trigger_id: &str,
        user_id: &str,
        throttle_seconds: i64,
    ) -> anyhow::Result<Option<SlackHeartbeatTrigger>> {
        todo!()
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
        todo!()
    }

    /// Fast check used by the Slack adapter to see if a channel is a heartbeat trigger.
    pub async fn is_heartbeat_trigger_channel(
        &self,
        channel_id: &str,
    ) -> anyhow::Result<TriggerChannelCheck> {
        todo!()
    }
}

impl Default for SlackHeartbeatTriggerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static SLACK_HEARTBEAT_TRIGGER_SERVICE: LazyLock<SlackHeartbeatTriggerService> =
    LazyLock::new(SlackHeartbeatTriggerService::new);
