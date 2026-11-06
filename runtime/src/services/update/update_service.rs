//! Self-update for standalone (SEA) installs.
//!
//! Checks the GHCR tag list for a newer release (hourly, first check one
//! minute after boot), announces it, and applies it: stage + verify the
//! release archive, record a PENDING attempt, swap the install and restart.
//! The next boot resolves the pending attempt by comparing its own version to
//! the target — the record survives the process the update kills.
//!
//! The updater runs only where all three hold: the process is a SEA binary
//! (a container or dev run updates by other means — pulling the image, git),
//! its baked version is release-shaped (a dev build has nothing to compare),
//! and DISABLE_UPDATER is not set. Check failures are logged at debug and
//! never surface in any UI.
//!
//! Nothing here knows about WebSockets — progress is announced on the
//! `events` channel (an [`UpdateEvent`]); the gateway subscribes and broadcasts.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::config::CONFIG;
use crate::constants::{
    RELEASE_VERSION_RE, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_DELAY_MS,
    WINDOWS_HANDOFF_TIMEOUT_MS,
};
use crate::db::models::{UpdateAttempt, UpdateOutcome, UpdateTrigger};
use crate::lib::telemetry::track_event;
use crate::services::agent_activity::is_agent_idle;
use crate::services::update::apply::{
    UpdateError, remove_staged_release, spawn_windows_installer, stage_release, swap_install,
    sweep_update_dirs,
};
use crate::services::update::ghcr::{compare_release_versions, fetch_latest_release_version};
use crate::{log_error, log_info, log_warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateDisabledReason {
    DisabledByEnv,
    NotSeaInstall,
    DevBuild,
}

impl UpdateDisabledReason {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateDisabledReason::DisabledByEnv => "disabled_by_env",
            UpdateDisabledReason::NotSeaInstall => "not_sea_install",
            UpdateDisabledReason::DevBuild => "dev_build",
        }
    }
}

impl std::fmt::Display for UpdateDisabledReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A second apply was requested while one is running — the route maps it to 409.
#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("An update is already in progress.")]
pub struct UpdateInProgressError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateEventStatus {
    Available,
    Updating,
    Failed,
}

impl UpdateEventStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateEventStatus::Available => "available",
            UpdateEventStatus::Updating => "updating",
            UpdateEventStatus::Failed => "failed",
        }
    }
}

/// Sent on `events`; broadcast to clients verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    pub status: UpdateEventStatus,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

/// The newest attempt, as `get_status` reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAttemptReport {
    pub version_from: String,
    pub version_to: String,
    pub trigger: UpdateTrigger,
    pub outcome: UpdateOutcome,
    pub error_code: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusReport {
    pub enabled: bool,
    pub reason: Option<UpdateDisabledReason>,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked_at: Option<String>,
    pub applying: bool,
    pub last_attempt: Option<UpdateAttemptReport>,
}

/// Whether the updater may run here, and why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGate {
    pub enabled: bool,
    pub reason: Option<UpdateDisabledReason>,
}

/// How an apply ended once it passed the point of no return, or deferred.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub version: String,
    pub will_exit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred: Option<bool>,
}

/// An apply whose attempt row is recorded, with the rest of it already running.
pub struct StartedApply {
    pub version: String,
    /// The running `continue_apply`.
    pub completion: JoinHandle<anyhow::Result<ApplyOutcome>>,
}

pub struct UpdateService {
    /// `'update'` events; the gateway subscribes.
    pub events: broadcast::Sender<UpdateEvent>,

    latest_version: Mutex<Option<String>>,
    checked_at: Mutex<Option<DateTime<Utc>>>,
    applying: AtomicBool,
    /// Versions already announced, so the telemetry event fires once per version.
    announced: Mutex<HashSet<String>>,
    first_check_timer: Mutex<Option<JoinHandle<()>>>,
    check_interval: Mutex<Option<JoinHandle<()>>>,
}

