//! Cron tools.
//!
//! Owns database CRUD directly and schedules/unschedules via the in-process
//! `CRON_SCHEDULER_SERVICE`.

use chrono::{DateTime, Datelike, Offset, TimeZone, Timelike, Utc};
use diesel::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::db::models::{CronTask, NewCronTask};
use crate::db::schema::cron_tasks;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::cron_schedule::{ScheduleOptions, parse_schedule, validate_cron};
use crate::services::cron_scheduler_service::{
    CRON_SCHEDULER_SERVICE, CronTaskChanges, CronTaskEdit, CurrentTaskDelivery,
    ScheduleTaskOptions, TaskDeliveryChanges, TaskOwner, UpdateTaskOptions, read_task_delivery,
    to_backend_cron_task,
};
use crate::services::delivery_target_service::{DELIVER_TARGETS, parse_comma_list};
use crate::support::iso;

pub const SCHEDULE_TASK_DESCRIPTION: &str = "Schedule a task to run at a specific time or interval. When the user asks to be reminded or alerted, set it up at once; use it also to check again later on something that is not ready yet. Set continueInThread to resume in this conversation thread instead of reporting as a scheduled task — this is how you \"wait\" for something and pick the conversation back up here.";
pub const LIST_SCHEDULED_TASKS_DESCRIPTION: &str = "List all scheduled tasks.";
pub const UPDATE_SCHEDULED_TASK_DESCRIPTION: &str = "Change the name, schedule, instruction or delivery of a scheduled task. A field you leave out keeps its value.";
pub const DELETE_SCHEDULED_TASK_DESCRIPTION: &str = "Delete a scheduled task.";

const DELIVER_TO_DESCRIPTION: &str = "Where the result goes: \"all\" (every connected channel), \"chat\" (web chat only), a channel name (its direct conversation, else its main channel), or \"none\" (run without posting). Default \"all\". A task that continues in the thread replies there.";
const CHANNEL_IDS_DESCRIPTION: &str =
    "Linked channel ids of the deliverTo channel to post to, instead of its default destination";
const SCHEDULE_DESCRIPTION: &str =
    "When to run: \"in 30 seconds\", \"in 2 minutes\", \"every hour\", \"at 3pm\", cron expression";

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

fn deliver_to_param() -> Value {
    json!({
        "type": "string",
        "enum": *DELIVER_TARGETS,
        "description": DELIVER_TO_DESCRIPTION
    })
}

fn channel_ids_param() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "string"
        },
        "description": CHANNEL_IDS_DESCRIPTION
    })
}

pub fn schedule_task_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Short name for the task"
            },
            "schedule": {
                "type": "string",
                "description": SCHEDULE_DESCRIPTION
            },
            "instruction": {
                "type": "string",
                "description": "What to do when the task runs"
            },
            "continueInThread": {
                "description": "Continue in this conversation/thread when the task runs, instead of reporting as a scheduled task in the latest conversation. Use this to \"wait\" and resume the conversation here. Only valid for one-off schedules like \"in 10 minutes\".",
                "type": "boolean"
            },
            "deliverTo": deliver_to_param(),
            "channelIds": channel_ids_param()
        },
        "required": ["name", "schedule", "instruction"],
        "additionalProperties": false
    })
}

pub fn list_scheduled_tasks_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

pub fn update_scheduled_task_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "taskId": {
                "type": "string",
                "description": "The task ID to change"
            },
            "name": {
                "description": "New short name for the task",
                "type": "string"
            },
            "schedule": {
                "description": "New time to run: \"in 30 seconds\", \"in 2 minutes\", \"every hour\", \"at 3pm\", cron expression",
                "type": "string"
            },
            "instruction": {
                "description": "New instruction: what to do when the task runs",
                "type": "string"
            },
            "deliverTo": deliver_to_param(),
            "channelIds": channel_ids_param()
        },
        "required": ["taskId"],
        "additionalProperties": false
    })
}

pub fn delete_scheduled_task_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "taskId": {
                "type": "string",
                "description": "The task ID to delete"
            }
        },
        "required": ["taskId"],
        "additionalProperties": false
    })
}

