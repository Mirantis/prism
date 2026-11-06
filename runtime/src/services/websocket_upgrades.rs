//! Which WebSocket endpoint an upgrade belongs to.
//!
//! Several endpoints share the runtime's HTTP server: chat and its voice on
//! `/api/ws`, and the agent's screen on `/api/computer`. Each registers its path
//! here with [`serve_upgrades`], and `server.rs` installs [`upgrade_middleware`]
//! as the outermost layer, so every upgrade request is dispatched here before any
//! router or middleware sees it. An endpoint applies its own checks (the origin
//! rule included) inside its handler.
//!
//! That leaves one thing no endpoint can decide alone: an upgrade to a path nobody
//! serves. A handler that only knows its own path can only ignore it, and an
//! ignored upgrade holds its socket open for as long as the client keeps it. So the
//! decision is made once, here, by the only party that knows every path.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use futures::future::BoxFuture;
use parking_lot::RwLock;
use url::Url;

/// Serves one upgrade request: checks it, upgrades it (`WebSocketUpgrade`
/// extracted from the request) and answers with the switching-protocols response,
/// or answers the refusal.
pub type UpgradeHandler = Arc<dyn Fn(Request) -> BoxFuture<'static, Response> + Send + Sync>;

static HANDLERS: LazyLock<RwLock<HashMap<String, UpgradeHandler>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Whether a path was ever registered since the last reset. Until then an upgrade
/// is closed without a log line, as a server with no upgrade listener does.
static INSTALLED: AtomicBool = AtomicBool::new(false);

/// The request's path as `new URL(req.url, 'http://localhost').pathname` reads it:
/// the query removed and dot segments resolved.
fn pathname_of(req: &Request) -> String {
    let target = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    Url::parse("http://localhost")
        .and_then(|base| base.join(target))
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| req.uri().path().to_string())
}

/// Whether a request asks to switch to the WebSocket protocol (`Connection:
/// upgrade` and `Upgrade: websocket`).
pub fn is_upgrade_request(req: &Request) -> bool {
    todo!()
}

/// Serve WebSocket upgrades on `path` with `handler`.
///
/// The first call starts dispatching upgrades. Registering a path twice replaces
/// the handler, so a restart in a test does not stack them.
pub fn serve_upgrades(path: &str, handler: UpgradeHandler) {
    HANDLERS.write().insert(path.to_string(), handler);
    INSTALLED.store(true, Ordering::SeqCst);
}

/// Forget every registered path and stop dispatching. For tests, which build a
/// server per case.
pub fn reset_upgrades() {
    HANDLERS.write().clear();
    INSTALLED.store(false, Ordering::SeqCst);
}

/// The outermost layer of the runtime's HTTP server
/// (`axum::middleware::from_fn(upgrade_middleware)`). A request that is not an
/// upgrade goes on to `next`. An upgrade goes to the handler registered for its
/// path; an upgrade to any other path is logged at debug as
/// `Refused a WebSocket upgrade to {url}` and its connection closed without an
/// answer.
pub async fn upgrade_middleware(req: Request, next: Next) -> Response {
    todo!()
}