impl UpdateService {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            events,
            latest_version: Mutex::new(None),
            checked_at: Mutex::new(None),
            applying: AtomicBool::new(false),
            announced: Mutex::new(HashSet::new()),
            first_check_timer: Mutex::new(None),
            check_interval: Mutex::new(None),
        }
    }

    /// `disabled_by_env` when `DISABLE_UPDATER` is set, `not_sea_install` when the
    /// process is not a standalone binary, `dev_build` when the baked version is not
    /// release-shaped; enabled otherwise.
    pub fn gate(&self) -> UpdateGate {
        todo!()
    }

    /// Boot entry: resolve attempts left pending by a previous process (the
    /// restart sentinel), then start the check loop when the gate allows it.
    ///
    /// Resolving and sweeping belong to the installed binary, not to whatever
    /// process happens to open the database. A source run shares
    /// `~/.prism/agent.db` with an install, and resolving there would mark that
    /// install's in-flight attempt `restart_version_mismatch` while it is still
    /// mid-restart — sweeping there would delete its staged release. Deliberately
    /// gated on the process being a standalone binary alone rather than the full
    /// gate: the process that comes back after an update is the one that must
    /// resolve the sentinel, even if the user set DISABLE_UPDATER in between.
    ///
    /// Logs `[Update] updater off (<reason>)` when the gate is closed, otherwise
    /// arms the first check after `UPDATE_FIRST_CHECK_DELAY_MS` and one every
    /// `UPDATE_CHECK_INTERVAL_MS`, and logs `[Update] updater on — running
    /// <version>, checking hourly`.
    pub async fn start(&'static self) -> anyhow::Result<()> {
        todo!()
    }

    pub fn stop(&self) {
        if let Some(timer) = self.first_check_timer.lock().take() {
            timer.abort();
        }
        if let Some(interval) = self.check_interval.lock().take() {
            interval.abort();
        }
    }

    pub async fn get_status(&self) -> anyhow::Result<UpdateStatusReport> {
        todo!()
    }

    /// One check against the registry. Updates the cached latest version;
    /// returns it, or `None` when the check could not complete (already logged
    /// at debug by the fetcher).
    pub async fn check_now(&self) -> Option<String> {
        todo!()
    }

    /// The first half of an apply: claim the single-flight flag and persist the
    /// attempt row, so the caller can acknowledge the update before the download
    /// starts knowing its outcome is recorded either way. Returns the running
    /// `completion` — `continue_apply`, already started. Fails with
    /// [`UpdateInProgressError`] when an apply is already running, or with the
    /// row-insert failure with the flag released. Logs `[Update] applying <from>
    /// -> <to> (<trigger>)`.
    pub async fn start_apply(
        &'static self,
        version: &str,
        trigger: UpdateTrigger,
    ) -> anyhow::Result<StartedApply> {
        todo!()
    }

    /// Stage, verify and activate `version`. Resolves after the point of no
    /// return: on macOS/Linux the swap is done and the caller must end the
    /// process (`will_exit: true`); on Windows the staged installer now owns the
    /// restart and will kill this process (`will_exit: false`). An automatic
    /// apply re-checks the idle gate after the download — staging can take
    /// minutes, and work that started meanwhile must not be restarted under —
    /// and defers (`deferred: true`, staged files kept for cheap reuse) when the
    /// agent turned busy. Fails before anything was activated — the install is
    /// untouched and `applying` is released.
    pub async fn apply_update(
        &'static self,
        version: &str,
        trigger: UpdateTrigger,
    ) -> anyhow::Result<ApplyOutcome> {
        todo!()
    }

    /// The rest of an apply after its row is recorded.
    ///
    /// Named trade: the idle re-check narrows the window, it does not close it. A
    /// message landing between the check and the exit — the swap, the 500 ms flush
    /// delay, then a graceful shutdown, so roughly one to six seconds — still
    /// starts a turn the restart interrupts. The next boot continues that turn, so
    /// the window costs the work done before the restart, and the reply still
    /// arrives. Closing it needs the thread service to refuse new claims for the
    /// rest of the process's life, which is a lock with its own failure mode (an
    /// update that then fails leaves the agent mute).
    ///
    /// A deferral deletes the row (an attempt that never activated), releases
    /// `applying` and logs `[Update] <version> staged but the agent turned busy —
    /// deferring activation`. Before activating it sends `updating`. On failure it
    /// records the attempt `FAILURE` with the `UpdateError` code (else
    /// `apply_failed`) in its own guard — logging `[Update] could not record the
    /// failed attempt` when that write fails — removes the stage, sends `failed`
    /// for a manual apply or after `updating` went out (every `updating` must end
    /// in a restart or a `failed`, or the UIs stick on "updating…"), releases
    /// `applying` and returns the error. On success `applying` stays set: this
    /// process is over.
    async fn continue_apply(
        &'static self,
        attempt: UpdateAttempt,
        version: String,
        trigger: UpdateTrigger,
    ) -> anyhow::Result<ApplyOutcome> {
        todo!()
    }

    /// End this process so the supervisor (launchd KeepAlive / systemd
    /// Restart=always) respawns the swapped-in binary. The delay (500 ms by
    /// default) lets the WS broadcast and any HTTP response flush first.
    ///
    /// Raises SIGTERM rather than exiting outright, so the restart runs the same
    /// graceful shutdown a `docker stop` gets: plugin MCP child processes closed
    /// instead of orphaned, a live meeting left rather than frozen in the room,
    /// channels disconnected, and telemetry flushed. Logs `[Update] restarting to
    /// finish the update`.
    pub fn schedule_restart_exit(&self, delay_ms: Option<u64>) {
        todo!()
    }

    fn has_newer_version(&self) -> bool {
        todo!()
    }

    /// The hourly tick: check, announce, and auto-apply when nothing is
    /// mid-flight. A busy agent (LLM turn, running cron task, live goal loop, live
    /// meeting) defers to the next tick rather than being restarted under a turn.
    ///
    /// Announced on every tick, not once: a client that connects after the first
    /// announce (the TUI has no status fetch) still learns about it on the next
    /// tick, and both consumers render the frame idempotently. Only the log line
    /// `[Update] <latest> is available (running <version>)` and the `update
    /// available` telemetry event (`version_from`, `version_to`) are once per
    /// version. A busy agent logs `[Update] <latest> not applied — agent busy,
    /// retrying next tick`; a failed apply warns `[Update] automatic update to
    /// <latest> failed: <message>`.
    async fn check_tick(&'static self) {
        todo!()
    }

    /// Windows only: the staged installer is supposed to kill this process, so
    /// reaching the deadline (`WINDOWS_HANDOFF_TIMEOUT_MS`) means it did not.
    /// Nothing else would notice — the Unix path has a supervisor, this one has the
    /// installer and nothing more — and the attempt would stay PENDING with
    /// `applying` stuck true, so no later tick ever retries.
    ///
    /// At the deadline it warns `[Update] the installer for <version> did not
    /// restart this process within <minutes> minutes — marking the attempt failed`,
    /// records `FAILURE` with `handoff_timeout` (logging `[Update] could not record
    /// the handoff timeout` on failure), sends `failed` with `handoff_timeout` and
    /// releases `applying`. The timer never holds the process open.
    fn arm_windows_handoff_watchdog(&'static self, attempt: UpdateAttempt, version: String) {
        todo!()
    }

    /// The boot half of the restart sentinel: every attempt still PENDING was
    /// interrupted by its own handoff. It succeeded when this process runs the
    /// version it targeted or a newer release (the user can run the installer by
    /// hand while the update is pending). Logs `[Update] updated <from> ->
    /// <version>` or warns `[Update] update to <to> did not take — running
    /// <version or <unversioned>>`; a failure is `restart_version_mismatch`.
    async fn resolve_pending_attempts(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Record an attempt's end (`finishedAt` now) and send `update applied` with
    /// `version_from`, `version_to`, `outcome`, `trigger` and, when set,
    /// `error_code`.
    async fn finish_attempt(
        &self,
        attempt: &UpdateAttempt,
        outcome: UpdateOutcome,
        error_code: Option<&str>,
        error_detail: Option<&str>,
    ) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for UpdateService {
    fn default() -> Self {
        Self::new()
    }
}

fn to_attempt_report(row: &UpdateAttempt) -> UpdateAttemptReport {
    UpdateAttemptReport {
        version_from: row.version_from.clone(),
        version_to: row.version_to.clone(),
        trigger: row.trigger.clone(),
        outcome: row.outcome.clone(),
        error_code: row.error_code.clone(),
        started_at: crate::support::iso(&row.started_at),
        finished_at: row.finished_at.as_ref().map(crate::support::iso),
    }
}

pub static UPDATE_SERVICE: LazyLock<UpdateService> = LazyLock::new(UpdateService::new);
