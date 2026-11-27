//! Conversation search: finds what was said in the agent's conversations, on every
//! surface, and reads a conversation by position.
//!
//! A conversation whose history a channel keeps holds its person messages in the
//! channel. [`ConversationSearchService::record_channel_messages`] keeps a copy of
//! each one a history read returns (`channel_messages`), and blanks the copy of one
//! the channel no longer holds. A copy stands in for the stored person messages a
//! read held ([`CopySpan`]), in a search (`lib::message_search_index::search`) and in
//! a read here, so each message appears once and with the text it has now.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Instant;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sql_types::{Bool, Nullable, Text};
use diesel::sqlite::{Sqlite, SqliteConnection};
use indexmap::IndexMap;
use serde_json::Value;

use crate::db::models::{ChannelMessage, ConversationMessage, MessageRole, NewChannelMessage};
use crate::db::schema::channel_messages::dsl as c;
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::db::sql_types::{DbDateTime, PrismaDateTime};
use crate::lib::message_search_index::{self, IndexHit, IndexQuery, fts_query, query_words};
use crate::lib::telemetry::track_event;
use crate::services::generated_ui::generated_ui_service::PRESS_TRIGGER_NAME;
use crate::support::js::stringify;

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

/// Which conversations a run may search and read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SearchScope {
    /// Every conversation of the agent: a run on the owner's own surfaces.
    #[default]
    All,
    /// The conversations held in one channel (`externalChannelId`), and the run's
    /// own: a run whose audience is that channel's members.
    Channel(String),
    /// Only the run's own conversation: a voice meeting or a webhook run.
    Current,
}

/// What [`ConversationSearchService::search`] looks for.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchOptions {
    pub query: String,
    /// The agent whose conversations are searched.
    pub agent_id: String,
    /// Only the conversations of this channel, and `current_thread_id`.
    pub channel_id: Option<String>,
    pub current_thread_id: Option<String>,
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

/// A conversation a run may read.
#[derive(Debug, Clone, PartialEq)]
pub struct Conversation {
    pub title: Option<String>,
    /// Where the conversation's runs work, which says where their saved tool
    /// outputs are.
    pub workspace_root: Option<String>,
}

/// A message a person typed; a channel copy replaces it.
fn is_person_row(role: MessageRole, internal_step: bool) -> bool {
    role == MessageRole::User && !internal_step
}

const READ_ROLES: [MessageRole; 2] = [MessageRole::User, MessageRole::Agent];

/// The span of a conversation's channel copies: from the first copy's time up to
/// the last time a read recorded a copy. A read made after a person message was
/// stored held that message, so in this span the copies replace the stored person
/// messages. One stored after the last read stays until a read copies it, and a
/// button press stays, since the channel holds no message for it.
#[derive(Debug, Clone, Copy)]
struct CopySpan {
    start: DateTime<Utc>,
    recorded: DateTime<Utc>,
}

impl CopySpan {
    fn replaces(&self, row: &OrderRow) -> bool {
        is_person_row(row.1, row.2)
            && row.3.as_deref() != Some(PRESS_TRIGGER_NAME)
            && self.start <= row.4
            && row.4 <= self.recorded
    }
}

/// The ordering columns of a stored message: id, role, internal step, trigger
/// name, time.
type OrderRow = (String, MessageRole, bool, Option<String>, DateTime<Utc>);

