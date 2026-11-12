//! Slack Message Queue Service
//!
//! Persists pending Slack messages for heartbeat triggers in the database.
//! Messages are enqueued when a Slack message arrives in a heartbeat trigger channel,
//! read by the heartbeat, which this queue is a trigger source of, and removed when
//! that heartbeat ends.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use diesel::prelude::*;

use crate::db::models::{NewPendingSlackMessage, PendingSlackMessage, SlackHeartbeatTrigger};
use crate::db::schema::pending_slack_messages::dsl as p;
use crate::db::schema::slack_heartbeat_triggers::dsl as t;
use crate::log_info;
use crate::services::channel_adapter_interface::ChatPlatform;
use crate::services::heartbeat_service::{HeartbeatTriggerSource, PendingTriggerMessages};
use crate::support::js::slice16;
use crate::types::{ChannelTriggerMessage, TriggerPlace};

pub struct SlackMessageQueueService;

impl SlackMessageQueueService {
    pub fn new() -> Self {
        SlackMessageQueueService
    }

    /// The channel's adapter name; reported as the heartbeat's trigger.
    pub const CHANNEL: ChatPlatform = ChatPlatform::Slack;

    /// How the prompt names the channel's platform.
    pub const PLATFORM: &'static str = "Slack";

    /// Queue `message` for the agent's next heartbeat.
    pub async fn enqueue(
        &self,
        agent_id: &str,
        message: &ChannelTriggerMessage,
    ) -> anyhow::Result<()> {
        log_info!(
            "[SlackMessageQueue] Enqueuing message for agent {} from sender {}",
            slice16(agent_id, 0, 8),
            message.sender
        );
        let row = NewPendingSlackMessage::new(
            agent_id,
            message.sender.clone(),
            message.text.clone(),
            message.timestamp.clone(),
        );
        crate::db::run(move |conn| {
            diesel::insert_into(p::pending_slack_messages)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// Every message queued for `agent_id`, oldest first, with the trigger
    /// channel as the place when the agent has one. They stay queued until
    /// `remove`.
    pub async fn pending(&self, agent_id: &str) -> anyhow::Result<PendingTriggerMessages> {
        let agent = agent_id.to_string();
        let rows: Vec<PendingSlackMessage> = crate::db::read(move |conn| {
            Ok(p::pending_slack_messages
                .filter(p::agent_id.eq(&agent))
                .order(p::created_at.asc())
                .select(PendingSlackMessage::as_select())
                .load(conn)?)
        })
        .await?;
        if !rows.is_empty() {
            log_info!(
                "[SlackMessageQueue] {} message(s) pending for agent {}",
                rows.len(),
                slice16(agent_id, 0, 8)
            );
        }
        // An agent has one trigger channel, and every queued message came from it.
        let trigger = if rows.is_empty() {
            None
        } else {
            let agent = agent_id.to_string();
            crate::db::read(move |conn| {
                Ok(t::slack_heartbeat_triggers
                    .filter(t::agent_id.eq(&agent))
                    .select(SlackHeartbeatTrigger::as_select())
                    .first(conn)
                    .optional()?)
            })
            .await?
        };
        Ok(PendingTriggerMessages {
            ids: rows.iter().map(|row| row.id.clone()).collect(),
            messages: rows
                .into_iter()
                .map(|row| ChannelTriggerMessage {
                    sender: row.sender,
                    text: row.text,
                    timestamp: row.timestamp,
                })
                .collect(),
            place: trigger.map(|trigger| TriggerPlace {
                target: format!("slack:{}", trigger.slack_channel_id),
                name: format!(
                    "#{}",
                    trigger
                        .slack_channel_name
                        .unwrap_or_else(|| trigger.slack_channel_id.clone())
                ),
            }),
        })
    }

    /// Forget the messages a run answered. An empty list does nothing.
    pub async fn remove(&self, ids: &[String]) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let ids = ids.to_vec();
        crate::db::run(move |conn| {
            diesel::delete(p::pending_slack_messages.filter(p::id.eq_any(&ids))).execute(conn)?;
            Ok(())
        })
        .await
    }
}

impl Default for SlackMessageQueueService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HeartbeatTriggerSource for SlackMessageQueueService {
    fn channel(&self) -> ChatPlatform {
        Self::CHANNEL
    }

    fn platform(&self) -> &str {
        Self::PLATFORM
    }

    async fn pending(&self, agent_id: &str) -> anyhow::Result<PendingTriggerMessages> {
        SlackMessageQueueService::pending(self, agent_id).await
    }

    async fn remove(&self, ids: &[String]) -> anyhow::Result<()> {
        SlackMessageQueueService::remove(self, ids).await
    }
}

/// The queue, shared: boot registers it with the heartbeat, and the Slack
/// adapter and routes start the heartbeat from it.
pub static SLACK_MESSAGE_QUEUE_SERVICE: LazyLock<Arc<SlackMessageQueueService>> =
    LazyLock::new(|| Arc::new(SlackMessageQueueService::new()));

/// The queue as the heartbeat reads it.
pub fn slack_trigger_source() -> Arc<dyn HeartbeatTriggerSource> {
    SLACK_MESSAGE_QUEUE_SERVICE.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewSlackHeartbeatTrigger;
    use crate::db::testing::test_db;
    use crate::services::slack_mapping_service::testing::insert_agent;

    fn message(sender: &str, text: &str) -> ChannelTriggerMessage {
        ChannelTriggerMessage {
            sender: sender.into(),
            text: text.into(),
            timestamp: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn holds_messages_oldest_first_until_removed() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        let queue = SlackMessageQueueService::new();
        queue
            .enqueue("agent-1", &message("Ann", "one"))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        queue
            .enqueue("agent-1", &message("Bob", "two"))
            .await
            .unwrap();

        let pending = queue.pending("agent-1").await.unwrap();
        assert_eq!(
            pending
                .messages
                .iter()
                .map(|m| m.text.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert!(pending.place.is_none());

        queue.remove(&pending.ids[..1]).await.unwrap();
        let left = queue.pending("agent-1").await.unwrap();
        assert_eq!(left.messages.len(), 1);
        assert_eq!(left.messages[0].sender, "Bob");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn names_the_trigger_channel_as_the_place() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        let mut trigger = NewSlackHeartbeatTrigger::new("T1", "C9", "agent-1", "owner");
        trigger.slack_channel_name = Some("alerts".into());
        crate::db::run(move |conn| {
            diesel::insert_into(t::slack_heartbeat_triggers)
                .values(&trigger)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        let queue = SlackMessageQueueService::new();
        queue
            .enqueue("agent-1", &message("Ann", "one"))
            .await
            .unwrap();
        let place = queue.pending("agent-1").await.unwrap().place.unwrap();
        assert_eq!(place.target, "slack:C9");
        assert_eq!(place.name, "#alerts");
    }
}
