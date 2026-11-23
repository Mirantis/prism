//! Spending Routes — estimated model spend, from `SPENDING_SERVICE`.
//!
//! GET /agents/spending                       — totals for a range (`from`, `to`; default the last 30 days).
//! GET /agents/spending/periods               — per day, week or month (`period`, `count`, `timezone`).
//! GET /agents/spending/threads               — threads by spend (`from`, `to`, `limit`, `offset`).
//! GET /agents/spending/threads/{threadId}    — one thread, with its requests.
//! GET /agents/spending/requests/{requestId}  — one request.
//! GET /agents/spending/sources               — one category per task, webhook or goal (`category`, `from`, `to`).

use std::future::Future;

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::get;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use crate::lib::log_redaction::err_json;
use crate::lib::timezone::is_timezone;
use crate::log_error;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::spending_service::{
    SOURCED_CATEGORIES, SPENDING_SERVICE, SourcedCategory, SpendPeriod, SpendRange,
};
use crate::support::http::{QueryParams, QueryValue, error_json, json};
use crate::support::{from_ms, iso, now_ms, parse_iso};

pub fn router() -> Router {
    Router::new()
        .route("/agents/spending", get(summary))
        .route("/agents/spending/periods", get(periods))
        .route("/agents/spending/threads", get(threads))
        .route("/agents/spending/threads/{thread_id}", get(thread))
        .route("/agents/spending/requests/{request_id}", get(request))
        .route("/agents/spending/sources", get(sources))
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS: i64 = 30;

const DEFAULT_PAGE_SIZE: i64 = 30;
const MAX_PAGE_SIZE: i64 = 200;

/// `Number.MAX_SAFE_INTEGER`, the largest offset.
const MAX_OFFSET: i64 = 9_007_199_254_740_991;

/// Periods listed by default and at most, per period length.
fn period_counts(period: SpendPeriod) -> (i64, i64) {
    match period {
        SpendPeriod::Day => (30, 366),
        SpendPeriod::Week => (12, 104),
        SpendPeriod::Month => (12, 36),
    }
}

/// How a read ended: its body, a 404 for no spending, or an error.
enum Outcome {
    Found(Value),
    Missing,
}

/// A request parameter the route refuses with 400.
#[derive(Debug)]
struct BadParam(String);

impl std::fmt::Display for BadParam {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BadParam {}

fn bad(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(BadParam(message.into()))
}

fn integer(
    raw: Option<String>,
    name: &str,
    fallback: i64,
    min: i64,
    max: i64,
) -> anyhow::Result<i64> {
    let Some(text) = raw else {
        return Ok(fallback);
    };
    let refusal = || bad(format!("{name} must be an integer in {min}..{max}"));
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(refusal());
    }
    // A digit string too long for an integer is past `max` as well.
    let parsed = text.parse::<i64>().map_err(|_| refusal())?;
    if parsed < min || parsed > max {
        return Err(refusal());
    }
    Ok(parsed)
}

fn instant(
    raw: Option<String>,
    name: &str,
    fallback: DateTime<Utc>,
) -> anyhow::Result<DateTime<Utc>> {
    let Some(text) = raw else {
        return Ok(fallback);
    };
    parse_iso(&text).ok_or_else(|| bad(format!("{name} must be an ISO 8601 time")))
}

fn range(query: &QueryParams) -> anyhow::Result<SpendRange> {
    let to = instant(query.text("to"), "to", from_ms(now_ms()))?;
    let from = instant(
        query.text("from"),
        "from",
        from_ms(to.timestamp_millis() - DEFAULT_RANGE_DAYS * DAY_MS),
    )?;
    if from >= to {
        return Err(bad("from must be before to"));
    }
    Ok(SpendRange { from, to })
}

fn period(raw: Option<&QueryValue>) -> anyhow::Result<SpendPeriod> {
    match raw {
        None => Ok(SpendPeriod::Day),
        Some(QueryValue::One(value)) if value == "day" => Ok(SpendPeriod::Day),
        Some(QueryValue::One(value)) if value == "week" => Ok(SpendPeriod::Week),
        Some(QueryValue::One(value)) if value == "month" => Ok(SpendPeriod::Month),
        Some(_) => Err(bad("period must be day, week or month")),
    }
}

fn sourced_category(raw: Option<&str>) -> anyhow::Result<SourcedCategory> {
    raw.and_then(SourcedCategory::parse).ok_or_else(|| {
        let names: Vec<&str> = SOURCED_CATEGORIES.iter().map(|c| c.as_str()).collect();
        bad(format!("category must be one of {}", names.join(", ")))
    })
}

/// The zone a period is read in: the request's, else the agent's own.
async fn time_zone(raw: Option<String>) -> anyhow::Result<String> {
    let Some(name) = raw else {
        return Ok(AGENT_WORKSPACE_SERVICE.get_agent().await?.timezone);
    };
    if !is_timezone(&name) {
        return Err(bad("timezone must be an IANA time zone name"));
    }
    Ok(name)
}

fn found(body: impl Serialize) -> anyhow::Result<Outcome> {
    Ok(Outcome::Found(serde_json::to_value(body)?))
}

/// Answers what `read` returns, a 400 for a bad parameter, a 404 for no spending
/// and a 500 for anything else.
async fn handle(read: impl Future<Output = anyhow::Result<Outcome>>) -> Response {
    match read.await {
        Ok(Outcome::Found(body)) => json(200, body),
        Ok(Outcome::Missing) => error_json(404, "No spending recorded"),
        Err(err) => {
            if let Some(param) = err.downcast_ref::<BadParam>() {
                return error_json(400, param.0.clone());
            }
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Spending] Failed to read spending"
            );
            error_json(500, err.to_string())
        }
    }
}

