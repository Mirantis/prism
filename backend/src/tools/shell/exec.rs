//! `shell_exec` tool — in-process port of the upstream Lens Agents shell
//! sandbox's `shell_exec` handler.
//!
//! Runs a single shell command in the execution environment with a timeout.
//! Captures stdout + stderr (up to MAX_EXEC_OUTPUT_BYTES each) and
//! returns them alongside the exit code. Input schema + return shape
//! are identical to upstream so the agent's tool contract doesn't
//! change between modes.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::config::{
    DEFAULT_EXEC_OUTPUT_LIMIT_BYTES, DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_OUTPUT_BYTES,
    MAX_EXEC_OUTPUT_LIMIT, MAX_EXEC_TIMEOUT_MS,
};
use super::workspace::resolve_path;
use crate::lib::execution_environments::capture::{CaptureOptions, capture_shell};
use crate::lib::execution_environments::execution_environment::Signal;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment_for;

/// The input of `shell_exec`.
#[derive(Debug, Clone, Deserialize)]
pub struct ShellExecInput {
    /// The shell command to execute.
    pub command: String,
    /// Working directory (default: workspace root). Relative paths resolve from
    /// the workspace root; absolute paths are used as-is.
    #[serde(default)]
    pub workdir: Option<String>,
    /// Timeout in milliseconds (default: 30000). Max 20 minutes.
    #[serde(default)]
    pub timeout: Option<u64>,
    /// Maximum number of bytes to capture per stream.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// The JSON Schema `shell_exec` declares, byte-identical to the TypeScript runtime's.
pub fn shell_exec_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "command": { "type": "string", "description": "The shell command to execute" },
            "workdir": {
                "description": "Working directory (default: workspace root). Relative paths resolve from the workspace root; absolute paths are used as-is.",
                "type": "string"
            },
            "timeout": {
                "description": "Timeout in milliseconds (default: 30000). Max 20 minutes.",
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_EXEC_TIMEOUT_MS
            },
            "limit": {
                "description": format!(
                    "Maximum number of bytes to capture per stream (default: {DEFAULT_EXEC_OUTPUT_LIMIT_BYTES}, max: {MAX_EXEC_OUTPUT_LIMIT})."
                ),
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_EXEC_OUTPUT_BYTES
            }
        },
        "required": ["command"],
        "additionalProperties": false
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    /// Set when the run was killed because the turn was canceled mid-command.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aborted: Option<bool>,
}

/// Core exec path — exposed separately for testing without wiring
/// through the tool surface.
///
/// Per path: a thread rooted in a repository the container cannot see runs on
/// the host instead. A launch failure is `{ stdout: "", stderr: <error>,
/// exitCode: -1 }`; truncated output ends with
/// `\n... (truncated; exceeded <limit> bytes)`.
pub async fn run_shell_exec(
    input: ShellExecInput,
    workspace: &str,
    abort_signal: Option<CancellationToken>,
) -> ExecResult {
    let cwd = match input.workdir.as_deref().filter(|dir| !dir.is_empty()) {
        Some(workdir) => resolve_path(workspace, workdir),
        None => workspace.to_string(),
    };
    // Per path: a thread rooted in a repository the container cannot see runs on
    // the host instead.
    let environment = get_execution_environment_for(Some(&cwd));
    let output_limit = input
        .limit
        .unwrap_or(DEFAULT_EXEC_OUTPUT_LIMIT_BYTES)
        .min(MAX_EXEC_OUTPUT_BYTES);

    let run = capture_shell(
        environment.as_ref(),
        &input.command,
        CaptureOptions {
            cwd,
            env: environment.base_env(),
            timeout_ms: input
                .timeout
                .unwrap_or(DEFAULT_EXEC_TIMEOUT_MS)
                .min(MAX_EXEC_TIMEOUT_MS),
            limit_bytes: output_limit,
            abort_signal,
        },
    )
    .await;

    if let Some(error) = &run.error {
        return ExecResult {
            stdout: String::new(),
            stderr: error.to_string(),
            exit_code: -1,
            timed_out: None,
            aborted: None,
        };
    }

    let marker = format!("\n... (truncated; exceeded {output_limit} bytes)");
    ExecResult {
        stdout: if run.stdout_truncated {
            format!("{}{marker}", run.stdout)
        } else {
            run.stdout
        },
        stderr: if run.stderr_truncated {
            format!("{}{marker}", run.stderr)
        } else {
            run.stderr
        },
        exit_code: exit_code_of(run.exit_code, run.signal),
        timed_out: run.timed_out.then_some(true),
        aborted: run.aborted.then_some(true),
    }
}

pub fn exit_code_of(exit_code: Option<i32>, signal: Option<Signal>) -> i32 {
    if let Some(code) = exit_code {
        return code;
    }
    match signal {
        Some(signal) => 128 + signal_number(signal),
        None => -1,
    }
}

