//! Agent Runtime HTTP Server
//!
//! ```text
//! GET  /health         — liveness check
//!      /agents/*       — management routes (heartbeat, chat, cron lifecycle)
//!                        + self-update (/agents/update, /agents/update/status)
//!                        + activity reads (/agents/activity/*)
//!      /threads, /latest-thread — thread resolve/list/open
//!      /messages       — thread history replay
//!      /               — Prism Agent Web UI (static SPA bundle from web/dist)
//!
//!      /agents/state   — whether the agent is working, for the other agents
//!      /agents/llm-provider — the LLM provider's missing settings, for the clients' warning
//! ```
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

use std::path::{Path, PathBuf};

use axum::Json;
use axum::Router;
use axum::extract::Request;
use axum::middleware::from_fn;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::Method;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::config::CONFIG;
use crate::lib::origin_guard::origin_guard;
use crate::routes;
use crate::services::websocket_upgrades::upgrade_middleware;
use crate::support::http::{JsonOptions, finish, not_found, serve, with_json_body};
use crate::{log_error, log_info};

/// The API body limit.
pub const JSON_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;

/// The agent-messages listener's body limit: the largest message the route takes.
pub const AGENT_MESSAGES_BODY_LIMIT_BYTES: usize = 1024 * 1024;

/// The routes of the API, in the order `app.use` mounts them: health, then under
/// `/agents` management, slack, teams, computer, coding agents, computers,
/// question cards, locked-in, agent guide, model selection, heartbeat delivery, document
/// revisions, update, activity, cron tasks and agent state; then threads and
/// messages at the root, ahead of the SPA fallback so these explicit routes win
/// over the static catch-all.
fn api_routes() -> Router {
    Router::new()
        .route("/health", get(health))
        // Management routes (heartbeat, cron lifecycle)
        .merge(routes::management::router())
        .merge(routes::slack::router())
        .merge(routes::teams::router())
        .merge(routes::computer::router())
        // The coding agents' subscriptions (/agents/coding-agents)
        .merge(routes::coding_agents::router())
        // Sign in with ChatGPT for `LLM_PROVIDER=chatgpt` (/agents/chatgpt-auth/*)
        .merge(routes::chatgpt_auth::router())
        // The agent's computers, its own and remote ones (/agents/computers)
        .merge(routes::computers::router())
        // Answers to the agent's question cards (/agents/question-cards)
        .merge(routes::question_cards::router())
        // Locked-in mode (PATCH /agents/locked-in)
        .merge(routes::locked_in::router())
        // Agent guide editing (PATCH /agents/agent-guide)
        .merge(routes::agent_guide::router())
        // Fixed or Auto model selection (/agents/model-selection)
        .merge(routes::model_selection::router())
        // Where a heartbeat run may post (/agents/heartbeat/delivery)
        .merge(routes::heartbeat_delivery::router())
        // Identity-document history and restore (/agents/documents/{field}/revisions)
        .merge(routes::document_revisions::router())
        // Self-update (GET /agents/update/status, POST /agents/update)
        .merge(routes::update::router())
        // GET /agents/activity/*
        .merge(routes::activity::router())
        // Scheduled tasks (/agents/cron-tasks)
        .merge(routes::cron_tasks::router())
        // Whether this agent is working, for the other agents of the project
        // (GET /agents/state). Their messages arrive on `AGENT_MESSAGES_PORT`.
        .merge(routes::agent_state::router())
        // Whether the LLM provider has what it needs (GET /agents/llm-provider).
        .merge(routes::llm_provider::router())
        // Thread and message routes: /threads, /latest-thread and /messages.
        .merge(routes::threads::router())
        .merge(routes::messages::router())
}

/// The main app.
///
/// In order: the WebSocket upgrades (`services::websocket_upgrades`), outermost,
/// so an upgrade never reaches a route; the origin guard, ahead of the body
/// parser (a refused request costs nothing to read, and the CORS headers of a
/// listed origin are on every response, errors included); JSON bodies up to
/// `JSON_BODY_LIMIT_BYTES`; the routes; then the Web UI.
///
/// The Web UI: `PRISM_WEB_DIR`, else `web/dist` of the repository. Skip it when
/// the directory is not present (development runs Vite separately on :5173). When
/// it exists its files are served, and every GET whose path does not start with
/// `/agents`, `/api`, `/health`, `/threads`, `/messages` or `/latest-thread`
/// answers `index.html`.
pub fn create_app() -> Router {
    let routes = api_routes().method_not_allowed_fallback(not_found);
    let routes = match web_dist() {
        Some(dir) => routes.fallback(move |req: Request| web_ui(dir.clone(), req)),
        None => routes.fallback(not_found),
    };
    with_json_body(routes, JsonOptions::limit(JSON_BODY_LIMIT_BYTES))
        .layer(from_fn(origin_guard))
        .layer(from_fn(upgrade_middleware))
}

