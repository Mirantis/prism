//! Monitor manager for `monitor` / `monitor_stop`.
//!
//! A monitor runs a shell command in the agent's execution environment and turns
//! each line the command prints on stdout into an event for the chat conversation
//! that started it (`TASK_NOTIFICATION_SERVICE`). The lines that arrive within
//! `BATCH_MS` of the first go out as one notification, in order, so a command
//! that never pauses still sends one every `BATCH_MS`. stderr is read and
//! dropped, so a full pipe never blocks the command. The watch ends when the
//! command exits, when its deadline passes, when it prints more often than
//! `MAX_NOTIFICATIONS_PER_MINUTE`, or when the agent stops it. Every end but the
//! agent's own stop sends one last notice, stored under the monitor's id, so it
//! reaches the conversation once. A command that ignores SIGTERM gets SIGKILL
//! after `KILL_GRACE_MS`.
//!
//! A monitor is pending work from its start until its last notice is stored. A
//! restart stops the command, so the next boot stops a process a crash left
//! running and tells the conversation that the watch ended.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use crate::lib::agent_processes::{AGENT_PROCESSES, AgentProcessesEvent};
use crate::lib::execution_environments::execution_environment::{
    ExecProcess, ProcessMark, RunOptions, Signal, StdinMode,
};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment_for;
use crate::lib::execution_environments::leftover_process::stop_leftover_process;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::prompts::task_notification_prompt::{
    MonitorEndReason, render_monitor_end, render_monitor_event,
};
use crate::services::pending_work_service::{
    PENDING_WORK_SERVICE, PendingWorkItem, PendingWorkKind,
};
use crate::services::task_notification_service::{
    TASK_NOTIFICATION_SERVICE, TaskNotificationTarget,
};
use crate::{log_error, log_info};

pub const MAX_MONITORS: usize = 5;
pub const DEFAULT_TIMEOUT_MS: u64 = 5 * 60_000;
pub const MAX_TIMEOUT_MS: u64 = 30 * 60_000;
/// Lines printed this close together are one event.
pub const BATCH_MS: u64 = 200;
/// Each notification can start a turn, so a command that prints more often than this is stopped.
pub const MAX_NOTIFICATIONS_PER_MINUTE: usize = 12;
const MAX_LINE_CHARS: usize = 2_000;
const PIPE_DRAIN_MS: u64 = 1_000;
const MAX_BATCH_LINES: usize = 50;
/// How long a stopped command gets to honour SIGTERM before SIGKILL.
pub const KILL_GRACE_MS: u64 = 2_000;

#[derive(Debug, Clone)]
pub struct MonitorParams {
    pub command: String,
    pub description: String,
    pub timeout_ms: Option<u64>,
    pub workdir: String,
    pub notify: TaskNotificationTarget,
}

/// One event, under the id its notification is stored as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorEvent {
    pub id: String,
    pub text: String,
}

/// A monitor, as `pending_work` holds it until its last notice is stored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorWork {
    pub description: String,
    pub notify: TaskNotificationTarget,
    /// The command's process, which the next boot stops when a crash left it running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<ProcessMark>,
    /// Events sent so far, which the notice after a restart reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<u64>,
    /// Events not stored in the conversation yet, sent again before the last notice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsent: Option<Vec<MonitorEvent>>,
}

/// Stores a notification in the conversation; `TASK_NOTIFICATION_SERVICE.deliver`
/// unless a test injects another. Arguments: target, message id, text.
pub type DeliverMonitorNotification = Arc<
    dyn Fn(
            TaskNotificationTarget,
            String,
            String,
        ) -> futures::future::BoxFuture<'static, anyhow::Result<()>>
        + Send
        + Sync,
>;

type DeliveryJob = (
    TaskNotificationTarget,
    String,
    String,
    oneshot::Sender<anyhow::Result<()>>,
);

/// What `stop` and `kill_all` share with a running watch.
struct Running {
    proc: Arc<dyn ExecProcess>,
    /// Set by `monitor_stop` (or `kill_all`): no notice goes out.
    stopped_by_agent: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
}

