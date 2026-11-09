//! Agent Archive Service
//!
//! Save-game / restore for a Prism Agent container. A `.prism` file is a
//! gzipped copy of `/data/agent.db`. Export takes a consistent VACUUM
//! INTO snapshot (so live writes from heartbeat/cron don't tear the
//! file). Import gunzips to a private scratch file next to the live DB,
//! validates it, and only then atomic-renames to `/data/agent.db.next`
//! — that one file's existence is the entire pending-import protocol,
//! no separate marker. The caller then exits, and on next boot
//! `apply_pending_import` (run by both `start.sh` in prod and the
//! `dev:single` npm script in dev) renames `.next` into place before any
//! process opens the DB.
//!
//! Validation on import: PRAGMA integrity_check + an exact match of the
//! applied Prisma migration set between the uploaded file and the
//! runtime's current DB. A mismatch is rejected up front so we never
//! restart into a file the runtime can't read.
//!
//! `export_agent()` snapshots the live SQLite at `config.database_url`.

use std::io::Write;
use std::path::Path;
use std::pin::Pin;
use std::sync::LazyLock;

use bytes::Bytes;
use chrono::{DateTime, Local, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::Text;
use flate2::Compression;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::StreamReader;
use uuid::Uuid;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::lib::sqlite_bootstrap::load_sqlite_vec;
use crate::lib::sqlite_path::resolve_prisma_sqlite_path;
use crate::lib::telemetry::track_event;
use crate::{log_info, log_warn};

/// A user-facing rejection of an uploaded archive; the caller answers it with a 400.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ArchiveValidationError(pub String);

impl ArchiveValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        static REGISTER_LOG_FIELDS: std::sync::Once = std::sync::Once::new();
        REGISTER_LOG_FIELDS
            .call_once(|| crate::lib::log_redaction::register_error_fields(archive_error_name));
        Self(message.into())
    }
}

/// The error's `name`, so a log line reads `ArchiveValidationError`.
fn archive_error_name(
    error: &(dyn std::error::Error + 'static),
) -> Option<serde_json::Map<String, serde_json::Value>> {
    error.downcast_ref::<ArchiveValidationError>()?;
    let mut fields = serde_json::Map::new();
    fields.insert("name".into(), json!("ArchiveValidationError"));
    Some(fields)
}

/// An export: the gzipped snapshot as a byte stream, the suggested filename, and
/// the cleanup that removes the temp snapshot once the stream is done.
pub struct ExportedAgent {
    pub stream: Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    pub filename: String,
    pub cleanup: Box<dyn FnOnce() + Send>,
}

fn resolve_db_path() -> anyhow::Result<String> {
    resolve_prisma_sqlite_path(Some(&CONFIG.database_url))
}

static NON_SLUG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9]+").expect("valid slug pattern"));
static EDGE_DASHES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-+|-+$").expect("valid dash pattern"));

fn slugify(s: &str) -> String {
    let lowered = s.to_lowercase();
    let dashed = NON_SLUG.replace_all(crate::support::js::trim(&lowered), "-");
    let slug = EDGE_DASHES.replace_all(&dashed, "");
    if slug.is_empty() {
        "agent".to_string()
    } else {
        slug.into_owned()
    }
}

/// `YYYYMMDD-HHMM` in the local time zone.
fn date_stamp(d: DateTime<Utc>) -> String {
    d.with_timezone(&Local).format("%Y%m%d-%H%M").to_string()
}

#[derive(QueryableByName)]
struct MigrationName {
    #[diesel(sql_type = Text)]
    migration_name: String,
}

#[derive(QueryableByName)]
struct IntegrityCheck {
    #[diesel(sql_type = Text)]
    integrity_check: String,
}

/// The finished migrations a database records, in the order it records them.
fn get_applied_migrations(conn: &mut SqliteConnection) -> anyhow::Result<IndexSet<String>> {
    let rows: Vec<MigrationName> = diesel::sql_query(
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL",
    )
    .load(conn)?;
    Ok(rows.into_iter().map(|r| r.migration_name).collect())
}

