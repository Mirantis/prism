//! Agent Runtime HTTP Server
//!
//! GET  /health         — liveness check
//!      /agents/*       — management routes (heartbeat, chat, cron lifecycle)
//!                        + self-update (/agents/update, /agents/update/status)
//!                        + activity reads (/agents/activity/*)
//!      /threads, /latest-thread — thread resolve/list/open
//!      /messages       — thread history replay
//!      /               — Prism Agent Web UI (static SPA bundle from web/dist)
//!
//!      /agents/state   — whether the agent is working, for the other agents
//!
//! Webhook ingestion (POST /agents/webhooks/:name) has a listener of its own on
//! `WEBHOOK_PORT`, so a deployment can expose it to senders and keep the port
//! above private. Messages from the other agents of the project
//! (POST /agents/agent-messages) have one too, on `AGENT_MESSAGES_PORT`
//! (`create_agent_messages_app`), so a deployment can route them apart from the API.
//!
//! Auth is handled by the routing in front of the runtime; the container itself
//! trusts every incoming connection, with two exceptions. The origin guard answers
//! 403 to a browser request that comes from another site, unless
//! `PRISM_ALLOWED_ORIGINS` lists that site (see `lib/origin_guard`), and a
//! webhook subscription can require a signed or token-bearing request from its
//! sender (see `lib/webhook_signature`).

use axum::Json;
use axum::Router;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::config::CONFIG;
use crate::log_info;

/// The API body limit.
pub const JSON_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;

/// The agent-messages listener's body limit: the largest message the route takes.
pub const AGENT_MESSAGES_BODY_LIMIT_BYTES: usize = 1024 * 1024;

/// The main app.
///
/// In order: the origin guard, ahead of the body parser (a refused request costs
/// nothing to read, and the CORS headers of a listed origin are on every response,
/// errors included); JSON bodies up to `JSON_BODY_LIMIT_BYTES`; `GET /health`
/// (`health`); under `/agents`: management, slack, teams, computer, coding agents
/// (`/agents/coding-agents`), computers (`/agents/computers`), locked-in
/// (`PATCH /agents/locked-in`), agent guide (`PATCH /agents/agent-guide`), model
/// selection (`/agents/model-selection`), heartbeat delivery
/// (`/agents/heartbeat/delivery`), document revisions
/// (`/agents/documents/:field/revisions`), update (`GET /agents/update/status`,
/// `POST /agents/update`), activity (`GET /agents/activity/*`), cron tasks
/// (`/agents/cron-tasks`) and agent state (`GET /agents/state`); then threads and
/// messages at the root (`/threads`, `/latest-thread`, `/messages`), ahead of the
/// SPA fallback so these explicit routes win over the static catch-all.
///
/// The Web UI: `PRISM_WEB_DIR`, else `web/dist` beside the runtime. When that
/// directory exists it is served as static files with `index.html` as the index,
/// and every GET whose path does not start with `/agents`, `/api`, `/health`,
/// `/threads`, `/messages` or `/latest-thread` answers `index.html`; otherwise
/// (development runs the SPA on its own server) nothing is mounted for it.
pub fn create_app() -> Router {
    todo!()
}

/// `GET /health`.
pub async fn health() -> Json<Value> {
    Json(
        json!({ "status": "ok", "service": "agent-runtime", "timestamp": crate::support::now_iso() }),
    )
}

/// The agent-messages listener's app: `POST /agents/agent-messages` alone, on
/// `AGENT_MESSAGES_PORT`, with JSON bodies up to
/// `AGENT_MESSAGES_BODY_LIMIT_BYTES`. No browser calls it, so it has no origin
/// guard and no CORS; the route checks who posted (`routes/agent_messages`).
pub fn create_agent_messages_app() -> Router {
    todo!()
}

/// The agent-messages app, or none when `AGENT_MESSAGES_TOKEN_ID` is unset: no
/// delivery could be accepted then, so the port is not opened at all. The
/// variable is set before the runtime starts, so setting it takes a restart.
pub fn create_agent_messages_server() -> Option<Router> {
    CONFIG.agent_messages_token_id.as_ref()?;
    Some(create_agent_messages_app())
}

/// A running listener. Cancelling `shutdown` closes it; `task` ends once its
/// connections have closed.
pub struct ServerHandle {
    pub shutdown: tokio_util::sync::CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}

/// Opens the agent-messages listener on `CONFIG.host`, as the API. A port that
/// cannot be opened is logged at error,
/// `[AgentMessages] Cannot listen on port {port}. {reason}` (the reason for a port
/// in use is `The port is already in use. Choose a free AGENT_MESSAGES_PORT and
/// restart.`, else the error's message), and leaves the rest of the runtime
/// running: deliveries then fail, and the sender tries again later. On success it
/// logs `[AgentMessages] Listening` with `{ port, host }`.
pub async fn listen_for_agent_messages(app: Router) -> Option<ServerHandle> {
    todo!()
}

/// The address a person opens for a listener on `host`. A wildcard bind is not an
/// address a browser can open, so it names `localhost`; an IPv6 literal needs brackets.
fn listen_url(host: &str, port: u16) -> String {
    let wildcard = ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"].contains(&host);
    let address = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!(
        "http://{}:{port}",
        if wildcard {
            "localhost"
        } else {
            address.as_str()
        }
    )
}

/// Bind the API listener to `CONFIG.host`, which `PRISM_HOST` sets and which
/// defaults to loopback, on `CONFIG.port`, and log where it runs.
pub async fn listen_on() -> anyhow::Result<TcpListener> {
    let listener = TcpListener::bind((CONFIG.host.as_str(), CONFIG.port)).await?;
    let url = listen_url(&CONFIG.host, CONFIG.port);
    log_info!("Running on {} (interface {})", url, CONFIG.host);
    log_info!("Health: {}/health", url);
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_an_address_a_browser_can_open() {
        assert_eq!(listen_url("0.0.0.0", 3003), "http://localhost:3003");
        assert_eq!(listen_url("::", 3003), "http://localhost:3003");
        assert_eq!(listen_url("::1", 3003), "http://[::1]:3003");
        assert_eq!(listen_url("127.0.0.1", 3003), "http://127.0.0.1:3003");
    }
}
