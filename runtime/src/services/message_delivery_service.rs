//! Message Delivery Service
//!
//! Unified entry point for all agent messages. Provides a single `publish()` function
//! that handles both persistence (storing in DB) and delivery (sending to all channels).
//!
//! Key design principles:
//! - All agent messages go through `publish()` - one function for store + deliver
//! - Callers don't need to know about channels or database details
//! - Adding new channels requires zero changes to calling code
//! - Consistent logging and error handling across all channels

use std::sync::{Arc, LazyLock};

use parking_lot::RwLock;
use tokio::sync::broadcast;

use crate::db::models::ConversationMessage;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, DeliverableMessage,
};
use crate::types::ToolCallRecord;

// ============================================================================
// Types
// ============================================================================

/// What triggered this message. The stored enum; `SYSTEM` is one of its values
/// that nothing produces, so [`MESSAGE_TRIGGERS`] lists the ones an incoming
/// trigger is validated against.
pub use crate::db::models::MessageTrigger;

/// The triggers a message can have. An incoming trigger is validated against
/// this list rather than the stored enum, which still declares `SYSTEM`.
pub const MESSAGE_TRIGGERS: [MessageTrigger; 6] = [
    MessageTrigger::UserInput,
    MessageTrigger::Heartbeat,
    MessageTrigger::CronTask,
    MessageTrigger::Goal,
    MessageTrigger::Webhook,
    MessageTrigger::AgentMessage,
];

/// Options for publishing a message
#[derive(Debug, Clone, Default)]
pub struct PublishOptions {
    /// The webhook subscription that produced a WEBHOOK message, for the model's history.
    pub trigger_name: Option<String>,
    /// Tool calls made during message generation
    pub tool_calls: Option<Vec<ToolCallRecord>>,
    /// UI blocks for rich rendering
    pub blocks: Option<Vec<serde_json::Value>>,
    /// Ids of files the agent shared (via share_file) to deliver with this
    /// message. They're linked to the stored message and rendered/uploaded by
    /// each channel adapter. Already-linked or forged ids are ignored at link
    /// time (the attachment service caps and only claims unlinked rows).
    pub attachment_ids: Option<Vec<String>>,
    /// Per-message context: routing (channel/channelId/channelThreadId) + rendering
    /// hints (e.g. `include_feedback`). The caller (conversation engine for
    /// user turns; heartbeat/cron leave it unset) is the single owner of
    /// this object — `publish` just forwards it.
    pub channel_context: Option<ChannelContext>,
}

/// The delivery context for an autonomous message that continues a thread, with
/// the label of the destination the channel's adapter reconstructed
/// (`ChannelContext & ChannelDestination`).
#[derive(Debug, Clone)]
pub struct ThreadContext {
    /// The channel, the thread, and the destination's `channel_id` and
    /// `channel_thread_id`.
    pub context: ChannelContext,
    /// The conversation a continuing turn posts in, as its system prompt names it.
    pub channel_label: Option<String>,
}

/// Result of delivery to a single adapter
#[derive(Debug, Clone)]
struct DeliveryResult {
    adapter: String,
    delivered: bool,
    reason: Option<String>,
}

// ============================================================================
// Message Delivery Service
// ============================================================================

pub struct MessageDeliveryService {
    /// Sends each agent message once it is stored and delivered (`published`).
    pub published: broadcast::Sender<ConversationMessage>,
    adapters: RwLock<Vec<Arc<dyn ChannelAdapter>>>,
}

impl MessageDeliveryService {
    pub fn new() -> Self {
        let (published, _) = broadcast::channel(256);
        MessageDeliveryService {
            published,
            adapters: RwLock::new(Vec::new()),
        }
    }

    /// Register a channel adapter
    pub fn register(&self, adapter: Arc<dyn ChannelAdapter>) {
        todo!()
    }

    /// Get all registered adapters (for testing)
    pub fn get_adapters(&self) -> Vec<Arc<dyn ChannelAdapter>> {
        self.adapters.read().clone()
    }

    /// The registered adapter named `name`.
    pub fn get_adapter(&self, name: &str) -> Option<Arc<dyn ChannelAdapter>> {
        todo!()
    }

    /// Whether a message delivered in `channel` can link a page of the web UI:
    /// always when the agent has a public address, else when the channel opens
    /// links relative to the web UI. No channel is a broadcast, which some
    /// channels cannot open.
    pub fn opens_web_ui_links(&self, channel: Option<&str>) -> bool {
        todo!()
    }

    /// The delivery context for an autonomous message that continues `thread_id`
    /// where it started: the stored origin channel, and the destination that
    /// channel's adapter reconstructs from the thread. A thread with no stored
    /// origin started in the chat socket.
    pub async fn thread_context(
        &self,
        thread_id: &str,
        origin_channel: Option<&str>,
        origin_channel_id: Option<&str>,
    ) -> anyhow::Result<ThreadContext> {
        todo!()
    }

    /// SINGLE FUNCTION: Store message in DB + deliver to all channels
    pub async fn publish(
        &self,
        user_id: &str,
        thread_id: &str,
        content: &str,
        triggered_by: MessageTrigger,
        options: PublishOptions,
    ) -> anyhow::Result<ConversationMessage> {
        todo!()
    }

    /// Publish a message for autonomous background services (heartbeat, cron)
    ///
    /// Gets or creates the latest thread for the user before publishing.
    /// `triggered_by` is an autonomous trigger only (`Heartbeat`, `CronTask`, `Goal`,
    /// `Webhook`) — a user message always has a thread of its own.
    pub async fn publish_to_latest_thread(
        &self,
        agent_id: &str,
        user_id: &str,
        content: &str,
        triggered_by: MessageTrigger,
        options: PublishOptions,
    ) -> anyhow::Result<ConversationMessage> {
        todo!()
    }

    /// Publish an autonomous message to web chat only, in the web-visible latest
    /// thread. The options' `channel_context` is replaced with the web chat's.
    pub async fn publish_to_web_chat(
        &self,
        agent_id: &str,
        user_id: &str,
        content: &str,
        triggered_by: MessageTrigger,
        options: PublishOptions,
    ) -> anyhow::Result<ConversationMessage> {
        todo!()
    }

    /// Send a stored message that `publish` does not, to every channel that shows
    /// the whole conversation. There are two such messages:
    ///
    /// - A person's own message. Only those channels show it, so a message sent
    ///   from one device appears on the others.
    /// - A message changed after it was published. The one today is a computer
    ///   help card: answering it changes its status, and every open client has to
    ///   stop offering to answer it.
    ///
    /// A channel that posts only the agent's replies is skipped: it shows a
    /// person's message itself, and posting a change there would post the message
    /// twice.
    pub async fn show_in_conversation(
        &self,
        user_id: &str,
        message: &ConversationMessage,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Deliver to all connected channels. A USER_INPUT message without a channel
    /// context is not delivered (fail-closed), since a broadcast would leak the
    /// reply to every connected adapter.
    async fn deliver_to_all(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) {
        todo!()
    }

    /// Initialize all registered adapters
    pub async fn initialize_all(&self) {
        todo!()
    }

    /// Shutdown all registered adapters
    pub async fn shutdown_all(&self) {
        todo!()
    }

    /// Check if any adapter has an active connection for a user
    pub async fn is_user_connected_to_any(&self, user_id: &str) -> bool {
        todo!()
    }
}

impl Default for MessageDeliveryService {
    fn default() -> Self {
        Self::new()
    }
}

pub static MESSAGE_DELIVERY_SERVICE: LazyLock<MessageDeliveryService> =
    LazyLock::new(MessageDeliveryService::new);
