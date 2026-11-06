//! Activity Routes
//!
//! GET /agents/activity/llm-usage        — token totals.
//! GET /agents/activity/tool-calls       — paged tool calls.
//! GET /agents/activity/webhook-runs     — paged webhook runs.
//! GET /agents/activity/webhook-runs/{id} — one run with the message it delivered.

use axum::Router;
use axum::extract::{Path, Query};
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};

pub fn router() -> Router {
    Router::new()
        .route("/agents/activity/llm-usage", get(llm_usage))
        .route("/agents/activity/tool-calls", get(tool_calls))
        .route("/agents/activity/webhook-runs", get(webhook_runs))
        .route("/agents/activity/webhook-runs/{id}", get(webhook_run))
}

const DEFAULT_WINDOW_HOURS: i64 = 24;
const MAX_WINDOW_HOURS: i64 = 24 * 31;

const DEFAULT_PAGE_SIZE: i64 = 30;
const MAX_PAGE_SIZE: i64 = 200;

/// The query of `GET /agents/activity/llm-usage`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UsageQuery {
    /// The window, an integer in 1..=744 hours. Absent is 24.
    pub hours: Option<String>,
}

/// The query of the two paged lists.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PageQuery {
    /// The page size, an integer in 1..=200. Absent is 30.
    pub limit: Option<String>,
    /// Where the page starts. Absent or empty starts at the newest entry.
    pub cursor: Option<String>,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// An absent or empty cursor starts at the newest entry.
fn cursor_param(raw: Option<&str>) -> Option<&str> {
    raw.filter(|text| !text.is_empty())
}

/// An absent param takes the default; anything not an integer in 1..max is an
/// error, whose text the handler answers 400 after the param's name
/// (`hours must be an integer in 1..744`).
fn positive_int(raw: Option<&str>, fallback: i64, max: i64) -> Result<i64, String> {
    let Some(text) = raw else {
        return Ok(fallback);
    };
    let refusal = || format!("must be an integer in 1..{max}");
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(refusal());
    }
    // A digit string too long for an integer is past `max` as well.
    let parsed = text.parse::<i64>().map_err(|_| refusal())?;
    if parsed < 1 || parsed > max {
        return Err(refusal());
    }
    Ok(parsed)
}

/// GET /agents/activity/llm-usage
///
/// `?hours` (default 24, at most 744) goes to `LLM_USAGE_SERVICE.summarize`, whose
/// result is sent unchanged. A bad `hours` answers 400 `hours <reason>`. A failure
/// is logged (`[Activity] Failed to summarize LLM usage`, with `err`) and answers
/// 500 with the error's message.
async fn llm_usage(Query(query): Query<UsageQuery>) -> Response {
    todo!()
}

/// GET /agents/activity/tool-calls
///
/// Sends `TOOL_CALL_HISTORY_SERVICE.page(limit, cursor)` unchanged. A bad `limit`
/// answers 400 `limit <reason>`. A failure is logged
/// (`[Activity] Failed to list tool calls`, with `err`) and answers 500.
async fn tool_calls(Query(query): Query<PageQuery>) -> Response {
    todo!()
}

/// GET /agents/activity/webhook-runs
///
/// Sends `WEBHOOK_RUN_SERVICE.page(limit, cursor)` unchanged. A bad `limit` answers
/// 400 `limit <reason>`. A failure is logged
/// (`[Activity] Failed to list webhook runs`, with `err`) and answers 500.
async fn webhook_runs(Query(query): Query<PageQuery>) -> Response {
    todo!()
}

/// GET /agents/activity/webhook-runs/{id}
///
/// Sends `WEBHOOK_RUN_SERVICE.get(id)` unchanged, or 404
/// `Webhook run not found`. A failure is logged
/// (`[Activity] Failed to read a webhook run`, with `err`) and answers 500.
async fn webhook_run(Path(id): Path<String>) -> Response {
    todo!()
}
