//! The record of each webhook event the runtime accepted, read by the Activity
//! page.
//!
//! An agent run is written as `queued` when the receiver accepts it, moves to
//! `running` when its turn in the subscription's queue comes, and is finished
//! with its result. A deliver-only event is written as `running` before its
//! publish and finished as `delivered` or `failed`.

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::config::CONFIG;
use crate::db::models::WebhookRun;
use crate::services::tool_call_history_service::read_tool_calls;
use crate::support::js;
use crate::types::ToolCallRecord;
use crate::{log_error, log_info, log_warn};

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

impl std::fmt::Display for WebhookRunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A run in these states still has a worker that will write to its row.
const UNFINISHED: [WebhookRunStatus; 2] = [WebhookRunStatus::Queued, WebhookRunStatus::Running];

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
}

fn to_summary(row: SummaryRow) -> WebhookRunSummary {
    todo!()
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
        todo!()
    }

    pub async fn start(&self, id: &str) {
        todo!()
    }

    pub async fn finish(&self, id: &str, result: &WebhookRunResult) {
        todo!()
    }

    /// Put a run a restart interrupted back in the queue, and record one the restart
    /// cut off before its row was written. False when the run already finished, so
    /// there is nothing to run again.
    pub async fn requeue(&self, event: &AcceptedEvent) -> anyhow::Result<bool> {
        todo!()
    }

    /// A run still queued or running at boot was cut off by the restart. Fails every
    /// such run except the ones `resumed` names. Returns how many it failed.
    pub async fn fail_interrupted(
        &self,
        agent_id: &str,
        resumed: &[String],
    ) -> anyhow::Result<i64> {
        todo!()
    }

    /// One page of runs, newest first.
    pub async fn page(&self, limit: i64, cursor: Option<&str>) -> anyhow::Result<WebhookRunPage> {
        todo!()
    }

    /// One run with what it delivered, or `None` when this agent has no such run.
    pub async fn get(&self, id: &str) -> anyhow::Result<Option<WebhookRunDetail>> {
        todo!()
    }

    /// Writes the row and trims the oldest finished rows beyond the bound, in one
    /// transaction.
    async fn insert(&self, event: &AcceptedEvent, status: WebhookRunStatus) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for WebhookRunService {
    fn default() -> Self {
        Self::new()
    }
}

pub static WEBHOOK_RUN_SERVICE: LazyLock<WebhookRunService> = LazyLock::new(WebhookRunService::new);
