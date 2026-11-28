//! A fresh database for a test: a temporary file, migrated with the committed
//! migrations and bootstrapped with the vector index, installed as the runtime
//! database while the guard lives.
//!
//! The runtime database is one per process, so every test that uses [`test_db`]
//! runs alone: mark it `#[serial_test::serial]`.
//!
//! ```ignore
//! #[tokio::test]
//! #[serial_test::serial]
//! async fn stores_a_message() {
//!     let _db = crate::db::testing::test_db();
//!     // crate::db::run(...) now reaches the fresh database.
//! }
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use super::Database;

/// The installed test database. Dropping it puts back the database it replaced, and
/// the agent and owner ids a test set for its rows, and deletes the file.
pub struct TestDb {
    pub db: Arc<Database>,
    /// The database file.
    pub path: PathBuf,
    /// A `DATABASE_URL` naming the file.
    pub url: String,
    previous: Option<Arc<Database>>,
    agent_id: Option<String>,
    owner_user_id: String,
    dir: Option<tempfile::TempDir>,
}

/// Creates, migrates and installs a fresh database.
pub fn test_db() -> TestDb {
    let dir = tempfile::Builder::new()
        .prefix("prism-db-")
        .tempdir()
        .expect("create a temporary directory");
    let path = dir.path().join("agent.db");
    let url = format!("file:{}", path.display());
    let db = Arc::new(Database::open(Some(&url)).expect("open the test database"));
    db.run_sync(super::migrate)
        .expect("migrate the test database");
    db.run_sync(crate::lib::message_search_index::ensure)
        .expect("index the test database");

    crate::lib::sqlite_bootstrap::close_sqlite_vec();
    let previous = super::set_database(Some(Arc::clone(&db)));
    crate::lib::sqlite_bootstrap::init_sqlite_vec().expect("bootstrap the test database");
    TestDb {
        db,
        path,
        url,
        previous,
        agent_id: crate::config::CONFIG.agent_id(),
        owner_user_id: crate::config::CONFIG.owner_user_id(),
        dir: Some(dir),
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        crate::config::CONFIG.set_agent_id(self.agent_id.take());
        crate::config::CONFIG.set_owner_user_id(std::mem::take(&mut self.owner_user_id));
        crate::lib::sqlite_bootstrap::close_sqlite_vec();
        super::set_database(self.previous.take());
        // The pool's connections close with the last handle; the directory goes after.
        let dir = self.dir.take();
        drop(dir);
    }
}
