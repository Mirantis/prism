//! The agent's computers: the runtime's own desktop as `local`, and the remote computers a
//! client adds. Each computer's control routes act on that computer alone.
//!
//! The `/agents/computer/…` paths name the runtime's own, as they did before there were
//! others; the shipped desktop app calls them.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use crate::services::computer::computer_help_service::{AwaitingRun, ComputerHelp};
use crate::services::computer::computer_service::{ComputerSummary, LOCAL_COMPUTER_ID};
use crate::services::computer::computer_session::{ComputerSession, SessionStatus};
use crate::services::computer::remote::link_protocol::RemotePlatform;

pub fn router() -> Router {
    Router::new()
        .route("/agents/computers", get(list_computers).post(add_computer))
        .route(
            "/agents/computers/{id}",
            get(computer_status)
                .patch(rename_computer)
                .delete(remove_computer),
        )
        .route("/agents/computer", get(local_computer_status))
        .route("/agents/computers/{id}/control", post(take_control))
        .route("/agents/computer/control", post(local_take_control))
        .route("/agents/computers/{id}/continue", post(hand_back))
        .route("/agents/computer/continue", post(local_hand_back))
        .route("/agents/computers/{id}/stop", post(stop_computer))
        .route("/agents/computer/stop", post(local_stop_computer))
        .layer(middleware::from_fn(require_agent))
}

/// Answers 503 `{ error: 'Agent is not initialized.' }` while `CONFIG.agent_id` is unset.
///
/// In Express this middleware is on a router mounted at `/agents`, so it runs for every
/// `/agents` request that reaches this router: those no router mounted before it
/// answered, including the routes of the routers mounted after it. Here it covers this
/// router's own routes.
async fn require_agent(req: Request, next: Next) -> Response {
    todo!()
}

/// `computers` from `COMPUTER_SERVICE.summaries()`.
#[derive(Debug, Clone, Serialize)]
pub struct ComputerList {
    pub computers: Vec<ComputerSummary>,
}

/// `{ computer }`: the summary of the computer added, or `null`.
#[derive(Debug, Clone, Serialize)]
pub struct AddedComputer {
    pub computer: Option<ComputerSummary>,
}

/// The body of `POST /agents/computers`. Zod: `name` trimmed, 1 to 100 characters;
/// `platform` one of `PLATFORMS`; `installationId` a UUID. Anything else answers 400 `A
/// computer needs a name of 1 to 100 characters.`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddComputerBody {
    pub name: String,
    #[serde(default)]
    pub platform: Option<RemotePlatform>,
    #[serde(default)]
    pub installation_id: Option<String>,
}

/// The body of `PATCH /agents/computers/{id}`. Zod: `name` trimmed, 1 to 100 characters.
/// Anything else answers 400 `A computer needs a name of 1 to 100 characters.`
#[derive(Debug, Clone, Deserialize)]
pub struct RenameComputerBody {
    pub name: String,
}

/// The body of the control and continue routes. Zod: `clientId` a UUID, `helpId` an
/// optional UUID. Anything else answers 400 `A connected Computer viewer is required.`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlBody {
    pub client_id: String,
    #[serde(default)]
    pub help_id: Option<String>,
}

/// A computer's status: its summary's fields (none when there is no summary), then the
/// session's status over them, then its help requests and the runs waiting for an answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatusBody {
    /// The summary's fields, with the session's status written over the keys they share.
    #[serde(flatten)]
    pub summary_and_status: serde_json::Map<String, serde_json::Value>,
    pub help: Vec<ComputerHelp>,
    pub awaiting_help: Vec<AwaitingRun>,
}

