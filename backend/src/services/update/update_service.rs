//! Self-update for standalone installs.
//!
//! Checks the GHCR tag list for a newer release (hourly, first check one
//! minute after boot), announces it, and applies it: stage + verify the
//! release archive, record a PENDING attempt, swap the install and restart.
//! The next boot resolves the pending attempt by comparing its own version to
//! the target — the record survives the process the update kills.
//!
//! The updater runs only where all three hold: the process is a standalone
//! binary (a container or dev run updates by other means — pulling the image,
//! git), its baked version is release-shaped (a dev build has nothing to
//! compare), and DISABLE_UPDATER is not set. Check failures are logged at debug
//! and never surface in any UI.
//!
//! Nothing here knows about WebSockets — progress is announced on the
//! `events` channel (an [`UpdateEvent`]); the gateway subscribes and broadcasts.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::config::CONFIG;
use crate::constants::{
    RELEASE_VERSION_RE, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_DELAY_MS,
    WINDOWS_HANDOFF_TIMEOUT_MS,
};
use crate::db::models::{
    NewUpdateAttempt, UpdateAttempt, UpdateAttemptChangeset, UpdateOutcome, UpdateTrigger,
};
use crate::db::schema::update_attempts;
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

/// What the updater reads and does outside itself: the build and the
/// configuration, the registry, the install on disk, the agent's activity,
/// telemetry and the process signal. [`SystemHost`] is the running process.
#[async_trait]
pub trait UpdateHost: Send + Sync {
    /// Whether this process is the standalone binary.
    fn is_sea(&self) -> bool;
    fn app_version(&self) -> String;
    fn disable_updater(&self) -> bool;
    fn is_windows(&self) -> bool;
    async fn fetch_latest_release_version(&self) -> Option<String>;
    async fn stage_release(&self, version: &str) -> anyhow::Result<String>;
    fn swap_install(&self, dist_dir: &str) -> anyhow::Result<()>;
    async fn spawn_windows_installer(&self, dist_dir: &str, version: &str) -> anyhow::Result<()>;
    fn sweep_update_dirs(&self);
    fn remove_staged_release(&self, version: &str);
    async fn is_agent_idle(&self) -> bool;
    fn track_event(&self, event: &str, properties: IndexMap<String, String>);
    /// Ends this process the way a `docker stop` does.
    fn raise_sigterm(&self);
}

/// The running process.
pub struct SystemHost;

#[async_trait]
impl UpdateHost for SystemHost {
    fn is_sea(&self) -> bool {
        crate::lib::environment::is_sea()
    }

    fn app_version(&self) -> String {
        CONFIG.app_version.clone()
    }

    fn disable_updater(&self) -> bool {
        CONFIG.disable_updater
    }

    fn is_windows(&self) -> bool {
        cfg!(windows)
    }

    async fn fetch_latest_release_version(&self) -> Option<String> {
        fetch_latest_release_version().await
    }

    async fn stage_release(&self, version: &str) -> anyhow::Result<String> {
        stage_release(version, None).await
    }

    fn swap_install(&self, dist_dir: &str) -> anyhow::Result<()> {
        swap_install(dist_dir, None)
    }

    async fn spawn_windows_installer(&self, dist_dir: &str, version: &str) -> anyhow::Result<()> {
        spawn_windows_installer(dist_dir, version).await
    }

    fn sweep_update_dirs(&self) {
        sweep_update_dirs(None);
    }

    fn remove_staged_release(&self, version: &str) {
        remove_staged_release(version, None);
    }

    async fn is_agent_idle(&self) -> bool {
        is_agent_idle().await
    }

    fn track_event(&self, event: &str, properties: IndexMap<String, String>) {
        let owner = CONFIG.owner_user_id();
        track_event(event, Some(&owner), Some(properties));
    }

    fn raise_sigterm(&self) {
        #[cfg(unix)]
        {
            let _ = nix::sys::signal::kill(nix::unistd::getpid(), nix::sys::signal::SIGTERM);
        }
        // Node's `process.kill(pid, 'SIGTERM')` terminates the process there.
        #[cfg(windows)]
        std::process::exit(1);
    }
}

pub struct UpdateService {
    /// `'update'` events; the gateway subscribes.
    pub events: broadcast::Sender<UpdateEvent>,

