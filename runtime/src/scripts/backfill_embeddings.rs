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

use std::time::Duration;

use diesel::prelude::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::db::schema::memory_entries::dsl as m;
use crate::lib::log_redaction::err_json;
use crate::services::embedding_service::EMBEDDING_SERVICE;

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
    let mut processed = 0;
    let mut failed = 0;
    let mut scanned = 0;
    let mut last_id: Option<String> = None;

    loop {
        // Paginate with cursor to avoid loading all rows into memory
        let entries = next_page(last_id.clone()).await?;

        if entries.is_empty() {
            if scanned == 0 {
                println!("No entries need backfilling.");
                return Ok(BackfillResult {
                    processed,
                    failed,
                    scanned,
                });
            }
            break;
        }

        scanned += entries.len() as i64;
        last_id = entries.last().map(|e| e.id.clone());
        println!(
            "Fetched page of {} entries (total scanned: {})",
            entries.len(),
            scanned
        );

        // Group by agent id to reuse provider setup.
        let mut by_agent: IndexMap<String, Vec<BackfillEntry>> = IndexMap::new();
        for entry in entries {
            by_agent
                .entry(entry.agent_id.clone())
                .or_default()
                .push(entry);
        }

        for (agent_id, agent_entries) in &by_agent {
            // Process in batches
            for (batch_index, batch) in agent_entries.chunks(BATCH_SIZE).enumerate() {
                let i = batch_index * BATCH_SIZE;
                tokio::time::sleep(Duration::from_millis(1000)).await;
                let texts: Vec<String> = batch.iter().map(|e| e.content.clone()).collect();

                let Some(embeddings) = EMBEDDING_SERVICE
                    .generate_embeddings(agent_id, &texts)
                    .await
                else {
                    let listed: Vec<String> = batch
                        .iter()
                        .enumerate()
                        .map(|(idx, e)| {
                            format!(
                                "{{ index: {}, id: {}, text: {} }}",
                                i + idx,
                                inspect_string(&e.id),
                                inspect_string(&texts[idx])
                            )
                        })
                        .collect();
                    eprintln!(
                        "Could not generate embeddings for agent {} — skipping {} entries \nFailed entries: [ {} ]",
                        agent_id,
                        batch.len(),
                        listed.join(", ")
                    );
                    failed += batch.len() as i64;
                    continue;
                };

                if embeddings.len() != batch.len() {
                    eprintln!(
                        "Embedding count mismatch: expected {}, got {} — skipping batch",
                        batch.len(),
                        embeddings.len()
                    );
                    failed += batch.len() as i64;
                    continue;
                }

                // Store each embedding through the provider-aware store.
                for (entry, embedding) in batch.iter().zip(&embeddings) {
                    match EMBEDDING_SERVICE
                        .store_embedding(&entry.id, embedding)
                        .await
                    {
                        Ok(()) => processed += 1,
                        Err(err) => {
                            // Through the same serializer the logger uses. This script talks
                            // to the embeddings endpoint, so a failure here is an SDK error
                            // carrying the request that produced it — which is the memory
                            // entry's own text.
                            eprintln!(
                                "Failed to store embedding for entry {}: {}",
                                entry.id,
                                err_json(&err)
                            );
                            failed += 1;
                        }
                    }
                }

                println!(
                    "Progress: scanned {}, completed {} ({} ok, {} failed)",
                    scanned,
                    processed + failed,
                    processed,
                    failed
                );
            }
        }
    }

    println!("\nDone. Processed: {processed}, Failed: {failed}, Scanned: {scanned}");
    Ok(BackfillResult {
        processed,
        failed,
        scanned,
    })
}

/// The next page of entries with no embedding, after `last_id` in id order.
async fn next_page(last_id: Option<String>) -> anyhow::Result<Vec<BackfillEntry>> {
    let rows: Vec<(String, String, String)> = crate::db::run(move |conn| {
        let mut query = m::memory_entries
            .filter(m::embedding.is_null())
            .select((m::id, m::agent_id, m::content))
            .into_boxed();
        if let Some(last_id) = last_id {
            query = query.filter(m::id.gt(last_id));
        }
        Ok(query.order(m::id.asc()).limit(PAGE_SIZE).load(conn)?)
    })
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, agent_id, content)| BackfillEntry {
            id,
            agent_id,
            content,
        })
        .collect())
}

/// A string as Node's `util.inspect` shows it inside an object: single-quoted.
fn inspect_string(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Manual re-run entry point: runs the backfill and exits 1 with
/// `Backfill failed:` and the redacted error when it fails.
pub async fn main() -> i32 {
    match run_backfill().await {
        Ok(_) => 0,
        Err(err) => {
            eprintln!("Backfill failed: {}", err_json(&err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewMemoryEntry;
    use crate::db::testing::test_db;

    fn insert(id: &str, embedding: Option<Vec<u8>>) {
        let mut row = NewMemoryEntry::new("agent-1", format!("memory {id}"), "fact");
        row.id = id.to_string();
        row.embedding = embedding;
        crate::db::run_sync(move |conn| {
            diesel::insert_into(m::memory_entries)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_nothing_to_do_when_every_entry_has_an_embedding() {
        let _db = test_db();
        insert("entry-1", Some(vec![0; 8]));
        assert_eq!(run_backfill().await.unwrap(), BackfillResult::default());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_the_next_page_after_the_last_id_of_the_previous_one() {
        let _db = test_db();
        insert("entry-2", None);
        insert("entry-1", None);
        insert("entry-3", Some(vec![0; 8]));

        let first = next_page(None).await.unwrap();
        let ids: Vec<&str> = first.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["entry-1", "entry-2"]);
        assert_eq!(first[0].agent_id, "agent-1");
        assert_eq!(first[0].content, "memory entry-1");

        let rest = next_page(Some("entry-1".to_string())).await.unwrap();
        let ids: Vec<&str> = rest.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["entry-2"]);
        assert!(
            next_page(Some("entry-2".to_string()))
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn quotes_a_string_as_node_shows_it() {
        assert_eq!(inspect_string("it's"), "'it\\'s'");
    }
}
