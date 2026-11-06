//! Notices a Slack Socket Mode client that stays disconnected.
//!
//! After a socket drop the client asks Slack for a new socket address with
//! `apps.connections.open`. The client can wait on that request for hours, and
//! it emits nothing while it waits. A new socket can also open and then wait for
//! Slack's `hello` for ever. The adapter rebuilds the app when this watch fires.

use tokio::sync::broadcast;
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
    todo!()
}
