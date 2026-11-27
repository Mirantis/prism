//! The record of each webhook event the runtime accepted, read by the Activity
//! page.
//!
//! An agent run is written as `queued` when the receiver accepts it, moves to
//! `running` when its turn in the subscription's queue comes, and is finished
//! with its result. A deliver-only event is written as `running` before its
//! publish and finished as `delivered` or `failed`.

use std::collections::HashMap;
use std::sync::LazyLock;

use anyhow::anyhow;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::CONFIG;
use crate::db::models::{NewWebhookRun, WebhookRun, WebhookRunChangeset};
use crate::db::schema::conversation_messages::dsl as m;
use crate::db::schema::conversation_threads::dsl as t;
use crate::db::schema::webhook_runs::dsl as wr;
use crate::db::sql_types::DbDateTime;
use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::tool_call_history_service::read_tool_calls;
use crate::support::js;
use crate::types::ToolCallRecord;

/// Every status a webhook run row holds, in the order of the run's life.
pub const WEBHOOK_RUN_STATUSES: [WebhookRunStatus; 7] = [
    WebhookRunStatus::Queued,
    WebhookRunStatus::Running,
    WebhookRunStatus::Completed,
    WebhookRunStatus::Failed,
    WebhookRunStatus::BudgetExceeded,
    WebhookRunStatus::Delivered,
    WebhookRunStatus::Suppressed,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebhookRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    BudgetExceeded,
    Delivered,
    Suppressed,
}

impl WebhookRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WebhookRunStatus::Queued => "queued",
            WebhookRunStatus::Running => "running",
            WebhookRunStatus::Completed => "completed",
            WebhookRunStatus::Failed => "failed",
            WebhookRunStatus::BudgetExceeded => "budget_exceeded",
            WebhookRunStatus::Delivered => "delivered",
            WebhookRunStatus::Suppressed => "suppressed",
        }
    }

    /// The status a stored `status` column names, or `None` for any other text.
    pub fn parse(text: &str) -> Option<WebhookRunStatus> {
        WEBHOOK_RUN_STATUSES
            .into_iter()
            .find(|status| status.as_str() == text)
    }
}

crate::support::display_as_str!(WebhookRunStatus);

/// A run in these states still has a worker that will write to its row.
const UNFINISHED: [WebhookRunStatus; 2] = [WebhookRunStatus::Queued, WebhookRunStatus::Running];

fn unfinished() -> [&'static str; 2] {
    UNFINISHED.map(WebhookRunStatus::as_str)
}

/// The statuses a run ends with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebhookRunResultStatus {
    Completed,
    Failed,
    BudgetExceeded,
    Delivered,
    Suppressed,
}

impl WebhookRunResultStatus {
    pub fn as_str(self) -> &'static str {
        self.status().as_str()
    }

    /// The run status this end is stored as.
    pub fn status(self) -> WebhookRunStatus {
        match self {
            WebhookRunResultStatus::Completed => WebhookRunStatus::Completed,
            WebhookRunResultStatus::Failed => WebhookRunStatus::Failed,
            WebhookRunResultStatus::BudgetExceeded => WebhookRunStatus::BudgetExceeded,
            WebhookRunResultStatus::Delivered => WebhookRunStatus::Delivered,
            WebhookRunResultStatus::Suppressed => WebhookRunStatus::Suppressed,
        }
    }
}

/// How a run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRunResult {
    pub status: WebhookRunResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The message the run delivered; absent when the delivery itself failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

/// Finished rows kept per agent. Unfinished rows are never trimmed, and are
/// bounded by the subscriptions' queues. A constant, not a setting.
pub const MAX_WEBHOOK_RUNS: i64 = 1000;

/// Cap on the stored error. The delivered message holds the whole notice.
const ERROR_MAX_CHARS: usize = 2000;

pub const INTERRUPTED_ERROR: &str = "The runtime restarted before the run finished.";

