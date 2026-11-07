//! Memory Embedding Store
//!
//! Vector storage + search for memory entries via sqlite-vec's
//! `memory_entry_vec` virtual table, on the database handle that has the
//! `sqlite-vec` extension loaded (`lib::sqlite_bootstrap::init_sqlite_vec`).
//! Consumers (`embedding_service`) call through this abstraction rather than
//! inlining raw SQL. This is one of the named raw-SQL exceptions.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sql_types::{BigInt, Binary, Double, Text};
use diesel::sqlite::Sqlite;
use serde_json::json;

use crate::db::schema::memory_entries;
use crate::db::schema::memory_entries::dsl as m;
use crate::db::sql_types::{DbDateTime, PrismaDateTime};
use crate::lib::sqlite_bootstrap::{EMBEDDING_DIMENSION, init_sqlite_vec};
use crate::log_warn;
use crate::services::memory_manager_service::{MemorySearchResult, MemorySort};

const DEFAULT_SIMILARITY_THRESHOLD: f64 = 0.3;
const MAX_SEARCH_LIMIT: i64 = 100;
/// The largest k a vec0 KNN query takes.
const VEC0_K_MAX: i64 = 4096;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchOptions {
    pub categories: Option<Vec<String>>,
    pub limit: i64,
    /// Inclusive bounds on when an entry was recorded. Either may be left out.
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    /// Distance order (the default), or the newest matches first.
    pub sort: Option<MemorySort>,
    pub similarity_threshold: Option<f64>,
}

#[async_trait]
pub trait MemoryEmbeddingStore: Send + Sync {
    async fn store_embedding(&self, entry_id: &str, embedding: &[f64]) -> anyhow::Result<()>;
    async fn search_by_embedding(
        &self,
        agent_id: &str,
        query_embedding: &[f64],
        options: &SearchOptions,
    ) -> anyhow::Result<Vec<MemorySearchResult>>;
}

// ============================================================================
// SQLite (sqlite-vec) implementation.
//
// `memory_entries` stores metadata + a packed Float32 blob in the `embedding`
// column so the durable source of truth survives restarts. `memory_entry_vec`
// (vec0 virtual table) is the runtime search index rebuilt on boot from those
// blobs.
//
// Both writes run through the **same** handle inside a single transaction. If
// the vec0 upsert fails the blob UPDATE rolls back with it, so the two stores
// can never disagree mid-session. The migrations own the table's schema and the
// model layer owns all reads — this just takes over the one write path where
// atomicity with vec0 is required.
//
// Search returns (id, distance). We join back to `memory_entries` for the
// metadata columns, using the ids returned by the vec search.
// ============================================================================

/// The embedding as packed little-endian `f32`s, the layout of a `Float32Array`'s
/// buffer.
fn pack_embedding(embedding: &[f64]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|value| (*value as f32).to_le_bytes())
        .collect()
}

/// The `sqlite-vec` store.
pub struct SqliteMemoryEmbeddingStore;

/// One kNN hit.
#[derive(QueryableByName)]
struct Hit {
    #[diesel(sql_type = Text)]
    id: String,
    #[diesel(sql_type = Double)]
    #[allow(dead_code)]
    distance: f64,
}

type ResultRow = (String, String, String, i64, DateTime<Utc>);
type ResultSql = (Text, Text, Text, BigInt, PrismaDateTime);

fn to_result(row: ResultRow) -> MemorySearchResult {
    MemorySearchResult {
        id: row.0,
        content: row.1,
        category: row.2,
        importance: row.3,
        created_at: row.4,
    }
}

/// The metadata read over a set of hit ids, with the agent, window and category
/// filters vec0 cannot apply.
fn filtered<'a>(
    agent_id: &'a str,
    ids: &'a [String],
    options: &'a SearchOptions,
) -> memory_entries::BoxedQuery<'a, Sqlite, ResultSql> {
    let mut query = m::memory_entries
        .select(SELECT)
        .filter(m::id.eq_any(ids))
        .filter(m::agent_id.eq(agent_id))
        .into_boxed();
    if let Some(since) = options.since {
        query = query.filter(m::created_at.ge(DbDateTime(since)));
    }
    if let Some(until) = options.until {
        query = query.filter(m::created_at.le(DbDateTime(until)));
    }
    if let Some(categories) = options.categories.as_ref().filter(|c| !c.is_empty()) {
        query = query.filter(m::category.eq_any(categories));
    }
    query
}

