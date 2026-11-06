//! Outbound Message Service
//!
//! A message the agent posts on its own initiative into a conversation linked
//! to it: a linked channel, a thread in one, or a linked DM. It
//! owns the policy the `send_message` tool relies on: which target is allowed,
//! which text is refused, and the `agent message sent` event. Each adapter owns
//! its platform's mention rules and the post itself.

use std::sync::{Arc, LazyLock};

use fancy_regex::Regex;
use serde::Deserialize;

use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelName, LinkedTarget, PostedMessage,
};
use crate::services::delivery_target_service::PostingCeiling;
use crate::services::message_delivery_service::MessageTrigger;
use crate::types::ToolCallRecord;

/// The tool that posts through this service.
pub const SEND_MESSAGE_TOOL_NAME: &str = "send_message";

/// A post is a message to people, not a report: one chat message.
pub const MAX_SENT_MESSAGE_LENGTH: usize = 4000;

/// The stored text of a withheld run that sent a message and ended with no text of its own.
pub const WITHHELD_RUN_TEXT: &str = "This run sent a message and ended with no reply.";

/// What the `agent message sent` event reports about a target.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrackedTarget {
    platform: String,
    kind: String,
}

/// The plain broadcast words, each of which notifies a whole conversation.
static BROADCAST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^A-Za-z0-9])@(?:channel|here|everyone)(?![A-Za-z0-9])").unwrap()
});

/// The conversation and thread a run's own reply goes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOrigin {
    pub platform: ChannelName,
    pub conversation_id: Option<String>,
    pub thread: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SendInput {
    pub agent_id: String,
    pub user_id: String,
    /// A target key from `list_targets`, or `#name` of one linked channel.
    pub target: String,
    pub thread: Option<String>,
    pub text: String,
    /// What started the sending run, recorded on the message stored in the target's history.
    pub trigger: MessageTrigger,
    /// The conversation and thread the run's own reply goes to, which the service
    /// refuses as a target.
    pub origin: Option<SendOrigin>,
    /// Where an autonomous run may post. Set, it also allows web chat as `WEB_CHAT_TARGET`.
    pub ceiling: Option<PostingCeiling>,
}

/// What a send posted to: a target's key and name, and the posted message's id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMessage {
    pub key: String,
    pub name: Option<String>,
    pub message_id: String,
}

/// A run whose final message is not delivered, as `keep_withheld_run` stores it.
#[derive(Debug, Clone)]
pub struct WithheldRun {
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: Option<String>,
    pub content: String,
    pub triggered_by: MessageTrigger,
    /// The webhook subscription that produced the run, for the model's history.
    pub trigger_name: Option<String>,
    pub tool_calls: Vec<ToolCallRecord>,
}

/// A message a run's tool calls posted: the target, where it went with the thread
/// included, and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentMessageEntry {
    pub target: String,
    pub place: String,
    pub text: String,
}

/// An adapter that posts to targets: it has a display name, lists its linked
/// targets and posts to them.
type PostingAdapter = Arc<dyn ChannelAdapter>;

/// A linked target with the adapter that posts to it.
#[derive(Clone)]
struct ResolvedTarget {
    target: LinkedTarget,
    adapter: PostingAdapter,
}

/// How a send ended, for the `agent message sent` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendOutcome {
    Sent,
    Refused,
    Failed,
}

impl SendOutcome {
    fn as_str(self) -> &'static str {
        match self {
            SendOutcome::Sent => "sent",
            SendOutcome::Refused => "refused",
            SendOutcome::Failed => "failed",
        }
    }
}

pub struct OutboundMessageService;

impl OutboundMessageService {
    pub fn new() -> Self {
        OutboundMessageService
    }

    pub async fn list_targets(&self, agent_id: &str) -> anyhow::Result<Vec<LinkedTarget>> {
        todo!()
    }

    /// Post the message, or fail with an error whose message tells the agent why
    /// not. A refusal is a `SendRefusedError`.
    pub async fn send(&self, input: SendInput) -> anyhow::Result<SentMessage> {
        todo!()
    }