/// The message a run delivered, as a summary names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRunMessage {
    pub id: String,
    pub thread_id: String,
    pub thread_title: Option<String>,
    /// The thread is a web conversation, not a channel destination's own thread.
    pub in_web_chat: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRunSummary {
    pub id: String,
    pub name: String,
    pub event: String,
    pub status: WebhookRunStatus,
    pub error: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "crate::support::serde_iso::option")]
    pub finished_at: Option<DateTime<Utc>>,
    /// The message the run delivered, if it delivered one.
    pub message: Option<WebhookRunMessage>,
}

/// What the delivered message said and the tool calls it stored, in step order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRunDelivered {
    pub content: String,
    pub tool_calls: Vec<ToolCallRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRunDetail {
    #[serde(flatten)]
    pub summary: WebhookRunSummary,
    /// What the delivered message said and the tool calls it stored, in step order.
    pub delivered: Option<WebhookRunDelivered>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookRunPage {
    pub items: Vec<WebhookRunSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedEvent {
    /// The runId the receiver answered with.
    pub id: String,
    pub agent_id: String,
    pub name: String,
    pub event: String,
}

/// A run row with the message it delivered and that message's thread, as a
/// summary reads it.
struct SummaryRow {
    id: String,
    name: String,
    event: String,
    status: String,
    error: Option<String>,
    created_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    message: Option<SummaryRowMessage>,
}

struct SummaryRowMessage {
    id: String,
    thread_id: String,
    thread_title: Option<String>,
    thread_external_thread_id: Option<String>,
    content: String,
    tool_calls: Option<Value>,
}

fn to_summary(row: SummaryRow) -> WebhookRunSummary {
    WebhookRunSummary {
        id: row.id,
        name: row.name,
        event: row.event,
        status: WebhookRunStatus::parse(&row.status).unwrap_or(WebhookRunStatus::Failed),
        error: row.error,
        created_at: row.created_at,
        finished_at: row.finished_at,
        message: row.message.map(|message| WebhookRunMessage {
            id: message.id,
            thread_id: message.thread_id,
            thread_title: message.thread_title,
            in_web_chat: message.thread_external_thread_id.is_none(),
        }),
    }
}

/// The error as stored: `None` for an empty one, else cut at `ERROR_MAX_CHARS`
/// UTF-16 code units with an ellipsis.
fn cap_error(error: Option<&str>) -> Option<String> {
    let error = error.filter(|text| !text.is_empty())?;
    if js::len16(error) <= ERROR_MAX_CHARS {
        return Some(error.to_string());
    }
    Some(format!("{}…", js::slice16(error, 0, ERROR_MAX_CHARS)))
}

/// The runs with the message each delivered and that message's thread.
fn with_messages(
    conn: &mut SqliteConnection,
    runs: Vec<WebhookRun>,
) -> anyhow::Result<Vec<SummaryRow>> {
    let ids: Vec<String> = runs
        .iter()
        .filter_map(|run| run.message_id.clone())
        .collect();
    let messages: HashMap<String, SummaryRowMessage> = if ids.is_empty() {
        HashMap::new()
    } else {
        m::conversation_messages
            .inner_join(t::conversation_threads)
            .filter(m::id.eq_any(&ids))
            .select((
                m::id,
                m::thread_id,
                m::content,
                m::tool_calls,
                t::title,
                t::external_thread_id,
            ))
            .load::<(
                String,
                String,
                String,
                Option<Value>,
                Option<String>,
                Option<String>,
            )>(conn)?
            .into_iter()
            .map(|(id, thread_id, content, tool_calls, title, external)| {
                (
                    id.clone(),
                    SummaryRowMessage {
                        id,
                        thread_id,
                        thread_title: title,
                        thread_external_thread_id: external,
                        content,
                        tool_calls,
                    },
                )
            })
            .collect()
    };
    let mut messages = messages;
    Ok(runs
        .into_iter()
        .map(|run| SummaryRow {
            message: run.message_id.as_ref().and_then(|id| messages.remove(id)),
            id: run.id,
            name: run.name,
            event: run.event,
            status: run.status,
            error: run.error,
            created_at: run.created_at,
            finished_at: run.finished_at,
        })
        .collect())
}

/// `accept` is on the request's path and fails, so an event that cannot be
/// recorded answers 500 before anything runs or is sent. `start` and `finish`
/// follow a run already under way: a failed write is logged and never changes
/// what the run does or what the sender is told.
pub struct WebhookRunService {}

impl WebhookRunService {
    pub fn new() -> Self {
        WebhookRunService {}
    }

    /// An event the receiver accepted: `Queued` for an agent run waiting in its
    /// subscription's queue, `Running` for a deliver-only publish.
    pub async fn accept(
        &self,
        event: &AcceptedEvent,
        status: WebhookRunStatus,
    ) -> anyhow::Result<()> {
        self.insert(event, status).await
    }

    pub async fn start(&self, id: &str) {
        let run_id = id.to_string();
        let started = crate::db::run(move |conn| {
            let updated = diesel::update(wr::webhook_runs.filter(wr::id.eq(&run_id)))
                .set(wr::status.eq(WebhookRunStatus::Running.as_str()))
                .execute(conn)?;
            if updated == 0 {
                return Err(anyhow!("Record to update not found."));
            }
            Ok(())
        })
        .await;
        if let Err(err) = started {
            log_error!(
                json!({ "err": err_json(&err), "runId": id }),
                "[WebhookRun] Could not mark the run running"
            );
        }
    }

    pub async fn finish(&self, id: &str, result: &WebhookRunResult) {
        let run_id = id.to_string();
        let changes = WebhookRunChangeset {
            status: Some(result.status.as_str().to_string()),
            error: Some(cap_error(result.error.as_deref())),
            message_id: Some(result.message_id.clone()),
            finished_at: Some(Some(Utc::now())),
            ..WebhookRunChangeset::default()
        };
        let finished = crate::db::run(move |conn| {
            let updated = diesel::update(wr::webhook_runs.filter(wr::id.eq(&run_id)))
                .set(&changes)
                .execute(conn)?;
            if updated == 0 {
                return Err(anyhow!("Record to update not found."));
            }
            Ok(())
        })
        .await;
        if let Err(err) = finished {
            log_error!(
                json!({ "err": err_json(&err), "runId": id, "status": result.status.as_str() }),
                "[WebhookRun] Could not record how the run ended"
            );
        }
    }

    /// Put a run a restart interrupted back in the queue, and record one the restart
    /// cut off before its row was written. False when the run already finished, so
    /// there is nothing to run again.
    pub async fn requeue(&self, event: &AcceptedEvent) -> anyhow::Result<bool> {
        let run_id = event.id.clone();
        let count = crate::db::run(move |conn| {
            Ok(diesel::update(
                wr::webhook_runs
                    .filter(wr::id.eq(&run_id))
                    .filter(wr::status.eq_any(unfinished())),
            )
            .set(wr::status.eq(WebhookRunStatus::Queued.as_str()))
            .execute(conn)?)
        })
        .await?;
        if count > 0 {
            return Ok(true);
        }
        let run_id = event.id.clone();
        let finished = crate::db::run(move |conn| {
            Ok(wr::webhook_runs
                .filter(wr::id.eq(&run_id))
                .select(wr::id)
                .first::<String>(conn)
                .optional()?)
        })
        .await?;
        if finished.is_some() {
            return Ok(false);
        }
        self.insert(event, WebhookRunStatus::Queued).await?;
        Ok(true)
    }

    /// A run still queued or running at boot was cut off by the restart. Fails every
    /// such run except the ones `resumed` names. Returns how many it failed.
    pub async fn fail_interrupted(
        &self,
        agent_id: &str,
        resumed: &[String],
    ) -> anyhow::Result<i64> {
        let agent_id = agent_id.to_string();
        let resumed = resumed.to_vec();
        let count = crate::db::run(move |conn| {
            Ok(diesel::update(
                wr::webhook_runs
                    .filter(wr::agent_id.eq(&agent_id))
                    .filter(wr::status.eq_any(unfinished()))
                    .filter(wr::id.ne_all(&resumed)),
            )
            .set(&WebhookRunChangeset {
                status: Some(WebhookRunStatus::Failed.as_str().to_string()),
                error: Some(Some(INTERRUPTED_ERROR.to_string())),
                finished_at: Some(Some(Utc::now())),
                ..WebhookRunChangeset::default()
            })
            .execute(conn)?)
        })
        .await?;
        Ok(count as i64)
    }

    /// One page of runs, newest first.
    pub async fn page(&self, limit: i64, cursor: Option<&str>) -> anyhow::Result<WebhookRunPage> {
        // An unset id would filter on nothing and return every agent's runs.
        let Some(owner) = CONFIG.agent_id() else {
            return Ok(WebhookRunPage {
                items: Vec::new(),
                next_cursor: None,
            });
        };

        // A cursor row trimmed since the last page reads as the end.
        let cursor = cursor.map(str::to_string);
        let rows = crate::db::run(move |conn| {
            let mut query = wr::webhook_runs
                .filter(wr::agent_id.eq(&owner))
                .order((wr::created_at.desc(), wr::id.desc()))
                .limit(limit + 1)
                .select(WebhookRun::as_select())
                .into_boxed();
            if let Some(cursor) = &cursor {
                let at: Option<(DateTime<Utc>, String)> = wr::webhook_runs
                    .filter(wr::id.eq(cursor))
                    .select((wr::created_at, wr::id))
                    .first(conn)
                    .optional()?;
                let Some((created_at, id)) = at else {
                    return Ok(Vec::new());
                };
                query = query.filter(
                    wr::created_at
                        .lt(DbDateTime(created_at))
                        .or(wr::created_at.eq(DbDateTime(created_at)).and(wr::id.lt(id))),
                );
            }
            let runs = query.load(conn)?;
            with_messages(conn, runs)
        })
        .await?;

        let more = rows.len() as i64 > limit;
        let items: Vec<WebhookRunSummary> = rows
            .into_iter()
            .take(limit.max(0) as usize)
            .map(to_summary)
            .collect();
        let next_cursor = if more {
            items.last().map(|item| item.id.clone())
        } else {
            None
        };
        Ok(WebhookRunPage { items, next_cursor })
    }

    /// One run with what it delivered, or `None` when this agent has no such run.
    pub async fn get(&self, id: &str) -> anyhow::Result<Option<WebhookRunDetail>> {
        let Some(owner) = CONFIG.agent_id() else {
            return Ok(None);
        };
        let run_id = id.to_string();
        let row = crate::db::run(move |conn| {
            let run = wr::webhook_runs
                .filter(wr::id.eq(&run_id))
                .filter(wr::agent_id.eq(&owner))
                .select(WebhookRun::as_select())
                .first(conn)
                .optional()?;
            match run {
                Some(run) => Ok(with_messages(conn, vec![run])?.pop()),
                None => Ok(None),
            }
        })
        .await?;
        let Some(mut row) = row else {
            return Ok(None);
        };
        let delivered = row.message.as_mut().map(|message| WebhookRunDelivered {
            content: message.content.clone(),
            tool_calls: read_tool_calls(message.tool_calls.as_ref().unwrap_or(&Value::Null))
                .into_iter()
                .rev()
                .map(|indexed| indexed.call)
                .collect(),
        });
        Ok(Some(WebhookRunDetail {
            summary: to_summary(row),
            delivered,
        }))
    }

    /// Writes the row and trims the oldest finished rows beyond the bound, in one
    /// transaction.
    async fn insert(&self, event: &AcceptedEvent, status: WebhookRunStatus) -> anyhow::Result<()> {
        let row = NewWebhookRun::new(
            event.id.clone(),
            event.agent_id.clone(),
            event.name.clone(),
            event.event.clone(),
            status.as_str(),
        );
        let agent_id = event.agent_id.clone();
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                diesel::insert_into(wr::webhook_runs)
                    .values(&row)
                    .execute(conn)?;

                let over_bound: Vec<String> = wr::webhook_runs
                    .filter(wr::agent_id.eq(&agent_id))
                    .filter(wr::status.ne_all(unfinished()))
                    .order((wr::created_at.desc(), wr::id.desc()))
                    .offset(MAX_WEBHOOK_RUNS)
                    .select(wr::id)
                    .load(conn)?;
                if over_bound.is_empty() {
                    return Ok(());
                }

                diesel::delete(wr::webhook_runs.filter(wr::id.eq_any(&over_bound)))
                    .execute(conn)?;
                Ok(())
            })
        })
        .await
    }
}

