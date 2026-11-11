//! Usage Telemetry
//!
//! Single owner of the `llm usage aggregated` product event: the agent's model
//! calls, one event per closed UTC hour and model, read from `llm_calls`. Each
//! event covers `[period_start, period_end)` and carries counts only.
//!
//! `runtime_state` keeps the end of the last hour reported, written once the
//! collector has accepted the events. A pass reports every closed hour after it,
//! in windows of `WINDOW_HOURS`. With no mark stored, a pass reports the last window.
//! A crash or a failed export leaves the mark, so the same hours go out again
//! with the same period start.
//!
//! Provider and routing are read from config when an hour is reported, since one
//! process uses one vendor and one route. Hours reported after a restart that
//! changed `LLM_PROVIDER` or `NEXUS_API_URL` carry the new values.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use diesel::prelude::*;
use indexmap::IndexMap;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::config::CONFIG;
use crate::db::schema::llm_calls::dsl as l;
use crate::db::sql_types::DbDateTime;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::{flush_telemetry, is_telemetry_enabled, llm_routing, track_event};
use crate::log_warn;
use crate::services::runtime_state_service::{LLM_USAGE_REPORTED_THROUGH, RUNTIME_STATE_SERVICE};
use crate::support::{from_ms, iso, now_ms, parse_iso};

const HOUR_MS: i64 = 60 * 60 * 1000;
/// How often a pass runs, so an hour goes out a few minutes after it closes.
const PASS_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// How long after its end an hour is read, so a call recorded just before the boundary is in.
const SETTLE_MS: i64 = 60 * 1000;
/// The hours one read covers, which bounds the rows it holds.
const WINDOW_HOURS: i64 = 24;

static PASS_RUNNING: AtomicBool = AtomicBool::new(false);

/// Where a pass sends its events: product telemetry, or a test's record.
trait UsageSink: Sync {
    fn track(&self, props: IndexMap<String, String>);
    /// Whether the collector accepted every event tracked so far.
    async fn flush(&self) -> bool;
}

struct Telemetry;

impl UsageSink for Telemetry {
    fn track(&self, props: IndexMap<String, String>) {
        track_event("llm usage aggregated", None, Some(props));
    }

    async fn flush(&self) -> bool {
        flush_telemetry().await
    }
}

#[derive(Default)]
struct Bucket {
    calls: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_write_tokens: i64,
    cache_read_tokens: i64,
}

fn start_of_hour(ms: i64) -> i64 {
    ms.div_euclid(HOUR_MS) * HOUR_MS
}

/// Report the closed hours not yet reported. Never fails: a failure is logged,
/// and the next pass reports the same hours.
///
/// The rows are the owner's alone, since a subagent's calls are recorded against
/// the owner.
pub async fn report_closed_hours(agent_id: &str) {
    report_closed_hours_at(agent_id, now_ms(), &Telemetry).await;
}

async fn report_closed_hours_at(agent_id: &str, now: i64, sink: &impl UsageSink) {
    // A catch-up on a slow collector can outlast the interval, and a second pass
    // would read the same mark and send the same windows again.
    if PASS_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(err) = report_pass(agent_id, now, sink).await {
        log_warn!(
            json!({ "err": err_json(&err) }),
            "[UsageTelemetry] could not report LLM usage"
        );
    }
    PASS_RUNNING.store(false, Ordering::SeqCst);
}

async fn report_pass(agent_id: &str, now: i64, sink: &impl UsageSink) -> anyhow::Result<()> {
    let end = start_of_hour(now - SETTLE_MS);
    let mut start = match RUNTIME_STATE_SERVICE.get(LLM_USAGE_REPORTED_THROUGH).await? {
        // An unreadable mark reports nothing, as `Date.parse` answering NaN does.
        Some(mark) => match parse_iso(&mark) {
            Some(at) => at.timestamp_millis(),
            None => return Ok(()),
        },
        None => end - WINDOW_HOURS * HOUR_MS,
    };
    while start < end {
        let window_end = end.min(start + WINDOW_HOURS * HOUR_MS);
        if !report_window(agent_id, start, window_end, sink).await? {
            return Ok(());
        }
        start = window_end;
    }
    Ok(())
}