fn sets_equal(a: &IndexSet<String>, b: &IndexSet<String>) -> bool {
    a.len() == b.len() && a.iter().all(|v| b.contains(v))
}

/// Opens a database file read-only, with sqlite-vec loaded.
fn open_readonly(path: &str) -> anyhow::Result<SqliteConnection> {
    let mut conn = crate::db::open_readonly(path)?;
    load_sqlite_vec(&mut conn)?;
    Ok(conn)
}

/// The text Node's `err.message` gives for the decompression failures a bad
/// upload produces, else the error's own text.
fn gunzip_message(err: &std::io::Error) -> String {
    let text = err.to_string();
    if text.contains("invalid gzip header") {
        return "incorrect header check".to_string();
    }
    if err.kind() == std::io::ErrorKind::UnexpectedEof {
        return "unexpected end of file".to_string();
    }
    text
}

/// A `Write` that hands each buffer to the export stream.
struct ChannelWriter(mpsc::Sender<std::io::Result<Bytes>>);

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .blocking_send(Ok(Bytes::copy_from_slice(buf)))
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "export stream closed")
            })?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Export the current agent DB to a gzipped byte stream + suggested
/// filename. Caller is responsible for streaming it to the HTTP
/// response and calling `cleanup` to unlink the temp snapshot when done.
pub async fn export_agent(agent_name: &str) -> anyhow::Result<ExportedAgent> {
    export_from(&resolve_db_path()?, agent_name).await
}

/// `export_agent` of the database file at `src`.
async fn export_from(src: &str, agent_name: &str) -> anyhow::Result<ExportedAgent> {
    if !Path::new(src).exists() {
        anyhow::bail!("Agent database not found at {src}");
    }

    let snapshot_path = std::env::temp_dir()
        .join(format!("prism-export-{}.db", Uuid::new_v4()))
        .to_string_lossy()
        .into_owned();

    // VACUUM INTO produces a self-contained, consistent snapshot — safe even
    // while the runtime is mid-write on the live DB. The live DB carries a
    // `memory_entry_vec` virtual table (rebuilt by sqlite_bootstrap each
    // boot), so the handle must have sqlite-vec before VACUUM walks every
    // table's schema — otherwise it fails with `no such module: vec0`.
    {
        let src = src.to_string();
        let snapshot = snapshot_path.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let mut handle = open_readonly(&src)?;
            // The handle refuses writes to the live file by its open mode; the
            // snapshot is a write to another file, which `query_only` would refuse.
            handle.batch_execute("PRAGMA query_only = OFF")?;
            diesel::sql_query("VACUUM INTO ?")
                .bind::<Text, _>(&snapshot)
                .execute(&mut handle)?;
            Ok(())
        })
        .await??;
    }

    let (tx, rx) = mpsc::channel::<std::io::Result<Bytes>>(8);
    let snapshot = snapshot_path.clone();
    tokio::task::spawn_blocking(move || {
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::open(&snapshot)?;
            let writer = std::io::BufWriter::with_capacity(64 * 1024, ChannelWriter(tx.clone()));
            let mut encoder = GzEncoder::new(writer, Compression::default());
            std::io::copy(&mut file, &mut encoder)?;
            encoder.finish()?.flush()?;
            Ok(())
        })();
        if let Err(err) = result {
            let _ = tx.blocking_send(Err(err));
        }
    });

    let stream = StreamReader::new(ReceiverStream::new(rx));
    let filename = format!("{}-{}.prism", slugify(agent_name), date_stamp(Utc::now()));
    let cleanup = Box::new(move || {
        let _ = std::fs::remove_file(&snapshot_path);
    });

    Ok(ExportedAgent {
        stream: Box::pin(stream),
        filename,
        cleanup,
    })
}

