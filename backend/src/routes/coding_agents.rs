//! The coding agents' subscriptions: which one each runs on, and signing in and
//! out. The code a Claude sign-in shows comes in here and goes to the CLI; it is
//! never stored, logged or shown to a model.
//!
//!   GET  /agents/coding-agents
//!   POST /agents/coding-agents/{agent}/sign-in
//!   GET  /agents/coding-agents/{agent}/sign-in/{id}
//!   POST /agents/coding-agents/claude-code/sign-in/{id}/code
//!   POST /agents/coding-agents/{agent}/sign-out

use axum::Router;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Serialize;
use serde_json::{Value, json};

use crate::config::CodingAgentName;
use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::coding_agent_sign_in::coding_agent_sign_in_service::{
    CODING_AGENT_SIGN_IN_SERVICE, CodingAgentRow, SignInClosedError, SignInUnavailableError,
};
use crate::support::http::{HandlerError, JsonBody, error_json, json};

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
    CodingAgentName::parse(value)
}

/// The `code` field as zod reads `z.string().trim().min(1).max(2048)`: a string,
/// trimmed, of 1 to 2048 UTF-16 units. Anything else (a missing key, another
/// type, blank text) is `None`.
fn sign_in_code(value: Option<&Value>) -> Option<&str> {
    let code = value?.as_str()?.trim();
    let length = code.encode_utf16().count();
    (1..=2048).contains(&length).then_some(code)
}

/// The body of `GET /agents/coding-agents`.
#[derive(Debug, Clone, Serialize)]
pub struct CodingAgentList {
    pub agents: Vec<CodingAgentRow>,
}

/// GET /agents/coding-agents
///
/// `{ agents }`: `CODING_AGENT_SIGN_IN_SERVICE.list()`.
async fn list_coding_agents() -> Response {
    let agents = CODING_AGENT_SIGN_IN_SERVICE.list().await;
    json(200, CodingAgentList { agents })
}

/// POST /agents/coding-agents/{agent}/sign-in
///
/// An unknown agent answers 404 `No such coding agent.`. Otherwise 201 with the
/// `SignInAttempt` from `start(agent)`; a `SignInUnavailableError` answers 409 with
/// its message, and any other error reaches the default error handler.
async fn start_sign_in(Path(agent): Path<String>) -> Response {
    let Some(agent) = agent_param(&agent) else {
        return error_json(404, "No such coding agent.");
    };
    match CODING_AGENT_SIGN_IN_SERVICE.start(agent).await {
        Ok(attempt) => json(201, attempt),
        Err(err) => match err.downcast_ref::<SignInUnavailableError>() {
            Some(unavailable) => error_json(409, unavailable.to_string()),
            None => HandlerError(err).into_response(),
        },
    }
}

/// GET /agents/coding-agents/{agent}/sign-in/{id}
///
/// The `SignInAttempt` from `get(agent, id)`, or 404
/// `That sign-in has ended. Get a new link.` when the agent is unknown or the
/// attempt is gone.
async fn read_sign_in(Path((agent, id)): Path<(String, String)>) -> Response {
    let attempt =
        agent_param(&agent).and_then(|agent| CODING_AGENT_SIGN_IN_SERVICE.get(agent, &id));
    match attempt {
        Some(attempt) => json(200, attempt),
        None => error_json(404, "That sign-in has ended. Get a new link."),
    }
}

/// POST /agents/coding-agents/claude-code/sign-in/{id}/code
///
/// A body without a valid `code` answers 400
/// `Paste the code the sign-in page shows.`. Otherwise hands the trimmed code to
/// `submit_code(id, code)` and sends the `SignInAttempt` it answers. A
/// `SignInClosedError` answers 409 with its message; any other error reaches the
/// default error handler.
async fn submit_code(Path(id): Path<String>, body: JsonBody) -> Response {
    let Some(code) = sign_in_code(body.field("code")) else {
        return error_json(400, "Paste the code the sign-in page shows.");
    };
    match CODING_AGENT_SIGN_IN_SERVICE.submit_code(&id, code).await {
        Ok(attempt) => json(200, attempt),
        Err(err) => match err.downcast_ref::<SignInClosedError>() {
            Some(closed) => error_json(409, closed.to_string()),
            None => HandlerError(err).into_response(),
        },
    }
}

/// POST /agents/coding-agents/{agent}/sign-out
///
/// An unknown agent answers 404 `No such coding agent.`. Otherwise the
/// `CodingAgentRow` from `sign_out(agent)`; a failure is logged
/// (`[CodingAgents] Sign-out failed`, with `err` and `agent`) and answers 500
/// `The sign-out failed. Try again.`.
async fn sign_out(Path(agent): Path<String>) -> Response {
    let Some(agent) = agent_param(&agent) else {
        return error_json(404, "No such coding agent.");
    };
    match CODING_AGENT_SIGN_IN_SERVICE.sign_out(agent).await {
        Ok(row) => json(200, row),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err), "agent": agent.as_str() }),
                "[CodingAgents] Sign-out failed"
            );
            error_json(500, "The sign-out failed. Try again.")
        }
    }
}