#[async_trait]
impl MemoryEmbeddingStore for SqliteMemoryEmbeddingStore {
    /// Store one entry's embedding: fails with `Embedding dimensionality mismatch:
    /// expected <EMBEDDING_DIMENSION>, got <n>` for a vector of the wrong size;
    /// otherwise, in one transaction on the shared handle, `UPDATE memory_entries
    /// SET embedding = ? WHERE id = ?`, then `DELETE FROM memory_entry_vec WHERE
    /// memory_entry_id = ?` and `INSERT INTO memory_entry_vec(memory_entry_id,
    /// embedding) VALUES (?, ?)` (vec0 doesn't support ON CONFLICT).
    async fn store_embedding(&self, entry_id: &str, embedding: &[f64]) -> anyhow::Result<()> {
        if embedding.len() != EMBEDDING_DIMENSION {
            anyhow::bail!(
                "Embedding dimensionality mismatch: expected {}, got {}",
                EMBEDDING_DIMENSION,
                embedding.len()
            );
        }

        let blob = pack_embedding(embedding);
        let entry_id = entry_id.to_string();
        let db = init_sqlite_vec()?;

        // One transaction over the shared handle: durable blob + vec0 index
        // move together. vec0 doesn't support ON CONFLICT, so the index
        // upsert is a DELETE+INSERT pair.
        db.run(move |conn| {
            conn.transaction(|conn| {
                diesel::update(m::memory_entries.filter(m::id.eq(&entry_id)))
                    .set(m::embedding.eq(Some(&blob)))
                    .execute(conn)?;
                diesel::sql_query("DELETE FROM memory_entry_vec WHERE memory_entry_id = ?")
                    .bind::<Text, _>(&entry_id)
                    .execute(conn)?;
                diesel::sql_query(
                    "INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)",
                )
                .bind::<Text, _>(&entry_id)
                .bind::<Binary, _>(&blob)
                .execute(conn)?;
                anyhow::Ok(())
            })
        })
        .await
    }

