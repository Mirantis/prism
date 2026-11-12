//! The runtime database: the Diesel schema and models of the Prisma schema, the
//! connection pool, and the migrations the binary carries.
//!
//! Every query runs on a pooled `SqliteConnection` off the async threads:
//!
//! ```ignore
//! use crate::db::schema::conversation_messages::dsl as m;
//! let rows = crate::db::run(move |conn| {
//!     Ok(m::conversation_messages
//!         .filter(m::thread_id.eq(&thread_id))
//!         .order(m::created_at.asc())
//!         .select(ConversationMessage::as_select())
//!         .load(conn)?)
//! })
//! .await?;
//! ```
//!
//! [`run`] runs on the one writing connection, so a transaction
//! (`conn.transaction(|conn| …)`) holds the database from its start to its end and
//! every other [`run`] waits for it, as every Prisma query waits for an open
//! interactive transaction. [`read`] runs on a connection that cannot write, beside
//! the writer, for a read that should not queue behind writes. A closure must not
//! reach the database again through these functions on the same thread; that would
//! wait for the connection it holds, and is refused.

pub mod models;
pub mod schema;
pub mod sql_types;

#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::sync::{Arc, Once};
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use diesel::Connection;
use diesel::r2d2::{ConnectionManager, Pool, PooledConnection};
use diesel::sqlite::SqliteConnection;
use libsqlite3_sys as ffi;
use parking_lot::RwLock;

use crate::sea::migrate::{Migration, apply_migrations};

/// The committed migrations under `prisma/sqlite/migrations`, in name order, read
/// into the binary at build time.
pub static MIGRATIONS: &[Migration<'static>] = include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// How long a caller waits for a pooled connection before the wait is an error.
pub const CONNECTION_WAIT: Duration = Duration::from_secs(60);

type SqlitePool = Pool<ConnectionManager<SqliteConnection>>;

/// One database file: the writing connection and the reading ones.
pub struct Database {
    path: String,
    writer: SqlitePool,
    /// `None` for an in-memory database, whose every connection would be a database
    /// of its own; reads then use the writer.
    readers: Option<SqlitePool>,
}

impl std::fmt::Debug for Database {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Database")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

thread_local! {
    /// The databases whose writing connection this thread holds, by address.
    static HELD_WRITERS: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

impl Database {
    /// Opens the database `DATABASE_URL` names, with the runtime's connection settings.
    pub fn open(database_url: Option<&str>) -> anyhow::Result<Database> {
        crate::lib::prisma_adapter::create_sqlite_adapter(database_url)
    }

    pub(crate) fn from_pools(
        path: String,
        writer: SqlitePool,
        readers: Option<SqlitePool>,
    ) -> Database {
        Database {
            path,
            writer,
            readers,
        }
    }

    /// The file the connections open, as `resolve_prisma_sqlite_path` resolved it.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Runs `f` on the writing connection, on this thread.
    pub fn run_sync<T>(
        &self,
        f: impl FnOnce(&mut SqliteConnection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let key = self as *const Database as usize;
        if HELD_WRITERS.with_borrow(|held| held.contains(&key)) {
            bail!("nested database access: this thread already holds the database connection");
        }
        let mut conn = checkout(&self.writer)?;
        HELD_WRITERS.with_borrow_mut(|held| held.push(key));
        let _release = ReleaseWriter(key);
        f(&mut conn)
    }

    /// Runs `f` on a connection that cannot write, on this thread.
    pub fn read_sync<T>(
        &self,
        f: impl FnOnce(&mut SqliteConnection) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        match &self.readers {
            Some(readers) => {
                let mut conn = checkout(readers)?;
                f(&mut conn)
            }
            None => self.run_sync(f),
        }
    }

    /// [`Database::run_sync`] on a blocking thread.
    pub async fn run<T, F>(self: &Arc<Self>, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&mut SqliteConnection) -> anyhow::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let db = Arc::clone(self);
        blocking(move || db.run_sync(f)).await
    }

    /// [`Database::read_sync`] on a blocking thread.
    pub async fn read<T, F>(self: &Arc<Self>, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&mut SqliteConnection) -> anyhow::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let db = Arc::clone(self);
        blocking(move || db.read_sync(f)).await
    }
}

/// Takes a database off [`HELD_WRITERS`] when the closure returns or unwinds.
struct ReleaseWriter(usize);

impl Drop for ReleaseWriter {
    fn drop(&mut self) {
        HELD_WRITERS.with_borrow_mut(|held| held.retain(|key| *key != self.0));
    }
}

fn checkout(
    pool: &SqlitePool,
) -> anyhow::Result<PooledConnection<ConnectionManager<SqliteConnection>>> {
    pool.get_timeout(CONNECTION_WAIT)
        .context("failed to get a database connection")
}

async fn blocking<T, F>(f: F) -> anyhow::Result<T>
where
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        Err(err) => Err(anyhow!(err).context("database task was cancelled")),
    }
}

// ---------------------------------------------------------------- the global handle

static CURRENT: RwLock<Option<Arc<Database>>> = RwLock::new(None);

/// The `DATABASE_URL` the runtime opens. Unit tests open an empty in-memory
/// database unless they install one with [`testing::test_db`].
fn configured_url() -> Option<String> {
    if cfg!(test) {
        return Some("file::memory:".to_string());
    }
    Some(crate::config::CONFIG.database_url.clone())
}

