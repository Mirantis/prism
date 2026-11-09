//! The webhook listener: `POST /agents/webhooks/:name` on its own port
//! (`WEBHOOK_PORT`), open only while the receiver is enabled.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::anyhow;
use axum::Router;
use axum::extract::ConnectInfo;
use diesel::prelude::*;
use indexmap::IndexMap;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower::{Layer, ServiceExt};
use tower_http::normalize_path::NormalizePathLayer;

use crate::config::CONFIG;
use crate::db::models::AgentWorkspaceChangeset;
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::routes::webhook::WEBHOOK_BODY_LIMIT_BYTES;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::support::http::{JsonOptions, finish, with_json_body};
use crate::{log_error, log_info};

/// The webhook listener serves deliveries on their own port: JSON bodies up to
/// 5 MB with the raw bytes kept for signature checks, and the webhook router
/// under `/agents`.
pub fn create_webhook_app() -> Router {
    with_json_body(
        finish(crate::routes::webhook::router()),
        JsonOptions::limit(WEBHOOK_BODY_LIMIT_BYTES).keeping_raw_body(),
    )
}

/// The listener while it is open: what stops it and the task that serves it.
pub struct ListeningServer {
    /// Cancelled to stop accepting and to close every open connection.
    pub shutdown: CancellationToken,
    /// The task serving the listener; it ends once the listener and its
    /// connections are closed.
    pub task: JoinHandle<()>,
}

/// Serve `router` on `listener` until `shutdown` is cancelled, then close the
/// listener and every connection it accepted, requests in flight included, as
/// `server.close()` with `closeAllConnections()` does. Express's routing is not
/// strict, so a path with a trailing slash is routed as the path without it.
async fn serve_until_closed(listener: TcpListener, router: Router, shutdown: CancellationToken) {
    let app = NormalizePathLayer::trim_trailing_slash().layer(router);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                let Ok((stream, remote)) = accepted else {
                    continue;
                };
                let app = app.clone();
                connections.spawn(async move {
                    let service = hyper::service::service_fn(
                        move |mut request: http::Request<hyper::body::Incoming>| {
                            request.extensions_mut().insert(ConnectInfo::<SocketAddr>(remote));
                            let app = app.clone();
                            async move {
                                let response = app
                                    .oneshot(request.map(axum::body::Body::new))
                                    .await
                                    .unwrap_or_else(|never: Infallible| match never {});
                                Ok::<_, Infallible>(response)
                            }
                        },
                    );
                    let _ = hyper_util::server::conn::auto::Builder::new(
                        hyper_util::rt::TokioExecutor::new(),
                    )
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
                });
            }
        }
        while connections.try_join_next().is_some() {}
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
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
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        if !agent.webhooks_enabled {
            return Ok(());
        }
        if let Err(error) = self.start().await {
            track_event(
                "webhook receiver toggle failed",
                Some(&agent.user_id),
                Some(IndexMap::from([
                    ("agent.id".to_string(), agent.id.clone()),
                    ("webhook.operation".to_string(), "startup".to_string()),
                ])),
            );
            log_error!(
                json!({ "err": err_json(&error) }),
                "[Webhook] Receiver could not start; restart to retry"
            );
        }
        Ok(())
    }

    /// Open or close the listener and save the setting. Fails while shutting
    /// down ("Webhook receiver is shutting down") and when the port cannot be
    /// opened.
    pub async fn set_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        let _turn = self.pending.lock().await;
        if self.stopping.load(Ordering::SeqCst) {
            return Err(anyhow!("Webhook receiver is shutting down"));
        }
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        match self.apply_enabled(&agent.id, enabled).await {
            Ok(()) => {
                track_event(
                    "webhook receiver toggled",
                    Some(&agent.user_id),
                    Some(IndexMap::from([
                        ("agent.id".to_string(), agent.id.clone()),
                        ("webhook.receiver_enabled".to_string(), enabled.to_string()),
                    ])),
                );
                Ok(())
            }
            Err(error) => {
                track_event(
                    "webhook receiver toggle failed",
                    Some(&agent.user_id),
                    Some(IndexMap::from([
                        ("agent.id".to_string(), agent.id.clone()),
                        (
                            "webhook.operation".to_string(),
                            if enabled { "enable" } else { "disable" }.to_string(),
                        ),
                    ])),
                );
                Err(error)
            }
        }
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.stopping.store(true, Ordering::SeqCst);
        let _turn = self.pending.lock().await;
        self.stop().await
    }

    /// Save the setting and open or close the listener: closing saves first, so
    /// the delivery gate closes before the connections do; opening saves after,
    /// and closes again when the save fails.
    async fn apply_enabled(&self, agent_id: &str, enabled: bool) -> anyhow::Result<()> {
        if !enabled {
            // Close the delivery gate before terminating existing connections.
            save_enabled(agent_id, false).await?;
            return self.stop().await;
        }
        self.start().await?;
        if let Err(error) = save_enabled(agent_id, true).await {
            self.stop().await?;
            return Err(error);
        }
        Ok(())
    }

    /// Open the listener on `CONFIG.webhook_port` at `CONFIG.host`. A taken port
    /// fails with "Cannot enable webhooks on port <port>. The port is already in
    /// use. Choose a free WEBHOOK_PORT and restart."
    async fn start(&self) -> anyhow::Result<()> {
        if self.enabled() {
            return Ok(());
        }
        let port = CONFIG.webhook_port;
        let host = CONFIG.host.clone();
        let listener = TcpListener::bind((host.as_str(), port))
            .await
            .map_err(|error| {
                let reason = if error.kind() == std::io::ErrorKind::AddrInUse {
                    "The port is already in use. Choose a free WEBHOOK_PORT and restart."
                        .to_string()
                } else {
                    error.to_string()
                };
                anyhow!("Cannot enable webhooks on port {port}. {reason}")
            })?;
        let shutdown = CancellationToken::new();
        let task = tokio::spawn(serve_until_closed(
            listener,
            create_webhook_app(),
            shutdown.clone(),
        ));
        *self.server.lock() = Some(ListeningServer { shutdown, task });
        log_info!(
            json!({ "port": port, "host": host }),
            "[Webhook] Receiver enabled"
        );
        Ok(())
    }

    /// Close the listener and every connection it holds.
    async fn stop(&self) -> anyhow::Result<()> {
        let Some(server) = self.server.lock().take() else {
            return Ok(());
        };
        server.shutdown.cancel();
        server.task.await?;
        log_info!("[Webhook] Receiver disabled");
        Ok(())
    }
}

