//! Channel Adapter Interface
//!
//! Defines the contract for message delivery channels. All adapters implement
//! this trait to enable unified message delivery across multiple channels
//! through the `MessageDeliveryService`. Shared code asks a channel for a
//! per-channel answer through the optional members here and never names the
//! channel itself.

use std::fmt;
use std::sync::LazyLock;

use async_trait::async_trait;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::db::models::ConversationMessage;
use crate::services::attachment_service::WithAttachments;
use crate::types::ResumedReply;

/// The chat platforms the runtime joins through their own apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatPlatform {
    Slack,
    Teams,
}

/// The chat platforms the runtime joins through their own apps, in order.
pub const CHAT_PLATFORMS: [ChatPlatform; 2] = [ChatPlatform::Slack, ChatPlatform::Teams];

impl ChatPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatPlatform::Slack => "slack",
            ChatPlatform::Teams => "teams",
        }
    }

    /// The platform a stored or received name names, or `None` for any other text.
    pub fn parse(value: &str) -> Option<ChatPlatform> {
        CHAT_PLATFORMS
            .into_iter()
            .find(|platform| platform.as_str() == value)
    }
}

impl fmt::Display for ChatPlatform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Every channel: the runtime's own chat socket and each chat platform. One adapter each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelName {
    Websocket,
    Slack,
    Teams,
}

impl ChannelName {
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelName::Websocket => "websocket",
            ChannelName::Slack => "slack",
            ChannelName::Teams => "teams",
        }
    }

    /// The channel a stored or received name names, or `None` for any other text.
    pub fn parse(value: &str) -> Option<ChannelName> {
        match value {
            "websocket" => Some(ChannelName::Websocket),
            other => ChatPlatform::parse(other).map(ChannelName::from),
        }
    }

    /// The chat platform this channel is, or `None` for the runtime's own chat socket.
    pub fn chat_platform(self) -> Option<ChatPlatform> {
        match self {
            ChannelName::Websocket => None,
            ChannelName::Slack => Some(ChatPlatform::Slack),
            ChannelName::Teams => Some(ChatPlatform::Teams),
        }
    }
}

impl From<ChatPlatform> for ChannelName {
    fn from(platform: ChatPlatform) -> Self {
        match platform {
            ChatPlatform::Slack => ChannelName::Slack,
            ChatPlatform::Teams => ChannelName::Teams,
        }
    }
}

impl fmt::Display for ChannelName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Whether `value` names one of the chat platforms.
pub fn is_chat_platform(value: &str) -> bool {
    ChatPlatform::parse(value).is_some()
}

/// A persisted message plus the (no-bytes) metadata of any files the agent
/// shared with it. Each adapter renders these its own way.
pub type DeliverableMessage = WithAttachments<ConversationMessage>;

/// Channel context for routing responses back to the originating channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelContext {
    /// The `name` of the adapter that delivers the message.
    pub channel: ChannelName,
    /// The conversation inside the channel. Unset, the adapter picks the user's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// The channel's own thread to reply in. Unset, the reply posts top-level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_thread_id: Option<String>,
    /// Internal database thread ID.
    pub thread_id: String,
    /// When true, adapters that support interactive feedback render 👍/👎
    /// buttons alongside this message. Caller gates (terminal/length/cadence).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_feedback: Option<bool>,
}

/// Where a message goes inside a channel.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDestination {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_thread_id: Option<String>,
    /// The conversation a continuing turn posts in, as its system prompt names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_label: Option<String>,
}

/// The conversation a message addressed to a channel as a whole goes to, and
/// the key of the stored thread that holds such messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultDestination {
    #[serde(flatten)]
    pub destination: ChannelDestination,
    pub thread_key: String,
}

/// Whether a linked target is a shared channel or a direct conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkedTargetKind {
    Channel,
    Dm,
}

