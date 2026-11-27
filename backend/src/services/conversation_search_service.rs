//! Conversation search: finds what was said in the agent's conversations, on every
//! surface, and reads a conversation by position.
//!
//! A conversation whose history a channel keeps holds its person messages in the
//! channel. [`ConversationSearchService::record_channel_messages`] keeps a copy of
//! each one a history read returns (`channel_messages`). From the time of a
//! conversation's first copy, the copies stand in for its stored person messages, in
//! a search (`lib::message_search_index::search`) and in a read here, so each message
//! appears once and with the text it has now.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Instant;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use indexmap::IndexMap;
use serde_json::Value;

use crate::db::models::{ChannelMessage, ConversationMessage, MessageRole, NewChannelMessage};
use crate::db::schema::channel_messages::dsl as c;
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::db::sql_types::DbDateTime;
use crate::lib::message_search_index::{self, IndexHit, IndexQuery, fts_query};
use crate::lib::telemetry::track_event;

/// A message of a conversation as a search or a read returns it, and its index among
/// the conversation's messages, oldest first.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub tool_calls: Option<Value>,
    pub internal_step: bool,
    pub sender_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub position: i64,
}

/// One page of a conversation's messages, and whether more follow.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryPage {
    pub messages: Vec<HistoryMessage>,
    pub more: bool,
}

/// What [`ConversationSearchService::search`] looks for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchOptions {
    pub query: String,
    /// The agent whose conversations are searched.
    pub agent_id: String,
    pub thread_id: Option<String>,
    /// Inclusive, epoch milliseconds.
    pub after_ms: Option<i64>,
    /// Exclusive, epoch milliseconds.
    pub before_ms: Option<i64>,
    pub limit: i64,
    /// For the telemetry event.
    pub user_id: Option<String>,
}

/// A message the search found.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchMatch {
    pub thread_id: String,
    pub conversation_title: Option<String>,
    pub message: HistoryMessage,
    pub excerpt: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchOutcome {
    pub matches: Vec<SearchMatch>,
    /// No message held every word, and these hold at least one.
    pub any_word: bool,
    /// The query held no word to search for.
    pub no_words: bool,
}

/// Which messages a read holds: the stored rows of the indexed roles, and the
/// channel's copies from `channel_start` on in place of the person rows.
fn is_person_row(role: MessageRole, internal_step: bool) -> bool {
    role == MessageRole::User && !internal_step
}

const READ_ROLES: [MessageRole; 2] = [MessageRole::User, MessageRole::Agent];

type StoredRow = (
    String,
    MessageRole,
    String,
    Option<Value>,
    bool,
    Option<String>,
    DateTime<Utc>,
);

fn from_stored(row: StoredRow, position: i64) -> HistoryMessage {
    let (id, role, content, tool_calls, internal_step, sender_name, created_at) = row;
    HistoryMessage {
        id,
        role,
        content,
        tool_calls,
        internal_step,
        sender_name,
        created_at,
        position,
    }
}

fn from_channel(row: ChannelMessage, position: i64) -> HistoryMessage {
    HistoryMessage {
        id: row.id,
        role: MessageRole::User,
        content: row.content,
        tool_calls: None,
        internal_step: false,
        sender_name: row.sender_name,
        created_at: row.created_at,
        position,
    }
}

pub struct ConversationSearchService;

pub static CONVERSATION_SEARCH_SERVICE: LazyLock<ConversationSearchService> =
    LazyLock::new(|| ConversationSearchService);

