//! Work a request starts in the background, held until the request's caller has
//! answered it.
//!
//! In Node a promise left running (`void work()`) runs only between awaits, so the
//! caller that awaited the request sends its answer first: a chat message's `ack`
//! goes out before the turn or the title upgrade the message started sends
//! anything. A spawned task runs on another thread at once, so the same work is
//! spawned through [`spawn_after_accept`] and waits on the gate the request runs
//! inside, which the caller opens by dropping its [`AcceptGate`].

use std::future::Future;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::Shared;
use tokio::sync::oneshot;

tokio::task_local! {
    static GATE: Shared<oneshot::Receiver<()>>;
}

/// Held by the caller until it has answered; dropping it lets the held work run.
#[derive(Debug, Clone)]
pub struct AcceptGate(#[allow(dead_code)] Arc<oneshot::Sender<()>>);

/// Run `request` inside a gate. Work it spawns through [`spawn_after_accept`] waits
/// until the returned [`AcceptGate`] and all its clones are dropped.
pub async fn within_gate<T>(request: impl Future<Output = T>) -> (T, AcceptGate) {
    let (open, wait) = oneshot::channel::<()>();
    let result = GATE.scope(wait.shared(), request).await;
    (result, AcceptGate(Arc::new(open)))
}

/// Spawn `work`, held behind the gate of the request it is started from, if any.
pub fn spawn_after_accept<F>(work: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let gate = GATE.try_with(Clone::clone).ok();
    tokio::spawn(async move {
        if let Some(gate) = gate {
            // Opens when the sender is dropped; nothing is ever sent on it.
            let _ = gate.await;
        }
        work.await;
    });
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    #[tokio::test]
    async fn holds_spawned_work_until_the_gate_is_dropped() {
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        let ((), gate) = within_gate(async move {
            spawn_after_accept(async move { flag.store(true, Ordering::SeqCst) });
        })
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!ran.load(Ordering::SeqCst));
        drop(gate);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(ran.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn runs_at_once_outside_a_gate() {
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        spawn_after_accept(async move { flag.store(true, Ordering::SeqCst) });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(ran.load(Ordering::SeqCst));
    }
}
