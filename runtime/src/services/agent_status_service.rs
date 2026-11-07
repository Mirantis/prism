//! Agent Status Service
//!
//! Writes agent fields directly to the database, eliminating HTTP round-trips
//! to the backend for simple field updates (heartbeat timestamp, status).

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::{AgentStatus, AgentWorkspace, AgentWorkspaceChangeset};
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::services::delivery_target_service::{
    DELIVER_TARGETS, DELIVERY_TARGET_SERVICE, is_valid_deliver_to, parse_comma_list,
};
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

/// The one agent row, as `findFirstOrThrow()` reads it.
pub(crate) fn first_agent(conn: &mut SqliteConnection) -> anyhow::Result<AgentWorkspace> {
    aw::agent_workspaces
        .select(AgentWorkspace::as_select())
        .first(conn)
        .optional()?
        .ok_or_else(|| anyhow!("No AgentWorkspace found"))
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
        let count = {
            let mut counts = self.active_processing_count.lock();
            let count = counts.get(agent_id).copied().unwrap_or(0) + 1;
            counts.insert(agent_id.to_string(), count);
            count
        };
        if count == 1 {
            self.update_agent_status(agent_id, AgentStatus::Running)
                .await?;
        }
        Ok(())
    }

    /// Mark an agent as done processing. Sets status to IDLE in DB when all concurrent tasks finish.
    pub async fn set_done_processing(&self, agent_id: &str) -> anyhow::Result<()> {
        let count = {
            let mut counts = self.active_processing_count.lock();
            let count = (counts.get(agent_id).copied().unwrap_or(1) - 1).max(0);
            counts.insert(agent_id.to_string(), count);
            count
        };
        if count == 0 {
            self.update_agent_status(agent_id, AgentStatus::Idle)
                .await?;
        }
        Ok(())
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

    /// Update one agent row. Fails when no row has the id.
    pub async fn update_agent_by_id(
        &self,
        agent_id: &str,
        data: AgentWorkspaceChangeset,
    ) -> anyhow::Result<()> {
        let agent_id = agent_id.to_string();
        crate::db::run(move |conn| {
            let updated = diesel::update(aw::agent_workspaces.filter(aw::id.eq(&agent_id)))
                .set(&data)
                .execute(conn)?;
            if updated == 0 {
                return Err(anyhow!("Record to update not found."));
            }
            Ok(())
        })
        .await
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
        let agent = crate::db::run(first_agent).await?;
        self.update_agent_by_id(
            &agent.id,
            AgentWorkspaceChangeset {
                next_heartbeat_at: Some(Some(schedule.next_heartbeat_at)),
                last_heartbeat: schedule.last_heartbeat.map(Some),
                ..AgentWorkspaceChangeset::default()
            },
        )
        .await
    }

    pub async fn update_agent_heartbeat_status(
        &self,
        heartbeat_status: AgentHeartbeatStatus,
    ) -> anyhow::Result<()> {
        let agent = crate::db::run(first_agent).await?;
        self.update_agent_by_id(
            &agent.id,
            AgentWorkspaceChangeset {
                heartbeat_status: Some(heartbeat_status),
                ..AgentWorkspaceChangeset::default()
            },
        )
        .await
    }

    /// Where a heartbeat run may post: a `DELIVER_TARGETS` value and the chosen linked channels.
    pub async fn get_heartbeat_delivery(&self) -> anyhow::Result<HeartbeatDelivery> {
        let agent = crate::db::run(first_agent).await?;
        Ok(HeartbeatDelivery {
            deliver_to: agent.heartbeat_deliver_to,
            channel_ids: parse_comma_list(agent.heartbeat_channel_ids.as_deref()),
        })
    }

    /// Change where a heartbeat run may post. A channel list is kept only for the
    /// target it was chosen for; the next run reads the new setting. `Err` holds
    /// the message a refused change is answered with.
    pub async fn update_heartbeat_delivery(
        &self,
        changes: HeartbeatDeliveryChanges,
    ) -> anyhow::Result<Result<HeartbeatDelivery, String>> {
        let agent = crate::db::run(first_agent).await?;
        let deliver_to = match &changes.deliver_to {
            Some(value) if !value.is_null() => value.clone(),
            _ => Value::String(agent.heartbeat_deliver_to.clone()),
        };
        if !is_valid_deliver_to(&deliver_to) {
            return Ok(Err(format!(
                "deliverTo must be one of: {}",
                DELIVER_TARGETS.join(", ")
            )));
        }
        let deliver_to = deliver_to.as_str().unwrap_or_default().to_string();
        let mut channel_ids = if deliver_to == agent.heartbeat_deliver_to {
            agent.heartbeat_channel_ids.clone()
        } else {
            None
        };
        if let Some(raw) = &changes.channel_ids {
            let read = DELIVERY_TARGET_SERVICE
                .read_channel_ids(
                    raw,
                    &deliver_to,
                    &agent.id,
                    &parse_comma_list(agent.heartbeat_channel_ids.as_deref()),
                )
                .await?;
            match read {
                Ok(value) => channel_ids = value,
                Err(error) => return Ok(Err(error)),
            }
        }
        self.update_agent_by_id(
            &agent.id,
            AgentWorkspaceChangeset {
                heartbeat_deliver_to: Some(deliver_to.clone()),
                heartbeat_channel_ids: Some(channel_ids.clone()),
                ..AgentWorkspaceChangeset::default()
            },
        )
        .await?;
        Ok(Ok(HeartbeatDelivery {
            deliver_to,
            channel_ids: parse_comma_list(channel_ids.as_deref()),
        }))
    }

    pub async fn update_agent_status(
        &self,
        agent_id: &str,
        status: AgentStatus,
    ) -> anyhow::Result<()> {
        self.update_agent_by_id(
            agent_id,
            AgentWorkspaceChangeset {
                status: Some(status),
                ..AgentWorkspaceChangeset::default()
            },
        )
        .await
    }
}