fn signal_number(signal: Signal) -> i32 {
    match signal {
        Signal::SIGHUP => 1,
        Signal::SIGINT => 2,
        Signal::SIGQUIT => 3,
        Signal::SIGKILL => 9,
        Signal::SIGTERM => 15,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    //! The `shell_exec` handler against a real temp directory as the workspace.

    use std::time::{Duration, Instant};

    use super::*;

    fn workspace() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("shell-tools-test-")
            .tempdir()
            .unwrap();
        // Resolve symlinks (on macOS /tmp -> /private/tmp) so `pwd` inside the
        // spawned shell matches what we hand to run_shell_exec.
        let path = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, path)
    }

    fn input(command: &str) -> ShellExecInput {
        ShellExecInput {
            command: command.to_string(),
            workdir: None,
            timeout: None,
            limit: None,
        }
    }

    #[test]
    fn declares_the_schema_the_typescript_runtime_sends() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tool-schemas.json"
        )))
        .unwrap();
        let expected = fixture["shell"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "shell_exec")
            .unwrap()["inputSchema"]
            .clone();
        let schema = shell_exec_input_schema();
        assert_eq!(schema, expected);
        assert_eq!(
            serde_json::to_string(&schema).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn captures_stdout_and_exit_code_on_success() {
        let (_guard, ws) = workspace();
        let result = run_shell_exec(input("echo hello"), &ws, None).await;
        assert_eq!(result.stdout.trim(), "hello");
        assert_eq!(result.exit_code, 0);
        assert_eq!(result.timed_out, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn surfaces_non_zero_exits_with_stderr() {
        let (_guard, ws) = workspace();
        let result = run_shell_exec(input("echo oops >&2; exit 3"), &ws, None).await;
        assert_eq!(result.stderr.trim(), "oops");
        assert_eq!(result.exit_code, 3);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn runs_in_the_workspace_by_default_and_honors_a_workdir_override() {
        let (_guard, ws) = workspace();
        let sub = format!("{ws}/sub");
        std::fs::create_dir_all(&sub).unwrap();
        let default_cwd = run_shell_exec(input("pwd"), &ws, None).await;
        assert_eq!(default_cwd.stdout.trim(), ws);
        let sub_cwd = run_shell_exec(
            ShellExecInput {
                workdir: Some("sub".into()),
                ..input("pwd")
            },
            &ws,
            None,
        )
        .await;
        assert_eq!(sub_cwd.stdout.trim(), sub);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn times_out_and_sets_timed_out_when_the_command_exceeds_the_budget() {
        let (_guard, ws) = workspace();
        let result = run_shell_exec(
            ShellExecInput {
                timeout: Some(200),
                ..input("sleep 5")
            },
            &ws,
            None,
        )
        .await;
        assert_eq!(result.timed_out, Some(true));
        // SIGTERM → exit code 143 (128 + 15).
        assert_ne!(result.exit_code, 0);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn kills_the_child_and_sets_aborted_when_the_turn_is_canceled_mid_command() {
        let (_guard, ws) = workspace();
        let token = CancellationToken::new();
        let start = Instant::now();
        let cancel = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancel.cancel();
        });
        let result = run_shell_exec(input("sleep 5"), &ws, Some(token)).await;
        assert_eq!(result.aborted, Some(true));
        assert_ne!(result.exit_code, 0);
        // Killed promptly — nowhere near the 5s the command would have taken.
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn does_not_wait_for_a_command_when_the_signal_is_already_aborted() {
        let (_guard, ws) = workspace();
        let token = CancellationToken::new();
        token.cancel();
        let start = Instant::now();
        let result = run_shell_exec(input("sleep 5"), &ws, Some(token)).await;
        assert_eq!(result.aborted, Some(true));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn truncates_stdout_at_the_default_limit_and_appends_a_marker() {
        let (_guard, ws) = workspace();
        let result =
            run_shell_exec(input("head -c 20000 /dev/zero | tr '\\0' 'x'"), &ws, None).await;
        assert_eq!(result.exit_code, 0);
        assert_eq!(
            result.stdout,
            format!(
                "{}\n... (truncated; exceeded 10000 bytes)",
                "x".repeat(10_000)
            )
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn honors_a_custom_limit_and_reports_it_in_the_marker() {
        let (_guard, ws) = workspace();
        let result = run_shell_exec(
            ShellExecInput {
                limit: Some(100),
                ..input("head -c 5000 /dev/zero | tr '\\0' 'x'")
            },
            &ws,
            None,
        )
        .await;
        assert_eq!(
            result.stdout,
            format!("{}\n... (truncated; exceeded 100 bytes)", "x".repeat(100))
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn omits_the_truncation_marker_when_output_fits_under_the_limit() {
        let (_guard, ws) = workspace();
        let result = run_shell_exec(
            ShellExecInput {
                limit: Some(1000),
                ..input("echo hi")
            },
            &ws,
            None,
        )
        .await;
        assert_eq!(result.stdout, "hi\n");
        assert!(!result.stderr.contains("(truncated;"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn applies_the_limit_independently_to_stdout_and_stderr() {
        let (_guard, ws) = workspace();
        let command =
            "head -c 500 /dev/zero | tr '\\0' 'a'; head -c 500 /dev/zero | tr '\\0' 'b' >&2";
        let result = run_shell_exec(
            ShellExecInput {
                limit: Some(300),
                ..input(command)
            },
            &ws,
            None,
        )
        .await;
        assert_eq!(
            result.stdout,
            format!("{}\n... (truncated; exceeded 300 bytes)", "a".repeat(300))
        );
        assert_eq!(
            result.stderr,
            format!("{}\n... (truncated; exceeded 300 bytes)", "b".repeat(300))
        );
    }

    #[test]
    fn writes_the_result_as_the_typescript_runtime_does() {
        let result = ExecResult {
            stdout: "a".into(),
            stderr: String::new(),
            exit_code: 0,
            timed_out: None,
            aborted: None,
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"stdout":"a","stderr":"","exitCode":0}"#
        );
    }
}