/// Send the events of `[start, end)` and move the mark to `end`. Answers false,
/// with the mark left where it was, when the collector did not accept them.
async fn report_window(
    agent_id: &str,
    start: i64,
    end: i64,
    sink: &impl UsageSink,
) -> anyhow::Result<bool> {
    let owner = agent_id.to_string();
    let rows: Vec<(String, DbDateTime, i64, i64, i64, i64)> = crate::db::read(move |conn| {
        Ok(l::llm_calls
            .filter(l::agent_id.eq(&owner))
            .filter(l::created_at.ge(DbDateTime(from_ms(start))))
            .filter(l::created_at.lt(DbDateTime(from_ms(end))))
            .select((
                l::model,
                l::created_at,
                l::input_tokens,
                l::output_tokens,
                l::cache_write_tokens,
                l::cache_read_tokens,
            ))
            .load(conn)?)
    })
    .await?;

    let mut buckets: IndexMap<(i64, String), Bucket> = IndexMap::new();
    for (model, created_at, input, output, cache_write, cache_read) in rows {
        let hour_start = start_of_hour(created_at.0.timestamp_millis());
        let bucket = buckets.entry((hour_start, model)).or_default();
        bucket.calls += 1;
        bucket.input_tokens += input;
        bucket.output_tokens += output;
        bucket.cache_write_tokens += cache_write;
        bucket.cache_read_tokens += cache_read;
    }

    let routing = llm_routing();
    for ((hour_start, model), bucket) in buckets {
        let mut props = IndexMap::new();
        let mut put = |key: &str, value: String| {
            props.insert(key.to_string(), value);
        };
        put("usage.period_start", iso(&from_ms(hour_start)));
        put("usage.period_end", iso(&from_ms(hour_start + HOUR_MS)));
        put("usage.provider", CONFIG.llm_provider.as_str().to_string());
        put("usage.model", model);
        // The whole prompt, cache reads and writes included.
        put("usage.input_tokens", bucket.input_tokens.to_string());
        put("usage.output_tokens", bucket.output_tokens.to_string());
        put("usage.cache_creation_tokens", bucket.cache_write_tokens.to_string());
        put("usage.cache_read_tokens", bucket.cache_read_tokens.to_string());
        // Model calls, one per step, including those the provider reported no usage for.
        put("usage.request_count", bucket.calls.to_string());
        put("usage.metering_point", "harness".to_string());
        put("usage.llm_routing", routing.to_string());
        put("agent.id", agent_id.to_string());
        sink.track(props);
    }

    if !sink.flush().await {
        return Ok(false);
    }
    RUNTIME_STATE_SERVICE
        .set(LLM_USAGE_REPORTED_THROUGH, &iso(&from_ms(end)))
        .await?;
    Ok(true)
}