    /// The entries of `agent_id` nearest to `query_embedding`.
    ///
    /// A query of the wrong dimension warns `Skipping embedding search due to
    /// dimension mismatch` (with `agentId`, `actual`, `expected`) and finds nothing.
    /// The limit is clamped to 1..=`MAX_SEARCH_LIMIT`. sqlite-vec returns cosine
    /// distance (1 - similarity), so the threshold becomes `distance <= 1 -
    /// threshold`:
    ///
    /// ```sql
    /// SELECT memory_entry_id AS id, distance
    /// FROM memory_entry_vec
    /// WHERE embedding MATCH ? AND distance <= ?
    /// ORDER BY distance
    /// LIMIT ?
    /// ```
    ///
    /// vec0 stores no agent, time or category, so those filters run on the k nearest
    /// hits. Newest-first has to see every match, so it asks for the most vec0 gives:
    /// past 4096 matches it orders the closest 4096 (one round, ordered `createdAt`
    /// desc then `id` asc). Distance order needs only the closest `limit` that pass,
    /// so k starts at `4 × limit` and grows fourfold (capped at 4096) until they do or
    /// the matches run out. The trade: a filter that drops most hits costs up to six
    /// rounds, each a KNN query and an `in` list of up to 4096 ids.
    async fn search_by_embedding(
        &self,
        agent_id: &str,
        query_embedding: &[f64],
        options: &SearchOptions,
    ) -> anyhow::Result<Vec<MemorySearchResult>> {
        let threshold = options
            .similarity_threshold
            .unwrap_or(DEFAULT_SIMILARITY_THRESHOLD);

        if query_embedding.len() != EMBEDDING_DIMENSION {
            log_warn!(
                json!({
                    "agentId": agent_id,
                    "actual": query_embedding.len(),
                    "expected": EMBEDDING_DIMENSION,
                }),
                "Skipping embedding search due to dimension mismatch"
            );
            return Ok(Vec::new());
        }

        let clamped_limit = options.limit.clamp(1, MAX_SEARCH_LIMIT);
        let db = init_sqlite_vec()?;

        // sqlite-vec returns cosine distance (1 - similarity). Convert threshold.
        let max_distance = 1.0 - threshold;
        let packed = pack_embedding(query_embedding);
        let newest = options.sort == Some(MemorySort::Newest);
        let agent_id = agent_id.to_string();
        let options = options.clone();

        db.run(move |conn| {
            let mut k = if newest {
                VEC0_K_MAX
            } else {
                clamped_limit * 4
            };
            loop {
                let hits: Vec<Hit> = diesel::sql_query(
                    "SELECT memory_entry_id AS id, distance
       FROM memory_entry_vec
       WHERE embedding MATCH ? AND distance <= ?
       ORDER BY distance
       LIMIT ?",
                )
                .bind::<Binary, _>(&packed)
                .bind::<Double, _>(max_distance)
                .bind::<BigInt, _>(k)
                .load(conn)?;
                if hits.is_empty() {
                    return Ok(Vec::new());
                }

                let ids: Vec<String> = hits.iter().map(|h| h.id.clone()).collect();
                if newest {
                    let rows: Vec<ResultRow> = filtered(&agent_id, &ids, &options)
                        .order((m::created_at.desc(), m::id.asc()))
                        .limit(clamped_limit)
                        .load(conn)?;
                    return Ok(rows.into_iter().map(to_result).collect());
                }

                let rows: Vec<ResultRow> = filtered(&agent_id, &ids, &options).load(conn)?;
                let mut by_id: HashMap<String, MemorySearchResult> = rows
                    .into_iter()
                    .map(|row| (row.0.clone(), to_result(row)))
                    .collect();
                let matches: Vec<MemorySearchResult> = hits
                    .iter()
                    .filter_map(|hit| by_id.remove(&hit.id))
                    .collect();
                let exhausted = (hits.len() as i64) < k || k == VEC0_K_MAX;
                if matches.len() as i64 >= clamped_limit || exhausted {
                    return Ok(matches.into_iter().take(clamped_limit as usize).collect());
                }
                k = (k * 4).min(VEC0_K_MAX);
            }
        })
        .await
    }
}

/// The columns a search returns.
const SELECT: (m::id, m::content, m::category, m::importance, m::created_at) = (
    m::id,
    m::content,
    m::category,
    m::importance,
    m::created_at,
);

// ============================================================================
// Module-level selector
// ============================================================================