const SHORT_MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `date` in `zone` as `toLocaleString('en-US', …)` writes it with the options of
/// [`format_run_time`]. Fails as `toLocaleString` fails on a name that is not a zone.
fn format_run_time_in(date: &DateTime<Utc>, zone: &str) -> anyhow::Result<String> {
    let tz: chrono_tz::Tz = zone
        .parse()
        .map_err(|_| anyhow::anyhow!("Invalid time zone specified: {zone}"))?;
    let local = tz.from_utc_datetime(&date.naive_utc());
    let offset_minutes = local.offset().fix().local_minus_utc() / 60;
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let (hours, minutes) = (offset_minutes.abs() / 60, offset_minutes.abs() % 60);
    let offset = if minutes == 0 {
        format!("GMT{sign}{hours}")
    } else {
        format!("GMT{sign}{hours}:{minutes:02}")
    };
    let hour12 = match local.hour() % 12 {
        0 => 12,
        hour => hour,
    };
    let meridiem = if local.hour() < 12 { "AM" } else { "PM" };
    Ok(format!(
        "{} {}, {}, {}:{:02} {} {}",
        SHORT_MONTHS[local.month0() as usize],
        local.day(),
        local.year(),
        hour12,
        local.minute(),
        meridiem,
        offset
    ))
}

/// A run time in the agent's time zone, with its UTC offset, such as
/// "Oct 30, 2026, 4:00 PM GMT+2" (`toLocaleString('en-US', { year: 'numeric',
/// month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
/// timeZoneName: 'shortOffset' })`).
pub fn format_run_time(date: &chrono::DateTime<chrono::Utc>) -> anyhow::Result<String> {
    format_run_time_in(date, &CRON_SCHEDULER_SERVICE.timezone())
}

/// `to run at <time>` for a task with a next run, else `with schedule: <schedule>`.
fn when_text(task: &CronTask) -> anyhow::Result<String> {
    Ok(match &task.next_run_at {
        Some(next) => format!("to run at {}", format_run_time(next)?),
        None => format!("with schedule: {}", task.schedule),
    })
}

/// The bound identity and origin of a run the tools act for.
#[derive(Clone)]
struct CronToolContext {
    user_id: String,
    agent_id: String,
    mode: String,
    thread_id: Option<String>,
    origin_channel: ChannelName,
    origin_channel_id: Option<String>,
}

async fn run_schedule_task(ctx: CronToolContext, input: Value) -> anyhow::Result<Value> {
    let ScheduleTaskInput {
        name,
        schedule,
        instruction,
        continue_in_thread,
        deliver_to,
        channel_ids,
    } = serde_json::from_value(input)?;
    let parsed = parse_schedule(
        &schedule,
        ScheduleOptions {
            timezone: Some(CRON_SCHEDULER_SERVICE.timezone()),
            now: None,
        },
    )?;

    if !parsed.is_one_shot && !validate_cron(&parsed.cron_expression) {
        anyhow::bail!("Invalid cron expression: {}", parsed.cron_expression);
    }

    // Thread continuation is only meaningful for a one-off "wait then resume"
    // and needs a thread to resume in (absent on autonomous/subagent runs).
    let bind_to_thread = continue_in_thread == Some(true);
    if bind_to_thread && !parsed.is_one_shot {
        return Ok(json!({
            "success": false,
            "error": "continueInThread only works with one-off schedules (e.g. \"in 10 minutes\"), not recurring ones.",
        }));
    }
    if bind_to_thread && ctx.thread_id.is_none() {
        return Ok(json!({
            "success": false,
            "error": "continueInThread requires an active conversation thread to resume in.",
        }));
    }
    let delivery = read_task_delivery(
        &TaskDeliveryChanges {
            deliver_to,
            channel_ids: channel_ids.map(Some),
        },
        &ctx.agent_id,
        &CurrentTaskDelivery {
            deliver_to: "all".to_string(),
            channel_ids: None,
            thread_id: if bind_to_thread {
                ctx.thread_id.clone()
            } else {
                None
            },
        },
    )
    .await?;
    let delivery = match delivery {
        Ok(value) => value,
        Err(refusal) => return Ok(json!({ "success": false, "error": refusal.error })),
    };

    let mut row = NewCronTask::new(
        ctx.agent_id.clone(),
        ctx.user_id.clone(),
        name.clone(),
        parsed.cron_expression.clone(),
        instruction,
    );
    row.next_run_at = parsed.next_run_at;
    row.deliver_to = delivery.deliver_to;
    row.channel_ids = delivery.channel_ids;
    if bind_to_thread {
        row.thread_id = ctx.thread_id.clone();
        row.origin_channel = Some(ctx.origin_channel.as_str().to_string());
        row.origin_channel_id = ctx.origin_channel_id.clone();
    }
    let task: CronTask = crate::db::run(move |conn| {
        Ok(diesel::insert_into(cron_tasks::table)
            .values(&row)
            .returning(CronTask::as_returning())
            .get_result(conn)?)
    })
    .await?;

    CRON_SCHEDULER_SERVICE.schedule_task(
        to_backend_cron_task(&task),
        ScheduleTaskOptions {
            source: None,
            invoke_mode: Some(ctx.mode.clone()),
        },
    );

    let when = when_text(&task)?;
    let message = if bind_to_thread {
        format!("Scheduled \"{name}\" {when} — it will continue in this conversation.")
    } else {
        format!("Scheduled \"{name}\" {when}")
    };
    Ok(json!({
        "success": true,
        "taskId": task.id,
        "message": message,
        "continueInThread": bind_to_thread,
        "nextRunAt": task.next_run_at.as_ref().map(iso),
        "schedule": task.schedule,
    }))
}