pub struct MonitorManager {
    monitors: Mutex<HashMap<String, Running>>,
    /// Starts waiting for their pending-work row, which hold a slot already.
    starting: AtomicUsize,
    /// Notifications go out one at a time, so a conversation reads them in the order printed.
    queue: mpsc::UnboundedSender<DeliveryJob>,
}

fn props(pairs: &[(&str, String)]) -> IndexMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

fn persist(monitor_id: &str, work: &MonitorWork) {
    if let Ok(value) = serde_json::to_value(work) {
        PENDING_WORK_SERVICE.update(PendingWorkKind::Monitor, monitor_id, value);
    }
}

/// SIGTERM, then SIGKILL for a command still running after the grace period.
fn terminate(proc: &Arc<dyn ExecProcess>, exited: &Arc<AtomicBool>) {
    proc.kill(Signal::SIGTERM);
    let proc = proc.clone();
    let exited = exited.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS)).await;
        if !exited.load(Ordering::SeqCst) {
            proc.kill(Signal::SIGKILL);
        }
    });
}

/// The first `max` characters of `text`, and whether it was longer.
fn clip(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (text[..at].to_string(), true),
        None => (text.to_string(), false),
    }
}

impl MonitorManager {
    pub fn new() -> Self {
        let deliver: DeliverMonitorNotification = Arc::new(|target, id, text| {
            Box::pin(async move { TASK_NOTIFICATION_SERVICE.deliver(&target, &id, &text).await })
        });
        Self::with_deliver(deliver)
    }

    /// Deliver notifications with `deliver` instead of the conversation engine.
    pub fn with_deliver(deliver: DeliverMonitorNotification) -> Self {
        let (queue, mut jobs) = mpsc::unbounded_channel::<DeliveryJob>();
        tokio::spawn(async move {
            while let Some((target, id, text, done)) = jobs.recv().await {
                let _ = done.send(deliver(target, id, text).await);
            }
        });
        MonitorManager {
            monitors: Mutex::new(HashMap::new()),
            starting: AtomicUsize::new(0),
            queue,
        }
    }

    pub fn running_count(&self) -> usize {
        self.starting.load(Ordering::SeqCst) + self.monitors.lock().len()
    }

