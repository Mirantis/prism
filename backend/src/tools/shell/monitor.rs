//! Inputs and handlers for `monitor` / `monitor_stop`. The watch itself is the
//! monitor manager's.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::services::task_notification_service::TaskNotificationTarget;

use super::monitor_manager::{
    BATCH_MS, DEFAULT_TIMEOUT_MS, MAX_MONITORS, MAX_NOTIFICATIONS_PER_MINUTE, MAX_TIMEOUT_MS,
    MonitorParams, get_monitor_manager,
};

/// What the agent does after starting a monitor.
pub const MONITOR_NEXT: &str = "End your turn now unless you have other work. Each line the command prints arrives in this conversation as a task notification.";

pub const MONITOR_STOP_DESCRIPTION: &str = "Stop a monitor you no longer need. No notification follows. Returns { ok: true } if it was running, { ok: false } if it had already ended.";

pub fn monitor_description() -> String {
    format!(
        "Start a monitor: a shell command whose stdout lines are events. Each line it prints reaches this conversation as a task notification that starts a new turn, so you can end your turn and react when something happens. Lines printed within {BATCH_MS} ms of the first arrive as one notification. The monitor ends when the command exits (one last notification, with the exit code), when timeoutMs passes (default 5 minutes, at most 30, with one last notification: start it again if the watch is still needed), or when it prints more than {MAX_NOTIFICATIONS_PER_MINUTE} times a minute.

Use it instead of a sleep, a polling loop or a scheduled check whenever you wait for something to happen:
- One notification per occurrence: a command that runs until the deadline, such as `tail -f app.log | grep --line-buffered ERROR`.
- One notification when a condition holds: a command that exits then, such as `until curl -sf https://host/health; do sleep 5; done; echo healthy`.

Every stage of a pipe must flush each line, or the lines wait in its buffer: grep needs --line-buffered, awk needs fflush(). Match the failures as well as the success you wait for (Error|FAIL|Traceback|exited), because a monitor that stays silent looks the same as one still waiting. Only stdout is an event: add 2>&1 to see a command's errors. Poll a remote API at most every 30 seconds. Returns {{ monitorId }}; stop a monitor with monitor_stop. At most {MAX_MONITORS} run at once."
    )
}

pub fn monitor_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "Shell command. Each line it prints on stdout is an event; its exit ends the watch."
            },
            "description": {
                "type": "string",
                "description": "What is watched, in a few words. Each notification names it."
            },
            "timeoutMs": {
                "description": format!("Stop the command after this many ms (default {DEFAULT_TIMEOUT_MS})."),
                "type": "integer",
                "minimum": 1_000,
                "maximum": MAX_TIMEOUT_MS
            }
        },
        "required": ["command", "description"],
        "additionalProperties": false
    })
}

pub fn monitor_stop_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "monitorId": { "type": "string", "description": "Monitor ID returned by monitor" }
        },
        "required": ["monitorId"],
        "additionalProperties": false
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInput {
    pub command: String,
    pub description: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStopInput {
    pub monitor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStarted {
    pub monitor_id: String,
    pub next: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MonitorStopResult {
    pub ok: bool,
}

pub async fn run_monitor(
    input: MonitorInput,
    workspace: &str,
    notify: TaskNotificationTarget,
) -> anyhow::Result<MonitorStarted> {
    let monitor_id = get_monitor_manager()
        .start(MonitorParams {
            command: input.command,
            description: input.description,
            timeout_ms: input.timeout_ms,
            workdir: workspace.to_string(),
            notify,
        })
        .await?;
    Ok(MonitorStarted {
        monitor_id,
        next: MONITOR_NEXT,
    })
}

pub fn run_monitor_stop(input: MonitorStopInput) -> MonitorStopResult {
    MonitorStopResult {
        ok: get_monitor_manager().stop(&input.monitor_id),
    }
}
