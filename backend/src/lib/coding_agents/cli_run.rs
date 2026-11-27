//! Run a coding agent's CLI as one `CodingAgentRun`.
//!
//! Shared plumbing for the adapters whose agent is a command-line program: start
//! it in the execution environment, turn each stdout line into events through
//! the adapter's parser, wait for it to exit, and close the stream with a
//! `result` when the agent reported none. The contract in `coding_agent` knows
//! nothing of this; an adapter that is not a CLI builds its run another way.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;

use super::coding_agent::{
    CodingAgentEvent, CodingAgentEvents, CodingAgentRun, CodingAgentStopReason,
};
use crate::lib::execution_environments::execution_environment::{
    ExecError, ExecOutput, ExecProcess, ExecutionEnvironment, ProcessEnv, ProcessMark, RunOptions,
    Signal, StdinMode,
};
use crate::lib::execution_environments::get_execution_environment::get_execution_environment_for;
use crate::lib::log_redaction::err_json;
use crate::support::js::{len16, slice16};
use crate::{log_debug, log_error, log_warn};

/// How long a stopped process gets to honour SIGTERM before SIGKILL.
pub const STOP_GRACE_MS: u64 = 2_000;

/// How much of stderr is kept for the closing message of a run that reports nothing.
pub const STDERR_KEEP_BYTES: usize = 4096;

/// How long the closing message waits for the stderr lines already written,
/// once the process has ended and stdout has closed.
const STDERR_DRAIN_MS: u64 = 100;

/// One stdout line to events; `[]` for a line of no interest. Fails on a line
/// it cannot read, which is logged (`[AgentTask] unreadable output line`) and skipped.
pub type ParseLine = Box<dyn FnMut(&str) -> anyhow::Result<Vec<CodingAgentEvent>> + Send>;

/// Optional callback invoked when stdout closes so a parser that buffers
/// partial stream deltas can flush them before the closing result is emitted.
pub type FlushEvents = Box<dyn FnMut() -> Vec<CodingAgentEvent> + Send>;

pub struct CliRunSpec {
    pub task_id: String,
    /// Names the agent in the closing message of a run that never got to report.
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: ProcessEnv,
    pub parse_line: ParseLine,
    pub flush: Option<FlushEvents>,
}

/// Start the CLI with `stdin: Pipe`, closing stdin at once (prompts are argv
/// inputs; Codex also reads piped stdin until EOF), and pump its output into the
/// run's events.
///
/// `environment` is resolved per path when `None`
/// (`get_execution_environment_for(spec.cwd)`), so a task in a repository the
/// container cannot see runs on the host — the same rule the shell tools follow.
/// An environment has no ambient working directory of its own, so a spec that
/// names none runs at the workspace root.
pub fn run_cli(
    spec: CliRunSpec,
    environment: Option<Arc<dyn ExecutionEnvironment>>,
) -> Arc<dyn CodingAgentRun> {
    let environment =
        environment.unwrap_or_else(|| get_execution_environment_for(spec.cwd.as_deref()));
    let CliRunSpec {
        task_id,
        display_name,
        command,
        args,
        cwd,
        env,
        parse_line,
        flush,
    } = spec;
    let proc = environment.run_program(
        &command,
        &args,
        RunOptions {
            cwd: cwd.unwrap_or_else(|| environment.workspace_root()),
            env,
            stdin: StdinMode::Pipe,
        },
    );
    // Prompts are argv inputs; Codex also reads piped stdin until EOF.
    drop(proc.take_stdin());
    let (tx, rx) = mpsc::unbounded_channel();

    let pump_proc = proc.clone();
    let pump_task_id = task_id.clone();
    tokio::spawn(async move {
        // Logged here because nothing awaits the pump: the consumer reads the
        // channel, which a failed pump would otherwise leave open forever.
        if let Err(err) = pump(
            pump_proc,
            &pump_task_id,
            &display_name,
            parse_line,
            flush,
            &tx,
        )
        .await
        {
            log_error!(
                json!({ "err": err_json(&err), "taskId": pump_task_id }),
                "[AgentTask] output pump failed"
            );
        }
        // Dropping the sender closes the run's events.
    });

    Arc::new(CliRun {
        proc,
        task_id,
        events: parking_lot::Mutex::new(Some(UnboundedReceiverStream::new(rx).boxed())),
    })
}