pub static MEMORY_EMBEDDING_STORE: LazyLock<Arc<dyn MemoryEmbeddingStore>> =
    LazyLock::new(|| Arc::new(SqliteMemoryEmbeddingStore));

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::models::NewMemoryEntry;
    use crate::db::testing::test_db;

    /// A unit vector at `angle` radians from the first axis, in the plane of the
    /// first two.
    pub(crate) fn at_angle(angle: f64) -> Vec<f64> {
        let mut v = vec![0.0; EMBEDDING_DIMENSION];
        v[0] = angle.cos();
        v[1] = angle.sin();
        v
    }

    pub(crate) fn insert_entry(id: &str, agent_id: &str, created_at: &str) {
        let mut row = NewMemoryEntry::new(agent_id, id, "observation");
        row.id = id.to_string();
        row.created_at = DbDateTime(crate::support::parse_iso(created_at).unwrap());
        crate::db::run_sync(move |conn| {
            diesel::insert_into(m::memory_entries)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    async fn seed() {
        // Nearest first, and the nearest is the oldest.
        for (id, created_at, angle) in [
            ("near", "2026-10-01T00:00:00Z", 0.1),
            ("mid", "2026-10-02T00:00:00Z", 0.3),
            ("far", "2026-10-03T00:00:00Z", 0.5),
        ] {
            insert_entry(id, "agent-1", created_at);
            MEMORY_EMBEDDING_STORE
                .store_embedding(id, &at_angle(angle))
                .await
                .unwrap();
        }
    }

    fn ids(results: &[MemorySearchResult]) -> Vec<&str> {
        results.iter().map(|r| r.id.as_str()).collect()
    }

    fn options(limit: i64) -> SearchOptions {
        SearchOptions {
            limit,
            ..Default::default()
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_wrong_dimension_embeddings() {
        let _db = test_db();
        let err = MEMORY_EMBEDDING_STORE
            .store_embedding("entry-1", &vec![0.1; 128])
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Embedding dimensionality mismatch: expected 1024, got 128"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn stores_the_blob_and_the_index_together() {
        let _db = test_db();
        insert_entry("entry-1", "agent-1", "2026-10-01T00:00:00Z");
        let embedding = at_angle(0.0);
        MEMORY_EMBEDDING_STORE
            .store_embedding("entry-1", &embedding)
            .await
            .unwrap();
        // A second store replaces the index row rather than failing on it.
        MEMORY_EMBEDDING_STORE
            .store_embedding("entry-1", &embedding)
            .await
            .unwrap();
        let blob: Option<Vec<u8>> = crate::db::run_sync(|conn| {
            Ok(m::memory_entries
                .filter(m::id.eq("entry-1"))
                .select(m::embedding)
                .first(conn)?)
        })
        .unwrap();
        assert_eq!(blob, Some(pack_embedding(&embedding)));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_the_closest_matches_first_by_default() {
        let _db = test_db();
        seed().await;
        let results = MEMORY_EMBEDDING_STORE
            .search_by_embedding("agent-1", &at_angle(0.0), &options(2))
            .await
            .unwrap();
        assert_eq!(ids(&results), ["near", "mid"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn puts_the_newest_matches_first_when_asked() {
        let _db = test_db();
        seed().await;
        let results = MEMORY_EMBEDDING_STORE
            .search_by_embedding(
                "agent-1",
                &at_angle(0.0),
                &SearchOptions {
                    sort: Some(MemorySort::Newest),
                    ..options(2)
                },
            )
            .await
            .unwrap();
        assert_eq!(ids(&results), ["far", "mid"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn filters_the_matches_to_the_window_and_the_agent() {
        let _db = test_db();
        seed().await;
        insert_entry("other", "agent-2", "2026-10-02T12:00:00Z");
        MEMORY_EMBEDDING_STORE
            .store_embedding("other", &at_angle(0.0))
            .await
            .unwrap();
        let results = MEMORY_EMBEDDING_STORE
            .search_by_embedding(
                "agent-1",
                &at_angle(0.0),
                &SearchOptions {
                    since: crate::support::parse_iso("2026-10-02T00:00:00Z"),
                    until: crate::support::parse_iso("2026-10-02T23:59:59.999Z"),
                    ..options(5)
                },
            )
            .await
            .unwrap();
        assert_eq!(ids(&results), ["mid"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fetches_further_when_the_filters_leave_fewer_matches_than_the_limit() {
        let _db = test_db();
        for (i, id) in ["a", "b", "c", "d", "fifth"].into_iter().enumerate() {
            let created_at = if id == "fifth" {
                "2026-10-06T12:00:00Z"
            } else {
                "2026-10-01T00:00:00Z"
            };
            insert_entry(id, "agent-1", created_at);
            MEMORY_EMBEDDING_STORE
                .store_embedding(id, &at_angle(0.1 * (i as f64 + 1.0)))
                .await
                .unwrap();
        }
        let results = MEMORY_EMBEDDING_STORE
            .search_by_embedding(
                "agent-1",
                &at_angle(0.0),
                &SearchOptions {
                    since: crate::support::parse_iso("2026-10-06T00:00:00Z"),
                    ..options(1)
                },
            )
            .await
            .unwrap();
        assert_eq!(ids(&results), ["fifth"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_nothing_for_a_query_of_the_wrong_dimension() {
        let _db = test_db();
        seed().await;
        let results = MEMORY_EMBEDDING_STORE
            .search_by_embedding("agent-1", &[1.0, 0.0], &options(2))
            .await
            .unwrap();
        assert!(results.is_empty());
    }
}
