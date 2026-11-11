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
use serde_json::json;

use crate::db::models::UpdateTrigger;
use crate::lib::log_redaction::err_json;
use crate::services::update::update_service::{UPDATE_SERVICE, UpdateInProgressError};
use crate::support::http::{error_json, json};
use crate::{log_error, log_warn};

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

/// GET /agents/update/status
///
/// Sends `UPDATE_SERVICE.get_status()` unchanged. A failure is logged
/// (`[Update] Failed to read update status`, with `err`) and answers 500 with the
/// error's message.
async fn update_status() -> Response {
    match UPDATE_SERVICE.get_status().await {
        Ok(status) => json(200, status),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Update] Failed to read update status"
            );
            error_json(500, err.to_string())
        }
    }
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
    match apply_manual_update().await {
        Ok(response) => response,
        Err(err) if err.is::<UpdateInProgressError>() => error_json(409, err.to_string()),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Update] Manual update failed"
            );
            error_json(500, err.to_string())
        }
    }
}

async fn apply_manual_update() -> anyhow::Result<Response> {
    let status = UPDATE_SERVICE.get_status().await?;
    if !status.enabled {
        let reason = status.reason.map(|r| r.to_string()).unwrap_or_default();
        return Ok(error_json(
            409,
            format!("Updates are not available in this install ({reason})."),
        ));
    }
    if status.applying {
        return Ok(error_json(409, "An update is already in progress."));
    }

    let Some(latest) = UPDATE_SERVICE.check_now().await else {
        return Ok(error_json(
            502,
            "Could not check for updates. Try again later.",
        ));
    };
    let fresh = UPDATE_SERVICE.get_status().await?;
    if !fresh.update_available {
        return Ok(error_json(
            409,
            format!("Already up to date ({}).", status.current_version),
        ));
    }

    // The attempt row is persisted before the 202, so its outcome is recorded
    // whatever happens next; a completion failure is also sent as a WS `failed`
    // frame, which the clients watch.
    let started = UPDATE_SERVICE
        .start_apply(&latest, UpdateTrigger::Manual)
        .await?;
    let version = latest.clone();
    tokio::spawn(async move {
        let failure = match started.completion.await {
            Ok(Ok(outcome)) => {
                if outcome.will_exit {
                    UPDATE_SERVICE.schedule_restart_exit(None);
                }
                return;
            }
            Ok(Err(err)) => err.to_string(),
            Err(join) => join.to_string(),
        };
        log_warn!("[Update] manual update to {version} failed: {failure}");
    });
    Ok(json(202, UpdateAccepted { ok: true, version: latest }))
}
