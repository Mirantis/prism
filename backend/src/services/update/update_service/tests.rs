//! Update orchestrator tests: the gate matrix, the check loop (announce every
//! tick, telemetry once, defer while busy, auto-apply when idle), the restart
//! sentinel, and the failure paths of `apply_update`.

use super::*;
use crate::services::update::apply::UpdateErrorCode;

const CURRENT: &str = "v2026.8.20000000";
const NEWER: &str = "v2026.8.24083158";
const DIST: &str = "/tmp/staged/dist";

struct State {
    is_sea: bool,
    app_version: String,
    disable_updater: bool,
    windows: bool,
    latest: Option<String>,
    busy: bool,
    /// What staging answers: the dist dir, or an error.
    stage_error: Option<UpdateError>,
    /// The agent turns busy while staging runs.
    busy_after_stage: bool,
    swap_error: Option<UpdateError>,
    fetches: usize,
    staged: Vec<String>,
    swapped: Vec<String>,
    removed: Vec<String>,
    sweeps: usize,
    sigterms: usize,
    tracked: Vec<(String, IndexMap<String, String>)>,
}

struct FakeHost(Mutex<State>);

impl FakeHost {
    fn new() -> Arc<Self> {
        Arc::new(FakeHost(Mutex::new(State {
            is_sea: true,
            app_version: CURRENT.to_string(),
            disable_updater: false,
            windows: false,
            latest: None,
            busy: false,
            stage_error: None,
            busy_after_stage: false,
            swap_error: None,
            fetches: 0,
            staged: Vec::new(),
            swapped: Vec::new(),
            removed: Vec::new(),
            sweeps: 0,
            sigterms: 0,
            tracked: Vec::new(),
        })))
    }

    fn with(self: Arc<Self>, f: impl FnOnce(&mut State)) -> Arc<Self> {
        f(&mut self.0.lock());
        self
    }
}

#[async_trait]
impl UpdateHost for FakeHost {
    fn is_sea(&self) -> bool {
        self.0.lock().is_sea
    }
    fn app_version(&self) -> String {
        self.0.lock().app_version.clone()
    }
    fn disable_updater(&self) -> bool {
        self.0.lock().disable_updater
    }
    fn is_windows(&self) -> bool {
        self.0.lock().windows
    }
    async fn fetch_latest_release_version(&self) -> Option<String> {
        let mut state = self.0.lock();
        state.fetches += 1;
        state.latest.clone()
    }
    async fn stage_release(&self, version: &str) -> anyhow::Result<String> {
        let mut state = self.0.lock();
        state.staged.push(version.to_string());
        if state.busy_after_stage {
            state.busy = true;
        }
        match &state.stage_error {
            Some(error) => Err(error.clone().into()),
            None => Ok(DIST.to_string()),
        }
    }
    fn swap_install(&self, dist_dir: &str) -> anyhow::Result<()> {
        let mut state = self.0.lock();
        state.swapped.push(dist_dir.to_string());
        match state.swap_error.take() {
            Some(error) => Err(error.into()),
            None => Ok(()),
        }
    }
    async fn spawn_windows_installer(&self, _dist_dir: &str, _version: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn sweep_update_dirs(&self) {
        self.0.lock().sweeps += 1;
    }
    fn remove_staged_release(&self, version: &str) {
        self.0.lock().removed.push(version.to_string());
    }
    async fn is_agent_idle(&self) -> bool {
        !self.0.lock().busy
    }
    fn track_event(&self, event: &str, properties: IndexMap<String, String>) {
        self.0.lock().tracked.push((event.to_string(), properties));
    }
    fn raise_sigterm(&self) {
        self.0.lock().sigterms += 1;
    }
}

fn service(host: &Arc<FakeHost>) -> &'static UpdateService {
    Box::leak(Box::new(UpdateService::with_host(host.clone())))
}

