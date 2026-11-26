//! WebSocket Adapter Service (Agent-Runtime)
//!
//! Implements `ChannelAdapter` for the chat socket. A message becomes a `message`
//! event on the numbered stream, which every connected client reads and a client
//! that was away is sent again when it resumes.

use std::sync::LazyLock;

use async_trait::async_trait;

use serde_json::Value;

use crate::db::models::ConversationMessage;
use crate::lib::agent_message_kind::agent_message_kind;
use crate::log_info;
use crate::protocol::chat_protocol::{AttachmentPayload, MessageEventPayload, StreamEvent};
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, DeliverableMessage,
};
use crate::services::event_stream_service::EVENT_STREAM_SERVICE;
use crate::services::inbound_message_service::INBOUND_MESSAGE_SERVICE;
use crate::services::web_chat_label::web_chat_label;
use crate::types::ResumedReply;

/// The wire form of a stored message, for any role.
///
/// `createdAt` is ISO text; `toolCalls`, `blocks` and `attachments` (shared-file
/// metadata with no bytes — clients render download chips and fetch bytes from
/// `GET /agents/attachments/:id`) are `null` when absent; `senderId` is the
/// message's `senderExternalId`; `agentMessageKind` comes from
/// `lib::agent_message_kind::agent_message_kind`.
pub fn message_event_payload(message: &DeliverableMessage) -> MessageEventPayload {
    // The stored columns hold arrays.
    let as_list = |value: &Option<Value>| value.as_ref().and_then(Value::as_array).cloned();
    MessageEventPayload {
        id: message.id.clone(),
        thread_id: message.thread_id.clone(),
        role: message.role,
        content: message.content.clone(),
        triggered_by: message.triggered_by.as_str().to_string(),
        tool_calls: as_list(&message.tool_calls),
        blocks: as_list(&message.blocks),
        is_compacted: message.is_compacted,
        created_at: crate::support::iso(&message.created_at),
        attachments: message.attachments.as_ref().map(|attachments| {
            attachments
                .iter()
                .map(|meta| AttachmentPayload {
                    id: meta.id.clone(),
                    filename: meta.filename.clone(),
                    media_type: meta.media_type.clone(),
                    size_bytes: meta.size_bytes,
                    category: meta.category.as_str().to_string(),
                    expired: Some(meta.expired),
                    inline: meta.inline,
                })
                .collect()
        }),
        sender_id: message.sender_external_id.clone(),
        sender_name: message.sender_name.clone(),
        agent_message_kind: agent_message_kind(
            &message.triggered_by,
            message.trigger_name.as_deref(),
        ),
    }
}

pub struct WebSocketAdapterService;

impl Default for WebSocketAdapterService {
    fn default() -> Self {
        Self::new()
    }
}

impl WebSocketAdapterService {
    pub fn new() -> Self {
        WebSocketAdapterService
    }
}

#[async_trait]
impl ChannelAdapter for WebSocketAdapterService {
    fn name(&self) -> ChannelName {
        ChannelName::Websocket
    }

    fn shows_whole_conversation(&self) -> bool {
        true
    }

    fn opens_web_ui_links(&self) -> bool {
        true
    }

    /// Publishes a `message` event with `message_event_payload`. A failure is logged
    /// as `WebSocket deliver failed for user {userId}: {message}` and not returned.
    async fn deliver(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) -> anyhow::Result<()> {
        // Publishing has no failure to report: the frame always serializes, and a
        // subscriber only queues it for its socket.
        EVENT_STREAM_SERVICE.publish(StreamEvent::Message(message_event_payload(message)));
        Ok(())
    }

    /// Always connected. The stream keeps what it is given for a client that is
    /// away right now, and a reply that was never published could never be sent again.
    async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        Ok(true)
    }

    /// A turn that continues a web conversation gets the label a chat turn on it gets
    /// (`web_chat_label`).
    async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> Option<anyhow::Result<ChannelDestination>> {
        Some(
            web_chat_label(thread_id)
                .await
                .map(|channel_label| ChannelDestination {
                    channel_label,
                    ..ChannelDestination::default()
                }),
        )
    }

    /// The socket answers one message at a time, so a resumed reply waits its turn
    /// there (`INBOUND_MESSAGE_SERVICE.resume`).
    fn continue_reply(&self, message: &ConversationMessage, resumed: &ResumedReply) -> Option<()> {
        INBOUND_MESSAGE_SERVICE.resume(message, resumed.clone());
        Some(())
    }

    /// A message the runtime stored waits its turn there too.
    fn answer_stored(&self, message: &ConversationMessage) -> Option<()> {
        INBOUND_MESSAGE_SERVICE.answer_stored(message);
        Some(())
    }

    async fn initialize(&self) -> anyhow::Result<()> {
        log_info!("WebSocket adapter ready");
        Ok(())
    }

    async fn shutdown(&self) -> anyhow::Result<()> {
        log_info!("WebSocket adapter shutdown");
        Ok(())
    }
}

pub static WEB_SOCKET_ADAPTER_SERVICE: LazyLock<WebSocketAdapterService> =
    LazyLock::new(WebSocketAdapterService::new);