impl ConversationSearchService {
    /// The best matches for `options.query`: first the messages that hold every word,
    /// and when none does, the messages that hold any of them.
    pub async fn search(&self, options: SearchOptions) -> anyhow::Result<SearchOutcome> {
        let started = Instant::now();
        let Some(all_words) = fts_query(&options.query, false) else {
            return Ok(SearchOutcome {
                no_words: true,
                ..SearchOutcome::default()
            });
        };
        let mut query = IndexQuery {
            matching: all_words,
            agent_id: options.agent_id.clone(),
            thread_id: options.thread_id.clone(),
            after_ms: options.after_ms,
            before_ms: options.before_ms,
            limit: options.limit,
        };
        let mut hits = run_index_query(query.clone()).await?;
        let mut any_word = false;
        if hits.is_empty()
            && let Some(any) = fts_query(&options.query, true).filter(|any| *any != query.matching)
        {
            query.matching = any;
            hits = run_index_query(query).await?;
            any_word = true;
        }
        let matches = self.hydrate(hits).await?;
        let any_word = any_word && !matches.is_empty();
        track_search(&options, matches.len(), any_word, started);
        Ok(SearchOutcome {
            matches,
            any_word,
            no_words: false,
        })
    }

    /// The matches with their messages, conversations and positions, in the index's order.
    async fn hydrate(&self, hits: Vec<IndexHit>) -> anyhow::Result<Vec<SearchMatch>> {
        if hits.is_empty() {
            return Ok(Vec::new());
        }
        let threads: Vec<String> = unique(hits.iter().map(|hit| hit.thread_id.clone()));
        let titles: HashMap<String, Option<String>> = {
            let ids = threads.clone();
            crate::db::read(move |conn| {
                Ok(t::conversation_threads
                    .filter(t::id.eq_any(ids))
                    .select((t::id, t::title))
                    .load::<(String, Option<String>)>(conn)?)
            })
            .await?
            .into_iter()
            .collect()
        };
        // A conversation with channel copies is read whole, which is how its positions
        // are known; the others count each message's position.
        let mut read_whole: HashMap<String, Vec<HistoryMessage>> = HashMap::new();
        for thread in &threads {
            if channel_start(thread).await?.is_some() {
                read_whole.insert(thread.clone(), self.read_all(thread).await?);
            }
        }
        let mut matches = Vec::new();
        for hit in hits {
            let Some(id) = hit.message_id.or(hit.channel_message_id) else {
                continue;
            };
            let message = match read_whole.get(&hit.thread_id) {
                Some(messages) => messages.iter().find(|message| message.id == id).cloned(),
                None => stored_with_position(&hit.thread_id, &id).await?,
            };
            let Some(message) = message else { continue };
            matches.push(SearchMatch {
                conversation_title: titles.get(&hit.thread_id).cloned().flatten(),
                thread_id: hit.thread_id,
                message,
                excerpt: hit.excerpt,
            });
        }
        Ok(matches)
    }

