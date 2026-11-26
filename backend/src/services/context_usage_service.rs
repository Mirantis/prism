//! Context-window occupancy tracking (channel-agnostic).
//!
//! Answers "how much of the model's context window is this thread using?" so the
//! clients can show a context-window indicator (% of the window consumed).
//!
//! The numerator comes from the provider, not from an estimate. The AI SDK's
//! `usage.input_tokens` is the full prompt size *including* cached tokens — the
//! Anthropic provider sets it to `input_tokens + cache_creation + cache_read`, and
//! the SDK core flattens that to a single number. So it must NOT have cache
//! read/write added on top; that would double-count, badly, because `invoke.rs`
//! sets four cache breakpoints and cache reads dominate a warm thread.
//!
//! Note the distinction from `InvokeResponse.usage.total_tokens`, which sums every
//! step: each agentic step resends the whole conversation, so that figure is
//! cumulative *billed* spend, not occupancy.
//!
//! Occupancy here is the latest step's prompt **plus that step's output** — i.e.
//! how full the context will be when the next turn starts, since the reply becomes
//! part of the next prompt. Deliberately not the prompt alone: at the moment the
//! number matters most, the reply is exactly what pushed it there. Don't "simplify"
//! this to `input_tokens` to match a narrower reading of the word occupancy; that
//! silently changes the metric.
//!
//! Nothing here knows about WebSockets — snapshots are announced on `events`
//! and transports subscribe, matching `thread_title_service.rs`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use parking_lot::{Mutex, RwLock};
use serde::Serialize;

use serde_json::json;

pub use crate::lib::context_window::ContextUsageSnapshot;
use crate::lib::context_window::build_context_snapshot;
use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::conversation_service::CONVERSATION_SERVICE;

/// A thread's occupancy changed — emitted as `usage`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageEvent {
    pub user_id: String,
    #[serde(flatten)]
    pub snapshot: ContextUsageSnapshot,
}

/// One step's measurement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordInput {
    /// Carried only so the `usage` event can be routed to that user's clients.
    pub user_id: String,
    pub thread_id: String,
    pub model_id: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// A post-compaction occupancy estimate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstimateInput {
    pub user_id: String,
    pub thread_id: String,
    pub model_id: String,
    pub used_tokens: i64,
}

/// A thread's latest measurement, stored for every model: idle compaction reads the
/// size after a restart. `snapshot` is `None` when the model's window is unknown.
#[derive(Debug, Clone)]
struct TrackedThread {
    model_id: String,
    used_tokens: i64,
    snapshot: Option<ContextUsageSnapshot>,
}

/// Receives each `usage` event.
pub type ContextUsageListener = Arc<dyn Fn(&ContextUsageEvent) + Send + Sync>;

/// The `usage` events: a thread's occupancy changed.
#[derive(Default)]
pub struct ContextUsageEvents {
    usage: RwLock<Vec<ContextUsageListener>>,
}

impl ContextUsageEvents {
    /// Call `listener` with every usage event from now on.
    pub fn on_usage(&self, listener: impl Fn(&ContextUsageEvent) + Send + Sync + 'static) {
        self.usage.write().push(Arc::new(listener));
    }

    /// Hand `event` to every listener, synchronously and in subscription order.
    pub fn emit_usage(&self, event: &ContextUsageEvent) {
        let listeners = self.usage.read().clone();
        for listener in listeners {
            listener(event);
        }
    }
}

pub struct ContextUsageService {
    pub events: ContextUsageEvents,
    /// Keyed by threadId. Bounded by concurrent in-flight turns (goal runs are
    /// already serialized per thread), and each entry is dropped by `finalize`.
    tracked: Mutex<HashMap<String, TrackedThread>>,
}

impl ContextUsageService {
    pub fn new() -> Self {
        Self {
            events: ContextUsageEvents::default(),
            tracked: Mutex::new(HashMap::new()),
        }
    }

