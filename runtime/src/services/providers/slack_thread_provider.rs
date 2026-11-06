//! Slack Thread Provider
//!
//! Reads conversation messages from Slack's conversations.replies API.
//! Used for threads with `ThreadSource::Slack` to get the full Slack thread history,
//! including messages where the bot wasn't mentioned, edited messages, and
//! messages from before the bot joined.
//!
//! Calls the Slack Web API through the adapter's per-team clients (no backend proxy).

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::services::thread_provider_interface::{MessageReadOptions, ThreadMessageProvider};
use crate::utils::poll_until::PollUntilOptions;

/// The fields of a `conversations.replies` message the provider reads.
#[derive(Debug, Clone, Default, Deserialize)]
struct SlackMessage {
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    text: Option<String>,
    ts: String,
}

/// What started a reply we stored.
#[derive(Debug, Clone)]
struct StoredTrigger {
    triggered_by: MessageTrigger,
    trigger_name: Option<String>,
}

/// Stored agent data by Slack message ts.
#[derive(Debug, Clone, Default)]
struct AgentMessageMaps {
    content_by_ts: HashMap<String, String>,
    tool_calls_by_ts: HashMap<String, serde_json::Value>,
    created_at_by_ts: HashMap<String, DateTime<Utc>>,
    trigger_by_ts: HashMap<String, StoredTrigger>,
}

/// The Slack workspace details of a thread.
#[derive(Debug, Clone)]
struct ResolvedSlackThread {
    channel_id: String,
    thread_ts: String,
    team_id: String,
    bot_user_id: String,
}

const USER_NAME_CACHE_TTL_MS: i64 = 5 * 60 * 1000; // 5 minutes

#[derive(Debug, Clone)]
struct CachedName {
    name: String,
    expires_at: i64,
}

pub struct SlackThreadProvider {
    user_name_cache: DashMap<String, CachedName>,
}

impl SlackThreadProvider {
    pub fn new() -> Self {
        SlackThreadProvider {
            user_name_cache: DashMap::new(),
        }
    }