    /// The title of `agent_id`'s conversation `thread_id`, as `Some(title)`, or `None`
    /// when the agent has no conversation with that id.
    pub async fn conversation_title(
        &self,
        agent_id: &str,
        thread_id: &str,
    ) -> anyhow::Result<Option<Option<String>>> {
        let (agent, id) = (agent_id.to_string(), thread_id.to_string());
        crate::db::read(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .filter(t::agent_id.eq(agent))
                .select(t::title)
                .first::<Option<String>>(conn)
                .optional()?)
        })
        .await
    }

    /// The messages of `thread_id` from position `offset`, at most `limit`.
    pub async fn list_history(
        &self,
        thread_id: &str,
        offset: i64,
        limit: i64,
    ) -> anyhow::Result<HistoryPage> {
        let offset = offset.max(0);
        let mut messages = match channel_start(thread_id).await? {
            Some(_) => self
                .read_all(thread_id)
                .await?
                .into_iter()
                .skip(usize::try_from(offset).unwrap_or(0))
                .take(usize::try_from(limit + 1).unwrap_or(0))
                .collect(),
            None => read_stored(thread_id, offset, limit + 1).await?,
        };
        let more = messages.len() as i64 > limit;
        messages.truncate(usize::try_from(limit).unwrap_or(0));
        Ok(HistoryPage { messages, more })
    }

    /// The message at `position` of `thread_id`, or `None` past the last one.
    pub async fn get_history_message(
        &self,
        thread_id: &str,
        position: i64,
    ) -> anyhow::Result<Option<HistoryMessage>> {
        Ok(self
            .list_history(thread_id, position, 1)
            .await?
            .messages
            .into_iter()
            .next())
    }

    /// Every message of `thread_id`, in order.
    async fn read_all(&self, thread_id: &str) -> anyhow::Result<Vec<HistoryMessage>> {
        let Some(start) = channel_start(thread_id).await? else {
            return read_stored(thread_id, 0, i64::MAX).await;
        };
        let id = thread_id.to_string();
        let (stored, copies) = crate::db::read(move |conn| {
            let stored = load_stored(conn, &id, 0, i64::MAX)?
                .into_iter()
                .filter(|row| !(is_person_row(row.1, row.4) && row.6 >= start))
                .collect::<Vec<_>>();
            let copies = c::channel_messages
                .filter(c::thread_id.eq(&id))
                .order((c::created_at.asc(), c::id.asc()))
                .select(ChannelMessage::as_select())
                .load::<ChannelMessage>(conn)?;
            Ok((stored, copies))
        })
        .await?;
        let mut merged: Vec<HistoryMessage> = stored
            .into_iter()
            .map(|row| from_stored(row, 0))
            .chain(copies.into_iter().map(|row| from_channel(row, 0)))
            .collect();
        // Stable: a stored message stays ahead of a copy with the same time.
        merged.sort_by_key(|message| message.created_at);
        for (position, message) in merged.iter_mut().enumerate() {
            message.position = position as i64;
        }
        Ok(merged)
    }

    /// Keep a copy of each person message of `messages`, a history read of
    /// `thread_id` from the channel that keeps it: new ones are added, and an edited
    /// one takes its new text.
    pub async fn record_channel_messages(
        &self,
        thread_id: &str,
        messages: &[ConversationMessage],
    ) -> anyhow::Result<()> {
        let read: Vec<NewChannelMessage> = messages
            .iter()
            .filter(|message| is_person_row(message.role, message.internal_step))
            .filter_map(|message| {
                let external_id = message.external_message_id.clone()?;
                Some(NewChannelMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    thread_id: thread_id.to_string(),
                    external_message_id: external_id,
                    sender_external_id: message.sender_external_id.clone(),
                    sender_name: message.sender_name.clone(),
                    content: message.content.clone(),
                    created_at: DbDateTime(message.created_at),
                    updated_at: DbDateTime::now(),
                })
            })
            .collect();
        if read.is_empty() {
            return Ok(());
        }
        let id = thread_id.to_string();
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let kept: HashMap<String, (String, String)> = c::channel_messages
                    .filter(c::thread_id.eq(&id))
                    .select((c::external_message_id, c::id, c::content))
                    .load::<(String, String, String)>(conn)?
                    .into_iter()
                    .map(|(external_id, row_id, content)| (external_id, (row_id, content)))
                    .collect();
                for message in read {
                    match kept.get(&message.external_message_id) {
                        None => {
                            diesel::insert_into(c::channel_messages)
                                .values(&message)
                                .execute(conn)?;
                        }
                        Some((row_id, content)) if *content != message.content => {
                            diesel::update(c::channel_messages.find(row_id))
                                .set((
                                    c::content.eq(&message.content),
                                    c::sender_name.eq(&message.sender_name),
                                    c::updated_at.eq(DbDateTime::now()),
                                ))
                                .execute(conn)?;
                        }
                        Some(_) => {}
                    }
                }
                Ok(())
            })
        })
        .await
    }
}

async fn run_index_query(query: IndexQuery) -> anyhow::Result<Vec<IndexHit>> {
    crate::db::read(move |conn| message_search_index::search(conn, &query)).await
}

