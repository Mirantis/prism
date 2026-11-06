//! Scheduled Task Routes
//!
//! The agent's scheduled tasks, for the Web UI and the terminal UI. Each write
//! persists the row first, then brings the in-process scheduler in line with it.
//!
//!   GET    /agents/cron-tasks             - List cron tasks
//!   POST   /agents/cron-tasks             - Create + register
//!   PATCH  /agents/cron-tasks/{taskId}    - Edit + re-register
//!   DELETE /agents/cron-tasks/{taskId}    - Unschedule + delete

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{get, patch};
use chrono::{DateTime, Utc};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::CronTask;

pub fn router() -> Router {
    Router::new()
        .route("/agents/cron-tasks", get(list_tasks).post(create_task))
        .route(
            "/agents/cron-tasks/{taskId}",
            patch(update_task).delete(delete_task),
        )
}

/// The body of `POST /agents/cron-tasks` (`{ name, schedule, instruction,
/// deliverTo?, channelIds? }`) and of `PATCH /agents/cron-tasks/{taskId}` (the
/// same fields, each optional, at least one given).
///
/// Every field keeps the difference between a missing key (outer `None`) and an
/// explicit `null` (`Some(None)`), and takes any JSON type, because the handlers
/// check the types by hand: POST reads a non-string name, schedule or instruction
/// as empty text; PATCH answers `<field> must be a string` for a present value that
/// is not a string, `null` included.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskBody {
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub name: Option<Option<Value>>,
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub schedule: Option<Option<Value>>,
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub instruction: Option<Option<Value>>,
    /// A `DELIVER_TARGETS` value.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub deliver_to: Option<Option<Value>>,
    /// The linked channels of the target's channel to post to; `null` clears them.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub channel_ids: Option<Option<Value>>,
}

/// The delivery fields of a request body, typed. `None` leaves the field as it is;
/// `channel_ids: Some(None)` is an explicit `null`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeliveryFields {
    pub deliver_to: Option<String>,
    pub channel_ids: Option<Option<Vec<String>>>,
}

/// A refused field: its wire name and the text the 400 answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldRefusal {
    pub field: String,
    pub error: String,
}

/// The delivery fields of a request body, or the name of the field that has the
/// wrong type. `read_task_delivery` checks the values; this types the body, and
/// refuses a wrong type before the task's row is read and locked.
pub fn read_delivery_fields(body: &CronTaskBody) -> Result<DeliveryFields, FieldRefusal> {
    let deliver_to = match &body.deliver_to {
        None => None,
        Some(Some(Value::String(text))) => Some(text.clone()),
        Some(_) => {
            return Err(FieldRefusal {
                field: "deliverTo".to_string(),
                error: "deliverTo must be a string".to_string(),
            });
        }
    };
    let channel_ids = match &body.channel_ids {
        None => None,
        Some(None) => Some(None),
        Some(Some(Value::Array(items))) if items.iter().all(Value::is_string) => Some(Some(
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
        )),
        Some(Some(_)) => {
            return Err(FieldRefusal {
                field: "channelIds".to_string(),
                error: "The channel list must be an array of channel ids".to_string(),
            });
        }
    };
    Ok(DeliveryFields {
        deliver_to,
        channel_ids,
    })
}

/// A task as the list shows it: the stored row, with `nextRunAt` and `channelIds`
/// replaced in place and `recurring` added last. A recurring task's running job
/// knows its next run; the stored one is what the boot reads. A one-shot's
/// schedule is the wording it was asked in, which a cron parser does not read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCronTask {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub name: String,
    pub schedule: String,
    pub instruction: String,
    pub is_active: bool,
    #[serde(with = "crate::support::serde_iso::option")]
    pub last_run_at: Option<DateTime<Utc>>,
    /// The running job's next run (`CRON_SCHEDULER_SERVICE.next_run_for`) for a
    /// recurring task, else the stored one.
    #[serde(with = "crate::support::serde_iso::option")]
    pub next_run_at: Option<DateTime<Utc>>,
    pub thread_id: Option<String>,
    pub origin_channel: Option<String>,
    pub origin_channel_id: Option<String>,
    pub deliver_to: String,
    /// `parse_comma_list` of the stored text: `[]` when none.
    pub channel_ids: Vec<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
    /// Whether the stored schedule is a valid cron expression.
    pub recurring: bool,
}

