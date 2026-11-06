//! Delivery Target Service
//!
//! Delivers an autonomous message to the target its source was configured with:
//! every channel, web chat only, one channel's default destination, chosen
//! linked channels of a channel, or nowhere. Webhook subscriptions and scheduled
//! tasks each store a target.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::services::channel_adapter_interface::{CHAT_PLATFORMS, ChannelName, LinkedTarget};
use crate::types::ToolCallRecord;

/// Every delivery target: `all`, `chat`, each chat platform, then `none`.
pub static DELIVER_TARGETS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let mut targets = vec!["all", "chat"];
    targets.extend(CHAT_PLATFORMS.iter().map(|platform| platform.as_str()));
    targets.push("none");
    targets
});

/// One of `DELIVER_TARGETS`, as stored.
pub type DeliverTo = String;

/// Whether `value` is a string naming one of `DELIVER_TARGETS`.
pub fn is_valid_deliver_to(value: &Value) -> bool {
    value.as_str().is_some_and(is_valid_deliver_to_str)
}

/// Whether `value` names one of `DELIVER_TARGETS`.
pub fn is_valid_deliver_to_str(value: &str) -> bool {
    DELIVER_TARGETS.contains(&value)
}

/// Parse a stored comma-separated column; `None` or empty is an empty list.
pub fn parse_comma_list(value: Option<&str>) -> Vec<String> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Vec::new();
    };
    value
        .split(',')
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// Where a message goes: the target, and the linked channels chosen for it, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryTarget {
    pub deliver_to: String,
    pub channel_ids: Vec<String>,
}

/// Where an autonomous run may post: web chat, and the linked targets. A run
/// posts only what the agent sends, so this is the whole of its reach.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostingCeiling {
    pub web_chat: bool,
    pub targets: Vec<LinkedTarget>,
}

/// The channels a delivery to chosen channels posted to, and the unlinked ones it skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChosenChannels {
    pub channel: ChannelName,
    pub posted: i64,
    pub skipped: i64,
}

/// What a delivery stored: the message, or `None` for 'none'. A delivery to chosen
/// channels also counts the channels it posted to and the unlinked ones it
/// skipped.
#[derive(Debug, Clone)]
pub struct Delivery {
    pub message: Option<ConversationMessage>,
    pub chosen_channels: Option<ChosenChannels>,
}

/// The triggers of a message that a target delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TargetTrigger {
    Heartbeat,
    CronTask,
    Webhook,
}

impl TargetTrigger {
    /// The stored trigger of the message.
    pub fn message_trigger(self) -> MessageTrigger {
        match self {
            TargetTrigger::Heartbeat => MessageTrigger::Heartbeat,
            TargetTrigger::CronTask => MessageTrigger::CronTask,
            TargetTrigger::Webhook => MessageTrigger::Webhook,
        }
    }
}

/// The publish options a delivery to a target passes on.
#[derive(Debug, Clone, Default)]
pub struct TargetPublishOptions {
    /// The webhook subscription that produced a WEBHOOK message, for the model's history.
    pub trigger_name: Option<String>,
    pub tool_calls: Option<Vec<ToolCallRecord>>,
    pub attachment_ids: Option<Vec<String>>,
}

pub struct DeliveryTargetService;

impl DeliveryTargetService {
    pub fn new() -> Self {
        DeliveryTargetService
    }

    /// Deliver a message: to the chosen channels when the target's channel links
    /// channels and some are chosen, else per the target.
    pub async fn deliver(
        &self,
        agent_id: &str,
        user_id: &str,
        target: &DeliveryTarget,
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<Delivery> {
        todo!()
    }

    /// Where a run under this target may post with `send_message`: every linked
    /// target and web chat for 'all', web chat for 'chat', nothing for 'none', and
    /// for a platform its linked targets, or only the chosen channels when some are
    /// chosen. A platform with none of them linked gets web chat, as `deliver` does.
    pub async fn ceiling(
        &self,
        agent_id: &str,
        target: &DeliveryTarget,
    ) -> anyhow::Result<PostingCeiling> {
        todo!()
    }

    /// Read a channel list from a request, as the stored column value. The list
    /// belongs to a target whose channel links channels. Each id has to name a
    /// channel linked to the agent, or one the source already holds, so a channel
    /// unlinked after it was chosen does not block an unrelated edit. `null`
    /// clears the list. `Err` holds the message a refused list is answered with.
    pub async fn read_channel_ids(
        &self,
        raw: &Value,
        deliver_to: &str,
        agent_id: &str,
        stored: &[String],
    ) -> anyhow::Result<Result<Option<String>, String>> {
        todo!()
    }

    /// Deliver a message per the target, and return the stored message, or `None`
    /// for 'none':
    /// - 'all' — broadcast to every connected channel, in the latest thread.
    /// - 'chat' — scoped to web chat; stored in the web-visible latest thread.
    /// - a channel's name — scoped to that channel's default destination (the
    ///   direct conversation, else the main channel). Stored in the destination's
    ///   own thread, keyed by a non-null externalThreadId, so `list_threads` hides
    ///   it from web Recents + the CLI resume picker. Falls back to web chat only
    ///   + a warning when the channel has no destination.
    /// - 'none' — nothing is published or stored.
    async fn deliver_to_target(
        &self,
        agent_id: &str,
        user_id: &str,
        deliver_to: &str,
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<Option<ConversationMessage>> {
        todo!()
    }

    async fn deliver_to_chat(
        &self,
        agent_id: &str,
        user_id: &str,
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<ConversationMessage> {
        todo!()
    }

    /// Post to each chosen channel that is still linked to the agent, and return
    /// the first stored message. Each post is stored in its channel's own thread.
    /// A shared file belongs to one message, so files go with the first post
    /// only: a run that shares files and posts to several channels is rare.
    /// When no chosen channel is linked any more, the message goes to web chat
    /// only, because the list excludes every other destination on that platform.
    #[allow(clippy::too_many_arguments)]
    async fn deliver_to_chosen_channels(
        &self,
        agent_id: &str,
        user_id: &str,
        channel: ChannelName,
        linked: &HashSet<String>,
        chosen: &[String],
        content: &str,
        triggered_by: TargetTrigger,
        options: TargetPublishOptions,
    ) -> anyhow::Result<Delivery> {
        todo!()
    }
}

impl Default for DeliveryTargetService {
    fn default() -> Self {
        Self::new()
    }
}

pub static DELIVERY_TARGET_SERVICE: LazyLock<DeliveryTargetService> =
    LazyLock::new(DeliveryTargetService::new);