    /// Wait (bounded, exponential backoff) until a message with `external_ts` is
    /// visible in this thread's live Slack history.
    ///
    /// `conversations.replies` is eventually consistent: a just-posted message can
    /// be absent for a few seconds, so building context immediately would read a
    /// thread that ends on the bot's previous reply rather than the user's new
    /// turn. Callers invoke this before building context so the history reflects
    /// the message being responded to.
    ///
    /// Returns once the message appears. If it never shows within the time
    /// budget, **fails** with `Slack message {externalTs} did not become visible
    /// in thread {threadId} within the wait budget` — the turn must fail rather
    /// than respond to stale context (and risk the provider's assistant-prefill
    /// rejection): the message is not dropped. Uses a light raw-replies check (no
    /// name resolution / mapping); the full read happens later via `get_messages`.
    /// A thread without an external channel or thread id returns at once.
    pub async fn wait_for_external_message(
        &self,
        thread_id: &str,
        external_ts: &str,
        options: PollUntilOptions,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Check whether a single message (by ts) is visible in a thread, without
    /// paginating the whole thread.
    ///
    /// Slack has no "fetch one message by id" endpoint, but `conversations.replies`
    /// accepts an `oldest`/`inclusive` window. The message we wait for is the
    /// newest one, so windowing to `ts >= externalTs` returns just the thread's
    /// tail — a single small page (limit 200), no cursor — instead of every
    /// reply. (The thread parent is always returned too, so we match on `ts`
    /// rather than assume a position.) Fails with `No Slack app found for team
    /// {teamId}` when the team has no app.
    async fn is_message_visible(
        &self,
        channel_id: &str,
        thread_ts: &str,
        external_ts: &str,
        team_id: &str,
    ) -> anyhow::Result<bool> {
        todo!()
    }

    /// Resolve thread metadata, fetch from Slack API, and map to ConversationMessage format.
    ///
    /// Fails with `Slack thread {threadId} missing externalChannelId or
    /// externalThreadId` when the thread lacks either.
    ///
    /// The model view (the default) reads only replies after the thread's
    /// `compactedThroughTs` watermark, and also merges the thread's concise-mode
    /// internal steps — rows persisted for replay but never posted to Slack, so
    /// absent from the live `conversations.replies` read — sorted by `createdAt`
    /// with the internal steps first on a tie (stable sort). The client view
    /// (`view: Client`) is unwindowed and skips that merge.
    async fn fetch_slack_messages(
        &self,
        thread_id: &str,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }

    /// Internal steps for this thread: rows persisted for model replay but never
    /// delivered to Slack (`externalMessageId` is null, so they are disjoint from the
    /// ts-enriched set built in `get_agent_message_maps` — never set a ts on an
    /// internal row or it would replay twice). `isCompacted: false` mirrors the
    /// DatabaseThreadProvider filter. Ordered by `createdAt` ascending.
    ///
    /// Either role. Concise mode writes AGENT rows; a turn's recalled memories are a
    /// USER row. Filtering to AGENT would rebuild a Slack thread's history from Slack
    /// alone and drop every recall, so the same agent would answer differently
    /// depending on which surface the thread ran on.
    async fn get_internal_step_messages(
        &self,
        thread_id: &str,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }

    /// Look up the Slack workspace details for a thread.
    ///
    /// Channels store their id on slackChannelId; DMs store theirs on
    /// dmChannelId. Both are searched so threaded DMs (which are SLACK-sourced and
    /// pass dmChannelId as externalChannelId) resolve their workspace here. Fails
    /// with `No SlackMapping found for channel {channelId} (thread {threadId})` or
    /// `No SlackConnection found for connectionId {connectionId} (thread {threadId})`.
    async fn resolve_slack_thread(
        &self,
        thread_id: &str,
        channel_id: &str,
        thread_ts: &str,
    ) -> anyhow::Result<ResolvedSlackThread> {
        todo!()
    }

    /// Fetch all replies from Slack's conversations.replies API (limit 200 per
    /// page, at most 50 pages).
    ///
    /// `oldest` windows the read to replies strictly after the compaction
    /// watermark (no `inclusive`, so the watermark message itself is excluded).
    /// The thread parent is always returned by the API regardless of `oldest`, so
    /// a ts post-filter (as floats) drops it — without that, a compacted thread
    /// would replay its root message forever.
    async fn fetch_all_replies(
        &self,
        channel_id: &str,
        thread_ts: &str,
        team_id: &str,
        oldest: Option<&str>,
    ) -> anyhow::Result<Vec<SlackMessage>> {
        todo!()
    }

    /// Map Slack messages to ConversationMessage format.
    ///
    /// Senders and any `<@USERID>` tokens inside message bodies are rewritten to
    /// the combined `<@USERID:displayName>` form so the agent can copy the token
    /// verbatim into a reply — the Slack adapter's outbound rewrite then turns
    /// it into a real Slack mention that fires a notification.
    ///
    /// For the agent's own replies the stored content (which keeps newlines) is
    /// preferred over Slack's flattened `text`, the stored `createdAt` over the
    /// Slack ts, and the stored trigger and tool calls are kept. Only messages
    /// from our bot are AGENT; other bots are users.
    async fn map_to_conversation_messages(
        &self,
        thread_id: &str,
        slack_messages: Vec<SlackMessage>,
        bot_user_id: &str,
        team_id: &str,
        maps: AgentMessageMaps,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }

    /// Build lookup maps from Slack message ts → stored agent data.
    ///
    /// Agent replies are persisted in the DB with `externalMessageId` set to the
    /// Slack ts (and `toolCalls` when present), so they match back to the
    /// Slack messages this provider reads. Both the original `content`
    /// (lossless, newline-preserving — used in place of Slack's flattened
    /// `msg.text`) and `toolCalls` are read for context enrichment.
    ///
    /// No `toolCalls` filter on the query — most agent messages have none,
    /// and their `content` is still needed. The `toolCalls` map only gains an
    /// entry when the row actually carries tool calls.
    async fn get_agent_message_maps(&self, thread_id: &str) -> anyhow::Result<AgentMessageMaps> {
        todo!()
    }

    /// Resolve Slack user IDs to display names (`real_name`, else `name`) with an
    /// in-memory cache. A failed lookup is skipped; the caller falls back to the
    /// user ID.
    async fn resolve_user_names(
        &self,
        user_ids: &[String],
        team_id: &str,
    ) -> HashMap<String, String> {
        todo!()
    }

    /// Generate a deterministic ID from threadId + Slack timestamp, in UUID shape
    /// (8-4-4-4-12 hex digits of the SHA-256 of `{threadId}:{ts}`).
    fn deterministic_id(&self, thread_id: &str, ts: &str) -> String {
        let hex = hex::encode(Sha256::digest(format!("{thread_id}:{ts}").as_bytes()));
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    }
}

impl Default for SlackThreadProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ThreadMessageProvider for SlackThreadProvider {
    async fn get_messages(
        &self,
        thread_id: &str,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }

    /// The `limit` messages before `opts.before` (or the newest `limit`). An id the
    /// read does not hold reads no messages.
    async fn get_recent_messages(
        &self,
        thread_id: &str,
        limit: i64,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        todo!()
    }
}
