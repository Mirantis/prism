//! MCP Client Library
//!
//! Connects the agent runtime to the Lens Agents MCP server (kubectl, GitHub,
//! AWS tools) with the AI SDK's MCP client.
//!
//! Every tool collection uses one client per URL, because a client holds a
//! gateway session and the tools it returns run through that client. Each
//! collection lists the tools again, so a connection added in Lens Agents
//! appears on the next turn. A failed listing replaces the client, which is how
//! an expired session recovers.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};

use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;

use crate::ai::ToolSet;
use crate::ai::mcp::MCPClient;

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
type PendingClient = Shared<BoxFuture<'static, Result<Arc<MCPClient>, Arc<anyhow::Error>>>>;

/// The cached clients and the shutdown flag.
struct McpClients {
    /// Keyed by URL. The value is the connect future, so concurrent first collections share one connect.
    clients: Mutex<HashMap<String, PendingClient>>,
    /// Set by `close_mcp_clients()`: no connect starts after it.
    closed: AtomicBool,
}

static MCP_CLIENTS: LazyLock<McpClients> = LazyLock::new(|| McpClients {
    clients: Mutex::new(HashMap::new()),
    closed: AtomicBool::new(false),
});

/// The tools of the MCP server at `url`, listed through the cached client.
///
/// A failed listing removes the client from the cache and connects once more.
/// That client stays open, because tools another turn already holds, such as a
/// meeting's, run through it.
///
/// Returns the tools, or an empty set if the connection fails (logged as
/// `[MCPClient] Failed to connect to <url>`; a failed listing on a cached client
/// logs `[MCPClient] Listing tools at <url> failed; connecting again`). Empty
/// after `close_mcp_clients()`.
pub async fn get_mcp_tools(config: MCPConnectionConfig) -> ToolSet {
    todo!()
}

/// Close every cached client, a connect in flight included. Bounded by
/// `SHUTDOWN_TIMEOUT_MS`.
pub async fn close_mcp_clients() {
    todo!()
}

/// The cached connect for `url`, or a new one over HTTP with
/// `CONNECT_TIMEOUT_MS` as its initialization timeout. A failed connect leaves
/// the cache, so the next collection connects again. Fails at once with
/// `MCP clients are shut down` after `close_mcp_clients()`.
fn connect(url: &str) -> PendingClient {
    todo!()
}

/// Remove `stale` from the cache, unless another connect already replaced it.
fn uncache(url: &str, stale: &PendingClient) {
    todo!()
}
