//! apply-pending-import: runs before anything opens the SQLite DB.
//!
//! Runs ahead of the runtime in production (`start.sh`) and in development. When
//! the previous run staged a `.prism` restore (renamed the validated file to
//! `<db>.next` next to the live DB), this promotes that file in place. No-op when
//! nothing is staged.
//!
//! The live DB path is encoded in `DATABASE_URL` as a `file:…` URL that resolves
//! relative to the schema directory, not the current working directory; that
//! convention lives in `lib/sqlite_path`. `.env` in the current directory is
//! loaded first, so development picks the URL up from it.

use std::path::Path;

use crate::lib::environment::load_dotenv_from;
use crate::lib::sqlite_path::resolve_prisma_sqlite_path;

/// Removes a file, ignoring one that is not there (`fs.rmSync(path, { force: true })`).
fn remove_if_present(path: &str) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub fn apply_pending_import() -> anyhow::Result<()> {
    let database_url = std::env::var("DATABASE_URL").ok();
    let Some(database_url) = database_url.filter(|url| url.starts_with("file:")) else {
        // Not an SQLite file: nothing to swap.
        return Ok(());
    };

    let db_path = resolve_prisma_sqlite_path(Some(&database_url))?;
    let next = format!("{db_path}.next");

    if !Path::new(&next).exists() {
        return Ok(());
    }

    // Drop WAL/SHM sidecars from the old inode so the restored file isn't
    // paired with stale write-ahead logs on first open.
    remove_if_present(&db_path)?;
    remove_if_present(&format!("{db_path}-wal"))?;
    remove_if_present(&format!("{db_path}-shm"))?;
    std::fs::rename(&next, &db_path)?;

    // stderr, the stream `start.sh` writes to; stdout is left to tooling.
    eprintln!("[apply-pending-import] applied pending .prism import at {db_path}");
    Ok(())
}

/// The script's entry: loads `.env` from the current directory, then applies the import.
pub fn run() -> anyhow::Result<()> {
    let env_path = std::env::current_dir().unwrap_or_default().join(".env");
    load_dotenv_from(&env_path);
    apply_pending_import()
}