/// Stage an uploaded `.prism` for the next process restart.
///
/// Steps:
///   1. Gunzip the buffer to a private `.import-staging-<uuid>.db` next
///      to the live DB.
///   2. Open it read-only, run `PRAGMA integrity_check`, and confirm the
///      applied migration set matches the current DB.
///   3. Atomic-rename the validated file to `<liveDb>.next`. That rename is
///      the entire signal — `apply_pending_import` checks only `.next`.
///
/// Fails with `ArchiveValidationError` for user-facing rejections; the caller
/// should surface those as 400s. Cleans up the staging file on rejection so
/// partial writes never land at `.next`.
pub async fn import_agent(buffer: &[u8]) -> anyhow::Result<()> {
    import_into(&resolve_db_path()?, buffer).await
}

/// `import_agent` against the live database file at `live_db`.
async fn import_into(live_db: &str, buffer: &[u8]) -> anyhow::Result<()> {
    let dst = format!("{live_db}.next");

    // gunzip to a unique scratch file in the same directory as the live DB,
    // not directly to `<db>.next`. The atomic rename at the end is the signal
    // a pending import is ready — its absence means there's either nothing
    // staged or staging didn't complete, so the boot-time swap path has no
    // marker file to coordinate with.
    let staging_path = Path::new(live_db)
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".import-staging-{}.db", Uuid::new_v4()))
        .to_string_lossy()
        .into_owned();

    // 1. gunzip → staging
    let gunzipped = {
        let buffer = buffer.to_vec();
        let staging = staging_path.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut decoder = MultiGzDecoder::new(buffer.as_slice());
            let mut out = std::fs::File::create(&staging)?;
            std::io::copy(&mut decoder, &mut out)?;
            out.flush()
        })
        .await?
    };
    if let Err(err) = gunzipped {
        safe_unlink(&staging_path);
        return Err(ArchiveValidationError::new(format!(
            "Failed to decompress archive: {}",
            gunzip_message(&err)
        ))
        .into());
    }

    // 2. Validate the staged file before promoting it. Both handles need
    // sqlite-vec — the staged file is a normal `.prism` export from a running
    // runtime so it carries the `memory_entry_vec` virtual table, and the live
    // DB has the same table from this runtime's own bootstrap rebuild on boot.
    // Without the extension, `PRAGMA integrity_check` errors on `no such
    // module: vec0`.
    let validated = {
        let staging = staging_path.clone();
        let live_db = live_db.to_string();
        tokio::task::spawn_blocking(move || validate(&staging, &live_db)).await?
    };
    if let Err(err) = validated {
        safe_unlink(&staging_path);
        if err.downcast_ref::<ArchiveValidationError>().is_some() {
            return Err(err);
        }
        return Err(ArchiveValidationError::new(format!(
            "Failed to validate archive: {}",
            err.root_cause()
        ))
        .into());
    }

    // 3. Atomic rename — staging → `<db>.next`. From this point on, the
    // boot-time swap (`apply_pending_import`) will pick it up. Rename is
    // atomic within the same filesystem; both paths sit in `live_db`'s
    // directory by construction.
    std::fs::rename(&staging_path, &dst)?;
    log_info!(
        json!({ "next": dst }),
        "[AgentArchive] staged import — restart will apply"
    );

    // Best-effort: the process restarts shortly after staging, so this may not
    // flush — losing it never affects the import itself.
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    track_event("agent imported", None, Some(props));
    Ok(())
}

/// The integrity and migration checks of a staged file against the live one.
fn validate(staging: &str, live_db: &str) -> anyhow::Result<()> {
    let mut staged = open_readonly(staging)?;
    let mut live = open_readonly(live_db)?;

    let integrity: Vec<IntegrityCheck> =
        diesel::sql_query("PRAGMA integrity_check").load(&mut staged)?;
    let integrity = integrity.into_iter().next().map(|row| row.integrity_check);
    if integrity.as_deref() != Some("ok") {
        return Err(ArchiveValidationError::new(format!(
            "Uploaded database failed integrity check: {}",
            integrity.as_deref().unwrap_or("unknown")
        ))
        .into());
    }

    let staged_migrations = get_applied_migrations(&mut staged)?;
    let live_migrations = get_applied_migrations(&mut live)?;
    if !sets_equal(&staged_migrations, &live_migrations) {
        let only_in_staged: Vec<&str> = staged_migrations
            .iter()
            .filter(|m| !live_migrations.contains(*m))
            .map(String::as_str)
            .collect();
        let only_in_live: Vec<&str> = live_migrations
            .iter()
            .filter(|m| !staged_migrations.contains(*m))
            .map(String::as_str)
            .collect();
        let or_none = |list: Vec<&str>| {
            if list.is_empty() {
                "none".to_string()
            } else {
                list.join(", ")
            }
        };
        return Err(ArchiveValidationError::new(format!(
            "Schema version mismatch — the backup was taken against a different runtime version. Only in backup: [{}]. Only in current: [{}].",
            or_none(only_in_staged),
            or_none(only_in_live)
        ))
        .into());
    }
    Ok(())
}

