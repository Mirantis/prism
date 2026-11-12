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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn lets_a_call_through_while_nothing_holds_it() {
        let gate = InferenceGate::new();
        gate.wait(None).await.unwrap();
    }

    #[tokio::test]
    async fn holds_a_call_until_the_window_closes() {
        let gate = Arc::new(InferenceGate::new());
        gate.hold();
        let waiting = gate.clone();
        let call = tokio::spawn(async move { waiting.wait(None).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!call.is_finished());

        gate.free();
        call.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn holds_once_however_many_times_it_is_asked() {
        let gate = Arc::new(InferenceGate::new());
        gate.hold();
        gate.hold();
        let waiting = gate.clone();
        let call = tokio::spawn(async move { waiting.wait(None).await });
        gate.free();
        call.await.unwrap().unwrap();
        assert!(!gate.held());
    }

    #[tokio::test]
    async fn lets_an_aborted_caller_through_while_nothing_holds_it() {
        let gate = InferenceGate::new();
        let signal = CancellationToken::new();
        signal.cancel();
        gate.wait(Some(&signal)).await.unwrap();
    }

    #[tokio::test]
    async fn gives_up_on_a_caller_that_aborts_while_it_waits() {
        let gate = Arc::new(InferenceGate::new());
        gate.hold();
        let signal = CancellationToken::new();
        let waiting = gate.clone();
        let token = signal.clone();
        let call = tokio::spawn(async move { waiting.wait(Some(&token)).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        signal.cancel();
        let error = call.await.unwrap().unwrap_err();
        assert_eq!(error.to_string(), ABORTED_MESSAGE);
    }
}
