//! Memory Manager Service
//!
//! Simplified memory system with a flat `MemoryEntry` table.
//! Agent curates what's worth keeping - no automatic daily grouping.
//!
//! Key insight: Memory ≠ Context
//! - Context: What model sees per request (ephemeral, bounded, expensive)
//! - Memory: What's stored in DB (persistent, unbounded, cheap, searchable)
//!
//! Search uses embedding similarity (sqlite-vec cosine distance).

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::dsl::count;
use diesel::prelude::*;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::json;

use crate::db::models::{MemoryEntry, NewMemoryEntry};
use crate::db::schema::memory_entries::dsl as m;
use crate::db::sql_types::DbDateTime;
use crate::lib::log_redaction::err_json;
use crate::log_warn;
use crate::services::embedding_service::EMBEDDING_SERVICE;
use crate::services::memory_store::SearchOptions;
use crate::support::js::len16;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub id: String,
    pub content: String,
    pub category: String,
    pub importance: i64,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// `Relevance` keeps the closest matches first; `Newest` the most recently recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySort {
    Relevance,
    Newest,
}

impl MemorySort {
    pub fn as_str(self) -> &'static str {
        match self {
            MemorySort::Relevance => "relevance",
            MemorySort::Newest => "newest",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemorySearchOptions {
    pub agent_id: String,
    pub categories: Option<Vec<String>>,
    pub limit: Option<i64>,
    /// Inclusive bounds on when an entry was recorded. Either may be left out.
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub sort: Option<MemorySort>,
}

/// A rendered block and the entries it shows, so another block of the same turn can leave them out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBlock {
    pub text: String,
    pub entry_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteInput {
    pub content: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importance: Option<i64>,
}

/// What `get_stats` reports for one agent's memory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total_entries: i64,
    pub by_category: IndexMap<String, i64>,
    #[serde(serialize_with = "js_number")]
    pub avg_importance: f64,
}

/// A float as `JSON.stringify` writes it: `5`, not `5.0`.
fn js_number<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
    crate::support::js::number(*value).serialize(s)
}

/// Filters of the newest-entries read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ListRecentOptions {
    categories: Option<Vec<String>>,
    since: Option<DateTime<Utc>>,
    until: Option<DateTime<Utc>>,
    exclude_ids: Option<Vec<String>>,
    limit: i64,
}

// ============================================================================
// Memory Manager Service
// ============================================================================

static LINE_BREAK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\n\s*").unwrap());

/// An entry rendered as one line.
///
/// Both surfaces are newline-joined lists, so an entry holding a newline and `- ` can
/// append entries of its own — with a `(category, recorded …)` suffix that looks just
/// as authored. That suffix exists because the agent would not use a recall until it
/// could see where each line came from, and provenance the content can forge is not
/// provenance. What an entry may contain is not ours to trust: the agent writes them,
/// but out of whatever it has read.
fn one_line(content: &str) -> String {
    crate::support::js::trim(&LINE_BREAK_RE.replace_all(content, " ")).to_string()
}

/// At and above this score an entry is carried every turn, query or not.
const MIN_IMPORTANT_SCORE: i64 = 9;
const MAX_IMPORTANT: i64 = 15;
const MAX_RELEVANT: i64 = 10;
const IMPORTANT_CHAR_BUDGET: usize = 4000;
/// Half the important budget: this half is billed per turn, the other is cached.
const RELEVANT_CHAR_BUDGET: usize = 2000;
/// How far back a new conversation looks for what the agent recorded before it.
const RECENT_WINDOW_MS: i64 = 4 * 60 * 60 * 1000;
const MAX_RECENT: i64 = 8;
const RECENT_CHAR_BUDGET: usize = 2000;
/// The automatic per-turn recall looks back a year.
const RELEVANT_WINDOW_MS: i64 = 365 * 24 * 60 * 60 * 1000;

pub struct MemoryManagerService;

/// The columns a search result reads.
type ResultRow = (String, String, String, i64, DateTime<Utc>);

fn to_result(row: ResultRow) -> MemorySearchResult {
    MemorySearchResult {
        id: row.0,
        content: row.1,
        category: row.2,
        importance: row.3,
        created_at: row.4,
    }
}