    /// A run whose final message is not delivered keeps its record when it sent a
    /// message: the message is stored, undelivered, in its own thread, or in the
    /// latest thread for a run that has none. The record is an internal row, which
    /// the model reads and no client shows, in a thread read live from a channel,
    /// which replays only the channel's messages and internal rows, and when the
    /// run posted into web chat, where the post itself already shows.
    ///
    /// Returns the stored message's id, or `None` when the run sent nothing.
    pub async fn keep_withheld_run(&self, run: WithheldRun) -> anyhow::Result<Option<String>> {
        todo!()
    }

    /// A reply in the target conversation reads its history from the stored
    /// thread, so the sent text is stored there, as an agent message nobody
    /// delivers. The message is already posted, so a failed write is logged and
    /// the send still succeeds: an error would make the agent send it again.
    async fn store_in_target_history(
        &self,
        input: &SendInput,
        user_id: &str,
        thread_key: &str,
        text: &str,
    ) {
        todo!()
    }

    async fn linked(&self, agent_id: &str) -> anyhow::Result<Vec<ResolvedTarget>> {
        todo!()
    }

    /// A refusal passes through; any other error is the platform's, and names it.
    async fn post(
        &self,
        resolved: &ResolvedTarget,
        text: &str,
        input: &SendInput,
    ) -> anyhow::Result<PostedMessage> {
        todo!()
    }

    async fn resolve_target(&self, input: &SendInput) -> anyhow::Result<ResolvedTarget> {
        todo!()
    }

    /// The linked targets `requested` names: its exact key, else each channel of that name.
    fn find_target(&self, linked: &[ResolvedTarget], requested: &str) -> Vec<ResolvedTarget> {
        todo!()
    }

    /// `known` gives the places to name when the send is refused.
    fn or_refuse(
        &self,
        found: Vec<ResolvedTarget>,
        requested: &str,
        known: &dyn Fn() -> String,
    ) -> anyhow::Result<ResolvedTarget> {
        todo!()
    }

    fn check_text(&self, raw: &str) -> anyhow::Result<String> {
        todo!()
    }

    fn check_origin(&self, target: &LinkedTarget, input: &SendInput) -> anyhow::Result<()> {
        todo!()
    }

    fn track(
        &self,
        input: &SendInput,
        outcome: SendOutcome,
        target: Option<&TrackedTarget>,
        reason: Option<&str>,
    ) {
        todo!()
    }
}

impl Default for OutboundMessageService {
    fn default() -> Self {
        Self::new()
    }
}

pub static OUTBOUND_MESSAGE_SERVICE: LazyLock<OutboundMessageService> =
    LazyLock::new(OutboundMessageService::new);

fn target_name(t: &LinkedTarget) -> String {
    match &t.name {
        Some(name) if !name.is_empty() => format!("{} ({})", t.key, name),
        _ => t.key.clone(),
    }
}

fn linked_list(targets: &[LinkedTarget]) -> String {
    if targets.is_empty() {
        return "No channel or DM is linked to this agent.".to_string();
    }
    let names: Vec<String> = targets.iter().map(target_name).collect();
    format!("Linked targets: {}.", names.join(", "))
}

/// The targets a delivery setting allows, as a refusal names them.
fn ceiling_list(ceiling: &PostingCeiling) -> String {
    todo!()
}

/// The `send_message` input a stored tool call holds.
#[derive(Deserialize)]
struct SendMessageCallInput {
    target: String,
    thread: Option<String>,
    text: String,
}

/// The messages a run's tool calls posted: the target, where each went with the
/// thread included, and its text. A call whose input does not parse is skipped.
pub fn sent_message_list(tool_calls: &[ToolCallRecord]) -> Vec<SentMessageEntry> {
    tool_calls
        .iter()
        .filter(|call| call.tool == SEND_MESSAGE_TOOL_NAME && call.success)
        .filter_map(|call| serde_json::from_str::<SendMessageCallInput>(&call.input).ok())
        .map(|input| {
            let place = match input.thread.as_deref() {
                Some(thread) if !thread.is_empty() => {
                    format!("{}, in thread {}", input.target, thread)
                }
                _ => input.target.clone(),
            };
            SentMessageEntry {
                target: input.target,
                place,
                text: input.text,
            }
        })
        .collect()
}

/// The messages a run's tool calls posted, one line each: where it went, then its text.
pub fn sent_messages(tool_calls: &[ToolCallRecord]) -> Vec<String> {
    sent_message_list(tool_calls)
        .into_iter()
        .map(|entry| format!("- To {}: {}", entry.place, entry.text))
        .collect()
}
