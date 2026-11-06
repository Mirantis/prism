//! Plugin MCP Service
//!
//! Owns the MCP servers contributed by installed Agent Plugins: connecting them,
//! naming their tools, and closing them at shutdown.
//!
//! The important decision is that the client's `tools()` is called **once, at
//! connect time**, and the resulting tool map is cached. Three things fall out of
//! that:
//!
//!   - one child process per server rather than one per turn (the tool objects
//!     close over a live connection, so a per-turn client would leak a process);
//!   - a tools block that is byte-identical across turns and across the chat and
//!     compaction paths by construction, which is what keeps the provider's
//!     prompt cache warm;
//!   - no `tools/list` round-trip on the hot path.
//!
//! The trade is that a server which changes its tool list while running is not
//! noticed until it reconnects. For a cache-sensitive tools block that is the
//! behaviour we want.
//!
//! Connection is lazy — the first turn that collects tools pays for it — and
//! steady state costs one `stat` per plugin. Dropping a plugin in is picked up on
//! the next turn without a restart, matching how skills behave.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::ai::ToolSet;
use crate::ai::mcp::MCPClient;
use crate::lib::execution_environments::get_execution_environment::{
    files_for, get_execution_environment,
};
use crate::lib::tool_names::{sanitize_tool_name_segment, to_model_tool_name};
use crate::services::plugin_catalog_service::PLUGIN_CATALOG_SERVICE;
use crate::services::plugin_mcp_config::{McpParseContext, ResolvedServer, parse_mcp_json};
use crate::{log_error, log_info, log_warn};

/// How long a single server gets to connect before we give up on it.
const CONNECT_TIMEOUT_MS: u64 = 10_000;

/// Bounded so shutdown stays well inside the process-level force-exit budget.
const SHUTDOWN_TIMEOUT_MS: u64 = 2_000;

/// Backoff for a server that failed to start.
///
/// A failure is not evidence the server is broken. The shape the docs recommend
/// — `npx -y <server>` — downloads its package on first run, and a cold download
/// routinely overruns the connect timeout. Without a retry that server stays dead
/// for the life of the container, which is one per agent and long-lived, even
/// though the download finished seconds later. Same for a remote host that was
/// briefly unreachable on the first turn.
///
/// Doubling from 30s and capped at 15 minutes: quick enough that a cold install
/// recovers on the next turn or two, slow enough that a dead server is not
/// respawned on every turn forever.
const RETRY_BASE_MS: i64 = 30_000;
const RETRY_MAX_MS: i64 = 15 * 60_000;

fn retry_delay_ms(attempts: u32) -> i64 {
    let factor = 2i64.saturating_pow(attempts.saturating_sub(1));
    RETRY_BASE_MS.saturating_mul(factor).min(RETRY_MAX_MS)
}

struct DesiredServer {
    plugin_id: String,
    server: ResolvedServer,
    /// Identifies the plugin's mcp.json contents; a change forces a reconnect.
    fingerprint: String,
}

enum Entry {
    Ready {
        fingerprint: String,
        client: Arc<MCPClient>,
        tools: ToolSet,
    },
    Failed {
        fingerprint: String,
        error: String,
        /// Consecutive failures for this config; drives the backoff.
        attempts: u32,
        /// Epoch ms before which no retry is made.
        next_retry_at: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatusKind {
    Ready,
    Failed,
}

impl ServerStatusKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ServerStatusKind::Ready => "ready",
            ServerStatusKind::Failed => "failed",
        }
    }
}

/// One server's outcome, for the management API to attribute a failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub plugin_id: String,
    pub server_name: String,
    pub status: ServerStatusKind,
    /// Why it failed — present only when `status` is `Failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A server an installed plugin declares, with the plugin it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredServer {
    pub plugin_id: String,
    pub server: ResolvedServer,
}

#[derive(Debug, Clone)]
struct CachedConfig {
    fingerprint: String,
    servers: Vec<ResolvedServer>,
}

pub struct PluginMcpService {
    /// Keyed `<pluginId>/<serverName>`.
    entries: Mutex<HashMap<String, Entry>>,
    /// Parsed mcp.json per plugin id, so a steady-state refresh does no reads.
    configs: Mutex<HashMap<String, CachedConfig>>,
    merged: Mutex<ToolSet>,
    /// The refresh in flight, shared by every caller that arrives while it runs.
    inflight: Mutex<Option<Shared<BoxFuture<'static, ToolSet>>>>,
    /// Set by `shutdown_all()`: no connect may store a client past this point.
    closed: AtomicBool,
}

