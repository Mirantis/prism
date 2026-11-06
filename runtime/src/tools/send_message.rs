//! send_message and list_message_targets — the agent posts a message on its own
//! initiative into a conversation linked to it.
//!
//! The policy lives in the outbound message service; these tools only pass the
//! run's identity and the conversation its reply goes to. A refusal is an error,
//! so the agent reads the reason and the stored tool call is marked failed.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::delivery_target_service::PostingCeiling;

pub const SEND_MESSAGE_DESCRIPTION: &str = "Post a message into a channel, a thread in one, or a DM that is linked to you, or into web chat when list_message_targets lists it. In a conversation your reply already goes to that conversation; use this tool to reach another one. Only the targets list_message_targets shows are allowed. To mention a person so they are notified, write <@ID> with the id from a <@ID:Name> tag in a message you have seen. The person must be a member of the target. @channel, @here, @everyone and group mentions are refused. A refusal says why; fix the cause before you try again.";
pub const LIST_MESSAGE_TARGETS_DESCRIPTION: &str =
    "List the channels and DMs linked to you, which send_message can post to.";

/// The trigger each invocation mode stores its messages under
/// (`heartbeat` → `HEARTBEAT`, `cron` → `CRON_TASK`, `webhook` → `WEBHOOK`,
/// `goal` → `GOAL`), `USER_INPUT` for any other.
pub fn mode_trigger(mode: &str) -> &'static str {
    match mode {
        "heartbeat" => "HEARTBEAT",
        "cron" => "CRON_TASK",
        "webhook" => "WEBHOOK",
        "goal" => "GOAL",
        _ => "USER_INPUT",
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SendMessageInput {
    /// A target from list_message_targets, or #name of a linked channel when the name is unique.
    pub target: String,
    /// Post into this thread of the target: the id of the thread's first message.
    #[serde(default)]
    pub thread: Option<String>,
    /// The message, in markdown.
    pub text: String,
}

pub fn list_message_targets_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn send_message_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// list_message_targets, then send_message.
///
/// `mode` sets the trigger of the message stored in the target's history, and
/// where a goal turn's own reply goes. `ceiling` is where an autonomous run may
/// post; unset, the run may post to any linked target.
pub fn get_send_message_tools(
    user_id: &str,
    agent_id: &str,
    mode: &str,
    thread_id: Option<&str>,
    origin_channel: Option<ChannelName>,
    origin_channel_id: Option<&str>,
    ceiling: Option<PostingCeiling>,
) -> ToolSet {
    todo!()
}

/// Where the run's own reply goes: a chat conversation and thread, or nowhere a
/// send can reach (a web turn). A goal turn posts its reply top-level, never in
/// a thread.
async fn reply_destination(
    mode: &str,
    thread_id: Option<&str>,
    origin_channel: Option<ChannelName>,
    origin_channel_id: Option<&str>,
) -> anyhow::Result<Option<Value>> {
    todo!()
}