/// A task as the list shows it.
pub fn to_listed_task(task: &CronTask) -> ListedCronTask {
    todo!()
}

/// `{ error }`, the body of a refusal and a failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// A refused field: `{ error, fieldErrors: { <field>: error } }`, answered 400.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldErrorBody {
    pub error: String,
    pub field_errors: IndexMap<String, String>,
}

/// The body of a successful delete.
#[derive(Debug, Clone, Serialize)]
pub struct DeleteResponse {
    /// Always `true`.
    pub success: bool,
}

/// GET /agents/cron-tasks
///
/// List cron tasks for an agent: every row, newest `createdAt` first, as
/// `ListedCronTask`. A failure logs `[CronTasks] Failed to list cron tasks for
/// agent: <message>` and answers 500 with the message.
async fn list_tasks() -> Response {
    todo!()
}

/// POST /agents/cron-tasks
///
/// Create + register a cron task. Mirrors the agent's own `schedule_task` tool:
/// persists the row first, then registers it in memory via the scheduler service.
/// Body: `{ name, schedule, instruction, deliverTo?, channelIds? }`.
///
/// Name, schedule and instruction are trimmed before the check: a task without an
/// instruction runs on its name, so a name of only whitespace would be an empty
/// prompt. In order: an empty name or schedule answers 400
/// `Missing required fields: name, schedule`; a wrong delivery type, a delivery
/// `read_task_delivery` refuses (current `{ deliverTo: 'all', channelIds: null,
/// threadId: null }`) and a recurring schedule that is not a valid cron expression
/// (`Invalid cron expression: <expr>`, field `schedule`) answer 400 with
/// `fieldErrors`. The schedule is read with `parse_schedule` in the scheduler's time
/// zone. The created row is registered with `schedule_task(to_backend_cron_task(row))`
/// and answered 201 as a `ListedCronTask`. A failure logs
/// `[CronTasks] Failed to create cron task for agent: <message>` and answers 500.
///
/// Express reads `req.body.name` without a fallback, so a request with no JSON body
/// answers 500 there (`Cannot read properties of undefined (reading 'name')`).
async fn create_task(Json(body): Json<CronTaskBody>) -> Response {
    todo!()
}

/// PATCH /agents/cron-tasks/{taskId}
///
/// Edit a task and re-register it. A field the body leaves out keeps its value, and
/// a schedule the body gives is read again from now.
/// Body: `{ name?, schedule?, instruction?, deliverTo?, channelIds? }`, at least one
/// of them.
///
/// A present name, schedule or instruction that is not a string answers 400
/// `<field> must be a string` with `fieldErrors`; so does a wrong delivery type. No
/// change answers 400 `Nothing to change: send a name, a schedule, an instruction or
/// a delivery`. `CRON_SCHEDULER_SERVICE.update_task` then answers: `invalid` 400
/// with `fieldErrors`, `not_found` 404, `running` 409, `updated` 200 with the
/// `ListedCronTask`. A failure logs `[CronTasks] Failed to update cron task
/// <taskId>: <message>` and answers 500.
async fn update_task(Path(task_id): Path<String>, Json(body): Json<CronTaskBody>) -> Response {
    todo!()
}

/// DELETE /agents/cron-tasks/{taskId}
///
/// Unschedule + delete a cron task. A missing row answers 404
/// `Cron task not found`. The unschedule comes after the confirmed delete so the
/// `cron task deleted` event (owned by `unschedule_task`) never fires for a task
/// that does not exist. Answers `{ success: true }`. A failure logs
/// `[CronTasks] Failed to delete cron task <taskId>: <message>` and answers 500.
async fn delete_task(Path(task_id): Path<String>) -> Response {
    todo!()
}
