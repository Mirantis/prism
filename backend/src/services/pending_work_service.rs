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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::db::models::{NewPendingWork, PendingWork, PendingWorkChangeset};
use crate::db::schema::pending_work::dsl as pw;
use crate::db::sql_types::{DbDateTime, DbJson};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::{log_error, log_info, log_warn};

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

/// The last write to each row, keyed `<kind>:<key>`, with the number that tells
/// one write from the next.
type RowWrites = Arc<Mutex<HashMap<String, (u64, RowWrite)>>>;

fn to_item(row: PendingWork) -> PendingWorkItem {
    PendingWorkItem {
        key: row.key,
        payload: row.payload,
        attempts: row.attempts,
        created_at: row.created_at,
    }
}

pub struct PendingWorkService {
    stopping: CancellationToken,
    /// The last write to each row, keyed `<kind>:<key>`, so the writes to one row
    /// land in the order they were made.
    writes: RowWrites,
    next_write: AtomicU64,
}

impl PendingWorkService {
    pub fn new() -> Self {
        PendingWorkService {
            stopping: CancellationToken::new(),
            writes: Arc::new(Mutex::new(HashMap::new())),
            next_write: AtomicU64::new(0),
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
    ///
    /// The write is queued when `begin` is called, so a later `update` of the same row
    /// lands after it even before the returned future is awaited.
    pub fn begin(
        &self,
        kind: PendingWorkKind,
        key: &str,
        payload: serde_json::Value,
    ) -> BoxFuture<'static, anyhow::Result<()>> {
        let row = NewPendingWork::new(kind.as_str(), key, payload.clone());
        self.write(kind, key, move || {
            crate::db::run(move |conn| {
                diesel::insert_into(pw::pending_work)
                    .values(&row)
                    .on_conflict((pw::kind, pw::key))
                    .do_update()
                    .set(&PendingWorkChangeset {
                        payload: Some(DbJson(payload)),
                        ..PendingWorkChangeset::default()
                    })
                    .execute(conn)?;
                Ok(())
            })
            .boxed()
        })
    }

    /// Run the owner's write and record the work in one transaction. When
    /// `owner_write` answers false, no row is written and this answers false too.
    pub fn begin_with(
        &self,
        kind: PendingWorkKind,
        key: &str,
        payload: serde_json::Value,
        owner_write: impl FnOnce(&mut SqliteConnection) -> anyhow::Result<bool> + Send + 'static,
    ) -> BoxFuture<'static, anyhow::Result<bool>> {
        let row = NewPendingWork::new(kind.as_str(), key, payload.clone());
        self.write(kind, key, move || {
            crate::db::run(move |conn| {
                conn.transaction(|conn| {
                    if !owner_write(conn)? {
                        return Ok(false);
                    }
                    diesel::insert_into(pw::pending_work)
                        .values(&row)
                        .on_conflict((pw::kind, pw::key))
                        .do_update()
                        .set(&PendingWorkChangeset {
                            payload: Some(DbJson(payload)),
                            ..PendingWorkChangeset::default()
                        })
                        .execute(conn)?;
                    Ok(true)
                })
            })
            .boxed()
        })
    }

    /// Replace what the owner needs to continue the work, e.g. once a session id
    /// is known.
    pub fn update(&self, kind: PendingWorkKind, key: &str, payload: serde_json::Value) {
        self.replace(kind, key, payload, false);
    }

    /// The work is done, and its row holds the result until its reader asks. A
    /// restart is no attempt at it, so the resume bound never drops the result.
    pub fn settle(&self, kind: PendingWorkKind, key: &str, payload: serde_json::Value) {
        self.replace(kind, key, payload, true);
    }

    /// The work ended. Its row goes, so no boot continues it.
    pub fn end(&self, kind: PendingWorkKind, keys: impl Into<WorkKeys>) {
        if self.stopping.is_cancelled() {
            return;
        }
        self.remove(kind, keys.into());
    }

    /// The work's result reached its user. Its row goes, also during a shutdown.
    pub fn finish(&self, kind: PendingWorkKind, keys: impl Into<WorkKeys>) {
        self.remove(kind, keys.into());
    }

