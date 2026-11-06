//! The coding agents' subscriptions: which one each runs on, and signing in and
//! out. The code a Claude sign-in shows comes in here and goes to the CLI; it is
//! never stored, logged or shown to a model.
//!
//!   GET  /agents/coding-agents
//!   POST /agents/coding-agents/{agent}/sign-in
//!   GET  /agents/coding-agents/{agent}/sign-in/{id}
//!   POST /agents/coding-agents/claude-code/sign-in/{id}/code
//!   POST /agents/coding-agents/{agent}/sign-out

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use crate::config::CodingAgentName;
use crate::services::coding_agent_sign_in::coding_agent_sign_in_service::CodingAgentRow;

pub fn router() -> Router {
    Router::new()
        .route("/agents/coding-agents", get(list_coding_agents))
        .route("/agents/coding-agents/{agent}/sign-in", post(start_sign_in))
        .route(
            "/agents/coding-agents/{agent}/sign-in/{id}",
            get(read_sign_in),
        )
        .route(
            "/agents/coding-agents/claude-code/sign-in/{id}/code",
            post(submit_code),
        )
        .route("/agents/coding-agents/{agent}/sign-out", post(sign_out))
}

/// The coding agent a path segment names, or `None` for any other text.
fn agent_param(value: &str) -> Option<CodingAgentName> {
    todo!()
}

/// The body of `GET /agents/coding-agents`.
#[derive(Debug, Clone, Serialize)]
pub struct CodingAgentList {
    pub agents: Vec<CodingAgentRow>,
}

/// The body of `POST /agents/coding-agents/claude-code/sign-in/{id}/code`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SignInCodeBody {
    /// zod: a string, trimmed, then 1..=2048 characters. Anything else (a missing
    /// key, another type, blank text) answers 400
    /// `Paste the code the sign-in page shows.`, so the field takes any JSON type.
    #[serde(default)]
    pub code: Option<serde_json::Value>,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// GET /agents/coding-agents
///
/// `{ agents }`: `CODING_AGENT_SIGN_IN_SERVICE.list()`. A failure reaches the
/// default error handler.
async fn list_coding_agents() -> Response {
    todo!()
}

/// POST /agents/coding-agents/{agent}/sign-in
///
/// An unknown agent answers 404 `No such coding agent.`. Otherwise 201 with the
/// `SignInAttempt` from `start(agent)`; a `SignInUnavailableError` answers 409 with
/// its message, and any other error reaches the default error handler.
async fn start_sign_in(Path(agent): Path<String>) -> Response {
    todo!()
}

/// GET /agents/coding-agents/{agent}/sign-in/{id}
///
/// The `SignInAttempt` from `get(agent, id)`, or 404
/// `That sign-in has ended. Get a new link.` when the agent is unknown or the
/// attempt is gone.
async fn read_sign_in(Path((agent, id)): Path<(String, String)>) -> Response {
    todo!()
}

/// POST /agents/coding-agents/claude-code/sign-in/{id}/code
///
/// Hands the trimmed code to `submit_code(id, code)` and sends the `SignInAttempt`
/// it answers. A `SignInClosedError` answers 409 with its message; any other error
/// reaches the default error handler.
async fn submit_code(Path(id): Path<String>, Json(body): Json<SignInCodeBody>) -> Response {
    todo!()
}

/// POST /agents/coding-agents/{agent}/sign-out
///
/// An unknown agent answers 404 `No such coding agent.`. Otherwise the
/// `CodingAgentRow` from `sign_out(agent)`; a failure is logged
/// (`[CodingAgents] Sign-out failed`, with `err` and `agent`) and answers 500
/// `The sign-out failed. Try again.`.
async fn sign_out(Path(agent): Path<String>) -> Response {
    todo!()
}
