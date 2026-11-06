//! The webhook listener: `POST /agents/webhooks/:name` on its own port
//! (`WEBHOOK_PORT`), open only while the receiver is enabled.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Router;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::lib::telemetry::track_event;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::{log_error, log_info};

/// The webhook listener serves deliveries on their own port: JSON bodies up to
/// 5 MB with the raw bytes kept for signature checks, and the webhook router
/// under `/agents`.
pub fn create_webhook_app() -> Router {
    todo!()
}

/// The listener while it is open: what stops it and the task that serves it.
pub struct ListeningServer {
    /// Cancelled to stop accepting and to close every open connection.
    pub shutdown: CancellationToken,
    /// The task serving the listener; it ends once the listener and its
    /// connections are closed.
    pub task: JoinHandle<()>,
}

pub struct WebhookReceiverService {
    /// The open listener, `None` while the receiver is disabled.
    server: parking_lot::Mutex<Option<ListeningServer>>,
    /// Serializes socket changes and their saved state across concurrent
    /// requests, in arrival order.
    pending: tokio::sync::Mutex<()>,
    stopping: AtomicBool,
}

impl WebhookReceiverService {
    pub fn new() -> Self {
        WebhookReceiverService {
            server: parking_lot::Mutex::new(None),
            pending: tokio::sync::Mutex::new(()),
            stopping: AtomicBool::new(false),
        }
    }

    /// Whether the listener is open.
    pub fn enabled(&self) -> bool {
        self.server.lock().is_some()
    }

    /// Restore the saved receiver state before the management API starts.
    pub async fn initialize(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Open or close the listener and save the setting. Fails while shutting
    /// down ("Webhook receiver is shutting down") and when the port cannot be
    /// opened.
    pub async fn set_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        todo!()
    }

    async fn apply_enabled(&self, agent_id: &str, enabled: bool) -> anyhow::Result<()> {
        todo!()
    }

    /// Open the listener on `CONFIG.webhook_port` at `CONFIG.host`. A taken port
    /// fails with "Cannot enable webhooks on port <port>. The port is already in
    /// use. Choose a free WEBHOOK_PORT and restart."
    async fn start(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Close the listener and every connection it holds.
    async fn stop(&self) -> anyhow::Result<()> {
        todo!()
    }
}

impl Default for WebhookReceiverService {
    fn default() -> Self {
        Self::new()
    }
}

pub static WEBHOOK_RECEIVER_SERVICE: LazyLock<WebhookReceiverService> =
    LazyLock::new(WebhookReceiverService::new);
