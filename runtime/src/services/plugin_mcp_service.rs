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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ai::ToolSet;
use crate::ai::mcp::{MCPClient, MCPClientConfig, MCPTransportConfig, create_mcp_client};
use crate::lib::execution_environments::exec_stdio_transport::{
    ExecStdioServer, ExecStdioTransport,
};
use crate::lib::execution_environments::get_execution_environment::{
    files_for, get_execution_environment,
};
use crate::lib::log_redaction::err_json;
use crate::lib::tool_names::{sanitize_tool_name_segment, to_model_tool_name};
use crate::services::plugin_catalog_service::PLUGIN_CATALOG_SERVICE;
use crate::services::plugin_mcp_config::{McpParseContext, ResolvedServer, parse_mcp_json};
use crate::support::js::number_text;
use crate::support::now_ms;
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

/// A connect in flight or done; the error is the connect's failure.
type PendingClient = Shared<BoxFuture<'static, Result<MCPClient, Arc<anyhow::Error>>>>;

enum Entry {
    Ready {
        fingerprint: String,
        client: MCPClient,
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

impl Entry {
    fn fingerprint(&self) -> &str {
        match self {
            Entry::Ready { fingerprint, .. } | Entry::Failed { fingerprint, .. } => fingerprint,
        }
    }
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
        // After shutdown there is nothing to serve and nothing may be spawned.
        if self.closed.load(Ordering::SeqCst) {
            return self.merged.lock().clone();
        }
        let refresh = {
            let mut inflight = self.inflight.lock();
            match inflight.as_ref() {
                Some(pending) => pending.clone(),
                None => {
                    let task = tokio::spawn(async move {
                        let tools = match self.refresh().await {
                            Ok(tools) => tools,
                            Err(error) => {
                                log_error!(
                                    json!({ "err": err_json(&error) }),
                                    "[PluginMCP] refresh failed"
                                );
                                self.merged.lock().clone()
                            }
                        };
                        *self.inflight.lock() = None;
                        tools
                    });
                    let pending = async move {
                        match task.await {
                            Ok(tools) => tools,
                            Err(_) => {
                                *self.inflight.lock() = None;
                                ToolSet::default()
                            }
                        }
                    }
                    .boxed()
                    .shared();
                    *inflight = Some(pending.clone());
                    pending
                }
            }
        };
        refresh.await
    }

    /// Per-server outcomes for whatever is currently connected. Reflects the last
    /// refresh, so callers that need it to be current should `get_tools().await`
    /// first — that is what makes a "failed to start" attributable in the API
    /// rather than only in the logs.
    pub fn get_server_statuses(&self) -> Vec<ServerStatus> {
        let entries = self.entries.lock();
        let mut keys: Vec<&String> = entries.keys().collect();
        keys.sort_by(|a, b| compare16(a, b));
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
        ids.sort_by(|a, b| compare16(a, b));
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
        self.closed.store(true, Ordering::SeqCst);
        let clients: Vec<MCPClient> = self
            .entries
            .lock()
            .drain()
            .filter_map(|(_, entry)| match entry {
                Entry::Ready { client, .. } => Some(client),
                Entry::Failed { .. } => None,
            })
            .collect();
        self.configs.lock().clear();
        *self.merged.lock() = ToolSet::default();
        if clients.is_empty() {
            return;
        }

        log_info!("[PluginMCP] closing {} plugin MCP server(s)", clients.len());
        let closing = futures::future::join_all(clients.iter().map(|client| client.close()));
        let _ = tokio::time::timeout(Duration::from_millis(SHUTDOWN_TIMEOUT_MS), closing).await;
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
    async fn refresh(&'static self) -> anyhow::Result<ToolSet> {
        let desired = self.scan_desired().await;

        // Drop anything that vanished or whose config changed.
        let mut changed = false;
        {
            let mut entries = self.entries.lock();
            let keys: Vec<String> = entries.keys().cloned().collect();
            for key in keys {
                let current = entries[&key].fingerprint();
                if desired
                    .get(&key)
                    .is_some_and(|want| want.fingerprint == current)
                {
                    continue;
                }
                if let Some(Entry::Ready { client, .. }) = entries.remove(&key) {
                    close_in_background(client);
                }
                changed = true;
            }
        }

        // Connect what isn't connected, plus any failure whose backoff has elapsed.
        // The failed entry is left in place rather than deleted, so `connect` can
        // read its attempt count and keep widening the interval.
        let now = now_ms();
        let missing: Vec<(&String, &DesiredServer)> = {
            let entries = self.entries.lock();
            desired
                .iter()
                .filter(|(key, _)| match entries.get(*key) {
                    None => true,
                    Some(Entry::Failed { next_retry_at, .. }) => *next_retry_at <= now,
                    Some(Entry::Ready { .. }) => false,
                })
                .collect()
        };
        if !missing.is_empty() {
            changed = true;
        }
        futures::future::join_all(
            missing
                .into_iter()
                .map(|(key, want)| self.connect(key, want)),
        )
        .await;

        if changed {
            self.rebuild();
        }
        Ok(self.merged.lock().clone())
    }

    /// The servers that *should* be connected, from what is on disk right now,
    /// keyed `<pluginId>/<serverName>`.
    ///
    /// Reads through the environment the plugin's files are in. The catalog is
    /// mtime-cached on the plugins dir, so mcp.json can turn unreadable *after*
    /// the scan that recorded its path, and one plugin's bad file must not abort
    /// the refresh for every other plugin's servers. The fingerprint is
    /// `<mtimeMs>:<size>`. Configs of plugins no longer installed are forgotten.
    async fn scan_desired(&self) -> IndexMap<String, DesiredServer> {
        let mut desired = IndexMap::new();
        let mut seen_plugins: HashSet<String> = HashSet::new();

        for plugin in PLUGIN_CATALOG_SERVICE.get_plugins().await {
            let Some(config_path) = plugin.mcp_config_path.clone() else {
                continue;
            };
            seen_plugins.insert(plugin.id.clone());

            // Read through the environment the plugin's files are in. The catalog is
            // mtime-cached on the plugins dir, so mcp.json can turn unreadable *after*
            // the scan that recorded its path, and one plugin's bad file must not
            // abort the refresh for every other plugin's servers.
            let Ok(stat) = files_for(&config_path).stat(&config_path).await else {
                continue;
            };
            let fingerprint = format!("{}:{}", number_text(stat.mtime_ms), stat.size);

            let cached = self
                .configs
                .lock()
                .get(&plugin.id)
                .filter(|c| c.fingerprint == fingerprint)
                .cloned();
            let servers = match cached {
                Some(cached) => cached.servers,
                None => {
                    let servers = self
                        .parse_config(&plugin.id, &plugin.dir, &config_path)
                        .await;
                    self.configs.lock().insert(
                        plugin.id.clone(),
                        CachedConfig {
                            fingerprint: fingerprint.clone(),
                            servers: servers.clone(),
                        },
                    );
                    servers
                }
            };

            for server in servers {
                desired.insert(
                    format!("{}/{}", plugin.id, server.name()),
                    DesiredServer {
                        plugin_id: plugin.id.clone(),
                        server,
                        fingerprint: fingerprint.clone(),
                    },
                );
            }
        }

        self.configs
            .lock()
            .retain(|id, _| seen_plugins.contains(id));
        desired
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
        let raw = match files_for(config_path).read_text(config_path, None).await {
            Ok(raw) => raw,
            Err(error) => {
                log_warn!(
                    json!({ "err": err_json(&error) }),
                    "[PluginMCP] \"{}\": mcp.json could not be read",
                    plugin_id
                );
                return Vec::new();
            }
        };

        let context = McpParseContext {
            plugin_id: plugin_id.to_string(),
            plugin_root: plugin_root.to_string(),
            plugin_data: plugin_data_dir_for(plugin_id),
        };
        let Some(result) = parse_mcp_json(&raw, &context) else {
            // An unusable file disables MCP for this plugin only; its skills are
            // unaffected (spec §7.2.2).
            log_warn!(
                "[PluginMCP] \"{}\": mcp.json is invalid — no MCP servers loaded",
                plugin_id
            );
            return Vec::new();
        };
        // Logged here rather than per refresh: we only re-parse when the file changes.
        for warning in &result.warnings {
            log_warn!("[PluginMCP] \"{}\": {}", plugin_id, warning);
        }
        result.servers
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
    async fn connect(&'static self, key: &str, want: &DesiredServer) {
        let DesiredServer {
            plugin_id,
            server,
            fingerprint,
        } = want;
        let mut client_future: Option<PendingClient> = None;
        let outcome: Result<(MCPClient, ToolSet), Arc<anyhow::Error>> = async {
            if matches!(server, ResolvedServer::Stdio { .. }) {
                // The spec requires PLUGIN_DATA to exist and be writable before
                // launch, on the side the server runs on.
                get_execution_environment()
                    .files()
                    .mkdir(&plugin_data_dir_for(plugin_id))
                    .await
                    .map_err(Arc::new)?;
            }

            let mut config = MCPClientConfig::new(build_transport(server));
            config.client_name = Some("prism-agent".to_string());
            let errored_key = key.to_string();
            config.on_uncaught_error = Some(Arc::new(move |error: &anyhow::Error| {
                log_warn!(
                    json!({ "err": err_json(error) }),
                    "[PluginMCP] {} errored; dropping until it reconnects",
                    errored_key
                );
                self.drop_server(&errored_key);
            }));

            // Spawned, so the connect keeps going when the timeout below wins: a
            // client that materializes later is closed rather than leaked.
            let task = tokio::spawn(create_mcp_client(config));
            let pending: PendingClient = async move {
                match task.await {
                    Ok(outcome) => outcome.map_err(Arc::new),
                    Err(error) => Err(Arc::new(anyhow::Error::new(error))),
                }
            }
            .boxed()
            .shared();
            client_future = Some(pending.clone());

            let client = with_timeout(pending, CONNECT_TIMEOUT_MS).await??;
            let tools = with_timeout(client.tools(), CONNECT_TIMEOUT_MS)
                .await?
                .map_err(Arc::new)?;
            Ok((client, tools))
        }
        .await;

        match outcome {
            Ok((client, tools)) => {
                if self.closed.load(Ordering::SeqCst) {
                    // shutdown_all() ran while this connect was in flight. Storing
                    // the entry now would resurrect a client nothing will ever
                    // close again.
                    close_in_background(client);
                    return;
                }
                let count = tools.len();
                self.entries.lock().insert(
                    key.to_string(),
                    Entry::Ready {
                        fingerprint: fingerprint.clone(),
                        client,
                        tools,
                    },
                );
                log_info!("[PluginMCP] {} connected ({} tool(s))", key, count);
            }
            Err(error) => {
                // A failure here does not mean no client. A timeout only loses the
                // race — the connect can still finish later with a live child
                // process (a slow-starting server, e.g. a first-run `uvx`
                // download) — and a failed `tools()` handshake leaves an
                // already-connected client in hand. Close whichever materializes,
                // or it is unreferenced, unreachable by shutdown_all(), and its
                // child process is orphaned.
                if let Some(pending) = client_future {
                    tokio::spawn(async move {
                        if let Ok(client) = pending.await {
                            let _ = client.close().await;
                        }
                    });
                }

                // Non-fatal by spec: other servers and component types keep
                // loading. The failure is retried on a widening interval rather
                // than being final — a cold `npx` download can lose the first race
                // and win the next.
                let message = error.to_string();
                let attempts = match self.entries.lock().get(key) {
                    Some(Entry::Failed {
                        fingerprint: previous,
                        attempts,
                        ..
                    }) if previous == fingerprint => attempts + 1,
                    _ => 1,
                };
                let delay = retry_delay_ms(attempts);
                log_warn!(
                    json!({ "err": err_json(&error) }),
                    "[PluginMCP] {} failed to start (attempt {}); retrying in {}s",
                    key,
                    attempts,
                    (delay as f64 / 1000.0).round() as i64
                );
                if !self.closed.load(Ordering::SeqCst) {
                    self.entries.lock().insert(
                        key.to_string(),
                        Entry::Failed {
                            fingerprint: fingerprint.clone(),
                            error: message,
                            attempts,
                            next_retry_at: now_ms() + delay,
                        },
                    );
                }
            }
        }
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
        let removed = self.entries.lock().remove(key);
        if let Some(Entry::Ready { client, .. }) = removed {
            close_in_background(client);
        }
        self.rebuild();
    }

    /// Rebuild the merged map. Ordering is deterministic at every level — entry key
    /// (plugin id, then server name) and then qualified tool name — because the key
    /// order of this map is part of the prompt-cache prefix. A qualified name
    /// already taken warns `[PluginMCP] <key>: dropping tool "<raw>" — qualified
    /// name already taken`.
    fn rebuild(&self) {
        let merged = {
            let entries = self.entries.lock();
            let mut keys: Vec<&String> = entries.keys().collect();
            keys.sort_by(|a, b| compare16(a, b));
            let mut merged = ToolSet::default();
            for key in keys {
                let Entry::Ready { tools, .. } = &entries[key] else {
                    continue;
                };
                let (plugin_id, server_name) = split_key(key);

                // Sorted on the qualified name: truncation can reorder relative to
                // the raw one.
                let mut qualified: Vec<(String, &String)> = tools
                    .keys()
                    .map(|raw| (qualify_tool_name(&plugin_id, &server_name, raw), raw))
                    .collect();
                qualified.sort_by(|a, b| compare16(&a.0, &b.0));

                for (name, raw) in qualified {
                    if merged.contains_key(&name) {
                        log_warn!(
                            "[PluginMCP] {}: dropping tool \"{}\" — qualified name already taken",
                            key,
                            raw
                        );
                        continue;
                    }
                    merged.insert(name, tools[raw].clone());
                }
            }
            merged
        };
        *self.merged.lock() = merged;
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

fn compare16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn close_in_background(client: MCPClient) {
    tokio::spawn(async move {
        let _ = client.close().await;
    });
}

/// The client transport for a server. A stdio server is started in the
/// execution environment, not as a child of this process: a plugin's files are
/// the environment's, so its server has to run where they are and with the
/// toolchain that is there.
fn build_transport(server: &ResolvedServer) -> MCPTransportConfig {
    match server {
        ResolvedServer::Stdio {
            command,
            args,
            env,
            cwd,
            ..
        } => MCPTransportConfig::Custom(ExecStdioTransport::new(
            get_execution_environment(),
            ExecStdioServer {
                command: command.clone(),
                args: Some(args.clone()),
                env: Some(env.clone()),
                cwd: Some(cwd.clone()),
            },
        )),
        ResolvedServer::Http { url, headers, .. } => MCPTransportConfig::Http {
            url: url.clone(),
            headers: Some(headers.clone()),
        },
        ResolvedServer::Sse { url, headers, .. } => MCPTransportConfig::Sse {
            url: url.clone(),
            headers: Some(headers.clone()),
        },
    }
}

/// The outcome of `future`, or `timed out after <ms>ms`.
async fn with_timeout<T>(
    future: impl std::future::Future<Output = T>,
    ms: u64,
) -> Result<T, Arc<anyhow::Error>> {
    tokio::time::timeout(Duration::from_millis(ms), future)
        .await
        .map_err(|_| Arc::new(anyhow::anyhow!("timed out after {ms}ms")))
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToolExecutionOptions;
    use crate::services::plugin_catalog_service::test_support::{TestDataDir, manifest};
    use crate::services::plugin_mcp_config::MCP_SCHEMA_1_0_0;
    use serde_json::Value;
    use serial_test::serial;

    /// A stdio MCP server for the tests. `TOOLS` names its tools, `NO_TOOLS`
    /// drops the tools capability, `FAIL_FLAG` names a file whose presence makes
    /// it exit at once, `DELAY_MS` delays its `initialize` answer. It appends
    /// `start` and `stop` to `EVENT_LOG`. Calling a tool returns where it runs;
    /// calling `crash` first sends a notification, which the client reports.
    const SERVER: &str = r#"
import fs from 'node:fs';
const log = (line) => process.env.EVENT_LOG && fs.appendFileSync(process.env.EVENT_LOG, line + '\n');
log('start');
if (process.env.FAIL_FLAG && fs.existsSync(process.env.FAIL_FLAG)) process.exit(1);
process.on('SIGTERM', () => { log('stop'); process.exit(0); });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const tools = (process.env.TOOLS ?? 'search').split(',').filter(Boolean);
const handle = (m) => {
  if (m.method === 'initialize') {
    const reply = () => send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: m.params.protocolVersion,
      capabilities: process.env.NO_TOOLS ? {} : { tools: {} },
      serverInfo: { name: 'test', version: '1' } } });
    setTimeout(reply, Number(process.env.DELAY_MS ?? 0));
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
  } else if (m.method === 'tools/call') {
    if (m.params.name === 'crash') send({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
    const where = { cwd: process.cwd(), argv: process.argv.slice(2), root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA, mode: process.env.MODE };
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(where) }] } });
  }
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
"#;

