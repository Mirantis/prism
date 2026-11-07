//! Scheduled Task Routes
//!
//! The agent's scheduled tasks, for the Web UI and the terminal UI. Each write
//! persists the row first, then brings the in-process scheduler in line with it.
//!
//!   GET    /agents/cron-tasks             - List cron tasks
//!   POST   /agents/cron-tasks             - Create + register
//!   PATCH  /agents/cron-tasks/{taskId}    - Edit + re-register
//!   DELETE /agents/cron-tasks/{taskId}    - Unschedule + delete

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{get, patch};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};

use crate::db::models::{CronTask, NewCronTask};
use crate::db::schema::cron_tasks;
use crate::log_error;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::cron_schedule::{ScheduleOptions, parse_schedule, validate_cron};
use crate::services::cron_scheduler_service::{
    CRON_SCHEDULER_SERVICE, CronTaskChanges, CronTaskEdit, CurrentTaskDelivery,
    ScheduleTaskOptions, TaskDeliveryChanges, UpdateTaskOptions, read_task_delivery,
    to_backend_cron_task,
};
use crate::services::delivery_target_service::parse_comma_list;
use crate::support::http::{JsonBody, error_json, json};

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
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CronTaskBody {
    pub name: Option<Option<Value>>,
    pub schedule: Option<Option<Value>>,
    pub instruction: Option<Option<Value>>,
    /// A `DELIVER_TARGETS` value.
    pub deliver_to: Option<Option<Value>>,
    /// The linked channels of the target's channel to post to; `null` clears them.
    pub channel_ids: Option<Option<Value>>,
}

impl CronTaskBody {
    /// The fields of a request body as `body[field]` reads them: a body that is not
    /// an object has none.
    pub fn from_body(body: &JsonBody) -> Self {
        let read = |key: &str| {
            body.field(key).map(|value| match value {
                Value::Null => None,
                value => Some(value.clone()),
            })
        };
        CronTaskBody {
            name: read("name"),
            schedule: read("schedule"),
            instruction: read("instruction"),
            deliver_to: read("deliverTo"),
            channel_ids: read("channelIds"),
        }
    }
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
    let recurring = validate_cron(&task.schedule);
    ListedCronTask {
        id: task.id.clone(),
        agent_id: task.agent_id.clone(),
        user_id: task.user_id.clone(),
        name: task.name.clone(),
        schedule: task.schedule.clone(),
        instruction: task.instruction.clone(),
        is_active: task.is_active,
        last_run_at: task.last_run_at,
        next_run_at: if recurring {
            CRON_SCHEDULER_SERVICE.next_run_for(&task.id)
        } else {
            task.next_run_at
        },
        thread_id: task.thread_id.clone(),
        origin_channel: task.origin_channel.clone(),
        origin_channel_id: task.origin_channel_id.clone(),
        deliver_to: task.deliver_to.clone(),
        channel_ids: parse_comma_list(task.channel_ids.as_deref()),
        created_at: task.created_at,
        updated_at: task.updated_at,
        recurring,
    }
}

/// A refused field: `{ error, fieldErrors: { <field>: error } }`, answered 400.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldErrorBody {
    pub error: String,
    pub field_errors: IndexMap<String, String>,
}

fn reject_field(field: &str, error: &str) -> Response {
    let mut field_errors = IndexMap::new();
    field_errors.insert(field.to_string(), error.to_string());
    json(
        400,
        FieldErrorBody {
            error: error.to_string(),
            field_errors,
        },
    )
}

/// The body of a successful delete.
#[derive(Debug, Clone, Serialize)]
pub struct DeleteResponse {
    /// Always `true`.
    pub success: bool,
}

/// GET /agents/cron-tasks
///
/// List cron tasks for an agent: every row, newest `createdAt` first.
async fn list_tasks() -> Response {
    let tasks = crate::db::run(|conn| {
        Ok(cron_tasks::table
            .order(cron_tasks::created_at.desc())
            .select(CronTask::as_select())
            .load::<CronTask>(conn)?)
    })
    .await;
    match tasks {
        Ok(tasks) => json(200, tasks.iter().map(to_listed_task).collect::<Vec<_>>()),
        Err(err) => {
            let msg = err.to_string();
            log_error!("[CronTasks] Failed to list cron tasks for agent: {}", msg);
            error_json(500, msg)
        }
    }
}

/// `typeof value === 'string' ? value.trim() : ''`.
fn text(value: &Option<Option<Value>>) -> String {
    match value {
        Some(Some(Value::String(text))) => crate::support::js::trim(text).to_string(),
        _ => String::new(),
    }
}

/// POST /agents/cron-tasks
///
/// Create + register a cron task. Mirrors the agent's own `schedule_task` tool:
/// persists the row first, then registers it in memory via the scheduler service.
/// Body: `{ name, schedule, instruction, deliverTo?, channelIds? }`.
async fn create_task(body: JsonBody) -> Response {
    match create(body).await {
        Ok(response) => response,
        Err(err) => {
            let msg = err.to_string();
            log_error!("[CronTasks] Failed to create cron task for agent: {}", msg);
            error_json(500, msg)
        }
    }
}