    /// Stop the work in flight and keep its rows for the next boot.
    pub fn shutdown(&self) {
        self.stopping.cancel();
    }

    /// Wait for the writes in flight, so a process that exits next keeps them.
    pub async fn flush(&self) {
        let writes: Vec<RowWrite> = self
            .writes
            .lock()
            .values()
            .map(|(_, write)| write.clone())
            .collect();
        futures::future::join_all(writes).await;
    }

    /// The work a restart interrupted. Read at boot before the channels connect, so
    /// a message that arrives during the boot is new work with its own turn. Each
    /// read is an attempt; the work past `MAX_RESUME_ATTEMPTS` goes to its owner as
    /// given up.
    pub async fn interrupted(&self) -> anyhow::Result<InterruptedWork> {
        crate::db::run(|conn| {
            diesel::update(pw::pending_work)
                .set((
                    pw::attempts.eq(pw::attempts + 1_i64),
                    pw::updated_at.eq(DbDateTime::now()),
                ))
                .execute(conn)?;
            Ok(())
        })
        .await?;
        let rows = crate::db::run(|conn| {
            Ok(pw::pending_work
                .order(pw::created_at.asc())
                .select(PendingWork::as_select())
                .load(conn)?)
        })
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| InterruptedWorkItem {
                kind: row.kind.clone(),
                item: to_item(row),
            })
            .collect())
    }

    /// The rows of one kind as they stand.
    pub async fn rows(&self, kind: PendingWorkKind) -> anyhow::Result<Vec<PendingWorkItem>> {
        let rows = crate::db::run(move |conn| {
            Ok(pw::pending_work
                .filter(pw::kind.eq(kind.as_str()))
                .order(pw::created_at.asc())
                .select(PendingWork::as_select())
                .load(conn)?)
        })
        .await?;
        Ok(rows.into_iter().map(to_item).collect())
    }

    /// Give each owner the work a restart interrupted. Runs once, at boot, after
    /// the channels connect, so a resumed reply can be delivered.
    pub async fn resume_all(
        &self,
        interrupted: InterruptedWork,
        resumers: HashMap<PendingWorkKind, PendingWorkResumer>,
    ) {
        for kind in PENDING_WORK_KINDS {
            let of_kind: Vec<&InterruptedWorkItem> = interrupted
                .iter()
                .filter(|row| row.kind == kind.as_str())
                .collect();
            let live: Vec<PendingWorkItem> = of_kind
                .iter()
                .filter(|row| row.item.attempts <= MAX_RESUME_ATTEMPTS)
                .map(|row| row.item.clone())
                .collect();
            let given_up: Vec<PendingWorkItem> = of_kind
                .iter()
                .filter(|row| row.item.attempts > MAX_RESUME_ATTEMPTS)
                .map(|row| row.item.clone())
                .collect();
            if !live.is_empty() {
                log_info!(
                    "[PendingWork] Continuing {} piece(s) of {} work a restart interrupted",
                    live.len(),
                    kind
                );
            }
            let live_count = live.len();
            let given_up_keys: Vec<String> = given_up.iter().map(|row| row.key.clone()).collect();
            let resumed = match resumers.get(&kind) {
                Some(resumer) => resumer(live, given_up).await,
                None => Err(anyhow::anyhow!("resumers[kind] is not a function")),
            };
            match resumed {
                Ok(()) => {
                    // The owner has closed the work it was given up, so its rows can go. A boot
                    // that stops before this gives the work up again.
                    if !given_up_keys.is_empty() {
                        log_warn!(
                            "[PendingWork] Gave up {} piece(s) of {} work that {} boots in a row could not finish",
                            given_up_keys.len(),
                            kind,
                            MAX_RESUME_ATTEMPTS
                        );
                        self.remove(kind, WorkKeys(given_up_keys));
                    }
                }
                Err(err) => {
                    log_error!(
                        json!({ "err": err_json(&err), "kind": kind.as_str() }),
                        "[PendingWork] Could not continue the interrupted work"
                    );
                }
            }
            if !of_kind.is_empty() {
                let mut props = IndexMap::new();
                if let Some(agent_id) = CONFIG.agent_id() {
                    props.insert("agent.id".to_string(), agent_id);
                }
                props.insert("work.kind".to_string(), kind.as_str().to_string());
                props.insert("work.count".to_string(), live_count.to_string());
                props.insert(
                    "work.dropped".to_string(),
                    (of_kind.len() - live_count).to_string(),
                );
                track_event("work resumed", Some(&CONFIG.owner_user_id()), Some(props));
            }
        }
    }

    fn replace(
        &self,
        kind: PendingWorkKind,
        key: &str,
        payload: serde_json::Value,
        reset_attempts: bool,
    ) {
        if self.stopping.is_cancelled() {
            return;
        }
        let row_key = key.to_string();
        let done = self.write(kind, key, move || {
            crate::db::run(move |conn| {
                diesel::update(
                    pw::pending_work
                        .filter(pw::kind.eq(kind.as_str()))
                        .filter(pw::key.eq(&row_key)),
                )
                .set(&PendingWorkChangeset {
                    payload: Some(DbJson(payload)),
                    attempts: reset_attempts.then_some(0),
                    ..PendingWorkChangeset::default()
                })
                .execute(conn)?;
                Ok(())
            })
            .boxed()
        });
        let key = key.to_string();
        tokio::spawn(async move {
            if let Err(err) = done.await {
                log_error!(
                    json!({ "err": err_json(&err), "kind": kind.as_str(), "key": key }),
                    "[PendingWork] Could not update the work"
                );
            }
        });
    }

    fn remove(&self, kind: PendingWorkKind, keys: WorkKeys) {
        let mut seen: Vec<String> = Vec::new();
        for key in keys.0 {
            if seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            let row_key = key.clone();
            let done = self.write(kind, &key, move || {
                crate::db::run(move |conn| {
                    diesel::delete(
                        pw::pending_work
                            .filter(pw::kind.eq(kind.as_str()))
                            .filter(pw::key.eq(&row_key)),
                    )
                    .execute(conn)?;
                    Ok(())
                })
                .boxed()
            });
            tokio::spawn(async move {
                if let Err(err) = done.await {
                    log_error!(
                        json!({ "err": err_json(&err), "kind": kind.as_str(), "key": key }),
                        "[PendingWork] Could not end the work"
                    );
                }
            });
        }
    }

    /// Run `run` after the earlier writes to the row, and before the later ones. The
    /// write starts at once; the returned future answers how it went.
    fn write<T: Send + 'static>(
        &self,
        kind: PendingWorkKind,
        key: &str,
        run: impl FnOnce() -> BoxFuture<'static, anyhow::Result<T>> + Send + 'static,
    ) -> BoxFuture<'static, anyhow::Result<T>> {
        let id = format!("{}:{}", kind.as_str(), key);
        let number = self.next_write.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let writes = Arc::clone(&self.writes);
        let mut table = self.writes.lock();
        let previous = table.get(&id).map(|(_, write)| write.clone());
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            if let Some(previous) = previous {
                previous.await;
            }
            let _ = sender.send(run().await);
            let mut table = writes.lock();
            if table.get(&task_id).is_some_and(|(n, _)| *n == number) {
                table.remove(&task_id);
            }
        });
        let settled: RowWrite = async move {
            let _ = task.await;
        }
        .boxed()
        .shared();
        table.insert(id, (number, settled));
        drop(table);
        async move {
            receiver
                .await
                .unwrap_or_else(|_| Err(anyhow::anyhow!("the write was cancelled")))
        }
        .boxed()
    }
}