/// `{ success: true }`.
#[derive(Debug, Clone, Serialize)]
pub struct SuccessBody {
    pub success: bool,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// The computer `id` names, or the 404 `There is no such computer.` answered for it.
fn session_for(id: &str) -> Result<std::sync::Arc<ComputerSession>, Response> {
    todo!()
}

/// GET /agents/computers
///
/// `{ computers }` from `COMPUTER_SERVICE.summaries()`.
async fn list_computers() -> Response {
    todo!()
}

/// POST /agents/computers
///
/// Add a computer, or find the one its installation added before
/// (`REMOTE_COMPUTER_SERVICE.add`), then emit the service's `change`. Answers 201 with `{
/// computer }` for a new one, 200 for the found one; 400 for a body the schema refuses; 409
/// with the message of a `ComputerNameTakenError`; else logs `[Computer] Could not add a
/// computer` (warn, with `err`) and answers 500 `Could not add the computer.`
async fn add_computer(Json(body): Json<AddComputerBody>) -> Response {
    todo!()
}

/// GET /agents/computers/{id}
///
/// `computer_status_for` the computer `id` names.
async fn computer_status(Path(id): Path<String>) -> Response {
    computer_status_for(id).await
}

/// GET /agents/computer
///
/// `computer_status_for` the runtime's own computer.
async fn local_computer_status() -> Response {
    computer_status_for(LOCAL_COMPUTER_ID.to_string()).await
}

/// The status of computer `id`: 404 when there is none; else its summary and its session's
/// status, `help` (the agent's help requests whose `session_of` is this session) and
/// `awaitingHelp` (`COMPUTER_HELP_SERVICE.awaiting()`). A failure logs `[Computer] Status
/// failed` (warn, with `err`) and answers 500 `Could not load computer status.`
async fn computer_status_for(id: String) -> Response {
    todo!()
}

/// PATCH /agents/computers/{id}
///
/// Rename a remote computer. `local` answers 409 `The runtime's own computer cannot be
/// renamed.`, an unknown computer 404, a body the schema refuses 400. Answers the
/// computer's summary (or `null`) after emitting the service's `change`; 409 with the
/// message of a `ComputerNameTakenError`; else logs `[Computer] Could not rename a
/// computer` (warn, with `err`) and answers 500 `Could not rename the computer.`
async fn rename_computer(Path(id): Path<String>, Json(body): Json<RenameComputerBody>) -> Response {
    todo!()
}

/// DELETE /agents/computers/{id}
///
/// Remove a remote computer (`COMPUTER_SERVICE.remove`). `local` answers 409 `The runtime's
/// own computer cannot be removed.`, an unknown computer 404 `There is no such computer.`,
/// a removed one 204 with no body. A failure logs `[Computer] Could not remove a computer`
/// (warn, with `err`) and answers 500 `Could not remove the computer.`
async fn remove_computer(Path(id): Path<String>) -> Response {
    todo!()
}

/// POST /agents/computers/{id}/control
///
/// `take_control_for` the computer `id` names.
async fn take_control(Path(id): Path<String>, Json(body): Json<ControlBody>) -> Response {
    take_control_for(id, body).await
}

/// POST /agents/computer/control
///
/// `take_control_for` the runtime's own computer.
async fn local_take_control(Json(body): Json<ControlBody>) -> Response {
    take_control_for(LOCAL_COMPUTER_ID.to_string(), body).await
}

/// A viewer takes control of computer `id`: 404 when there is none, 400 for a body the
/// schema refuses. A takeover naming a request is secure because of that request. One
/// nothing matches is refused, rather than granted as an ordinary takeover with the agent
/// still running, and so is one about another computer: 404 `That help request is gone.
/// Reload Computer.` Answers the session's status, or 409 with the error's message.
async fn take_control_for(id: String, body: ControlBody) -> Response {
    todo!()
}

/// POST /agents/computers/{id}/continue
///
/// `hand_back_for` the computer `id` names.
async fn hand_back(Path(id): Path<String>, Json(body): Json<ControlBody>) -> Response {
    hand_back_for(id, body).await
}

/// POST /agents/computer/continue
///
/// `hand_back_for` the runtime's own computer.
async fn local_hand_back(Json(body): Json<ControlBody>) -> Response {
    hand_back_for(LOCAL_COMPUTER_ID.to_string(), body).await
}

/// A viewer hands computer `id` back: 404 when there is none, 400 for a body the schema
/// refuses. Answers the session's status, or 409 with the error's message.
async fn hand_back_for(id: String, body: ControlBody) -> Response {
    todo!()
}

/// POST /agents/computers/{id}/stop
///
/// `stop_for` the computer `id` names.
async fn stop_computer(Path(id): Path<String>) -> Response {
    stop_for(id).await
}

/// POST /agents/computer/stop
///
/// `stop_for` the runtime's own computer.
async fn local_stop_computer() -> Response {
    stop_for(LOCAL_COMPUTER_ID.to_string()).await
}

/// Stop the invocation using computer `id` (`access.stop()`): 404 when there is none, else
/// `{ success: true }`.
async fn stop_for(id: String) -> Response {
    todo!()
}
