use crate::db::models::MessageTrigger;
use crate::protocol::chat_protocol::AgentMessageKind;

/// A message from another agent keeps its kind in `triggerName`. Both the chat
/// socket's `message` event and a client's history read derive it here, so a
/// message shows the same whether it arrived live or was read back.
///
/// `triggered_by` and `trigger_name` are the message's `triggeredBy` and
/// `triggerName` columns.
pub fn agent_message_kind(
    triggered_by: &MessageTrigger,
    trigger_name: Option<&str>,
) -> Option<AgentMessageKind> {
    if !matches!(triggered_by, MessageTrigger::AgentMessage) {
        return None;
    }
    Some(match trigger_name {
        Some("ask") => AgentMessageKind::Ask,
        Some("notice") => AgentMessageKind::Notice,
        _ => AgentMessageKind::Message,
    })
}