    /// Start a watch. Fails at `MAX_MONITORS`, and without running the command
    /// when the monitor cannot be recorded, since a restart would lose it.
    pub async fn start(self: &Arc<Self>, params: MonitorParams) -> anyhow::Result<String> {
        // A step's tool calls run in parallel, so the slot is taken before the await.
        if self.running_count() >= MAX_MONITORS {
            anyhow::bail!(
                "At most {MAX_MONITORS} monitors run at once. Stop one with monitor_stop first."
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        let work = MonitorWork {
            description: params.description.clone(),
            notify: params.notify.clone(),
            ..MonitorWork::default()
        };
        self.starting.fetch_add(1, Ordering::SeqCst);
        // Before the command: a restart in between finds the row and tells the conversation.
        let begun = PENDING_WORK_SERVICE
            .begin(PendingWorkKind::Monitor, &id, serde_json::to_value(&work)?)
            .await;
        self.starting.fetch_sub(1, Ordering::SeqCst);
        begun?;

        let environment = get_execution_environment_for(Some(&params.workdir));
        let proc = environment.run_shell(
            &params.command,
            RunOptions {
                cwd: params.workdir.clone(),
                env: environment.base_env(),
                stdin: StdinMode::Ignore,
            },
        );
        let timeout_ms = params
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);
        let stopped_by_agent = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        self.monitors.lock().insert(
            id.clone(),
            Running {
                proc: proc.clone(),
                stopped_by_agent: stopped_by_agent.clone(),
                exited: exited.clone(),
            },
        );
        let work = Arc::new(Mutex::new(work));
        Self::record_process(&id, &proc, &work);

        let notify = &params.notify;
        track_event(
            "monitor started",
            Some(&notify.user_id),
            Some(props(&[
                ("agent.id", notify.agent_id.clone()),
                ("thread.id", notify.thread_id.clone()),
                ("monitor.id", id.clone()),
                ("monitor.timeout_ms", timeout_ms.to_string()),
            ])),
        );
        log_info!(
            json!({ "monitorId": id, "timeoutMs": timeout_ms }),
            "[Monitor] started"
        );

        let watch = Watch {
            manager: self.clone(),
            id: id.clone(),
            params,
            proc,
            work,
            stopped_by_agent,
            exited,
            started_at: Instant::now(),
            timeout: Duration::from_millis(timeout_ms),
            events: 0,
            partial: Vec::new(),
            batch: Vec::new(),
            dropped_lines: 0,
            sent: VecDeque::new(),
            sending: Vec::new(),
            reason: None,
        };
        tokio::spawn(watch.run());
        Ok(id)
    }

    /// Stop a monitor the agent no longer needs. Answers whether it was running.
    pub fn stop(&self, monitor_id: &str) -> bool {
        let monitors = self.monitors.lock();
        let Some(running) = monitors.get(monitor_id) else {
            return false;
        };
        running.stopped_by_agent.store(true, Ordering::SeqCst);
        terminate(&running.proc, &running.exited);
        true
    }

    /// Tell each conversation whose monitor a restart stopped that the watch ended,
    /// after stopping a command a crash left running.
    pub async fn resume(&self, items: Vec<PendingWorkItem>, given_up: Vec<PendingWorkItem>) {
        for item in items.iter().chain(given_up.iter()) {
            if let Ok(work) = serde_json::from_value::<MonitorWork>(item.payload.clone())
                && let Some(process) = work.process
            {
                stop_leftover_process(process).await;
            }
        }
        for item in items {
            let Ok(work) = serde_json::from_value::<MonitorWork>(item.payload) else {
                PENDING_WORK_SERVICE.end(PendingWorkKind::Monitor, &item.key);
                continue;
            };
            let events = work.events.unwrap_or(0);
            track_event(
                "monitor ended",
                Some(&work.notify.user_id),
                Some(props(&[
                    ("agent.id", work.notify.agent_id.clone()),
                    ("monitor.id", item.key.clone()),
                    ("monitor.reason", "restart".to_string()),
                    ("monitor.events", events.to_string()),
                ])),
            );
            let text = render_monitor_end(
                &item.key,
                &work.description,
                MonitorEndReason::Restart,
                events,
                None,
            );
            let work = Arc::new(Mutex::new(work));
            let unsent = work.lock().unsent.clone().unwrap_or_default();
            let mut sends: Vec<_> = unsent
                .into_iter()
                .map(|event| self.send_event(&item.key, &work, event))
                .collect();
            let notify = work.lock().notify.clone();
            sends.push(self.deliver(notify, text, item.key.clone()));
            match settle(sends).await {
                Ok(()) => PENDING_WORK_SERVICE.end(PendingWorkKind::Monitor, &item.key),
                Err(err) => log_error!(
                    json!({ "err": err_json(&err), "monitorId": item.key }),
                    "[Monitor] Could not report the monitor a restart stopped"
                ),
            }
        }
    }

    /// Stop every monitor without a notice, as a shutdown does.
    pub fn kill_all(&self) {
        for running in self.monitors.lock().values() {
            running.stopped_by_agent.store(true, Ordering::SeqCst);
            running.proc.kill(Signal::SIGKILL);
        }
    }

    /// A command a secure takeover holds starts on resume, and only then has a process to record.
    fn record_process(id: &str, proc: &Arc<dyn ExecProcess>, work: &Arc<Mutex<MonitorWork>>) {
        let save = |proc: &Arc<dyn ExecProcess>| -> bool {
            let Some(mark) = proc.mark() else {
                return false;
            };
            let mut work = work.lock();
            work.process = Some(mark);
            persist(id, &work);
            true
        };
        if save(proc) {
            return;
        }
        let mut events = AGENT_PROCESSES.subscribe();
        let proc = proc.clone();
        let work = work.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = proc.ended() => return,
                    event = events.recv() => match event {
                        Ok(AgentProcessesEvent::Resume) => {
                            if let Some(mark) = proc.mark() {
                                let mut work = work.lock();
                                work.process = Some(mark);
                                persist(&id, &work);
                                return;
                            }
                        }
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => return,
                    },
                }
            }
        });
    }

    /// Store one event; once it is stored, its row no longer lists it.
    fn send_event(
        &self,
        monitor_id: &str,
        work: &Arc<Mutex<MonitorWork>>,
        event: MonitorEvent,
    ) -> oneshot::Receiver<anyhow::Result<()>> {
        let notify = work.lock().notify.clone();
        let delivered = self.deliver(notify, event.text, event.id.clone());
        let (done, receiver) = oneshot::channel();
        let work = work.clone();
        let monitor_id = monitor_id.to_string();
        tokio::spawn(async move {
            let result = match delivered.await {
                Ok(Ok(())) => {
                    let mut work = work.lock();
                    if let Some(unsent) = work.unsent.as_mut() {
                        unsent.retain(|pending| pending.id != event.id);
                    }
                    persist(&monitor_id, &work);
                    Ok(())
                }
                Ok(Err(err)) => Err(err),
                Err(_) => Err(anyhow::anyhow!("the notification queue closed")),
            };
            let _ = done.send(result);
        });
        receiver
    }

    /// `message_id` makes the delivery idempotent: a stored id is not stored again.
    fn deliver(
        &self,
        target: TaskNotificationTarget,
        text: String,
        message_id: String,
    ) -> oneshot::Receiver<anyhow::Result<()>> {
        let (done, receiver) = oneshot::channel();
        if let Err(mpsc::error::SendError((_, _, _, done))) =
            self.queue.send((target, message_id, text, done))
        {
            let _ = done.send(Err(anyhow::anyhow!("the notification queue closed")));
        }
        receiver
    }
}