async fn pump(
    proc: Arc<dyn ExecProcess>,
    task_id: &str,
    display_name: &str,
    mut parse_line: ParseLine,
    flush: Option<FlushEvents>,
    events: &mpsc::UnboundedSender<CodingAgentEvent>,
) -> anyhow::Result<()> {
    let stderr_chunks = Arc::new(parking_lot::Mutex::new((Vec::<String>::new(), 0usize)));
    let stderr_task = proc.take_stderr().map(|stderr| {
        let chunks = stderr_chunks.clone();
        let task_id = task_id.to_string();
        tokio::spawn(async move {
            let _ = for_each_line(stderr, |line| {
                log_debug!(
                    json!({ "taskId": task_id, "line": line }),
                    "[AgentTask] stderr"
                );
                let mut kept = chunks.lock();
                let (lines, bytes) = &mut *kept;
                if *bytes < STDERR_KEEP_BYTES {
                    let piece = slice16(&line, 0, STDERR_KEEP_BYTES - *bytes);
                    *bytes += len16(&piece) + 1;
                    lines.push(piece);
                }
            })
            .await;
        })
    });

    let mut reported = false;
    if let Some(stdout) = proc.take_stdout() {
        for_each_line(stdout, |line| {
            if line.is_empty() {
                return;
            }
            let parsed = match parse_line(&line) {
                Ok(parsed) => parsed,
                Err(err) => {
                    log_warn!(
                        json!({ "taskId": task_id, "err": err_json(&err), "line": slice16(&line, 0, 200) }),
                        "[AgentTask] unreadable output line"
                    );
                    return;
                }
            };
            for event in parsed {
                if matches!(event, CodingAgentEvent::Result { .. }) {
                    reported = true;
                }
                let _ = events.send(event);
            }
        })
        .await?;
    }
    if let Some(mut flush) = flush {
        for event in flush() {
            if matches!(event, CodingAgentEvent::Result { .. }) {
                reported = true;
            }
            let _ = events.send(event);
        }
    }

    // Wait for the process to actually exit (stdout closing doesn't always
    // mean the process is fully reaped).
    let end = proc.ended().await;
    // A launch failure — a missing binary, a workdir that doesn't exist — never
    // reaches the parser, so it is reported here and as the closing result.
    if let Some(error) = &end.error {
        log_error!(
            json!({ "err": err_json(error), "taskId": task_id }),
            "[AgentTask] child process error"
        );
    }

    if !reported {
        if let Some(task) = stderr_task {
            let _ = tokio::time::timeout(Duration::from_millis(STDERR_DRAIN_MS), task).await;
        }
        let stderr = stderr_chunks.lock().0.join("\n");
        let _ = events.send(CodingAgentEvent::Result {
            stop_reason: CodingAgentStopReason::Error,
            turns: 0,
            message: closing_message(display_name, end.error.as_ref(), end.exit_code, &stderr),
            refusals: None,
        });
    }
    Ok(())
}

/// Read `reader` line by line, as Node's readline splits it (`\n`, `\r\n` or
/// `\r`), with a last line that has no break emitted when it is not empty.
pub(crate) async fn for_each_line(
    mut reader: ExecOutput,
    mut on_line: impl FnMut(String),
) -> std::io::Result<()> {
    let mut line: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 16 * 1024];
    let mut after_cr = false;
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        for &byte in &chunk[..n] {
            if after_cr {
                after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\n' => on_line(String::from_utf8_lossy(&std::mem::take(&mut line)).into_owned()),
                b'\r' => {
                    on_line(String::from_utf8_lossy(&std::mem::take(&mut line)).into_owned());
                    after_cr = true;
                }
                _ => line.push(byte),
            }
        }
    }
    if !line.is_empty() {
        on_line(String::from_utf8_lossy(&line).into_owned());
    }
    Ok(())
}

/// A CLI process as a run.
pub struct CliRun {
    pub(crate) proc: Arc<dyn ExecProcess>,
    pub(crate) task_id: String,
    pub(crate) events: parking_lot::Mutex<Option<CodingAgentEvents>>,
}

#[async_trait]
impl CodingAgentRun for CliRun {
    fn take_events(&self) -> Option<CodingAgentEvents> {
        self.events.lock().take()
    }

    fn exited(&self) -> bool {
        self.proc.exit_code().is_some() || self.proc.signal().is_some()
    }

    fn mark(&self) -> Option<ProcessMark> {
        self.proc.mark()
    }

    /// The process starts with the run.
    async fn started(&self) {}

    fn stop(&self) {
        terminate(&self.proc, &self.task_id)
    }
}

