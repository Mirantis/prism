//! MCP Client Library
//!
//! Connects the agent runtime to the Mirantis Agent Platform MCP server (kubectl, GitHub,
//! AWS tools) with the AI SDK's MCP client.
//!
//! Every tool collection uses one client per URL, because a client holds a
//! gateway session and the tools it returns run through that client. Each
//! collection lists the tools again, so a connection added in Mirantis Agent Platform
//! appears on the next turn. A failed listing replaces the client, which is how
//! an expired session recovers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::json;

use crate::ai::ToolSet;
use crate::ai::mcp::{
    MCPClient, MCPClientConfig, MCPTransportConfig, RequestOptions, create_mcp_client,
};
use crate::lib::log_redaction::err_json;
use crate::{log_error, log_warn};

/// Bounded because every collection waits on the cached connect: a hung one leaves the cache.
const CONNECT_TIMEOUT_MS: u64 = 10_000;

/// Bounded so a slow gateway does not hold up shutdown.
const SHUTDOWN_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MCPConnectionConfig {
    pub url: String,
}

/// A connect in flight or done, shared by every collection that asks for the URL
/// meanwhile. The error is the connect's failure.
type PendingClient = Shared<BoxFuture<'static, Result<MCPClient, Arc<anyhow::Error>>>>;

/// How a client is connected: over HTTP to the URL in production.
type Connect = Arc<dyn Fn(String) -> BoxFuture<'static, anyhow::Result<MCPClient>> + Send + Sync>;

/// The cached clients and the shutdown flag.
struct McpClients {
    /// Keyed by URL. The value is the connect future, so concurrent first collections share one connect.
    clients: Mutex<HashMap<String, PendingClient>>,
    /// Set by `close_mcp_clients()`: no connect starts after it.
    closed: AtomicBool,
    connect: Connect,
}

static MCP_CLIENTS: LazyLock<Arc<McpClients>> =
    LazyLock::new(|| McpClients::new(Arc::new(|url| connect_over_http(url).boxed())));

async fn connect_over_http(url: String) -> anyhow::Result<MCPClient> {
    let mut config = MCPClientConfig::new(MCPTransportConfig::Http { url, headers: None });
    config.initialization_options = Some(RequestOptions {
        timeout: Some(CONNECT_TIMEOUT_MS),
        ..RequestOptions::default()
    });
    create_mcp_client(config).await
}

/// The tools of the MCP server at `url`, listed through the cached client.
///
/// A failed listing removes the client from the cache and connects once more.
/// That client stays open, because tools another turn already holds, such as a
/// meeting's, run through it.
///
/// Returns the tools, or an empty set if the connection fails.
pub async fn get_mcp_tools(config: MCPConnectionConfig) -> ToolSet {
    MCP_CLIENTS.clone().get_tools(&config.url).await
}

/// Close every cached client, a connect in flight included. Bounded.
pub async fn close_mcp_clients() {
    MCP_CLIENTS.close().await
}

/// The error of a connect, which every waiter shares.
fn shared_error(error: &Arc<anyhow::Error>) -> serde_json::Value {
    json!({ "err": err_json(error.as_ref()) })
}

impl McpClients {
    fn new(connect: Connect) -> Arc<Self> {
        Arc::new(McpClients {
            clients: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            connect,
        })
    }

    async fn get_tools(self: Arc<Self>, url: &str) -> ToolSet {
        if self.closed.load(Ordering::SeqCst) {
            return ToolSet::new();
        }
        let cached = self.connect(url);
        let client = match cached.clone().await {
            Ok(client) => client,
            Err(error) => {
                log_error!(
                    shared_error(&error),
                    "[MCPClient] Failed to connect to {}",
                    url
                );
                return ToolSet::new();
            }
        };

        match client.tools().await {
            Ok(tools) => return tools,
            Err(error) => {
                log_warn!(
                    json!({ "err": err_json(&error) }),
                    "[MCPClient] Listing tools at {} failed; connecting again",
                    url
                );
                self.uncache(url, &cached);
            }
        }

        let fresh = self.connect(url);
        let logged = match fresh.clone().await {
            Ok(client) => match client.tools().await {
                Ok(tools) => return tools,
                Err(error) => json!({ "err": err_json(&error) }),
            },
            Err(error) => shared_error(&error),
        };
        log_error!(logged, "[MCPClient] Failed to connect to {}", url);
        self.uncache(url, &fresh);
        ToolSet::new()
    }