    host: Arc<dyn UpdateHost>,
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
        Self::with_host(Arc::new(SystemHost))
    }

    pub fn with_host(host: Arc<dyn UpdateHost>) -> Self {
        let (events, _) = broadcast::channel(64);
        Self {
            events,
            host,
            latest_version: Mutex::new(None),
            checked_at: Mutex::new(None),
            applying: AtomicBool::new(false),
            announced: Mutex::new(HashSet::new()),
            first_check_timer: Mutex::new(None),
            check_interval: Mutex::new(None),
        }
    }

    fn emit(&self, status: UpdateEventStatus, version: &str, error_code: Option<&str>) {
        // A send with no subscriber is fine: nobody is listening for it.
        let _ = self.events.send(UpdateEvent {
            status,
            version: version.to_string(),
            error_code: error_code.map(str::to_string),
        });
    }

    /// `disabled_by_env` when `DISABLE_UPDATER` is set, `not_sea_install` when the
    /// process is not a standalone binary, `dev_build` when the baked version is not
    /// release-shaped; enabled otherwise.
    pub fn gate(&self) -> UpdateGate {
        let reason = if self.host.disable_updater() {
            Some(UpdateDisabledReason::DisabledByEnv)
        } else if !self.host.is_sea() {
            Some(UpdateDisabledReason::NotSeaInstall)
        } else if !RELEASE_VERSION_RE.is_match(&self.host.app_version()) {
            Some(UpdateDisabledReason::DevBuild)
        } else {
            None
        };
        UpdateGate {
            enabled: reason.is_none(),
            reason,
        }
    }

    /// Boot entry: resolve attempts left pending by a previous process (the
    /// restart sentinel), then start the check loop when the gate allows it.
    pub async fn start(&'static self) -> anyhow::Result<()> {
        // Both of these belong to the installed binary, not to whatever process
        // happens to open the database. A source run shares ~/.prism/agent.db with
        // an install, and resolving there would mark that install's in-flight
        // attempt `restart_version_mismatch` while it is still mid-restart —
        // sweeping there would delete its staged release. Deliberately gated on
        // the standalone binary alone rather than the full gate: the process that
        // comes back after an update is the one that must resolve the sentinel,
        // even if the user set DISABLE_UPDATER in between.
        if self.host.is_sea() {
            self.resolve_pending_attempts().await?;
            self.host.sweep_update_dirs();
        }

        let UpdateGate { enabled, reason } = self.gate();
        if !enabled {
            log_info!(
                "[Update] updater off ({})",
                reason.map(UpdateDisabledReason::as_str).unwrap_or_default()
            );
            return Ok(());
        }

        let first = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(UPDATE_FIRST_CHECK_DELAY_MS as u64)).await;
            self.check_tick().await;
        });
        let interval = tokio::spawn(async move {
            let period = Duration::from_millis(UPDATE_CHECK_INTERVAL_MS as u64);
            loop {
                tokio::time::sleep(period).await;
                tokio::spawn(self.check_tick());
            }
        });
        *self.first_check_timer.lock() = Some(first);
        *self.check_interval.lock() = Some(interval);
        log_info!(
            "[Update] updater on — running {}, checking hourly",
            self.host.app_version()
        );
        Ok(())
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
        let UpdateGate { enabled, reason } = self.gate();
        let last = crate::db::run(|conn| {
            Ok(update_attempts::table
                .order(update_attempts::started_at.desc())
                .select(UpdateAttempt::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        let latest_version = self.latest_version.lock().clone();
        let checked_at = self.checked_at.lock().as_ref().map(crate::support::iso);
        Ok(UpdateStatusReport {
            enabled,
            reason,
            current_version: self.host.app_version(),
            latest_version,
            update_available: self.has_newer_version(),
            checked_at,
            applying: self.applying.load(Ordering::SeqCst),
            last_attempt: last.as_ref().map(to_attempt_report),
        })
    }

    /// One check against the registry. Updates the cached latest version;
    /// returns it, or `None` when the check could not complete (already logged
    /// at debug by the fetcher).
    pub async fn check_now(&self) -> Option<String> {
        let latest = self.host.fetch_latest_release_version().await?;
        *self.latest_version.lock() = Some(latest.clone());
        *self.checked_at.lock() = Some(Utc::now());
        Some(latest)
    }

    /// The first half of an apply: claim the single-flight flag and persist the
    /// attempt row, so the caller can acknowledge the update before the download
    /// starts knowing its outcome is recorded either way. Returns the running
    /// `completion` — `continue_apply`, already started. Fails with
    /// [`UpdateInProgressError`] when an apply is already running, or with the
    /// row-insert failure with the flag released.
    pub async fn start_apply(
        &'static self,
        version: &str,
        trigger: UpdateTrigger,
    ) -> anyhow::Result<StartedApply> {
        if self
            .applying
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(UpdateInProgressError.into());
        }

        let row = NewUpdateAttempt::new(self.host.app_version(), version, trigger);
        let created = crate::db::run(move |conn| {
            Ok(diesel::insert_into(update_attempts::table)
                .values(&row)
                .returning(UpdateAttempt::as_returning())
                .get_result(conn)?)
        })
        .await;
        let attempt = match created {
            Ok(attempt) => attempt,
            Err(error) => {
                // A failed insert must not leave the single-flight flag stuck true —
                // that would block every later attempt until a restart.
                self.applying.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        log_info!(
            "[Update] applying {} -> {} ({})",
            self.host.app_version(),
            version,
            trigger.as_str()
        );
        let completion = tokio::spawn(self.continue_apply(attempt, version.to_string(), trigger));
        Ok(StartedApply {
            version: version.to_string(),
            completion,
        })
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
        let StartedApply { completion, .. } = self.start_apply(version, trigger).await?;
        completion.await?
    }

    /// The rest of an apply after its row is recorded.
    async fn continue_apply(
        &'static self,
        attempt: UpdateAttempt,
        version: String,
        trigger: UpdateTrigger,
    ) -> anyhow::Result<ApplyOutcome> {
        let mut updating_emitted = false;
        let outcome: anyhow::Result<ApplyOutcome> = async {
            let dist_dir = self.host.stage_release(&version).await?;

            // Named trade: this narrows the window, it does not close it. A
            // message landing between this check and the exit — the swap, the
            // 500 ms flush delay, then a graceful shutdown, so roughly one to six
            // seconds — still starts a turn the restart interrupts. The next boot
            // continues that turn, so the window costs the work done before the
            // restart, and the reply still arrives. Closing it needs the thread
            // service to refuse new claims for the rest of the process's life,
            // which is a lock with its own failure mode (an update that then
            // fails leaves the agent mute).
            if trigger == UpdateTrigger::Auto && !self.host.is_agent_idle().await {
                // Not an attempt that failed — one that never activated. Drop the
                // row, keep the verified stage, and let the next tick retry.
                let id = attempt.id.clone();
                crate::db::run(move |conn| {
                    diesel::delete(update_attempts::table.find(id)).execute(conn)?;
                    Ok(())
                })
                .await?;
                self.applying.store(false, Ordering::SeqCst);
                log_info!(
                    "[Update] {} staged but the agent turned busy — deferring activation",
                    version
                );
                return Ok(ApplyOutcome {
                    version: version.clone(),
                    will_exit: false,
                    deferred: Some(true),
                });
            }

            self.emit(UpdateEventStatus::Updating, &version, None);
            updating_emitted = true;
            if self.host.is_windows() {
                self.host
                    .spawn_windows_installer(&dist_dir, &version)
                    .await?;
                self.arm_windows_handoff_watchdog(attempt.clone(), version.clone());
                return Ok(ApplyOutcome {
                    version: version.clone(),
                    will_exit: false,
                    deferred: None,
                });
            }
            self.host.swap_install(&dist_dir)?;
            Ok(ApplyOutcome {
                version: version.clone(),
                will_exit: true,
                deferred: None,
            })
        }
        .await;

        // `applying` intentionally stays true on success — this process is over.
        let error = match outcome {
            Ok(done) => return Ok(done),
            Err(error) => error,
        };
        let error_code = error
            .downcast_ref::<UpdateError>()
            .map(|e| e.code.as_str())
            .unwrap_or("apply_failed");
        let error_detail = error.to_string();
        // Its own guard: the two failures are correlated rather than
        // independent — a full disk fails the staging with ENOSPC and this write
        // with SQLITE_FULL — and that is exactly when the staged files most need
        // deleting and the UI most needs telling. A row left PENDING here would
        // also resolve SUCCESS at the next boot alongside a later real attempt,
        // double-counting `update applied`.
        if let Err(record_error) = self
            .finish_attempt(
                &attempt,
                UpdateOutcome::Failure,
                Some(error_code),
                Some(&error_detail),
            )
            .await
        {
            log_error!(
                json!({ "err": crate::lib::log_redaction::err_json(&record_error) }),
                "[Update] could not record the failed attempt"
            );
        }
        // Don't leave a few hundred MB staged until the next boot's sweep — an
        // always-on daemon can run for weeks.
        self.host.remove_staged_release(&version);
        // A manual failure is always reported. An automatic one is reported only
        // after 'updating' already went out — every 'updating' frame must end in
        // a restart or a 'failed', or the UIs stick on "updating…".
        if trigger == UpdateTrigger::Manual || updating_emitted {
            self.emit(UpdateEventStatus::Failed, &version, Some(error_code));
        }
        // Released even when recording the failure fails (a transient DB error
        // must not block every later attempt until a restart).
        self.applying.store(false, Ordering::SeqCst);
        Err(error)
    }

    /// End this process so the supervisor (launchd KeepAlive / systemd
    /// Restart=always) respawns the swapped-in binary. The delay (500 ms by
    /// default) lets the WS broadcast and any HTTP response flush first.
    ///
    /// Raises SIGTERM rather than exiting outright, so the restart runs the same
    /// graceful shutdown a `docker stop` gets: plugin MCP child processes closed
    /// instead of orphaned, a live meeting left rather than frozen in the room,
    /// channels disconnected, and telemetry flushed.
    pub fn schedule_restart_exit(&self, delay_ms: Option<u64>) {
        log_info!("[Update] restarting to finish the update");
        let host = Arc::clone(&self.host);
        let delay = Duration::from_millis(delay_ms.unwrap_or(500));
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            host.raise_sigterm();
        });
    }

    fn has_newer_version(&self) -> bool {
        if !self.gate().enabled {
            return false;
        }
        let Some(latest) = self.latest_version.lock().clone() else {
            return false;
        };
        compare_release_versions(&latest, &self.host.app_version()).is_ok_and(|order| order > 0)
    }

    /// The hourly tick: check, announce, and auto-apply when nothing is
    /// mid-flight. A busy agent (LLM turn, running cron task, live goal loop, live
    /// meeting) defers to the next tick rather than being restarted under a turn.
    async fn check_tick(&'static self) {
        if self.applying.load(Ordering::SeqCst) {
            return;
        }
        let Some(latest) = self.check_now().await else {
            return;
        };
        if !self.has_newer_version() {
            return;
        }

        // Announced on every tick, not once: a client that connects after the
        // first announce (the TUI has no status fetch) still learns about it on
        // the next tick, and both consumers render the frame idempotently. Only
        // the telemetry event is once-per-version.
        self.emit(UpdateEventStatus::Available, &latest, None);
        let first_announce = self.announced.lock().insert(latest.clone());
        if first_announce {
            log_info!(
                "[Update] {} is available (running {})",
                latest,
                self.host.app_version()
            );
            let mut props = IndexMap::new();
            props.insert("version_from".to_string(), self.host.app_version());
            props.insert("version_to".to_string(), latest.clone());
            self.host.track_event("update available", props);
        }

        if !self.host.is_agent_idle().await {
            log_info!(
                "[Update] {} not applied — agent busy, retrying next tick",
                latest
            );
            return;
        }
        match self.apply_update(&latest, UpdateTrigger::Auto).await {
            Ok(ApplyOutcome {
                deferred: Some(true),
                ..
            }) => {}
            Ok(ApplyOutcome { will_exit, .. }) => {
                if will_exit {
                    self.schedule_restart_exit(None);
                }
            }
            Err(error) => {
                log_warn!("[Update] automatic update to {} failed: {}", latest, error);
            }
        }
    }

    /// Windows only: the staged installer is supposed to kill this process, so
    /// reaching the deadline means it did not. Nothing else would notice — the
    /// Unix path has a supervisor, this one has the installer and nothing more —
    /// and the attempt would stay PENDING with `applying` stuck true, so no later
    /// tick ever retries.
    fn arm_windows_handoff_watchdog(&'static self, attempt: UpdateAttempt, version: String) {
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(WINDOWS_HANDOFF_TIMEOUT_MS as u64)).await;
            log_warn!(
                "[Update] the installer for {} did not restart this process within {} minutes — marking the attempt failed",
                version,
                WINDOWS_HANDOFF_TIMEOUT_MS / 60_000
            );
            if let Err(error) = self
                .finish_attempt(
                    &attempt,
                    UpdateOutcome::Failure,
                    Some("handoff_timeout"),
                    None,
                )
                .await
            {
                log_error!(
                    json!({ "err": crate::lib::log_redaction::err_json(&error) }),
                    "[Update] could not record the handoff timeout"
                );
            }
            self.emit(UpdateEventStatus::Failed, &version, Some("handoff_timeout"));
            self.applying.store(false, Ordering::SeqCst);
        });
    }

    /// The boot half of the restart sentinel: every attempt still PENDING was
    /// interrupted by its own handoff. It succeeded when this process runs the
    /// version it targeted or a newer release.
    async fn resolve_pending_attempts(&self) -> anyhow::Result<()> {
        let pending = crate::db::run(|conn| {
            Ok(update_attempts::table
                .filter(update_attempts::outcome.eq(UpdateOutcome::Pending))
                .select(UpdateAttempt::as_select())
                .load(conn)?)
        })
        .await?;
        let app_version = self.host.app_version();
        for row in pending {
            // This process can run a release newer than the target: the user can
            // run the installer by hand while the update is pending.
            let success = RELEASE_VERSION_RE.is_match(&app_version)
                && compare_release_versions(&app_version, &row.version_to)? >= 0;
            if success {
                self.finish_attempt(&row, UpdateOutcome::Success, None, None)
                    .await?;
                log_info!("[Update] updated {} -> {}", row.version_from, app_version);
            } else {
                self.finish_attempt(
                    &row,
                    UpdateOutcome::Failure,
                    Some("restart_version_mismatch"),
                    None,
                )
                .await?;
                let running = if app_version.is_empty() {
                    "<unversioned>"
                } else {
                    app_version.as_str()
                };
                log_warn!(
                    "[Update] update to {} did not take — running {}",
                    row.version_to,
                    running
                );
            }
        }
        Ok(())
    }

    /// Record an attempt's end (`finishedAt` now) and send `update applied`.
    async fn finish_attempt(
        &self,
        attempt: &UpdateAttempt,
        outcome: UpdateOutcome,
        error_code: Option<&str>,
        error_detail: Option<&str>,
    ) -> anyhow::Result<()> {
        let id = attempt.id.clone();
        let changes = UpdateAttemptChangeset {
            outcome: Some(outcome),
            error_code: Some(error_code.map(str::to_string)),
            error_detail: Some(error_detail.map(str::to_string)),
            finished_at: Some(Some(Utc::now())),
            ..Default::default()
        };
        crate::db::run(move |conn| {
            diesel::update(update_attempts::table.find(id))
                .set(&changes)
                .execute(conn)?;
            Ok(())
        })
        .await?;

        let mut props = IndexMap::new();
        props.insert("version_from".to_string(), attempt.version_from.clone());
        props.insert("version_to".to_string(), attempt.version_to.clone());
        props.insert("outcome".to_string(), outcome.as_str().to_string());
        props.insert("trigger".to_string(), attempt.trigger.as_str().to_string());
        if let Some(code) = error_code.filter(|code| !code.is_empty()) {
            props.insert("error_code".to_string(), code.to_string());
        }
        self.host.track_event("update applied", props);
        Ok(())
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
        trigger: row.trigger,
        outcome: row.outcome,
        error_code: row.error_code.clone(),
        started_at: crate::support::iso(&row.started_at),
        finished_at: row.finished_at.as_ref().map(crate::support::iso),
    }
}

pub static UPDATE_SERVICE: LazyLock<UpdateService> = LazyLock::new(UpdateService::new);

#[cfg(test)]
mod tests;
