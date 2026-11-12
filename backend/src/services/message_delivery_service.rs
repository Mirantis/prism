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

use futures::future::join_all;
use parking_lot::RwLock;
use serde_json::Value;
use tokio::sync::broadcast;

use crate::config::CONFIG;
use crate::db::models::{ConversationMessage, MessageRole};
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, ChatPlatform,
    DeliverableMessage,
};
use crate::services::conversation_service::{AddedMessage, CONVERSATION_SERVICE, MessageInput};
use crate::types::ToolCallRecord;
use crate::{log_error, log_info, log_warn};

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
        let name = adapter.name();
        self.adapters.write().push(adapter);
        log_info!("Registered channel adapter: {}", name);
    }

    /// Get all registered adapters (for testing)
    pub fn get_adapters(&self) -> Vec<Arc<dyn ChannelAdapter>> {
        self.adapters.read().clone()
    }

    /// The registered adapter named `name`.
    pub fn get_adapter(&self, name: &str) -> Option<Arc<dyn ChannelAdapter>> {
        self.adapters
            .read()
            .iter()
            .find(|adapter| adapter.name().as_str() == name)
            .cloned()
    }

    /// Whether a message delivered in `channel` can link a page of the web UI:
    /// always when the agent has a public address, else when the channel opens
    /// links relative to the web UI. No channel is a broadcast, which some
    /// channels cannot open.
    pub fn opens_web_ui_links(&self, channel: Option<&str>) -> bool {
        CONFIG
            .public_url
            .as_deref()
            .is_some_and(|url| !url.is_empty())
            || channel
                .filter(|channel| !channel.is_empty())
                .and_then(|channel| self.get_adapter(channel))
                .is_some_and(|adapter| adapter.opens_web_ui_links())
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
        let channel = origin_channel
            .and_then(ChatPlatform::parse)
            .map_or(ChannelName::Websocket, ChannelName::from);
        let destination = match self.get_adapter(channel.as_str()) {
            Some(adapter) => adapter
                .thread_destination(thread_id, origin_channel_id)
                .await
                .transpose()?
                .unwrap_or_default(),
            None => ChannelDestination::default(),
        };
        Ok(ThreadContext {
            context: ChannelContext {
                channel,
                channel_id: destination.channel_id,
                channel_thread_id: destination.channel_thread_id,
                thread_id: thread_id.to_string(),
                include_feedback: None,
            },
            channel_label: destination.channel_label,
        })
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
        // 1. Store in the database, in the thread clients show.
        let thread_id = CONVERSATION_SERVICE.writable_thread_id(thread_id).await?;
        let mut input = MessageInput::new(content, MessageRole::Agent, triggered_by);
        input.trigger_name = options.trigger_name.clone();
        input.tool_calls = options
            .tool_calls
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        input.blocks = options.blocks.clone().map(Value::Array);
        let AddedMessage { message, .. } =
            CONVERSATION_SERVICE.add_message(&thread_id, input).await?;

        // 2. Link any agent-shared files to this message and load their metadata
        // (no bytes) so adapters can render/upload them. `link_to_message` only claims
        // unlinked rows and caps the count, so forged/duplicate ids are safe.
        // Deliver a copy with the metadata, and with the tool calls of the steps a
        // concise turn hid — the persisted message we return stays a clean
        // `ConversationMessage` (no extra fields leak out).
        let shown = CONVERSATION_SERVICE
            .with_hidden_step_tool_calls(&thread_id, vec![message.clone()])
            .await?;
        let mut deliverable =
            DeliverableMessage::bare(shown.into_iter().next().unwrap_or_else(|| message.clone()));
        if let Some(attachment_ids) = options
            .attachment_ids
            .as_ref()
            .filter(|ids| !ids.is_empty())
        {
            ATTACHMENT_SERVICE
                .link_to_message(attachment_ids, &message.id, &thread_id)
                .await?;
            let mut meta = ATTACHMENT_SERVICE
                .get_meta_by_message_ids(std::slice::from_ref(&message.id))
                .await?;
            if let Some(attachments) = meta.shift_remove(&message.id).filter(|a| !a.is_empty()) {
                deliverable.attachments = Some(attachments);
            }
        }

        // 3. Deliver to all connected channels. The channel context is the single
        // source of routing + rendering hints; it is forwarded as-is and the adapter
        // decides what to do with it.
        self.deliver_to_all(user_id, &deliverable, options.channel_context.as_ref())
            .await;
        // Nobody listening is not an error.
        let _ = self.published.send(message.clone());

        Ok(message)
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
        // Resolve (or create) the latest thread for this user
        let thread = CONVERSATION_SERVICE
            .get_or_create_latest_thread(agent_id, user_id)
            .await?;

        // Use the standard publish method
        self.publish(user_id, &thread.id, content, triggered_by, options)
            .await
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
        let thread = CONVERSATION_SERVICE
            .get_or_create_latest_thread(agent_id, user_id)
            .await?;
        let options = PublishOptions {
            channel_context: Some(ChannelContext {
                channel: ChannelName::Websocket,
                channel_id: None,
                channel_thread_id: None,
                thread_id: thread.id.clone(),
                include_feedback: None,
            }),
            ..options
        };
        self.publish(user_id, &thread.id, content, triggered_by, options)
            .await
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
        let channels: Vec<Arc<dyn ChannelAdapter>> = self
            .adapters
            .read()
            .iter()
            .filter(|adapter| adapter.shows_whole_conversation())
            .cloned()
            .collect();
        if channels.is_empty() {
            return Ok(());
        }
        let attachments = ATTACHMENT_SERVICE
            .get_meta_by_message_ids(std::slice::from_ref(&message.id))
            .await?
            .shift_remove(&message.id);
        let shown = CONVERSATION_SERVICE
            .with_hidden_step_tool_calls(&message.thread_id, vec![message.clone()])
            .await?
            .into_iter()
            .next()
            .unwrap_or_else(|| message.clone());
        let deliverable = DeliverableMessage {
            inner: shown,
            attachments: attachments.filter(|attachments| !attachments.is_empty()),
        };
        join_all(channels.iter().map(|adapter| {
            let deliverable = &deliverable;
            async move {
                if let Err(error) = adapter.deliver(user_id, deliverable, None).await {
                    log_error!("Failed to show a message via {}: {}", adapter.name(), error);
                }
            }
        }))
        .await;
        Ok(())
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
        let adapters = self.adapters.read().clone();
        if adapters.is_empty() {
            log_warn!("No channel adapters registered, message stored but not delivered");
            return;
        }

        // Fail-closed: USER_INPUT replies must always be scoped to a channel.
        // If a caller forgot to pass a channel context, broadcasting would leak the
        // reply to every connected adapter, a direct message's answer included.
        // Better to log loudly and drop delivery than to leak.
        // Heartbeat/cron (HEARTBEAT/CRON_TASK) legitimately broadcast and are unaffected.
        if channel_context.is_none() && message.triggered_by == MessageTrigger::UserInput {
            log_error!(
                "[MessageDelivery] user-input message {} (thread {}) lacks channelContext — skipping delivery to prevent cross-channel leak",
                message.id,
                message.thread_id
            );
            return;
        }

        let results: Vec<DeliveryResult> = join_all(adapters.iter().map(|adapter| async move {
            let name = adapter.name().as_str().to_string();
            // When a channel context is set (user-initiated), only deliver to the
            // originating channel. When it is absent (heartbeat/cron), broadcast to
            // all connected channels.
            if let Some(context) = channel_context
                && context.channel != adapter.name()
            {
                return DeliveryResult {
                    adapter: name,
                    delivered: false,
                    reason: Some("not originating channel".to_string()),
                };
            }
            let attempt = async {
                if adapter.is_user_connected(user_id).await? {
                    adapter.deliver(user_id, message, channel_context).await?;
                    return Ok(true);
                }
                Ok::<bool, anyhow::Error>(false)
            };
            match attempt.await {
                Ok(true) => DeliveryResult {
                    adapter: name,
                    delivered: true,
                    reason: None,
                },
                Ok(false) => DeliveryResult {
                    adapter: name,
                    delivered: false,
                    reason: Some("not connected".to_string()),
                },
                Err(error) => {
                    log_error!("Failed to deliver via {}: {}", name, error);
                    DeliveryResult {
                        adapter: name,
                        delivered: false,
                        reason: Some(error.to_string()),
                    }
                }
            }
        }))
        .await;

        let delivered = results.iter().filter(|result| result.delivered).count();
        let statuses: Vec<String> = results
            .iter()
            .map(|result| {
                if result.delivered {
                    format!("{}:✓", result.adapter)
                } else {
                    format!("{}:✗", result.adapter)
                }
            })
            .collect();

        log_info!(
            "Message delivered to {}/{} channel(s) for user {} [{}]",
            delivered,
            adapters.len(),
            user_id,
            statuses.join(", ")
        );
    }

    /// Initialize all registered adapters
    pub async fn initialize_all(&self) {
        let adapters = self.adapters.read().clone();
        log_info!("Initializing {} channel adapter(s)", adapters.len());

        for adapter in adapters {
            match adapter.initialize().await {
                Ok(()) => log_info!("{} adapter initialized", adapter.name()),
                Err(error) => log_error!("Failed to initialize {}: {}", adapter.name(), error),
            }
        }
    }

    /// Shutdown all registered adapters
    pub async fn shutdown_all(&self) {
        let adapters = self.adapters.read().clone();
        log_info!("Shutting down {} channel adapter(s)", adapters.len());

        for adapter in adapters {
            match adapter.shutdown().await {
                Ok(()) => log_info!("{} adapter shut down", adapter.name()),
                Err(error) => log_error!("Failed to shutdown {}: {}", adapter.name(), error),
            }
        }
    }

    /// Check if any adapter has an active connection for a user
    pub async fn is_user_connected_to_any(&self, user_id: &str) -> bool {
        let adapters = self.adapters.read().clone();
        for adapter in adapters {
            // Errors are ignored; the next adapter is asked.
            if let Ok(true) = adapter.is_user_connected(user_id).await {
                return true;
            }
        }
        false
    }
}

impl Default for MessageDeliveryService {
    fn default() -> Self {
        Self::new()
    }
}

pub static MESSAGE_DELIVERY_SERVICE: LazyLock<MessageDeliveryService> =
    LazyLock::new(MessageDeliveryService::new);
