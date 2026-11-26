//! The task manager against a scripted fake agent: the buffer, drain, complete
//! and stop state machine on the neutral events every adapter emits, and the
//! pending-work row a restart continues from.

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

use super::*;
use crate::lib::coding_agents::coding_agent::{CodingAgentEvents, CodingAgentHome};
use crate::lib::execution_environments::execution_environment::ProcessEnv;

/// A run the test drives by hand. `stop()` ends the stream the way a killed CLI
/// does — a closing error result — unless the run is `stubborn`, in which case
/// it never ends and the manager has to give up on its own.
struct FakeRun {
    tx: Mutex<Option<mpsc::UnboundedSender<CodingAgentEvent>>>,
    events: Mutex<Option<CodingAgentEvents>>,
    exited: AtomicBool,
    stopped: AtomicBool,
    mark: Mutex<Option<ProcessMark>>,
    stubborn: bool,
    started: watch::Sender<bool>,
}

const MARK: ProcessMark = ProcessMark {
    pid: 4242,
    started_at: 1_000,
};

impl FakeRun {
    fn new(stubborn: bool, late_start: bool) -> Arc<FakeRun> {
        let (tx, rx) = mpsc::unbounded_channel();
        Arc::new(FakeRun {
            tx: Mutex::new(Some(tx)),
            events: Mutex::new(Some(UnboundedReceiverStream::new(rx).boxed())),
            exited: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            mark: Mutex::new((!late_start).then_some(MARK)),
            stubborn,
            started: watch::channel(!late_start).0,
        })
    }

    fn start(&self) {
        *self.mark.lock() = Some(MARK);
        self.started.send_replace(true);
    }

    fn emit(&self, event: CodingAgentEvent) {
        if let Some(tx) = self.tx.lock().as_ref() {
            let _ = tx.send(event);
        }
    }

    fn text(&self, text: &str) {
        self.emit(CodingAgentEvent::Text {
            text: text.to_string(),
        });
    }

    fn session(&self, session_id: &str) {
        self.emit(CodingAgentEvent::Session {
            session_id: session_id.to_string(),
        });
    }

    /// The agent finished on its own: its result, then the stream closes.
    fn finish(
        &self,
        stop_reason: CodingAgentStopReason,
        turns: i64,
        message: &str,
        refusals: Option<Vec<CodingAgentRefusal>>,
    ) {
        self.emit(CodingAgentEvent::Result {
            stop_reason,
            turns,
            message: message.to_string(),
            refusals,
        });
        self.end();
    }

    fn succeed(&self) {
        self.finish(CodingAgentStopReason::EndTurn, 1, "ok", None);
    }

    /// The stream closes without any result, as a broken adapter would.
    fn end(&self) {
        self.exited.store(true, Ordering::SeqCst);
        self.tx.lock().take();
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl CodingAgentRun for FakeRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    fn mark(&self) -> Option<ProcessMark> {
        *self.mark.lock()
    }

    async fn started(&self) {
        let mut started = self.started.subscribe();
        let _ = started.wait_for(|started| *started).await;
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if self.stubborn {
            return;
        }
        self.finish(
            CodingAgentStopReason::Error,
            0,
            "Fake Agent exited with code 143",
            None,
        );
    }
}

struct FakeAgent {
    id: CodingAgentName,
    stubborn: bool,
    late_start: bool,
    runs: Mutex<Vec<Arc<FakeRun>>>,
    tasks: Mutex<Vec<CodingAgentTask>>,
}

#[async_trait]
impl CodingAgent for FakeAgent {
    fn id(&self) -> CodingAgentName {
        self.id
    }

    fn display_name(&self) -> &str {
        "Fake Agent"
    }

    async fn prepare_home(&self) -> anyhow::Result<CodingAgentHome> {
        Ok(CodingAgentHome {
            config_dir: String::new(),
            skills_linked: true,
        })
    }

    async fn is_available(&self, _env: &ProcessEnv) -> anyhow::Result<bool> {
        Ok(true)
    }

    fn run(&self, task: CodingAgentTask) -> Arc<dyn CodingAgentRun> {
        self.tasks.lock().push(task);
        let run = FakeRun::new(self.stubborn, self.late_start);
        self.runs.lock().push(run.clone());
        run
    }
}

struct Harness {
    _db: crate::db::testing::TestDb,
    manager: Arc<AgentTaskManager>,
    agent: Arc<FakeAgent>,
}

impl Harness {
    fn run(&self) -> Arc<FakeRun> {
        self.agent
            .runs
            .lock()
            .last()
            .cloned()
            .expect("run not started yet")
    }

    fn task(&self) -> CodingAgentTask {
        self.agent
            .tasks
            .lock()
            .last()
            .cloned()
            .expect("run not started yet")
    }

    fn launched(&self) -> usize {
        self.agent.runs.lock().len()
    }
}

fn harness_with(stubborn: bool, late_start: bool) -> Harness {
    let db = crate::db::testing::test_db();
    let agent = Arc::new(FakeAgent {
        id: CodingAgentName::ClaudeCode,
        stubborn,
        late_start,
        runs: Mutex::new(Vec::new()),
        tasks: Mutex::new(Vec::new()),
    });
    let resolved = agent.clone();
    let manager = Arc::new(AgentTaskManager::new(Some(Arc::new(move |_| {
        let agent: Arc<dyn CodingAgent> = resolved.clone();
        Ok(agent)
    }))));
    Harness {
        _db: db,
        manager,
        agent,
    }
}

fn harness() -> Harness {
    harness_with(false, false)
}

fn sample() -> AgentTaskParams {
    AgentTaskParams {
        prompt: "do X".to_string(),
        ..Default::default()
    }
}

/// Poll until the task reports completion, as a real caller does; each
/// iteration accumulates the drained output.
async fn poll_until_complete(
    manager: &AgentTaskManager,
    task_id: &str,
) -> (String, AgentTaskStatus) {
    let mut output = String::new();
    for _ in 0..100 {
        let status = manager.read_status(task_id, Some(30)).await.unwrap();
        output.push_str(&status.output);
        if status.completed {
            return (output, status);
        }
    }
    panic!("task {task_id} did not complete");
}

/// Let the driver run to its finalize after the run ends.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
}