/// A message's place in a conversation with copies.
#[derive(Debug, Clone)]
struct Slot {
    id: String,
    copy: bool,
    position: i64,
}

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
    /// and when none does, the messages that hold any of them. A search of one
    /// conversation also matches its tool results, after the index's matches.
    /// Reports `conversations searched` whether it succeeds or fails.
    pub async fn search(&self, options: SearchOptions) -> anyhow::Result<SearchOutcome> {
        let started = Instant::now();
        let outcome = self.find(&options).await;
        match &outcome {
            Ok(found) if found.no_words => {}
            Ok(found) => track_search(&options, Some(found), started),
            Err(_) => track_search(&options, None, started),
        }
        outcome
    }

    async fn find(&self, options: &SearchOptions) -> anyhow::Result<SearchOutcome> {
        let Some(all_words) = fts_query(&options.query, false) else {
            return Ok(SearchOutcome {
                no_words: true,
                ..SearchOutcome::default()
            });
        };
        let words: Vec<String> = query_words(&options.query)
            .into_iter()
            .map(str::to_string)
            .collect();
        let mut query = IndexQuery {
            matching: all_words,
            agent_id: options.agent_id.clone(),
            channel_id: options.channel_id.clone(),
            current_thread_id: options.current_thread_id.clone(),
            thread_id: options.thread_id.clone(),
            after_ms: options.after_ms,
            before_ms: options.before_ms,
            limit: options.limit,
        };
        let mut hits = run_index_query(query.clone()).await?;
        add_output_hits(&mut hits, options, &words, false).await?;
        let mut any_word = false;
        if hits.is_empty()
            && let Some(any) = fts_query(&options.query, true).filter(|any| *any != query.matching)
        {
            query.matching = any;
            hits = run_index_query(query).await?;
            add_output_hits(&mut hits, options, &words, true).await?;
            any_word = true;
        }
        let matches = self.hydrate(hits).await?;
        let any_word = any_word && !matches.is_empty();
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
        // A conversation with channel copies numbers its messages from their ordering
        // columns, then loads only the matched ones; the others count each match's
        // position.
        let mut ordered: HashMap<String, HashMap<String, Slot>> = HashMap::new();
        for thread in &threads {
            if let Some(span) = copy_span(thread).await? {
                let slots = copy_order(thread, span).await?;
                ordered.insert(
                    thread.clone(),
                    slots
                        .into_iter()
                        .map(|slot| (slot.id.clone(), slot))
                        .collect(),
                );
            }
        }
        let wanted: Vec<Slot> = hits
            .iter()
            .filter_map(|hit| {
                let id = hit
                    .message_id
                    .as_ref()
                    .or(hit.channel_message_id.as_ref())?;
                ordered.get(&hit.thread_id)?.get(id).cloned()
            })
            .collect();
        let mut loaded: HashMap<String, HistoryMessage> = load_slots(wanted)
            .await?
            .into_iter()
            .map(|message| (message.id.clone(), message))
            .collect();
        let mut matches = Vec::new();
        for hit in hits {
            let Some(id) = hit.message_id.or(hit.channel_message_id) else {
                continue;
            };
            let message = if ordered.contains_key(&hit.thread_id) {
                loaded.remove(&id)
            } else {
                stored_with_position(&hit.thread_id, &id).await?
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

    /// `agent_id`'s conversation `thread_id`, or `None` when the agent has no
    /// conversation with that id that `scope` lets a run in `current` read.
    pub async fn conversation(
        &self,
        agent_id: &str,
        thread_id: &str,
        scope: &SearchScope,
        current: Option<&str>,
    ) -> anyhow::Result<Option<Conversation>> {
        let is_current = current == Some(thread_id);
        let channel = match scope {
            SearchScope::Current if !is_current => return Ok(None),
            SearchScope::Channel(channel) if !is_current => Some(channel.clone()),
            _ => None,
        };
        let (agent, id) = (agent_id.to_string(), thread_id.to_string());
        let found = crate::db::read(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .filter(t::agent_id.eq(agent))
                .select((t::title, t::workspace_root, t::external_channel_id))
                .first::<(Option<String>, Option<String>, Option<String>)>(conn)
                .optional()?)
        })
        .await?;
        Ok(found
            .filter(|(_, _, held_in)| channel.is_none() || *held_in == channel)
            .map(|(title, workspace_root, _)| Conversation {
                title,
                workspace_root,
            }))
    }

    /// The channel that holds conversation `thread_id` (`externalChannelId`), if one does.
    pub async fn conversation_channel(&self, thread_id: &str) -> anyhow::Result<Option<String>> {
        let id = thread_id.to_string();
        Ok(crate::db::read(move |conn| {
            Ok(t::conversation_threads
                .filter(t::id.eq(id))
                .select(t::external_channel_id)
                .first::<Option<String>>(conn)
                .optional()?)
        })
        .await?
        .flatten())
    }

    /// The messages of `thread_id` from position `offset`, at most `limit`.
    pub async fn list_history(
        &self,
        thread_id: &str,
        offset: i64,
        limit: i64,
    ) -> anyhow::Result<HistoryPage> {
        let offset = offset.max(0);
        let mut messages = match copy_span(thread_id).await? {
            Some(span) => {
                let page = copy_order(thread_id, span)
                    .await?
                    .into_iter()
                    .skip(usize::try_from(offset).unwrap_or(0))
                    .take(usize::try_from(limit + 1).unwrap_or(0))
                    .collect();
                load_slots(page).await?
            }
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

    /// Keep a copy of each person message of `messages`, a history read of
    /// `thread_id` from the channel that keeps it: new ones are added, an edited one
    /// takes its new text, and one the channel no longer holds loses its text. A
    /// copy is left as it is when it is outside the read's time span, as a windowed
    /// read leaves older messages out. A blanked copy keeps its row, so the span of
    /// the copies, which hides the stored person messages, does not change.
    pub async fn record_channel_messages(
        &self,
        thread_id: &str,
        messages: &[ConversationMessage],
    ) -> anyhow::Result<()> {
        let (Some(first), Some(last)) = (
            messages.iter().map(|message| message.created_at).min(),
            messages.iter().map(|message| message.created_at).max(),
        ) else {
            return Ok(());
        };
        let held: HashSet<String> = messages
            .iter()
            .filter_map(|message| message.external_message_id.clone())
            .collect();
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
        let id = thread_id.to_string();
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let kept: Vec<(String, String, String, DateTime<Utc>)> = c::channel_messages
                    .filter(c::thread_id.eq(&id))
                    .select((c::external_message_id, c::id, c::content, c::created_at))
                    .load(conn)?;
                let by_external_id: HashMap<&str, (&str, &str)> = kept
                    .iter()
                    .map(|(external_id, row_id, content, _)| {
                        (external_id.as_str(), (row_id.as_str(), content.as_str()))
                    })
                    .collect();
                for message in &read {
                    match by_external_id.get(message.external_message_id.as_str()) {
                        None => {
                            diesel::insert_into(c::channel_messages)
                                .values(message)
                                .execute(conn)?;
                        }
                        Some((row_id, content)) if *content != message.content => {
                            diesel::update(c::channel_messages.find(*row_id))
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
                let gone: Vec<&str> = kept
                    .iter()
                    .filter(|(external_id, _, content, at)| {
                        !content.is_empty()
                            && first <= *at
                            && *at <= last
                            && !held.contains(external_id)
                    })
                    .map(|(_, row_id, _, _)| row_id.as_str())
                    .collect();
                if !gone.is_empty() {
                    diesel::update(c::channel_messages.filter(c::id.eq_any(gone)))
                        .set(c::content.eq(""))
                        .execute(conn)?;
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

/// The span of the conversation's channel copies; `None` when it has none.
async fn copy_span(thread_id: &str) -> anyhow::Result<Option<CopySpan>> {
    let id = thread_id.to_string();
    crate::db::read(move |conn| {
        let start = c::channel_messages
            .filter(c::thread_id.eq(&id))
            .order(c::created_at.asc())
            .select(c::created_at)
            .first::<DateTime<Utc>>(conn)
            .optional()?;
        let recorded = c::channel_messages
            .filter(c::thread_id.eq(&id))
            .order(c::updated_at.desc())
            .select(c::updated_at)
            .first::<DateTime<Utc>>(conn)
            .optional()?;
        Ok(start
            .zip(recorded)
            .map(|(start, recorded)| CopySpan { start, recorded }))
    })
    .await
}

/// Which messages a read of a conversation with copies holds, in order: the stored
/// messages of the read roles that the copies do not replace, and the copies that
/// hold text. Numbered from the ordering columns alone; [`load_slots`] loads the
/// messages a caller needs.
async fn copy_order(thread_id: &str, span: CopySpan) -> anyhow::Result<Vec<Slot>> {
    let id = thread_id.to_string();
    let (stored, copies) = crate::db::read(move |conn| {
        let stored = m::conversation_messages
            .filter(m::thread_id.eq(&id))
            .filter(m::role.eq_any(READ_ROLES))
            .order((m::created_at.asc(), m::id.asc()))
            .select((
                m::id,
                m::role,
                m::internal_step,
                m::trigger_name,
                m::created_at,
            ))
            .load::<OrderRow>(conn)?;
        let copies = c::channel_messages
            .filter(c::thread_id.eq(&id))
            .filter(c::content.ne(""))
            .order((c::created_at.asc(), c::id.asc()))
            .select((c::id, c::created_at))
            .load::<(String, DateTime<Utc>)>(conn)?;
        Ok((stored, copies))
    })
    .await?;
    let mut merged: Vec<(DateTime<Utc>, String, bool)> = stored
        .into_iter()
        .filter(|row| !span.replaces(row))
        .map(|(id, _, _, _, at)| (at, id, false))
        .chain(copies.into_iter().map(|(id, at)| (at, id, true)))
        .collect();
    // Stable: a stored message stays ahead of a copy with the same time.
    merged.sort_by_key(|(at, _, _)| *at);
    Ok(merged
        .into_iter()
        .enumerate()
        .map(|(position, (_, id, copy))| Slot {
            id,
            copy,
            position: position as i64,
        })
        .collect())
}

/// The messages of `slots`, in their order.
async fn load_slots(slots: Vec<Slot>) -> anyhow::Result<Vec<HistoryMessage>> {
    if slots.is_empty() {
        return Ok(Vec::new());
    }
    let stored_ids: Vec<String> = slots
        .iter()
        .filter(|slot| !slot.copy)
        .map(|slot| slot.id.clone())
        .collect();
    let copy_ids: Vec<String> = slots
        .iter()
        .filter(|slot| slot.copy)
        .map(|slot| slot.id.clone())
        .collect();
    let (stored, copies) = crate::db::read(move |conn| {
        let stored = m::conversation_messages
            .filter(m::id.eq_any(stored_ids))
            .select(STORED_COLUMNS)
            .load::<StoredRow>(conn)?;
        let copies = c::channel_messages
            .filter(c::id.eq_any(copy_ids))
            .select(ChannelMessage::as_select())
            .load::<ChannelMessage>(conn)?;
        Ok((stored, copies))
    })
    .await?;
    let mut stored: HashMap<String, StoredRow> =
        stored.into_iter().map(|row| (row.0.clone(), row)).collect();
    let mut copies: HashMap<String, ChannelMessage> = copies
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();
    Ok(slots
        .into_iter()
        .filter_map(|slot| {
            if slot.copy {
                copies
                    .remove(&slot.id)
                    .map(|row| from_channel(row, slot.position))
            } else {
                stored
                    .remove(&slot.id)
                    .map(|row| from_stored(row, slot.position))
            }
        })
        .collect())
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
/// the number of messages before it in read order. The count compares the stored
/// values as `ORDER BY "createdAt", "id"` does, so a row that holds the column's
/// text default, which only rows older than the runtime hold, counts where the
/// read puts it: after every time the runtime wrote.
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
        let target = diesel::alias!(crate::db::schema::conversation_messages as target);
        let before = m::conversation_messages
            .inner_join(target.on(target.field(m::thread_id).eq(m::thread_id)))
            .filter(target.field(m::id).eq(&id))
            .filter(m::role.eq_any(READ_ROLES))
            .filter(
                m::created_at
                    .lt(target.field(m::created_at))
                    .or(m::created_at
                        .eq(target.field(m::created_at))
                        .and(m::id.lt(target.field(m::id)))),
            )
            .count()
            .get_result::<i64>(conn)?;
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

/// The candidates a search of one conversation reads tool results from at a time.
const OUTPUT_PAGE: i64 = 50;

/// The characters of a tool-result excerpt before and after the match.
const OUTPUT_EXCERPT_BEFORE: usize = 80;
const OUTPUT_EXCERPT_AFTER: usize = 240;

/// Add to `hits`, up to the search's limit, the messages of the one conversation
/// the search names whose tool results hold the query's words (any of them with
/// `any_word`), newest first. The index holds no tool result, so this reads them.
async fn add_output_hits(
    hits: &mut Vec<IndexHit>,
    options: &SearchOptions,
    words: &[String],
    any_word: bool,
) -> anyhow::Result<()> {
    let Some(thread_id) = options.thread_id.clone() else {
        return Ok(());
    };
    let room = usize::try_from(options.limit)
        .unwrap_or(0)
        .saturating_sub(hits.len());
    if room == 0 || words.is_empty() {
        return Ok(());
    }
    let found: HashSet<String> = hits
        .iter()
        .filter_map(|hit| hit.message_id.clone())
        .collect();
    // A cheap first pass on the stored JSON; the match below reads the results.
    let patterns: Vec<String> = words
        .iter()
        .map(|word| {
            let escaped = word
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            format!("%{escaped}%")
        })
        .collect();
    let after = options.after_ms.and_then(DateTime::from_timestamp_millis);
    let before = options.before_ms.and_then(DateTime::from_timestamp_millis);
    let lowered: Vec<Vec<char>> = words.iter().map(|word| lower_chars(word)).collect();
    let mut page_end: Option<PageEnd> = None;
    loop {
        let (thread, patterns, end) = (thread_id.clone(), patterns.clone(), page_end.take());
        let rows = crate::db::read(move |conn| {
            Ok(tool_call_candidates(
                conn,
                &thread,
                &patterns,
                any_word,
                after,
                before,
                end.as_ref(),
            )?)
        })
        .await?;
        let last_page = (rows.len() as i64) < OUTPUT_PAGE;
        page_end = rows.last().map(PageEnd::of);
        for row in rows {
            if hits.len() >= usize::try_from(options.limit).unwrap_or(0) {
                return Ok(());
            }
            // The query lets every row with the text default through the bounds.
            let outside = after.is_some_and(|after| row.created_at < after)
                || before.is_some_and(|before| row.created_at >= before);
            if outside || found.contains(&row.id) {
                continue;
            }
            let Some(excerpt) =
                output_excerpt(&tool_results(row.tool_calls.as_ref()), &lowered, any_word)
            else {
                continue;
            };
            hits.push(IndexHit {
                message_id: Some(row.id),
                channel_message_id: None,
                thread_id: thread_id.clone(),
                created_at_ms: row.created_at.timestamp_millis(),
                automated: false,
                excerpt,
            });
        }
        if last_page {
            return Ok(());
        }
    }
}

diesel::define_sql_function! {
    /// SQLite's `typeof`: how a value is stored (`'integer'`, `'text'`, ...).
    #[sql_name = "typeof"]
    fn stored_type(value: PrismaDateTime) -> Text;
}

/// An agent message whose stored tool calls may hold the words.
#[derive(Queryable)]
struct ToolCallCandidate {
    id: String,
    created_at: DateTime<Utc>,
    tool_calls: Option<Value>,
    /// `typeof("createdAt")`.
    stored_type: String,
    /// `"createdAt"` as text: the column's text default on rows older than the runtime.
    stored_text: String,
}

/// The ordering keys of the last candidate a page read, so the next page starts
/// after it. A row that holds the column's text default keeps that text, because
/// SQLite orders every text above every number the runtime wrote.
struct PageEnd {
    created_at: StoredTime,
    id: String,
}

enum StoredTime {
    Written(DateTime<Utc>),
    Default(String),
}

impl PageEnd {
    fn of(row: &ToolCallCandidate) -> PageEnd {
        let created_at = if row.stored_type == "text" {
            StoredTime::Default(row.stored_text.clone())
        } else {
            StoredTime::Written(row.created_at)
        };
        PageEnd {
            created_at,
            id: row.id.clone(),
        }
    }
}

/// One page, newest first and after `page_end`, of a conversation's agent messages
/// in the time bounds whose stored tool calls hold the patterns (any of them with
/// `any_word`): a cheap first pass on the JSON text before the results are read.
fn tool_call_candidates(
    conn: &mut SqliteConnection,
    thread_id: &str,
    patterns: &[String],
    any_word: bool,
    after: Option<DateTime<Utc>>,
    before: Option<DateTime<Utc>>,
    page_end: Option<&PageEnd>,
) -> QueryResult<Vec<ToolCallCandidate>> {
    type Condition =
        Box<dyn BoxableExpression<m::conversation_messages, Sqlite, SqlType = Nullable<Bool>>>;
    let like = |pattern: &String| -> Condition {
        Box::new(
            m::tool_calls
                .cast::<Nullable<Text>>()
                .like(pattern.clone())
                .escape('\\'),
        )
    };
    let mut query = m::conversation_messages
        .filter(m::thread_id.eq(thread_id))
        .filter(m::role.eq(MessageRole::Agent))
        .filter(m::tool_calls.is_not_null())
        .into_boxed();
    if any_word {
        if let Some(matched) = patterns
            .iter()
            .map(like)
            .reduce(|either, other| Box::new(either.or(other)))
        {
            query = query.filter(matched);
        }
    } else {
        for pattern in patterns {
            query = query.filter(like(pattern));
        }
    }
    // A row with the column's text default compares above every millisecond bound,
    // so it passes here and the caller checks its decoded time.
    let text_default = || stored_type(m::created_at).eq("text");
    if let Some(after) = after {
        query = query.filter(m::created_at.ge(DbDateTime(after)).or(text_default()));
    }
    if let Some(before) = before {
        query = query.filter(m::created_at.lt(DbDateTime(before)).or(text_default()));
    }
    match page_end {
        None => {}
        // Every text sorts above every number, so only numbers come after a number.
        Some(PageEnd {
            created_at: StoredTime::Written(at),
            id,
        }) => {
            query = query.filter(
                m::created_at
                    .lt(DbDateTime(*at))
                    .or(m::created_at.eq(DbDateTime(*at)).and(m::id.lt(id.clone()))),
            );
        }
        Some(PageEnd {
            created_at: StoredTime::Default(text),
            id,
        }) => {
            let stored = || m::created_at.cast::<Text>();
            query = query.filter(
                stored_type(m::created_at)
                    .ne("text")
                    .or(stored().lt(text.clone()))
                    .or(stored().eq(text.clone()).and(m::id.lt(id.clone()))),
            );
        }
    }
    query
        .order((m::created_at.desc(), m::id.desc()))
        .limit(OUTPUT_PAGE)
        .select((
            m::id,
            m::created_at,
            m::tool_calls,
            stored_type(m::created_at),
            m::created_at.cast::<Text>(),
        ))
        .load(conn)
}

/// The results of a message's tool calls, one after another.
fn tool_results(tool_calls: Option<&Value>) -> String {
    let Some(Value::Array(calls)) = tool_calls else {
        return String::new();
    };
    calls
        .iter()
        .filter_map(|call| call.get("output"))
        .map(|output| match output {
            Value::String(text) => text.clone(),
            other => stringify(other),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Each character lowercased, one for one, so an index into it is an index into
/// the text.
fn lower_chars(text: &str) -> Vec<char> {
    text.chars()
        .map(|ch| ch.to_lowercase().next().unwrap_or(ch))
        .collect()
}

fn find_chars(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The text around the first word `text` holds, marked as a tool result, when it
/// holds every word (any of them with `any_word`), ignoring case.
fn output_excerpt(text: &str, words: &[Vec<char>], any_word: bool) -> Option<String> {
    let lower = lower_chars(text);
    let found: Vec<Option<usize>> = words.iter().map(|word| find_chars(&lower, word)).collect();
    let held = if any_word {
        found.iter().any(Option::is_some)
    } else {
        found.iter().all(Option::is_some)
    };
    if !held {
        return None;
    }
    let at = found.into_iter().flatten().min()?;
    let chars: Vec<char> = text.chars().collect();
    let from = at.saturating_sub(OUTPUT_EXCERPT_BEFORE);
    let to = (at + OUTPUT_EXCERPT_AFTER).min(chars.len());
    let around: String = chars[from..to].iter().collect();
    let around = around.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(format!(
        "[tool result] {}{around}{}",
        if from > 0 { "…" } else { "" },
        if to < chars.len() { "…" } else { "" }
    ))
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

/// `conversations searched`, once per search: `search.outcome` is `ok` with the
/// results, or `error`. The query is never sent.
fn track_search(options: &SearchOptions, found: Option<&SearchOutcome>, started: Instant) {
    let mut props = IndexMap::new();
    if !options.agent_id.is_empty() {
        props.insert("agent.id".to_string(), options.agent_id.clone());
    }
    props.insert(
        "search.outcome".to_string(),
        if found.is_some() { "ok" } else { "error" }.to_string(),
    );
    if let Some(found) = found {
        props.insert(
            "search.results".to_string(),
            found.matches.len().to_string(),
        );
        props.insert("search.any_word".to_string(), found.any_word.to_string());
    }
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