/// Remove a file, logging any failure but ENOENT. Every caller is in a cleanup
/// path where failing would mask the real error.
fn safe_unlink(path: &str) {
    if let Err(err) = std::fs::remove_file(path) {
        // Missing-file ENOENT is common and uninteresting, so skip those.
        if err.kind() != std::io::ErrorKind::NotFound {
            log_warn!(
                json!({ "err": err_json(&anyhow::Error::from(err)), "path": path }),
                "[AgentArchive] safeUnlink failed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testing::test_db;
    use tokio::io::AsyncReadExt;

    async fn export_bytes(src: &str) -> Vec<u8> {
        let mut exported = export_from(src, "  My Agent!  ").await.unwrap();
        assert!(exported.filename.starts_with("my-agent-"));
        assert!(exported.filename.ends_with(".prism"));
        let mut bytes = Vec::new();
        exported.stream.read_to_end(&mut bytes).await.unwrap();
        (exported.cleanup)();
        bytes
    }

    #[test]
    fn slugs_a_name_for_the_filename() {
        assert_eq!(slugify("  My Agent!  "), "my-agent");
        assert_eq!(slugify("!!!"), "agent");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn an_export_imports_back_as_a_pending_restore() {
        let db = test_db();
        let live = db.path.to_string_lossy().into_owned();
        let bytes = export_bytes(&live).await;

        import_into(&live, &bytes).await.unwrap();

        let next = format!("{live}.next");
        assert!(Path::new(&next).exists());
        let mut conn = open_readonly(&next).unwrap();
        assert!(!get_applied_migrations(&mut conn).unwrap().is_empty());
        // No staging file is left beside the live database.
        let leftovers = std::fs::read_dir(db.path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".import-staging-")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_an_upload_that_is_not_gzip() {
        let db = test_db();
        let live = db.path.to_string_lossy().into_owned();
        let err = import_into(&live, b"not gzip at all").await.unwrap_err();
        assert_eq!(
            err.downcast_ref::<ArchiveValidationError>().unwrap().0,
            "Failed to decompress archive: incorrect header check"
        );
        assert!(!Path::new(&format!("{live}.next")).exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_a_gzip_that_holds_no_database() {
        let db = test_db();
        let live = db.path.to_string_lossy().into_owned();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&[7u8; 4096]).unwrap();
        let bytes = encoder.finish().unwrap();

        let err = import_into(&live, &bytes).await.unwrap_err();
        let message = &err.downcast_ref::<ArchiveValidationError>().unwrap().0;
        assert!(
            message.starts_with("Failed to validate archive: "),
            "{message}"
        );
        assert!(!Path::new(&format!("{live}.next")).exists());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_a_backup_from_another_schema_version() {
        let db = test_db();
        let live = db.path.to_string_lossy().into_owned();
        let bytes = export_bytes(&live).await;
        // The live database gains a migration the backup lacks.
        crate::db::run_sync(|conn| {
            diesel::sql_query(
                "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES ('x', 'c', 1, '99990101000000_newer', 1)",
            )
            .execute(conn)?;
            Ok(())
        })
        .unwrap();

        let err = import_into(&live, &bytes).await.unwrap_err();
        assert_eq!(
            err.downcast_ref::<ArchiveValidationError>().unwrap().0,
            "Schema version mismatch — the backup was taken against a different runtime version. Only in backup: [none]. Only in current: [99990101000000_newer]."
        );
    }
}
