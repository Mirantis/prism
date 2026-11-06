//! Update Routes
//!
//! GET  /agents/update/status — updater state: enabled/reason, current and
//!      latest version, whether an update is available, and the last attempt.
//!      A failed check is not an error here — latestVersion just stays null.
//! POST /agents/update — check now, then apply the newer release (manual
//!      trigger; bypasses the idle gate the automatic path waits on). Responds
//!      202 `{ ok, version }` before the download starts — staging can take
//!      minutes, longer than HTTP client timeouts — and the apply runs on. Its
//!      progress arrives as WS `update` frames, its outcome lands in the
//!      attempt record, and clients poll /agents/update/status until the
//!      runtime reports the new version.

use axum::Router;
use axum::response::Response;
use axum::routing::{get, post};
use serde::Serialize;

pub fn router() -> Router {
    Router::new()
        .route("/agents/update/status", get(update_status))
        .route("/agents/update", post(start_update))
}

/// The 202 body of `POST /agents/update`: the release being applied.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateAccepted {
    /// Always `true`.
    pub ok: bool,
    pub version: String,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// GET /agents/update/status
///
/// Sends `UPDATE_SERVICE.get_status()` unchanged. A failure is logged
/// (`[Update] Failed to read update status`, with `err`) and answers 500 with the
/// error's message.
async fn update_status() -> Response {
    todo!()
}

/// POST /agents/update
///
/// In order:
/// - updates disabled: 409 `Updates are not available in this install (<reason>).`
/// - an apply running: 409 `An update is already in progress.`
/// - `check_now()` answers no version: 502 `Could not check for updates. Try again later.`
/// - a fresh status with no update available: 409 `Already up to date (<currentVersion>).`,
///   naming the version of the first status read.
///
/// Then `start_apply(latest, MANUAL)` claims the single flight and persists the
/// attempt row, and the route answers 202 `{ ok: true, version }`. The completion
/// runs on: `will_exit` calls `schedule_restart_exit()`, and a failure logs a warning
/// `[Update] manual update to <latest> failed: <message>`. An `UpdateInProgressError`
/// (an automatic apply won the race) answers 409 with its message; any other
/// failure is logged (`[Update] Manual update failed`, with `err`) and answers 500.
async fn start_update() -> Response {
    todo!()
}