/// The coding-task rows as stored.
async fn rows() -> Vec<PendingWorkItem> {
    PENDING_WORK_SERVICE.flush().await;
    PENDING_WORK_SERVICE
        .rows(PendingWorkKind::CodingTask)
        .await
        .unwrap()
}

async fn row(task_id: &str) -> Option<serde_json::Value> {
    rows()
        .await
        .into_iter()
        .find(|item| item.key == task_id)
        .map(|item| item.payload)
}

fn refusal(action: &str, target: &str) -> CodingAgentRefusal {
    CodingAgentRefusal {
        action: action.to_string(),
        target: target.to_string(),
    }
}

#[tokio::test]
#[serial_test::serial]
async fn start_task_returns_a_task_id_and_tracks_the_task() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    assert!(!started.task_id.is_empty());
    assert_eq!(started.agent, CodingAgentName::ClaudeCode);
    assert_eq!(h.manager.running_count(), 1);
}

#[tokio::test]
#[serial_test::serial]
async fn hands_the_agent_the_task_inputs() {
    let h = harness();
    let started = h
        .manager
        .start_task(AgentTaskParams {
            workdir: Some("/work".to_string()),
            mode: Some(CodingAgentMode::Plan),
            max_turns: Some(7),
            append_system_prompt: Some("framing".to_string()),
            session_id: Some("sess-prev".to_string()),
            debug: Some(true),
            ..sample()
        })
        .await
        .unwrap();
    let task = h.task();
    assert_eq!(task.task_id, started.task_id);
    assert_eq!(task.prompt, "do X");
    assert_eq!(task.workdir.as_deref(), Some("/work"));
    assert_eq!(task.mode, CodingAgentMode::Plan);
    assert_eq!(task.max_turns, 7);
    assert_eq!(task.append_system_prompt.as_deref(), Some("framing"));
    assert_eq!(task.session_id.as_deref(), Some("sess-prev"));
    assert_eq!(task.debug, Some(true));
}

#[tokio::test]
#[serial_test::serial]
async fn defaults_to_edit_mode_and_the_standard_turn_budget() {
    let h = harness();
    h.manager.start_task(sample()).await.unwrap();
    assert_eq!(h.task().mode, CodingAgentMode::Edit);
    assert_eq!(h.task().max_turns, DEFAULT_MAX_TURNS);
}

#[tokio::test]
#[serial_test::serial]
async fn buffers_text_and_delivers_it_on_read_status() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text("hello ");
    run.text("world");
    run.succeed();

    let (output, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(output, "hello world");
    assert!(status.completed);
}

#[tokio::test]
#[serial_test::serial]
async fn reports_completion_and_result_fields_once_the_run_ends() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text("final answer");
    run.session("sess-42");
    run.finish(CodingAgentStopReason::EndTurn, 7, "final answer", None);

    let (output, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(output, "final answer");
    assert!(status.completed);
    assert_eq!(status.stop_reason, Some(TaskStopReason::EndTurn));
    assert_eq!(status.turns, Some(7));
    assert_eq!(status.session_id.as_deref(), Some("sess-42"));
    assert_eq!(status.result.as_deref(), Some("final answer"));
    assert_eq!(status.refusals, None);

    // After completion is delivered once and the next empty read, the task is
    // reaped and later lookups fail.
    let _ = h.manager.read_status(&started.task_id, Some(0)).await;
    let err = h
        .manager
        .read_status(&started.task_id, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("cleaned up"));
}

#[tokio::test]
#[serial_test::serial]
async fn uses_the_agents_message_as_the_result_when_it_produced_no_text() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.run()
        .finish(CodingAgentStopReason::EndTurn, 2, "summary", None);
    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.result.as_deref(), Some("summary"));
}

#[tokio::test]
#[serial_test::serial]
async fn appends_a_non_success_outcome_to_the_text_it_produced() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text("partial");
    run.finish(CodingAgentStopReason::MaxTurns, 100, "hit max", None);

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.stop_reason, Some(TaskStopReason::MaxTurns));
    assert_eq!(
        status.result.as_deref(),
        Some("partial\n\n[max_turns]: hit max")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_run_its_permission_checks_refused_part_of_as_refused_naming_each_action() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text("Steps 1 and 2 are done.");
    let refusals = vec![
        refusal("Bash", "git push --force origin main"),
        refusal("Write", "/work/forbidden.txt"),
    ];
    run.finish(
        CodingAgentStopReason::EndTurn,
        5,
        "Steps 1 and 2 are done.",
        Some(refusals.clone()),
    );

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.stop_reason, Some(TaskStopReason::Refused));
    assert_eq!(status.refusals, Some(refusals));
    assert_eq!(
        status.result.as_deref(),
        Some(
            "Steps 1 and 2 are done.\n\n[refused]: Fake Agent did not run these actions, because its permission checks refused them:\n- Bash: git push --force origin main\n- Write: /work/forbidden.txt"
        )
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_a_failed_outcome_as_it_is_and_lists_its_refusals_after_it() {
    let h = harness();
    let started = h
        .manager
        .start_task(AgentTaskParams {
            mode: Some(CodingAgentMode::Plan),
            ..sample()
        })
        .await
        .unwrap();
    h.run().finish(
        CodingAgentStopReason::MaxTurns,
        3,
        "hit max",
        Some(vec![refusal("Bash", "touch marker.txt")]),
    );

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.stop_reason, Some(TaskStopReason::MaxTurns));
    assert_eq!(
        status.result.as_deref(),
        Some(
            "Error (max_turns): hit max\n\n[refused]: Fake Agent did not run these actions, because its permission checks refused them:\n- Bash: touch marker.txt"
        )
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_non_success_outcome_with_no_text_as_an_error() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.run()
        .finish(CodingAgentStopReason::Error, 0, "boom", None);

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.stop_reason, Some(TaskStopReason::Error));
    assert_eq!(status.result.as_deref(), Some("Error (error): boom"));
}