impl Default for WebhookRunService {
    fn default() -> Self {
        Self::new()
    }
}

pub static WEBHOOK_RUN_SERVICE: LazyLock<WebhookRunService> = LazyLock::new(WebhookRunService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{
        MessageRole, MessageTrigger, NewAgentWorkspace, NewConversationMessage,
        NewConversationThread,
    };
    use crate::db::schema::agent_workspaces::dsl as aw;

    /// A test database with one agent, installed as the configured agent.
    struct Fixture {
        _db: crate::db::testing::TestDb,
        agent_id: String,
        previous: Option<String>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            CONFIG.set_agent_id(self.previous.take());
        }
    }

    async fn fixture() -> Fixture {
        let db = crate::db::testing::test_db();
        let agent = NewAgentWorkspace::new("user-1", "soul", "user", "memory", "heartbeat", "");
        let agent_id = agent.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(aw::agent_workspaces)
                .values(&agent)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        let previous = CONFIG.agent_id();
        CONFIG.set_agent_id(Some(agent_id.clone()));
        Fixture {
            _db: db,
            agent_id,
            previous,
        }
    }

    fn event(fixture: &Fixture, id: &str) -> AcceptedEvent {
        AcceptedEvent {
            id: id.into(),
            agent_id: fixture.agent_id.clone(),
            name: "alerts".into(),
            event: "push".into(),
        }
    }

    async fn run(id: &str) -> Option<WebhookRun> {
        let id = id.to_string();
        crate::db::run(move |conn| {
            Ok(wr::webhook_runs
                .filter(wr::id.eq(&id))
                .select(WebhookRun::as_select())
                .first(conn)
                .optional()?)
        })
        .await
        .unwrap()
    }

    /// A message in a thread, `external` naming a channel destination's thread.
    async fn message(
        fixture: &Fixture,
        external: Option<&str>,
        title: Option<&str>,
        tool_calls: Option<Value>,
    ) -> (String, String) {
        let mut thread = NewConversationThread::new(fixture.agent_id.clone(), "user-1");
        thread.external_thread_id = external.map(str::to_string);
        thread.title = title.map(str::to_string);
        let thread_id = thread.id.clone();
        let mut row = NewConversationMessage::new(
            thread_id.clone(),
            MessageRole::Agent,
            "All clear.",
            MessageTrigger::Webhook,
        );
        row.tool_calls = tool_calls;
        let message_id = row.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(t::conversation_threads)
                .values(&thread)
                .execute(conn)?;
            diesel::insert_into(m::conversation_messages)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        (message_id, thread_id)
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn accepts_an_event_in_the_status_the_caller_names() {
        let fixture = fixture().await;
        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-1"), WebhookRunStatus::Queued)
            .await
            .unwrap();
        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-2"), WebhookRunStatus::Running)
            .await
            .unwrap();
        assert_eq!(run("run-1").await.unwrap().status, "queued");
        assert_eq!(run("run-2").await.unwrap().status, "running");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_to_accept_an_event_it_cannot_record() {
        let fixture = fixture().await;
        let mut unknown = event(&fixture, "run-1");
        unknown.agent_id = "no-such-agent".into();
        assert!(
            WEBHOOK_RUN_SERVICE
                .accept(&unknown, WebhookRunStatus::Queued)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn marks_a_run_running_and_finishes_it_with_its_result() {
        let fixture = fixture().await;
        let (message_id, _) = message(&fixture, None, None, None).await;
        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-1"), WebhookRunStatus::Queued)
            .await
            .unwrap();
        WEBHOOK_RUN_SERVICE.start("run-1").await;
        assert_eq!(run("run-1").await.unwrap().status, "running");

        WEBHOOK_RUN_SERVICE
            .finish(
                "run-1",
                &WebhookRunResult {
                    status: WebhookRunResultStatus::Completed,
                    error: None,
                    message_id: Some(message_id.clone()),
                },
            )
            .await;
        let finished = run("run-1").await.unwrap();
        assert_eq!(finished.status, "completed");
        assert_eq!(finished.error, None);
        assert_eq!(finished.message_id, Some(message_id));
        assert!(finished.finished_at.is_some());

        // A run with no row is logged, not failed.
        WEBHOOK_RUN_SERVICE.start("missing").await;
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn caps_a_long_error() {
        let fixture = fixture().await;
        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-1"), WebhookRunStatus::Running)
            .await
            .unwrap();
        WEBHOOK_RUN_SERVICE
            .finish(
                "run-1",
                &WebhookRunResult {
                    status: WebhookRunResultStatus::Failed,
                    error: Some("x".repeat(5000)),
                    message_id: None,
                },
            )
            .await;
        let row = run("run-1").await.unwrap();
        assert!(row.error.unwrap().len() < 2100);
        assert_eq!(row.message_id, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn trims_only_finished_rows_beyond_the_bound() {
        let fixture = fixture().await;
        let agent_id = fixture.agent_id.clone();
        crate::db::run(move |conn| {
            let base = 1_700_000_000_000_i64;
            let rows: Vec<NewWebhookRun> = (0..MAX_WEBHOOK_RUNS + 1)
                .map(|i| {
                    let mut row = NewWebhookRun::new(
                        format!("old-{i}"),
                        &agent_id,
                        "alerts",
                        "push",
                        "completed",
                    );
                    row.created_at = DbDateTime(crate::support::from_ms(base + i));
                    row
                })
                .chain(std::iter::once({
                    let mut row =
                        NewWebhookRun::new("waiting", &agent_id, "alerts", "push", "queued");
                    row.created_at = DbDateTime(crate::support::from_ms(base - 1));
                    row
                }))
                .collect();
            diesel::insert_into(wr::webhook_runs)
                .values(&rows)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();

        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-new"), WebhookRunStatus::Running)
            .await
            .unwrap();

        // The oldest finished row goes; the queued row has a worker that still writes to it.
        assert!(run("old-0").await.is_none());
        assert!(run("old-1").await.is_some());
        assert!(run("waiting").await.is_some());
        assert!(run("run-new").await.is_some());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn fails_the_runs_a_restart_cut_off_except_the_ones_that_run_again() {
        let fixture = fixture().await;
        for (id, status) in [
            ("run-1", WebhookRunStatus::Queued),
            ("run-2", WebhookRunStatus::Running),
            ("run-3", WebhookRunStatus::Queued),
        ] {
            WEBHOOK_RUN_SERVICE
                .accept(&event(&fixture, id), status)
                .await
                .unwrap();
        }
        let count = WEBHOOK_RUN_SERVICE
            .fail_interrupted(&fixture.agent_id, &["run-3".to_string()])
            .await
            .unwrap();
        assert_eq!(count, 2);
        let failed = run("run-1").await.unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error.as_deref(), Some(INTERRUPTED_ERROR));
        assert_eq!(run("run-3").await.unwrap().status, "queued");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn requeues_an_unfinished_run_and_records_one_with_no_row() {
        let fixture = fixture().await;
        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-3"), WebhookRunStatus::Running)
            .await
            .unwrap();
        WEBHOOK_RUN_SERVICE
            .accept(&event(&fixture, "run-done"), WebhookRunStatus::Running)
            .await
            .unwrap();
        WEBHOOK_RUN_SERVICE
            .finish(
                "run-done",
                &WebhookRunResult {
                    status: WebhookRunResultStatus::Completed,
                    error: None,
                    message_id: None,
                },
            )
            .await;

        assert!(
            WEBHOOK_RUN_SERVICE
                .requeue(&event(&fixture, "run-3"))
                .await
                .unwrap()
        );
        assert_eq!(run("run-3").await.unwrap().status, "queued");
        assert!(
            !WEBHOOK_RUN_SERVICE
                .requeue(&event(&fixture, "run-done"))
                .await
                .unwrap()
        );
        assert!(
            WEBHOOK_RUN_SERVICE
                .requeue(&event(&fixture, "run-unwritten"))
                .await
                .unwrap()
        );
        assert_eq!(run("run-unwritten").await.unwrap().status, "queued");
    }

    async fn accept_at(fixture: &Fixture, id: &str, at: i64, message_id: Option<String>) {
        let mut row = NewWebhookRun::new(id, &fixture.agent_id, "alerts", "push", "completed");
        row.created_at = DbDateTime(crate::support::from_ms(at));
        row.message_id = message_id;
        crate::db::run(move |conn| {
            diesel::insert_into(wr::webhook_runs)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pages_runs_newest_first_with_a_cursor_naming_the_last_item() {
        let fixture = fixture().await;
        accept_at(&fixture, "a", 3_000, None).await;
        accept_at(&fixture, "b", 2_000, None).await;
        accept_at(&fixture, "c", 1_000, None).await;

        let page = WEBHOOK_RUN_SERVICE.page(2, None).await.unwrap();
        let ids: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert_eq!(page.next_cursor.as_deref(), Some("b"));

        let rest = WEBHOOK_RUN_SERVICE.page(2, Some("b")).await.unwrap();
        let ids: Vec<&str> = rest.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["c"]);
        assert_eq!(rest.next_cursor, None);

        // A cursor row trimmed since the last page reads as the end.
        let gone = WEBHOOK_RUN_SERVICE.page(2, Some("trimmed")).await.unwrap();
        assert!(gone.items.is_empty());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn says_whether_the_delivered_message_sits_in_a_web_conversation() {
        let fixture = fixture().await;
        let (web, web_thread) = message(&fixture, None, Some("Alerts"), None).await;
        let (slack, _) = message(&fixture, Some("D123"), None, None).await;
        accept_at(&fixture, "web", 3_000, Some(web.clone())).await;
        accept_at(&fixture, "slack", 2_000, Some(slack)).await;
        accept_at(&fixture, "gone", 1_000, None).await;

        let page = WEBHOOK_RUN_SERVICE.page(10, None).await.unwrap();
        assert_eq!(
            page.items[0].message,
            Some(WebhookRunMessage {
                id: web,
                thread_id: web_thread,
                thread_title: Some("Alerts".into()),
                in_web_chat: true,
            })
        );
        assert!(!page.items[1].message.as_ref().unwrap().in_web_chat);
        assert_eq!(page.items[2].message, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_empty_with_no_agent_resolved() {
        let _fixture = fixture().await;
        CONFIG.set_agent_id(None);
        assert_eq!(
            WEBHOOK_RUN_SERVICE.page(10, None).await.unwrap(),
            WebhookRunPage {
                items: vec![],
                next_cursor: None,
            }
        );
        assert_eq!(WEBHOOK_RUN_SERVICE.get("run-1").await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn serves_the_delivered_message_and_its_tool_calls_in_step_order() {
        let fixture = fixture().await;
        let (delivered, _) = message(
            &fixture,
            None,
            Some("Alerts"),
            Some(json!([
                { "tool": "first", "input": "{}", "output": "a", "success": true, "timestamp": "t1" },
                { "tool": "second", "input": "{}", "output": "b", "success": false, "timestamp": "t2" },
            ])),
        )
        .await;
        accept_at(&fixture, "run-1", 1_000, Some(delivered)).await;
        accept_at(&fixture, "run-2", 2_000, None).await;

        let detail = WEBHOOK_RUN_SERVICE.get("run-1").await.unwrap().unwrap();
        let delivered = detail.delivered.unwrap();
        assert_eq!(delivered.content, "All clear.");
        let tools: Vec<&str> = delivered
            .tool_calls
            .iter()
            .map(|call| call.tool.as_str())
            .collect();
        assert_eq!(tools, vec!["first", "second"]);

        let none = WEBHOOK_RUN_SERVICE.get("run-2").await.unwrap().unwrap();
        assert_eq!(none.delivered, None);
        assert_eq!(WEBHOOK_RUN_SERVICE.get("nope").await.unwrap(), None);
    }
}
