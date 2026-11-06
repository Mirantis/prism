//! WebSocket Adapter Service (Agent-Runtime)
//!
//! Implements `ChannelAdapter` for the chat socket. A message becomes a `message`
//! event on the numbered stream, which every connected client reads and a client
//! that was away is sent again when it resumes.

use std::sync::LazyLock;

use async_trait::async_trait;

use crate::db::models::ConversationMessage;
use crate::protocol::chat_protocol::MessageEventPayload;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, DeliverableMessage,
};
use crate::types::ResumedReply;
use crate::{log_error, log_info};

/// The wire form of a stored message, for any role.
///
/// `createdAt` is ISO text; `toolCalls`, `blocks` and `attachments` (shared-file
/// metadata with no bytes — clients render download chips and fetch bytes from
/// `GET /agents/attachments/:id`) are `null` when absent; `senderId` is the
/// message's `senderExternalId`; `agentMessageKind` comes from
/// `lib::agent_message_kind::agent_message_kind`.
pub fn message_event_payload(message: &DeliverableMessage) -> MessageEventPayload {
    todo!()
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
        todo!()
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
        todo!()
    }

    /// The socket answers one message at a time, so a resumed reply waits its turn
    /// there (`INBOUND_MESSAGE_SERVICE.resume`).
    fn continue_reply(&self, message: &ConversationMessage, resumed: &ResumedReply) -> Option<()> {
        todo!()
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
