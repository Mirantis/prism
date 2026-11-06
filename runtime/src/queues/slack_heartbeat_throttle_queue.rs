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
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use serde_json::json;
use tokio::task::AbortHandle;

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
        todo!()
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
        todo!()
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

/// Test-only: reset the singleton so each test starts clean.
pub fn reset_slack_heartbeat_throttle_queue_for_tests() {
    *INSTANCE.lock() = None;
}