    async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let pending: Vec<PendingClient> = self.clients.lock().drain().map(|(_, p)| p).collect();
        if pending.is_empty() {
            return;
        }
        let closing = futures::future::join_all(pending.into_iter().map(|client| async move {
            if let Ok(client) = client.await {
                let _ = client.close().await;
            }
        }));
        let _ = tokio::time::timeout(Duration::from_millis(SHUTDOWN_TIMEOUT_MS), closing).await;
    }

    /// The cached connect for `url`, or a new one over HTTP with
    /// `CONNECT_TIMEOUT_MS` as its initialization timeout. A failed connect leaves
    /// the cache, so the next collection connects again. Fails at once with
    /// `MCP clients are shut down` after `close_mcp_clients()`.
    fn connect(self: &Arc<Self>, url: &str) -> PendingClient {
        if self.closed.load(Ordering::SeqCst) {
            return futures::future::ready(Err(Arc::new(anyhow::anyhow!(
                "MCP clients are shut down"
            ))))
            .boxed()
            .shared();
        }
        let mut clients = self.clients.lock();
        if let Some(existing) = clients.get(url) {
            return existing.clone();
        }

        let connect = (self.connect)(url.to_string());
        let pending: PendingClient = connect
            .map(|outcome| outcome.map_err(Arc::new))
            .boxed()
            .shared();
        clients.insert(url.to_string(), pending.clone());
        drop(clients);

        // The connect runs whether or not a collection still waits on it, and a
        // failed one leaves the cache, so the next collection connects again.
        let watcher = pending.clone();
        let owner = self.clone();
        let url = url.to_string();
        tokio::spawn(async move {
            if watcher.clone().await.is_err() {
                owner.uncache(&url, &watcher);
            }
        });
        pending
    }

    /// Remove `stale` from the cache, unless another connect already replaced it.
    fn uncache(&self, url: &str, stale: &PendingClient) {
        let mut clients = self.clients.lock();
        if clients
            .get(url)
            .is_some_and(|current| current.ptr_eq(stale))
        {
            clients.remove(url);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use serde_json::Value;

    /// A Streamable HTTP MCP server: JSON answers and one session per
    /// `initialize`. `tools/list` fails with 404 for the expired session.
    #[derive(Default)]
    struct Gateway {
        initialize_attempts: AtomicUsize,
        sessions: AtomicUsize,
        listings: AtomicUsize,
        terminated: AtomicUsize,
        expired_session: Mutex<Option<String>>,
        tools: Mutex<Vec<&'static str>>,
        initialize_delay_ms: AtomicUsize,
        refuse: AtomicBool,
    }

    async fn handle(
        State(gateway): State<Arc<Gateway>>,
        headers: HeaderMap,
        body: String,
    ) -> Response {
        let message: Value = serde_json::from_str(&body).unwrap();
        let method = message["method"].as_str().unwrap_or_default().to_string();
        let id = message.get("id").cloned();
        let reply = |result: Value| {
            axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
        };
        match method.as_str() {
            "server/discover" => axum::Json(json!({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": { "code": -32601, "message": "Method not found" },
            }))
            .into_response(),
            "initialize" => {
                gateway.initialize_attempts.fetch_add(1, Ordering::SeqCst);
                let delay = gateway.initialize_delay_ms.load(Ordering::SeqCst);
                if delay > 0 {
                    tokio::time::sleep(Duration::from_millis(delay as u64)).await;
                }
                if gateway.refuse.load(Ordering::SeqCst) {
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                let n = gateway.sessions.fetch_add(1, Ordering::SeqCst) + 1;
                let mut response = reply(json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "gateway", "version": "1" },
                }));
                response
                    .headers_mut()
                    .insert("mcp-session-id", format!("session-{n}").parse().unwrap());
                response
            }
            "notifications/initialized" => StatusCode::ACCEPTED.into_response(),
            "tools/list" => {
                gateway.listings.fetch_add(1, Ordering::SeqCst);
                let session = headers
                    .get("mcp-session-id")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                if session.is_some() && *gateway.expired_session.lock() == session {
                    return (StatusCode::NOT_FOUND, "session expired").into_response();
                }
                let tools: Vec<Value> = gateway
                    .tools
                    .lock()
                    .iter()
                    .map(|name| json!({ "name": name, "inputSchema": { "type": "object" } }))
                    .collect();
                reply(json!({ "tools": tools }))
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    async fn terminate(State(gateway): State<Arc<Gateway>>) -> StatusCode {
        gateway.terminated.fetch_add(1, Ordering::SeqCst);
        StatusCode::OK
    }

    async fn serve(gateway: Arc<Gateway>) -> String {
        let app = Router::new()
            .route(
                "/mcp",
                post(handle)
                    .get(|| async { StatusCode::METHOD_NOT_ALLOWED })
                    .delete(terminate),
            )
            .with_state(gateway);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/mcp")
    }

    fn gateway_with(tools: Vec<&'static str>) -> Arc<Gateway> {
        let gateway = Arc::new(Gateway::default());
        *gateway.tools.lock() = tools;
        gateway
    }

    fn clients() -> Arc<McpClients> {
        McpClients::new(Arc::new(|url| connect_over_http(url).boxed()))
    }

    fn names(tools: &ToolSet) -> Vec<&str> {
        tools.keys().map(String::as_str).collect()
    }

    fn expire(gateway: &Gateway, session: &str) {
        *gateway.expired_session.lock() = Some(session.to_string());
    }

    #[tokio::test]
    async fn returns_the_tools_of_the_server() {
        let gateway = gateway_with(vec!["memory_search", "memory_write"]);
        let url = serve(gateway.clone()).await;

        let tools = clients().get_tools(&url).await;

        assert_eq!(names(&tools), vec!["memory_search", "memory_write"]);
    }

    #[tokio::test]
    async fn reuses_one_client_across_collections_and_lists_the_tools_on_each() {
        let gateway = gateway_with(vec!["memory_search"]);
        let url = serve(gateway.clone()).await;
        let clients = clients();

        for _ in 0..3 {
            clients.clone().get_tools(&url).await;
        }

        assert_eq!(gateway.sessions.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.listings.load(Ordering::SeqCst), 3);
        assert_eq!(gateway.terminated.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn shares_one_connect_between_concurrent_first_collections() {
        let gateway = gateway_with(vec!["memory_search"]);
        gateway.initialize_delay_ms.store(100, Ordering::SeqCst);
        let url = serve(gateway.clone()).await;
        let clients = clients();

        let (first, second) = tokio::join!(
            clients.clone().get_tools(&url),
            clients.clone().get_tools(&url)
        );

        assert_eq!(names(&first), vec!["memory_search"]);
        assert_eq!(names(&second), vec!["memory_search"]);
        assert_eq!(gateway.initialize_attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn replaces_a_client_whose_listing_failed_and_keeps_it_open() {
        let gateway = gateway_with(vec!["memory_search"]);
        let url = serve(gateway.clone()).await;
        let clients = clients();
        clients.clone().get_tools(&url).await;
        expire(&gateway, "session-1");
        *gateway.tools.lock() = vec!["kubectl_get"];

        let tools = clients.clone().get_tools(&url).await;

        assert_eq!(names(&tools), vec!["kubectl_get"]);
        assert_eq!(gateway.sessions.load(Ordering::SeqCst), 2);
        // Tools another turn holds still run through the stale client.
        assert_eq!(gateway.terminated.load(Ordering::SeqCst), 0);

        clients.clone().get_tools(&url).await;
        assert_eq!(gateway.sessions.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn connects_once_when_two_concurrent_collections_fail_on_one_reused_client() {
        let gateway = gateway_with(vec!["memory_search"]);
        let url = serve(gateway.clone()).await;
        let clients = clients();
        clients.clone().get_tools(&url).await;
        expire(&gateway, "session-1");

        let (first, second) = tokio::join!(
            clients.clone().get_tools(&url),
            clients.clone().get_tools(&url)
        );

        assert_eq!(names(&first), vec!["memory_search"]);
        assert_eq!(names(&second), vec!["memory_search"]);
        assert_eq!(gateway.sessions.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn returns_nothing_on_a_failed_connect_and_connects_again_on_the_next_collection() {
        let gateway = gateway_with(vec!["memory_search"]);
        gateway.refuse.store(true, Ordering::SeqCst);
        let url = serve(gateway.clone()).await;
        let clients = clients();

        assert!(clients.clone().get_tools(&url).await.is_empty());

        gateway.refuse.store(false, Ordering::SeqCst);
        assert_eq!(
            names(&clients.clone().get_tools(&url).await),
            vec!["memory_search"]
        );
        assert_eq!(gateway.initialize_attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn gives_every_collection_waiting_on_a_failed_connect_nothing_with_no_second_connect() {
        let gateway = gateway_with(vec!["memory_search"]);
        gateway.refuse.store(true, Ordering::SeqCst);
        gateway.initialize_delay_ms.store(100, Ordering::SeqCst);
        let url = serve(gateway.clone()).await;
        let clients = clients();

        let (first, second) = tokio::join!(
            clients.clone().get_tools(&url),
            clients.clone().get_tools(&url)
        );

        assert!(first.is_empty() && second.is_empty());
        assert_eq!(gateway.initialize_attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn returns_nothing_when_the_reconnect_after_a_failed_listing_also_fails() {
        let gateway = gateway_with(vec!["memory_search"]);
        let url = serve(gateway.clone()).await;
        let clients = clients();
        clients.clone().get_tools(&url).await;
        expire(&gateway, "session-1");
        gateway.refuse.store(true, Ordering::SeqCst);

        assert!(clients.clone().get_tools(&url).await.is_empty());
    }

    #[tokio::test]
    async fn closes_the_cached_client_and_connects_no_more() {
        let gateway = gateway_with(vec!["memory_search"]);
        let url = serve(gateway.clone()).await;
        let clients = clients();
        clients.clone().get_tools(&url).await;

        clients.close().await;

        assert_eq!(gateway.terminated.load(Ordering::SeqCst), 1);
        assert!(clients.clone().get_tools(&url).await.is_empty());
        assert_eq!(gateway.initialize_attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn closes_a_client_whose_connect_was_still_in_flight() {
        let gateway = gateway_with(vec!["memory_search"]);
        gateway.initialize_delay_ms.store(200, Ordering::SeqCst);
        let url = serve(gateway.clone()).await;
        let clients = clients();

        let collection = tokio::spawn({
            let clients = clients.clone();
            let url = url.clone();
            async move { clients.get_tools(&url).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        clients.close().await;
        let _ = collection.await.unwrap();

        assert_eq!(gateway.sessions.load(Ordering::SeqCst), 1);
        assert_eq!(gateway.terminated.load(Ordering::SeqCst), 1);
    }
}
