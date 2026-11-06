//! Work the agent has accepted and not finished, kept in `pending_work` so the
//! process can stop at any moment and lose none of it.
//!
//! An owner `begin`s a row before the work starts and `end`s it when the work
//! ends, however it ends. At boot `interrupted` reads the rows left over and
//! `resume_all` gives each to the owner of its kind, which continues the work.
//! A scheduled run keeps a row too, so the attempt bound covers the run a boot
//! starts again because it is still due.
//!
//! A shutdown freezes the journal. From `shutdown()` on, `update`, `settle` and
//! `end` change nothing, and `shutdown_signal` tells the work to stop, so the next
//! boot continues the work a shutdown interrupts from the point it had reached.
//! `finish` is the exception: work whose result reached its user records that,
//! so the next boot does not deliver it again.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// Each kind of work that survives a restart, by the service that owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PendingWorkKind {
    #[serde(rename = "coding-task")]
    CodingTask,
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "webhook")]
    Webhook,
    #[serde(rename = "cron")]
    Cron,
    #[serde(rename = "heartbeat")]
    Heartbeat,
}

impl PendingWorkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PendingWorkKind::CodingTask => "coding-task",
            PendingWorkKind::Chat => "chat",
            PendingWorkKind::Webhook => "webhook",
            PendingWorkKind::Cron => "cron",
            PendingWorkKind::Heartbeat => "heartbeat",
        }
    }
}

impl std::fmt::Display for PendingWorkKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Each kind of work that survives a restart, in the order the boot gives it
/// back: a resumed reply or run can poll a coding task, so the tasks come back
/// first.
pub const PENDING_WORK_KINDS: [PendingWorkKind; 5] = [
    PendingWorkKind::CodingTask,
    PendingWorkKind::Chat,
    PendingWorkKind::Webhook,
    PendingWorkKind::Cron,
    PendingWorkKind::Heartbeat,
];

/// Boots that may give one piece of work back. Work that stops its own process
/// every time it runs would otherwise stop every boot after it.
pub const MAX_RESUME_ATTEMPTS: i64 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorkItem {
    pub key: String,
    /// What the owner wrote. Only that owner writes its kind, so it reads its own
    /// shape back.
    pub payload: serde_json::Value,
    /// Boots that have given this work back, this one included.
    pub attempts: i64,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
}

/// One row of the work a restart interrupted, with the kind it was stored under.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedWorkItem {
    pub kind: String,
    #[serde(flatten)]
    pub item: PendingWorkItem,
}

/// The work a restart interrupted, as the boot read it before any new work arrived.
pub type InterruptedWork = Vec<InterruptedWorkItem>;

/// Continues the work a restart interrupted. Called once per boot, also with no
/// items. The second list is the work that `MAX_RESUME_ATTEMPTS` boots in a row
/// could not finish. Its rows are gone, and an owner whose schedule would start it
/// again closes it.
pub type PendingWorkResumer = Arc<
    dyn Fn(Vec<PendingWorkItem>, Vec<PendingWorkItem>) -> BoxFuture<'static, anyhow::Result<()>>
        + Send
        + Sync,
>;

/// The keys `end` and `finish` take: one key or several.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkKeys(pub Vec<String>);

impl From<&str> for WorkKeys {
    fn from(key: &str) -> Self {
        WorkKeys(vec![key.to_string()])
    }
}

impl From<String> for WorkKeys {
    fn from(key: String) -> Self {
        WorkKeys(vec![key])
    }
}

impl From<&String> for WorkKeys {
    fn from(key: &String) -> Self {
        WorkKeys(vec![key.clone()])
    }
}

impl From<Vec<String>> for WorkKeys {
    fn from(keys: Vec<String>) -> Self {
        WorkKeys(keys)
    }
}

impl From<&[String]> for WorkKeys {
    fn from(keys: &[String]) -> Self {
        WorkKeys(keys.to_vec())
    }
}

impl From<Vec<&str>> for WorkKeys {
    fn from(keys: Vec<&str>) -> Self {
        WorkKeys(keys.into_iter().map(str::to_string).collect())
    }
}

/// A write in flight to one row, which later writes to that row wait for.
type RowWrite = Shared<BoxFuture<'static, ()>>;

pub struct PendingWorkService {
    stopping: CancellationToken,
    /// The last write to each row, keyed `<kind>:<key>`, so the writes to one row
    /// land in the order they were made.
    writes: Mutex<HashMap<String, RowWrite>>,
}

impl PendingWorkService {
    pub fn new() -> Self {
        PendingWorkService {
            stopping: CancellationToken::new(),
            writes: Mutex::new(HashMap::new()),
        }
    }

    /// Cancelled when shutdown starts. Work passes it to what it runs, so it stops
    /// rather than finishing in a process being taken apart.
    pub fn shutdown_signal(&self) -> CancellationToken {
        self.stopping.clone()
    }

    /// Record work before it starts, with what its owner needs to accept the work
    /// again when a restart comes before the owner's own record of it. `payload` is
    /// stored as JSON. Fails when the row cannot be written, so the caller can
    /// refuse work it cannot keep.
    pub async fn begin(
        &self,
        kind: PendingWorkKind,
        key: &str,
        payload: serde_json::Value,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Replace what the owner needs to continue the work, e.g. once a session id
    /// is known.
    pub fn update(&self, kind: PendingWorkKind, key: &str, payload: serde_json::Value) {
        todo!()
    }

    /// The work is done, and its row holds the result until its reader asks. A
    /// restart is no attempt at it, so the resume bound never drops the result.
    pub fn settle(&self, kind: PendingWorkKind, key: &str, payload: serde_json::Value) {
        todo!()
    }

    /// The work ended. Its row goes, so no boot continues it.
    pub fn end(&self, kind: PendingWorkKind, keys: impl Into<WorkKeys>) {
        todo!()
    }

    /// The work's result reached its user. Its row goes, also during a shutdown.
    pub fn finish(&self, kind: PendingWorkKind, keys: impl Into<WorkKeys>) {
        todo!()
    }

    /// Stop the work in flight and keep its rows for the next boot.
    pub fn shutdown(&self) {
        self.stopping.cancel();
    }

    /// Wait for the writes in flight, so a process that exits next keeps them.
    pub async fn flush(&self) {
        todo!()
    }

    /// The work a restart interrupted. Read at boot before the channels connect, so
    /// a message that arrives during the boot is new work with its own turn. Each
    /// read is an attempt; the work past `MAX_RESUME_ATTEMPTS` goes to its owner as
    /// given up.
    pub async fn interrupted(&self) -> anyhow::Result<InterruptedWork> {
        todo!()
    }

    /// The rows of one kind as they stand.
    pub async fn rows(&self, kind: PendingWorkKind) -> anyhow::Result<Vec<PendingWorkItem>> {
        todo!()
    }

    /// Give each owner the work a restart interrupted. Runs once, at boot, after
    /// the channels connect, so a resumed reply can be delivered.
    pub async fn resume_all(
        &self,
        interrupted: InterruptedWork,
        resumers: HashMap<PendingWorkKind, PendingWorkResumer>,
    ) {
        todo!()
    }

    fn replace(
        &self,
        kind: PendingWorkKind,
        key: &str,
        payload: serde_json::Value,
        reset_attempts: bool,
    ) {
        todo!()
    }

    fn remove(&self, kind: PendingWorkKind, keys: WorkKeys) {
        todo!()
    }
}

impl Default for PendingWorkService {
    fn default() -> Self {
        Self::new()
    }
}

pub static PENDING_WORK_SERVICE: LazyLock<PendingWorkService> =
    LazyLock::new(PendingWorkService::new);