/// The range's bounds, as the response names them.
fn bounds(range: &SpendRange) -> (String, String) {
    (iso(&range.from), iso(&range.to))
}

/// `{ ...head, ...rest }`: `rest`'s fields after `head`'s.
fn merged(head: Value, rest: impl Serialize) -> anyhow::Result<Outcome> {
    let (Value::Object(mut out), Value::Object(tail)) = (head, serde_json::to_value(rest)?) else {
        anyhow::bail!("a spending body is not an object");
    };
    out.extend(tail);
    Ok(Outcome::Found(Value::Object(out)))
}

/// GET /agents/spending
async fn summary(query: QueryParams) -> Response {
    handle(async move {
        let range = range(&query)?;
        let (from, to) = bounds(&range);
        merged(
            json!({ "from": from, "to": to }),
            SPENDING_SERVICE.summary(range).await?,
        )
    })
    .await
}

/// GET /agents/spending/periods
async fn periods(query: QueryParams) -> Response {
    handle(async move {
        let length = period(query.get("period"))?;
        let (fallback, max) = period_counts(length);
        let count = integer(query.text("count"), "count", fallback, 1, max)?;
        let zone = time_zone(query.text("timezone")).await?;
        let periods = SPENDING_SERVICE
            .periods(length, count, &zone, now_ms())
            .await?;
        found(json!({ "period": length, "timezone": zone, "periods": periods }))
    })
    .await
}

/// GET /agents/spending/threads
async fn threads(query: QueryParams) -> Response {
    handle(async move {
        let range = range(&query)?;
        let limit = integer(
            query.text("limit"),
            "limit",
            DEFAULT_PAGE_SIZE,
            1,
            MAX_PAGE_SIZE,
        )?;
        let offset = integer(query.text("offset"), "offset", 0, 0, MAX_OFFSET)?;
        let (from, to) = bounds(&range);
        merged(
            json!({ "from": from, "to": to }),
            SPENDING_SERVICE.threads(range, limit, offset).await?,
        )
    })
    .await
}

/// GET /agents/spending/threads/{threadId}
async fn thread(Path(thread_id): Path<String>) -> Response {
    handle(async move {
        match SPENDING_SERVICE.thread(&thread_id).await? {
            Some(thread) => found(thread),
            None => Ok(Outcome::Missing),
        }
    })
    .await
}