#[tokio::test]
#[serial_test::serial]
async fn fails_a_task_whose_run_ends_without_reporting_a_result() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.run().end();

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.stop_reason, Some(TaskStopReason::Error));
    assert!(
        status
            .result
            .unwrap()
            .contains("Fake Agent ended without reporting a result")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn truncates_the_output_buffer_when_it_exceeds_max_buffer_size() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text(&"x".repeat(MAX_BUFFER_SIZE + 1000));
    run.succeed();

    let (output, _) = poll_until_complete(&h.manager, &started.task_id).await;
    assert!(output.starts_with("[...output truncated...]\n"));
    assert!(output.len() <= MAX_BUFFER_SIZE + 64);
}

#[tokio::test]
#[serial_test::serial]
async fn enforces_max_concurrent_on_start_task() {
    let h = harness();
    for _ in 0..MAX_CONCURRENT {
        h.manager.start_task(sample()).await.unwrap();
    }
    let err = h.manager.start_task(sample()).await.unwrap_err();
    assert_eq!(err.to_string(), "Max concurrent agent tasks (3) reached");
}

#[tokio::test]
#[serial_test::serial]
async fn read_status_on_an_unknown_task_id_fails() {
    let h = harness();
    let err = h.manager.read_status("no-such-id", None).await.unwrap_err();
    assert_eq!(err.to_string(), "Unknown task: no-such-id");
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_terminates_a_running_task_and_returns_the_output_so_far() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text("partial work");
    settle().await;

    let status = h.manager.stop_task(&started.task_id).await.unwrap();
    assert!(run.stopped());
    assert!(status.completed);
    assert_eq!(status.stop_reason, Some(TaskStopReason::Stopped));
    assert_eq!(status.output, "partial work");
    // The run's closing error is not reported as a task failure.
    assert_eq!(status.result.as_deref(), Some("partial work"));
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_reports_the_session_id_so_the_abandoned_work_can_be_resumed() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.run().session("sess-init");
    settle().await;

    let status = h.manager.stop_task(&started.task_id).await.unwrap();
    assert_eq!(status.session_id.as_deref(), Some("sess-init"));
    assert_eq!(
        status.result.as_deref(),
        Some("Task stopped before producing any output.")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_frees_the_concurrency_slot() {
    let h = harness();
    let mut ids = Vec::new();
    for _ in 0..MAX_CONCURRENT {
        ids.push(h.manager.start_task(sample()).await.unwrap().task_id);
    }
    assert!(h.manager.start_task(sample()).await.is_err());

    h.manager.stop_task(&ids[0]).await.unwrap();
    assert!(h.manager.start_task(sample()).await.is_ok());
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_rejects_an_unknown_or_already_stopped_task_id() {
    let h = harness();
    let err = h.manager.stop_task("no-such-id").await.unwrap_err();
    assert!(err.to_string().contains("Unknown task"));

    let started = h.manager.start_task(sample()).await.unwrap();
    h.manager.stop_task(&started.task_id).await.unwrap();
    let again = h.manager.stop_task(&started.task_id).await.unwrap_err();
    assert_eq!(
        again.to_string(),
        format!(
            "Task {} has already ended and been cleaned up",
            started.task_id
        )
    );
    let read = h
        .manager
        .read_status(&started.task_id, None)
        .await
        .unwrap_err();
    assert!(read.to_string().contains("cleaned up"));
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_on_a_task_that_already_finished_keeps_its_real_outcome() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.text("done text");
    run.finish(CodingAgentStopReason::EndTurn, 3, "done", None);
    settle().await;

    let status = h.manager.stop_task(&started.task_id).await.unwrap();
    assert_eq!(status.stop_reason, Some(TaskStopReason::EndTurn));
    assert_eq!(status.turns, Some(3));
    assert_eq!(status.output, "done text");
    assert!(!run.stopped());
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_does_not_relabel_a_run_that_ended_just_before_the_stop() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.session("sess-real");
    // Ends, and the stop comes before drive() reaches its finalize.
    run.finish(
        CodingAgentStopReason::EndTurn,
        3,
        "THE REAL FINAL RESULT",
        None,
    );

    let status = h.manager.stop_task(&started.task_id).await.unwrap();
    assert!(!run.stopped());
    assert_eq!(status.stop_reason, Some(TaskStopReason::EndTurn));
    assert_eq!(status.result.as_deref(), Some("THE REAL FINAL RESULT"));
    assert_eq!(status.turns, Some(3));
    assert_eq!(status.session_id.as_deref(), Some("sess-real"));
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_still_reports_output_and_a_session_id_when_the_run_never_ends() {
    let h = harness_with(true, false);
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.session("sess-stubborn");
    run.text("half-done work");
    settle().await;

    let status = h.manager.stop_task(&started.task_id).await.unwrap();
    assert!(run.stopped());
    assert!(status.completed);
    assert_eq!(status.stop_reason, Some(TaskStopReason::Stopped));
    assert_eq!(status.output, "half-done work");
    // The resume path survives the fallback, though no result ever arrives.
    assert_eq!(status.session_id.as_deref(), Some("sess-stubborn"));
    assert_eq!(
        status.result.as_deref(),
        Some("Task stopped; it did not exit cleanly, so no final result was captured.")
    );
}

#[tokio::test]
#[serial_test::serial]
async fn stop_task_wakes_a_parked_poll_instead_of_leaving_it_to_time_out() {
    let h = harness_with(true, false);
    let started = h.manager.start_task(sample()).await.unwrap();
    // Only the session, so there is nothing to drain and the poll really parks.
    h.run().session("sess-stubborn");
    settle().await;

    let begun = std::time::Instant::now();
    let manager = h.manager.clone();
    let id = started.task_id.clone();
    let parked = tokio::spawn(async move { manager.read_status(&id, Some(25_000)).await });
    settle().await;
    h.manager.stop_task(&started.task_id).await.unwrap();
    let parked = parked.await.unwrap().unwrap();

    // Woken by the stop, not by its own 25 s timer.
    assert!(begun.elapsed() < Duration::from_secs(8));
    assert!(parked.completed);
    assert_eq!(parked.stop_reason, Some(TaskStopReason::Stopped));
}

#[tokio::test]
#[serial_test::serial]
async fn kill_all_stops_running_tasks_and_forgets_them() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.manager.kill_all();
    assert!(h.run().stopped());
    assert!(h.manager.read_status(&started.task_id, None).await.is_err());
}

// --------------------------------------------------- a restart at any moment

#[tokio::test]
#[serial_test::serial]
async fn keeps_a_task_as_pending_work_from_its_start_until_its_end_has_been_read() {
    let h = harness();
    let started = h
        .manager
        .start_task(AgentTaskParams {
            prompt: "fix the build".to_string(),
            mode: Some(CodingAgentMode::Plan),
            ..Default::default()
        })
        .await
        .unwrap();
    let params = json!({ "agent": "claude-code", "prompt": "fix the build", "mode": "plan" });

    h.run().session("session-1");
    settle().await;
    assert_eq!(
        row(&started.task_id).await,
        Some(json!({
            "params": params,
            "sessionId": "session-1",
            "process": { "pid": 4242, "startedAt": 1_000 }
        }))
    );

    h.run().succeed();
    settle().await;
    // Kept for its reader, so the bound never drops it.
    assert_eq!(
        row(&started.task_id).await,
        Some(json!({
            "params": params,
            "sessionId": "session-1",
            "finished": { "result": "ok", "turns": 1, "stopReason": "end_turn" }
        }))
    );

    poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(row(&started.task_id).await, None);
}

#[tokio::test]
#[serial_test::serial]
async fn records_the_process_of_a_run_that_starts_late_before_the_agent_reports_a_session() {
    let h = harness_with(false, true);
    let started = h
        .manager
        .start_task(AgentTaskParams {
            prompt: "fix the build".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();
    settle().await;
    let params = json!({ "agent": "claude-code", "prompt": "fix the build" });
    assert_eq!(
        row(&started.task_id).await,
        Some(json!({ "params": params }))
    );

    h.run().start();
    settle().await;
    assert_eq!(
        row(&started.task_id).await,
        Some(json!({ "params": params, "process": { "pid": 4242, "startedAt": 1_000 } }))
    );
}

#[tokio::test]
#[serial_test::serial]
async fn refuses_a_task_for_an_agent_that_is_not_available_and_records_nothing() {
    let _db = crate::db::testing::test_db();
    let manager = Arc::new(AgentTaskManager::new(Some(Arc::new(|_| {
        anyhow::bail!("Coding agent \"codex\" is unavailable.")
    }))));

    let err = manager
        .start_task(AgentTaskParams {
            agent: Some(CodingAgentName::Codex),
            ..sample()
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("is unavailable"));
    assert!(rows().await.is_empty());
    assert_eq!(manager.running_count(), 0);
}

#[tokio::test]
#[serial_test::serial]
async fn stops_owing_a_task_once_a_read_hands_out_how_it_ended_also_with_its_last_output() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.run().text("all done");
    h.run().succeed();
    settle().await;

    let status = h
        .manager
        .read_status(&started.task_id, Some(0))
        .await
        .unwrap();

    assert!(status.completed);
    assert_eq!(status.output, "all done");
    assert_eq!(row(&started.task_id).await, None);
}

#[tokio::test]
#[serial_test::serial]
async fn stops_owing_a_task_the_agent_stopped() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.manager.stop_task(&started.task_id).await.unwrap();
    settle().await;
    assert_eq!(row(&started.task_id).await, None);
}

fn item(key: &str, payload: serde_json::Value) -> PendingWorkItem {
    PendingWorkItem {
        key: key.to_string(),
        payload,
        attempts: 1,
        created_at: chrono::Utc::now(),
    }
}

#[tokio::test]
#[serial_test::serial]
async fn resumes_the_session_of_a_task_a_restart_stopped_under_the_same_id() {
    let h = harness();
    h.manager
        .resume(
            vec![item(
                "task-7",
                json!({
                    "params": { "prompt": "fix the build", "mode": "edit", "agent": "claude-code" },
                    "sessionId": "session-1"
                }),
            )],
            vec![],
        )
        .await;

    let task = h.task();
    assert_eq!(task.task_id, "task-7");
    assert_eq!(task.session_id.as_deref(), Some("session-1"));
    assert_eq!(task.prompt, RESUMED_CODING_TASK_PROMPT);
    assert_eq!(task.mode, CodingAgentMode::Edit);

    h.run().text("continuing");
    h.run().succeed();
    let (output, status) = poll_until_complete(&h.manager, "task-7").await;
    assert_eq!(output, "continuing");
    assert!(status.completed);
}

#[tokio::test]
#[serial_test::serial]
async fn starts_a_task_again_when_the_restart_came_before_it_reported_a_session() {
    let h = harness();
    h.manager
        .resume(
            vec![item(
                "task-8",
                json!({ "params": { "prompt": "fix the build", "agent": "claude-code" } }),
            )],
            vec![],
        )
        .await;

    assert_eq!(h.task().task_id, "task-8");
    assert_eq!(h.task().prompt, "fix the build");
    assert_eq!(h.task().session_id, None);
}

#[tokio::test]
#[serial_test::serial]
async fn continues_the_other_tasks_when_one_cannot_continue() {
    let h = harness();
    let agent = h.agent.clone();
    let manager = Arc::new(AgentTaskManager::new(Some(Arc::new(move |id| {
        if id == CodingAgentName::Codex {
            anyhow::bail!("Coding agent \"codex\" is unavailable.");
        }
        let agent: Arc<dyn CodingAgent> = agent.clone();
        Ok(agent)
    }))));

    manager
        .resume(
            vec![
                item(
                    "task-codex",
                    json!({ "params": { "prompt": "a", "agent": "codex" } }),
                ),
                item(
                    "task-claude",
                    json!({ "params": { "prompt": "b", "agent": "claude-code" } }),
                ),
            ],
            vec![],
        )
        .await;

    let launched: Vec<String> = h
        .agent
        .tasks
        .lock()
        .iter()
        .map(|t| t.task_id.clone())
        .collect();
    assert_eq!(launched, ["task-claude"]);
    manager.kill_all();
}

#[tokio::test]
#[serial_test::serial]
async fn relaunches_nothing_for_a_task_the_restarts_gave_up() {
    let h = harness();
    h.manager
        .resume(
            vec![],
            vec![item(
                "task-loop",
                json!({ "params": { "prompt": "fix the build", "agent": "claude-code" } }),
            )],
        )
        .await;
    assert_eq!(h.launched(), 0);
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_finished_result_after_its_agent_became_unavailable() {
    let _db = crate::db::testing::test_db();
    let manager = Arc::new(AgentTaskManager::new(Some(Arc::new(|_| {
        anyhow::bail!("Coding agent \"codex\" is unavailable.")
    }))));

    manager
        .resume(
            vec![item(
                "task-done",
                json!({
                    "params": { "prompt": "fix it", "agent": "codex" },
                    "finished": { "result": "Fixed.", "turns": 2, "stopReason": "end_turn" }
                }),
            )],
            vec![],
        )
        .await;

    let status = manager.read_status("task-done", None).await.unwrap();
    assert!(status.completed);
    assert_eq!(status.result.as_deref(), Some("Fixed."));
    assert_eq!(status.agent, CodingAgentName::Codex);
}

fn unconnected(
    name: &str,
    status: &str,
    host: Option<&str>,
    network: bool,
) -> CodingAgentUnconnectedServer {
    CodingAgentUnconnectedServer {
        name: name.to_string(),
        status: status.to_string(),
        host: host.map(str::to_string),
        network,
    }
}

#[tokio::test]
#[serial_test::serial]
async fn lists_the_mcp_servers_a_run_started_without_after_its_result() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    let servers = vec![
        unconnected(
            "claude.ai Atlassian",
            "failed",
            Some("mcp-proxy.anthropic.com"),
            true,
        ),
        unconnected("repo-server", "failed", None, false),
    ];
    run.emit(CodingAgentEvent::Unconnected {
        servers: servers.clone(),
    });
    run.finish(CodingAgentStopReason::EndTurn, 2, "done", None);

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(status.stop_reason, Some(TaskStopReason::EndTurn));
    assert_eq!(status.unconnected_mcp_servers, Some(servers));
    assert_eq!(
        status.result.as_deref(),
        Some(
            "done\n\n[unconnected]: Fake Agent could not connect these MCP servers, so the task ran without their tools:\n- claude.ai Atlassian (failed, connects through mcp-proxy.anthropic.com)\n- repo-server (failed)\nThe sandbox's network policy may block a server's host, or a server may need a sign-in. A person can allow a host in the platform."
        )
    );
}

#[test]
fn adds_the_network_hint_only_for_a_server_marked_network() {
    let head = "[unconnected]: Fake Agent could not connect these MCP servers, so the task ran without their tools:";
    let hint = "\nThe sandbox's network policy may block a server's host, or a server may need a sign-in. A person can allow a host in the platform.";
    let connector = unconnected(
        "claude.ai Atlassian",
        "failed",
        Some("mcp-proxy.anthropic.com"),
        true,
    );
    let server = unconnected("repo-server", "failed", None, false);
    let remote = unconnected("repo-remote", "needs-auth", None, true);
    assert_eq!(
        describe_unconnected("Fake Agent", std::slice::from_ref(&server)),
        format!("{head}\n- repo-server (failed)")
    );
    assert_eq!(
        describe_unconnected("Fake Agent", std::slice::from_ref(&remote)),
        format!("{head}\n- repo-remote (needs-auth){hint}")
    );
    assert_eq!(
        describe_unconnected("Fake Agent", &[connector]),
        format!(
            "{head}\n- claude.ai Atlassian (failed, connects through mcp-proxy.anthropic.com){hint}"
        )
    );
    assert_eq!(
        describe_unconnected("Fake Agent", &[server, remote]),
        format!("{head}\n- repo-server (failed)\n- repo-remote (needs-auth){hint}")
    );
}

#[test]
fn reports_the_unconnected_mcp_servers_of_a_completed_task_by_their_wire_name() {
    let mut state = TaskState {
        agent: CodingAgentName::ClaudeCode,
        output_buffer: String::new(),
        completed: true,
        reporting: false,
        result: None,
        turns: None,
        stop_reason: None,
        session_id: None,
        refusals: None,
        unconnected_mcp_servers: Some(vec![unconnected("repo-server", "failed", None, false)]),
    };
    assert_eq!(
        serde_json::to_value(drain_task(&mut state)).unwrap()["unconnectedMcpServers"],
        json!([{ "name": "repo-server", "status": "failed", "network": false }])
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_last_list_when_the_run_reports_its_servers_twice() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    for name in ["first", "second"] {
        run.emit(CodingAgentEvent::Unconnected {
            servers: vec![unconnected(name, "failed", None, false)],
        });
    }
    run.finish(CodingAgentStopReason::EndTurn, 1, "done", None);

    let (_, status) = poll_until_complete(&h.manager, &started.task_id).await;
    assert_eq!(
        status.unconnected_mcp_servers,
        Some(vec![unconnected("second", "failed", None, false)])
    );
    assert!(!status.result.unwrap().contains("- first"));
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_unconnected_mcp_servers_of_a_finished_task_for_its_reader() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    let run = h.run();
    run.emit(CodingAgentEvent::Unconnected {
        servers: vec![unconnected(
            "claude.ai Atlassian",
            "failed",
            Some("mcp-proxy.anthropic.com"),
            true,
        )],
    });
    run.finish(CodingAgentStopReason::EndTurn, 2, "done", None);
    settle().await;

    let payload = row(&started.task_id).await.unwrap();
    assert_eq!(
        payload["finished"]["unconnectedMcpServers"],
        json!([{ "name": "claude.ai Atlassian", "status": "failed", "host": "mcp-proxy.anthropic.com", "network": true }])
    );
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_the_refusals_of_a_finished_task_for_its_reader() {
    let h = harness();
    let started = h.manager.start_task(sample()).await.unwrap();
    h.run().finish(
        CodingAgentStopReason::EndTurn,
        2,
        "done",
        Some(vec![refusal("Write", "/work/forbidden.txt")]),
    );
    settle().await;

    let payload = row(&started.task_id).await.unwrap();
    assert_eq!(payload["finished"]["stopReason"], "refused");
    assert_eq!(
        payload["finished"]["refusals"],
        json!([{ "action": "Write", "target": "/work/forbidden.txt" }])
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reports_the_result_of_a_task_that_ended_unread_before_the_restart() {
    let h = harness();
    h.manager
        .resume(
            vec![item(
                "task-9",
                json!({
                    "params": { "prompt": "fix the build", "agent": "claude-code" },
                    "sessionId": "session-9",
                    "finished": { "result": "Build fixed.", "turns": 4, "stopReason": "end_turn" }
                }),
            )],
            vec![],
        )
        .await;

    let status = h.manager.read_status("task-9", None).await.unwrap();
    assert!(status.completed);
    assert_eq!(status.result.as_deref(), Some("Build fixed."));
    assert_eq!(status.turns, Some(4));
    assert_eq!(status.session_id.as_deref(), Some("session-9"));
    assert_eq!(h.launched(), 0);
}

#[test]
fn reports_a_drained_status_with_the_wire_names() {
    let mut state = TaskState {
        agent: CodingAgentName::ClaudeCode,
        output_buffer: "out".to_string(),
        completed: false,
        reporting: false,
        result: Some("r".to_string()),
        turns: Some(1),
        stop_reason: Some(TaskStopReason::Refused),
        session_id: Some("s".to_string()),
        refusals: None,
        unconnected_mcp_servers: None,
    };
    assert_eq!(
        serde_json::to_string(&drain_task(&mut state)).unwrap(),
        r#"{"agent":"claude-code","output":"out","completed":false}"#
    );
    state.completed = true;
    assert_eq!(
        serde_json::to_string(&drain_task(&mut state)).unwrap(),
        r#"{"agent":"claude-code","output":"","completed":true,"result":"r","turns":1,"stopReason":"refused","sessionId":"s"}"#
    );
}

// ---------------------------------------------------------------------------
// A task started in a chat conversation
// ---------------------------------------------------------------------------

type Delivered = Arc<Mutex<Vec<(TaskNotificationTarget, String, String)>>>;

struct Notified {
    h: Harness,
    delivered: Delivered,
    /// Set to make every delivery fail, as a locked database would.
    failing: Arc<AtomicBool>,
}

fn target() -> TaskNotificationTarget {
    TaskNotificationTarget {
        thread_id: "thread-1".to_string(),
        agent_id: "agent-1".to_string(),
        user_id: "user-1".to_string(),
        origin_channel: Some("websocket".to_string()),
        origin_channel_id: None,
    }
}

fn notified_with(resolve: Option<ResolveAgent>) -> Notified {
    let h = harness();
    let delivered: Delivered = Arc::new(Mutex::new(Vec::new()));
    let failing = Arc::new(AtomicBool::new(false));
    let (record, fail) = (delivered.clone(), failing.clone());
    let deliver: DeliverNotification = Arc::new(move |target, task_id, text| {
        let (record, fail) = (record.clone(), fail.clone());
        Box::pin(async move {
            record.lock().push((target, task_id, text));
            if fail.load(Ordering::SeqCst) {
                anyhow::bail!("database is locked");
            }
            Ok(())
        })
    });
    let resolve = resolve.unwrap_or_else(|| {
        let agent = h.agent.clone();
        Arc::new(move |_| {
            let agent: Arc<dyn CodingAgent> = agent.clone();
            Ok(agent)
        })
    });
    let manager = Arc::new(AgentTaskManager::new(Some(resolve)).with_deliver(deliver));
    Notified {
        h: Harness { manager, ..h },
        delivered,
        failing,
    }
}

fn notified() -> Notified {
    notified_with(None)
}

fn notifying(prompt: &str) -> AgentTaskParams {
    AgentTaskParams {
        prompt: prompt.to_string(),
        notify: Some(target()),
        ..Default::default()
    }
}

#[tokio::test]
#[serial_test::serial]
async fn counts_an_ended_task_as_running_until_its_notification_is_stored() {
    let h = harness();
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = release.clone();
    let deliver: DeliverNotification = Arc::new(move |_, _, _| {
        let gate = gate.clone();
        Box::pin(async move {
            gate.notified().await;
            Ok(())
        })
    });
    let agent = h.agent.clone();
    let manager = Arc::new(
        AgentTaskManager::new(Some(Arc::new(move |_| {
            let agent: Arc<dyn CodingAgent> = agent.clone();
            Ok(agent)
        })))
        .with_deliver(deliver),
    );
    let h = Harness { manager, ..h };
    h.manager.start_task(notifying("plan it")).await.unwrap();
    h.run()
        .finish(CodingAgentStopReason::EndTurn, 1, "ok", None);
    settle().await;

    assert_eq!(h.manager.running_count(), 1);
    release.notify_one();
    settle().await;
    assert_eq!(h.manager.running_count(), 0);
}

#[tokio::test]
#[serial_test::serial]
async fn reports_how_a_notifying_task_ended_to_its_conversation() {
    let n = notified();
    let started =
        n.h.manager
            .start_task(notifying("upgrade React"))
            .await
            .unwrap();
    n.h.run().session("session-9");
    n.h.run().text("Upgraded; 0 type errors.");
    n.h.run()
        .finish(CodingAgentStopReason::EndTurn, 7, "ok", None);
    settle().await;

    let delivered = n.delivered.lock().clone();
    assert_eq!(delivered.len(), 1);
    let (to, task_id, text) = &delivered[0];
    assert_eq!(to, &target());
    assert_eq!(task_id, &started.task_id);
    assert!(text.contains(&format!(
        "<task-notification task-id=\"{}\" agent=\"claude-code\" stop-reason=\"end_turn\" turns=\"7\" session-id=\"session-9\">",
        started.task_id
    )));
    assert!(text.contains("Upgraded; 0 type errors."));
    // The stored report replaces the task: a restart keeps nothing, and a poll
    // after it reads the same end.
    assert_eq!(row(&started.task_id).await, None);
    let status =
        n.h.manager
            .read_status(&started.task_id, None)
            .await
            .unwrap();
    assert!(status.completed);
    assert_eq!(status.stop_reason, Some(TaskStopReason::EndTurn));
    assert_eq!(status.turns, Some(7));
    assert_eq!(status.session_id.as_deref(), Some("session-9"));
    assert_eq!(status.result.as_deref(), Some("Upgraded; 0 type errors."));
}

#[tokio::test]
#[serial_test::serial]
async fn reports_nothing_for_a_task_whose_result_a_poll_already_handed_out() {
    let n = notified();
    let started =
        n.h.manager
            .start_task(notifying("upgrade React"))
            .await
            .unwrap();
    let manager = n.h.manager.clone();
    let task_id = started.task_id.clone();
    let poll = tokio::spawn(async move { manager.read_status(&task_id, Some(1_000)).await });
    settle().await;
    n.h.run().succeed();
    assert!(poll.await.unwrap().unwrap().completed);
    settle().await;
    assert!(n.delivered.lock().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn reports_nothing_for_a_task_the_agent_stopped() {
    let n = notified();
    let started =
        n.h.manager
            .start_task(notifying("upgrade React"))
            .await
            .unwrap();
    n.h.manager.stop_task(&started.task_id).await.unwrap();
    settle().await;
    assert!(n.delivered.lock().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn reports_nothing_for_a_task_stopped_after_its_run_ended_and_before_its_finalize() {
    // The run has exited, so stop_task does not flag the stop and awaits the
    // finalize, which must not report what the stop call is about to hand back.
    let n = notified();
    let started =
        n.h.manager
            .start_task(notifying("upgrade React"))
            .await
            .unwrap();
    n.h.run().finish(
        CodingAgentStopReason::EndTurn,
        3,
        "THE REAL FINAL RESULT",
        None,
    );
    let status = n.h.manager.stop_task(&started.task_id).await.unwrap();
    settle().await;
    assert_eq!(status.result.as_deref(), Some("THE REAL FINAL RESULT"));
    assert!(n.delivered.lock().is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn keeps_a_task_for_the_next_boot_when_its_report_cannot_be_stored() {
    let n = notified();
    n.failing.store(true, Ordering::SeqCst);
    let started =
        n.h.manager
            .start_task(notifying("upgrade React"))
            .await
            .unwrap();
    n.h.run().succeed();
    settle().await;

    assert_eq!(n.delivered.lock().len(), 1);
    let kept = row(&started.task_id).await.expect("the task is still owed");
    assert_eq!(kept["params"]["notify"]["threadId"], "thread-1");
    assert_eq!(kept["finished"]["stopReason"], "end_turn");
}

#[tokio::test]
#[serial_test::serial]
async fn sends_the_report_a_restart_held_back() {
    let n = notified();
    n.h.manager
        .resume(
            vec![item(
                "task-1",
                json!({
                    "params": { "prompt": "upgrade React", "agent": "claude-code", "notify": target() },
                    "finished": { "stopReason": "end_turn", "turns": 2, "result": "Done." },
                }),
            )],
            Vec::new(),
        )
        .await;
    settle().await;

    let delivered = n.delivered.lock().clone();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].1, "task-1");
    assert!(delivered[0].2.contains("Done."));
}

#[tokio::test]
#[serial_test::serial]
async fn cuts_a_long_result_in_the_report_and_names_the_saved_copy() {
    let n = notified();
    let long = format!("{}THE END", "a".repeat(40_000));
    let started =
        n.h.manager
            .start_task(notifying("write the report"))
            .await
            .unwrap();
    n.h.run().text(&long);
    n.h.run()
        .finish(CodingAgentStopReason::EndTurn, 4, "ok", None);
    for _ in 0..20 {
        settle().await;
        if !n.delivered.lock().is_empty() {
            break;
        }
    }

    let delivered = n.delivered.lock().clone();
    assert_eq!(delivered[0].1, started.task_id);
    let text = &delivered[0].2;
    assert!(len16(text) < NOTIFICATION_RESULT_MAX_CHARS + 2_000);
    assert!(text.contains("INCOMPLETE OUTPUT"));
    assert!(
        text.contains("The whole result is saved at ")
            || text.contains("The whole result could not be saved."),
        "{}",
        &text[text.len().saturating_sub(800)..]
    );
    assert!(text.contains("THE END"));
}

#[tokio::test]
#[serial_test::serial]
async fn names_the_tasks_workdir_where_a_cut_result_is_saved() {
    let workdir = tempfile::tempdir().unwrap();
    let workdir = workdir.path().to_str().unwrap();
    let text = notification_text(
        CodingTaskOutcome {
            task_id: "task-1".to_string(),
            agent: "claude-code".to_string(),
            stop_reason: "end_turn".to_string(),
            result: format!("{}THE END", "a".repeat(40_000)),
            ..Default::default()
        },
        Some(workdir),
    )
    .await;
    if text.contains("The whole result is saved at ") {
        // shell_exec picks its environment from its workdir, so the notice names
        // the one that saved the copy.
        assert!(text.contains(&format!(
            "with shell_exec in workdir {}, using grep or sed.",
            serde_json::to_string(workdir).unwrap()
        )));
    }
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_task_the_boot_cannot_continue_as_failed_then_stops_owing_it() {
    let n = notified_with(Some(Arc::new(|_| {
        anyhow::bail!("Coding agent \"codex\" is unavailable.")
    })));
    n.h.manager
        .resume(
            vec![item(
                "task-codex",
                json!({ "params": { "prompt": "a", "agent": "codex", "notify": target() } }),
            )],
            Vec::new(),
        )
        .await;

    let delivered = n.delivered.lock().clone();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].1, "task-codex");
    assert!(delivered[0].2.contains("stop-reason=\"error\""));
    assert!(
        delivered[0]
            .2
            .contains("Coding agent \"codex\" is unavailable.")
    );
    assert_eq!(row("task-codex").await, None);
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_task_the_restarts_gave_up_as_failed() {
    let n = notified();
    n.h.manager
        .resume(
            Vec::new(),
            vec![item(
                "task-loop",
                json!({ "params": { "prompt": "fix the build", "agent": "claude-code", "notify": target() } }),
            )],
        )
        .await;

    let delivered = n.delivered.lock().clone();
    assert_eq!(delivered.len(), 1);
    assert!(delivered[0].2.contains("stop-reason=\"error\""));
    assert!(delivered[0].2.contains("given up"));
}

#[tokio::test]
#[serial_test::serial]
async fn reports_a_finished_task_the_restarts_gave_up_with_its_own_result() {
    let n = notified();
    n.h.manager
        .resume(
            Vec::new(),
            vec![item(
                "task-done",
                json!({
                    "params": { "prompt": "fix the build", "agent": "claude-code", "notify": target() },
                    "sessionId": "session-3",
                    "finished": { "stopReason": "end_turn", "turns": 5, "result": "Build fixed." },
                }),
            )],
        )
        .await;

    let delivered = n.delivered.lock().clone();
    let text = &delivered[0].2;
    assert!(text.contains(
        "<task-notification task-id=\"task-done\" agent=\"claude-code\" stop-reason=\"end_turn\" turns=\"5\" session-id=\"session-3\">"
    ));
    assert!(text.contains("Build fixed."));
    assert!(!text.contains("given up"));
}

#[tokio::test]
#[serial_test::serial]
async fn leaves_a_task_without_a_conversation_to_its_polls() {
    let n = notified();
    let started = n.h.manager.start_task(sample()).await.unwrap();
    n.h.run().succeed();
    settle().await;
    assert!(n.delivered.lock().is_empty());
    let status =
        n.h.manager
            .read_status(&started.task_id, None)
            .await
            .unwrap();
    assert_eq!(status.result.as_deref(), Some("ok"));
}

#[tokio::test]
#[serial_test::serial]
async fn records_the_tokens_the_agent_reports_against_the_request_and_thread_that_started_the_task()
{
    use crate::db::models::LlmCall;
    use crate::db::schema::llm_calls::dsl as l;
    use crate::lib::spend_context::{SpendSource, SpendSourceKind, with_spend_context};
    use diesel::prelude::*;

    let h = harness();
    crate::services::memory_store::tests::ensure_agent(&CONFIG.agent_id().unwrap());
    let spend = SpendContext {
        request_id: "message-1".into(),
        thread_id: Some("thread-1".into()),
        source: Some(SpendSource::of(SpendSourceKind::Chat)),
    };
    let started = with_spend_context(spend, h.manager.start_task(sample()))
        .await
        .unwrap();
    // Kept with the task, so a relaunch after a restart records against them too.
    let stored = row(&started.task_id).await.unwrap();
    assert_eq!(
        stored["params"]["spend"],
        json!({ "requestId": "message-1", "threadId": "thread-1", "source": { "kind": "chat" } })
    );

    h.run().emit(CodingAgentEvent::Usage {
        usage: CodingAgentUsage {
            model: "claude-haiku-5-5".into(),
            input_tokens: 2,
            cache_read_tokens: 10,
            cache_write_tokens: 143_355,
            long_cache_write_tokens: 143_355,
            output_tokens: 4,
            cost_usd: Some(0.14),
            subscription: false,
        },
    });
    h.run().succeed();
    poll_until_complete(&h.manager, &started.task_id).await;

    let mut calls: Vec<LlmCall> = Vec::new();
    for _ in 0..100 {
        calls = crate::db::run(|conn| Ok(l::llm_calls.select(LlmCall::as_select()).load(conn)?))
            .await
            .unwrap();
        if !calls.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let call = &calls[0];
    assert_eq!(
        (
            call.purpose.as_str(),
            call.model.as_str(),
            call.thread_id.as_deref(),
            call.request_id.as_deref(),
            call.source_kind.as_deref(),
        ),
        (
            "coding-agent",
            "claude-haiku-5-5",
            Some("thread-1"),
            Some("message-1"),
            Some("chat")
        )
    );
    assert_eq!(
        (
            call.total_tokens,
            call.input_tokens,
            call.output_tokens,
            call.cache_read_tokens,
            call.cache_write_tokens,
            call.no_cache_tokens,
        ),
        (143_371, 143_367, 4, 10, 143_355, 2)
    );
    assert_eq!(
        (call.cost_micro_usd, call.cost_source.as_deref()),
        (Some(140_000), Some("reported"))
    );
}