fn props(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn drain(rx: &mut broadcast::Receiver<UpdateEvent>) -> Vec<UpdateEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

fn event(status: UpdateEventStatus, version: &str, error_code: Option<&str>) -> UpdateEvent {
    UpdateEvent {
        status,
        version: version.to_string(),
        error_code: error_code.map(str::to_string),
    }
}

async fn insert_pending(trigger: UpdateTrigger) -> String {
    let mut row = NewUpdateAttempt::new(CURRENT, NEWER, trigger);
    row.id = "a1".to_string();
    crate::db::run(move |conn| {
        diesel::insert_into(update_attempts::table)
            .values(&row)
            .execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    "a1".to_string()
}

async fn attempt(id: &str) -> Option<UpdateAttempt> {
    let id = id.to_string();
    crate::db::run(move |conn| {
        Ok(update_attempts::table
            .find(id)
            .select(UpdateAttempt::as_select())
            .first(conn)
            .optional()?)
    })
    .await
    .unwrap()
}

async fn only_attempt() -> UpdateAttempt {
    crate::db::run(|conn| {
        Ok(update_attempts::table
            .select(UpdateAttempt::as_select())
            .first(conn)?)
    })
    .await
    .unwrap()
}

/// Lets spawned work run to its end: sleeps past every short timer.
async fn settle() {
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ------------------------------------------------------------------- gate

#[tokio::test]
#[serial_test::serial]
async fn is_off_for_a_process_that_is_not_the_standalone_binary() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| s.is_sea = false);
    let status = service(&host).get_status().await.unwrap();
    assert!(!status.enabled);
    assert_eq!(status.reason, Some(UpdateDisabledReason::NotSeaInstall));
}

#[tokio::test]
#[serial_test::serial]
async fn is_off_for_a_dev_build() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| s.app_version = "0.1.0".to_string());
    let status = service(&host).get_status().await.unwrap();
    assert!(!status.enabled);
    assert_eq!(status.reason, Some(UpdateDisabledReason::DevBuild));
}

#[tokio::test]
#[serial_test::serial]
async fn is_off_when_disable_updater_is_set() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| s.disable_updater = true);
    let status = service(&host).get_status().await.unwrap();
    assert!(!status.enabled);
    assert_eq!(status.reason, Some(UpdateDisabledReason::DisabledByEnv));
}

#[tokio::test]
#[serial_test::serial]
async fn is_on_for_a_standalone_binary_with_a_release_version() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new();
    let status = service(&host).get_status().await.unwrap();
    assert!(status.enabled);
    assert_eq!(status.reason, None);
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(
        json,
        json!({
            "enabled": true,
            "reason": null,
            "currentVersion": CURRENT,
            "latestVersion": null,
            "updateAvailable": false,
            "checkedAt": null,
            "applying": false,
            "lastAttempt": null,
        })
    );
}

// ------------------------------------------------------------------- start

#[tokio::test]
#[serial_test::serial]
async fn resolves_pending_rows_and_sweeps_but_starts_no_loop_when_disabled() {
    let _db = crate::db::testing::test_db();
    let id = insert_pending(UpdateTrigger::Auto).await;
    let host = FakeHost::new().with(|s| s.disable_updater = true);
    let service = service(&host);
    service.start().await.unwrap();

    assert_ne!(attempt(&id).await.unwrap().outcome, UpdateOutcome::Pending);
    // Leftovers from before the updater was disabled still get swept.
    assert_eq!(host.0.lock().sweeps, 1);
    assert!(service.first_check_timer.lock().is_none());
    assert_eq!(host.0.lock().fetches, 0);
}

#[tokio::test]
#[serial_test::serial]
async fn never_resolves_or_sweeps_outside_the_standalone_binary() {
    let _db = crate::db::testing::test_db();
    let id = insert_pending(UpdateTrigger::Auto).await;
    let host = FakeHost::new().with(|s| s.is_sea = false);
    service(&host).start().await.unwrap();
    assert_eq!(host.0.lock().sweeps, 0);
    assert_eq!(attempt(&id).await.unwrap().outcome, UpdateOutcome::Pending);
}

#[tokio::test]
#[serial_test::serial]
async fn marks_a_pending_attempt_success_when_running_the_target_or_newer() {
    for boot_version in [NEWER, "v2026.8.25000000"] {
        let _db = crate::db::testing::test_db();
        let id = insert_pending(UpdateTrigger::Auto).await;
        let host = FakeHost::new().with(|s| s.app_version = boot_version.to_string());
        let service = service(&host);
        service.start().await.unwrap();
        service.stop();

        let row = attempt(&id).await.unwrap();
        assert_eq!(row.outcome, UpdateOutcome::Success);
        assert_eq!(row.error_code, None);
        assert!(row.finished_at.is_some());
        assert_eq!(
            host.0.lock().tracked,
            vec![(
                "update applied".to_string(),
                props(&[
                    ("version_from", CURRENT),
                    ("version_to", NEWER),
                    ("outcome", "SUCCESS"),
                    ("trigger", "AUTO"),
                ])
            )]
        );
    }
}

