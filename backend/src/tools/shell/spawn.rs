//! `shell_spawn` family — generic background-process control for the
//! agent. Distinct from `coding_agent` (which is its own dedicated tool
//! over a fixed CLI surface): this set lets the agent start arbitrary
//! long-running shell tasks (e.g. `npm run test`), feed them stdin,
//! drain accumulated stdout/stderr, and kill them — all without
//! blocking other tool calls.
//!
//! Port of the upstream Mirantis Agent Platform shell sandbox's process handlers,
//! with the per-process state map living in `process_manager`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::process_manager::{DrainResult, SpawnParams, get_process_manager};
use super::workspace::resolve_path;
use crate::lib::execution_environments::execution_environment::Signal;

#[derive(Debug, Clone, Deserialize)]
pub struct ShellSpawnInput {
    /// The shell command to start as a background process.
    pub command: String,
    /// Working directory (default: workspace root).
    #[serde(default)]
    pub workdir: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStdinInput {
    /// Process ID returned by shell_spawn.
    pub process_id: String,
    /// Data to write to the process's stdin (raw, no automatic newline).
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStdoutInput {
    /// Process ID returned by shell_spawn.
    pub process_id: String,
    /// If true, drain stderr instead of stdout (default: false).
    #[serde(default)]
    pub drain_stderr: Option<bool>,
}

/// The signals `shell_kill` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum KillSignal {
    #[serde(rename = "SIGTERM")]
    Sigterm,
    #[serde(rename = "SIGKILL")]
    Sigkill,
    #[serde(rename = "SIGINT")]
    Sigint,
    #[serde(rename = "SIGHUP")]
    Sighup,
}

impl KillSignal {
    pub fn signal(self) -> Signal {
        match self {
            KillSignal::Sigterm => Signal::SIGTERM,
            KillSignal::Sigkill => Signal::SIGKILL,
            KillSignal::Sigint => Signal::SIGINT,
            KillSignal::Sighup => Signal::SIGHUP,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellKillInput {
    /// Process ID returned by shell_spawn.
    pub process_id: String,
    /// Signal to send (default: SIGTERM).
    #[serde(default)]
    pub signal: Option<KillSignal>,
}

const PROCESS_ID_DESCRIPTION: &str = "Process ID returned by shell_spawn";

pub fn shell_spawn_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to start as a background process"
            },
            "workdir": {
                "description": "Working directory (default: workspace root). Relative paths resolve from the workspace root; absolute paths are used as-is.",
                "type": "string"
            }
        },
        "required": ["command"],
        "additionalProperties": false
    })
}

pub fn shell_stdin_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "processId": { "type": "string", "description": PROCESS_ID_DESCRIPTION },
            "data": {
                "type": "string",
                "description": "Data to write to the process's stdin (raw, no automatic newline)"
            }
        },
        "required": ["processId", "data"],
        "additionalProperties": false
    })
}

pub fn shell_stdout_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "processId": { "type": "string", "description": PROCESS_ID_DESCRIPTION },
            "drainStderr": {
                "description": "If true, drain stderr instead of stdout (default: false). Call once per stream.",
                "type": "boolean"
            }
        },
        "required": ["processId"],
        "additionalProperties": false
    })
}

pub fn shell_kill_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "processId": { "type": "string", "description": PROCESS_ID_DESCRIPTION },
            "signal": {
                "description": "Signal to send (default: SIGTERM).",
                "type": "string",
                "enum": ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]
            }
        },
        "required": ["processId"],
        "additionalProperties": false
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpawnResult {
    pub process_id: String,
}

/// `{ ok: true }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ShellStdinResult {
    Ok { ok: bool },
    Error { error: String },
}

/// The drained output, or `{ error }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum ShellStdoutResult {
    Drained(DrainResult),
    Error { error: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShellKillResult {
    pub ok: bool,
}

/// Fails with the process manager's refusal when too many processes run.
pub async fn run_shell_spawn(
    input: ShellSpawnInput,
    workspace: &str,
) -> anyhow::Result<ShellSpawnResult> {
    let cwd = match input.workdir.as_deref().filter(|dir| !dir.is_empty()) {
        Some(workdir) => resolve_path(workspace, workdir),
        None => workspace.to_string(),
    };
    let process_id = get_process_manager().spawn(SpawnParams {
        command: input.command,
        workdir: cwd,
        env: None,
    })?;
    Ok(ShellSpawnResult { process_id })
}

pub async fn run_shell_stdin(input: ShellStdinInput) -> ShellStdinResult {
    match get_process_manager()
        .stdin(&input.process_id, &input.data)
        .await
    {
        Ok(()) => ShellStdinResult::Ok { ok: true },
        Err(err) => ShellStdinResult::Error {
            error: err.to_string(),
        },
    }
}

pub async fn run_shell_stdout(input: ShellStdoutInput) -> ShellStdoutResult {
    match get_process_manager().drain(&input.process_id, input.drain_stderr.unwrap_or(false)) {
        Ok(drained) => ShellStdoutResult::Drained(drained),
        Err(err) => ShellStdoutResult::Error {
            error: err.to_string(),
        },
    }
}

/// Don't reap on kill — the signal is async and the process may
/// ignore SIGTERM. The map entry is kept so:
///   - `running_count()` still sees it (MAX_PROCESSES isn't bypassed),
///   - the agent can still drain final output,
///   - the agent can re-call shell_kill with SIGKILL if needed.
///
/// The natural lifecycle (the end handler in `process_manager` sets
/// the exit code) takes the process out of the running count once it
/// actually exits; the entry is purged on the next drain after exit.
pub async fn run_shell_kill(input: ShellKillInput) -> ShellKillResult {
    let ok = get_process_manager().kill(&input.process_id, input.signal.map(KillSignal::signal));
    ShellKillResult { ok }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declares_the_schemas_the_typescript_runtime_sends() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tool-schemas.json"
        )))
        .unwrap();
        let tools = fixture["shell"].as_array().unwrap();
        for (name, schema) in [
            ("shell_spawn", shell_spawn_input_schema()),
            ("shell_stdin", shell_stdin_input_schema()),
            ("shell_stdout", shell_stdout_input_schema()),
            ("shell_kill", shell_kill_input_schema()),
        ] {
            let expected = &tools.iter().find(|tool| tool["name"] == name).unwrap()["inputSchema"];
            assert_eq!(
                serde_json::to_string(&schema).unwrap(),
                serde_json::to_string(expected).unwrap(),
                "{name}"
            );
        }
    }

    #[test]
    fn writes_each_result_as_the_typescript_runtime_does() {
        assert_eq!(
            serde_json::to_string(&ShellStdinResult::Ok { ok: true }).unwrap(),
            r#"{"ok":true}"#
        );
        let drained = ShellStdoutResult::Drained(DrainResult {
            stdout: "a".into(),
            stderr: String::new(),
            exit_code: None,
            signal: None,
            running: true,
            truncated: super::super::process_manager::Truncated {
                stdout: false,
                stderr: false,
            },
        });
        assert_eq!(
            serde_json::to_string(&drained).unwrap(),
            r#"{"stdout":"a","stderr":"","exitCode":null,"signal":null,"running":true,"truncated":{"stdout":false,"stderr":false}}"#
        );
        assert_eq!(
            serde_json::to_string(&ShellSpawnResult {
                process_id: "p".into()
            })
            .unwrap(),
            r#"{"processId":"p"}"#
        );
    }
}