/// GET /agents/spending/requests/{requestId}
async fn request(Path(request_id): Path<String>) -> Response {
    handle(async move {
        match SPENDING_SERVICE.request(&request_id).await? {
            Some(request) => found(request),
            None => Ok(Outcome::Missing),
        }
    })
    .await
}

/// GET /agents/spending/sources
async fn sources(query: QueryParams) -> Response {
    handle(async move {
        let category = sourced_category(query.str("category"))?;
        let range = range(&query)?;
        let (from, to) = bounds(&range);
        let sources = SPENDING_SERVICE.sources(category, range).await?;
        found(json!({ "category": category, "from": from, "to": to, "sources": sources }))
    })
    .await
}

#[cfg(test)]
mod tests {
    //! How each endpoint reads its query parameters, and which status a bad
    //! parameter, a missing thread or request and a failed read get. The sums are
    //! covered in the service's own tests.

    use super::*;
    use crate::config::CONFIG;
    use crate::db::models::{NewLlmCall, llm_call_bucket};
    use crate::db::schema::{agent_workspaces, llm_calls};
    use crate::db::testing::{TestDb, test_db};
    use crate::support::http::testing::{TestResponse, call};
    use diesel::prelude::*;

    fn setup() -> TestDb {
        let db = test_db();
        let owner = CONFIG.agent_id().unwrap();
        crate::services::memory_store::tests::ensure_agent(&owner);
        crate::db::run_sync(move |conn| {
            diesel::update(agent_workspaces::table.filter(agent_workspaces::id.eq(owner)))
                .set(agent_workspaces::timezone.eq("Europe/Helsinki"))
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
        db
    }

    async fn get(uri: &str) -> TestResponse {
        call(router(), "GET", uri, None).await
    }

    async fn record(at: &str, thread_id: Option<&str>, request_id: Option<&str>) {
        let at = parse_iso(at).unwrap();
        let mut row = NewLlmCall::new(CONFIG.agent_id().unwrap(), "chat", "claude-opus-5");
        row.thread_id = thread_id.map(str::to_string);
        row.request_id = request_id.map(str::to_string);
        row.cost_micro_usd = Some(1_500_000);
        row.cost_source = Some("catalog".into());
        row.created_at = at.into();
        row.bucket = llm_call_bucket(at).into();
        crate::db::run(move |conn| {
            diesel::insert_into(llm_calls::table)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_the_range_it_is_given() {
        let _db = setup();
        record("2026-11-10T00:00:00Z", None, None).await;
        let res = get("/agents/spending?from=2026-11-01T00:00:00Z&to=2026-11-21T00:00:00Z").await;
        assert_eq!(res.status, 200);
        let body = res.json();
        assert_eq!(body["from"], "2026-11-01T00:00:00.000Z");
        assert_eq!(body["to"], "2026-11-21T00:00:00.000Z");
        assert_eq!(body["costUsd"], 1.5);
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "from",
                "to",
                "costUsd",
                "calls",
                "unpricedCalls",
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
                "byKind",
                "byCategory",
                "byModel",
                "byPurpose"
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn defaults_to_the_30_days_before_now() {
        let _db = setup();
        let res = get("/agents/spending").await;
        assert_eq!(res.status, 200);
        let body = res.json();
        let from = parse_iso(body["from"].as_str().unwrap()).unwrap();
        let to = parse_iso(body["to"].as_str().unwrap()).unwrap();
        assert_eq!(to.timestamp_millis() - from.timestamp_millis(), 30 * DAY_MS);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_bad_range() {
        let _db = setup();
        for (query, error) in [
            ("from=yesterday", "from must be an ISO 8601 time"),
            (
                "from=2026-11-21T00:00:00Z&to=2026-11-01T00:00:00Z",
                "from must be before to",
            ),
        ] {
            let res = get(&format!("/agents/spending?{query}")).await;
            assert_eq!(res.status, 400, "{query}");
            assert_eq!(res.json(), json!({ "error": error }));
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_500_when_the_read_fails() {
        let _db = setup();
        crate::db::run(|conn| {
            diesel::sql_query("DROP TABLE llm_calls").execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(get("/agents/spending").await.status, 500);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn lists_30_days_in_the_agents_own_time_zone_by_default() {
        let _db = setup();
        let res = get("/agents/spending/periods").await;
        assert_eq!(res.status, 200);
        let body = res.json();
        assert_eq!(body["period"], "day");
        assert_eq!(body["timezone"], "Europe/Helsinki");
        assert_eq!(body["periods"].as_array().unwrap().len(), 30);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn takes_the_period_the_count_and_a_time_zone() {
        let _db = setup();
        let res =
            get("/agents/spending/periods?period=month&count=6&timezone=America/New_York").await;
        let body = res.json();
        assert_eq!(
            (&body["period"], &body["timezone"]),
            (&json!("month"), &json!("America/New_York"))
        );
        let periods = body["periods"].as_array().unwrap();
        assert_eq!(periods.len(), 6);
        assert!(periods[0]["start"].as_str().unwrap().ends_with("-01"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_bad_period_parameter() {
        let _db = setup();
        for (query, error) in [
            ("period=year", "period must be day, week or month"),
            (
                "period=week&count=105",
                "count must be an integer in 1..104",
            ),
            ("count=0", "count must be an integer in 1..366"),
            (
                "timezone=Mars/Olympus",
                "timezone must be an IANA time zone name",
            ),
        ] {
            let res = get(&format!("/agents/spending/periods?{query}")).await;
            assert_eq!(res.status, 400, "{query}");
            assert_eq!(res.json(), json!({ "error": error }));
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn pages_the_threads_with_limit_and_offset() {
        let _db = setup();
        let now = iso(&from_ms(now_ms() - 60_000));
        for thread in ["thread-1", "thread-2", "thread-3"] {
            record(&now, Some(thread), None).await;
        }
        let res = get("/agents/spending/threads?limit=2&offset=1").await;
        assert_eq!(res.status, 200);
        let body = res.json();
        let ids: Vec<&str> = body["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["threadId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["thread-2", "thread-3"]);
        assert_eq!(body["nextOffset"], Value::Null);
        assert!(body["from"].is_string());
        assert_eq!(get("/agents/spending/threads?limit=201").await.status, 400);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reads_one_category_over_the_range() {
        let _db = setup();
        let res = get(
            "/agents/spending/sources?category=webhooks&from=2026-11-01T00:00:00Z&to=2026-11-21T00:00:00Z",
        )
        .await;
        assert_eq!(res.status, 200);
        assert_eq!(
            res.json(),
            json!({ "category": "webhooks", "from": "2026-11-01T00:00:00.000Z", "to": "2026-11-21T00:00:00.000Z", "sources": [] })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_category_that_has_no_sources() {
        let _db = setup();
        let res = get("/agents/spending/sources?category=voice").await;
        assert_eq!(res.status, 400);
        assert_eq!(
            res.json(),
            json!({ "error": "category must be one of scheduled-tasks, webhooks, goals" })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_one_thread_and_one_request_and_404_for_one_with_no_spending() {
        let _db = setup();
        record("2026-11-20T10:00:00Z", Some("thread-1"), Some("message-1")).await;

        let thread = get("/agents/spending/threads/thread-1").await;
        assert_eq!(thread.status, 200);
        assert_eq!(thread.json()["threadId"], "thread-1");
        assert_eq!(thread.json()["requests"][0]["requestId"], "message-1");
        let request = get("/agents/spending/requests/message-1").await;
        assert_eq!(request.status, 200);
        assert_eq!(request.json()["requestId"], "message-1");
        assert_eq!(request.json()["threadId"], "thread-1");

        for uri in [
            "/agents/spending/threads/nothing",
            "/agents/spending/requests/nothing",
        ] {
            let res = get(uri).await;
            assert_eq!(res.status, 404);
            assert_eq!(res.json(), json!({ "error": "No spending recorded" }));
        }
    }
}
