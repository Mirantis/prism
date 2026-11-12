//! How the runtime opens its database: the connection settings every connection
//! gets, and the pools behind `crate::db`.
//!
//! Every DateTime is written as epoch milliseconds (`crate::db::sql_types`), since
//! every existing database stores DateTime columns that way.
//!
//! Writes go through one connection. A transaction holds it from its start until it
//! commits or rolls back, and every other write waits for that, so a write made while
//! a transaction is open never runs inside it and never rolls back with it. Reads that
//! ask for it run on connections of their own, which see the last committed state.

use std::sync::{Arc, LazyLock};

use diesel::connection::SimpleConnection;
use diesel::r2d2::{ConnectionManager, CustomizeConnection, Pool};
use diesel::sqlite::SqliteConnection;
use scheduled_thread_pool::ScheduledThreadPool;

use crate::db::{CONNECTION_WAIT, Database};
use crate::lib::sqlite_path::resolve_prisma_sqlite_path;

/// How long a statement waits for a lock another connection holds, as the Prisma
/// adapter's driver waits by default.
pub const BUSY_TIMEOUT_MS: u32 = 5000;

/// Page cache per connection in KiB (a negative `cache_size`), as the Prisma adapter's
/// driver is built with.
const CACHE_SIZE_KIB: i64 = 16_000;

/// How many reading connections a file database keeps beside its writer.
pub const READER_CONNECTIONS: u32 = 4;

/// What a connection is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionRole {
    /// The connection that writes. It puts the file in WAL mode, so readers and the
    /// writer do not block each other.
    Writer,
    /// A connection that refuses writes.
    Reader,
}

/// Applies the settings every connection gets: the driver's lock wait and page
/// cache, foreign keys on, and WAL with `synchronous = NORMAL` for the writer of a
/// file database.
pub fn apply_connection_settings(
    conn: &mut SqliteConnection,
    role: ConnectionRole,
) -> diesel::QueryResult<()> {
    conn.batch_execute(&format!(
        "PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}; PRAGMA foreign_keys = ON; PRAGMA cache_size = -{CACHE_SIZE_KIB};"
    ))?;
    match role {
        ConnectionRole::Writer => {
            conn.batch_execute("PRAGMA journal_mode = WAL;")?;
            conn.batch_execute("PRAGMA synchronous = NORMAL;")
        }
        ConnectionRole::Reader => conn.batch_execute("PRAGMA query_only = ON;"),
    }
}

#[derive(Debug, Clone, Copy)]
struct Settings(ConnectionRole);

impl CustomizeConnection<SqliteConnection, diesel::r2d2::Error> for Settings {
    fn on_acquire(&self, conn: &mut SqliteConnection) -> Result<(), diesel::r2d2::Error> {
        apply_connection_settings(conn, self.0).map_err(diesel::r2d2::Error::QueryError)
    }
}

/// One thread for every pool's connection setup, rather than three per pool.
static POOL_THREADS: LazyLock<Arc<ScheduledThreadPool>> = LazyLock::new(|| {
    Arc::new(
        ScheduledThreadPool::builder()
            .num_threads(1)
            .thread_name_pattern("db-pool-{}")
            .build(),
    )
});

/// Opens the database `database_url` names: one writing connection and, for a file,
/// [`READER_CONNECTIONS`] reading ones. The first connection opens before this
/// returns, so a path that cannot be opened is an error here.
pub fn create_sqlite_adapter(database_url: Option<&str>) -> anyhow::Result<Database> {
    let path = resolve_prisma_sqlite_path(database_url)?;
    // An in-memory database lives as long as its one connection; every other
    // connection would open a database of its own.
    let in_memory = path.starts_with(':');

    let mut probe = crate::db::establish(&path)?;
    apply_connection_settings(&mut probe, ConnectionRole::Writer)?;
    drop(probe);

    let writer = build_pool(&path, ConnectionRole::Writer, 1, 1);
    let readers =
        (!in_memory).then(|| build_pool(&path, ConnectionRole::Reader, READER_CONNECTIONS, 0));
    Ok(Database::from_pools(path, writer, readers))
}

