//! Model Selection Route
//!
//! GET /agents/model-selection — the agent's model mode (Fixed or Auto) and its
//! three Auto tiers, each as the stored value and the value in force after the
//! deployment default.
//!
//! PATCH /agents/model-selection — write any of `mode` ('fixed' | 'auto'),
//! `small`, `medium` and `large`. `null` clears a field back to the deployment
//! default. Auto needs a small and a large model; a write that leaves either
//! missing is refused with 400.

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde_json::{Map, Value, json};

use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::agent_workspace_service::{AGENT_WORKSPACE_SERVICE, ValidationError};
use crate::support::http::{JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new().route(
        "/agents/model-selection",
        get(get_model_selection).patch(update_model_selection),
    )
}

async fn get_model_selection() -> Response {
    match AGENT_WORKSPACE_SERVICE.get_model_selection_info().await {
        Ok(info) => json(200, info),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[ModelSelection] Failed to read the model selection"
            );
            error_json(500, err.to_string())
        }
    }
}

/// The whole body object (`{}` when absent) goes to the service, which reads
/// `mode`, `small`, `medium` and `large` and checks their types.
async fn update_model_selection(body: JsonBody) -> Response {
    let input = match body.0 {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    match AGENT_WORKSPACE_SERVICE.update_model_selection(&input).await {
        Ok(info) => json(200, info),
        Err(err) => {
            if let Some(validation) = err.downcast_ref::<ValidationError>() {
                return error_json(400, validation.to_string());
            }
            log_error!(
                json!({ "err": err_json(&err) }),
                "[ModelSelection] Failed to update the model selection"
            );
            error_json(500, err.to_string())
        }
    }
}
