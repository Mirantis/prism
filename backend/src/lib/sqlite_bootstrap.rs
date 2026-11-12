//! SQLite bootstrap.
//!
//! Every connection the runtime opens has the sqlite-vec extension (see
//! `crate::db::register_sqlite_vec`), so the vector operations run on the runtime
//! database's own connections, and WAL mode and foreign keys are among the settings
//! every connection gets (`lib::prisma_adapter`).
//!
//! This module:
//!   - logs where the vector index lives and which sqlite-vec version is loaded
//!   - ensures the `memory_entry_vec` virtual table exists, rebuilt from the
//!     `memory_entries.embedding` BLOBs

use std::sync::Arc;

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::{Binary, Text};
use parking_lot::Mutex;
use serde_json::json;

use crate::db::Database;
use crate::db::schema::memory_entries;
use crate::lib::embedding_providers::embedding_provider::EMBEDDING_DIMENSIONS;
use crate::{log_info, log_warn};

// One source of truth for the vector width: the embedding-provider contract
// declares it (a light, dependency-free module every vendor imports), and the
// vec0 index here consumes it — so the index and the vendors' truncation
// targets cannot drift apart.
const EMBEDDING_DIM: usize = EMBEDDING_DIMENSIONS;

pub const EMBEDDING_DIMENSION: usize = EMBEDDING_DIM;

/// The database the vector index was built on.
static HANDLE: Mutex<Option<Arc<Database>>> = Mutex::new(None);

#[derive(QueryableByName)]
struct VecVersion {
    #[diesel(sql_type = Text)]
    v: String,
}

#[derive(QueryableByName)]
struct TableName {
    #[diesel(sql_type = Text)]
    #[allow(dead_code)]
    name: String,
}

/// Initialize the vector index on the runtime database. Safe to call more than
/// once — subsequent calls return the same handle. Blocks the calling thread for
/// the rebuild.
pub fn init_sqlite_vec() -> anyhow::Result<Arc<Database>> {
    let mut handle = HANDLE.lock();
    if let Some(db) = handle.as_ref() {
        return Ok(Arc::clone(db));
    }

    let db = crate::db::database()?;
    log_info!(
        json!({ "path": db.path() }),
        "[SqliteBootstrap] opening database for vec operations"
    );

    db.run_sync(|conn| {
        let version = diesel::sql_query("SELECT vec_version() AS v")
            .get_result::<VecVersion>(conn)?
            .v;
        log_info!(
            json!({ "version": version }),
            "[SqliteBootstrap] sqlite-vec loaded"
        );

        // vec0 is a runtime index — rebuilt from the `memory_entries.embedding`
        // BLOB column on every boot. The durable BLOBs in `memory_entries` are the
        // source of truth; this is cheap (microseconds per row) and self-healing.
        //
        // We DROP + CREATE on every boot rather than `IF NOT EXISTS` so any
        // schema change in this file (e.g. distance metric, dimension) takes
        // effect on the next process start without operator intervention.
        // sqlite-vec defaults `distance_metric` to L2 — explicitly request
        // cosine here because Titan v2 produces unit-normalized vectors and
        // the rest of the stack (`memory_store` threshold conversion,
        // pgvector parity) is built around cosine distance.
        //
        // FIXME(memory-rebuild-scale): unconditional rebuild is fine for the
        // realistic scale per agent (hundreds–low thousands of entries =
        // sub-second cold start) but becomes an issue at 10k+ entries
        // (seconds → tens of seconds). Likely fix is a schema-version sentinel
        // (e.g. `pragma user_version`) that skips the rebuild when the
        // existing vec0 already matches the current expected version. Punted
        // because we expect to revisit the memory system architecture before
        // agents accumulate that much memory.
        conn.batch_execute("DROP TABLE IF EXISTS memory_entry_vec")?;
        conn.batch_execute(&format!(
            "CREATE VIRTUAL TABLE memory_entry_vec USING vec0(
       memory_entry_id TEXT PRIMARY KEY,
       embedding float[{EMBEDDING_DIM}] distance_metric=cosine
     )"
        ))?;

        rebuild_vec0_index(conn)
    })?;

    *handle = Some(Arc::clone(&db));
    Ok(db)
}