#[tokio::test]
#[serial_test::serial]
async fn marks_a_pending_attempt_failure_when_the_version_did_not_change() {
    let _db = crate::db::testing::test_db();
    let id = insert_pending(UpdateTrigger::Manual).await;
    let host = FakeHost::new();
    let service = service(&host);
    service.start().await.unwrap();
    service.stop();

    let row = attempt(&id).await.unwrap();
    assert_eq!(row.outcome, UpdateOutcome::Failure);
    assert_eq!(row.error_code.as_deref(), Some("restart_version_mismatch"));
    assert_eq!(
        host.0.lock().tracked[0]
            .1
            .get("error_code")
            .map(String::as_str),
        Some("restart_version_mismatch")
    );
}

// -------------------------------------------------------------- check loop

#[tokio::test(start_paused = true)]
#[serial_test::serial]
async fn announces_every_tick_defers_while_busy_and_applies_when_idle() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| {
        s.latest = Some(NEWER.to_string());
        s.busy = true;
    });
    let service = service(&host);
    let mut rx = service.events.subscribe();
    service.start().await.unwrap();

    // First tick: busy — announce, don't apply.
    tokio::time::sleep(Duration::from_millis(60_000)).await;
    settle().await;
    assert_eq!(
        drain(&mut rx),
        vec![event(UpdateEventStatus::Available, NEWER, None)]
    );
    assert_eq!(
        host.0.lock().tracked,
        vec![(
            "update available".to_string(),
            props(&[("version_from", CURRENT), ("version_to", NEWER)])
        )]
    );
    assert!(host.0.lock().staged.is_empty());

    // Second tick: still busy — re-announced (a client that connected after the
    // first tick has no other way to learn), telemetry not repeated.
    tokio::time::sleep(Duration::from_millis(60 * 60_000)).await;
    settle().await;
    assert_eq!(
        drain(&mut rx),
        vec![event(UpdateEventStatus::Available, NEWER, None)]
    );
    assert_eq!(host.0.lock().tracked.len(), 1);

    // Third tick: idle — stage, swap, restart.
    host.0.lock().busy = false;
    tokio::time::sleep(Duration::from_millis(60 * 60_000)).await;
    settle().await;
    assert_eq!(host.0.lock().staged, vec![NEWER.to_string()]);
    assert_eq!(host.0.lock().swapped, vec![DIST.to_string()]);
    assert!(drain(&mut rx).contains(&event(UpdateEventStatus::Updating, NEWER, None)));
    assert_eq!(host.0.lock().sigterms, 1);
    service.stop();
}

#[tokio::test(start_paused = true)]
#[serial_test::serial]
async fn does_nothing_when_the_registry_has_nothing_newer() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| s.latest = Some(CURRENT.to_string()));
    let service = service(&host);
    let mut rx = service.events.subscribe();
    service.start().await.unwrap();
    tokio::time::sleep(Duration::from_millis(60_000)).await;
    settle().await;
    assert_eq!(host.0.lock().fetches, 1);
    assert!(drain(&mut rx).is_empty());
    assert!(host.0.lock().staged.is_empty());
    service.stop();
}

// ------------------------------------------------------------ apply_update

#[tokio::test]
#[serial_test::serial]
async fn records_the_failure_and_frees_the_flag_when_staging_fails() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| {
        s.stage_error = Some(UpdateError::new(
            UpdateErrorCode::AssetNotFound,
            "not published yet",
        ))
    });
    let service = service(&host);
    let mut rx = service.events.subscribe();

    let error = service
        .apply_update(NEWER, UpdateTrigger::Manual)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "not published yet");

    let row = only_attempt().await;
    assert_eq!(row.outcome, UpdateOutcome::Failure);
    assert_eq!(row.error_code.as_deref(), Some("asset_not_found"));
    assert_eq!(row.error_detail.as_deref(), Some("not published yet"));
    // A manual failure is reported; the staged download is removed; the flag is
    // free for the next attempt.
    assert!(drain(&mut rx).contains(&event(
        UpdateEventStatus::Failed,
        NEWER,
        Some("asset_not_found")
    )));
    assert_eq!(host.0.lock().removed, vec![NEWER.to_string()]);
    assert!(!service.get_status().await.unwrap().applying);
}

#[tokio::test]
#[serial_test::serial]
async fn frees_the_flag_when_the_attempt_row_cannot_be_written() {
    let _db = crate::db::testing::test_db();
    crate::db::run(|conn| {
        diesel::sql_query("DROP TABLE update_attempts").execute(conn)?;
        Ok(())
    })
    .await
    .unwrap();
    let host = FakeHost::new();
    let service = service(&host);
    assert!(
        service
            .apply_update(NEWER, UpdateTrigger::Manual)
            .await
            .is_err()
    );
    assert!(!service.applying.load(Ordering::SeqCst));
    assert!(host.0.lock().staged.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn stays_silent_on_an_automatic_failure_before_updating() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new()
        .with(|s| s.stage_error = Some(UpdateError::new(UpdateErrorCode::DownloadFailed, "boom")));
    let service = service(&host);
    let mut rx = service.events.subscribe();
    let error = service
        .apply_update(NEWER, UpdateTrigger::Auto)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "boom");
    assert!(
        drain(&mut rx)
            .iter()
            .all(|e| e.status != UpdateEventStatus::Failed)
    );
}

