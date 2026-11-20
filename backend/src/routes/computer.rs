//! Help requests, answered wherever the user sees them; each computer's own routes are in
//! `computers.rs`.

use axum::Router;
use axum::extract::{Path, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::post;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::computers::is_zod_uuid;
use crate::config::CONFIG;
use crate::services::computer::computer::CredentialFields;
use crate::services::computer::computer_help_service::{
    COMPUTER_HELP_SERVICE, HelpAction, HelpStatus,
};
use crate::services::computer::computer_session::{HelpTarget, SignInOutcome};
use crate::services::computer::sign_in_form::SignInCredentials;
use crate::support::http::{HandlerResult, JsonBody, json};

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
    if CONFIG.agent_id().is_none() {
        return json(503, json!({ "error": "Agent is not initialized." }));
    }
    next.run(req).await
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

impl CredentialsBody {
    /// The body as the schema reads it, or `None` when the schema refuses it.
    fn parse(body: &JsonBody) -> Option<CredentialsBody> {
        let fields = body.0.as_ref()?.as_object()?;
        let username = match fields.get("username") {
            None => String::new(),
            Some(Value::String(text)) if text.chars().count() <= 200 => text.clone(),
            Some(_) => return None,
        };
        let password = match fields.get("password") {
            Some(Value::String(text)) if (1..=500).contains(&text.chars().count()) => text.clone(),
            _ => return None,
        };
        Some(CredentialsBody { username, password })
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

impl HelpAnswerBody {
    /// The body as the schema reads it, or `None` when the schema refuses it.
    fn parse(body: &JsonBody) -> Option<HelpAnswerBody> {
        let fields = body.0.as_ref()?.as_object()?;
        let action = match fields.get("action").and_then(Value::as_str) {
            Some("continue") => HelpAction::Continue,
            Some("dismiss") => HelpAction::Dismiss,
            _ => return None,
        };
        let client_id = match fields.get("clientId") {
            None => None,
            Some(Value::String(id)) if is_zod_uuid(id) => Some(id.clone()),
            Some(_) => return None,
        };
        Some(HelpAnswerBody { action, client_id })
    }
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

fn refusal(status: u16, error: impl Into<String>) -> Response {
    json(
        status,
        ErrorBody {
            error: error.into(),
        },
    )
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
async fn submit_credentials(Path(id): Path<String>, body: JsonBody) -> HandlerResult {
    let Some(body) = CredentialsBody::parse(&body) else {
        return Ok(refusal(400, "A password is required."));
    };
    let agent_id = CONFIG.agent_id().unwrap_or_default();
    let owner = CONFIG.owner_user_id();
    let help = COMPUTER_HELP_SERVICE
        .list(&agent_id, &owner, None)
        .await?
        .into_iter()
        .find(|item| item.id == id);
    let Some(help) =
        help.filter(|help| help.credentials == Some(true) && help.status == HelpStatus::Waiting)
    else {
        return Ok(refusal(
            409,
            "That sign-in request is closed. Reload the page.",
        ));
    };
    if help.credential_fields != Some(CredentialFields::Password) && body.username.is_empty() {
        return Ok(refusal(400, "A username is required."));
    }
    let target = HelpTarget {
        id: help.id.clone(),
        target_id: help.target_id.clone(),
        site: help.site.clone(),
    };
    let credentials = SignInCredentials {
        username: body.username,
        password: body.password,
    };
    let outcome = COMPUTER_HELP_SERVICE
        .session_of(help.computer_id.as_deref())
        .sign_in(&target, &credentials, &owner, Some(&agent_id))
        .await;
    if let Some(refused) = sign_in_refusal(outcome) {
        return Ok(refusal(409, refused));
    }
    Ok(
        match COMPUTER_HELP_SERVICE
            .continue_request(&agent_id, &owner, &help.id, HelpAction::Continue, None)
            .await
        {
            Ok(()) => json(200, SuccessBody { success: true }),
            Err(error) => refusal(409, error.to_string()),
        },
    )
}

/// POST /agents/computer/help/{id}
///
/// The user's answer to a help request: `COMPUTER_HELP_SERVICE.continue_request` with the
/// action and the viewer's `clientId`. Answers `{ success: true }`, 400 `Choose continue or
/// dismiss.` for a body the schema refuses, or 409 with the error's message.
async fn answer_help(Path(id): Path<String>, body: JsonBody) -> Response {
    let Some(body) = HelpAnswerBody::parse(&body) else {
        return refusal(400, "Choose continue or dismiss.");
    };
    let agent_id = CONFIG.agent_id().unwrap_or_default();
    match COMPUTER_HELP_SERVICE
        .continue_request(
            &agent_id,
            &CONFIG.owner_user_id(),
            &id,
            body.action,
            body.client_id.as_deref(),
        )
        .await
    {
        Ok(()) => json(200, SuccessBody { success: true }),
        Err(error) => refusal(409, error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::http::testing::call;

    const HELP_ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn reads_the_credentials_body_as_the_schema_does() {
        let read = |value: Value| CredentialsBody::parse(&JsonBody(Some(value)));
        let body = read(json!({ "password": "a-password" })).unwrap();
        assert_eq!(body.username, "");
        assert!(read(json!({ "username": "demo-user" })).is_none());
        assert!(read(json!({ "password": "" })).is_none());
        assert!(read(json!({ "username": 1, "password": "p" })).is_none());
        assert!(read(json!({ "username": "u".repeat(201), "password": "p" })).is_none());
        assert!(CredentialsBody::parse(&JsonBody(None)).is_none());
    }

    #[test]
    fn reads_the_answer_body_as_the_schema_does() {
        let read = |value: Value| HelpAnswerBody::parse(&JsonBody(Some(value)));
        assert_eq!(
            read(json!({ "action": "dismiss" })).unwrap().action,
            HelpAction::Dismiss
        );
        assert!(read(json!({ "action": "later" })).is_none());
        assert!(read(json!({ "action": "continue", "clientId": "viewer" })).is_none());
        assert!(
            read(json!({ "action": "continue", "clientId": HELP_ID }))
                .unwrap()
                .client_id
                .is_some()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn needs_a_password() {
        let previous = CONFIG.agent_id();
        CONFIG.set_agent_id(Some("agent-1".into()));
        let response = call(
            router(),
            "POST",
            &format!("/agents/computer/help/{HELP_ID}/credentials"),
            Some(json!({ "username": "demo-user" })),
        )
        .await;
        CONFIG.set_agent_id(previous);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.json(),
            json!({ "error": "A password is required." })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn asks_for_continue_or_dismiss() {
        let previous = CONFIG.agent_id();
        CONFIG.set_agent_id(Some("agent-1".into()));
        let response = call(
            router(),
            "POST",
            &format!("/agents/computer/help/{HELP_ID}"),
            Some(json!({ "action": "later" })),
        )
        .await;
        CONFIG.set_agent_id(previous);
        assert_eq!(response.status, 400);
        assert_eq!(
            response.json(),
            json!({ "error": "Choose continue or dismiss." })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_503_before_the_agent_is_initialized() {
        let previous = CONFIG.agent_id();
        CONFIG.set_agent_id(None);
        let response = call(
            router(),
            "POST",
            &format!("/agents/computer/help/{HELP_ID}"),
            Some(json!({ "action": "continue" })),
        )
        .await;
        CONFIG.set_agent_id(previous);
        assert_eq!(response.status, 503);
        assert_eq!(
            response.json(),
            json!({ "error": "Agent is not initialized." })
        );
    }

    /// A conversation holding one sign-in request, as the help service stores it.
    async fn stored_request(help: Value) {
        use crate::db::schema::{conversation_messages, conversation_threads};
        use diesel::prelude::*;
        let agent =
            crate::services::computer::remote::remote_computer_service::tests::agent_row().await;
        CONFIG.set_agent_id(Some(agent.clone()));
        CONFIG.set_owner_user_id("user-1".to_string());
        crate::db::run(move |conn| {
            let thread = crate::db::models::NewConversationThread::new(agent.clone(), "user-1");
            let thread_id = thread.id.clone();
            diesel::insert_into(conversation_threads::table)
                .values(&thread)
                .execute(conn)?;
            let mut message = crate::db::models::NewConversationMessage::new(
                thread_id,
                crate::db::models::MessageRole::Agent,
                "",
                crate::db::models::MessageTrigger::UserInput,
            );
            message.blocks = Some(json!([help]));
            diesel::insert_into(conversation_messages::table)
                .values(&message)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
    }

    fn sign_in_request(overrides: Value) -> Value {
        let mut help = json!({
            "type": "computer_help",
            "id": HELP_ID,
            "reason": "Sign in to the inbox",
            "credentials": true,
            "credentialFields": "both",
            "site": "https://mail.example.com",
            "targetId": "target-1",
            "status": "waiting",
        });
        for (key, value) in overrides.as_object().unwrap() {
            if value.is_null() {
                help.as_object_mut().unwrap().remove(key);
            } else {
                help[key] = value.clone();
            }
        }
        help
    }

    async fn post_credentials(body: Value) -> crate::support::http::testing::TestResponse {
        call(
            router(),
            "POST",
            &format!("/agents/computer/help/{HELP_ID}/credentials"),
            Some(body),
        )
        .await
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn needs_a_username_for_a_page_that_asks_for_one() {
        let _db = crate::db::testing::test_db();
        stored_request(sign_in_request(json!({}))).await;
        let response = post_credentials(json!({ "username": "", "password": "a-password" })).await;
        assert_eq!(response.status, 400);
        assert!(
            response.json()["error"]
                .as_str()
                .unwrap()
                .contains("username")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_request_that_has_already_been_answered() {
        let _db = crate::db::testing::test_db();
        stored_request(sign_in_request(json!({ "status": "continued" }))).await;
        let response =
            post_credentials(json!({ "username": "demo-user", "password": "a-password" })).await;
        assert_eq!(response.status, 409);
        assert_eq!(
            response.json(),
            json!({ "error": "That sign-in request is closed. Reload the page." })
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_request_of_any_other_kind() {
        let _db = crate::db::testing::test_db();
        stored_request(sign_in_request(
            json!({ "credentials": null, "site": null }),
        ))
        .await;
        let response =
            post_credentials(json!({ "username": "demo-user", "password": "a-password" })).await;
        assert_eq!(response.status, 409);
    }

    #[test]
    fn tells_the_user_what_stopped_a_sign_in() {
        for (outcome, told) in [
            (SignInOutcome::SiteChanged, "another site"),
            (SignInOutcome::NoForm, "no sign-in form"),
            (SignInOutcome::TabGone, "has closed"),
            (SignInOutcome::InUse, "control of the computer"),
        ] {
            assert!(sign_in_refusal(outcome).unwrap().contains(told), "{told}");
        }
        assert_eq!(sign_in_refusal(SignInOutcome::Filled), None);
    }
}