fn rebuild_vec0_index(conn: &mut SqliteConnection) -> anyhow::Result<()> {
    // Defensive: in normal boot the migrations run before this code, so
    // `memory_entries` always exists. This guard only matters for bare test
    // setups or future call sites that skip the migrations.
    let has_memory_entries = diesel::sql_query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'",
    )
    .get_result::<TableName>(conn)
    .optional()?
    .is_some();
    if !has_memory_entries {
        return Ok(());
    }

    let rows: Vec<(String, Option<Vec<u8>>)> = memory_entries::table
        .filter(memory_entries::embedding.is_not_null())
        .select((memory_entries::id, memory_entries::embedding))
        .load(conn)?;

    let total = rows.len();
    let added = conn.transaction::<_, anyhow::Error, _>(|conn| {
        let mut added = 0_usize;
        for (id, embedding) in &rows {
            let Some(embedding) = embedding else { continue };
            // Sanity: each BLOB should be EMBEDDING_DIM * 4 bytes (Float32).
            if embedding.len() != EMBEDDING_DIM * 4 {
                continue;
            }
            diesel::sql_query(
                "INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)",
            )
            .bind::<Text, _>(id)
            .bind::<Binary, _>(embedding)
            .execute(conn)?;
            added += 1;
        }
        Ok(added)
    })?;
    if added > 0 {
        log_info!(
            json!({ "added": added, "total": total }),
            "[SqliteBootstrap] rebuilt vec0 index from BLOBs"
        );
    }
    Ok(())
}

/// Make sure a connection this module did not open has sqlite-vec. Needed by any
/// code that opens its own connection to the live DB and runs schema-level ops
/// (`VACUUM INTO`, `PRAGMA integrity_check`, etc.) — without the extension, those
/// fail with `no such module: vec0` on the `memory_entry_vec` virtual table that
/// [`init_sqlite_vec`] persists in the file. A connection opened through
/// `crate::db` has it from the start; this checks that it is there.
pub fn load_sqlite_vec(conn: &mut SqliteConnection) -> anyhow::Result<()> {
    crate::db::register_sqlite_vec();
    diesel::sql_query("SELECT vec_version() AS v")
        .get_result::<VecVersion>(conn)
        .map(|_| ())
        .map_err(|e| {
            anyhow::anyhow!(
                "sqlite-vec is not loaded on this connection; open it through crate::db: {e}"
            )
        })
}

/// Access the initialized handle. Errors if init has not been called.
pub fn get_sqlite_vec() -> anyhow::Result<Arc<Database>> {
    HANDLE.lock().as_ref().map(Arc::clone).ok_or_else(|| {
        anyhow::anyhow!("SQLite vec handle is not initialized — call init_sqlite_vec() first")
    })
}