/// A stream line's field as text: a string as it is, any other value as `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// The `result` message for a run that ended without the agent reporting one.
pub fn closing_message(
    display_name: &str,
    launch_error: Option<&ExecError>,
    exit_code: Option<i32>,
    stderr: &str,
) -> String {
    // It never ran, so "exited with code N" would be a fiction.
    if let Some(error) = launch_error {
        return format!("{display_name} failed to start: {error}");
    }
    let code = exit_code.unwrap_or(1);
    if stderr.is_empty() {
        format!("{display_name} exited with code {code} and no result")
    } else {
        format!("{display_name} exited with code {code}: {stderr}")
    }
}

/// SIGTERM, then escalate to SIGKILL if the process is still alive — the same
/// two-stage shape `shell_exec` uses for its timeout and cancel paths.
fn terminate(proc: &Arc<dyn ExecProcess>, task_id: &str) {
    if !proc.kill(Signal::SIGTERM) {
        log_warn!(
            json!({ "taskId": task_id }),
            "[AgentTask] SIGTERM was not delivered"
        );
        return;
    }
    let proc = proc.clone();
    let task_id = task_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(STOP_GRACE_MS)).await;
        if proc.exit_code().is_none() && proc.signal().is_none() && !proc.kill(Signal::SIGKILL) {
            log_warn!(
                json!({ "taskId": task_id }),
                "[AgentTask] SIGKILL was not delivered"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::coding_agents::testing::{FakeChild, FakeEnvironment, KillBehavior, env_of};

    /// Lines are the JSON of an event; `{ "skip": true }` is a line of no interest.
    fn parse(line: &str) -> anyhow::Result<Vec<CodingAgentEvent>> {
        let value: serde_json::Value = serde_json::from_str(line)?;
        if value.get("skip").is_some() {
            return Ok(vec![]);
        }
        Ok(vec![serde_json::from_value(value)?])
    }

    fn spec() -> CliRunSpec {
        CliRunSpec {
            task_id: "t1".to_string(),
            display_name: "Fake Agent".to_string(),
            command: "fake".to_string(),
            args: vec!["--go".to_string()],
            cwd: None,
            env: ProcessEnv::new(),
            parse_line: Box::new(parse),
            flush: None,
        }
    }

    fn start(child: Arc<FakeChild>) -> Arc<dyn CodingAgentRun> {
        let process = child.process();
        let environment = FakeEnvironment::with_run_program(move |_, _, _| process.clone());
        run_cli(spec(), Some(environment.arc()))
    }

    async fn collect(run: &Arc<dyn CodingAgentRun>) -> Vec<CodingAgentEvent> {
        run.take_events().unwrap().collect().await
    }

    fn result(stop_reason: CodingAgentStopReason, turns: i64, message: &str) -> CodingAgentEvent {
        CodingAgentEvent::Result {
            stop_reason,
            turns,
            message: message.to_string(),
            refusals: None,
        }
    }

    fn text(text: &str) -> CodingAgentEvent {
        CodingAgentEvent::Text {
            text: text.to_string(),
        }
    }

    // With no terminal and no input, a CLI that would ask for an approval refuses
    // the action and goes on: a delegated task never waits for an answer.
    #[tokio::test]
    async fn closes_stdin_after_passing_the_prompt_in_argv() {
        let child = FakeChild::new();
        let run = start(child.clone());
        assert!(child.stdin.is_closed());
        child.finish(Some(1));
        collect(&run).await;
    }

    #[tokio::test]
    async fn finishes_when_a_signal_exit_precedes_stdout_closing() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.exit(None, Some(Signal::SIGTERM));
        child.end_streams();
        assert_eq!(
            collect(&run).await,
            [result(
                CodingAgentStopReason::Error,
                0,
                "Fake Agent exited with code 1 and no result"
            )]
        );
    }

    #[tokio::test]
    async fn passes_the_command_args_cwd_and_env_to_the_environment() {
        let captured = Arc::new(parking_lot::Mutex::new(None));
        let sink = captured.clone();
        let environment = FakeEnvironment::with_run_program(move |command, args, options| {
            *sink.lock() = Some((command.to_string(), args.to_vec(), options));
            FakeChild::new().process()
        });
        run_cli(
            CliRunSpec {
                cwd: Some("/work".to_string()),
                env: env_of(&[("PATH", "/bin")]),
                ..spec()
            },
            Some(environment.arc()),
        );

        let (command, args, options) = captured.lock().clone().unwrap();
        assert_eq!(command, "fake");
        assert_eq!(args, ["--go"]);
        assert_eq!(options.cwd, "/work");
        assert_eq!(options.env, env_of(&[("PATH", "/bin")]));
        assert_eq!(options.stdin, StdinMode::Pipe);
    }

    #[tokio::test]
    async fn runs_at_the_workspace_root_when_the_spec_names_no_cwd() {
        let captured = Arc::new(parking_lot::Mutex::new(None));
        let sink = captured.clone();
        let environment = FakeEnvironment {
            workspace_root: "/home/node".to_string(),
            ..FakeEnvironment::with_run_program(move |_, _, options| {
                *sink.lock() = Some(options.cwd);
                FakeChild::new().process()
            })
        };
        run_cli(spec(), Some(environment.arc()));

        assert_eq!(captured.lock().clone().unwrap(), "/home/node");
    }

    #[tokio::test]
    async fn streams_parsed_events_in_order_and_closes_after_the_agent_reports() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.emit_line(r#"{"type":"text","text":"hello "}"#);
        child.emit_line(r#"{"skip":true}"#);
        child.emit_line(r#"{"type":"text","text":"world"}"#);
        child.emit_line(r#"{"type":"result","stopReason":"end_turn","turns":2,"message":"done"}"#);
        child.finish(Some(0));

        assert_eq!(
            collect(&run).await,
            [
                text("hello "),
                text("world"),
                result(CodingAgentStopReason::EndTurn, 2, "done"),
            ]
        );
    }

    #[tokio::test]
    async fn skips_a_line_the_parser_cannot_read() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.emit_line("not json at all");
        child.emit_line(r#"{"type":"text","text":"still here"}"#);
        child.emit_line(r#"{"type":"result","stopReason":"end_turn","turns":1,"message":"ok"}"#);
        child.finish(Some(0));

        let events = collect(&run).await;
        assert_eq!(events[0], text("still here"));
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn closes_with_the_exit_code_and_stderr_when_the_agent_exits_without_reporting() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.write_stderr("something went wrong\n");
        child.finish(Some(1));

        assert_eq!(
            collect(&run).await,
            [result(
                CodingAgentStopReason::Error,
                0,
                "Fake Agent exited with code 1: something went wrong"
            )]
        );
    }

    #[tokio::test]
    async fn caps_the_stderr_it_keeps_a_single_long_line_included() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.write_stderr(&format!("{}\n", "x".repeat(STDERR_KEEP_BYTES * 3)));
        child.write_stderr("tail line\n");
        child.finish(Some(1));

        let events = collect(&run).await;
        let CodingAgentEvent::Result { message, .. } = &events[0] else {
            panic!("no result");
        };
        assert!(message.len() <= STDERR_KEEP_BYTES + 64);
        assert!(!message.contains("tail line"));
    }

    #[tokio::test]
    async fn names_a_silent_exit_as_such() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.finish(Some(2));

        assert_eq!(
            collect(&run).await,
            [result(
                CodingAgentStopReason::Error,
                0,
                "Fake Agent exited with code 2 and no result"
            )]
        );
    }

    #[tokio::test]
    async fn reports_a_spawn_failure_as_the_closing_result_instead_of_crashing() {
        let child = FakeChild::new();
        let run = start(child.clone());
        child.fail("spawn fake ENOENT");

        assert_eq!(
            collect(&run).await,
            [result(
                CodingAgentStopReason::Error,
                0,
                "Fake Agent failed to start: spawn fake ENOENT"
            )]
        );
    }

    #[tokio::test]
    async fn reports_exited_once_the_child_is_gone() {
        let child = FakeChild::new();
        let run = start(child.clone());
        assert!(!run.exited());
        child.finish(Some(0));
        collect(&run).await;
        assert!(run.exited());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_sends_sigterm_and_escalates_to_sigkill_after_the_grace_period() {
        let child = FakeChild::with(KillBehavior::SigkillOnly);
        let run = start(child.clone());

        run.stop();
        assert_eq!(child.signals(), [Signal::SIGTERM]);
        assert!(!run.exited());

        tokio::time::sleep(Duration::from_millis(STOP_GRACE_MS + 1)).await;
        assert_eq!(child.signals(), [Signal::SIGTERM, Signal::SIGKILL]);
        assert!(run.exited());
    }

    #[tokio::test(start_paused = true)]
    async fn stop_does_not_escalate_on_a_child_that_honoured_sigterm() {
        let child = FakeChild::new();
        let run = start(child.clone());

        run.stop();
        tokio::time::sleep(Duration::from_millis(STOP_GRACE_MS + 1)).await;
        assert_eq!(child.signals(), [Signal::SIGTERM]);
    }
}