impl Default for PendingWorkService {
    fn default() -> Self {
        Self::new()
    }
}

pub static PENDING_WORK_SERVICE: LazyLock<PendingWorkService> =
    LazyLock::new(PendingWorkService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    async fn stored() -> Vec<(String, String, Value, i64)> {
        crate::db::run(|conn| {
            Ok(pw::pending_work
                .order((pw::kind.asc(), pw::key.asc()))
                .select(PendingWork::as_select())
                .load(conn)?)
        })
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.kind, row.key, row.payload, row.attempts))
        .collect()
    }

    async fn insert(kind: &str, key: &str, attempts: i64) {
        let mut row = NewPendingWork::new(kind, key, json!({ "key": key }));
        row.attempts = attempts;
        crate::db::run(move |conn| {
            diesel::insert_into(pw::pending_work)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    type Calls = Arc<Mutex<Vec<(PendingWorkKind, Vec<String>, Vec<String>)>>>;

    /// An owner per kind that records what it was given, failing for `failing`.
    fn resumers(
        calls: &Calls,
        failing: Option<PendingWorkKind>,
    ) -> HashMap<PendingWorkKind, PendingWorkResumer> {
        PENDING_WORK_KINDS
            .into_iter()
            .map(|kind| {
                let calls = calls.clone();
                let resumer: PendingWorkResumer = Arc::new(move |live, given_up| {
                    let keys = |items: Vec<PendingWorkItem>| {
                        items.into_iter().map(|item| item.key).collect::<Vec<_>>()
                    };
                    calls.lock().push((kind, keys(live), keys(given_up)));
                    let failed = failing == Some(kind);
                    async move {
                        if failed {
                            Err(anyhow::anyhow!("database locked"))
                        } else {
                            Ok(())
                        }
                    }
                    .boxed()
                });
                (kind, resumer)
            })
            .collect()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_the_row_when_the_work_begins_and_deletes_it_once_when_it_ends() {
        let _db = crate::db::testing::test_db();
        let service = PendingWorkService::new();
        service
            .begin(
                PendingWorkKind::Chat,
                "msg-1",
                json!({ "threadId": "thread-1" }),
            )
            .await
            .unwrap();
        service
            .begin(PendingWorkKind::Chat, "msg-2", json!({}))
            .await
            .unwrap();
        assert_eq!(stored().await.len(), 2);
        assert_eq!(stored().await[0].2, json!({ "threadId": "thread-1" }));

        service.end(PendingWorkKind::Chat, vec!["msg-1", "msg-2", "msg-1"]);
        service.flush().await;
        assert!(stored().await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn records_the_work_with_the_write_that_decides_it() {
        let _db = crate::db::testing::test_db();
        let service = PendingWorkService::new();
        let recorded = service
            .begin_with(PendingWorkKind::Chat, "k", json!({ "a": 1 }), |_| Ok(true))
            .await
            .unwrap();
        assert!(recorded);
        assert_eq!(
            stored().await,
            vec![("chat".to_string(), "k".to_string(), json!({ "a": 1 }), 0)]
        );

        let refused = service
            .begin_with(PendingWorkKind::Chat, "n", json!({ "a": 2 }), |_| Ok(false))
            .await
            .unwrap();
        assert!(!refused);
        assert_eq!(stored().await.len(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn applies_the_writes_to_one_row_in_the_order_they_were_made() {
        let _db = crate::db::testing::test_db();
        let service = PendingWorkService::new();
        let begun = service.begin(
            PendingWorkKind::CodingTask,
            "task-1",
            json!({ "params": {} }),
        );
        service.update(
            PendingWorkKind::CodingTask,
            "task-1",
            json!({ "params": {}, "sessionId": "session-1" }),
        );
        begun.await.unwrap();
        service.flush().await;
        assert_eq!(
            stored().await[0].2,
            json!({ "params": {}, "sessionId": "session-1" })
        );
        service.end(PendingWorkKind::CodingTask, "task-1");
        service.flush().await;
        assert!(stored().await.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_a_finished_result_with_no_resume_attempt_counted_against_it() {
        let _db = crate::db::testing::test_db();
        insert("coding-task", "task-1", 2).await;
        let service = PendingWorkService::new();
        service.settle(
            PendingWorkKind::CodingTask,
            "task-1",
            json!({ "finished": { "stopReason": "end_turn" } }),
        );
        service.flush().await;
        let rows = stored().await;
        assert_eq!(
            rows[0].2,
            json!({ "finished": { "stopReason": "end_turn" } })
        );
        assert_eq!(rows[0].3, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn a_shutdown_stops_the_work_and_keeps_every_row() {
        let _db = crate::db::testing::test_db();
        insert("coding-task", "task-1", 0).await;
        insert("chat", "msg-1", 0).await;
        let service = PendingWorkService::new();
        service.shutdown();
        service.update(
            PendingWorkKind::CodingTask,
            "task-1",
            json!({ "finished": { "stopReason": "error" } }),
        );
        service.end(PendingWorkKind::Chat, "msg-1");
        service.flush().await;
        assert!(service.shutdown_signal().is_cancelled());
        assert_eq!(stored().await.len(), 2);
        assert_eq!(stored().await[1].2, json!({ "key": "task-1" }));

        // Work whose result reached its user still goes.
        service.finish(PendingWorkKind::Chat, "msg-1");
        service.flush().await;
        assert_eq!(stored().await.len(), 1);

        // Work accepted while the process stops is still recorded.
        service
            .begin(PendingWorkKind::Chat, "msg-late", json!({}))
            .await
            .unwrap();
        assert_eq!(stored().await.len(), 2);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn counts_the_boot_and_gives_each_owner_its_rows_back() {
        let _db = crate::db::testing::test_db();
        insert("chat", "msg-1", 0).await;
        insert("webhook", "run-1", 0).await;
        let service = PendingWorkService::new();

        let interrupted = service.interrupted().await.unwrap();
        assert!(interrupted.iter().all(|row| row.item.attempts == 1));
        // A message that arrives while the channels connect is new work with its own turn.
        service
            .begin(PendingWorkKind::Chat, "msg-new", json!({}))
            .await
            .unwrap();

        let calls: Calls = Arc::default();
        service
            .resume_all(interrupted, resumers(&calls, None))
            .await;
        let calls = calls.lock().clone();
        assert_eq!(
            calls,
            vec![
                (PendingWorkKind::CodingTask, vec![], vec![]),
                (PendingWorkKind::Chat, vec!["msg-1".to_string()], vec![]),
                (PendingWorkKind::Webhook, vec!["run-1".to_string()], vec![]),
                (PendingWorkKind::Cron, vec![], vec![]),
                (PendingWorkKind::Heartbeat, vec![], vec![]),
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn drops_work_that_max_resume_attempts_boots_in_a_row_could_not_finish() {
        let _db = crate::db::testing::test_db();
        insert("chat", "msg-crashes", MAX_RESUME_ATTEMPTS).await;
        insert("chat", "msg-ok", 0).await;
        let service = PendingWorkService::new();

        let interrupted = service.interrupted().await.unwrap();
        assert_eq!(stored().await.len(), 2);
        let calls: Calls = Arc::default();
        service
            .resume_all(interrupted, resumers(&calls, None))
            .await;
        service.flush().await;

        assert!(calls.lock().contains(&(
            PendingWorkKind::Chat,
            vec!["msg-ok".to_string()],
            vec!["msg-crashes".to_string()]
        )));
        let keys: Vec<String> = stored().await.into_iter().map(|row| row.1).collect();
        assert_eq!(keys, vec!["msg-ok".to_string()]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_the_work_given_up_when_its_owner_could_not_close_it() {
        let _db = crate::db::testing::test_db();
        insert("cron", "task-loop", MAX_RESUME_ATTEMPTS).await;
        insert("webhook", "run-1", 0).await;
        let service = PendingWorkService::new();

        let calls: Calls = Arc::default();
        service
            .resume_all(
                service.interrupted().await.unwrap(),
                resumers(&calls, Some(PendingWorkKind::Cron)),
            )
            .await;
        service.flush().await;

        assert_eq!(stored().await.len(), 2);
        // The other owners still got their rows.
        assert!(calls.lock().iter().any(|(kind, live, _)| {
            *kind == PendingWorkKind::Webhook && live == &vec!["run-1".to_string()]
        }));
    }
}