    /// Record one step's measurement. Called per step finish, so it stays cheap:
    /// no I/O, and it only emits when the rounded percentage actually moved —
    /// otherwise a 100-step turn would push 100 identical frames.
    ///
    /// Returns the snapshot, or `None` when occupancy can't be determined (the
    /// provider reported no usage, or the model's window is unknown). A `None` means
    /// *render nothing* — never a reassuring 0% used, which would be a claim we
    /// can't back.
    pub fn record(&self, input: RecordInput) -> Option<ContextUsageSnapshot> {
        let input_tokens = input.input_tokens?;

        let used_tokens = input_tokens + input.output_tokens.unwrap_or(0);
        let snapshot =
            build_context_snapshot(&input.thread_id, Some(&input.model_id), Some(used_tokens));
        let previous = self.tracked.lock().insert(
            input.thread_id.clone(),
            TrackedThread {
                model_id: input.model_id.clone(),
                used_tokens,
                snapshot: snapshot.clone(),
            },
        );
        let snapshot = snapshot?;

        let previous_percent = previous.and_then(|p| p.snapshot).map(|s| s.used_percent);
        if previous_percent != Some(snapshot.used_percent) {
            self.events.emit_usage(&ContextUsageEvent {
                user_id: input.user_id,
                snapshot: snapshot.clone(),
            });
        }

        Some(snapshot)
    }

    /// Persist the turn's final measurement. One write per turn rather than per step.
    /// The meter, Auto tier selection and idle compaction after a restart read it. A DB
    /// error is logged (`[ContextUsage] failed to persist snapshot`) and swallowed,
    /// since the next turn writes the column again.
    pub async fn finalize(&self, thread_id: &str) {
        let Some(tracked) = self.tracked.lock().remove(thread_id) else {
            return;
        };

        if let Err(err) = CONVERSATION_SERVICE
            .set_thread_context_usage(thread_id, tracked.used_tokens, &tracked.model_id)
            .await
        {
            log_error!(
                json!({ "err": err_json(&err), "threadId": thread_id }),
                "[ContextUsage] failed to persist snapshot"
            );
        }
    }

    /// Rebuild a snapshot from the columns stored on a thread, for read paths (a
    /// page reload or a resumed CLI session). Recomputes the percentage against
    /// `context_model`'s window rather than the agent's current model, so a stale
    /// measurement is never reinterpreted against a different window.
    pub fn from_stored(
        &self,
        thread_id: &str,
        context_tokens: Option<i64>,
        context_model: Option<&str>,
    ) -> Option<ContextUsageSnapshot> {
        build_context_snapshot(thread_id, context_model, context_tokens)
    }

    /// Drop in-flight state for a thread without persisting (e.g. thread deleted).
    pub fn forget(&self, thread_id: &str) {
        self.tracked.lock().remove(thread_id);
    }

    /// Apply a post-compaction occupancy estimate: emit a usage frame so the
    /// clients' meters drop immediately, and persist it as the thread's stored
    /// snapshot so a reload shows the same number. The estimate (chars/4 over the
    /// rebuilt context) undershoots the real prompt — it ignores the system prompt
    /// and tools — and self-corrects on the next turn's provider-reported usage.
    ///
    /// Deliberately does not touch the per-turn `tracked` map: compaction runs
    /// under the thread mutex, so no turn is in flight for this thread and there
    /// is no entry to reconcile. The write runs in the background; a failure is
    /// logged (`[ContextUsage] failed to persist estimate`).
    ///
    /// When the model's window is unknown it persists the estimate, emits nothing and
    /// returns `None`. It never reports a made-up percent.
    pub fn apply_estimate(&self, input: EstimateInput) -> Option<ContextUsageSnapshot> {
        let snapshot = build_context_snapshot(
            &input.thread_id,
            Some(&input.model_id),
            Some(input.used_tokens),
        );
        let thread_id = input.thread_id.clone();
        let model_id = input.model_id.clone();
        let used_tokens = input.used_tokens;
        tokio::spawn(async move {
            if let Err(err) = CONVERSATION_SERVICE
                .set_thread_context_usage(&thread_id, used_tokens, &model_id)
                .await
            {
                log_error!(
                    json!({ "err": err_json(&err), "threadId": thread_id }),
                    "[ContextUsage] failed to persist estimate"
                );
            }
        });
        let snapshot = snapshot?;

        self.events.emit_usage(&ContextUsageEvent {
            user_id: input.user_id,
            snapshot: snapshot.clone(),
        });
        Some(snapshot)
    }
}

impl Default for ContextUsageService {
    fn default() -> Self {
        Self::new()
    }
}

pub static CONTEXT_USAGE_SERVICE: LazyLock<ContextUsageService> =
    LazyLock::new(ContextUsageService::new);

#[cfg(test)]
mod tests {
    use diesel::prelude::*;

    use super::*;
    use crate::db::models::{NewAgentWorkspace, NewConversationThread};
    use crate::db::schema::{agent_workspaces, conversation_threads};

    // A 1M window, so token counts map to percentages at a 10,000:1 ratio.
    const MODEL: &str = "us.anthropic.claude-opus-5";
    const WINDOW: i64 = 1_000_000;

