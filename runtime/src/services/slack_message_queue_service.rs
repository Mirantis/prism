//! Slack Message Queue Service
//!
//! Persists pending Slack messages for heartbeat triggers in the database.
//! Messages are enqueued when a Slack message arrives in a heartbeat trigger channel,
//! read by the heartbeat, which this queue is a trigger source of, and removed when
//! that heartbeat ends.

use std::sync::LazyLock;

use async_trait::async_trait;

use crate::services::channel_adapter_interface::ChatPlatform;
use crate::services::heartbeat_service::{HeartbeatTriggerSource, PendingTriggerMessages};
use crate::types::ChannelTriggerMessage;

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
        todo!()
    }

    /// Every message queued for `agent_id`, oldest first, with the trigger
    /// channel as the place when the agent has one. They stay queued until
    /// `remove`.
    pub async fn pending(&self, agent_id: &str) -> anyhow::Result<PendingTriggerMessages> {
        todo!()
    }

    /// Forget the messages a run answered. An empty list does nothing.
    pub async fn remove(&self, ids: &[String]) -> anyhow::Result<()> {
        todo!()
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

pub static SLACK_MESSAGE_QUEUE_SERVICE: LazyLock<SlackMessageQueueService> =
    LazyLock::new(SlackMessageQueueService::new);
