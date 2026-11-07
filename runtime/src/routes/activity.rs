//! Activity Routes
//!
//! GET /agents/activity/llm-usage        — token totals.
//! GET /agents/activity/tool-calls       — paged tool calls.
//! GET /agents/activity/webhook-runs     — paged webhook runs.
//! GET /agents/activity/webhook-runs/{id} — one run with the message it delivered.

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::get;
use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::llm_usage_service::LLM_USAGE_SERVICE;
use crate::services::tool_call_history_service::TOOL_CALL_HISTORY_SERVICE;
use crate::services::webhook_run_service::WEBHOOK_RUN_SERVICE;
use crate::support::http::{QueryParams, error_json, json};

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

/// An absent or empty cursor starts at the newest entry.
fn cursor_param(raw: Option<&str>) -> Option<&str> {
    raw.filter(|text| !text.is_empty())
}

/// An absent param takes the default; anything not an integer in 1..max is an
/// error, whose text the handler answers 400 after the param's name
/// (`hours must be an integer in 1..744`). `raw` is the param as text, a repeated
/// param joined with commas.
fn positive_int(raw: Option<String>, fallback: i64, max: i64) -> Result<i64, String> {
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
async fn llm_usage(query: QueryParams) -> Response {
    let window_hours =
        match positive_int(query.text("hours"), DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS) {
            Ok(hours) => hours,
            Err(reason) => return error_json(400, format!("hours {reason}")),
        };
    match LLM_USAGE_SERVICE.summarize(window_hours).await {
        Ok(summary) => json(200, summary),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Activity] Failed to summarize LLM usage"
            );
            error_json(500, err.to_string())
        }
    }
}

/// GET /agents/activity/tool-calls
async fn tool_calls(query: QueryParams) -> Response {
    let limit = match positive_int(query.text("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) {
        Ok(limit) => limit,
        Err(reason) => return error_json(400, format!("limit {reason}")),
    };
    let page = TOOL_CALL_HISTORY_SERVICE
        .page(limit as usize, cursor_param(query.str("cursor")))
        .await;
    match page {
        Ok(page) => json(200, page),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Activity] Failed to list tool calls"
            );
            error_json(500, err.to_string())
        }
    }
}

/// GET /agents/activity/webhook-runs
async fn webhook_runs(query: QueryParams) -> Response {
    let limit = match positive_int(query.text("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) {
        Ok(limit) => limit,
        Err(reason) => return error_json(400, format!("limit {reason}")),
    };
    match WEBHOOK_RUN_SERVICE
        .page(limit, cursor_param(query.str("cursor")))
        .await
    {
        Ok(page) => json(200, page),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Activity] Failed to list webhook runs"
            );
            error_json(500, err.to_string())
        }
    }
}

/// GET /agents/activity/webhook-runs/{id}
async fn webhook_run(Path(id): Path<String>) -> Response {
    match WEBHOOK_RUN_SERVICE.get(&id).await {
        Ok(Some(run)) => json(200, run),
        Ok(None) => error_json(404, "Webhook run not found"),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Activity] Failed to read a webhook run"
            );
            error_json(500, err.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_positive_integer_param() {
        assert_eq!(positive_int(None, 24, 744), Ok(24));
        assert_eq!(positive_int(Some("48".into()), 24, 744), Ok(48));
        for bad in [
            "0",
            "745",
            "-1",
            "1.5",
            "abc",
            "",
            "1,2",
            "99999999999999999999",
        ] {
            assert_eq!(
                positive_int(Some(bad.into()), 24, 744),
                Err("must be an integer in 1..744".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn starts_an_absent_or_empty_cursor_at_the_newest_entry() {
        assert_eq!(cursor_param(None), None);
        assert_eq!(cursor_param(Some("")), None);
        assert_eq!(cursor_param(Some("abc")), Some("abc"));
    }
}