#[tokio::test]
#[serial_test::serial]
async fn defers_an_automatic_activation_when_the_agent_turned_busy_during_the_download() {
    let _db = crate::db::testing::test_db();
    // Idle when the tick gated, busy by the time staging finished.
    let host = FakeHost::new().with(|s| s.busy_after_stage = true);
    let service = service(&host);
    let mut rx = service.events.subscribe();

    let outcome = service
        .apply_update(NEWER, UpdateTrigger::Auto)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        ApplyOutcome {
            version: NEWER.to_string(),
            will_exit: false,
            deferred: Some(true),
        }
    );
    // Not an attempt: the row is dropped, nothing activated, nothing said.
    let rows: i64 = crate::db::run(|conn| Ok(update_attempts::table.count().get_result(conn)?))
        .await
        .unwrap();
    assert_eq!(rows, 0);
    assert!(host.0.lock().swapped.is_empty());
    assert!(drain(&mut rx).is_empty());
    assert!(!service.get_status().await.unwrap().applying);
}

#[tokio::test]
#[serial_test::serial]
async fn reports_an_automatic_failure_that_happens_after_updating_went_out() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new()
        .with(|s| s.swap_error = Some(UpdateError::new(UpdateErrorCode::SwapFailed, "disk full")));
    let service = service(&host);
    let mut rx = service.events.subscribe();
    let error = service
        .apply_update(NEWER, UpdateTrigger::Auto)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "disk full");
    // Every 'updating' frame must end in a restart or a 'failed' — the UIs stick
    // on "updating…" otherwise.
    let statuses: Vec<UpdateEventStatus> = drain(&mut rx).into_iter().map(|e| e.status).collect();
    assert_eq!(
        statuses,
        vec![UpdateEventStatus::Updating, UpdateEventStatus::Failed]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn fails_the_attempt_when_the_windows_installer_never_restarts_this_process() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new().with(|s| s.windows = true);
    let service = service(&host);
    let mut rx = service.events.subscribe();

    let outcome = service
        .apply_update(NEWER, UpdateTrigger::Manual)
        .await
        .unwrap();
    assert!(!outcome.will_exit);
    // The installer owns the restart from here; nothing else would notice that
    // it died, so `applying` would otherwise stay true forever.
    assert!(service.get_status().await.unwrap().applying);

    tokio::time::pause();
    tokio::time::advance(Duration::from_millis(
        WINDOWS_HANDOFF_TIMEOUT_MS as u64 + 1_000,
    ))
    .await;
    settle().await;

    let row = only_attempt().await;
    assert_eq!(row.outcome, UpdateOutcome::Failure);
    assert_eq!(row.error_code.as_deref(), Some("handoff_timeout"));
    assert!(drain(&mut rx).contains(&event(
        UpdateEventStatus::Failed,
        NEWER,
        Some("handoff_timeout")
    )));
    assert!(!service.get_status().await.unwrap().applying);
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_applying_after_a_successful_swap() {
    let _db = crate::db::testing::test_db();
    let host = FakeHost::new();
    let service = service(&host);
    assert_eq!(
        service
            .apply_update(NEWER, UpdateTrigger::Manual)
            .await
            .unwrap(),
        ApplyOutcome {
            version: NEWER.to_string(),
            will_exit: true,
            deferred: None,
        }
    );
    // The process is about to exit.
    assert!(service.get_status().await.unwrap().applying);
    let error = service
        .apply_update(NEWER, UpdateTrigger::Manual)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "An update is already in progress.");
    assert!(error.downcast_ref::<UpdateInProgressError>().is_some());
}

#[test]
fn serializes_events_as_the_clients_read_them() {
    assert_eq!(
        serde_json::to_value(event(UpdateEventStatus::Available, NEWER, None)).unwrap(),
        json!({ "status": "available", "version": NEWER })
    );
    assert_eq!(
        serde_json::to_value(event(UpdateEventStatus::Failed, NEWER, Some("swap_failed"))).unwrap(),
        json!({ "status": "failed", "version": NEWER, "errorCode": "swap_failed" })
    );
}
