//! Outbound Message Service
//!
//! A message the agent posts on its own initiative into a conversation linked
//! to it: a linked channel, a thread in one, or a linked DM. It
//! owns the policy the `send_message` tool relies on: which target is allowed,
//! which text is refused, and the `agent message sent` event. Each adapter owns
//! its platform's mention rules and the post itself.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use anyhow::anyhow;
use fancy_regex::Regex;
use futures::future::try_join_all;
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::json;

use crate::db::models::{MessageRole, ThreadSource};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::lib::visible_text::visible_text;
use crate::log_error;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelName, LinkedTarget, LinkedTargetKind, PostedHistory, PostedMessage,
    SendRefusedError, WEB_CHAT_NAME, WEB_CHAT_TARGET, describe_target,
};
use crate::services::conversation_service::{CONVERSATION_SERVICE, LiveThread, MessageInput};
use crate::services::delivery_target_service::PostingCeiling;
use crate::services::message_delivery_service::{
    MESSAGE_DELIVERY_SERVICE, MessageTrigger, PublishOptions,
};
use crate::support::js;
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
        Ok(self
            .linked(agent_id)
            .await?
            .into_iter()
            .map(|resolved| resolved.target)
            .collect())
    }

    /// Post the message, or fail with an error whose message tells the agent why
    /// not. A refusal is a `SendRefusedError`.
    pub async fn send(&self, input: SendInput) -> anyhow::Result<SentMessage> {
        let mut target: Option<TrackedTarget> = None;
        let result: anyhow::Result<SentMessage> = async {
            if input.target == WEB_CHAT_TARGET
                && input
                    .ceiling
                    .as_ref()
                    .is_some_and(|ceiling| ceiling.web_chat)
            {
                target = Some(TrackedTarget {
                    platform: WEB_CHAT_TARGET.to_string(),
                    kind: WEB_CHAT_TARGET.to_string(),
                });
                if input.thread.is_some() {
                    return Err(SendRefusedError::new(
                        "Web chat has no threads. Send the message without a thread.",
                        "web_chat_thread",
                    )
                    .into());
                }
                let text = self.check_text(&input.text)?;
                let message = MESSAGE_DELIVERY_SERVICE
                    .publish_to_web_chat(
                        &input.agent_id,
                        &input.user_id,
                        &text,
                        input.trigger,
                        PublishOptions::default(),
                    )
                    .await?;
                self.track(&input, SendOutcome::Sent, target.as_ref(), None);
                return Ok(SentMessage {
                    key: WEB_CHAT_TARGET.to_string(),
                    name: Some(WEB_CHAT_NAME.to_string()),
                    message_id: message.id,
                });
            }
            let resolved = self.resolve_target(&input).await?;
            target = Some(tracked(&resolved.target));
            let text = self.check_text(&input.text)?;
            self.check_origin(&resolved.target, &input)?;
            let posted = self.post(&resolved, &text, &input).await?;
            self.track(&input, SendOutcome::Sent, target.as_ref(), None);
            if let Some(history) = posted.history {
                self.store_in_target_history(&input, &history, &text).await;
            }
            Ok(SentMessage {
                key: resolved.target.key.clone(),
                name: resolved.target.name.clone(),
                message_id: posted.message_id,
            })
        }
        .await;
        if let Err(error) = &result
            && let Some(refused) = error.downcast_ref::<SendRefusedError>()
        {
            self.track(
                &input,
                SendOutcome::Refused,
                target.as_ref(),
                Some(&refused.code),
            );
        }
        result
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
        if sent_messages(&run.tool_calls).is_empty() {
            return Ok(None);
        }
        // The thread a delivery of this run would write to, as `publish` resolves it.
        let thread_id = match &run.thread_id {
            Some(thread_id) => CONVERSATION_SERVICE.writable_thread_id(thread_id).await?,
            None => {
                CONVERSATION_SERVICE
                    .get_or_create_latest_thread(&run.agent_id, &run.user_id)
                    .await?
                    .id
            }
        };
        let read_live = run.thread_id.is_some()
            && CONVERSATION_SERVICE.get_thread_source(&thread_id).await?
                != Some(ThreadSource::Database);
        let posted_to_web_chat = sent_message_list(&run.tool_calls)
            .iter()
            .any(|entry| entry.target == WEB_CHAT_TARGET);
        let content = if visible_text(&run.content).is_empty() {
            WITHHELD_RUN_TEXT.to_string()
        } else {
            run.content.clone()
        };
        let mut input = MessageInput::new(content, MessageRole::Agent, run.triggered_by);
        input.trigger_name = run.trigger_name.clone();
        input.tool_calls = Some(serde_json::to_value(&run.tool_calls)?);
        if read_live || posted_to_web_chat {
            input.internal_step = Some(true);
        }
        let added = CONVERSATION_SERVICE.add_message(&thread_id, input).await?;
        Ok(Some(added.message.id))
    }

    /// A reply in the target conversation reads its history from the stored
    /// thread, so the sent text is stored there, as an agent message nobody
    /// delivers. The message is already posted, so a failed write is logged and
    /// the send still succeeds: an error would make the agent send it again.
    async fn store_in_target_history(
        &self,
        input: &SendInput,
        history: &PostedHistory,
        text: &str,
    ) {
        let stored = async {
            // A thread the inbound path opens in a channel is a database thread
            // in that channel.
            let live = history.channel_id.as_ref().map(|channel_id| LiveThread {
                source: ThreadSource::Database,
                channel_id: channel_id.clone(),
            });
            let thread = CONVERSATION_SERVICE
                .get_or_create_thread_by_external_id(
                    &history.user_id,
                    &input.agent_id,
                    &history.thread_key,
                    live,
                )
                .await?;
            let mut message = MessageInput::new(text, MessageRole::Agent, input.trigger);
            message.external_message_id = history.external_message_id.clone();
            CONVERSATION_SERVICE.add_message(&thread.id, message).await
        }
        .await;
        if let Err(err) = stored {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[OutboundMessage] posted, but the message could not be stored in the target history"
            );
        }
    }

    async fn linked(&self, agent_id: &str) -> anyhow::Result<Vec<ResolvedTarget>> {
        let adapters: Vec<PostingAdapter> = MESSAGE_DELIVERY_SERVICE
            .get_adapters()
            .into_iter()
            .filter(|adapter| adapter.display_name().is_some_and(|name| !name.is_empty()))
            .collect();
        let lists = try_join_all(adapters.into_iter().map(|adapter| async move {
            let Some(targets) = adapter.list_linked_targets(agent_id).await else {
                return Ok(Vec::new());
            };
            Ok::<Vec<ResolvedTarget>, anyhow::Error>(
                targets?
                    .into_iter()
                    .map(|target| ResolvedTarget {
                        target,
                        adapter: Arc::clone(&adapter),
                    })
                    .collect(),
            )
        }))
        .await?;
        Ok(lists.into_iter().flatten().collect())
    }

    /// A refusal passes through; any other error is the platform's, and names it.
    async fn post(
        &self,
        resolved: &ResolvedTarget,
        text: &str,
        input: &SendInput,
    ) -> anyhow::Result<PostedMessage> {
        let display_name = resolved
            .adapter
            .display_name()
            .unwrap_or_default()
            .to_string();
        let posted = match resolved
            .adapter
            .post_to_target(&resolved.target, text, input.thread.as_deref())
            .await
        {
            Some(posted) => posted,
            None => Err(anyhow!("{display_name} posts to no target")),
        };
        posted.map_err(|error| {
            if error.downcast_ref::<SendRefusedError>().is_some() {
                return error;
            }
            self.track(
                input,
                SendOutcome::Failed,
                Some(&tracked(&resolved.target)),
                None,
            );
            anyhow!("{display_name} did not accept the message: {error}")
        })
    }

    async fn resolve_target(&self, input: &SendInput) -> anyhow::Result<ResolvedTarget> {
        let linked = self.linked(&input.agent_id).await?;
        let found = self.find_target(&linked, &input.target);
        let Some(ceiling) = &input.ceiling else {
            let targets: Vec<LinkedTarget> = linked.iter().map(|r| r.target.clone()).collect();
            return self.or_refuse(found, &input.target, &|| linked_list(&targets));
        };

        let allowed: HashSet<&str> = ceiling.targets.iter().map(|t| t.key.as_str()).collect();
        let known = || ceiling_list(ceiling);
        if found.len() == 1 && !allowed.contains(found[0].target.key.as_str()) {
            return Err(SendRefusedError::new(
                format!(
                    "Your delivery setting does not let this run post to {}, so nothing was sent. {}",
                    describe_target(&found[0].target),
                    known()
                ),
                "outside_delivery",
            )
            .into());
        }
        self.or_refuse(
            found
                .into_iter()
                .filter(|resolved| allowed.contains(resolved.target.key.as_str()))
                .collect(),
            &input.target,
            &known,
        )
    }

    /// The linked targets `requested` names: its exact key, else each channel of that name.
    fn find_target(&self, linked: &[ResolvedTarget], requested: &str) -> Vec<ResolvedTarget> {
        if let Some(exact) = linked.iter().find(|r| r.target.key == requested) {
            return vec![exact.clone()];
        }
        let name = requested
            .strip_prefix('#')
            .unwrap_or(requested)
            .to_lowercase();
        linked
            .iter()
            .filter(|r| {
                r.target.kind == LinkedTargetKind::Channel
                    && r.target.name.as_ref().map(|n| n.to_lowercase()) == Some(name.clone())
            })
            .cloned()
            .collect()
    }

    /// `known` gives the places to name when the send is refused.
    fn or_refuse(
        &self,
        mut found: Vec<ResolvedTarget>,
        requested: &str,
        known: &dyn Fn() -> String,
    ) -> anyhow::Result<ResolvedTarget> {
        if found.len() == 1 {
            return Ok(found.remove(0));
        }
        if found.len() > 1 {
            return Err(SendRefusedError::new(
                format!(
                    "More than one linked channel is named \"{requested}\". Name one by its target. {}",
                    known()
                ),
                "ambiguous_target",
            )
            .into());
        }
        Err(SendRefusedError::new(
            format!(
                "\"{requested}\" is not a channel or DM linked to this agent, so nothing was sent. {}",
                known()
            ),
            "unknown_target",
        )
        .into())
    }

    fn check_text(&self, raw: &str) -> anyhow::Result<String> {
        let text = js::trim(raw);
        if text.is_empty() {
            return Err(SendRefusedError::new("The message is empty.", "empty").into());
        }
        let length = js::len16(text);
        if length > MAX_SENT_MESSAGE_LENGTH {
            return Err(SendRefusedError::new(
                format!(
                    "The message is {length} characters, and the limit is {MAX_SENT_MESSAGE_LENGTH}. Shorten it."
                ),
                "too_long",
            )
            .into());
        }
        if BROADCAST.is_match(text).unwrap_or(false) {
            return Err(SendRefusedError::new(
                "The message has a broadcast mention (@channel, @here or @everyone), so nothing was sent. Mention people one at a time as <@ID>.",
                "broadcast",
            )
            .into());
        }
        Ok(text.to_string())
    }

    fn check_origin(&self, target: &LinkedTarget, input: &SendInput) -> anyhow::Result<()> {
        let Some(origin) = &input.origin else {
            return Ok(());
        };
        if origin.platform != ChannelName::from(target.platform)
            || origin.conversation_id.as_deref() != Some(target.conversation_id.as_str())
        {
            return Ok(());
        }
        if origin.thread != input.thread {
            return Ok(());
        }
        Err(SendRefusedError::new(
            "Your reply already goes to this conversation. Write the message in your reply instead.",
            "own_conversation",
        )
        .into())
    }

    fn track(
        &self,
        input: &SendInput,
        outcome: SendOutcome,
        target: Option<&TrackedTarget>,
        reason: Option<&str>,
    ) {
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), input.agent_id.clone());
        props.insert("send.outcome".to_string(), outcome.as_str().to_string());
        if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
            props.insert("send.reason".to_string(), reason.to_string());
        }
        if let Some(target) = target {
            props.insert("send.platform".to_string(), target.platform.clone());
            props.insert("send.target_kind".to_string(), target.kind.clone());
        }
        props.insert(
            "send.threaded".to_string(),
            input.thread.is_some().to_string(),
        );
        track_event("agent message sent", Some(&input.user_id), Some(props));
    }
}

/// What the `agent message sent` event reports about a linked target.
fn tracked(target: &LinkedTarget) -> TrackedTarget {
    TrackedTarget {
        platform: target.platform.as_str().to_string(),
        kind: target.kind.as_str().to_string(),
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
    let mut names = Vec::new();
    if ceiling.web_chat {
        names.push(format!("{WEB_CHAT_TARGET} ({WEB_CHAT_NAME})"));
    }
    names.extend(ceiling.targets.iter().map(target_name));
    if names.is_empty() {
        return "This run may post nowhere.".to_string();
    }
    format!("This run may post to: {}.", names.join(", "))
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