/// Release the handle (graceful-shutdown path). The next [`init_sqlite_vec`]
/// rebuilds the index.
pub fn close_sqlite_vec() {
    HANDLE.lock().take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(QueryableByName)]
    struct Hit {
        #[diesel(sql_type = Text)]
        id: String,
        #[diesel(sql_type = diesel::sql_types::Double)]
        distance: f64,
    }

    #[derive(QueryableByName)]
    struct Name {
        #[diesel(sql_type = Text)]
        name: String,
    }

    fn packed(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    /// A fresh in-memory runtime database, as the unit-test configuration opens.
    struct MemoryDb(Option<Arc<Database>>);

    impl MemoryDb {
        fn install() -> MemoryDb {
            close_sqlite_vec();
            let db = Arc::new(Database::open(Some(":memory:")).unwrap());
            MemoryDb(crate::db::set_database(Some(db)))
        }
    }

    impl Drop for MemoryDb {
        fn drop(&mut self) {
            close_sqlite_vec();
            crate::db::set_database(self.0.take());
        }
    }

    #[test]
    #[serial_test::serial]
    fn opens_a_handle_with_sqlite_vec_loaded() {
        let _db = MemoryDb::install();
        let db = init_sqlite_vec().unwrap();
        let version = db
            .run_sync(|conn| {
                Ok(diesel::sql_query("SELECT vec_version() AS v")
                    .get_result::<VecVersion>(conn)?
                    .v)
            })
            .unwrap();
        assert!(
            regex::Regex::new(r"^v\d+\.").unwrap().is_match(&version),
            "{version}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn creates_the_memory_entry_vec_virtual_table() {
        let _db = MemoryDb::install();
        let db = init_sqlite_vec().unwrap();
        let tables: Vec<String> = db
            .run_sync(|conn| {
                Ok(diesel::sql_query(
                    "SELECT name FROM sqlite_master WHERE type='table' OR type='virtual' ORDER BY name",
                )
                .load::<Name>(conn)?
                .into_iter()
                .map(|row| row.name)
                .collect())
            })
            .unwrap();
        assert!(
            tables.contains(&"memory_entry_vec".to_string()),
            "{tables:?}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn supports_insert_and_match_for_knn_search() {
        let _db = MemoryDb::install();
        let db = init_sqlite_vec().unwrap();

        // Seed with three small vectors in a test table of our own, rather than the
        // production 1024-d one, so the test stays fast.
        let rows = db
            .run_sync(|conn| {
                conn.batch_execute(
                    "CREATE VIRTUAL TABLE t_vec USING vec0(id TEXT PRIMARY KEY, emb float[3])",
                )?;
                for (id, v) in [
                    ("a", [1.0, 0.0, 0.0]),
                    ("b", [0.0, 1.0, 0.0]),
                    ("c", [0.9, 0.1, 0.0]),
                ] {
                    diesel::sql_query("INSERT INTO t_vec(id, emb) VALUES (?, ?)")
                        .bind::<Text, _>(id)
                        .bind::<Binary, _>(packed(&v))
                        .execute(conn)?;
                }
                Ok(diesel::sql_query(
                    "SELECT id, distance FROM t_vec WHERE emb MATCH ? ORDER BY distance LIMIT 2",
                )
                .bind::<Binary, _>(packed(&[1.0, 0.0, 0.0]))
                .load::<Hit>(conn)?)
            })
            .unwrap();

        assert_eq!(rows[0].id, "a");
        assert_eq!(rows[0].distance, 0.0);
        assert_eq!(rows[1].id, "c");
        assert_eq!(EMBEDDING_DIMENSION, 1024);
    }

    #[test]
    #[serial_test::serial]
    fn is_idempotent_second_init_returns_the_same_handle() {
        let _db = MemoryDb::install();
        let first = init_sqlite_vec().unwrap();
        let second = init_sqlite_vec().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn throws_when_database_url_is_unset() {
        let err = Database::open(None).unwrap_err();
        assert!(
            err.to_string().contains("DATABASE_URL is required"),
            "{err}"
        );
    }

    #[test]
    #[serial_test::serial]
    fn memory_entry_vec_uses_cosine_distance_not_the_l2_default() {
        // Distinguish L2 from cosine using direction-only differences:
        //   query  = [1, 0]
        //   close  = [10, 0]   — same direction (cos sim 1.0), L2 distance 9
        //   right  = [1, 1]    — 45° off  (cos sim ~0.707), L2 distance 1
        // Under L2: `right` (dist 1) is closer than `close` (dist 9).
        // Under cosine: `close` (dist 0) is closer than `right` (dist ~0.293).
        let _db = MemoryDb::install();
        let db = init_sqlite_vec().unwrap();

        // Pad to the production dimension (1024) so vec0 accepts the BLOB.
        let pad = |head: &[f32]| {
            let mut v = head.to_vec();
            v.resize(1024, 0.0);
            packed(&v)
        };
        let rows = db
            .run_sync(|conn| {
                for (id, head) in [("close", [10.0, 0.0]), ("right", [1.0, 1.0])] {
                    diesel::sql_query(
                        "INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)",
                    )
                    .bind::<Text, _>(id)
                    .bind::<Binary, _>(pad(&head))
                    .execute(conn)?;
                }
                Ok(diesel::sql_query(
                    "SELECT memory_entry_id AS id, distance FROM memory_entry_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT 2",
                )
                .bind::<Binary, _>(pad(&[1.0, 0.0]))
                .load::<Hit>(conn)?)
            })
            .unwrap();

        assert_eq!(rows[0].id, "close");
        assert!(rows[0].distance.abs() < 1e-5, "{}", rows[0].distance);
        assert_eq!(rows[1].id, "right");
    }

    #[test]
    #[serial_test::serial]
    fn rebuilds_the_index_from_the_stored_blobs() {
        use crate::db::models::{NewAgentWorkspace, NewMemoryEntry};
        use crate::db::schema::agent_workspaces;

        let test = crate::db::testing::test_db();
        let mut good = vec![0.0_f32; 1024];
        good[0] = 1.0;
        test.db
            .run_sync(|conn| {
                let mut agent = NewAgentWorkspace::new("user-1", "", "", "", "", "");
                agent.id = "agent-1".into();
                diesel::insert_into(agent_workspaces::table)
                    .values(&agent)
                    .execute(conn)?;
                let mut kept = NewMemoryEntry::new("agent-1", "kept", "fact");
                kept.embedding = Some(packed(&good));
                let mut short = NewMemoryEntry::new("agent-1", "short", "fact");
                short.embedding = Some(packed(&[1.0, 0.0]));
                let none = NewMemoryEntry::new("agent-1", "none", "fact");
                diesel::insert_into(memory_entries::table)
                    .values(&vec![kept, short, none])
                    .execute(conn)?;
                Ok(())
            })
            .unwrap();

        close_sqlite_vec();
        let db = init_sqlite_vec().unwrap();
        let ids: Vec<String> = db
            .run_sync(|conn| {
                Ok(
                    diesel::sql_query("SELECT memory_entry_id AS name FROM memory_entry_vec")
                        .load::<Name>(conn)?
                        .into_iter()
                        .map(|row| row.name)
                        .collect(),
                )
            })
            .unwrap();
        let kept: String = test
            .db
            .run_sync(|conn| {
                Ok(memory_entries::table
                    .filter(memory_entries::content.eq("kept"))
                    .select(memory_entries::id)
                    .first(conn)?)
            })
            .unwrap();
        assert_eq!(ids, vec![kept]);
    }
}
