//! Notices a Slack Socket Mode client that stays disconnected.
//!
//! After a socket drop the client asks Slack for a new socket address with
//! `apps.connections.open`. The client can wait on that request for hours, and
//! it emits nothing while it waits. A new socket can also open and then wait for
//! Slack's `hello` for ever. The adapter rebuilds the app when this watch fires.

use std::time::Duration;

use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::AbortHandle;

/// How long a client may stay without `connected` before the adapter rebuilds it.
/// A normal start or reconnect reports `connected` within seconds.
pub const SOCKET_STALL_MS: u64 = 3 * 60_000;

/// The lifecycle events of a Socket Mode client that the watch reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketLifecycleEvent {
    Connected,
    Reconnecting,
    Disconnected,
}

/// A running watch. `stop` ends it; dropping the handle does not.
#[derive(Debug)]
pub struct SocketWatch {
    task: AbortHandle,
}

impl SocketWatch {
    /// Stops the watch, so `on_stall` is not called.
    pub fn stop(&self) {
        self.task.abort();
    }
}

/// Calls `on_stall` once when the client has not reported `Connected` for
/// `SOCKET_STALL_MS`. The window starts now, since a new client is not connected,
/// and again at the first `Reconnecting` or `Disconnected` after a `Connected`.
/// Returns the handle that stops the watch.
pub fn watch_socket(
    events: broadcast::Receiver<SocketLifecycleEvent>,
    on_stall: impl FnOnce() + Send + 'static,
) -> SocketWatch {
    watch_socket_for(events, Duration::from_millis(SOCKET_STALL_MS), on_stall)
}

fn watch_socket_for(
    mut events: broadcast::Receiver<SocketLifecycleEvent>,
    stall: Duration,
    on_stall: impl FnOnce() + Send + 'static,
) -> SocketWatch {
    let task = tokio::spawn(async move {
        // The window starts now: a new client is not connected.
        let mut deadline = Some(tokio::time::Instant::now() + stall);
        let mut open = true;
        loop {
            let timer = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                event = events.recv(), if open => match event {
                    Ok(SocketLifecycleEvent::Connected) => deadline = None,
                    Ok(SocketLifecycleEvent::Reconnecting | SocketLifecycleEvent::Disconnected) => {
                        // Armed once; a later drop leaves the running window as it is.
                        deadline.get_or_insert_with(|| tokio::time::Instant::now() + stall);
                    }
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => open = false,
                },
                _ = timer => {
                    on_stall();
                    return;
                }
            }
        }
    });
    SocketWatch {
        task: task.abort_handle(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const STALL: Duration = Duration::from_millis(SOCKET_STALL_MS);

    fn counter() -> (Arc<AtomicUsize>, impl FnOnce() + Send + 'static) {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        (count, move || {
            seen.fetch_add(1, Ordering::SeqCst);
        })
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fires_once_when_a_new_client_never_connects() {
        let (tx, rx) = broadcast::channel(8);
        let (count, on_stall) = counter();
        let _watch = watch_socket(rx, on_stall);
        settle().await;
        tokio::time::advance(STALL - Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_millis(2)).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_disarms_and_a_drop_arms_again() {
        let (tx, rx) = broadcast::channel(8);
        let (count, on_stall) = counter();
        let _watch = watch_socket(rx, on_stall);
        tx.send(SocketLifecycleEvent::Connected).unwrap();
        settle().await;
        tokio::time::advance(STALL * 2).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);

        tx.send(SocketLifecycleEvent::Reconnecting).unwrap();
        settle().await;
        tokio::time::advance(STALL / 2).await;
        settle().await;
        // A second drop leaves the window where the first one started it.
        tx.send(SocketLifecycleEvent::Disconnected).unwrap();
        settle().await;
        tokio::time::advance(STALL / 2 + Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stopped_watch_never_fires() {
        let (_tx, rx) = broadcast::channel(8);
        let (count, on_stall) = counter();
        let watch = watch_socket(rx, on_stall);
        watch.stop();
        tokio::time::advance(STALL * 2).await;
        settle().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
}
