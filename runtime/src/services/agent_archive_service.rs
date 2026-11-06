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

use std::collections::HashSet;
use std::pin::Pin;
use std::sync::LazyLock;

use chrono::{DateTime, Local, Utc};
use regex::Regex;

/// A user-facing rejection of an uploaded archive; the caller answers it with a 400.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ArchiveValidationError(pub String);

impl ArchiveValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// An export: the gzipped snapshot as a byte stream, the suggested filename, and
/// the cleanup that removes the temp snapshot once the stream is done.
pub struct ExportedAgent {
    pub stream: Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    pub filename: String,
    pub cleanup: Box<dyn FnOnce() + Send>,
}

fn resolve_db_path() -> String {
    todo!()
}

fn next_db_path() -> String {
    format!("{}.next", resolve_db_path())
}

static NON_SLUG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9]+").expect("valid slug pattern"));
static EDGE_DASHES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-+|-+$").expect("valid dash pattern"));

fn slugify(s: &str) -> String {
    let lowered = s.to_lowercase();
    let dashed = NON_SLUG.replace_all(lowered.trim(), "-");
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

fn sets_equal(a: &HashSet<String>, b: &HashSet<String>) -> bool {
    a.len() == b.len() && a.iter().all(|v| b.contains(v))
}

/// Export the current agent DB to a gzipped byte stream + suggested
/// filename. Caller is responsible for streaming it to the HTTP
/// response and calling `cleanup` to unlink the temp snapshot when done.
pub async fn export_agent(agent_name: &str) -> anyhow::Result<ExportedAgent> {
    todo!()
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
    todo!()
}

/// Remove a file, logging any failure but ENOENT. Every caller is in a cleanup
/// path where failing would mask the real error.
fn safe_unlink(path: &str) {
    todo!()
}