impl Default for MonitorManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Wait for every send; the first failure, once all have settled.
async fn settle(sends: Vec<oneshot::Receiver<anyhow::Result<()>>>) -> anyhow::Result<()> {
    let mut first_error = None;
    for send in sends {
        let result = send
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("the notification queue closed")));
        if let Err(err) = result
            && first_error.is_none()
        {
            first_error = Some(err);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// One running watch, owned by its task.
struct Watch {
    manager: Arc<MonitorManager>,
    id: String,
    params: MonitorParams,
    proc: Arc<dyn ExecProcess>,
    work: Arc<Mutex<MonitorWork>>,
    stopped_by_agent: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    started_at: Instant,
    timeout: Duration,
    events: u64,
    /// Bytes after the last newline, which become a line once its newline arrives.
    partial: Vec<u8>,
    /// At most `MAX_BATCH_LINES`; the lines past them are only counted.
    batch: Vec<String>,
    dropped_lines: usize,
    /// When recent notifications went out, for the rate limit.
    sent: VecDeque<Instant>,
    /// Event sends not settled yet.
    sending: Vec<oneshot::Receiver<anyhow::Result<()>>>,
    /// Why the runtime stopped the command, when it did.
    reason: Option<MonitorEndReason>,
}

impl Watch {
    async fn run(mut self) {
        let mut stdout = self.proc.take_stdout();
        // Only stdout is an event. Unread, stderr would fill its pipe and block the command.
        if let Some(mut stderr) = self.proc.take_stderr() {
            tokio::spawn(async move {
                let mut sink = [0u8; 8192];
                while matches!(stderr.read(&mut sink).await, Ok(n) if n > 0) {}
            });
        }
        let (ended_tx, mut ended_rx) = oneshot::channel();
        {
            let proc = self.proc.clone();
            tokio::spawn(async move {
                let end = proc.ended().await;
                let _ = ended_tx.send(end);
            });
        }

        let deadline = self.started_at + self.timeout;
        let mut batch_at: Option<Instant> = None;
        let mut drain_until: Option<Instant> = None;
        let mut exit_code: Option<i32> = None;
        let mut eof = stdout.is_none();
        let mut buf = vec![0u8; 8192];
        let far = || Instant::now() + Duration::from_secs(86_400 * 365);

        loop {
            if eof && drain_until.is_some() {
                break;
            }
            tokio::select! {
                read = async {
                    match stdout.as_mut() {
                        Some(out) => out.read(&mut buf).await,
                        None => std::future::pending().await,
                    }
                }, if !eof => match read {
                    Ok(0) | Err(_) => eof = true,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        if self.read(&chunk) && batch_at.is_none() {
                            // From the batch's first line, so a command that never pauses still sends events.
                            batch_at = Some(Instant::now() + Duration::from_millis(BATCH_MS));
                        }
                    }
                },
                _ = tokio::time::sleep_until(batch_at.unwrap_or_else(far)), if batch_at.is_some() => {
                    batch_at = None;
                    self.flush();
                }
                _ = tokio::time::sleep_until(deadline), if self.reason.is_none() && drain_until.is_none() => {
                    self.halt(MonitorEndReason::Timeout);
                }
                end = &mut ended_rx, if drain_until.is_none() => {
                    self.exited.store(true, Ordering::SeqCst);
                    exit_code = end.ok().and_then(|end| end.exit_code);
                    // The last lines can still be in the pipe when the process exits. A
                    // grandchild that inherited the pipe can hold it open, so the wait
                    // for it is short.
                    drain_until = Some(Instant::now() + Duration::from_millis(PIPE_DRAIN_MS));
                }
                _ = tokio::time::sleep_until(drain_until.unwrap_or_else(far)), if drain_until.is_some() => break,
            }
        }
        // A child that still holds stdout prints nothing more into this watch.
        drop(stdout);
        self.end(exit_code).await;
    }

    /// Take a chunk of stdout; true when it completed a line for the batch.
    fn read(&mut self, chunk: &[u8]) -> bool {
        self.partial.extend_from_slice(chunk);
        let Some(last_newline) = self.partial.iter().rposition(|b| *b == b'\n') else {
            // A line with no newline yet keeps only what an event shows of it,
            // plus one character so the cut is marked (4 bytes per character at most).
            self.partial.truncate((MAX_LINE_CHARS + 1) * 4);
            return false;
        };
        let rest = self.partial.split_off(last_newline + 1);
        let complete = std::mem::replace(&mut self.partial, rest);
        self.partial.truncate((MAX_LINE_CHARS + 1) * 4);
        let full: Vec<String> = String::from_utf8_lossy(&complete[..complete.len() - 1])
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .filter(|line| !line.trim().is_empty())
            .collect();
        if full.is_empty() {
            return false;
        }
        let room = MAX_BATCH_LINES.saturating_sub(self.batch.len());
        self.dropped_lines += full.len().saturating_sub(room);
        self.batch.extend(full.into_iter().take(room));
        true
    }

    fn flush(&mut self) {
        let dropped = std::mem::take(&mut self.dropped_lines);
        if self.batch.is_empty()
            || self.stopped_by_agent.load(Ordering::SeqCst)
            || self.reason == Some(MonitorEndReason::TooManyEvents)
        {
            self.batch.clear();
            return;
        }
        let now = Instant::now();
        while self
            .sent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60))
        {
            self.sent.pop_front();
        }
        if self.sent.len() >= MAX_NOTIFICATIONS_PER_MINUTE {
            self.batch.clear();
            self.halt(MonitorEndReason::TooManyEvents);
            return;
        }
        self.sent.push_back(now);
        self.events += 1;
        let mut shown: Vec<String> = self
            .batch
            .drain(..)
            .map(|line| match clip(&line, MAX_LINE_CHARS) {
                (cut, true) => format!("{cut}…"),
                (line, false) => line,
            })
            .collect();
        if dropped > 0 {
            shown.push(format!("[{dropped} more lines]"));
        }
        let text = render_monitor_event(&self.id, &self.params.description, &shown);
        let event = MonitorEvent {
            id: format!("{}:{}", self.id, self.events),
            text,
        };
        // In the row before it is sent: an event a failed store or a restart lost is sent again.
        {
            let mut work = self.work.lock();
            work.events = Some(self.events);
            work.unsent.get_or_insert_with(Vec::new).push(event.clone());
            persist(&self.id, &work);
        }
        let send = self.manager.send_event(&self.id, &self.work, event);
        self.sending.push(send);
    }

    /// The runtime stops the command; `end` sends the notice once it has exited.
    fn halt(&mut self, reason: MonitorEndReason) {
        if self.reason.is_some() || self.stopped_by_agent.load(Ordering::SeqCst) {
            return;
        }
        self.reason = Some(reason);
        terminate(&self.proc, &self.exited);
    }

    async fn end(mut self, exit_code: Option<i32>) {
        self.manager.monitors.lock().remove(&self.id);
        self.proc.kill(Signal::SIGKILL);
        // A shutdown leaves the row, and the next boot reports the end.
        if PENDING_WORK_SERVICE.shutdown_signal().is_cancelled() {
            return;
        }
        if !String::from_utf8_lossy(&self.partial).trim().is_empty() {
            let line = String::from_utf8_lossy(&self.partial).to_string();
            if self.batch.len() < MAX_BATCH_LINES {
                self.batch.push(line);
            } else {
                self.dropped_lines += 1;
            }
        }
        self.partial.clear();
        self.flush();

        let reason = if self.stopped_by_agent.load(Ordering::SeqCst) {
            MonitorEndReason::Stopped
        } else {
            self.reason.unwrap_or(MonitorEndReason::Exit)
        };
        let notify = self.params.notify.clone();
        track_event(
            "monitor ended",
            Some(&notify.user_id),
            Some(props(&[
                ("agent.id", notify.agent_id.clone()),
                ("monitor.id", self.id.clone()),
                ("monitor.reason", reason.as_str().to_string()),
                ("monitor.events", self.events.to_string()),
                (
                    "monitor.elapsed_ms",
                    self.started_at.elapsed().as_millis().to_string(),
                ),
            ])),
        );
        log_info!(
            json!({ "monitorId": self.id, "reason": reason.as_str(), "events": self.events }),
            "[Monitor] ended"
        );
        let text = (reason != MonitorEndReason::Stopped).then(|| {
            render_monitor_end(
                &self.id,
                &self.params.description,
                reason,
                self.events,
                exit_code,
            )
        });
        // Once the sends settle, the events still listed are the ones whose store failed.
        let _ = settle(std::mem::take(&mut self.sending)).await;
        let unsent = self.work.lock().unsent.clone().unwrap_or_default();
        let mut sends: Vec<_> = unsent
            .into_iter()
            .map(|event| self.manager.send_event(&self.id, &self.work, event))
            .collect();
        if let Some(text) = text {
            sends.push(self.manager.deliver(notify, text, self.id.clone()));
        }
        match settle(sends).await {
            Ok(()) => PENDING_WORK_SERVICE.end(PendingWorkKind::Monitor, &self.id),
            Err(err) => log_error!(
                json!({ "err": err_json(&err), "monitorId": self.id }),
                "[Monitor] Could not report the end of a monitor"
            ),
        }
    }
}

static MONITOR_MANAGER: LazyLock<RwLock<Option<Arc<MonitorManager>>>> =
    LazyLock::new(|| RwLock::new(None));

pub fn get_monitor_manager() -> Arc<MonitorManager> {
    if let Some(manager) = MONITOR_MANAGER.read().as_ref() {
        return manager.clone();
    }
    MONITOR_MANAGER
        .write()
        .get_or_insert_with(|| Arc::new(MonitorManager::new()))
        .clone()
}

/// Test-only: stop every monitor and start again with `manager` (or an empty one).
pub fn set_monitor_manager_for_tests(manager: Option<Arc<MonitorManager>>) {
    let mut slot = MONITOR_MANAGER.write();
    if let Some(previous) = slot.as_ref() {
        previous.kill_all();
    }
    *slot = manager;
}

#[cfg(test)]
#[path = "monitor_manager_tests.rs"]
mod tests;
