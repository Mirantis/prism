//! Cron tools.
//!
//! Owns database CRUD directly and schedules/unschedules via the in-process
//! `CRON_SCHEDULER_SERVICE`.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;
use crate::services::channel_adapter_interface::ChannelName;

pub const SCHEDULE_TASK_DESCRIPTION: &str = "Schedule a task to run at a specific time or interval. When the user asks to be reminded or alerted, set it up at once; use it also to check again later on something that is not ready yet. Set continueInThread to resume in this conversation thread instead of reporting as a scheduled task — this is how you \"wait\" for something and pick the conversation back up here.";
pub const LIST_SCHEDULED_TASKS_DESCRIPTION: &str = "List all scheduled tasks.";
pub const UPDATE_SCHEDULED_TASK_DESCRIPTION: &str = "Change the name, schedule, instruction or delivery of a scheduled task. A field you leave out keeps its value.";
pub const DELETE_SCHEDULED_TASK_DESCRIPTION: &str = "Delete a scheduled task.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTaskInput {
    /// Short name for the task.
    pub name: String,
    /// When to run: "in 30 seconds", "every hour", "at 3pm", a cron expression.
    pub schedule: String,
    /// What to do when the task runs.
    pub instruction: String,
    /// Continue in this conversation/thread when the task runs.
    #[serde(default)]
    pub continue_in_thread: Option<bool>,
    /// One of `DELIVER_TARGETS`.
    #[serde(default)]
    pub deliver_to: Option<String>,
    /// Linked channel ids of the deliverTo channel to post to.
    #[serde(default)]
    pub channel_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateScheduledTaskInput {
    /// The task ID to change.
    pub task_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub schedule: Option<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub deliver_to: Option<String>,
    #[serde(default)]
    pub channel_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteScheduledTaskInput {
    /// The task ID to delete.
    pub task_id: String,
}

pub fn schedule_task_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn list_scheduled_tasks_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn update_scheduled_task_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn delete_scheduled_task_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// A run time in the agent's time zone, with its UTC offset, such as
/// "Oct 30, 2026, 4:00 PM GMT+2" (`toLocaleString('en-US', { year: 'numeric',
/// month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
/// timeZoneName: 'shortOffset' })`).
pub fn format_run_time(date: &chrono::DateTime<chrono::Utc>) -> String {
    todo!()
}

/// schedule_task, list_scheduled_tasks, update_scheduled_task,
/// delete_scheduled_task. `mode` is the invocation mode, for the scheduler's
/// telemetry; `origin_channel` defaults to the chat socket.
pub fn get_cron_tools(
    user_id: &str,
    agent_id: &str,
    mode: &str,
    thread_id: Option<&str>,
    origin_channel: Option<ChannelName>,
    origin_channel_id: Option<&str>,
) -> ToolSet {
    todo!()
}