/// Save the receiver switch on the agent row.
async fn save_enabled(agent_id: &str, enabled: bool) -> anyhow::Result<()> {
    let agent_id = agent_id.to_string();
    crate::db::run(move |conn| {
        let updated = diesel::update(aw::agent_workspaces.filter(aw::id.eq(&agent_id)))
            .set(&AgentWorkspaceChangeset {
                webhooks_enabled: Some(enabled),
                ..AgentWorkspaceChangeset::default()
            })
            .execute(conn)?;
        if updated == 0 {
            return Err(anyhow!("Record to update not found."));
        }
        Ok(())
    })
    .await
}

impl Default for WebhookReceiverService {
    fn default() -> Self {
        Self::new()
    }
}

pub static WEBHOOK_RECEIVER_SERVICE: LazyLock<WebhookReceiverService> =
    LazyLock::new(WebhookReceiverService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The configured port is fixed for the process, so these tests reach the
    /// listener through it and skip when something else holds it.
    async fn port_free() -> bool {
        TcpListener::bind((CONFIG.host.as_str(), CONFIG.webhook_port))
            .await
            .is_ok()
    }

    async fn fixture(enabled: bool) -> (crate::db::testing::TestDb, Option<String>) {
        let db = crate::db::testing::test_db();
        let mut agent = NewAgentWorkspace::new("user-1", "soul", "user", "memory", "heartbeat", "");
        agent.webhooks_enabled = enabled;
        let agent_id = agent.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(aw::agent_workspaces)
                .values(&agent)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        let previous = CONFIG.agent_id();
        CONFIG.set_agent_id(Some(agent_id));
        (db, previous)
    }

    async fn saved() -> bool {
        crate::db::run(|conn| {
            Ok(aw::agent_workspaces
                .select(aw::webhooks_enabled)
                .first(conn)?)
        })
        .await
        .unwrap()
    }

    async fn status_of(path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", CONFIG.webhook_port))
            .await
            .unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer.lines().next().unwrap_or_default().to_string()
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn leaves_the_port_closed_when_the_saved_setting_is_disabled() {
        if CONFIG.host != "127.0.0.1" || !port_free().await {
            return;
        }
        let (_db, previous) = fixture(false).await;
        let receiver = WebhookReceiverService::new();
        receiver.initialize().await.unwrap();
        assert!(!receiver.enabled());
        assert!(port_free().await);
        CONFIG.set_agent_id(previous);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn opens_on_enable_closes_on_disable_and_saves_each() {
        if CONFIG.host != "127.0.0.1" || !port_free().await {
            return;
        }
        let (_db, previous) = fixture(false).await;
        let receiver = WebhookReceiverService::new();
        receiver.set_enabled(true).await.unwrap();
        assert!(receiver.enabled());
        assert!(saved().await);
        assert_eq!(status_of("/health").await, "HTTP/1.1 404 Not Found");

        // An open connection with a request half sent is closed by the disable.
        let mut open = tokio::net::TcpStream::connect(("127.0.0.1", CONFIG.webhook_port))
            .await
            .unwrap();
        open.write_all(b"POST /agents/webhooks/alerts HTTP/1.1\r\n")
            .await
            .unwrap();
        receiver.set_enabled(false).await.unwrap();
        let mut rest = Vec::new();
        let _ = open.read_to_end(&mut rest).await;
        assert!(!receiver.enabled());
        assert!(!saved().await);
        assert!(port_free().await);
        receiver.shutdown().await.unwrap();
        CONFIG.set_agent_id(previous);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_a_taken_port_disabled_and_allows_a_later_enable() {
        if CONFIG.host != "127.0.0.1" || !port_free().await {
            return;
        }
        let (_db, previous) = fixture(false).await;
        let receiver = WebhookReceiverService::new();
        let reservation = TcpListener::bind(("127.0.0.1", CONFIG.webhook_port))
            .await
            .unwrap();
        let err = receiver.set_enabled(true).await.unwrap_err();
        assert!(err.to_string().contains("already in use"));
        assert!(!saved().await);
        assert!(!receiver.enabled());
        drop(reservation);

        receiver.set_enabled(true).await.unwrap();
        assert!(receiver.enabled());
        receiver.shutdown().await.unwrap();
        // A shutdown keeps the saved setting for the next start.
        assert!(saved().await);
        CONFIG.set_agent_id(previous);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn rejects_enable_requests_after_shutdown() {
        let (_db, previous) = fixture(false).await;
        let receiver = WebhookReceiverService::new();
        receiver.shutdown().await.unwrap();
        let err = receiver.set_enabled(true).await.unwrap_err();
        assert!(err.to_string().contains("shutting down"));
        assert!(!receiver.enabled());
        CONFIG.set_agent_id(previous);
    }
}