impl LinkedTargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkedTargetKind::Channel => "channel",
            LinkedTargetKind::Dm => "dm",
        }
    }
}

/// A conversation linked to the agent that the agent may post into on its own
/// initiative: a linked channel, or a linked DM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedTarget {
    /// `<platform>:<conversation id>`, the name the agent sends to.
    pub key: String,
    /// The `name` of the adapter that lists and posts to it.
    pub platform: ChatPlatform,
    pub kind: LinkedTargetKind,
    pub conversation_id: String,
    pub name: Option<String>,
    pub is_main: bool,
    /// For a DM, the user it is linked to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dm_user_id: Option<String>,
}

/// The `send_message` target that posts into web chat, for a run whose delivery setting allows it.
pub const WEB_CHAT_TARGET: &str = "chat";
pub const WEB_CHAT_NAME: &str = "Web chat";

/// The stored thread a reply to a posted message continues.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedHistory {
    pub user_id: String,
    pub thread_key: String,
}

/// A message `post_to_target` posted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedMessage {
    pub message_id: String,
    /// The stored thread a reply to the message continues: the user it belongs
    /// to and the key the channel's inbound path gives it. Set when that thread is
    /// read from the database, so the message has to be stored there to be seen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<PostedHistory>,
}

/// A send the runtime refuses. The message is the reason the agent reads, so it
/// names the rule and, for a mention, the person.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SendRefusedError {
    pub message: String,
    /// Telemetry-safe reason code.
    pub code: String,
}

/// The `name` and `code` a logged or model-read `SendRefusedError` shows.
fn send_refused_fields(
    err: &(dyn std::error::Error + 'static),
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let refused = err.downcast_ref::<SendRefusedError>()?;
    let mut fields = serde_json::Map::new();
    fields.insert("name".into(), "SendRefusedError".into());
    fields.insert("code".into(), refused.code.clone().into());
    Some(fields)
}

static REGISTER_SEND_REFUSED: std::sync::Once = std::sync::Once::new();

impl SendRefusedError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        REGISTER_SEND_REFUSED
            .call_once(|| crate::lib::log_redaction::register_error_fields(send_refused_fields));
        Self {
            message: message.into(),
            code: code.into(),
        }
    }
}

/// The `<@ID>` and `<@ID:Name>` mention tokens the agent writes. Use it with
/// `captures_iter` and `replace_all`.
pub static MENTION_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@([^>:]*)(?::([^>]*))?>").expect("valid mention pattern"));

/// How a refusal names a target to the agent.
pub fn describe_target(target: &LinkedTarget) -> String {
    if target.kind == LinkedTargetKind::Dm {
        return match &target.name {
            Some(name) if !name.is_empty() => format!("the DM with {name}"),
            _ => "the DM".to_string(),
        };
    }
    match &target.name {
        Some(name) if !name.is_empty() => format!("#{name}"),
        _ => target.key.clone(),
    }
}

/// The contract of a message delivery channel.
///
/// Each channel adapter is responsible for:
/// - Delivering messages to users via its specific protocol
/// - Tracking user connection status
/// - Handling initialization and shutdown
///
/// An optional member is a provided method: a boolean answers `false`, and
/// any other answers `None`, which means the channel lacks the member.
#[async_trait]
pub trait ChannelAdapter: Send + Sync {
    /// Channel identifier, matched against `ChannelContext::channel`.
    fn name(&self) -> ChannelName;

    /// True when the channel shows the whole conversation — the person's own
    /// messages and messages changed after they were published — rather than only
    /// the agent's replies. Such a channel is handed those through
    /// `MESSAGE_DELIVERY_SERVICE.show_in_conversation`, and replaces a message it
    /// has seen before.
    fn shows_whole_conversation(&self) -> bool {
        false
    }

    /// True when the channel opens a link relative to the web UI, so a message
    /// can link a page of it even when the agent has no public address.
    fn opens_web_ui_links(&self) -> bool {
        false
    }

