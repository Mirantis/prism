//! Agent Runtime Entry Point
//!
//! On startup:
//! 1. Start the HTTP server
//! 2. Resolve (or bootstrap) the single AgentWorkspace row
//! 3. Start heartbeat timers and schedule cron tasks
//!
//! On shutdown:
//! - Stop all heartbeats, cron jobs, sessions, queues
//!
//! Pending `.prism` imports are applied by `scripts::apply_pending_import` before
//! this process opens the database.

use std::sync::LazyLock;

use serde_json::json;

use crate::config::CONFIG;
use crate::lib::environment::DOTENV_LOAD_INFO;
use crate::lib::log_redaction::err_json;
use crate::{log_info, log_warn};

/// The process entry. Loads `.env` before any thread starts (it writes the
/// environment), builds the configuration, and runs the runtime on a
/// multi-threaded async runtime until it shuts down.
pub fn main() {
    LazyLock::force(&DOTENV_LOAD_INFO);
    LazyLock::force(&CONFIG);
    log_dotenv_load();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Error: {err}");
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(start());
    std::process::exit(code);
}

/// The `.env` load summary, as the first log line of a boot.
fn log_dotenv_load() {
    let info = &*DOTENV_LOAD_INFO;
    match &info.error {
        Some(err) => log_warn!(
            json!({ "err": err_json(err), "path": info.path }),
            "[dotenv] failed to load .env"
        ),
        None => log_info!(
            "[dotenv] injected {} env var(s) from {}",
            info.loaded_count,
            info.path
        ),
    }
}

/// Everything the TypeScript entry did at module load, in order: start Langfuse
/// tracing and product telemetry before any LLM call; refresh the model-window
/// catalog in the background (a failure logs
/// `[ModelCatalog] refresh failed; using the bundled catalog` with `{ err }`);
/// build the app and the agent-messages app; register the channel adapters with
/// message delivery (WebSocket, Slack, Teams) before the server accepts
/// connections; register the Slack thread provider and the Slack trigger source
/// with the heartbeat; attach the WebSocket gateway, the computer endpoint and the
/// computer-link endpoint. Then `start`.
async fn start() -> i32 {
    todo!()
}

/// Boot, after the server is listening: data dirs (a fallback logs
/// `[Startup] data dir {} is not usable; falling back to {}. Set PRISM_DATA_DIR to
/// choose another.`; then `[Startup] skills dir: {}`), the shell workspace
/// (`[Startup] shell workspace {} is not usable; falling back to {}. Set
/// SHELL_WORKSPACE_ROOT to choose another.` or `[Startup] shell workspace: {}`),
/// execution environment detection, storage migration, coding agent detection and
/// subscription switches, each available coding agent's home
/// (`[Startup] coding agent` with `{ agent, ...home }`), the plugins dir
/// (`[Startup] plugins dir: {} ({} installed)`), attachment storage
/// reconciliation, the provider and routing line, the startup warnings for each
/// `invalid_*` config value, the single agent, the interrupted work, the channel
/// adapters, the resumed work, heartbeat, cron, goals, idle compaction, the
/// webhook receiver, the file janitor, the updater and the startup telemetry.
async fn initialize() -> anyhow::Result<()> {
    todo!()
}

/// Binds the API listener and serves the app on it.
async fn get_server() -> anyhow::Result<()> {
    todo!()
}

/// Stops the work in flight (`PENDING_WORK_SERVICE.shutdown()` first, so it stays
/// pending), then every service, the listeners and the database, and exits.
async fn shutdown(signal: &str) {
    todo!()
}