/// `Date.now() - ms` as a bound on `createdAt`.
fn ms_ago(ms: i64) -> DateTime<Utc> {
    crate::support::from_ms(crate::support::now_ms() - ms)
}

/// `category.charAt(0).toUpperCase() + category.slice(1)`.
fn capitalize(category: &str) -> String {
    let mut chars = category.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

impl MemoryManagerService {
    pub fn new() -> Self {
        Self
    }

    /// Search memory entries by meaning, inside an optional time window.
    ///
    /// With no search words it lists the newest entries in the window instead. That read
    /// needs no embedding, so it also works with embeddings switched off. The limit
    /// defaults to 25; a query without an embedding finds nothing; the similarity
    /// threshold is 0.3.
    pub async fn search(
        &self,
        user_id: &str,
        query: Option<&str>,
        options: &MemorySearchOptions,
    ) -> anyhow::Result<Vec<MemorySearchResult>> {
        let limit = options.limit.unwrap_or(25);
        let Some(query) = query.filter(|q| !crate::support::js::trim(q).is_empty()) else {
            return self
                .list_recent(
                    &options.agent_id,
                    ListRecentOptions {
                        categories: options.categories.clone(),
                        since: options.since,
                        until: options.until,
                        exclude_ids: None,
                        limit,
                    },
                )
                .await;
        };

        let Some(query_embedding) = EMBEDDING_SERVICE
            .generate_embedding(&options.agent_id, query)
            .await
        else {
            return Ok(Vec::new());
        };

        EMBEDDING_SERVICE
            .search_by_embedding(
                &options.agent_id,
                &query_embedding,
                &SearchOptions {
                    categories: options.categories.clone(),
                    limit,
                    since: options.since,
                    until: options.until,
                    sort: options.sort,
                    similarity_threshold: Some(0.3),
                },
            )
            .await
    }

    /// The newest entries in a time window. `id` breaks a tie, so the order is stable.
    async fn list_recent(
        &self,
        agent_id: &str,
        options: ListRecentOptions,
    ) -> anyhow::Result<Vec<MemorySearchResult>> {
        let agent_id = agent_id.to_string();
        let rows: Vec<ResultRow> = crate::db::read(move |conn| {
            let mut query = m::memory_entries
                .filter(m::agent_id.eq(&agent_id))
                .select((m::id, m::content, m::category, m::importance, m::created_at))
                .into_boxed();
            if let Some(since) = options.since {
                query = query.filter(m::created_at.ge(DbDateTime(since)));
            }
            if let Some(until) = options.until {
                query = query.filter(m::created_at.le(DbDateTime(until)));
            }
            if let Some(categories) = options.categories.filter(|c| !c.is_empty()) {
                query = query.filter(m::category.eq_any(categories));
            }
            if let Some(exclude_ids) = options.exclude_ids.filter(|ids| !ids.is_empty()) {
                query = query.filter(m::id.ne_all(exclude_ids));
            }
            Ok(query
                .order((m::created_at.desc(), m::id.asc()))
                .limit(options.limit)
                .load(conn)?)
        })
        .await?;
        Ok(rows.into_iter().map(to_result).collect())
    }

    /// Write to memory (importance defaults to 5).
    /// Generates and stores an embedding in the background; the entry exists even if
    /// that fails, which warns `Failed to generate embedding for memory entry` with
    /// `err` and `entryId`.
    pub async fn write(
        &self,
        user_id: &str,
        input: &MemoryWriteInput,
        agent_id: &str,
    ) -> anyhow::Result<MemoryEntry> {
        let mut row = NewMemoryEntry::new(agent_id, input.content.clone(), input.category.clone());
        row.importance = input.importance.unwrap_or(5);
        let entry: MemoryEntry = crate::db::run(move |conn| {
            Ok(diesel::insert_into(m::memory_entries)
                .values(&row)
                .returning(MemoryEntry::as_returning())
                .get_result(conn)?)
        })
        .await?;

        // Generate embedding in background — entry exists even if this fails
        let agent_id = agent_id.to_string();
        let entry_id = entry.id.clone();
        let content = input.content.clone();
        tokio::spawn(async move {
            if let Err(err) = EMBEDDING_SERVICE
                .generate_and_store_embedding(&agent_id, &entry_id, &content)
                .await
            {
                log_warn!(
                    json!({ "err": err_json(&err), "entryId": entry_id }),
                    "Failed to generate embedding for memory entry"
                );
            }
        });

        Ok(entry)
    }

    /// Delete a memory entry by ID. True when one was deleted.
    pub async fn delete(
        &self,
        user_id: &str,
        entry_id: &str,
        agent_id: &str,
    ) -> anyhow::Result<bool> {
        let entry_id = entry_id.to_string();
        let agent_id = agent_id.to_string();
        let count = crate::db::run(move |conn| {
            Ok(diesel::delete(
                m::memory_entries
                    .filter(m::id.eq(&entry_id))
                    .filter(m::agent_id.eq(&agent_id)),
            )
            .execute(conn)?)
        })
        .await?;
        Ok(count > 0)
    }

    /// Delete multiple memory entries by IDs. Returns how many were deleted.
    pub async fn delete_many(
        &self,
        user_id: &str,
        entry_ids: &[String],
        agent_id: &str,
    ) -> anyhow::Result<i64> {
        let entry_ids = entry_ids.to_vec();
        let agent_id = agent_id.to_string();
        let count = crate::db::run(move |conn| {
            Ok(diesel::delete(
                m::memory_entries
                    .filter(m::id.eq_any(&entry_ids))
                    .filter(m::agent_id.eq(&agent_id)),
            )
            .execute(conn)?)
        })
        .await?;
        Ok(count as i64)
    }

    /// Get entries by category, most important first, then newest. `limit`
    /// defaults to 20.
    pub async fn get_by_category(
        &self,
        user_id: &str,
        category: &str,
        agent_id: &str,
        limit: Option<i64>,
    ) -> anyhow::Result<Vec<MemorySearchResult>> {
        let category = category.to_string();
        let agent_id = agent_id.to_string();
        let limit = limit.unwrap_or(20);
        let rows: Vec<ResultRow> = crate::db::read(move |conn| {
            Ok(m::memory_entries
                .filter(m::agent_id.eq(&agent_id))
                .filter(m::category.eq(&category))
                .order((m::importance.desc(), m::created_at.desc()))
                .limit(limit)
                .select((m::id, m::content, m::category, m::importance, m::created_at))
                .load(conn)?)
        })
        .await?;
        Ok(rows.into_iter().map(to_result).collect())
    }

    /// The important entries that fit the budget, in the order they will render.
    ///
    /// The budget is applied here rather than while rendering, so one function decides
    /// the set and `build_relevant_memories` can exclude exactly it. Excluding by the score
    /// threshold instead leaves an entry in neither surface whenever the character budget
    /// cuts it, reachable only by an explicit search.
    ///
    /// `id` breaks the sort. The scores that qualify collapse to a couple of values, and
    /// `memory_write` can create several entries in one turn, so `createdAt` can tie with
    /// nothing behind it — and a swap reorders a whole category inside the cached prefix
    /// this section exists to keep stable.
    ///
    /// A line counts as `- <one_line(content)>` plus one newline, in UTF-16 units.
    async fn select_important_entries(&self, agent_id: &str) -> anyhow::Result<Vec<MemoryEntry>> {
        let agent_id = agent_id.to_string();
        let entries: Vec<MemoryEntry> = crate::db::read(move |conn| {
            Ok(m::memory_entries
                .filter(m::agent_id.eq(&agent_id))
                .filter(m::importance.ge(MIN_IMPORTANT_SCORE))
                .order((m::importance.desc(), m::created_at.desc(), m::id.asc()))
                .limit(MAX_IMPORTANT)
                .select(MemoryEntry::as_select())
                .load(conn)?)
        })
        .await?;

        let mut fitted = Vec::new();
        let mut char_count = 0;
        for entry in entries {
            let line = format!("- {}", one_line(&entry.content));
            let length = len16(&line);
            if char_count + length + 1 > IMPORTANT_CHAR_BUDGET {
                break;
            }
            fitted.push(entry);
            char_count += length + 1;
        }
        Ok(fitted)
    }

    /// The entries the agent scored most important, rendered for the system prompt.
    ///
    /// No query: these come back whatever the turn is about, which is why they are a
    /// stable section rather than part of the per-turn recall. They change only when the
    /// agent writes or drops one, so they cache like the rest of the prompt.
    ///
    /// Grouped by category in first-seen order under `## <Category>s` headers (first
    /// letter upper-cased), each entry `- <one line>`, joined with newlines.
    ///
    /// Returns an empty string when there are none, and the caller drops the section.
    pub async fn build_important_memories(&self, agent_id: &str) -> anyhow::Result<String> {
        let entries = self.select_important_entries(agent_id).await?;
        if entries.is_empty() {
            return Ok(String::new());
        }

        let mut by_category: IndexMap<String, Vec<MemoryEntry>> = IndexMap::new();
        for entry in entries {
            by_category
                .entry(entry.category.clone())
                .or_default()
                .push(entry);
        }

        // Grouped first, so a header cannot render with nothing under it.
        let mut parts: Vec<String> = Vec::new();
        for (category, group) in &by_category {
            parts.push(format!("## {}s", capitalize(category)));
            for entry in group {
                parts.push(format!("- {}", one_line(&entry.content)));
            }
        }
        Ok(parts.join("\n"))
    }

    /// What the agent recorded in the hours before a conversation, newest first, for the
    /// conversation to open with.
    ///
    /// Pinned entries are left out, since the system prompt already carries them. A line
    /// (`- <one line> (<category>)`) names the category and not the date, since every
    /// entry is from the last four hours.
    ///
    /// The text is empty when nothing recent is left (caller sends no block).
    pub async fn build_recent_memories(&self, agent_id: &str) -> anyhow::Result<MemoryBlock> {
        let important_ids: Vec<String> = self
            .select_important_entries(agent_id)
            .await?
            .into_iter()
            .map(|e| e.id)
            .collect();
        let entries = self
            .list_recent(
                agent_id,
                ListRecentOptions {
                    since: Some(ms_ago(RECENT_WINDOW_MS)),
                    exclude_ids: Some(important_ids),
                    limit: MAX_RECENT,
                    ..Default::default()
                },
            )
            .await?;

        let mut lines = Vec::new();
        let mut entry_ids = Vec::new();
        let mut char_count = 0;
        for entry in entries {
            let line = format!("- {} ({})", one_line(&entry.content), entry.category);
            let length = len16(&line);
            if char_count + length + 1 > RECENT_CHAR_BUDGET {
                break;
            }
            lines.push(line);
            entry_ids.push(entry.id);
            char_count += length + 1;
        }
        Ok(MemoryBlock {
            text: lines.join("\n"),
            entry_ids,
        })
    }

    /// What this turn's message matches, by meaning.
    ///
    /// Pinned entries are left out: `build_important_memories` already carries them from the
    /// system prompt, where they cost nothing per turn. So is every entry in `shown_ids`,
    /// which another block of the same turn shows.
    ///
    /// Its budget is smaller than the pinned one because this half is billed on every
    /// turn that matches something, while the pinned half is billed once and then read
    /// from cache.
    ///
    /// Each line is `- <one line> (<category>, recorded <YYYY-MM-DD>)`: asked to stand
    /// behind a recall, an agent given the bare text declined it for lack of a source
    /// or timestamp.
    ///
    /// Returns an empty string when nothing matches (caller sends no block).
    pub async fn build_relevant_memories(
        &self,
        user_id: &str,
        agent_id: &str,
        query: Option<&str>,
        shown_ids: &[String],
    ) -> anyhow::Result<String> {
        let Some(query) = query.filter(|q| !q.is_empty()) else {
            return Ok(String::new());
        };

        // Dropped by id, not by importance: only the entries the pinned section actually
        // emits are already in front of the agent. Anything the pinned caps left out is
        // still reachable here, which is what the threshold check got wrong.
        let mut excluded: HashSet<String> = self
            .select_important_entries(agent_id)
            .await?
            .into_iter()
            .map(|e| e.id)
            .collect();
        excluded.extend(shown_ids.iter().cloned());
        let matches: Vec<MemorySearchResult> = self
            .search(
                user_id,
                Some(query),
                &MemorySearchOptions {
                    agent_id: agent_id.to_string(),
                    limit: Some(MAX_RELEVANT),
                    since: Some(ms_ago(RELEVANT_WINDOW_MS)),
                    ..Default::default()
                },
            )
            .await?
            .into_iter()
            .filter(|entry| !excluded.contains(&entry.id))
            .collect();
        if matches.is_empty() {
            return Ok(String::new());
        }

        // Each line carries when it was recorded and what kind of entry it is. Asked to
        // stand behind a recall, an agent given the bare text answered that it had "no
        // source, timestamp, or citation attached — just an assertion that appeared in
        // the prompt", and declined it. Provenance is what that asks for; an assertion
        // that the entries are trustworthy is what it refuses.
        let mut parts = Vec::new();
        let mut char_count = 0;
        for entry in matches {
            let recorded = &crate::support::iso(&entry.created_at)[..10];
            let line = format!(
                "- {} ({}, recorded {})",
                one_line(&entry.content),
                entry.category,
                recorded
            );
            let length = len16(&line);
            // The budget is a ceiling, so the line has to fit before it is added.
            if char_count + length + 1 > RELEVANT_CHAR_BUDGET {
                break;
            }
            parts.push(line);
            char_count += length + 1;
        }
        Ok(parts.join("\n"))
    }

    /// Cleanup old low-importance memories (retention policy).
    /// Only removes entries with importance < `importance_threshold` (default 3) that
    /// are older than `days_to_keep` (default 30). Returns how many were removed.
    pub async fn cleanup(
        &self,
        user_id: &str,
        agent_id: &str,
        days_to_keep: Option<i64>,
        importance_threshold: Option<i64>,
    ) -> anyhow::Result<i64> {
        let cutoff = DbDateTime(ms_ago(days_to_keep.unwrap_or(30) * 24 * 60 * 60 * 1000));
        let threshold = importance_threshold.unwrap_or(3);
        let agent_id = agent_id.to_string();
        let count = crate::db::run(move |conn| {
            Ok(diesel::delete(
                m::memory_entries
                    .filter(m::agent_id.eq(&agent_id))
                    .filter(m::created_at.lt(cutoff))
                    .filter(m::importance.lt(threshold)),
            )
            .execute(conn)?)
        })
        .await?;
        Ok(count as i64)
    }

    /// Get memory stats for an agent. `avg_importance` is 0 with no entries.
    pub async fn get_stats(&self, user_id: &str, agent_id: &str) -> anyhow::Result<MemoryStats> {
        let agent_id = agent_id.to_string();
        let (total_entries, category_stats, avg) = crate::db::read(move |conn| {
            let total: i64 = m::memory_entries
                .filter(m::agent_id.eq(&agent_id))
                .count()
                .get_result(conn)?;
            let categories: Vec<(String, i64)> = m::memory_entries
                .filter(m::agent_id.eq(&agent_id))
                .group_by(m::category)
                .select((m::category, count(m::id)))
                .load(conn)?;
            let avg: Option<f64> = m::memory_entries
                .filter(m::agent_id.eq(&agent_id))
                .select(int_avg(m::importance))
                .get_result(conn)?;
            Ok((total, categories, avg))
        })
        .await?;

        let mut by_category = IndexMap::new();
        for (category, count) in category_stats {
            by_category.insert(category, count);
        }

        Ok(MemoryStats {
            total_entries,
            by_category,
            avg_importance: avg.unwrap_or(0.0),
        })
    }
}

#[diesel::declare_sql_function]
extern "SQL" {
    /// SQLite's `AVG` over an integer column, which it answers as a float.
    #[aggregate]
    #[sql_name = "AVG"]
    fn int_avg(
        x: diesel::sql_types::BigInt,
    ) -> diesel::sql_types::Nullable<diesel::sql_types::Double>;
}

impl Default for MemoryManagerService {
    fn default() -> Self {
        Self::new()
    }
}

pub static MEMORY_MANAGER_SERVICE: LazyLock<MemoryManagerService> =
    LazyLock::new(MemoryManagerService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testing::test_db;

    fn insert(id: &str, content: &str, category: &str, importance: i64, age_ms: i64) {
        let mut row = NewMemoryEntry::new("agent-1", content, category);
        row.id = id.to_string();
        row.importance = importance;
        row.created_at = DbDateTime(ms_ago(age_ms));
        crate::db::run_sync(move |conn| {
            diesel::insert_into(m::memory_entries)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn one_line_folds_line_breaks_so_an_entry_cannot_forge_another() {
        assert_eq!(one_line("  first\n  - second (fact)\n"), "first - second (fact)");
        assert_eq!(capitalize("fact"), "Fact");
        assert_eq!(capitalize(""), "");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn important_memories_group_by_category_in_first_seen_order() {
        let _db = test_db();
        insert("a", "Prefers dark mode", "preference", 10, 3000);
        insert("b", "Deploys on Fridays\nnever", "fact", 9, 2000);
        insert("c", "Likes tea", "preference", 9, 1000);
        insert("d", "Low score", "fact", 5, 0);

        let text = MEMORY_MANAGER_SERVICE
            .build_important_memories("agent-1")
            .await
            .unwrap();

        assert_eq!(
            text,
            "## Preferences\n- Prefers dark mode\n- Likes tea\n## Facts\n- Deploys on Fridays never"
        );
        assert_eq!(
            MEMORY_MANAGER_SERVICE
                .build_important_memories("agent-2")
                .await
                .unwrap(),
            ""
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn recent_memories_leave_out_pinned_and_old_entries() {
        let _db = test_db();
        let hour = 60 * 60 * 1000;
        insert("pinned", "Pinned", "fact", 9, 0);
        insert("new", "New thing", "observation", 5, 1000);
        insert("newer", "Newer thing", "task", 5, 0);
        insert("old", "Old thing", "observation", 5, 5 * hour);

        let block = MEMORY_MANAGER_SERVICE
            .build_recent_memories("agent-1")
            .await
            .unwrap();

        assert_eq!(block.text, "- Newer thing (task)\n- New thing (observation)");
        assert_eq!(block.entry_ids, vec!["newer".to_string(), "new".to_string()]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_search_without_words_lists_the_newest_in_the_window() {
        let _db = test_db();
        insert("one", "One", "fact", 5, 2000);
        insert("two", "Two", "task", 5, 1000);
        insert("three", "Three", "fact", 5, 0);

        let options = MemorySearchOptions {
            agent_id: "agent-1".to_string(),
            categories: Some(vec!["fact".to_string()]),
            ..Default::default()
        };
        let results = MEMORY_MANAGER_SERVICE
            .search("u", Some("   "), &options)
            .await
            .unwrap();
        let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["three", "one"]);
        assert_eq!(
            MEMORY_MANAGER_SERVICE
                .build_relevant_memories("u", "agent-1", None, &[])
                .await
                .unwrap(),
            ""
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_deletes_cleans_up_and_counts() {
        let _db = test_db();
        let entry = MEMORY_MANAGER_SERVICE
            .write(
                "u",
                &MemoryWriteInput {
                    content: "Remember this".to_string(),
                    category: "fact".to_string(),
                    importance: None,
                },
                "agent-1",
            )
            .await
            .unwrap();
        assert_eq!(entry.importance, 5);
        insert("old-low", "Old", "observation", 2, 31 * 24 * 60 * 60 * 1000);
        insert("high", "High", "fact", 9, 0);

        let stats = MEMORY_MANAGER_SERVICE.get_stats("u", "agent-1").await.unwrap();
        assert_eq!(stats.total_entries, 3);
        assert_eq!(stats.by_category.get("fact"), Some(&2));
        assert!((stats.avg_importance - 16.0 / 3.0).abs() < 1e-9);

        let by_category = MEMORY_MANAGER_SERVICE
            .get_by_category("u", "fact", "agent-1", None)
            .await
            .unwrap();
        assert_eq!(by_category[0].id, "high");

        assert_eq!(
            MEMORY_MANAGER_SERVICE
                .cleanup("u", "agent-1", None, None)
                .await
                .unwrap(),
            1
        );
        assert!(
            MEMORY_MANAGER_SERVICE
                .delete("u", &entry.id, "agent-1")
                .await
                .unwrap()
        );
        assert!(
            !MEMORY_MANAGER_SERVICE
                .delete("u", &entry.id, "agent-1")
                .await
                .unwrap()
        );
        assert_eq!(
            MEMORY_MANAGER_SERVICE
                .delete_many("u", &["high".to_string()], "agent-1")
                .await
                .unwrap(),
            1
        );
        let empty = MEMORY_MANAGER_SERVICE.get_stats("u", "agent-2").await.unwrap();
        assert_eq!(empty.avg_importance, 0.0);
        assert_eq!(
            serde_json::to_string(&empty).unwrap(),
            r#"{"totalEntries":0,"byCategory":{},"avgImportance":0}"#
        );
    }
}
