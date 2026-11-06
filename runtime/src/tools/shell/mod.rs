//! Shell tools.

// @generated-modules-start
pub mod agent_task_manager;
pub mod coding_agent;
pub mod config;
pub mod edit;
pub mod exec;
pub mod files;
pub mod format;
pub mod process_manager;
pub mod spawn;
pub mod workspace;
// @generated-modules-end

use std::sync::Arc;

use crate::ai::ToolSet;
use crate::lib::pending_file_writes::PendingFileWrites;

pub const SHELL_EXEC_DESCRIPTION: &str = "Run a single shell command. Returns { stdout, stderr, exitCode }. Each stream is capped; pass `limit` to read more. Truncated output ends with \"... (truncated; exceeded N bytes)\". Credentials and config files for any integrations connected to this project are injected into your sandbox automatically. When a user asks you to interact with external resources, run the appropriate CLI with this tool — don't refuse based on assumed lack of access. If the CLI isn't on `$PATH`, try installing it via `mise install <tool>@latest` and then re-run. If an integration isn't wired up for a task, the CLI will return a clear error you can relay back. For multi-step workflows or interactive tasks use coding_agent instead.";
pub const SHELL_READ_FILE_DESCRIPTION: &str =
    "Read a file. Output is line-numbered. Use offset/limit to read specific sections.";
pub const SHELL_WRITE_FILE_DESCRIPTION: &str = "Write a file. Overwrites existing files. Use shell_edit_file for modifying existing files; only use this for new files or full rewrites.";
pub const SHELL_EDIT_FILE_DESCRIPTION: &str = "Perform exact string replacement in a file. Read the file with shell_read_file first. Fails if old_string is not found, or matches multiple times without replace_all. Falls back to whitespace-tolerant matching if the exact match fails; replace_all needs an exact match.";
/// The literal parts of the `coding_agent` description, around: `availableAgents`, `config.codingAgent`.
pub const CODING_AGENT_DESCRIPTION_PARTS: [&str; 3] = [
    "Start an autonomous sub-agent with its own shell, file access, web access where the sandbox allows it, and an agentic loop. Use it for any task of many dependent steps, not only for code. For example: research a topic on the internet, or across files, logs, documents and data; analyze command output, test results, metrics or a database, and investigate an incident; create reports, summaries, comparisons and HTML overviews; produce diagrams (Mermaid, Graphviz, SVG), charts, slides, spreadsheets and web pages; draft or review a document, a ticket, a specification or a plan; process, convert or transform files; write, debug, build and test code. When a Task subagent's description matches the work, use Task instead.\n\nPrefer it over a long chain of hand-run shell calls, because the sub-agent keeps those steps in its own context. A task runs for minutes and you poll it for the result, so for a single command or a short, fixed sequence, use the shell tools directly. When the result is a file for the user, have the sub-agent write it to the workspace, then share it with share_file if you have that tool.\n\nmode=\"edit\" (the default) can create and change files. mode=\"plan\" tells the sub-agent to analyze and report without changing anything: use it to analyze or research files, logs and data. For a self-contained deliverable, such as a report, a diagram or a converted file, one mode=\"edit\" call is enough. For a change to existing work, plan, then edit: call once with mode=\"plan\", then call again with mode=\"edit\" and the sessionId from the plan response. If a plan comes back with open questions, settle them (ask the user if you cannot) and resume the same session in mode=\"plan\" with your answers in the prompt. Switch to edit only when no open questions remain. To continue earlier work, resume its sessionId instead of starting cold.\n\nAvailable agent values: ",
    ". Default agent: ",
    "; pass agent to override it, and use the same agent when you resume a session. Returns { taskId, agent } immediately; poll with coding_agent_status, or stop with coding_agent_stop. Choose model and effort for each task: their fields say what each tier is for, and an omitted value keeps the deployment default. Max 3 concurrent tasks.",
];
pub const CODING_AGENT_STATUS_DESCRIPTION: &str = "Poll a running coding_agent task. Returns { agent, output, completed, result, turns, stopReason, sessionId, refusals } — output is drained on read, so subsequent calls return only new output. When completed is true, result/turns/stopReason/sessionId are populated. refusals lists each action the sub-agent's permission checks refused; a task that otherwise finished then has stopReason \"refused\".";
pub const CODING_AGENT_STOP_DESCRIPTION: &str = "Terminate a running coding_agent task. Use when it is heading the wrong way, looping, stuck, or no longer needed, rather than waiting out its turn budget. Returns the same shape as coding_agent_status: any output produced before termination, completed:true, and stopReason:\"stopped\". sessionId comes back whenever the sub-agent got far enough to report one — pass it to coding_agent({ prompt, agent, sessionId }) to resume the abandoned work with its context instead of starting over. The taskId is invalid afterwards and its concurrency slot is freed immediately.";
pub const SHELL_SPAWN_DESCRIPTION: &str = "Start a long-running shell command as a background process. Returns { processId } immediately. Use for builds, watchers, test loops, anything that takes more than a few seconds or that you want to interact with via stdin. Use shell_stdout to drain output and check status; shell_stdin to feed input; shell_kill to terminate. Max 10 concurrent processes. For one-shot commands use shell_exec instead.";
pub const SHELL_STDIN_DESCRIPTION: &str =
    "Write data to a running process's stdin. Returns { ok: true } or { error }.";
