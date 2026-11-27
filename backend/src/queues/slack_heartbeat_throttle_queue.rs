//! Slack Heartbeat Throttle Queue
//!
//! When a Slack message arrives during a throttle cooldown the heartbeat cannot
//! fire right away, but the trigger must not be dropped either: a lone incoming
//! message would be lost for up to the cooldown window. It is deferred: a timer
//! re-attempts the claim when the window expires.
//!
//! In-memory timers keyed by agent id. At most one pending timer per agent;
//! re-scheduling cancels the previous one. The timers never keep the process
//! alive on their own, and `stop()` clears them on graceful shutdown.
//!
//! In practice the window is seconds to minutes, and if the process does restart
//! inside that window the next incoming Slack message re-triggers the heartbeat
//! anyway.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use tokio::task::AbortHandle;

use crate::lib::log_redaction::err_json;
use crate::services::heartbeat_service::HEARTBEAT_SERVICE;
use crate::services::slack_heartbeat_trigger_service::{
    ClaimResult, SLACK_HEARTBEAT_TRIGGER_SERVICE,
};
use crate::services::slack_message_queue_service::slack_trigger_source;
use crate::{log_error, log_info};

pub struct SlackHeartbeatThrottleQueue {
    timers: Mutex<HashMap<String, AbortHandle>>,
}

impl Default for SlackHeartbeatThrottleQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl SlackHeartbeatThrottleQueue {
    pub fn new() -> Self {
        Self {
            timers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn start(&self) {
        log_info!("[ThrottleQueue] started (in-memory)");
    }

    /// Schedule a deferred trigger for an agent. If one is already pending for
    /// the same agent, the previous timer is cancelled (singleton-per-agent).
    pub async fn schedule_deferred(self: &Arc<Self>, agent_id: &str, delay_seconds: i64) {
        let queue = self.clone();
        let agent = agent_id.to_string();
        let delay = Duration::from_millis((delay_seconds.max(0) as u64).saturating_mul(1000));
        let mut timers = self.timers.lock();
        if let Some(existing) = timers.remove(agent_id) {
            existing.abort();
        }
        let task = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            queue.fire(&agent).await;
        });
        timers.insert(agent_id.to_string(), task.abort_handle());
        drop(timers);

        log_info!(
            json!({ "agentId": agent_id, "delaySeconds": delay_seconds }),
            "[ThrottleQueue] Scheduled deferred trigger for agent {} in {}s",
            agent_id,
            delay_seconds
        );
    }

    pub async fn stop(&self) {
        for (_, timer) in self.timers.lock().drain() {
            timer.abort();
        }
        log_info!("[ThrottleQueue] Stopped");
    }

    /// Removes the agent's timer, then claims the trigger
    /// (`SLACK_HEARTBEAT_TRIGGER_SERVICE.try_claim_trigger()`). Claimed: the
    /// heartbeat runs from the Slack message queue
    /// (`HEARTBEAT_SERVICE.trigger_from(slack message queue)`) and
    /// `[ThrottleQueue] Triggered heartbeat for agent {}` is logged; otherwise
    /// `[ThrottleQueue] Trigger still throttled for agent {}, skipping`. A failure
    /// logs `[ThrottleQueue] Failed to trigger heartbeat for agent {}` with
    /// `{ err, agentId }`. Every line has `{ agentId }`.
    async fn fire(&self, agent_id: &str) {
        self.fire_with(
            agent_id,
            || SLACK_HEARTBEAT_TRIGGER_SERVICE.try_claim_trigger(),
            || {
                HEARTBEAT_SERVICE.trigger_from(&slack_trigger_source());
            },
        )
        .await;
    }

    async fn fire_with<C, F>(&self, agent_id: &str, claim: C, trigger: impl FnOnce())
    where
        C: FnOnce() -> F,
        F: Future<Output = anyhow::Result<ClaimResult>>,
    {
        self.timers.lock().remove(agent_id);
        log_info!(
            json!({ "agentId": agent_id }),
            "[ThrottleQueue] Deferred trigger firing for agent {}",
            agent_id
        );

        match claim().await {
            Ok(result) if result.claimed => {
                trigger();
                log_info!(
                    json!({ "agentId": agent_id }),
                    "[ThrottleQueue] Triggered heartbeat for agent {}",
                    agent_id
                );
            }
            Ok(_) => {
                log_info!(
                    json!({ "agentId": agent_id }),
                    "[ThrottleQueue] Trigger still throttled for agent {}, skipping",
                    agent_id
                );
            }
            Err(error) => {
                log_error!(
                    json!({ "err": err_json(&error), "agentId": agent_id }),
                    "[ThrottleQueue] Failed to trigger heartbeat for agent {}",
                    agent_id
                );
            }
        }
    }
}