    struct Fixture {
        data: TestDataDir,
        log: String,
    }

    impl Fixture {
        fn new() -> Option<Self> {
            let node = std::process::Command::new("node")
                .arg("--version")
                .output()
                .is_ok_and(|out| out.status.success());
            if !node {
                eprintln!("node is not on PATH; skipping");
                return None;
            }
            PLUGIN_MCP_SERVICE.reset();
            let data = TestDataDir::new();
            let log = format!("{}/events.log", data.base());
            Some(Fixture { data, log })
        }

        /// A stdio server entry running the test server.
        fn server(&self, env: Value) -> Value {
            let mut vars = json!({ "EVENT_LOG": self.log });
            for (key, value) in env.as_object().unwrap() {
                vars[key] = value.clone();
            }
            json!({
                "type": "stdio",
                "command": "node",
                "args": ["${PLUGIN_ROOT}/server.mjs"],
                "env": vars,
            })
        }

        /// A plugin whose mcp.json declares the given servers.
        fn write_plugin(&self, id: &str, servers: Value) -> String {
            let dir = self.data.write_plugin(id, &manifest(id, json!({})));
            std::fs::write(format!("{dir}/server.mjs"), SERVER).unwrap();
            std::fs::write(
                format!("{dir}/mcp.json"),
                json!({ "$schema": MCP_SCHEMA_1_0_0, "mcpServers": servers }).to_string(),
            )
            .unwrap();
            PLUGIN_CATALOG_SERVICE.invalidate();
            dir
        }

