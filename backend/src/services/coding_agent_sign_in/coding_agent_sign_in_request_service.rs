//! The agent asking the person, in chat, to sign a coding agent in to their
//! own subscription: a card in the conversation that opens the sign-in, and,
//! once a sign-in succeeds, the next turn of that conversation.
//!
//! The code a sign-in needs is typed where the card opens it, never into chat,
//! so nothing here reads or carries one.

use std::collections::HashSet;
use std::sync::LazyLock;

use diesel::prelude::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{CONFIG, CodingAgentName};
use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::db::schema::{conversation_messages, conversation_threads};
use crate::db::sql_types::DbJson;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::log_error;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata, StoredMessage, UserMessageInput,
};
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};

/// Whether a sign-in card still waits for the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentSignInRequestStatus {
    Waiting,
    SignedIn,
}

impl CodingAgentSignInRequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CodingAgentSignInRequestStatus::Waiting => "waiting",
            CodingAgentSignInRequestStatus::SignedIn => "signed_in",
        }
    }
}

/// The sign-in card, stored as the message's only UI block
/// (`{"type":"coding_agent_sign_in",…}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename = "coding_agent_sign_in",
    rename_all = "camelCase"
)]
pub struct CodingAgentSignInRequest {
    pub id: String,
    pub agent: CodingAgentName,
    pub status: CodingAgentSignInRequestStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel: Option<ChannelName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel_id: Option<String>,
}

/// A text for each coding agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PerAgent {
    pub claude_code: &'static str,
    pub codex: &'static str,
}

impl PerAgent {
    pub const fn get(&self, agent: CodingAgentName) -> &'static str {
        match agent {
            CodingAgentName::ClaudeCode => self.claude_code,
            CodingAgentName::Codex => self.codex,
        }
    }
}

/// Whose subscription the person signs in to.
pub const PROVIDERS: PerAgent = PerAgent {
    claude_code: "Claude",
    codex: "ChatGPT",
};

/// The name each coding agent is shown with.
pub const NAMES: PerAgent = PerAgent {
    claude_code: "Claude Code",
    codex: "Codex",
};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SignInCaller {
    pub agent_id: String,
    pub user_id: String,
    pub thread_id: String,
    pub origin_channel: Option<ChannelName>,
    pub origin_channel_id: Option<String>,
}

/// What `request` posted, or the card that already waited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestedSignIn {
    pub request: CodingAgentSignInRequest,
    /// True when a card for the same coding agent already waited in the
    /// conversation, and nothing was posted.
    pub repeated: bool,
}

/// The web UI's sign-in for `agent`: `<public url>/coding-agents?agent=<agent>`,
/// or the path alone without a public URL.
pub fn sign_in_link(agent: CodingAgentName) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("agent", agent.as_str())
        .finish();
    let suffix = format!("coding-agents?{query}");
    match CONFIG.public_url.as_deref().filter(|url| !url.is_empty()) {
        Some(url) => format!("{}/{suffix}", url.strip_suffix('/').unwrap_or(url)),
        None => format!("/{suffix}"),
    }
}

/// A waiting card, with the thread and the message that hold it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct WaitingRequest {
    request: CodingAgentSignInRequest,
    thread_id: String,
    message_id: String,
}

/// Whether the first block of a message's `blocks` is a sign-in card that waits.
fn waiting_card(blocks: &Value) -> Option<CodingAgentSignInRequest> {
    let first = blocks.get(0)?;
    if first.get("type").and_then(Value::as_str) != Some("coding_agent_sign_in")
        || first.get("status").and_then(Value::as_str) != Some("waiting")
    {
        return None;
    }
    serde_json::from_value(first.clone()).ok()
}

pub struct CodingAgentSignInRequestService {}

impl CodingAgentSignInRequestService {
    pub fn new() -> Self {
        CodingAgentSignInRequestService {}
    }