    fn input(input_tokens: Option<i64>, output_tokens: Option<i64>) -> RecordInput {
        RecordInput {
            user_id: "user-1".into(),
            thread_id: "thread-1".into(),
            model_id: MODEL.into(),
            input_tokens,
            output_tokens,
        }
    }

    fn capture(service: &ContextUsageService) -> Arc<Mutex<Vec<ContextUsageEvent>>> {
        let seen: Arc<Mutex<Vec<ContextUsageEvent>>> = Arc::default();
        let sink = Arc::clone(&seen);
        service
            .events
            .on_usage(move |event| sink.lock().push(event.clone()));
        seen
    }

    /// A database with the agent and `thread-1`, whose stored measurement the
    /// service writes.
    fn seeded() -> crate::db::testing::TestDb {
        let test = crate::db::testing::test_db();
        test.db
            .run_sync(|conn| {
                let mut agent =
                    NewAgentWorkspace::new("user-1", "soul", "user", "memory", "heartbeat", "");
                agent.id = "agent-1".into();
                diesel::insert_into(agent_workspaces::table)
                    .values(&agent)
                    .execute(conn)?;
                let mut thread = NewConversationThread::new("agent-1", "user-1");
                thread.id = "thread-1".into();
                diesel::insert_into(conversation_threads::table)
                    .values(&thread)
                    .execute(conn)?;
                Ok(())
            })
            .unwrap();
        test
    }

    fn stored(test: &crate::db::testing::TestDb) -> (Option<i64>, Option<String>) {
        test.db
            .run_sync(|conn| {
                Ok(conversation_threads::table
                    .filter(conversation_threads::id.eq("thread-1"))
                    .select((
                        conversation_threads::context_tokens,
                        conversation_threads::context_model,
                    ))
                    .first::<(Option<i64>, Option<String>)>(conn)?)
            })
            .unwrap()
    }

    #[test]
    fn counts_input_plus_output_tokens() {
        // Output counts because the reply becomes part of the next prompt.
        let service = ContextUsageService::new();
        let snapshot = service.record(input(Some(400_000), Some(100_000)));
        assert_eq!(
            snapshot,
            Some(ContextUsageSnapshot {
                thread_id: "thread-1".into(),
                model_id: MODEL.into(),
                used_tokens: 500_000,
                window_tokens: WINDOW,
                used_percent: 50,
            })
        );
    }

    #[test]
    fn does_not_add_cache_tokens_on_top_of_input_tokens() {
        let service = ContextUsageService::new();
        assert_eq!(
            service
                .record(input(Some(100_000), None))
                .map(|s| s.used_percent),
            Some(10)
        );
    }

    #[test]
    fn returns_none_and_emits_nothing_when_the_provider_reported_no_usage() {
        let service = ContextUsageService::new();
        let seen = capture(&service);
        assert_eq!(service.record(input(None, Some(0))), None);
        assert!(seen.lock().is_empty());
    }

    #[test]
    fn returns_none_and_emits_nothing_when_the_model_window_is_unknown() {
        let service = ContextUsageService::new();
        let seen = capture(&service);
        let mut unknown = input(Some(100_000), None);
        unknown.model_id = "my-custom-deploy".into();
        assert_eq!(service.record(unknown), None);
        assert!(seen.lock().is_empty());
    }

    #[test]
    fn emits_once_per_changed_integer_percentage_not_once_per_step() {
        let service = ContextUsageService::new();
        let seen = capture(&service);
        service.record(input(Some(100_000), None));
        service.record(input(Some(100_400), None)); // still 10%: no emit
        service.record(input(Some(150_000), None));
        let percents: Vec<i64> = seen
            .lock()
            .iter()
            .map(|e| e.snapshot.used_percent)
            .collect();
        assert_eq!(percents, [10, 15]);
    }

    #[test]
    fn includes_the_user_id_on_the_emitted_event_before_the_snapshot() {
        let service = ContextUsageService::new();
        let seen = capture(&service);
        service.record(input(Some(100_000), None));
        assert_eq!(
            serde_json::to_string(&seen.lock()[0]).unwrap(),
            format!(
                "{{\"userId\":\"user-1\",\"threadId\":\"thread-1\",\"modelId\":\"{MODEL}\",\"usedTokens\":100000,\"windowTokens\":1000000,\"usedPercent\":10}}"
            )
        );
    }