/// Report now, then every `PASS_INTERVAL`. Returns the task so the caller can stop
/// it on shutdown. Returns `None`, and reads nothing, when telemetry is off.
pub fn start_usage_telemetry(agent_id: &str) -> Option<JoinHandle<()>> {
    if !is_telemetry_enabled() {
        return None;
    }
    let agent_id = agent_id.to_string();
    Some(tokio::spawn(async move {
        // The first tick completes at once: the pass at boot.
        let mut interval = tokio::time::interval(PASS_INTERVAL);
        loop {
            interval.tick().await;
            let agent_id = agent_id.clone();
            tokio::spawn(async move { report_closed_hours(&agent_id).await });
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewLlmCall;
    use crate::db::testing::test_db;
    use parking_lot::Mutex;

    const OWNER: &str = "agent-1";
    const OTHER_AGENT: &str = "agent-2";
    const CHAT_MODEL: &str = "global.anthropic.claude-opus-5-5";
    const GATE_MODEL: &str = "global.anthropic.claude-haiku-5-5";

    /// 10:00 UTC; the tests report from a moment after 12:00, so 10:00 and 11:00 are closed.
    fn h10() -> i64 {
        parse_iso("2026-11-06T10:00:00.000Z").unwrap().timestamp_millis()
    }
    fn h11() -> i64 {
        h10() + HOUR_MS
    }
    fn h12() -> i64 {
        h10() + 2 * HOUR_MS
    }
    fn now() -> i64 {
        h12() + 5 * 60 * 1000
    }

    /// Records events, and answers each flush from a queue (true once it is empty).
    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<IndexMap<String, String>>>,
        flushes: Mutex<std::collections::VecDeque<bool>>,
    }

    impl UsageSink for Recorder {
        fn track(&self, props: IndexMap<String, String>) {
            self.events.lock().push(props);
        }

        async fn flush(&self) -> bool {
            self.flushes.lock().pop_front().unwrap_or(true)
        }
    }

    impl Recorder {
        fn starts(&self) -> Vec<String> {
            self.events
                .lock()
                .iter()
                .map(|e| e["usage.period_start"].clone())
                .collect()
        }

        fn event_for(&self, hour_start: i64, model: &str) -> Option<IndexMap<String, String>> {
            let start = iso(&from_ms(hour_start));
            self.events
                .lock()
                .iter()
                .find(|e| e["usage.period_start"] == start && e["usage.model"] == model)
                .cloned()
        }
    }

    async fn record_call(at: i64, model: &str, tokens: [i64; 4], agent_id: &str) {
        let mut row = NewLlmCall::new(agent_id, "chat", model);
        row.created_at = DbDateTime(from_ms(at));
        [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens] = tokens;
        crate::db::run(move |conn| {
            diesel::insert_into(l::llm_calls).values(&row).execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    async fn mark() -> Option<String> {
        RUNTIME_STATE_SERVICE
            .get(LLM_USAGE_REPORTED_THROUGH)
            .await
            .unwrap()
    }

    fn setup() -> crate::db::testing::TestDb {
        let db = test_db();
        crate::services::memory_store::tests::ensure_agent(OWNER);
        crate::services::memory_store::tests::ensure_agent(OTHER_AGENT);
        db
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sends_one_event_per_closed_hour_and_model_with_the_counts_of_that_hour() {
        let _db = setup();
        record_call(h10() + 1000, CHAT_MODEL, [1000, 100, 700, 200], OWNER).await;
        record_call(h10() + 2000, CHAT_MODEL, [500, 50, 400, 0], OWNER).await;
        record_call(h10() + 3000, GATE_MODEL, [300, 2, 0, 0], OWNER).await;
        // A call the provider reported no usage for is still a call.
        record_call(h11() + 1000, GATE_MODEL, [0, 0, 0, 0], OWNER).await;

        let sink = Recorder::default();
        report_closed_hours_at(OWNER, now(), &sink).await;

        assert_eq!(sink.events.lock().len(), 3);
        let chat = sink.event_for(h10(), CHAT_MODEL).unwrap();
        let expected: Vec<(&str, &str)> = vec![
            ("usage.period_start", "2026-11-06T10:00:00.000Z"),
            ("usage.period_end", "2026-11-06T11:00:00.000Z"),
            ("usage.provider", "bedrock"),
            ("usage.model", CHAT_MODEL),
            ("usage.input_tokens", "1500"),
            ("usage.output_tokens", "150"),
            ("usage.cache_creation_tokens", "200"),
            ("usage.cache_read_tokens", "1100"),
            ("usage.request_count", "2"),
            ("usage.metering_point", "harness"),
            ("usage.llm_routing", "direct"),
            ("agent.id", OWNER),
        ];
        let actual: Vec<(&str, &str)> = chat.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(actual, expected);
        let gate = sink.event_for(h10(), GATE_MODEL).unwrap();
        assert_eq!(gate["usage.input_tokens"], "300");
        assert_eq!(gate["usage.request_count"], "1");
        let later = sink.event_for(h11(), GATE_MODEL).unwrap();
        assert_eq!(later["usage.period_end"], "2026-11-06T12:00:00.000Z");
        assert_eq!(later["usage.input_tokens"], "0");
        assert_eq!(later["usage.request_count"], "1");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn puts_a_call_made_on_the_hour_into_the_hour_it_starts() {
        let _db = setup();
        record_call(h11(), CHAT_MODEL, [10, 0, 0, 0], OWNER).await;
        let sink = Recorder::default();
        report_closed_hours_at(OWNER, now(), &sink).await;
        assert_eq!(sink.starts(), vec!["2026-11-06T11:00:00.000Z"]);
        assert_eq!(sink.event_for(h11(), CHAT_MODEL).unwrap()["usage.input_tokens"], "10");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn leaves_the_open_hour_and_an_hour_that_just_ended_for_a_later_pass() {
        let _db = setup();
        record_call(h11() + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        record_call(h12() + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        let sink = Recorder::default();
        report_closed_hours_at(OWNER, h12() + 30 * 1000, &sink).await;
        assert!(sink.starts().is_empty());
        report_closed_hours_at(OWNER, h12() + 61 * 1000, &sink).await;
        assert_eq!(sink.starts(), vec!["2026-11-06T11:00:00.000Z"]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_each_hour_once_across_passes() {
        let _db = setup();
        record_call(h10() + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        let sink = Recorder::default();
        report_closed_hours_at(OWNER, now(), &sink).await;
        assert_eq!(mark().await.as_deref(), Some("2026-11-06T12:00:00.000Z"));
        report_closed_hours_at(OWNER, now() + 10 * 60 * 1000, &sink).await;
        assert_eq!(sink.events.lock().len(), 1);
        record_call(h12() + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        report_closed_hours_at(OWNER, h12() + HOUR_MS + 2 * 60 * 1000, &sink).await;
        assert_eq!(sink.events.lock().len(), 2);
        assert!(sink.event_for(h12(), CHAT_MODEL).is_some());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_at_most_the_last_24_closed_hours_with_no_mark_stored() {
        let _db = setup();
        record_call(h12() - 25 * HOUR_MS + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        record_call(h12() - 24 * HOUR_MS + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        let sink = Recorder::default();
        report_closed_hours_at(OWNER, now(), &sink).await;
        assert_eq!(sink.starts(), vec![iso(&from_ms(h12() - 24 * HOUR_MS))]);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_every_hour_after_the_mark_and_keeps_the_last_accepted_window() {
        let _db = setup();
        RUNTIME_STATE_SERVICE
            .set(LLM_USAGE_REPORTED_THROUGH, "2026-11-06T10:00:00.000Z")
            .await
            .unwrap();
        record_call(h10() + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        record_call(h10() + 26 * HOUR_MS + 1000, CHAT_MODEL, [0; 4], OWNER).await;
        let at = h10() + 30 * HOUR_MS + 5 * 60 * 1000;

        // The second window is not accepted: the mark stays at the end of the first.
        let sink = Recorder::default();
        sink.flushes.lock().extend([true, false]);
        report_closed_hours_at(OWNER, at, &sink).await;
        assert_eq!(mark().await.as_deref(), Some("2026-11-07T10:00:00.000Z"));

        // The next pass sends the second window again and moves the mark past it.
        let again = Recorder::default();
        report_closed_hours_at(OWNER, at, &again).await;
        assert_eq!(again.starts(), vec!["2026-11-07T12:00:00.000Z"]);
        assert_eq!(mark().await.as_deref(), Some("2026-11-07T16:00:00.000Z"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn reports_the_owner_alone_and_moves_the_mark_over_empty_hours() {
        let _db = setup();
        record_call(h10() + 1000, CHAT_MODEL, [7, 0, 0, 0], OTHER_AGENT).await;
        let sink = Recorder::default();
        report_closed_hours_at(OWNER, now(), &sink).await;
        assert!(sink.starts().is_empty());
        assert_eq!(mark().await.as_deref(), Some("2026-11-06T12:00:00.000Z"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_the_mark_when_the_calls_cannot_be_read() {
        let _db = setup();
        crate::db::run(|conn| {
            diesel::sql_query("DROP TABLE llm_calls").execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        let sink = Recorder::default();
        report_closed_hours_at(OWNER, now(), &sink).await;
        assert!(sink.starts().is_empty());
        assert_eq!(mark().await, None);
        // The guard is released after a failed pass.
        assert!(!PASS_RUNNING.load(Ordering::SeqCst));
    }

    #[test]
    fn starts_nothing_when_telemetry_is_off() {
        // The test configuration has no OTEL endpoint.
        assert!(start_usage_telemetry(OWNER).is_none());
    }
}