/// The time of the conversation's first channel copy, from which copies replace its
/// stored person messages; `None` when it has none.
async fn channel_start(thread_id: &str) -> anyhow::Result<Option<DateTime<Utc>>> {
    let id = thread_id.to_string();
    crate::db::read(move |conn| {
        Ok(c::channel_messages
            .filter(c::thread_id.eq(id))
            .order(c::created_at.asc())
            .select(c::created_at)
            .first::<DateTime<Utc>>(conn)
            .optional()?)
    })
    .await
}

/// Up to `limit` stored messages of a conversation in read order, after `offset`.
fn load_stored(
    conn: &mut SqliteConnection,
    thread_id: &str,
    offset: i64,
    limit: i64,
) -> QueryResult<Vec<StoredRow>> {
    m::conversation_messages
        .filter(m::thread_id.eq(thread_id))
        .filter(m::role.eq_any(READ_ROLES))
        .order((m::created_at.asc(), m::id.asc()))
        .offset(offset)
        .limit(limit)
        .select(STORED_COLUMNS)
        .load::<StoredRow>(conn)
}

const STORED_COLUMNS: (
    m::id,
    m::role,
    m::content,
    m::tool_calls,
    m::internal_step,
    m::sender_name,
    m::created_at,
) = (
    m::id,
    m::role,
    m::content,
    m::tool_calls,
    m::internal_step,
    m::sender_name,
    m::created_at,
);

/// A stored message of a conversation without channel copies, with its position:
/// the number of messages before it in read order. The count compares the time the
/// runtime wrote; a row that holds the column's text default instead counts as
/// after every written time, as SQLite orders it, which only rows older than the
/// runtime hold.
async fn stored_with_position(
    thread_id: &str,
    message_id: &str,
) -> anyhow::Result<Option<HistoryMessage>> {
    let (thread, id) = (thread_id.to_string(), message_id.to_string());
    crate::db::read(move |conn| {
        let Some(row) = m::conversation_messages
            .filter(m::id.eq(&id))
            .filter(m::thread_id.eq(&thread))
            .select(STORED_COLUMNS)
            .first::<StoredRow>(conn)
            .optional()?
        else {
            return Ok(None);
        };
        let at = DbDateTime(row.6);
        let before: i64 = m::conversation_messages
            .filter(m::thread_id.eq(&thread))
            .filter(m::role.eq_any(READ_ROLES))
            .filter(
                m::created_at
                    .lt(at)
                    .or(m::created_at.eq(at).and(m::id.lt(&id))),
            )
            .count()
            .get_result(conn)?;
        Ok(Some(from_stored(row, before)))
    })
    .await
}

/// The stored messages of a conversation without channel copies, from `offset`.
async fn read_stored(
    thread_id: &str,
    offset: i64,
    limit: i64,
) -> anyhow::Result<Vec<HistoryMessage>> {
    let id = thread_id.to_string();
    let rows = crate::db::read(move |conn| Ok(load_stored(conn, &id, offset, limit)?)).await?;
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(i, row)| from_stored(row, offset + i as i64))
        .collect())
}

fn unique(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

/// `conversations searched`, once per search.
fn track_search(options: &SearchOptions, results: usize, any_word: bool, started: Instant) {
    let mut props = IndexMap::new();
    if !options.agent_id.is_empty() {
        props.insert("agent.id".to_string(), options.agent_id.clone());
    }
    props.insert("search.results".to_string(), results.to_string());
    props.insert("search.any_word".to_string(), any_word.to_string());
    props.insert(
        "search.scope".to_string(),
        if options.thread_id.is_some() {
            "conversation"
        } else {
            "all"
        }
        .to_string(),
    );
    props.insert(
        "search.elapsed_ms".to_string(),
        started.elapsed().as_millis().to_string(),
    );
    track_event(
        "conversations searched",
        options.user_id.as_deref(),
        Some(props),
    );
}

#[cfg(test)]
#[path = "conversation_search_service_tests.rs"]
mod tests;
