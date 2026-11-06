//! Agent Status Service
//!
//! Writes agent fields directly to the database, eliminating HTTP round-trips
//! to the backend for simple field updates (heartbeat timestamp, status).

use std::collections::HashMap;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::{AgentStatus, AgentWorkspaceChangeset};
use crate::types::AgentHeartbeatStatus;

/// The heartbeat schedule to persist. `last_heartbeat` is set only by a recorded cycle.
#[derive(Debug, Clone, PartialEq)]
pub struct HeartbeatScheduleUpdate {
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub next_heartbeat_at: DateTime<Utc>,
}

/// Where a heartbeat run may post: a `DELIVER_TARGETS` value and the chosen linked channels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDelivery {
    pub deliver_to: String,
    pub channel_ids: Vec<String>,
}

/// A change to where a heartbeat run may post, as a request gives it. A field
/// left `None` was absent; `Some(Value::Null)` was given as null.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeartbeatDeliveryChanges {
    pub deliver_to: Option<Value>,
    pub channel_ids: Option<Value>,
}

pub struct AgentStatusService {
    active_processing_count: Mutex<HashMap<String, i64>>,
}

impl AgentStatusService {
    pub fn new() -> Self {
        Self {
            active_processing_count: Mutex::new(HashMap::new()),
        }
    }

    /// Mark an agent as processing. Sets status to RUNNING in DB on first concurrent task.
    /// Must be paired with `set_done_processing()` on every exit path.
    pub async fn set_processing(&self, agent_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Mark an agent as done processing. Sets status to IDLE in DB when all concurrent tasks finish.
    pub async fn set_done_processing(&self, agent_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Whether any invoke-loop turn (chat, heartbeat, cron, goal) is in flight.
    /// Counts what `set_processing`/`set_done_processing` bracket — the auxiliary model
    /// calls (classification gates, thread titles) are not tracked here; they
    /// are sub-second, fail-open calls whose loss on a restart is harmless.
    pub fn is_busy(&self) -> bool {
        self.active_processing_count
            .lock()
            .values()
            .any(|count| *count > 0)
    }

    pub async fn update_agent_by_id(
        &self,
        agent_id: &str,
        data: AgentWorkspaceChangeset,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Persist the heartbeat schedule. `next_heartbeat_at` is the deadline the next
    /// process arms, and `last_heartbeat` the check that really ran — passed only by
    /// a recorded cycle, so a cadence change moves the deadline without reporting a
    /// heartbeat. Both columns move in one write, so no boot can read one of them
    /// from an older event than the other.
    pub async fn update_heartbeat_schedule(
        &self,
        schedule: HeartbeatScheduleUpdate,
    ) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn update_agent_heartbeat_status(
        &self,
        heartbeat_status: AgentHeartbeatStatus,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Where a heartbeat run may post: a `DELIVER_TARGETS` value and the chosen linked channels.
    pub async fn get_heartbeat_delivery(&self) -> anyhow::Result<HeartbeatDelivery> {
        todo!()
    }

    /// Change where a heartbeat run may post. A channel list is kept only for the
    /// target it was chosen for; the next run reads the new setting. `Err` holds
    /// the message a refused change is answered with.
    pub async fn update_heartbeat_delivery(
        &self,
        changes: HeartbeatDeliveryChanges,
    ) -> anyhow::Result<Result<HeartbeatDelivery, String>> {
        todo!()
    }

    pub async fn update_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for AgentStatusService {
    fn default() -> Self {
        Self::new()
    }
}

pub static AGENT_STATUS_SERVICE: LazyLock<AgentStatusService> =
    LazyLock::new(AgentStatusService::new);