fn build_pool(
    path: &str,
    role: ConnectionRole,
    size: u32,
    min_idle: u32,
) -> Pool<ConnectionManager<SqliteConnection>> {
    crate::db::register_sqlite_vec();
    Pool::builder()
        .max_size(size)
        .min_idle(Some(min_idle))
        .max_lifetime(None)
        .idle_timeout(None)
        .test_on_check_out(false)
        .connection_timeout(CONNECTION_WAIT)
        .connection_customizer(Box::new(Settings(role)))
        .thread_pool(Arc::clone(&POOL_THREADS))
        .build_unchecked(ConnectionManager::new(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{NewAgentWorkspace, NewPendingSlackMessage, PendingSlackMessage};
    use crate::db::schema::{agent_workspaces, pending_slack_messages};
    use diesel::prelude::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    #[serial_test::serial]
    fn keeps_a_write_made_while_another_transaction_is_open_out_of_that_transaction() {
        let test = crate::db::testing::test_db();
        let db = Arc::clone(&test.db);
        db.run_sync(|conn| {
            let mut agent = NewAgentWorkspace::new("user-1", "", "", "", "", "");
            agent.id = "agent-1".into();
            diesel::insert_into(agent_workspaces::table)
                .values(&agent)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();

        let (opened_tx, opened_rx) = mpsc::channel();
        let inside_db = Arc::clone(&db);
        let rolled_back = std::thread::spawn(move || {
            inside_db.run_sync(|conn| {
                conn.transaction::<(), anyhow::Error, _>(|conn| {
                    diesel::insert_into(pending_slack_messages::table)
                        .values(&NewPendingSlackMessage::new("agent-1", "U1", "inside", "1"))
                        .execute(conn)?;
                    opened_tx.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(100));
                    anyhow::bail!("roll back")
                })
            })
        });

        opened_rx.recv().unwrap();
        db.run_sync(|conn| {
            diesel::insert_into(pending_slack_messages::table)
                .values(&NewPendingSlackMessage::new(
                    "agent-1", "U1", "outside", "2",
                ))
                .execute(conn)?;
            Ok(())
        })
        .unwrap();

        let outcome = rolled_back.join().unwrap();
        assert_eq!(outcome.unwrap_err().to_string(), "roll back");
        let texts: Vec<String> = db
            .read_sync(|conn| {
                Ok(pending_slack_messages::table
                    .select(PendingSlackMessage::as_select())
                    .load(conn)?
                    .into_iter()
                    .map(|row| row.text)
                    .collect())
            })
            .unwrap();
        assert_eq!(texts, vec!["outside".to_string()]);
    }

    #[test]
    fn opens_an_in_memory_database_on_one_connection() {
        let db = Arc::new(create_sqlite_adapter(Some(":memory:")).unwrap());
        db.run_sync(|conn| Ok(conn.batch_execute("CREATE TABLE t (x INTEGER)")?))
            .unwrap();
        // A read goes to the same connection, so it sees the table.
        db.read_sync(|conn| Ok(conn.batch_execute("SELECT x FROM t")?))
            .unwrap();
    }

    #[test]
    fn refuses_a_reader_write() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("agent.db");
        let db = create_sqlite_adapter(Some(&format!("file:{}", file.display()))).unwrap();
        db.run_sync(|conn| Ok(conn.batch_execute("CREATE TABLE t (x INTEGER)")?))
            .unwrap();
        let err = db
            .read_sync(|conn| Ok(conn.batch_execute("INSERT INTO t VALUES (1)")?))
            .unwrap_err();
        assert!(err.to_string().contains("readonly"), "{err}");
    }

    #[test]
    fn puts_a_file_database_in_wal_mode_with_foreign_keys_on() {
        #[derive(QueryableByName)]
        struct Mode {
            #[diesel(sql_type = diesel::sql_types::Text)]
            journal_mode: String,
        }
        #[derive(QueryableByName)]
        struct Keys {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            foreign_keys: i64,
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("agent.db");
        let db = create_sqlite_adapter(Some(&format!("file:{}", file.display()))).unwrap();
        let (mode, keys) = db
            .read_sync(|conn| {
                let mode = diesel::sql_query("PRAGMA journal_mode").get_result::<Mode>(conn)?;
                let keys = diesel::sql_query("PRAGMA foreign_keys").get_result::<Keys>(conn)?;
                Ok((mode.journal_mode, keys.foreign_keys))
            })
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(keys, 1);
    }

    #[test]
    fn refuses_a_path_it_cannot_open() {
        let err =
            create_sqlite_adapter(Some("file:/nonexistent-dir-for-test/agent.db")).unwrap_err();
        assert!(
            format!("{err:#}")
                .to_lowercase()
                .contains("unable to open the database file"),
            "{err:#}"
        );
    }
}
