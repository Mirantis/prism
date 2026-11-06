//! Backfill: generate embeddings for existing memory entries.
//!
//! Queries all memory_entries where embedding IS NULL, generates embeddings
//! through the embedding provider, and stores them in the database.
//!
//! Idempotent: skips entries that already have embeddings.
//! Processes one entry per call with a 1s pause between batches; serial
//! pacing keeps a busy backfill under the provider's per-account rate limit,
//! paired with `EMBEDDING_SERVICE.generate_embeddings`'s one call at a time.
//! Errors are logged per entry (they do not abort the full backfill).

use serde::{Deserialize, Serialize};

const BATCH_SIZE: usize = 1;
const PAGE_SIZE: i64 = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackfillEntry {
    id: String,
    agent_id: String,
    content: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackfillResult {
    pub processed: i64,
    pub failed: i64,
    pub scanned: i64,
}

/// Pages through `memory_entries` with no embedding, ordered by id with a cursor
/// after the last id (`PAGE_SIZE` rows a page, selecting id, agentId and content).
/// An empty first page prints `No entries need backfilling.` and returns. Each
/// page prints `Fetched page of {n} entries (total scanned: {scanned})`, groups its
/// rows by agent in first-seen order, and for each batch of `BATCH_SIZE` waits 1 s,
/// generates the embeddings, and stores each one. A batch with no embeddings
/// (`Could not generate embeddings for agent {agentId} — skipping {n} entries`,
/// then `\nFailed entries:` and `{ index, id, text }` per entry, on stderr) or with
/// a count mismatch (`Embedding count mismatch: expected {n}, got {m} — skipping
/// batch`) counts as failed. A store failure prints `Failed to store embedding for
/// entry {id}:` with the redacted error. After each batch:
/// `Progress: scanned {scanned}, completed {processed + failed} ({processed} ok,
/// {failed} failed)`. At the end: `\nDone. Processed: {p}, Failed: {f}, Scanned: {s}`.
/// Messages go to stdout, warnings and errors to stderr, as `console` writes them.
pub async fn run_backfill() -> anyhow::Result<BackfillResult> {
    todo!()
}

/// Manual re-run entry point: runs the backfill and exits 1 with
/// `Backfill failed:` and the redacted error when it fails.
pub async fn main() -> i32 {
    todo!()
}