static INSTANCE: LazyLock<Mutex<Option<Arc<SlackHeartbeatThrottleQueue>>>> =
    LazyLock::new(|| Mutex::new(None));

/// The process's queue, made on first use.
pub fn get_slack_heartbeat_throttle_queue() -> Arc<SlackHeartbeatThrottleQueue> {
    INSTANCE
        .lock()
        .get_or_insert_with(|| Arc::new(SlackHeartbeatThrottleQueue::new()))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A queue whose timers fire the given claim instead of the trigger service.
    struct Probe {
        claims: Arc<AtomicUsize>,
        triggers: Arc<AtomicUsize>,
    }

    impl Probe {
        fn new() -> Self {
            Probe {
                claims: Arc::new(AtomicUsize::new(0)),
                triggers: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// Schedules as `schedule_deferred` does, firing through `fire_with`.
        fn schedule(
            &self,
            queue: &Arc<SlackHeartbeatThrottleQueue>,
            agent_id: &str,
            delay_seconds: u64,
            result: anyhow::Result<ClaimResult>,
        ) {
            let queue_for_task = queue.clone();
            let agent = agent_id.to_string();
            let claims = self.claims.clone();
            let triggers = self.triggers.clone();
            let result = result.map_err(|e| e.to_string());
            let mut timers = queue.timers.lock();
            if let Some(existing) = timers.remove(agent_id) {
                existing.abort();
            }
            let task = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(delay_seconds)).await;
                queue_for_task
                    .fire_with(
                        &agent,
                        move || async move {
                            claims.fetch_add(1, Ordering::SeqCst);
                            result.map_err(|e| anyhow::anyhow!(e))
                        },
                        move || {
                            triggers.fetch_add(1, Ordering::SeqCst);
                        },
                    )
                    .await;
            });
            timers.insert(agent_id.to_string(), task.abort_handle());
        }
    }

    fn claimed(claimed: bool) -> anyhow::Result<ClaimResult> {
        Ok(ClaimResult {
            claimed,
            remaining_seconds: None,
        })
    }

    async fn advance(seconds: u64) {
        // Let each timer task start its sleep before the clock moves.
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(seconds)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fires_after_the_delay_and_claims_the_trigger() {
        let queue = Arc::new(SlackHeartbeatThrottleQueue::new());
        let probe = Probe::new();
        probe.schedule(&queue, "agent-1", 5, claimed(true));
        advance(4).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 0);
        advance(1).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 1);
        assert_eq!(probe.triggers.load(Ordering::SeqCst), 1);
        assert!(queue.timers.lock().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_trigger_the_heartbeat_while_still_throttled() {
        let queue = Arc::new(SlackHeartbeatThrottleQueue::new());
        let probe = Probe::new();
        probe.schedule(&queue, "agent-2", 3, claimed(false));
        advance(3).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 1);
        assert_eq!(probe.triggers.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn rescheduling_replaces_the_previous_timer_for_the_agent() {
        let queue = Arc::new(SlackHeartbeatThrottleQueue::new());
        let probe = Probe::new();
        probe.schedule(&queue, "agent-3", 10, claimed(true));
        probe.schedule(&queue, "agent-3", 2, claimed(true));
        advance(2).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 1);
        advance(20).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn stop_cancels_every_pending_timer() {
        let queue = Arc::new(SlackHeartbeatThrottleQueue::new());
        let probe = Probe::new();
        probe.schedule(&queue, "a", 5, claimed(true));
        probe.schedule(&queue, "b", 5, claimed(true));
        queue.stop().await;
        advance(10).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_claim_triggers_nothing() {
        let queue = Arc::new(SlackHeartbeatThrottleQueue::new());
        let probe = Probe::new();
        probe.schedule(&queue, "agent-4", 1, Err(anyhow::anyhow!("boom")));
        advance(2).await;
        assert_eq!(probe.claims.load(Ordering::SeqCst), 1);
        assert_eq!(probe.triggers.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_queue_is_a_singleton() {
        let a = get_slack_heartbeat_throttle_queue();
        let b = get_slack_heartbeat_throttle_queue();
        assert!(Arc::ptr_eq(&a, &b));
    }
}