    #[test]
    fn clamps_the_percentage_to_0_through_100() {
        let service = ContextUsageService::new();
        assert_eq!(
            service
                .record(input(Some(WINDOW * 3), None))
                .map(|s| s.used_percent),
            Some(100)
        );
        assert_eq!(
            service
                .record(input(Some(0), Some(0)))
                .map(|s| s.used_percent),
            Some(0)
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finalize_persists_the_last_measurement_once_and_then_forgets_the_thread() {
        let test = seeded();
        let service = ContextUsageService::new();
        service.record(input(Some(100_000), None));
        service.record(input(Some(412_300), None));

        service.finalize("thread-1").await;
        assert_eq!(stored(&test), (Some(412_300), Some(MODEL.to_string())));

        service.record(input(Some(1), None));
        service.forget("thread-1");
        service.finalize("thread-1").await;
        assert_eq!(stored(&test), (Some(412_300), Some(MODEL.to_string())));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn still_persists_the_measurement_of_a_model_whose_window_is_unknown() {
        let test = seeded();
        let service = ContextUsageService::new();
        let mut unknown = input(Some(250_000), None);
        unknown.model_id = "my-custom-deploy".into();
        service.record(unknown);
        service.finalize("thread-1").await;
        assert_eq!(
            stored(&test),
            (Some(250_000), Some("my-custom-deploy".to_string()))
        );
    }

    #[tokio::test]
    async fn finalize_does_nothing_when_no_step_recorded_usage() {
        ContextUsageService::new().finalize("never-tracked").await;
    }

    #[test]
    fn rebuilds_a_snapshot_from_the_stored_columns_against_the_stored_model() {
        let service = ContextUsageService::new();
        assert_eq!(
            service.from_stored("thread-9", Some(250_000), Some(MODEL)),
            Some(ContextUsageSnapshot {
                thread_id: "thread-9".into(),
                model_id: MODEL.into(),
                used_tokens: 250_000,
                window_tokens: WINDOW,
                used_percent: 25,
            })
        );
        let haiku = service
            .from_stored("thread-9", Some(100_000), Some("claude-haiku-4-5"))
            .unwrap();
        assert_eq!((haiku.window_tokens, haiku.used_percent), (200_000, 50));
        assert_eq!(service.from_stored("thread-9", None, None), None);
        assert_eq!(service.from_stored("thread-9", Some(100), None), None);
        assert_eq!(service.from_stored("thread-9", None, Some(MODEL)), None);
        assert_eq!(
            service.from_stored("thread-9", Some(100_000), Some("retired-deploy")),
            None
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn apply_estimate_emits_a_usage_frame_and_persists_it() {
        let test = seeded();
        let service = ContextUsageService::new();
        let seen = capture(&service);
        let snapshot = service
            .apply_estimate(EstimateInput {
                user_id: "user-1".into(),
                thread_id: "thread-1".into(),
                model_id: MODEL.into(),
                used_tokens: 50_000,
            })
            .unwrap();
        assert_eq!((snapshot.used_tokens, snapshot.used_percent), (50_000, 5));
        assert_eq!(seen.lock().len(), 1);
        assert_eq!(seen.lock()[0].user_id, "user-1");
        for _ in 0..100 {
            if stored(&test).0 == Some(50_000) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(stored(&test), (Some(50_000), Some(MODEL.to_string())));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn apply_estimate_persists_but_emits_nothing_when_the_window_is_unknown() {
        let test = seeded();
        let service = ContextUsageService::new();
        let seen = capture(&service);
        let snapshot = service.apply_estimate(EstimateInput {
            user_id: "user-1".into(),
            thread_id: "thread-1".into(),
            model_id: "my-custom-deploy".into(),
            used_tokens: 50_000,
        });
        assert_eq!(snapshot, None);
        assert!(seen.lock().is_empty());
        for _ in 0..100 {
            if stored(&test).0 == Some(50_000) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            stored(&test),
            (Some(50_000), Some("my-custom-deploy".to_string()))
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn apply_estimate_leaves_the_per_turn_measurement_alone() {
        let test = seeded();
        let service = ContextUsageService::new();
        service.record(input(Some(400_000), None));
        service.apply_estimate(EstimateInput {
            user_id: "user-1".into(),
            thread_id: "thread-1".into(),
            model_id: MODEL.into(),
            used_tokens: 10,
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        service.finalize("thread-1").await;
        // finalize persists the recorded turn measurement, not the estimate.
        assert_eq!(stored(&test), (Some(400_000), Some(MODEL.to_string())));
    }
}
