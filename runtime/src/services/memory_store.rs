//! Memory Embedding Store
//!
//! Vector storage + search for memory entries via sqlite-vec's
//! `memory_entry_vec` virtual table, on the database handle that has the
//! `sqlite-vec` extension loaded (`lib::sqlite_bootstrap::init_sqlite_vec`).
//! Consumers (`embedding_service`) call through this abstraction rather than
//! inlining raw SQL. This is one of the named raw-SQL exceptions.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};

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

#[async_trait]
impl MemoryEmbeddingStore for SqliteMemoryEmbeddingStore {
    /// Store one entry's embedding: fails with `Embedding dimensionality mismatch:
    /// expected <EMBEDDING_DIMENSION>, got <n>` for a vector of the wrong size;
    /// otherwise, in one transaction on the shared handle, `UPDATE memory_entries
    /// SET embedding = ? WHERE id = ?`, then `DELETE FROM memory_entry_vec WHERE
    /// memory_entry_id = ?` and `INSERT INTO memory_entry_vec(memory_entry_id,
    /// embedding) VALUES (?, ?)` (vec0 doesn't support ON CONFLICT).
    async fn store_embedding(&self, entry_id: &str, embedding: &[f64]) -> anyhow::Result<()> {
        todo!()
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
        todo!()
    }
}

// ============================================================================
// Module-level selector
// ============================================================================

pub static MEMORY_EMBEDDING_STORE: LazyLock<Arc<dyn MemoryEmbeddingStore>> =
    LazyLock::new(|| Arc::new(SqliteMemoryEmbeddingStore));