async fn run_list_scheduled_tasks(ctx: CronToolContext) -> anyhow::Result<Value> {
    let (user_id, agent_id) = (ctx.user_id.clone(), ctx.agent_id.clone());
    let tasks: Vec<CronTask> = crate::db::run(move |conn| {
        Ok(cron_tasks::table
            .filter(cron_tasks::user_id.eq(&user_id))
            .filter(cron_tasks::agent_id.eq(&agent_id))
            .order(cron_tasks::created_at.desc())
            .select(CronTask::as_select())
            .load(conn)?)
    })
    .await?;
    let listed: Vec<Value> = tasks
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "name": t.name,
                "schedule": t.schedule,
                "instruction": t.instruction,
                "isActive": t.is_active,
                "deliverTo": t.deliver_to,
                "channelIds": parse_comma_list(t.channel_ids.as_deref()),
                "nextRunAt": t.next_run_at.as_ref().map(iso),
                "lastRunAt": t.last_run_at.as_ref().map(iso),
            })
        })
        .collect();
    Ok(json!({ "success": true, "count": tasks.len(), "tasks": listed }))
}

async fn run_update_scheduled_task(ctx: CronToolContext, input: Value) -> anyhow::Result<Value> {
    let UpdateScheduledTaskInput {
        task_id,
        name,
        schedule,
        instruction,
        deliver_to,
        channel_ids,
    } = serde_json::from_value(input)?;
    let result = CRON_SCHEDULER_SERVICE
        .update_task(
            &task_id,
            CronTaskChanges {
                name,
                schedule,
                instruction,
                deliver_to,
                channel_ids: channel_ids.map(Some),
            },
            UpdateTaskOptions {
                owner: Some(TaskOwner {
                    user_id: ctx.user_id.clone(),
                    agent_id: ctx.agent_id.clone(),
                }),
                invoke_mode: Some(ctx.mode.clone()),
            },
        )
        .await?;
    let task = match result {
        CronTaskEdit::Updated { task } => task,
        CronTaskEdit::NotFound { error }
        | CronTaskEdit::Running { error }
        | CronTaskEdit::Invalid { error, .. } => {
            return Ok(json!({ "success": false, "error": error }));
        }
    };
    let when = when_text(&task)?;
    Ok(json!({
        "success": true,
        "taskId": task.id,
        "message": format!("Updated \"{}\" {when}", task.name),
        "nextRunAt": task.next_run_at.as_ref().map(iso),
        "schedule": task.schedule,
    }))
}

async fn run_delete_scheduled_task(ctx: CronToolContext, input: Value) -> anyhow::Result<Value> {
    let DeleteScheduledTaskInput { task_id } = serde_json::from_value(input)?;
    let (id, user_id, agent_id) = (task_id.clone(), ctx.user_id.clone(), ctx.agent_id.clone());
    let count = crate::db::run(move |conn| {
        Ok(diesel::delete(
            cron_tasks::table
                .filter(cron_tasks::id.eq(&id))
                .filter(cron_tasks::user_id.eq(&user_id))
                .filter(cron_tasks::agent_id.eq(&agent_id)),
        )
        .execute(conn)?)
    })
    .await?;

    // Only unschedule (which emits 'cron task deleted') when a row was
    // actually removed — deleting a nonexistent task is not an event.
    if count > 0 {
        CRON_SCHEDULER_SERVICE.unschedule_task(&task_id, Some(&ctx.user_id), Some(&ctx.mode));
    }

    Ok(json!({ "success": true, "message": format!("Deleted task {task_id}") }))
}