async fn create(body: JsonBody) -> anyhow::Result<Response> {
    // Express reads `req.body.name` with no fallback for a request without a body.
    if body.0.is_none() {
        anyhow::bail!("Cannot read properties of undefined (reading 'name')");
    }
    let fields = CronTaskBody::from_body(&body);
    // Trimmed before the check: a task without an instruction runs on its name, so a
    // name of only whitespace would be an empty prompt.
    let name = text(&fields.name);
    let schedule = text(&fields.schedule);
    let instruction = text(&fields.instruction);
    if name.is_empty() || schedule.is_empty() {
        return Ok(error_json(400, "Missing required fields: name, schedule"));
    }

    let delivery_fields = match read_delivery_fields(&fields) {
        Ok(delivery) => delivery,
        Err(refusal) => return Ok(reject_field(&refusal.field, &refusal.error)),
    };

    let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
    let delivery = read_task_delivery(
        &TaskDeliveryChanges {
            deliver_to: delivery_fields.deliver_to,
            channel_ids: delivery_fields.channel_ids,
        },
        &agent.id,
        &CurrentTaskDelivery {
            deliver_to: "all".to_string(),
            channel_ids: None,
            thread_id: None,
        },
    )
    .await?;
    let delivery = match delivery {
        Ok(delivery) => delivery,
        Err(refusal) => return Ok(reject_field(refusal.field.as_str(), &refusal.error)),
    };

    let parsed = parse_schedule(
        &schedule,
        ScheduleOptions {
            timezone: Some(CRON_SCHEDULER_SERVICE.timezone()),
            now: None,
        },
    )?;
    if !parsed.is_one_shot && !validate_cron(&parsed.cron_expression) {
        return Ok(reject_field(
            "schedule",
            &format!("Invalid cron expression: {}", parsed.cron_expression),
        ));
    }

    let mut row = NewCronTask::new(
        agent.id.clone(),
        agent.user_id.clone(),
        name,
        parsed.cron_expression.clone(),
        instruction,
    );
    row.next_run_at = parsed.next_run_at;
    row.deliver_to = delivery.deliver_to;
    row.channel_ids = delivery.channel_ids;
    let task = crate::db::run(move |conn| {
        Ok(diesel::insert_into(cron_tasks::table)
            .values(&row)
            .returning(CronTask::as_returning())
            .get_result::<CronTask>(conn)?)
    })
    .await?;

    CRON_SCHEDULER_SERVICE
        .schedule_task(to_backend_cron_task(&task), ScheduleTaskOptions::default());

    Ok(json(201, to_listed_task(&task)))
}

/// PATCH /agents/cron-tasks/{taskId}
///
/// Edit a task and re-register it. A field the body leaves out keeps its value, and
/// a schedule the body gives is read again from now.
/// Body: `{ name?, schedule?, instruction?, deliverTo?, channelIds? }`, at least one
/// of them.
async fn update_task(Path(task_id): Path<String>, body: JsonBody) -> Response {
    match update(&task_id, body).await {
        Ok(response) => response,
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[CronTasks] Failed to update cron task {}: {}",
                task_id,
                msg
            );
            error_json(500, msg)
        }
    }
}

async fn update(task_id: &str, body: JsonBody) -> anyhow::Result<Response> {
    let fields = CronTaskBody::from_body(&body);
    let mut changes = CronTaskChanges::default();
    let mut changed = false;
    for (field, value) in [
        ("name", &fields.name),
        ("schedule", &fields.schedule),
        ("instruction", &fields.instruction),
    ] {
        let Some(value) = value else {
            continue;
        };
        let Some(Value::String(text)) = value else {
            return Ok(reject_field(field, &format!("{field} must be a string")));
        };
        match field {
            "name" => changes.name = Some(text.clone()),
            "schedule" => changes.schedule = Some(text.clone()),
            _ => changes.instruction = Some(text.clone()),
        }
        changed = true;
    }
    let delivery = match read_delivery_fields(&fields) {
        Ok(delivery) => delivery,
        Err(refusal) => return Ok(reject_field(&refusal.field, &refusal.error)),
    };
    if delivery.deliver_to.is_some() {
        changes.deliver_to = delivery.deliver_to;
        changed = true;
    }
    if delivery.channel_ids.is_some() {
        changes.channel_ids = delivery.channel_ids;
        changed = true;
    }
    if !changed {
        return Ok(error_json(
            400,
            "Nothing to change: send a name, a schedule, an instruction or a delivery",
        ));
    }

    let result = CRON_SCHEDULER_SERVICE
        .update_task(task_id, changes, UpdateTaskOptions::default())
        .await?;
    Ok(match result {
        CronTaskEdit::Invalid { field, error } => reject_field(field.as_str(), &error),
        CronTaskEdit::NotFound { error } => error_json(404, error),
        CronTaskEdit::Running { error } => error_json(409, error),
        CronTaskEdit::Updated { task } => json(200, to_listed_task(&task)),
    })
}

/// DELETE /agents/cron-tasks/{taskId}
///
/// Unschedule + delete a cron task.
async fn delete_task(Path(task_id): Path<String>) -> Response {
    let id = task_id.clone();
    let deleted =
        crate::db::run(move |conn| Ok(diesel::delete(cron_tasks::table.find(&id)).execute(conn)?))
            .await;
    match deleted {
        Ok(0) => error_json(404, "Cron task not found"),
        Ok(_) => {
            // After the confirmed delete so the 'cron task deleted' event (owned by
            // `unschedule_task`) never fires for nonexistent tasks.
            CRON_SCHEDULER_SERVICE.unschedule_task(&task_id, None, None);
            json(200, DeleteResponse { success: true })
        }
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[CronTasks] Failed to delete cron task {}: {}",
                task_id,
                msg
            );
            error_json(500, msg)
        }
    }
}
