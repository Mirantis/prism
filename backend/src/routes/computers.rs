//! The agent's computers: the runtime's own desktop as `local`, and the remote computers a
//! client adds. Each computer's control routes act on that computer alone.
//!
//! The `/agents/computer/…` paths name the runtime's own, as they did before there were
//! others; the shipped desktop app calls them.

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::extract::{Path, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::log_warn;
use crate::services::computer::computer_help_service::{
    AwaitingRun, COMPUTER_HELP_SERVICE, ComputerHelp,
};
use crate::services::computer::computer_service::{
    COMPUTER_SERVICE, ComputerSummary, LOCAL_COMPUTER_ID,
};
use crate::services::computer::computer_session::{ComputerSession, HelpTarget};
use crate::services::computer::remote::link_protocol::RemotePlatform;
use crate::services::computer::remote::remote_computer_service::{
    AddComputerInput, ComputerNameTakenError, REMOTE_COMPUTER_SERVICE,
};
use crate::support::http::{JsonBody, empty, json};
use crate::support::js;

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
pub(super) async fn require_agent(req: Request, next: Next) -> Response {
    if CONFIG.agent_id().is_none() {
        return json(503, json!({ "error": "Agent is not initialized." }));
    }
    next.run(req).await
}

/// zod's `uuid()`: an RFC 9562 UUID of versions 1 to 8, or the nil or max UUID.
static ZOD_UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    )
    .expect("valid regex")
});

/// Whether `text` passes zod's `uuid()`.
pub(crate) fn is_zod_uuid(text: &str) -> bool {
    ZOD_UUID.is_match(text)
}

/// `z.string().trim().min(1).max(100)`: the trimmed name, or `None`.
fn computer_name(value: Option<&Value>) -> Option<String> {
    let name = js::trim(value?.as_str()?);
    (1..=100)
        .contains(&name.chars().count())
        .then(|| name.to_string())
}

