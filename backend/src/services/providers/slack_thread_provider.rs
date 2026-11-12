//! Slack Thread Provider
//!
//! Reads conversation messages from Slack's conversations.replies API.
//! Used for threads with `ThreadSource::Slack` to get the full Slack thread history,
//! including messages where the bot wasn't mentioned, edited messages, and
//! messages from before the bot joined.
//!
//! Calls the Slack Web API through the adapter's per-team clients (no backend proxy).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use diesel::prelude::*;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::db::models::{ConversationMessage, MessageRole, MessageTrigger, SlackMapping};
use crate::db::schema::conversation_messages::dsl as cm;
use crate::db::schema::conversation_threads::dsl as ct;
use crate::db::schema::slack_mappings::dsl as m;
use crate::lib::slack_source::get_slack_connection;
use crate::services::slack_adapter_service::SLACK_ADAPTER_SERVICE;
use crate::services::thread_provider_interface::{
    MessageReadOptions, MessageView, ThreadMessageProvider,
};
use crate::support::js::trim as js_trim;
use crate::utils::poll_until::{PollUntilOptions, poll_until};

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

/// A bare `<@USERID>` mention.
static BARE_MENTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@([A-Z0-9]+)>").expect("valid regex"));

/// Characters a display name loses inside a `<@ID:Name>` token.
static NAME_STRIP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[<>:\x00-\x1f]").expect("valid regex"));

#[derive(Debug, Clone)]
struct CachedName {
    name: String,
    expires_at: i64,
}

/// `parseFloat` of a Slack ts.
fn parse_ts(ts: &str) -> f64 {
    ts.trim().parse::<f64>().unwrap_or(f64::NAN)
}