/// A tool whose execute receives the bound context and the input.
fn cron_tool<F, Fut>(description: &str, schema: Value, ctx: &CronToolContext, run: F) -> Tool
where
    F: Fn(CronToolContext, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = anyhow::Result<Value>> + Send + 'static,
{
    let ctx = ctx.clone();
    tool(Tool {
        description: Some(description.to_string()),
        input_schema: zod_schema(schema),
        execute: Some(execute_fn(move |input, _| run(ctx.clone(), input))),
        ..Default::default()
    })
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
    let ctx = CronToolContext {
        user_id: user_id.to_string(),
        agent_id: agent_id.to_string(),
        mode: mode.to_string(),
        thread_id: thread_id.map(str::to_string),
        origin_channel: origin_channel.unwrap_or(ChannelName::Websocket),
        origin_channel_id: origin_channel_id.map(str::to_string),
    };
    let mut tools = ToolSet::new();
    tools.insert(
        "schedule_task".to_string(),
        cron_tool(
            SCHEDULE_TASK_DESCRIPTION,
            schedule_task_input_schema(),
            &ctx,
            run_schedule_task,
        ),
    );
    tools.insert(
        "list_scheduled_tasks".to_string(),
        cron_tool(
            LIST_SCHEDULED_TASKS_DESCRIPTION,
            list_scheduled_tasks_input_schema(),
            &ctx,
            |ctx, _| run_list_scheduled_tasks(ctx),
        ),
    );
    tools.insert(
        "update_scheduled_task".to_string(),
        cron_tool(
            UPDATE_SCHEDULED_TASK_DESCRIPTION,
            update_scheduled_task_input_schema(),
            &ctx,
            run_update_scheduled_task,
        ),
    );
    tools.insert(
        "delete_scheduled_task".to_string(),
        cron_tool(
            DELETE_SCHEDULED_TASK_DESCRIPTION,
            delete_scheduled_task_input_schema(),
            &ctx,
            run_delete_scheduled_task,
        ),
    );
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn the_chat_definitions_match_the_typescript_runtime() {
        let tools = get_cron_tools(
            "user-1",
            "agent-1",
            "chat",
            Some("thread-1"),
            Some(ChannelName::Websocket),
            None,
        );
        crate::tools::schema_fixture::assert_matches_fixture("cron:chat", &tools);
    }

    #[test]
    fn the_heartbeat_definitions_match_the_typescript_runtime() {
        let tools = get_cron_tools(
            "user-1",
            "agent-1",
            "heartbeat",
            None,
            Some(ChannelName::Websocket),
            None,
        );
        crate::tools::schema_fixture::assert_matches_fixture("cron:heartbeat", &tools);
    }

    // Each case is what `toLocaleString('en-US', …)` printed on Node 24.
    #[test]
    fn formats_a_run_time_as_node_does() {
        for (instant, zone, expected) in [
            (
                "2026-10-30T14:00:00Z",
                "Europe/Helsinki",
                "Oct 30, 2026, 4:00 PM GMT+2",
            ),
            ("2026-01-01T00:05:00Z", "UTC", "Jan 1, 2026, 12:05 AM GMT+0"),
            (
                "2026-06-01T12:00:00Z",
                "Asia/Kolkata",
                "Jun 1, 2026, 5:30 PM GMT+5:30",
            ),
            (
                "2026-09-01T23:30:00Z",
                "America/St_Johns",
                "Sep 1, 2026, 9:00 PM GMT-2:30",
            ),
            (
                "2026-03-01T12:00:00Z",
                "Asia/Kathmandu",
                "Mar 1, 2026, 5:45 PM GMT+5:45",
            ),
            (
                "2026-05-01T00:00:00Z",
                "America/New_York",
                "Apr 30, 2026, 8:00 PM GMT-4",
            ),
            (
                "2026-07-01T00:05:00Z",
                "Europe/London",
                "Jul 1, 2026, 1:05 AM GMT+1",
            ),
        ] {
            assert_eq!(format_run_time_in(&at(instant), zone).unwrap(), expected);
        }
    }

    #[test]
    fn refuses_a_name_that_is_not_a_zone() {
        assert_eq!(
            format_run_time_in(&at("2026-01-01T00:00:00Z"), "Mars/Olympus")
                .unwrap_err()
                .to_string(),
            "Invalid time zone specified: Mars/Olympus"
        );
    }
}
