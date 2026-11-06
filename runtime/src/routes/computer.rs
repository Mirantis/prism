//! Help requests, answered wherever the user sees them; each computer's own routes are in
//! `computers.rs`.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::post;
use serde::{Deserialize, Serialize};

use crate::services::computer::computer_help_service::HelpAction;
use crate::services::computer::computer_session::SignInOutcome;

pub fn router() -> Router {
    Router::new()
        .route(
            "/agents/computer/help/{id}/credentials",
            post(submit_credentials),
        )
        .route("/agents/computer/help/{id}", post(answer_help))
        .layer(middleware::from_fn(require_agent))
}

/// Answers 503 `{ error: 'Agent is not initialized.' }` while `CONFIG.agent_id` is unset.
///
/// In Express this middleware is on a router mounted at `/agents`, so it runs for every
/// `/agents` request that reaches this router: those the management, Slack and Teams
/// routers did not answer, including the routes of the routers mounted after it. Here it
/// covers this router's own routes.
async fn require_agent(req: Request, next: Next) -> Response {
    todo!()
}

/// What the user is told when a sign-in did not go in.
fn sign_in_refusal(outcome: SignInOutcome) -> Option<&'static str> {
    Some(match outcome {
        SignInOutcome::Filled => return None,
        SignInOutcome::NoForm => {
            "That page has no sign-in form any more. Open Computer and take control instead."
        }
        SignInOutcome::NoPasswordStep => {
            "That sign-in took the username and never asked for the password. Open Computer and take control instead."
        }
        SignInOutcome::TabGone => {
            "The tab needing that sign-in has closed. Open Computer and take control instead."
        }
        SignInOutcome::SiteChanged => {
            "That tab is on another site now. Open Computer and take control instead."
        }
        SignInOutcome::InUse => {
            "Somebody has control of the computer. Hand it back, then try again."
        }
        SignInOutcome::Error => {
            "The sign-in could not be entered. Open Computer and take control instead."
        }
    })
}

/// The body of `POST /agents/computer/help/{id}/credentials`. Zod: `username` a string of
/// at most 200 characters (default empty), `password` a string of 1 to 500 characters.
/// Anything else answers 400 `A password is required.`
#[derive(Clone, Default, Deserialize)]
pub struct CredentialsBody {
    #[serde(default)]
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for CredentialsBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialsBody").finish_non_exhaustive()
    }
}

/// The body of `POST /agents/computer/help/{id}`. Zod: `action` is `continue` or
/// `dismiss`, `clientId` an optional UUID. Anything else answers 400 `Choose continue or
/// dismiss.`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpAnswerBody {
    pub action: HelpAction,
    #[serde(default)]
    pub client_id: Option<String>,
}

/// `{ success: true }`.
#[derive(Debug, Clone, Serialize)]
pub struct SuccessBody {
    pub success: bool,
}

/// `{ error }`, the body of every refusal.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// POST /agents/computer/help/{id}/credentials
///
/// The username and the password for a sign-in the agent asked for.
///
/// Nothing here is stored, logged or shown to a model: the values go to the browser, the
/// form is submitted, and the request resolves the way "I'm done" resolves it. A refusal
/// says what stopped it and leaves the request waiting, so the user can still take control
/// and sign in themselves.
///
/// 400 `A password is required.` for a body the schema refuses. 409 `That sign-in request
/// is closed. Reload the page.` when the request is not a waiting credentials request. A
/// page that asks for both takes both: signing in with an empty username would clear the
/// field the page filled in for itself and submit a sign-in that cannot work, so a request
/// whose `credentialFields` is not `password` and an empty username answer 400 `A username
/// is required.` The sign-in goes through `COMPUTER_HELP_SERVICE.session_of(..).sign_in`;
/// an outcome other than `filled` answers 409 with `sign_in_refusal`. Then the request is
/// continued (`continue_request` with `continue`), answering `{ success: true }`, or 409
/// with the error's message.
async fn submit_credentials(Path(id): Path<String>, Json(body): Json<CredentialsBody>) -> Response {
    todo!()
}

/// POST /agents/computer/help/{id}
///
/// The user's answer to a help request: `COMPUTER_HELP_SERVICE.continue_request` with the
/// action and the viewer's `clientId`. Answers `{ success: true }`, 400 `Choose continue or
/// dismiss.` for a body the schema refuses, or 409 with the error's message.
async fn answer_help(Path(id): Path<String>, Json(body): Json<HelpAnswerBody>) -> Response {
    todo!()
}