/// An optional field that has to pass `check` when present.
fn optional<T>(value: Option<&Value>, check: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match value {
        None => Some(None),
        Some(value) => check(value).map(Some),
    }
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

impl AddComputerBody {
    fn parse(body: &JsonBody) -> Option<AddComputerBody> {
        let fields = body.0.as_ref()?.as_object()?;
        Some(AddComputerBody {
            name: computer_name(fields.get("name"))?,
            platform: optional(fields.get("platform"), |value| {
                RemotePlatform::parse(value.as_str()?)
            })?,
            installation_id: optional(fields.get("installationId"), |value| {
                value
                    .as_str()
                    .filter(|id| is_zod_uuid(id))
                    .map(str::to_string)
            })?,
        })
    }
}

/// The body of `PATCH /agents/computers/{id}`. Zod: `name` trimmed, 1 to 100 characters.
/// Anything else answers 400 `A computer needs a name of 1 to 100 characters.`
#[derive(Debug, Clone, Deserialize)]
pub struct RenameComputerBody {
    pub name: String,
}

impl RenameComputerBody {
    fn parse(body: &JsonBody) -> Option<RenameComputerBody> {
        let fields = body.0.as_ref()?.as_object()?;
        Some(RenameComputerBody {
            name: computer_name(fields.get("name"))?,
        })
    }
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

impl ControlBody {
    fn parse(body: &JsonBody) -> Option<ControlBody> {
        let fields = body.0.as_ref()?.as_object()?;
        let uuid = |value: &Value| {
            value
                .as_str()
                .filter(|id| is_zod_uuid(id))
                .map(str::to_string)
        };
        Some(ControlBody {
            client_id: uuid(fields.get("clientId")?)?,
            help_id: optional(fields.get("helpId"), uuid)?,
        })
    }
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

pub(super) fn refusal(status: u16, error: impl Into<String>) -> Response {
    json(
        status,
        ErrorBody {
            error: error.into(),
        },
    )
}

fn summary_of(id: &str) -> Option<ComputerSummary> {
    COMPUTER_SERVICE
        .summaries()
        .into_iter()
        .find(|item| item.id == id)
}

/// The computer `id` names, or the 404 `There is no such computer.` answered for it.
fn session_for(id: &str) -> Result<Arc<ComputerSession>, Response> {
    COMPUTER_SERVICE
        .session(id)
        .ok_or_else(|| refusal(404, "There is no such computer."))
}

/// GET /agents/computers
///
/// `{ computers }` from `COMPUTER_SERVICE.summaries()`.
async fn list_computers() -> Response {
    json(
        200,
        ComputerList {
            computers: COMPUTER_SERVICE.summaries(),
        },
    )
}

/// POST /agents/computers
///
/// Add a computer, or find the one its installation added before
/// (`REMOTE_COMPUTER_SERVICE.add`), then emit the service's `change`. Answers 201 with `{
/// computer }` for a new one, 200 for the found one; 400 for a body the schema refuses; 409
/// with the message of a `ComputerNameTakenError`; else logs `[Computer] Could not add a
/// computer` (warn, with `err`) and answers 500 `Could not add the computer.`
async fn add_computer(body: JsonBody) -> Response {
    let Some(body) = AddComputerBody::parse(&body) else {
        return refusal(400, "A computer needs a name of 1 to 100 characters.");
    };
    let input = AddComputerInput {
        name: body.name,
        platform: body.platform,
        installation_id: body.installation_id,
    };
    match REMOTE_COMPUTER_SERVICE
        .add(input, &CONFIG.owner_user_id())
        .await
    {
        Ok((computer, created)) => {
            COMPUTER_SERVICE.emit_change();
            json(
                if created { 201 } else { 200 },
                AddedComputer {
                    computer: summary_of(&computer.id),
                },
            )
        }
        Err(error) => {
            if let Some(taken) = error.downcast_ref::<ComputerNameTakenError>() {
                return refusal(409, taken.message.clone());
            }
            log_warn!(
                json!({ "err": err_json(&error) }),
                "[Computer] Could not add a computer"
            );
            refusal(500, "Could not add the computer.")
        }
    }
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
    let session = match session_for(&id) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let agent_id = CONFIG.agent_id().unwrap_or_default();
    let help = match COMPUTER_HELP_SERVICE
        .list(&agent_id, &CONFIG.owner_user_id(), None)
        .await
    {
        Ok(help) => help,
        Err(error) => {
            log_warn!(
                json!({ "err": err_json(&error) }),
                "[Computer] Status failed"
            );
            return refusal(500, "Could not load computer status.");
        }
    };
    let mut summary_and_status = serde_json::Map::new();
    let parts = [
        serde_json::to_value(summary_of(&session.id)),
        serde_json::to_value(session.status()),
    ];
    for part in parts {
        if let Ok(Value::Object(fields)) = part {
            summary_and_status.extend(fields);
        }
    }
    json(
        200,
        ComputerStatusBody {
            summary_and_status,
            help: help
                .into_iter()
                .filter(|item| {
                    Arc::ptr_eq(
                        &COMPUTER_HELP_SERVICE.session_of(item.computer_id.as_deref()),
                        &session,
                    )
                })
                .collect(),
            awaiting_help: COMPUTER_HELP_SERVICE.awaiting(),
        },
    )
}

/// PATCH /agents/computers/{id}
///
/// Rename a remote computer. `local` answers 409 `The runtime's own computer cannot be
/// renamed.`, an unknown computer 404, a body the schema refuses 400. Answers the
/// computer's summary (or `null`) after emitting the service's `change`; 409 with the
/// message of a `ComputerNameTakenError`; else logs `[Computer] Could not rename a
/// computer` (warn, with `err`) and answers 500 `Could not rename the computer.`
async fn rename_computer(Path(id): Path<String>, body: JsonBody) -> Response {
    if id == LOCAL_COMPUTER_ID {
        return refusal(409, "The runtime's own computer cannot be renamed.");
    }
    if let Err(response) = session_for(&id) {
        return response;
    }
    let Some(body) = RenameComputerBody::parse(&body) else {
        return refusal(400, "A computer needs a name of 1 to 100 characters.");
    };
    match REMOTE_COMPUTER_SERVICE.rename(&id, &body.name).await {
        Ok(_) => {
            COMPUTER_SERVICE.emit_change();
            json(200, summary_of(&id))
        }
        Err(error) => {
            if let Some(taken) = error.downcast_ref::<ComputerNameTakenError>() {
                return refusal(409, taken.message.clone());
            }
            log_warn!(
                json!({ "err": err_json(&error) }),
                "[Computer] Could not rename a computer"
            );
            refusal(500, "Could not rename the computer.")
        }
    }
}

/// DELETE /agents/computers/{id}
///
/// Remove a remote computer (`COMPUTER_SERVICE.remove`). `local` answers 409 `The runtime's
/// own computer cannot be removed.`, an unknown computer 404 `There is no such computer.`,
/// a removed one 204 with no body. A failure logs `[Computer] Could not remove a computer`
/// (warn, with `err`) and answers 500 `Could not remove the computer.`
async fn remove_computer(Path(id): Path<String>) -> Response {
    if id == LOCAL_COMPUTER_ID {
        return refusal(409, "The runtime's own computer cannot be removed.");
    }
    match COMPUTER_SERVICE.remove(&id, &CONFIG.owner_user_id()).await {
        Ok(true) => empty(204),
        Ok(false) => refusal(404, "There is no such computer."),
        Err(error) => {
            log_warn!(
                json!({ "err": err_json(&error) }),
                "[Computer] Could not remove a computer"
            );
            refusal(500, "Could not remove the computer.")
        }
    }
}

/// POST /agents/computers/{id}/control
///
/// `take_control_for` the computer `id` names.
async fn take_control(Path(id): Path<String>, body: JsonBody) -> Response {
    take_control_for(id, body).await
}

/// POST /agents/computer/control
///
/// `take_control_for` the runtime's own computer.
async fn local_take_control(body: JsonBody) -> Response {
    take_control_for(LOCAL_COMPUTER_ID.to_string(), body).await
}

/// A viewer takes control of computer `id`: 404 when there is none, 400 for a body the
/// schema refuses. A takeover naming a request is secure because of that request. One
/// nothing matches is refused, rather than granted as an ordinary takeover with the agent
/// still running, and so is one about another computer: 404 `That help request is gone.
/// Reload Computer.` Answers the session's status, or 409 with the error's message.
async fn take_control_for(id: String, body: JsonBody) -> Response {
    let session = match session_for(&id) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let Some(body) = ControlBody::parse(&body) else {
        return refusal(400, "A connected Computer viewer is required.");
    };
    let taken: anyhow::Result<Option<Response>> = async {
        let help = match &body.help_id {
            Some(help_id) => COMPUTER_HELP_SERVICE
                .list(
                    &CONFIG.agent_id().unwrap_or_default(),
                    &CONFIG.owner_user_id(),
                    None,
                )
                .await?
                .into_iter()
                .find(|item| &item.id == help_id),
            None => None,
        };
        if body.help_id.is_some() {
            let about_this = help.as_ref().is_some_and(|help| {
                Arc::ptr_eq(
                    &COMPUTER_HELP_SERVICE.session_of(help.computer_id.as_deref()),
                    &session,
                )
            });
            if !about_this {
                return Ok(Some(refusal(
                    404,
                    "That help request is gone. Reload Computer.",
                )));
            }
        }
        let target = help.map(|help| HelpTarget {
            id: help.id,
            target_id: help.target_id,
            site: None,
        });
        session
            .take_control(&body.client_id, target.as_ref())
            .await?;
        Ok(None)
    }
    .await;
    match taken {
        Ok(Some(response)) => response,
        Ok(None) => json(200, session.status()),
        Err(error) => refusal(409, error.to_string()),
    }
}

/// POST /agents/computers/{id}/continue
///
/// `hand_back_for` the computer `id` names.
async fn hand_back(Path(id): Path<String>, body: JsonBody) -> Response {
    hand_back_for(id, body).await
}

/// POST /agents/computer/continue
///
/// `hand_back_for` the runtime's own computer.
async fn local_hand_back(body: JsonBody) -> Response {
    hand_back_for(LOCAL_COMPUTER_ID.to_string(), body).await
}

/// A viewer hands computer `id` back: 404 when there is none, 400 for a body the schema
/// refuses. Answers the session's status, or 409 with the error's message.
async fn hand_back_for(id: String, body: JsonBody) -> Response {
    let session = match session_for(&id) {
        Ok(session) => session,
        Err(response) => return response,
    };
    let Some(body) = ControlBody::parse(&body) else {
        return refusal(400, "A connected Computer viewer is required.");
    };
    match session.hand_back(&body.client_id).await {
        Ok(()) => json(200, session.status()),
        Err(error) => refusal(409, error.to_string()),
    }
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
    let session = match session_for(&id) {
        Ok(session) => session,
        Err(response) => return response,
    };
    session.access.stop();
    json(200, SuccessBody { success: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::http::testing::{TestResponse, call};

    const INSTALLATION: &str = "9b2f0c1e-0000-4000-8000-000000000001";

    async fn send(method: &str, uri: &str, body: Option<Value>) -> TestResponse {
        call(router(), method, uri, body).await
    }

    /// A fresh database with the agent's computers loaded, none yet.
    async fn agent() -> crate::db::testing::TestDb {
        let db = crate::db::testing::test_db();
        let agent =
            crate::services::computer::remote::remote_computer_service::tests::agent_row().await;
        CONFIG.set_agent_id(Some(agent.clone()));
        CONFIG.set_owner_user_id("user-1".to_string());
        REMOTE_COMPUTER_SERVICE.load(&agent).await.unwrap();
        db
    }

    #[test]
    fn reads_the_bodies_as_the_schemas_do() {
        let add = |value: Value| AddComputerBody::parse(&JsonBody(Some(value)));
        assert_eq!(add(json!({ "name": "  Laptop " })).unwrap().name, "Laptop");
        assert!(add(json!({ "name": "   " })).is_none());
        assert!(add(json!({ "name": "x".repeat(101) })).is_none());
        assert!(add(json!({ "name": "a", "platform": "beos" })).is_none());
        assert!(add(json!({ "name": "a", "installationId": "x" })).is_none());
        assert_eq!(
            add(json!({ "name": "a", "installationId": INSTALLATION }))
                .unwrap()
                .installation_id
                .as_deref(),
            Some(INSTALLATION)
        );
        let control = |value: Value| ControlBody::parse(&JsonBody(Some(value)));
        assert!(control(json!({})).is_none());
        assert!(control(json!({ "clientId": INSTALLATION, "helpId": "x" })).is_none());
        assert!(control(json!({ "clientId": INSTALLATION })).is_some());
        assert!(is_zod_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_zod_uuid("00000000-0000-0000-0000-000000000001"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn adds_a_computer_which_is_not_connected_until_its_client_links() {
        let _db = agent().await;
        let res = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "Work laptop", "platform": "macos" })),
        )
        .await;
        assert_eq!(res.status, 201);
        let computer = &res.json()["computer"];
        assert_eq!(computer["kind"], json!("remote"));
        assert_eq!(computer["name"], json!("Work laptop"));
        assert_eq!(computer["connection"], json!("disconnected"));
        assert_eq!(computer["platform"], json!("macos"));
        assert_eq!(computer["lastConnectedAt"], json!(null));
        let list = send("GET", "/agents/computers", None).await;
        let names: Vec<Value> = list.json()["computers"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] == json!("remote"))
            .map(|item| item["name"].clone())
            .collect();
        assert_eq!(names, [json!("Work laptop")]);
        let id = computer["id"].as_str().unwrap().to_string();
        COMPUTER_SERVICE.remove(&id, "user-1").await.unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_the_computer_an_installation_added_before() {
        let _db = agent().await;
        let first = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "MacBook Pro", "installationId": INSTALLATION })),
        )
        .await;
        let again = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "Work laptop", "installationId": INSTALLATION })),
        )
        .await;
        assert_eq!(again.status, 200);
        assert_eq!(
            again.json()["computer"]["id"],
            first.json()["computer"]["id"]
        );
        assert_eq!(again.json()["computer"]["name"], json!("Work laptop"));
        assert_eq!(REMOTE_COMPUTER_SERVICE.count(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_name_taken_the_local_name_and_a_blank_one() {
        let _db = agent().await;
        send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "MacBook Pro", "installationId": INSTALLATION })),
        )
        .await;
        let taken = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "MacBook Pro" })),
        )
        .await;
        assert_eq!(taken.status, 409);
        assert_eq!(
            taken.json(),
            json!({ "error": "A computer named \"MacBook Pro\" already exists." })
        );
        let local = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "Local" })),
        )
        .await;
        assert_eq!(local.status, 409);
        assert_eq!(
            local.json(),
            json!({ "error": "\"Local\" is the name of the runtime's own computer." })
        );
        let blank = send("POST", "/agents/computers", Some(json!({ "name": "   " }))).await;
        assert_eq!(blank.status, 400);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renames_and_removes_a_computer() {
        let _db = agent().await;
        let added = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "MacBook Pro" })),
        )
        .await;
        let id = added.json()["computer"]["id"].as_str().unwrap().to_string();
        let renamed = send(
            "PATCH",
            &format!("/agents/computers/{id}"),
            Some(json!({ "name": "Work laptop" })),
        )
        .await;
        assert_eq!(renamed.status, 200);
        assert_eq!(renamed.json()["name"], json!("Work laptop"));
        let path = format!("/agents/computers/{id}");
        assert_eq!(send("DELETE", &path, None).await.status, 204);
        assert_eq!(send("DELETE", &path, None).await.status, 404);
        assert_eq!(send("GET", &path, None).await.status, 404);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_a_takeover_that_names_another_computers_help_request() {
        use crate::db::schema::{conversation_messages, conversation_threads};
        use diesel::prelude::*;
        let _db = agent().await;
        let added = send(
            "POST",
            "/agents/computers",
            Some(json!({ "name": "Work laptop" })),
        )
        .await;
        let computer_id = added.json()["computer"]["id"].as_str().unwrap().to_string();
        let help_id = "00000000-0000-4000-8000-0000000000aa";
        let help = json!([{
            "type": "computer_help",
            "id": help_id,
            "reason": "Sign in",
            "status": "waiting",
            "computerId": computer_id,
        }]);
        let agent_id = CONFIG.agent_id().unwrap();
        crate::db::run(move |conn| {
            let thread = crate::db::models::NewConversationThread::new(agent_id, "user-1");
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
            message.blocks = Some(help);
            diesel::insert_into(conversation_messages::table)
                .values(&message)
                .execute(conn)?;
            Ok(())
        })
        .await
        .unwrap();
        let res = send(
            "POST",
            "/agents/computers/local/control",
            Some(json!({ "clientId": "00000000-0000-4000-8000-0000000000bb", "helpId": help_id })),
        )
        .await;
        assert_eq!(res.status, 404);
        COMPUTER_SERVICE
            .remove(&computer_id, "user-1")
            .await
            .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn keeps_the_runtimes_own_computer() {
        let _db = agent().await;
        assert_eq!(
            send("DELETE", "/agents/computers/local", None).await.status,
            409
        );
        assert_eq!(
            send(
                "PATCH",
                "/agents/computers/local",
                Some(json!({ "name": "x" }))
            )
            .await
            .status,
            409
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn answers_the_shipped_desktop_apps_paths_for_the_runtimes_own_computer() {
        let _db = agent().await;
        let status = send("GET", "/agents/computer", None).await;
        assert_eq!(status.status, 200);
        let body = status.json();
        assert_eq!(body["computerId"], json!("local"));
        assert_eq!(body["help"], json!([]));
        assert_eq!(body["awaitingHelp"], json!([]));
        assert_eq!(
            send("POST", "/agents/computer/stop", None).await.status,
            200
        );
        assert_eq!(
            send("POST", "/agents/computer/continue", Some(json!({})))
                .await
                .status,
            400
        );
    }
}
