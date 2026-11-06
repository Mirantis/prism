//! Locked-In Mode Route
//!
//! PATCH /agents/locked-in — freeze the workspace markdown files against the
//! agent's own tools. No tool reaches this route, so a locked agent cannot unlock
//! itself with a tool call. The route keeps working while locked, so the user is
//! never shut out.
//!
//! Auth is terminated by the platform in front of the container (same as every
//! other route), so the route takes no credential from inside it. A shell can
//! therefore reach it — see the known holes in `docs/configuration.md`.

use axum::Json;
use axum::Router;
use axum::response::Response;
use axum::routing::patch;
use serde::{Deserialize, Serialize};

pub fn router() -> Router {
    Router::new().route("/agents/locked-in", patch(update_locked_in))
}

/// The body of `PATCH /agents/locked-in`: `{ lockedIn: boolean }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedInBody {
    /// Outer `None`: the key is missing, answered 400
    /// `missing required field 'lockedIn'`. `Some(None)` is an explicit `null`,
    /// which passes the presence check and goes to
    /// `AGENT_WORKSPACE_SERVICE.update_locked_in`, whose `ValidationError` text is
    /// answered 400. Any JSON type is accepted here; the service checks it.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub locked_in: Option<Option<serde_json::Value>>,
}

/// The body of a successful write: the value now in force.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedInResponse {
    pub locked_in: bool,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// PATCH /agents/locked-in
///
/// Body: `{ lockedIn: boolean }`. A missing key answers 400; a `ValidationError`
/// from the service answers 400 with its message; any other failure is logged
/// (`[LockedIn] Failed to update locked-in mode`, with `err`) and answers 500 with
/// the error's message. A body that is absent or not JSON reads as `{}` in Express.
async fn update_locked_in(Json(body): Json<LockedInBody>) -> Response {
    todo!()
}