/// The runtime's database, opened from `DATABASE_URL` on first use.
pub fn database() -> anyhow::Result<Arc<Database>> {
    if let Some(db) = CURRENT.read().as_ref() {
        return Ok(Arc::clone(db));
    }
    let mut current = CURRENT.write();
    if let Some(db) = current.as_ref() {
        return Ok(Arc::clone(db));
    }
    let db = Arc::new(Database::open(configured_url().as_deref())?);
    *current = Some(Arc::clone(&db));
    Ok(db)
}

/// Replaces the runtime's database and returns the one it held. `None` makes the
/// next use open `DATABASE_URL` again.
pub fn set_database(db: Option<Arc<Database>>) -> Option<Arc<Database>> {
    std::mem::replace(&mut *CURRENT.write(), db)
}

/// Runs `f` on the runtime database's writing connection, off the async threads.
pub async fn run<T, F>(f: F) -> anyhow::Result<T>
where
    F: FnOnce(&mut SqliteConnection) -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    blocking(move || database()?.run_sync(f)).await
}

/// Runs `f` on the runtime database's writing connection, on this thread: for boot
/// code and other code that is already off the async threads.
pub fn run_sync<T>(
    f: impl FnOnce(&mut SqliteConnection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    database()?.run_sync(f)
}

/// Runs `f` on a connection of the runtime database that cannot write, off the async
/// threads.
pub async fn read<T, F>(f: F) -> anyhow::Result<T>
where
    F: FnOnce(&mut SqliteConnection) -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    blocking(move || database()?.read_sync(f)).await
}

/// [`read`] on this thread.
pub fn read_sync<T>(
    f: impl FnOnce(&mut SqliteConnection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    database()?.read_sync(f)
}

/// Applies the committed migrations the database does not have yet, and returns the
/// names it applied.
pub fn migrate(conn: &mut SqliteConnection) -> anyhow::Result<Vec<String>> {
    apply_migrations(conn, MIGRATIONS)
}

// ---------------------------------------------------------------- connections

/// Opens one connection to `path` with the runtime's connection settings, outside the
/// pool: for a file other than the runtime database, such as an archive.
pub fn open_connection(path: &str) -> anyhow::Result<SqliteConnection> {
    let mut conn = establish(path)?;
    crate::lib::prisma_adapter::apply_connection_settings(
        &mut conn,
        crate::lib::prisma_adapter::ConnectionRole::Writer,
    )
    .with_context(|| format!("failed to configure the database connection to {path}"))?;
    Ok(conn)
}

/// Opens one read-only connection to an existing file at `path`.
pub fn open_readonly(path: &str) -> anyhow::Result<SqliteConnection> {
    if !std::path::Path::new(path).exists() {
        bail!("unable to open database file: {path}");
    }
    let uri = format!("file:{}?mode=ro", percent_encode_path(path));
    let mut conn = establish(&uri)?;
    crate::lib::prisma_adapter::apply_connection_settings(
        &mut conn,
        crate::lib::prisma_adapter::ConnectionRole::Reader,
    )
    .with_context(|| format!("failed to configure the database connection to {path}"))?;
    Ok(conn)
}

/// Opens a connection with sqlite-vec available, and nothing else applied.
pub(crate) fn establish(target: &str) -> anyhow::Result<SqliteConnection> {
    register_sqlite_vec();
    SqliteConnection::establish(target)
        .with_context(|| format!("failed to open the database at {target}"))
}

/// A path as the path of a `file:` URI: `%`, `?` and `#` would otherwise end or
/// change it.
fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '?' => out.push_str("%3f"),
            '#' => out.push_str("%23"),
            _ => out.push(ch),
        }
    }
    out
}

/// Makes every connection this process opens from now on start with sqlite-vec loaded
/// and with the driver defaults the Prisma adapter's driver is built with.
pub fn register_sqlite_vec() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        // SAFETY: `init_connection` has the entry-point signature SQLite calls an
        // automatic extension with, and lives for the whole process.
        let rc = unsafe { ffi::sqlite3_auto_extension(Some(init_connection)) };
        assert_eq!(
            rc,
            ffi::SQLITE_OK,
            "sqlite3_auto_extension failed with code {rc}"
        );
    });
}

/// Runs on every new connection: turns off double-quoted string literals, as the
/// driver build the Prisma adapter uses does, then loads sqlite-vec.
unsafe extern "C" fn init_connection(
    db: *mut ffi::sqlite3,
    err: *mut *mut std::os::raw::c_char,
    api: *const ffi::sqlite3_api_routines,
) -> std::os::raw::c_int {
    type EntryPoint = unsafe extern "C" fn(
        *mut ffi::sqlite3,
        *mut *mut std::os::raw::c_char,
        *const ffi::sqlite3_api_routines,
    ) -> std::os::raw::c_int;
    // SAFETY: SQLite passes a live connection; the two options take an int and a
    // nullable out-pointer. `sqlite3_vec_init` is the extension's entry point, declared
    // without parameters by its crate but defined in C with this signature.
    unsafe {
        ffi::sqlite3_db_config(
            db,
            ffi::SQLITE_DBCONFIG_DQS_DML,
            0 as std::os::raw::c_int,
            std::ptr::null_mut::<std::os::raw::c_int>(),
        );
        ffi::sqlite3_db_config(
            db,
            ffi::SQLITE_DBCONFIG_DQS_DDL,
            0 as std::os::raw::c_int,
            std::ptr::null_mut::<std::os::raw::c_int>(),
        );
        let vec_init: EntryPoint = std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        vec_init(db, err, api)
    }
}