impl Default for AgentStatusService {
    fn default() -> Self {
        Self::new()
    }
}

pub static AGENT_STATUS_SERVICE: LazyLock<AgentStatusService> =
    LazyLock::new(AgentStatusService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;

    async fn insert_agent() -> String {
        let agent = NewAgentWorkspace::new("user-1", "soul", "user", "memory", "heartbeat", "");
        let id = agent.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(aw::agent_workspaces)
                .values(&agent)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        id
    }

    async fn agent() -> AgentWorkspace {
        crate::db::run(first_agent).await.unwrap()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn marks_the_agent_running_on_the_first_turn_and_idle_after_the_last() {
        let _db = crate::db::testing::test_db();
        let id = insert_agent().await;
        let service = AgentStatusService::new();

        service.set_processing(&id).await.unwrap();
        service.set_processing(&id).await.unwrap();
        assert!(service.is_busy());
        assert_eq!(agent().await.status, AgentStatus::Running);

        service.set_done_processing(&id).await.unwrap();
        assert_eq!(agent().await.status, AgentStatus::Running);
        service.set_done_processing(&id).await.unwrap();
        assert!(!service.is_busy());
        assert_eq!(agent().await.status, AgentStatus::Idle);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_the_deadline_alone_unless_a_cycle_ran() {
        let _db = crate::db::testing::test_db();
        insert_agent().await;
        let service = AgentStatusService::new();
        let due = crate::support::from_ms(1_800_000_000_000);

        service
            .update_heartbeat_schedule(HeartbeatScheduleUpdate {
                last_heartbeat: None,
                next_heartbeat_at: due,
            })
            .await
            .unwrap();
        let row = agent().await;
        assert_eq!(row.next_heartbeat_at, Some(due));
        assert_eq!(row.last_heartbeat, None);

        let ran = crate::support::from_ms(1_799_000_000_000);
        service
            .update_heartbeat_schedule(HeartbeatScheduleUpdate {
                last_heartbeat: Some(ran),
                next_heartbeat_at: due,
            })
            .await
            .unwrap();
        assert_eq!(agent().await.last_heartbeat, Some(ran));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_delivery_target_that_is_not_one() {
        let _db = crate::db::testing::test_db();
        insert_agent().await;
        let refused = AGENT_STATUS_SERVICE
            .update_heartbeat_delivery(HeartbeatDeliveryChanges {
                deliver_to: Some(Value::String("pigeon".into())),
                channel_ids: None,
            })
            .await
            .unwrap();
        assert_eq!(
            refused,
            Err(format!(
                "deliverTo must be one of: {}",
                DELIVER_TARGETS.join(", ")
            ))
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn drops_the_chosen_channels_when_the_target_changes() {
        let _db = crate::db::testing::test_db();
        let id = insert_agent().await;
        AGENT_STATUS_SERVICE
            .update_agent_by_id(
                &id,
                AgentWorkspaceChangeset {
                    heartbeat_deliver_to: Some("slack".into()),
                    heartbeat_channel_ids: Some(Some("C1,C2".into())),
                    ..AgentWorkspaceChangeset::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            AGENT_STATUS_SERVICE.get_heartbeat_delivery().await.unwrap(),
            HeartbeatDelivery {
                deliver_to: "slack".into(),
                channel_ids: vec!["C1".into(), "C2".into()],
            }
        );

        let changed = AGENT_STATUS_SERVICE
            .update_heartbeat_delivery(HeartbeatDeliveryChanges {
                deliver_to: Some(Value::String("chat".into())),
                channel_ids: None,
            })
            .await
            .unwrap();
        assert_eq!(
            changed,
            Ok(HeartbeatDelivery {
                deliver_to: "chat".into(),
                channel_ids: vec![],
            })
        );
        assert_eq!(agent().await.heartbeat_channel_ids, None);
    }
}