/// The `limit` messages before the one with id `before` (or the newest `limit`).
/// An id the read does not hold reads no messages.
fn recent_window(
    all: Vec<ConversationMessage>,
    limit: i64,
    before: Option<&str>,
) -> Vec<ConversationMessage> {
    let end = match before {
        None => all.len(),
        Some(before) => match all.iter().position(|message| message.id == before) {
            Some(index) => index,
            None => return Vec::new(),
        },
    };
    let start = end.saturating_sub(limit.max(0) as usize);
    all.into_iter().skip(start).take(end - start).collect()
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
        let id = thread_id.to_string();
        let thread: Option<(Option<String>, Option<String>)> = crate::db::read(move |conn| {
            Ok(ct::conversation_threads
                .filter(ct::id.eq(&id))
                .select((ct::external_channel_id, ct::external_thread_id))
                .first(conn)
                .optional()?)
        })
        .await?;
        let Some((Some(channel_id), Some(thread_ts))) = thread else {
            return Ok(());
        };
        if channel_id.is_empty() || thread_ts.is_empty() {
            return Ok(());
        }

        let resolved = self
            .resolve_slack_thread(thread_id, &channel_id, &thread_ts)
            .await?;

        let found = poll_until(
            || {
                self.is_message_visible(
                    &resolved.channel_id,
                    &resolved.thread_ts,
                    external_ts,
                    &resolved.team_id,
                )
            },
            options,
        )
        .await?;

        if !found {
            anyhow::bail!(
                "Slack message {external_ts} did not become visible in thread {thread_id} within the wait budget"
            );
        }
        Ok(())
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
        let Some(app) = SLACK_ADAPTER_SERVICE.get_app_for_team(team_id).await else {
            anyhow::bail!("No Slack app found for team {team_id}");
        };

        let response = app
            .client
            .api_call(
                "conversations.replies",
                json!({
                    "channel": channel_id,
                    "ts": thread_ts,
                    "oldest": external_ts,
                    "inclusive": true,
                    "limit": 200,
                }),
            )
            .await?;

        Ok(response
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| {
                messages
                    .iter()
                    .any(|m| m.get("ts").and_then(Value::as_str) == Some(external_ts))
            }))
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
        let id = thread_id.to_string();
        type ThreadRow = (Option<String>, Option<String>, Option<String>);
        let thread: Option<ThreadRow> = crate::db::read(move |conn| {
            Ok(ct::conversation_threads
                .filter(ct::id.eq(&id))
                .select((
                    ct::external_channel_id,
                    ct::external_thread_id,
                    ct::compacted_through_ts,
                ))
                .first(conn)
                .optional()?)
        })
        .await?;

        let (channel_id, thread_ts, compacted_through_ts) = match thread {
            Some((Some(channel), Some(ts), compacted)) if !channel.is_empty() && !ts.is_empty() => {
                (channel, ts, compacted)
            }
            _ => anyhow::bail!(
                "Slack thread {thread_id} missing externalChannelId or externalThreadId"
            ),
        };

        let resolved = self
            .resolve_slack_thread(thread_id, &channel_id, &thread_ts)
            .await?;

        // Compaction watermark, model view only: replies at or before it are folded
        // into the thread's compaction summary, so the live read skips them (and
        // usually collapses to a single page). The client view stays unwindowed —
        // compaction only changes what the model sees.
        let client_view = opts.and_then(|o| o.view) == Some(MessageView::Client);
        let compacted_through_ts = if client_view {
            None
        } else {
            compacted_through_ts.filter(|ts| !ts.is_empty())
        };

        let (raw_messages, maps) = tokio::try_join!(
            self.fetch_all_replies(
                &resolved.channel_id,
                &resolved.thread_ts,
                &resolved.team_id,
                compacted_through_ts.as_deref(),
            ),
            self.get_agent_message_maps(thread_id),
        )?;
        let slack_derived = self
            .map_to_conversation_messages(
                thread_id,
                raw_messages,
                &resolved.bot_user_id,
                &resolved.team_id,
                maps,
            )
            .await?;

        if client_view {
            return Ok(slack_derived);
        }

        // Model view: interleave the persisted internal steps. Both the internal rows
        // and (via created_at_by_ts) our own delivered replies are ordered by our DB
        // clock, so an internal step sorts before its turn's delivered final; the
        // cross-clock comparison (Slack ts vs DB createdAt) only occurs at user↔agent
        // boundaries. Concat internal-first so a rare exact timestamp tie keeps the
        // internal step ahead of its final (stable sort).
        //
        // One of those boundaries is now close rather than a full LLM round apart: a
        // turn's recalled memories are written about a second after the Slack message
        // that triggered them, the time it takes to read the context and embed the
        // query. A host clock behind Slack's by more than that sorts the recall ahead of
        // the question it answers. The replay is then a different shape from the live
        // send, which costs that thread one re-write; nothing breaks.
        let internal = self.get_internal_step_messages(thread_id).await?;
        if internal.is_empty() {
            return Ok(slack_derived);
        }
        let mut merged: Vec<ConversationMessage> =
            internal.into_iter().chain(slack_derived).collect();
        merged.sort_by_key(|message| message.created_at.timestamp_millis());
        Ok(merged)
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
        let thread_id = thread_id.to_string();
        crate::db::read(move |conn| {
            Ok(cm::conversation_messages
                .filter(cm::thread_id.eq(&thread_id))
                .filter(cm::internal_step.eq(true))
                .filter(cm::is_compacted.eq(false))
                .order(cm::created_at.asc())
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await
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
        let channel = channel_id.to_string();
        let mapping: Option<SlackMapping> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(
                    m::slack_channel_id
                        .eq(&channel)
                        .or(m::dm_channel_id.eq(&channel)),
                )
                .select(SlackMapping::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;

        let Some(mapping) = mapping else {
            anyhow::bail!("No SlackMapping found for channel {channel_id} (thread {thread_id})");
        };

        let Some(connection) = get_slack_connection().await? else {
            anyhow::bail!(
                "No SlackConnection found for connectionId {} (thread {thread_id})",
                mapping.connection_id
            );
        };

        Ok(ResolvedSlackThread {
            channel_id: channel_id.to_string(),
            thread_ts: thread_ts.to_string(),
            team_id: connection.team_id,
            bot_user_id: connection.bot_user_id,
        })
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
        let Some(app) = SLACK_ADAPTER_SERVICE.get_app_for_team(team_id).await else {
            anyhow::bail!("No Slack app found for team {team_id}");
        };

        let mut all_messages: Vec<SlackMessage> = Vec::new();
        let mut cursor: Option<String> = None;
        const MAX_PAGES: usize = 50;

        for _page in 0..MAX_PAGES {
            let mut args = serde_json::Map::new();
            args.insert("channel".into(), json!(channel_id));
            args.insert("ts".into(), json!(thread_ts));
            args.insert("limit".into(), json!(200));
            if let Some(oldest) = oldest {
                args.insert("oldest".into(), json!(oldest));
            }
            if let Some(cursor) = &cursor {
                args.insert("cursor".into(), json!(cursor));
            }
            let response = app
                .client
                .api_call("conversations.replies", Value::Object(args))
                .await?;

            if let Some(messages) = response.get("messages").and_then(Value::as_array) {
                for message in messages {
                    all_messages.push(serde_json::from_value(message.clone())?);
                }
            }

            cursor = response
                .pointer("/response_metadata/next_cursor")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }

        let Some(oldest) = oldest else {
            return Ok(all_messages);
        };
        let cutoff = parse_ts(oldest);
        Ok(all_messages
            .into_iter()
            .filter(|m| parse_ts(&m.ts) > cutoff)
            .collect())
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
        // Choose the authoritative body for a message. For the agent's own
        // replies, prefer the lossless stored DB content (which preserves
        // newlines) over Slack's `msg.text`. Slack returns a flattened,
        // newline-stripped `text` for messages posted with markdown/blocks, and
        // replaying that as history trains the agent to imitate single-line
        // output — so we always feed it back its real, well-formatted reply.
        // Falls back to `msg.text` when no stored row exists (e.g. pre-join or
        // un-persisted messages).
        let source_text = |m: &SlackMessage| -> String {
            if m.user.as_deref() == Some(bot_user_id)
                && let Some(stored) = maps.content_by_ts.get(&m.ts)
                && !js_trim(stored).is_empty()
            {
                return stored.clone();
            }
            m.text.clone().unwrap_or_default()
        };

        // Collect every Slack user ID we'll need a name for: senders + any
        // user mentioned via `<@U…>` inside message bodies. Resolved in one batch.
        let mut user_ids: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for message in &slack_messages {
            if let Some(user) = message
                .user
                .as_deref()
                .filter(|u| !u.is_empty() && *u != bot_user_id)
                && seen.insert(user.to_string())
            {
                user_ids.push(user.to_string());
            }
        }
        for message in &slack_messages {
            for found in BARE_MENTION.captures_iter(&source_text(message)) {
                if seen.insert(found[1].to_string()) {
                    user_ids.push(found[1].to_string());
                }
            }
        }

        let user_names = self.resolve_user_names(&user_ids, team_id).await;

        let sanitize_name = |name: &str| -> String {
            let stripped = NAME_STRIP.replace_all(name, "");
            let trimmed = js_trim(&stripped);
            if trimmed.is_empty() {
                name.to_string()
            } else {
                trimmed.to_string()
            }
        };

        let enrich_mentions = |text: &str| -> String {
            BARE_MENTION
                .replace_all(text, |found: &regex::Captures<'_>| {
                    let uid = &found[1];
                    match user_names.get(uid) {
                        Some(name) => format!("<@{uid}:{}>", sanitize_name(name)),
                        None => format!("<@{uid}>"),
                    }
                })
                .into_owned()
        };

        Ok(slack_messages
            .iter()
            .map(|msg| {
                // Only treat messages from OUR bot as AGENT — other bots are treated as users
                let user = msg.user.as_deref().filter(|u| !u.is_empty());
                let is_our_agent = msg.user.as_deref() == Some(bot_user_id);
                let sender_name = if is_our_agent {
                    "Agent".to_string()
                } else {
                    user.and_then(|u| user_names.get(u))
                        .filter(|name| !name.is_empty())
                        .cloned()
                        .or_else(|| user.map(str::to_string))
                        .unwrap_or_else(|| "Unknown".to_string())
                };

                let raw_text = source_text(msg);
                let enriched_text = enrich_mentions(&raw_text);

                // Prefix user messages with the sender's combined mention marker so
                // the agent always sees the canonical token for whoever is speaking.
                let content = match user {
                    Some(user) if !is_our_agent && !enriched_text.is_empty() => {
                        format!("<@{user}:{}>: {enriched_text}", sanitize_name(&sender_name))
                    }
                    _ => enriched_text,
                };

                // Prefer the stored DB createdAt for our own replies (a single, monotonic
                // server clock) so persisted internal steps interleave correctly against
                // them; fall back to the Slack ts for messages we never persisted (pre-join,
                // non-mention, or user messages).
                let created_at = is_our_agent
                    .then(|| maps.created_at_by_ts.get(&msg.ts).copied())
                    .flatten()
                    .unwrap_or_else(|| {
                        let ms = (parse_ts(&msg.ts) * 1000.0).trunc();
                        crate::support::from_ms(if ms.is_finite() { ms as i64 } else { 0 })
                    });

                // A reply we stored keeps its trigger, so a scheduled task's reply is not
                // read as an answer to the person.
                let stored_trigger = is_our_agent
                    .then(|| maps.trigger_by_ts.get(&msg.ts))
                    .flatten();

                ConversationMessage {
                    id: self.deterministic_id(thread_id, &msg.ts),
                    thread_id: thread_id.to_string(),
                    role: if is_our_agent {
                        MessageRole::Agent
                    } else {
                        MessageRole::User
                    },
                    content,
                    triggered_by: stored_trigger
                        .map(|t| t.triggered_by)
                        .unwrap_or(MessageTrigger::UserInput),
                    trigger_name: stored_trigger
                        .and_then(|t| t.trigger_name.clone())
                        .filter(|name| !name.is_empty()),
                    tool_calls: is_our_agent
                        .then(|| maps.tool_calls_by_ts.get(&msg.ts).cloned())
                        .flatten(),
                    blocks: None,
                    sender_external_id: user.map(str::to_string),
                    sender_name: if is_our_agent {
                        None
                    } else {
                        Some(sender_name)
                    },
                    external_message_id: Some(msg.ts.clone()),
                    is_compacted: false,
                    // Slack-derived rows are always delivered messages, never internal steps.
                    internal_step: false,
                    created_at,
                }
            })
            .collect())
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
        // Only delivered agent replies carry a ts (`externalMessageId`). This set is
        // disjoint from the concise internal steps merged in fetch_slack_messages
        // (those have externalMessageId == null) — keep it that way so no row is
        // replayed twice.
        let thread_id = thread_id.to_string();
        let rows: Vec<ConversationMessage> = crate::db::read(move |conn| {
            Ok(cm::conversation_messages
                .filter(cm::thread_id.eq(&thread_id))
                .filter(cm::role.eq(MessageRole::Agent))
                .filter(cm::external_message_id.is_not_null())
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await?;

        let mut maps = AgentMessageMaps::default();
        for row in rows {
            let Some(ts) = row.external_message_id.filter(|ts| !ts.is_empty()) else {
                continue;
            };
            maps.content_by_ts.insert(ts.clone(), row.content);
            maps.created_at_by_ts.insert(ts.clone(), row.created_at);
            maps.trigger_by_ts.insert(
                ts.clone(),
                StoredTrigger {
                    triggered_by: row.triggered_by,
                    trigger_name: row.trigger_name,
                },
            );
            if let Some(tool_calls) = row.tool_calls.filter(|calls| !calls.is_null()) {
                maps.tool_calls_by_ts.insert(ts, tool_calls);
            }
        }
        Ok(maps)
    }

    /// Resolve Slack user IDs to display names (`real_name`, else `name`) with an
    /// in-memory cache. A failed lookup is skipped; the caller falls back to the
    /// user ID.
    async fn resolve_user_names(
        &self,
        user_ids: &[String],
        team_id: &str,
    ) -> HashMap<String, String> {
        let mut names = HashMap::new();
        let now = crate::support::now_ms();

        // Collect cached names and determine which IDs need fetching
        let mut uncached_ids: Vec<&String> = Vec::new();
        for user_id in user_ids {
            match self.user_name_cache.get(user_id) {
                Some(cached) if cached.expires_at > now => {
                    names.insert(user_id.clone(), cached.name.clone());
                }
                _ => uncached_ids.push(user_id),
            }
        }

        if uncached_ids.is_empty() {
            return names;
        }

        let Some(app) = SLACK_ADAPTER_SERVICE.get_app_for_team(team_id).await else {
            return names;
        };

        let lookups = futures::future::join_all(uncached_ids.into_iter().map(|user_id| {
            let client = app.client.clone();
            async move {
                let result = client
                    .api_call("users.info", json!({ "user": user_id }))
                    .await;
                (user_id, result)
            }
        }))
        .await;

        for (user_id, result) in lookups {
            // A failed lookup is skipped — the caller falls back to the user ID.
            let Ok(result) = result else {
                continue;
            };
            let user = result.get("user");
            let display_name = [
                user.and_then(|u| u.get("real_name")),
                user.and_then(|u| u.get("name")),
            ]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|name| !name.is_empty());
            if let Some(display_name) = display_name {
                names.insert(user_id.clone(), display_name.to_string());
                self.user_name_cache.insert(
                    user_id.clone(),
                    CachedName {
                        name: display_name.to_string(),
                        expires_at: now + USER_NAME_CACHE_TTL_MS,
                    },
                );
            }
        }

        names
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
        self.fetch_slack_messages(thread_id, opts).await
    }

    /// The `limit` messages before `opts.before` (or the newest `limit`). An id the
    /// read does not hold reads no messages.
    async fn get_recent_messages(
        &self,
        thread_id: &str,
        limit: i64,
        opts: Option<&MessageReadOptions>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        let all_messages = self.fetch_slack_messages(thread_id, opts).await?;
        Ok(recent_window(
            all_messages,
            limit,
            opts.and_then(|o| o.before.as_deref()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::db::models::NewConversationMessage;
    use crate::db::testing::test_db;
    use crate::lib::slack_config::{
        __reset_slack_config_for_tests, SlackConnectionRecord, set_slack_config_for_tests,
    };
    use crate::lib::slack_web_client::testing::{FakeSlackApi, fake_slack_api};
    use crate::services::slack_adapter_service::testing::install_app;
    use crate::services::slack_mapping_service::testing::{
        channel_mapping, insert_agent, insert_mapping,
    };
    use crate::utils::poll_until::{NowFn, SleepFn};
    use parking_lot::Mutex;

    fn message(id: &str) -> ConversationMessage {
        ConversationMessage {
            id: id.into(),
            thread_id: "t".into(),
            role: MessageRole::User,
            content: String::new(),
            triggered_by: MessageTrigger::UserInput,
            trigger_name: None,
            tool_calls: None,
            blocks: None,
            sender_external_id: None,
            sender_name: None,
            external_message_id: None,
            is_compacted: false,
            internal_step: false,
            created_at: Utc::now(),
        }
    }

    fn ids(messages: &[ConversationMessage]) -> Vec<&str> {
        messages.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn reads_the_newest_messages_or_the_page_before_a_message() {
        let read: Vec<ConversationMessage> =
            ["m-1", "m-2", "m-3", "m-4", "m-5"].map(message).to_vec();
        assert_eq!(
            ids(&recent_window(read.clone(), 2, None)),
            vec!["m-4", "m-5"]
        );
        assert_eq!(
            ids(&recent_window(read.clone(), 2, Some("m-4"))),
            vec!["m-2", "m-3"]
        );
        assert_eq!(
            ids(&recent_window(read.clone(), 2, Some("m-2"))),
            vec!["m-1"]
        );
    }

    #[test]
    fn reads_no_messages_before_a_message_the_thread_does_not_hold() {
        let read: Vec<ConversationMessage> = ["m-1", "m-2"].map(message).to_vec();
        assert!(recent_window(read, 2, Some("gone")).is_empty());
    }

    #[test]
    fn ids_are_stable_and_uuid_shaped() {
        let provider = SlackThreadProvider::new();
        let id = provider.deterministic_id("thread-1", "100.1");
        assert_eq!(id, provider.deterministic_id("thread-1", "100.1"));
        assert_eq!(
            id.split('-').map(str::len).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
    }

    fn connection() -> SlackConnectionRecord {
        SlackConnectionRecord {
            id: "T1".into(),
            team_id: "T1".into(),
            team_name: "Team".into(),
            bot_token: "xoxb".into(),
            bot_id: "B1".into(),
            bot_user_id: "UBOT".into(),
            installed_at: crate::support::now_iso(),
            is_active: true,
        }
    }

    /// A Slack thread `thread-1` bound to channel C1 at ts 100.1, with a mapping
    /// for the channel and the connection installed.
    fn slack_thread(external: bool) {
        insert_agent("agent-1", "owner", "Agent");
        insert_mapping(channel_mapping("agent-1", "C1", 1_000));
        let mut thread = crate::db::models::NewConversationThread::new("agent-1", "owner");
        thread.id = "thread-1".into();
        if external {
            thread.external_channel_id = Some("C1".into());
            thread.external_thread_id = Some("100.1".into());
        }
        crate::db::run_sync(move |conn| {
            diesel::insert_into(ct::conversation_threads)
                .values(&thread)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    fn no_sleep() -> SleepFn {
        Arc::new(|_ms| Box::pin(async {}))
    }

    async fn replies_api(pages: Vec<Value>) -> FakeSlackApi {
        let pages = Arc::new(Mutex::new(pages));
        fake_slack_api(Arc::new(move |method, _| {
            if method != "conversations.replies" {
                return (200, json!({ "ok": true }));
            }
            let mut pages = pages.lock();
            let page = if pages.len() > 1 {
                pages.remove(0)
            } else {
                pages[0].clone()
            };
            (200, json!({ "ok": true, "messages": page }))
        }))
        .await
    }

    fn reply(ts: &str) -> Value {
        json!({ "ts": ts, "user": "U1", "text": "hi" })
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolves_at_once_with_a_windowed_read_when_the_message_is_there() {
        let _db = test_db();
        set_slack_config_for_tests(Some(connection()));
        slack_thread(true);
        let api = replies_api(vec![json!([reply("100.1"), reply("100.2")])]).await;
        let _app = install_app("T1", &api.url);
        let result = SlackThreadProvider::new()
            .wait_for_external_message(
                "thread-1",
                "100.2",
                PollUntilOptions {
                    sleep: Some(no_sleep()),
                    ..Default::default()
                },
            )
            .await;
        __reset_slack_config_for_tests();
        result.unwrap();
        let calls = api.calls("conversations.replies");
        assert_eq!(calls.len(), 1);
        // Windowed to ts >= externalTs (the newest message) — no full-thread scan.
        assert_eq!(calls[0].field("oldest").as_deref(), Some("100.2"));
        assert_eq!(calls[0].field("inclusive").as_deref(), Some("true"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn polls_until_an_eventually_consistent_message_appears() {
        let _db = test_db();
        set_slack_config_for_tests(Some(connection()));
        slack_thread(true);
        let api = replies_api(vec![
            json!([reply("100.1")]),
            json!([reply("100.1"), reply("100.2")]),
        ])
        .await;
        let _app = install_app("T1", &api.url);
        let result = SlackThreadProvider::new()
            .wait_for_external_message(
                "thread-1",
                "100.2",
                PollUntilOptions {
                    sleep: Some(no_sleep()),
                    base_delay_ms: Some(1),
                    ..Default::default()
                },
            )
            .await;
        __reset_slack_config_for_tests();
        result.unwrap();
        assert_eq!(api.calls("conversations.replies").len(), 2);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_when_the_message_never_appears_within_the_budget() {
        let _db = test_db();
        set_slack_config_for_tests(Some(connection()));
        slack_thread(true);
        let api = replies_api(vec![json!([reply("100.1")])]).await;
        let _app = install_app("T1", &api.url);
        let clock = Arc::new(Mutex::new(0i64));
        let (sleep_clock, now_clock) = (clock.clone(), clock.clone());
        let sleep: SleepFn = Arc::new(move |ms| {
            *sleep_clock.lock() += ms;
            Box::pin(async {})
        });
        let now: NowFn = Arc::new(move || *now_clock.lock());
        let result = SlackThreadProvider::new()
            .wait_for_external_message(
                "thread-1",
                "999.9",
                PollUntilOptions {
                    sleep: Some(sleep),
                    now: Some(now),
                    base_delay_ms: Some(100),
                    max_delay_ms: Some(200),
                    timeout_ms: Some(500),
                },
            )
            .await;
        __reset_slack_config_for_tests();
        let err = result.unwrap_err();
        assert!(err.to_string().contains("999.9"), "{err}");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolves_the_workspace_of_a_threaded_dm_by_its_dm_channel() {
        let _db = test_db();
        set_slack_config_for_tests(Some(connection()));
        insert_agent("agent-1", "owner", "Agent");
        let mut dm = crate::db::models::NewSlackMapping::new("T1", "agent-1");
        dm.slack_user_id = Some("U1".into());
        dm.dm_channel_id = Some("D1".into());
        insert_mapping(dm);
        let resolved = SlackThreadProvider::new()
            .resolve_slack_thread("thread-1", "D1", "100.1")
            .await;
        let missing = SlackThreadProvider::new()
            .resolve_slack_thread("thread-1", "C-none", "100.1")
            .await;
        __reset_slack_config_for_tests();
        assert_eq!(resolved.unwrap().team_id, "T1");
        assert_eq!(
            missing.unwrap_err().to_string(),
            "No SlackMapping found for channel C-none (thread thread-1)"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn does_not_poll_when_the_thread_is_not_a_slack_thread() {
        let _db = test_db();
        slack_thread(false);
        SlackThreadProvider::new()
            .wait_for_external_message("thread-1", "100.2", PollUntilOptions::default())
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn maps_the_thread_with_stored_replies_names_and_internal_steps() {
        let _db = test_db();
        set_slack_config_for_tests(Some(connection()));
        slack_thread(true);
        // The agent's delivered reply, stored with its newlines and a trigger.
        let mut stored = NewConversationMessage::new(
            "thread-1",
            MessageRole::Agent,
            "line one\nline two",
            MessageTrigger::CronTask,
        );
        stored.external_message_id = Some("100.2".into());
        stored.created_at = crate::support::from_ms(100_200).into();
        // An internal step written before the reply.
        let mut step = NewConversationMessage::new(
            "thread-1",
            MessageRole::Agent,
            "thinking",
            MessageTrigger::UserInput,
        );
        step.internal_step = true;
        step.created_at = crate::support::from_ms(100_150).into();
        crate::db::run_sync(move |conn| {
            diesel::insert_into(cm::conversation_messages)
                .values(&vec![stored, step])
                .execute(conn)?;
            Ok(())
        })
        .unwrap();

        let api = fake_slack_api(Arc::new(|method, _| match method {
            "conversations.replies" => (
                200,
                json!({ "ok": true, "messages": [
                    { "ts": "100.1", "user": "U1", "text": "hey <@U2> look" },
                    { "ts": "100.2", "user": "UBOT", "text": "line one line two" },
                ] }),
            ),
            "users.info" => (
                200,
                json!({ "ok": true, "user": { "real_name": "Ann: Lee" } }),
            ),
            _ => (200, json!({ "ok": true })),
        }))
        .await;
        let _app = install_app("T1", &api.url);
        let messages = SlackThreadProvider::new()
            .get_messages("thread-1", None)
            .await;
        let client = SlackThreadProvider::new()
            .get_messages(
                "thread-1",
                Some(&MessageReadOptions {
                    view: Some(MessageView::Client),
                    before: None,
                }),
            )
            .await;
        __reset_slack_config_for_tests();
        let messages = messages.unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec![
                "<@U1:Ann Lee>: hey <@U2:Ann Lee> look",
                "thinking",
                "line one\nline two"
            ]
        );
        assert_eq!(messages[0].sender_name.as_deref(), Some("Ann: Lee"));
        assert_eq!(messages[2].role, MessageRole::Agent);
        assert_eq!(messages[2].triggered_by, MessageTrigger::CronTask);
        assert_eq!(messages[2].sender_name, None);
        assert_eq!(client.unwrap().len(), 2);
    }
}