        fn events(&self) -> Vec<String> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }

        fn count(&self, event: &str) -> usize {
            self.events().iter().filter(|e| *e == event).count()
        }

        /// Waits up to two seconds for `event` to be logged `n` times.
        async fn wait_for(&self, event: &str, n: usize) -> bool {
            for _ in 0..40 {
                if self.count(event) >= n {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            false
        }

        fn expire_backoff(&self) {
            for entry in PLUGIN_MCP_SERVICE.entries.lock().values_mut() {
                if let Entry::Failed { next_retry_at, .. } = entry {
                    *next_retry_at = 0;
                }
            }
        }

        async fn finish(self) {
            PLUGIN_MCP_SERVICE.shutdown_all().await;
            PLUGIN_MCP_SERVICE.reset();
        }
    }

    fn names(tools: &ToolSet) -> Vec<&str> {
        tools.keys().map(String::as_str).collect()
    }

    async fn call(tools: &ToolSet, name: &str) -> anyhow::Result<Value> {
        (tools[name].execute.as_ref().unwrap())(json!({}), ToolExecutionOptions::default()).await
    }

    fn canonical(path: &str) -> String {
        std::fs::canonicalize(path)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[tokio::test]
    #[serial]
    async fn returns_nothing_when_no_plugin_declares_mcp_servers() {
        let Some(fx) = Fixture::new() else { return };

        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());
        assert!(fx.events().is_empty());
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn connects_a_stdio_server_and_qualifies_its_tools() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("demo", json!({ "probe": fx.server(json!({})) }));

        let tools = PLUGIN_MCP_SERVICE.get_tools().await;

        assert_eq!(names(&tools), vec!["demo__probe__search"]);
        assert_eq!(
            PLUGIN_MCP_SERVICE.get_server_statuses(),
            vec![ServerStatus {
                plugin_id: "demo".into(),
                server_name: "probe".into(),
                status: ServerStatusKind::Ready,
                error: None,
            }]
        );
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn launches_with_the_resolved_command_cwd_and_plugin_variables() {
        let Some(fx) = Fixture::new() else { return };
        let dir = fx.write_plugin(
            "demo",
            json!({ "probe": fx.server(json!({ "MODE": "live" })) }),
        );

        let tools = PLUGIN_MCP_SERVICE.get_tools().await;
        let output = call(&tools, "demo__probe__search").await.unwrap();
        let text = output["content"][0]["text"].as_str().unwrap();
        let ran: Value = serde_json::from_str(text).unwrap();

        let data_dir = format!("{}/plugin-data/demo", fx.data.base());
        assert!(std::path::Path::new(&data_dir).is_dir());
        assert_eq!(canonical(ran["cwd"].as_str().unwrap()), canonical(&dir));
        assert_eq!(ran["argv"], json!([format!("{dir}/server.mjs")]));
        assert_eq!(ran["root"], json!(dir));
        assert_eq!(ran["data"], json!(data_dir));
        assert_eq!(ran["mode"], json!("live"));
        fx.finish().await;
    }

    #[test]
    fn passes_a_remote_server_through_as_a_transport_config() {
        let mut headers = IndexMap::new();
        headers.insert("X-Tenant".to_string(), "acme".to_string());
        let server = ResolvedServer::Http {
            name: "api".into(),
            url: "https://x.dev/mcp".into(),
            headers: headers.clone(),
        };

        let MCPTransportConfig::Http {
            url,
            headers: Some(sent),
        } = build_transport(&server)
        else {
            panic!("expected an http transport");
        };
        assert_eq!(url, "https://x.dev/mcp");
        assert_eq!(sent, headers);
    }

    #[tokio::test]
    #[serial]
    async fn starts_one_process_per_connection_not_one_per_turn() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("demo", json!({ "probe": fx.server(json!({})) }));

        PLUGIN_MCP_SERVICE.get_tools().await;
        PLUGIN_MCP_SERVICE.get_tools().await;
        PLUGIN_MCP_SERVICE.get_tools().await;

        assert_eq!(fx.count("start"), 1);
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn coalesces_concurrent_refreshes_into_a_single_connect() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("demo", json!({ "probe": fx.server(json!({})) }));

        let (first, second) = tokio::join!(
            PLUGIN_MCP_SERVICE.get_tools(),
            PLUGIN_MCP_SERVICE.get_tools()
        );

        assert_eq!(names(&first), names(&second));
        assert_eq!(fx.count("start"), 1);
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn keeps_working_and_reports_why_when_a_server_fails_to_start() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin(
            "broken",
            json!({ "probe": { "type": "stdio", "command": "prism-no-such-mcp-server" } }),
        );

        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());

        let statuses = PLUGIN_MCP_SERVICE.get_server_statuses();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].plugin_id, "broken");
        assert_eq!(statuses[0].status, ServerStatusKind::Failed);
        assert!(statuses[0].error.is_some());
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn closes_the_client_when_the_tools_handshake_fails() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin(
            "demo",
            json!({ "probe": fx.server(json!({ "NO_TOOLS": "1" })) }),
        );

        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());

        // The client connected before the handshake failed; without a close its
        // process would outlive every reference to it.
        assert!(fx.wait_for("stop", 1).await);
        assert_eq!(
            PLUGIN_MCP_SERVICE.get_server_statuses()[0].error.as_deref(),
            Some("Server does not support tools")
        );
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn retries_a_failed_server_once_its_backoff_has_elapsed_and_widens_it() {
        let Some(fx) = Fixture::new() else { return };
        let flag = format!("{}/fail", fx.data.base());
        std::fs::write(&flag, "").unwrap();
        fx.write_plugin(
            "slow",
            json!({ "probe": fx.server(json!({ "FAIL_FLAG": flag })) }),
        );

        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());
        let backoff = |attempts: u32| match PLUGIN_MCP_SERVICE.entries.lock().get("slow/probe") {
            Some(Entry::Failed {
                attempts: a,
                next_retry_at,
                ..
            }) if *a == attempts => Some(next_retry_at - now_ms()),
            _ => None,
        };
        let first = backoff(1).unwrap();
        assert!((29_000..=30_000).contains(&first), "{first}");

        // Not due yet: the next turn spawns nothing.
        PLUGIN_MCP_SERVICE.get_tools().await;
        assert_eq!(fx.count("start"), 1);

        fx.expire_backoff();
        PLUGIN_MCP_SERVICE.get_tools().await;
        let second = backoff(2).unwrap();
        assert!((59_000..=60_000).contains(&second), "{second}");

        // The package has finished installing by the time the backoff expires.
        std::fs::remove_file(&flag).unwrap();
        fx.expire_backoff();
        assert_eq!(
            names(&PLUGIN_MCP_SERVICE.get_tools().await),
            vec!["slow__probe__search"]
        );
        assert_eq!(fx.count("start"), 3);
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn loads_a_valid_plugin_even_when_another_has_an_unusable_mcp_json() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("good", json!({ "probe": fx.server(json!({})) }));
        let bad = fx.data.write_plugin("bad", &manifest("bad", json!({})));
        std::fs::write(format!("{bad}/mcp.json"), "{ not json").unwrap();
        PLUGIN_CATALOG_SERVICE.invalidate();

        assert_eq!(
            names(&PLUGIN_MCP_SERVICE.get_tools().await),
            vec!["good__probe__search"]
        );
        fx.finish().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial]
    async fn keeps_refreshing_other_plugins_when_one_mcp_json_cannot_be_stat_ed() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("good", json!({ "probe": fx.server(json!({})) }));
        let tricky = fx.write_plugin("tricky", json!({ "probe": fx.server(json!({})) }));
        assert_eq!(PLUGIN_CATALOG_SERVICE.get_plugins().await.len(), 2);
        std::fs::remove_file(format!("{tricky}/mcp.json")).unwrap();
        std::os::unix::fs::symlink("mcp.json", format!("{tricky}/mcp.json")).unwrap();

        assert_eq!(
            names(&PLUGIN_MCP_SERVICE.get_tools().await),
            vec!["good__probe__search"]
        );
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn drops_a_plugin_removed_from_disk_and_closes_its_client() {
        let Some(fx) = Fixture::new() else { return };
        let dir = fx.write_plugin("demo", json!({ "probe": fx.server(json!({})) }));
        assert_eq!(PLUGIN_MCP_SERVICE.get_tools().await.len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
        PLUGIN_CATALOG_SERVICE.invalidate();

        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());
        assert!(PLUGIN_MCP_SERVICE.configured_servers().is_empty());
        assert!(fx.wait_for("stop", 1).await);
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn orders_tools_by_plugin_server_and_qualified_name() {
        let Some(fx) = Fixture::new() else { return };
        let server = fx.server(json!({ "TOOLS": "beta,alpha" }));
        fx.write_plugin("zeta", json!({ "srv": server.clone() }));
        fx.write_plugin("alpha", json!({ "srv": server }));

        assert_eq!(
            names(&PLUGIN_MCP_SERVICE.get_tools().await),
            vec![
                "alpha__srv__alpha",
                "alpha__srv__beta",
                "zeta__srv__alpha",
                "zeta__srv__beta",
            ]
        );
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn lists_every_declared_server_of_the_last_read_by_plugin_then_server() {
        let Some(fx) = Fixture::new() else { return };
        let zeta = fx.write_plugin(
            "zeta",
            json!({ "srv": { "type": "stdio", "command": "prism-no-such-mcp-server", "env": { "K": "v" } } }),
        );
        fx.write_plugin(
            "alpha",
            json!({
                "web": { "type": "streamable-http", "url": "http://127.0.0.1:9/mcp" },
                "cli": { "type": "stdio", "command": "prism-no-such-mcp-server" },
            }),
        );
        assert!(PLUGIN_MCP_SERVICE.configured_servers().is_empty());

        PLUGIN_MCP_SERVICE.get_tools().await;

        let servers = PLUGIN_MCP_SERVICE.configured_servers();
        assert_eq!(
            servers
                .iter()
                .map(|s| format!("{}/{}", s.plugin_id, s.server.name()))
                .collect::<Vec<_>>(),
            vec!["alpha/cli", "alpha/web", "zeta/srv"]
        );
        let ResolvedServer::Stdio { cwd, env, .. } = &servers[2].server else {
            panic!("expected a stdio server");
        };
        assert_eq!(cwd, &zeta);
        assert_eq!(env["K"], "v");
        assert_eq!(env["PLUGIN_ROOT"], zeta);
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn lists_the_declared_servers_after_a_read_that_starts_none() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("docs", json!({ "search": fx.server(json!({})) }));

        PLUGIN_MCP_SERVICE.read_configs().await;

        assert_eq!(
            PLUGIN_MCP_SERVICE
                .configured_servers()
                .iter()
                .map(|s| format!("{}/{}", s.plugin_id, s.server.name()))
                .collect::<Vec<_>>(),
            vec!["docs/search"]
        );
        assert!(fx.events().is_empty());
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn drops_a_server_that_errors_closes_it_and_reconnects_on_the_next_turn() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin(
            "demo",
            json!({ "probe": fx.server(json!({ "TOOLS": "crash" })) }),
        );
        let tools = PLUGIN_MCP_SERVICE.get_tools().await;

        // The server sends a notification, which the client reports as uncaught.
        call(&tools, "demo__probe__crash").await.ok();

        assert!(fx.wait_for("stop", 1).await);
        assert!(PLUGIN_MCP_SERVICE.get_server_statuses().is_empty());
        assert_eq!(
            names(&PLUGIN_MCP_SERVICE.get_tools().await),
            vec!["demo__probe__crash"]
        );
        assert_eq!(fx.count("start"), 2);
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn withdraws_a_dead_servers_tools_even_when_its_plugin_is_gone() {
        let Some(fx) = Fixture::new() else { return };
        let dir = fx.write_plugin(
            "demo",
            json!({ "probe": fx.server(json!({ "TOOLS": "crash" })) }),
        );
        let tools = PLUGIN_MCP_SERVICE.get_tools().await;

        call(&tools, "demo__probe__crash").await.ok();
        std::fs::remove_dir_all(&dir).unwrap();
        PLUGIN_CATALOG_SERVICE.invalidate();

        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn shuts_down_live_clients_and_empties_the_tool_set() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin("demo", json!({ "probe": fx.server(json!({})) }));
        PLUGIN_MCP_SERVICE.get_tools().await;

        PLUGIN_MCP_SERVICE.shutdown_all().await;

        assert_eq!(fx.count("stop"), 1);
        assert!(PLUGIN_MCP_SERVICE.get_server_statuses().is_empty());
        assert!(PLUGIN_MCP_SERVICE.get_tools().await.is_empty());
        // Safe to call again with nothing connected.
        PLUGIN_MCP_SERVICE.shutdown_all().await;
        fx.finish().await;
    }

    #[tokio::test]
    #[serial]
    async fn does_not_resurrect_a_connection_that_completes_after_shutdown() {
        let Some(fx) = Fixture::new() else { return };
        fx.write_plugin(
            "demo",
            json!({ "probe": fx.server(json!({ "DELAY_MS": "500" })) }),
        );

        let pending = tokio::spawn(PLUGIN_MCP_SERVICE.get_tools());
        assert!(fx.wait_for("start", 1).await);
        PLUGIN_MCP_SERVICE.shutdown_all().await;

        assert!(pending.await.unwrap().is_empty());
        assert!(fx.wait_for("stop", 1).await);
        assert!(PLUGIN_MCP_SERVICE.get_server_statuses().is_empty());
        fx.finish().await;
    }

    #[test]
    fn joins_the_three_segments_with_a_double_underscore() {
        assert_eq!(
            qualify_tool_name("demo", "probe", "search"),
            "demo__probe__search"
        );
    }

    #[test]
    fn replaces_characters_outside_the_provider_charset() {
        assert_eq!(
            qualify_tool_name("my.plugin", "srv", "read:file"),
            "my_plugin__srv__read_file"
        );
    }

    #[test]
    fn prefixes_a_name_that_would_start_with_a_digit() {
        assert_eq!(
            qualify_tool_name("12306", "srv", "search"),
            "t_12306__srv__search"
        );
    }

    #[test]
    fn keeps_a_namespace_for_a_segment_that_sanitizes_to_nothing() {
        let a = qualify_tool_name("___", "srv", "search");
        let b = qualify_tool_name("...", "srv", "search");
        assert_ne!(a, b);
        assert!(a.ends_with("__srv__search"));
        assert_ne!(a, "srv__search");
        assert_eq!(qualify_tool_name("___", "srv", "search"), a);
    }

    #[test]
    fn caps_at_64_characters() {
        let name = qualify_tool_name(&"a".repeat(40), &"b".repeat(40), &"c".repeat(40));
        assert_eq!(name.len(), 64);
    }

    #[test]
    fn keeps_two_over_long_names_distinct_and_stable() {
        let long = "x".repeat(80);
        let a = qualify_tool_name("plugin", "server", &format!("{long}_one"));
        let b = qualify_tool_name("plugin", "server", &format!("{long}_two"));
        assert_ne!(a, b);
        assert_eq!(
            qualify_tool_name("plugin", "server", &format!("{long}_one")),
            a
        );
    }
}