/// The Web UI's directory, when it exists. `PRISM_WEB_DIR` lets the packaged
/// binary point at its sidecar copy.
fn web_dist() -> Option<PathBuf> {
    let dir = match std::env::var("PRISM_WEB_DIR")
        .ok()
        .filter(|v| !v.is_empty())
    {
        Some(dir) => std::path::absolute(dir).ok()?,
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/dist"),
    };
    dir.exists().then_some(dir)
}

/// The paths the SPA fallback leaves to the API (`/^\/(?!agents|api|health|threads|messages|latest-thread).*/`).
fn is_spa_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    ![
        "agents",
        "api",
        "health",
        "threads",
        "messages",
        "latest-thread",
    ]
    .iter()
    .any(|prefix| rest.starts_with(prefix))
}

/// The file under `dir` a request path names, as `express.static` serves it: a
/// path holding a dot segment (`.`, `..`, a dotfile) or naming no regular file
/// names none.
fn static_file(dir: &Path, path: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?;
    let mut file = dir.to_path_buf();
    for segment in decoded.split('/').filter(|s| !s.is_empty()) {
        if segment.starts_with('.') || segment.contains('\\') || segment.contains('\0') {
            return None;
        }
        file.push(segment);
    }
    file.is_file().then_some(file)
}

/// The Web UI after the routes: a file of the bundle, `index.html` for an SPA
/// path, else Express's 404.
async fn web_ui(dir: PathBuf, req: Request) -> Response {
    let readable = req.method() == Method::GET || req.method() == Method::HEAD;
    if !readable {
        return not_found(req).await;
    }
    let path = req.uri().path().to_string();
    let file = match static_file(&dir, &path) {
        Some(file) => file,
        None if is_spa_path(&path) => dir.join("index.html"),
        None => return not_found(req).await,
    };
    match ServeFile::new(file).oneshot(req).await {
        Ok(response) => response.map(axum::body::Body::new).into_response(),
        Err(err) => crate::support::http::HandlerError::from(err).into_response(),
    }
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
    with_json_body(
        finish(routes::agent_messages::router()),
        JsonOptions::limit(AGENT_MESSAGES_BODY_LIMIT_BYTES),
    )
}

/// The agent-messages app, or none when `AGENT_MESSAGES_TOKEN_ID` is unset: no
/// delivery could be accepted then, so the port is not opened at all. The
/// variable is set before the runtime starts, so setting it takes a restart.
pub fn create_agent_messages_server() -> Option<Router> {
    CONFIG
        .agent_messages_token_id
        .as_ref()
        .filter(|id| !id.is_empty())?;
    Some(create_agent_messages_app())
}

/// A running listener. Cancelling `shutdown` closes it; `task` ends once its
/// connections have closed.
pub struct ServerHandle {
    pub shutdown: tokio_util::sync::CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}

/// Serve `app` on `listener` until the handle's `shutdown` is cancelled.
pub fn spawn_server(listener: TcpListener, app: Router) -> ServerHandle {
    let shutdown = tokio_util::sync::CancellationToken::new();
    let token = shutdown.clone();
    let task = tokio::spawn(async move {
        if let Err(err) = serve(listener, app, token).await {
            log_error!("Server error: {}", err);
        }
    });
    ServerHandle { shutdown, task }
}

