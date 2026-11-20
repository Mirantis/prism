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

use axum::Router;
use axum::response::Response;
use axum::routing::patch;
use serde::Serialize;
use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::agent_workspace_service::{AGENT_WORKSPACE_SERVICE, ValidationError};
use crate::support::http::{JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new().route("/agents/locked-in", patch(update_locked_in))
}

/// The body of a successful write: the value now in force.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedInResponse {
    pub locked_in: bool,
}

/// PATCH /agents/locked-in
///
/// Body: `{ lockedIn: boolean }`. A missing key answers 400; a `ValidationError`
/// from the service answers 400 with its message; any other failure is logged
/// and answers 500 with the error's message.
async fn update_locked_in(body: JsonBody) -> Response {
    let Some(locked_in) = body.field("lockedIn") else {
        return error_json(400, "missing required field 'lockedIn'");
    };
    match AGENT_WORKSPACE_SERVICE.update_locked_in(locked_in).await {
        Ok(locked_in) => json(200, LockedInResponse { locked_in }),
        Err(err) => {
            if let Some(validation) = err.downcast_ref::<ValidationError>() {
                return error_json(400, validation.to_string());
            }
            log_error!(
                json!({ "err": err_json(&err) }),
                "[LockedIn] Failed to update locked-in mode"
            );
            error_json(500, err.to_string())
        }
    }
}