impl PluginMcpService {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            configs: Mutex::new(HashMap::new()),
            merged: Mutex::new(ToolSet::default()),
            inflight: Mutex::new(None),
            closed: AtomicBool::new(false),
        }
    }

    /// Every connected plugin server's tools, qualified and in a canonical order.
    /// Never fails — a broken plugin yields fewer tools, never an error.
    ///
    /// After shutdown it serves the (empty) merged map and spawns nothing.
    /// Coalesced: a chat turn and a compaction can both be inside
    /// `collect_tools()` at once, and two concurrent refreshes would spawn
    /// duplicate children. A failed refresh logs `[PluginMCP] refresh failed`
    /// (error under `err`) and serves the last merged map.
    pub async fn get_tools(&'static self) -> ToolSet {
        todo!()
    }

    /// Per-server outcomes for whatever is currently connected. Reflects the last
    /// refresh, so callers that need it to be current should `get_tools().await`
    /// first — that is what makes a "failed to start" attributable in the API
    /// rather than only in the logs.
    pub fn get_server_statuses(&self) -> Vec<ServerStatus> {
        let entries = self.entries.lock();
        let mut keys: Vec<&String> = entries.keys().collect();
        keys.sort();
        keys.into_iter()
            .map(|key| {
                let (plugin_id, server_name) = split_key(key);
                match &entries[key] {
                    Entry::Ready { .. } => ServerStatus {
                        plugin_id,
                        server_name,
                        status: ServerStatusKind::Ready,
                        error: None,
                    },
                    Entry::Failed { error, .. } => ServerStatus {
                        plugin_id,
                        server_name,
                        status: ServerStatusKind::Failed,
                        error: Some(error.clone()),
                    },
                }
            })
            .collect()
    }

    /// Read what the installed plugins declare, without connecting a server.
    pub async fn read_configs(&self) {
        self.scan_desired().await;
    }

    /// Every server the installed plugins declare, as the last read found them:
    /// the servers the agent's current tools come from. Ordered by plugin id, then
    /// server name.
    pub fn configured_servers(&self) -> Vec<ConfiguredServer> {
        let configs = self.configs.lock();
        let mut ids: Vec<&String> = configs.keys().collect();
        ids.sort();
        ids.into_iter()
            .flat_map(|plugin_id| {
                configs[plugin_id]
                    .servers
                    .iter()
                    .map(|server| ConfiguredServer {
                        plugin_id: plugin_id.clone(),
                        server: server.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Close every live client. Bounded, and safe to call more than once.
    ///
    /// Marks the service closed first: a connect still in flight must not
    /// re-insert its client after the map is cleared — nothing would ever close
    /// that one again. Logs `[PluginMCP] closing <n> plugin MCP server(s)` when
    /// there are clients, and waits at most `SHUTDOWN_TIMEOUT_MS` for them.
    pub async fn shutdown_all(&self) {
        todo!()
    }

    /// Drop all cached state without closing anything. Tests only.
    pub fn reset(&self) {
        self.entries.lock().clear();
        self.configs.lock().clear();
        *self.merged.lock() = ToolSet::default();
        *self.inflight.lock() = None;
        self.closed.store(false, Ordering::SeqCst);
    }

    // -------------------------------------------------------------------------

    /// Drop anything that vanished or whose config changed (closing a ready
    /// client in the background), connect what isn't connected plus any failure
    /// whose backoff has elapsed, and rebuild the merged map when anything
    /// changed. The failed entry is left in place rather than deleted, so
    /// `connect` can read its attempt count and keep widening the interval.
    async fn refresh(&self) -> anyhow::Result<ToolSet> {
        todo!()
    }

    /// The servers that *should* be connected, from what is on disk right now,
    /// keyed `<pluginId>/<serverName>`.
    ///
    /// Reads through the environment the plugin's files are in. The catalog is
    /// mtime-cached on the plugins dir, so mcp.json can turn unreadable *after*
    /// the scan that recorded its path, and one plugin's bad file must not abort
    /// the refresh for every other plugin's servers. The fingerprint is
    /// `<mtimeMs>:<size>`. Configs of plugins no longer installed are forgotten.
    async fn scan_desired(&self) -> HashMap<String, DesiredServer> {
        todo!()
    }

    /// Parse one plugin's mcp.json. An unreadable file warns
    /// `[PluginMCP] "<id>": mcp.json could not be read` (error under `err`); an
    /// unusable one warns `[PluginMCP] "<id>": mcp.json is invalid — no MCP
    /// servers loaded` (spec §7.2.2: its skills are unaffected); each parse
    /// warning is logged `[PluginMCP] "<id>": <warning>`.
    async fn parse_config(
        &self,
        plugin_id: &str,
        plugin_root: &str,
        config_path: &str,
    ) -> Vec<ResolvedServer> {
        todo!()
    }

    /// Connect one server and cache its tools.
    ///
    /// A stdio server gets its `PLUGIN_DATA` dir created first, on the side the
    /// server runs on. The client is named `prism-agent`, and a stdio server is
    /// started in the execution environment (`ExecStdioTransport`), not as a
    /// child of this process; a remote one uses the SDK transport of its kind with
    /// its url and headers. The client and its `tools()` each get
    /// `CONNECT_TIMEOUT_MS`. An uncaught client error warns `[PluginMCP] <key>
    /// errored; dropping until it reconnects` and drops the entry.
    ///
    /// On success, a service closed meanwhile closes the client instead of
    /// storing it; otherwise it logs `[PluginMCP] <key> connected (<n> tool(s))`.
    /// On failure, whichever client materializes later is closed, and the entry
    /// becomes `Failed` with the attempt count (incremented when the previous
    /// failure had the same fingerprint, else 1) and the next retry time, after
    /// warning `[PluginMCP] <key> failed to start (attempt <n>); retrying in <s>s`.
    async fn connect(&self, key: &str, want: &DesiredServer) {
        todo!()
    }

    /// Forget one server, closing it first.
    ///
    /// Both halves matter. Closing before dropping the reference is what stops the
    /// child process being orphaned — nothing else holds it, and `shutdown_all()`
    /// closes only what is still in the map. Rebuilding immediately is what stops
    /// the model being offered tools backed by a dead connection: a plugin deleted
    /// from disk after its server errored appears in neither `entries` nor the next
    /// refresh's desired set, so nothing there would mark the map dirty.
    fn drop_server(&self, key: &str) {
        todo!()
    }

    /// Rebuild the merged map. Ordering is deterministic at every level — entry key
    /// (plugin id, then server name) and then qualified tool name — because the key
    /// order of this map is part of the prompt-cache prefix. A qualified name
    /// already taken warns `[PluginMCP] <key>: dropping tool "<raw>" — qualified
    /// name already taken`.
    fn rebuild(&self) {
        todo!()
    }
}

impl Default for PluginMcpService {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `PLUGIN_DATA` for one plugin, in the environment its MCP server runs in. The
/// id is a directory name read from disk, so the basename only guards a caller
/// that passed a path.
fn plugin_data_dir_for(plugin_id: &str) -> String {
    let base = get_execution_environment().paths().plugin_data_dir;
    let name = plugin_id
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("");
    if name.is_empty() {
        return base;
    }
    format!("{}/{}", base.trim_end_matches('/'), name)
}

/// `<pluginId>/<serverName>` — server names cannot contain a slash.
fn split_key(key: &str) -> (String, String) {
    match key.find('/') {
        Some(at) => (key[..at].to_string(), key[at + 1..].to_string()),
        None => (String::new(), key.to_string()),
    }
}

/// `<pluginId>__<serverName>__<toolName>`, in the character set every provider
/// accepts and within the length cap.
///
/// The three-part shape — and with it the per-plugin namespace — is guaranteed:
/// `sanitize_tool_name_segment` always yields a token, so no segment can vanish
/// and take its namespace with it. Shortening an over-long name is
/// `lib::tool_names`'s job, shared with every other tool source.
pub fn qualify_tool_name(plugin_id: &str, server_name: &str, tool_name: &str) -> String {
    let joined = [plugin_id, server_name, tool_name]
        .iter()
        .map(|segment| sanitize_tool_name_segment(segment))
        .collect::<Vec<_>>()
        .join("__");
    to_model_tool_name(&joined)
}

pub static PLUGIN_MCP_SERVICE: LazyLock<PluginMcpService> = LazyLock::new(PluginMcpService::new);