/// Opens the agent-messages listener on `CONFIG.host`, as the API. A port that
/// cannot be opened is logged and leaves the rest of the runtime running:
/// deliveries then fail, and the sender tries again later.
pub async fn listen_for_agent_messages(app: Router) -> Option<ServerHandle> {
    let port = CONFIG.agent_messages_port;
    match TcpListener::bind((CONFIG.host.as_str(), port)).await {
        Ok(listener) => {
            log_info!(
                json!({ "port": port, "host": CONFIG.host }),
                "[AgentMessages] Listening"
            );
            Some(spawn_server(listener, app))
        }
        Err(err) => {
            let reason = if err.kind() == std::io::ErrorKind::AddrInUse {
                "The port is already in use. Choose a free AGENT_MESSAGES_PORT and restart."
                    .to_string()
            } else {
                err.to_string()
            };
            log_error!("[AgentMessages] Cannot listen on port {}. {}", port, reason);
            None
        }
    }
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
    use crate::support::http::testing::{request, send};

    #[test]
    fn names_an_address_a_browser_can_open() {
        assert_eq!(listen_url("0.0.0.0", 3003), "http://localhost:3003");
        assert_eq!(listen_url("::", 3003), "http://localhost:3003");
        assert_eq!(listen_url("::1", 3003), "http://[::1]:3003");
        assert_eq!(listen_url("127.0.0.1", 3003), "http://127.0.0.1:3003");
    }

    #[tokio::test]
    async fn answers_health_with_status_ok() {
        let res = send(create_app(), request("GET", "/health", None)).await;
        assert_eq!(res.status, 200);
        let body = res.json();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["service"], "agent-runtime");
        assert!(body["timestamp"].is_string());
    }

    #[tokio::test]
    async fn serves_no_webhook_delivery_and_no_agent_message_on_the_main_port() {
        let res = send(
            create_app(),
            request("POST", "/agents/webhooks/alerts", Some(json!({}))),
        )
        .await;
        assert_eq!(res.status, 404);
        let res = send(
            create_app(),
            request("POST", "/agents/agent-messages", Some(json!({}))),
        )
        .await;
        assert_eq!(res.status, 404);
    }

    #[tokio::test]
    async fn serves_agent_messages_alone_on_their_listener() {
        let app = create_agent_messages_app;
        // No AGENT_MESSAGES_TOKEN_ID in the test configuration: the route answers, and refuses.
        let res = send(
            app(),
            request("POST", "/agents/agent-messages", Some(json!({}))),
        )
        .await;
        assert_eq!(res.status, 503);

        let mut req = request("POST", "/agents/agent-messages", Some(json!({})));
        req.headers_mut()
            .insert("x-forwarded-user", "person@example.com".parse().unwrap());
        assert_eq!(send(app(), req).await.status, 403);

        assert_eq!(
            send(app(), request("GET", "/agents/state", None))
                .await
                .status,
            404
        );
        assert_eq!(
            send(app(), request("GET", "/health", None)).await.status,
            404
        );
        assert_eq!(
            send(
                app(),
                request("POST", "/agents/webhooks/alerts", Some(json!({})))
            )
            .await
            .status,
            404
        );
    }

    #[test]
    fn opens_no_agent_messages_port_without_agent_messages_token_id() {
        assert!(CONFIG.agent_messages_token_id.is_none());
        assert!(create_agent_messages_server().is_none());
    }

    #[tokio::test]
    async fn gives_a_browser_no_cors_permission_on_the_agent_messages_listener() {
        let mut req = request("OPTIONS", "/agents/agent-messages", None);
        req.headers_mut()
            .insert("origin", "https://site.example".parse().unwrap());
        req.headers_mut()
            .insert("access-control-request-method", "POST".parse().unwrap());
        let res = send(create_agent_messages_app(), req).await;
        assert!(res.header("access-control-allow-origin").is_none());
    }

    #[test]
    fn leaves_the_api_paths_to_the_api() {
        assert!(is_spa_path("/"));
        assert!(is_spa_path("/chat/abc"));
        assert!(!is_spa_path("/agents/me"));
        assert!(!is_spa_path("/agentsx"));
        assert!(!is_spa_path("/api/ws"));
        assert!(!is_spa_path("/health"));
        assert!(!is_spa_path("/latest-thread"));
    }

    #[test]
    fn serves_no_dot_segment_from_the_bundle() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("app.js"), "x").unwrap();
        std::fs::write(dir.path().join(".env"), "x").unwrap();
        assert_eq!(
            static_file(dir.path(), "/app.js"),
            Some(dir.path().join("app.js"))
        );
        assert_eq!(static_file(dir.path(), "/.env"), None);
        assert_eq!(static_file(dir.path(), "/../app.js"), None);
        assert_eq!(static_file(dir.path(), "/missing.js"), None);
        assert_eq!(static_file(dir.path(), "/"), None);
    }
}
