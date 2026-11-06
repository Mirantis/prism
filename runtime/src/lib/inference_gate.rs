//! A window in which this runtime calls no model.
//!
//! `model_call.rs` is the one place a model is called, so a gate there stops every
//! kind of turn at once — chat, goals, heartbeat, cron and the classification
//! gates. A secure takeover of the computer is what holds it: while somebody types a
//! password on the agent's desktop, the agent decides nothing, so it cannot decide
//! to look at the screen or to run a command that does.
//!
//! Nothing in flight is interrupted. A model call already sent finishes and its
//! tool calls run, which is why the computer's own gate and the process suspension
//! cover that step; this gate covers the next one.

use std::sync::LazyLock;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// The error a wait ends with when its caller aborts: the text of the DOM
/// `AbortError` an aborted signal throws.
pub const ABORTED_MESSAGE: &str = "This operation was aborted";

pub struct InferenceGate {
    /// Whether the gate is held. Waiters watch it fall to `false`.
    held: watch::Sender<bool>,
}

impl InferenceGate {
    pub fn new() -> Self {
        Self {
            held: watch::Sender::new(false),
        }
    }

    /// Whether something holds the gate.
    pub fn held(&self) -> bool {
        *self.held.borrow()
    }

    /// Hold the gate. Calling it twice holds it once; `free` opens it either way.
    pub fn hold(&self) {
        self.held.send_if_modified(|held| {
            if *held {
                return false;
            }
            *held = true;
            true
        });
    }

    pub fn free(&self) {
        self.held.send_if_modified(|held| {
            let was_held = *held;
            *held = false;
            was_held
        });
    }

    /// Returns at once while nothing holds the gate, and fails if the caller aborts
    /// while it waits.
    ///
    /// The abort is only read while there is something to wait for. This gate delays
    /// a call, it does not cancel one, and a caller that asks about a gate nobody
    /// holds is answered rather than told its turn is over.
    pub async fn wait(&self, signal: Option<&CancellationToken>) -> anyhow::Result<()> {
        let mut held = self.held.subscribe();
        loop {
            if !*held.borrow_and_update() {
                return Ok(());
            }
            if signal.is_some_and(|signal| signal.is_cancelled()) {
                anyhow::bail!(ABORTED_MESSAGE);
            }
            match signal {
                Some(signal) => {
                    tokio::select! {
                        changed = held.changed() => { let _ = changed; }
                        _ = signal.cancelled() => anyhow::bail!(ABORTED_MESSAGE),
                    }
                }
                None => {
                    let _ = held.changed().await;
                }
            }
        }
    }
}

impl Default for InferenceGate {
    fn default() -> Self {
        Self::new()
    }
}

pub static INFERENCE_GATE: LazyLock<InferenceGate> = LazyLock::new(InferenceGate::new);