pub const SHELL_STDOUT_DESCRIPTION: &str = "Drain accumulated output from a running process. Returns { stdout, stderr, exitCode, signal, running, truncated }. Output is drained-on-read — subsequent calls return only new bytes. exitCode is null while running.";
pub const SHELL_KILL_DESCRIPTION: &str = "Send a signal to a running process. Default SIGTERM; pass SIGKILL for force-kill, SIGINT for Ctrl-C semantics, SIGHUP for hangup. Returns { ok: true } if the signal was delivered to a running process, { ok: false } if the process was already gone.";

/// The `coding_agent` description. Names the available agents and the default
/// one, so the model knows what it is delegating to. Fixed per process once the
/// boot probe settles, so the description is byte-identical every turn.
///
/// `available_agents` is the available agents joined by `, `, or `none detected`.
pub fn coding_agent_description(available_agents: &str, default_agent: &str) -> String {
    let [head, middle, tail] = CODING_AGENT_DESCRIPTION_PARTS;
    [head, available_agents, middle, default_agent, tail].concat()
}

/// Build the shell tool set. `workspace_root` is the per-thread workspace (e.g.
/// persisted from the CLI's launch cwd); it's resolved once here via
/// `resolve_workspace` — the single owner of the per-thread-vs-global fallback —
/// and the concrete path is handed to every tool's handler.
///
/// `pending_writes` lets a reader in the same step wait for a write to the file it
/// is about to read — see `lib::pending_file_writes`. The two file tools register
/// their path; `shell_exec` registers none, since it can write any file. So a
/// `share_file` in the same step as any `shell_exec` waits for that command, and
/// one that runs past `PENDING_WRITE_TIMEOUT_MS` gets the share refused. A call the
/// tool risk gate blocks never reaches `execute`, so it holds its sibling shares
/// for that whole timeout. `coding_agent` and `shell_spawn` write after their call
/// returns, so no reader in the step can wait for them. Optional, because a caller
/// that passes none (the meeting tool bridge, tests) must keep today's behaviour.
///
/// A tracked tool announces its write when its input is available (to the
/// resolved path, or to any file) and settles it once the write returns,
/// including when it returns an error, so a failed write never strands a reader.
/// `shell_exec` forwards the turn's cancellation, so a canceled turn kills the
/// command instead of leaving it to its own timeout.
///
/// Tools, in order: shell_exec, shell_read_file, shell_write_file,
/// shell_edit_file, coding_agent, coding_agent_status, coding_agent_stop,
/// shell_spawn, shell_stdin, shell_stdout, shell_kill.
pub fn get_shell_tools(
    workspace_root: Option<&str>,
    pending_writes: Option<Arc<dyn PendingFileWrites>>,
) -> ToolSet {
    todo!()
}