    /// Posts the card, unless one for the same coding agent already waits in the
    /// conversation.
    pub async fn request(
        &self,
        caller: &SignInCaller,
        agent: CodingAgentName,
    ) -> anyhow::Result<RequestedSignIn> {
        let waiting = self
            .waiting(&caller.agent_id, &caller.user_id, Some(&caller.thread_id))
            .await?
            .into_iter()
            .find(|item| item.request.agent == agent);
        if let Some(waiting) = waiting {
            return Ok(RequestedSignIn {
                request: waiting.request,
                repeated: true,
            });
        }
        let request = CodingAgentSignInRequest {
            id: uuid::Uuid::new_v4().to_string(),
            agent,
            status: CodingAgentSignInRequestStatus::Waiting,
            origin_channel: caller.origin_channel,
            origin_channel_id: caller.origin_channel_id.clone(),
        };
        let channel_context = MESSAGE_DELIVERY_SERVICE
            .thread_context(
                &caller.thread_id,
                caller.origin_channel.map(ChannelName::as_str),
                caller.origin_channel_id.as_deref(),
            )
            .await?
            .context;
        let provider = PROVIDERS.get(agent);
        let link = if MESSAGE_DELIVERY_SERVICE
            .opens_web_ui_links(Some(channel_context.channel.as_str()))
        {
            format!("[Sign in to {provider}]({})", sign_in_link(agent))
        } else {
            "Sign in from Coding agents in the agent's settings.".to_string()
        };
        MESSAGE_DELIVERY_SERVICE
            .publish(
                &caller.user_id,
                &caller.thread_id,
                &format!(
                    "Sign in to {provider} to run {} on your own plan. Enter the sign-in code only where this link opens, never in chat.\n\n{link}",
                    NAMES.get(agent)
                ),
                MessageTrigger::UserInput,
                PublishOptions {
                    blocks: Some(vec![serde_json::to_value(&request)?]),
                    channel_context: Some(channel_context),
                    ..Default::default()
                },
            )
            .await?;
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), caller.agent_id.clone());
        props.insert("coding_agent.name".to_string(), agent.as_str().to_string());
        track_event(
            "coding agent sign-in requested",
            Some(&caller.user_id),
            Some(props),
        );
        Ok(RequestedSignIn {
            request,
            repeated: false,
        })
    }

    /// The cards still waiting in the agent's conversations with the user (in
    /// `thread_id` alone when given), oldest first.
    async fn waiting(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: Option<&str>,
    ) -> anyhow::Result<Vec<WaitingRequest>> {
        let (agent_id, user_id) = (agent_id.to_string(), user_id.to_string());
        let thread_id = thread_id.map(str::to_string);
        let rows: Vec<(String, String, Option<Value>)> = crate::db::read(move |conn| {
            let mut query = conversation_messages::table
                .inner_join(conversation_threads::table)
                .filter(conversation_threads::agent_id.eq(agent_id))
                .filter(conversation_threads::user_id.eq(user_id))
                .filter(conversation_messages::blocks.is_not_null())
                .select((
                    conversation_messages::id,
                    conversation_messages::thread_id,
                    conversation_messages::blocks,
                ))
                .order(conversation_messages::created_at.asc())
                .into_boxed();
            if let Some(thread_id) = thread_id {
                query = query.filter(conversation_messages::thread_id.eq(thread_id));
            }
            Ok(query.load(conn)?)
        })
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(message_id, thread_id, blocks)| {
                let request = waiting_card(blocks.as_ref()?)?;
                Some(WaitingRequest {
                    request,
                    thread_id,
                    message_id,
                })
            })
            .collect())
    }

    /// Marks every request waiting for `agent` signed in and continues each
    /// conversation that asked, once. Each continuation is stored, owed an
    /// answer, before its card is marked, so a restart in between continues it
    /// at boot, and a later confirmation stores it no more.
    pub async fn signed_in(
        &self,
        agent_id: &str,
        user_id: &str,
        agent: CodingAgentName,
    ) -> anyhow::Result<()> {
        let waiting: Vec<WaitingRequest> = self
            .waiting(agent_id, user_id, None)
            .await?
            .into_iter()
            .filter(|item| item.request.agent == agent)
            .collect();
        let mut continuations = Vec::new();
        let mut threads = HashSet::new();
        for item in &waiting {
            if !threads.insert(item.thread_id.clone()) {
                continue;
            }
            if let Some(continuation) = self
                .accept_continuation(agent_id, user_id, &item.thread_id, &item.request)
                .await?
            {
                continuations.push(continuation);
            }
        }
        for item in waiting {
            let updated = CodingAgentSignInRequest {
                status: CodingAgentSignInRequestStatus::SignedIn,
                ..item.request
            };
            let blocks = json!([serde_json::to_value(&updated)?]);
            let message_id = item.message_id.clone();
            let changed = crate::db::run(move |conn| {
                conn.transaction(|conn| {
                    let current: Option<Option<Value>> = conversation_messages::table
                        .find(&message_id)
                        .select(conversation_messages::blocks)
                        .first(conn)
                        .optional()?;
                    if current.flatten().as_ref().and_then(waiting_card).is_none() {
                        return Ok(0);
                    }
                    diesel::update(conversation_messages::table.find(&message_id))
                        .set(conversation_messages::blocks.eq(Some(DbJson(blocks))))
                        .execute(conn)
                })
                .map_err(anyhow::Error::from)
            })
            .await?;
            if changed == 0 {
                continue;
            }
            let message_id = item.message_id.clone();
            let row: Option<ConversationMessage> = crate::db::read(move |conn| {
                Ok(conversation_messages::table
                    .find(&message_id)
                    .select(ConversationMessage::as_select())
                    .first(conn)
                    .optional()?)
            })
            .await?;
            // The card is part of the transcript, so every open client shows it signed in.
            if let Some(row) = row {
                MESSAGE_DELIVERY_SERVICE
                    .show_in_conversation(user_id, &row)
                    .await?;
            }
        }
        for continuation in continuations {
            tokio::spawn(async move {
                if let Err(err) = CONVERSATION_ENGINE_SERVICE.chat(continuation).await {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "[CodingAgents] Continuation after sign-in failed"
                    );
                }
            });
        }
        Ok(())
    }

    /// Stores the person's word that they signed in, owed an answer, under the
    /// request's id, and returns the turn that answers it. `None` when an earlier
    /// confirmation stored it: that one, or the boot after it, answers it.
    async fn accept_continuation(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        request: &CodingAgentSignInRequest,
    ) -> anyhow::Result<Option<ChatInput>> {
        let id = request.id.clone();
        let stored: Option<String> = crate::db::read(move |conn| {
            Ok(conversation_messages::table
                .find(&id)
                .select(conversation_messages::id)
                .first(conn)
                .optional()?)
        })
        .await?;
        if stored.is_some() {
            return Ok(None);
        }
        let context = MESSAGE_DELIVERY_SERVICE
            .thread_context(
                thread_id,
                request.origin_channel.map(ChannelName::as_str),
                request.origin_channel_id.as_deref(),
            )
            .await?;
        let input = UserMessageInput {
            agent_id: agent_id.to_string(),
            user_id: user_id.to_string(),
            message: format!("I signed in to {}.", PROVIDERS.get(request.agent)),
            runtime_written: true,
            metadata: Some(ChatMetadata {
                channel: Some(context.context.channel),
                channel_id: context.context.channel_id.clone(),
                channel_thread_id: context.context.channel_thread_id.clone(),
                channel_label: context.channel_label.clone(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let added = CONVERSATION_ENGINE_SERVICE
            .accept_user_message(&input, thread_id, Some(&request.id))
            .await?;
        Ok(Some(ChatInput {
            user_id: input.user_id,
            agent_id: input.agent_id,
            message: input.message,
            metadata: input.metadata,
            thread_id: Some(thread_id.to_string()),
            stored: Some(StoredMessage {
                id: request.id.clone(),
                title_set: added.title_set,
            }),
            ..Default::default()
        }))
    }
}

impl Default for CodingAgentSignInRequestService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CODING_AGENT_SIGN_IN_REQUEST_SERVICE: LazyLock<CodingAgentSignInRequestService> =
    LazyLock::new(CodingAgentSignInRequestService::new);