    /// Where an autonomous message continues a stored thread that started in this
    /// channel: a scheduled task or a goal that resumes the conversation, or a
    /// computer help request. `origin_channel_id` is the conversation the thread
    /// recorded when it began, when it recorded one. A resolved conversation
    /// gets a `channel_label` that names it by its id, which puts the channel
    /// guidelines in the prompt of a turn that continues the thread.
    async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> Option<anyhow::Result<ChannelDestination>> {
        None
    }

    /// The conversation a message addressed to this channel as a whole goes to:
    /// the user's direct conversation, else the agent's main channel. `thread_key`
    /// keys the stored thread that holds such messages. `Ok(None)` when the user
    /// has linked neither.
    async fn default_destination(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> Option<anyhow::Result<Option<DefaultDestination>>> {
        None
    }

    /// Continue a reply a restart interrupted, for a channel that answers its
    /// messages in a queue of its own. `message` is the newest message the reply
    /// owes an answer. A channel without it starts the reply's turn at once.
    /// `Some(())` when the channel took the reply.
    fn continue_reply(&self, message: &ConversationMessage, resumed: &ResumedReply) -> Option<()> {
        None
    }

    /// Answer a message the runtime stored in one of this channel's conversations,
    /// such as a task notification, for a channel that answers its messages in a
    /// queue of its own. A channel without it starts the answer's turn at once.
    /// `Some(())` when the channel took the message.
    fn answer_stored(&self, message: &ConversationMessage) -> Option<()> {
        None
    }

    /// The ids of the agent's linked shared channels, which a webhook or a
    /// scheduled task can choose to post to.
    async fn linked_channel_ids(&self, agent_id: &str) -> Option<anyhow::Result<Vec<String>>> {
        None
    }

    /// Deliver a message to a user via this channel.
    ///
    /// Should be idempotent and handle errors gracefully. If the user is not
    /// connected or delivery fails, the adapter should log the error but not
    /// fail (the message is already persisted in DB).
    ///
    /// `user_id` is the Lens Platform user ID; `message` is the message to
    /// deliver (already persisted in DB), with optional shared-file metadata in
    /// `attachments`; `channel_context` routes it to a specific channel/thread.
    async fn deliver(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) -> anyhow::Result<()>;

    /// Check if user has an active connection on this channel: true if the user
    /// can receive messages on this channel.
    async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool>;

    /// The platform's name as the agent reads it in a message, for example in a
    /// failed send. An adapter that posts to targets sets it.
    fn display_name(&self) -> Option<&str> {
        None
    }

    /// The agent's linked channels and DMs on this platform.
    async fn list_linked_targets(
        &self,
        agent_id: &str,
    ) -> Option<anyhow::Result<Vec<LinkedTarget>>> {
        None
    }

    /// Post agent-written text into a linked target, in the reply chain rooted at
    /// `thread` when given. Every `<@ID>` token must name a member of the target,
    /// and becomes a mention that notifies. Fails with `SendRefusedError` for a
    /// send the platform rules refuse, and the platform's error when the post
    /// fails. Returns the id of the posted message, and `history` when the
    /// conversation's history is read from the database rather than from the
    /// platform.
    async fn post_to_target(
        &self,
        target: &LinkedTarget,
        text: &str,
        thread: Option<&str>,
    ) -> Option<anyhow::Result<PostedMessage>> {
        None
    }

    /// Initialize the channel adapter.
    ///
    /// Called once on server startup. Adapters should:
    /// - Set up any persistent connections
    /// - Load existing connection state from database
    /// - Register event handlers
    async fn initialize(&self) -> anyhow::Result<()>;

    /// Shutdown the channel adapter.
    ///
    /// Called on SIGTERM/SIGINT. Adapters should:
    /// - Close all connections gracefully
    /// - Clean up any resources
    async fn shutdown(&self) -> anyhow::Result<()>;
}
