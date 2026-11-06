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

use axum::Json;
use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde::Serialize;

pub fn router() -> Router {
    Router::new().route(
        "/agents/model-selection",
        get(get_model_selection).patch(update_model_selection),
    )
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// GET /agents/model-selection
///
/// Sends `AGENT_WORKSPACE_SERVICE.get_model_selection_info()` unchanged. A failure
/// is logged (`[ModelSelection] Failed to read the model selection`, with `err`) and
/// answers 500 with the error's message.
async fn get_model_selection() -> Response {
    todo!()
}

/// PATCH /agents/model-selection
///
/// The whole body object (`{}` when absent) goes to
/// `AGENT_WORKSPACE_SERVICE.update_model_selection`, which reads `mode`, `small`,
/// `medium` and `large` and checks their types; its result is sent unchanged. A
/// `ValidationError` answers 400 with its message; any other failure is logged
/// (`[ModelSelection] Failed to update the model selection`, with `err`) and
/// answers 500.
async fn update_model_selection(
    Json(body): Json<serde_json::Map<String, serde_json::Value>>,
) -> Response {
    todo!()
}
