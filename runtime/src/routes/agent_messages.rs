//! Agent Messages Route
//!
//! POST /agents/agent-messages — a message from another agent of the project,
//! posted by the delivery service. Served on `AGENT_MESSAGES_PORT` alone
//! (`create_agent_messages_app` in `server.rs`), never on the main port. The
//! ingress names the API token of each caller in `x-forwarded-token-id`, and only
//! the token `AGENT_MESSAGES_TOKEN_ID` names may post here. The message is stored
//! in the web conversation as that agent's, and its turn is scheduled like a chat
//! message's. The answer comes once the message is stored, before the turn runs;
//! the service sends a delivery again until it gets one, and the same `id` is
//! stored once.

use std::sync::LazyLock;

use axum::Router;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::post;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::protocol::chat_protocol::{
    AgentMessageKind, NackCode, UUID, UUID_MESSAGE, UUID_V4, UUID_V4_MESSAGE,
};
use crate::services::agent_conversation_service::AGENT_CONVERSATION_SERVICE;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::inbound_message_service::{
    INBOUND_MESSAGE_SERVICE, InboundMessage, InboundMessageError,
};
use crate::support::http::{JsonBody, error_json, json};
use crate::support::js;
use crate::types::AgentMessageOrigin;
use crate::{log_error, log_warn};

pub fn router() -> Router {
    Router::new().route("/agents/agent-messages", post(receive_agent_message))
}

/// The headers the ingress writes to name a person, and only a person.
const PERSON_HEADERS: [&str; 2] = ["x-forwarded-user", "x-forwarded-user-id"];

/// The header the ingress writes with the id of the API token a caller used. It
/// drops any copy the caller sent, so it is to be trusted only for a request that
/// came through the ingress.
const TOKEN_ID_HEADER: &str = "x-forwarded-token-id";

/// Why a request is not the delivery service's: the status it answers (401 or
/// 503) and the reason the warning logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub reason: &'static str,
}

/// Why a request is not the delivery service's, or `None` when it is. `expected`
/// is `AGENT_MESSAGES_TOKEN_ID`.
fn not_the_delivery_service(expected: Option<&str>, token_id: Option<&str>) -> Option<Refusal> {
    let Some(expected) = expected.filter(|e| !e.is_empty()) else {
        return Some(Refusal {
            status: 503,
            reason: "AGENT_MESSAGES_TOKEN_ID is not set",
        });
    };
    let Some(token_id) = token_id.filter(|t| !t.is_empty()) else {
        return Some(Refusal {
            status: 401,
            reason: "the ingress named no API token",
        });
    };
    if same_text(token_id, expected) {
        None
    } else {
        Some(Refusal {
            status: 401,
            reason: "another API token",
        })
    }
}

/// Equal strings, compared in constant time whatever their lengths.
fn same_text(a: &str, b: &str) -> bool {
    let digest_a = Sha256::digest(a.as_bytes());
    let digest_b = Sha256::digest(b.as_bytes());
    digest_a.ct_eq(&digest_b).into()
}

/// A run of JavaScript `\s` characters.
static JS_WHITESPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+")
        .expect("valid regex")
});

/// A control character (`\p{Cc}`).
static CONTROL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Cc}").expect("valid regex"));

/// A sender's id or name on one line, as the prompt's attribute and every client
/// show it: each control character becomes a space, each run of whitespace one
/// space, and the ends are trimmed. The length limit applies to the text before
/// this, and blank text after it is refused (`must not be blank`).
pub fn one_line(text: &str) -> String {
    let spaced = CONTROL.replace_all(text, " ");
    let collapsed = JS_WHITESPACE.replace_all(&spaced, " ");
    collapsed.trim_matches(' ').to_string()
}

/// What another agent's message is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageBodyKind {
    Message,
    Notice,
}

impl AgentMessageBodyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentMessageBodyKind::Message => "message",
            AgentMessageBodyKind::Notice => "notice",
        }
    }
}

/// The sending agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMessageSender {
    /// At most 64 characters, then `one_line`, then not blank.
    pub id: String,
    /// At most 128 characters, then `one_line`, then not blank.
    pub name: String,
}

/// The body of `POST /agents/agent-messages`, as the zod schema reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMessageBody {
    /// The delivery's id, which becomes the stored message's. A uuid v4.
    pub id: String,
    /// The message's own id, which a reply names. Any uuid.
    pub message_id: String,
    pub conversation_id: String,
    pub kind: AgentMessageBodyKind,
    pub sender: AgentMessageSender,
    /// At most 32,000 characters, and not blank after trimming.
    pub content: String,
    /// Default `false`.
    pub expects_reply: bool,
    /// At most 5 uuids. Default `[]`.
    pub attachment_ids: Vec<String>,
}

/// The first issue zod 4 reports for the body: where it is and what it says.
struct Issue {
    path: Vec<String>,
    message: String,
}

type Checked<T> = Result<T, Issue>;

fn issue(path: &[&str], message: impl Into<String>) -> Issue {
    Issue {
        path: path.iter().map(|p| p.to_string()).collect(),
        message: message.into(),
    }
}

/// zod's name for a JSON value's type; `undefined` for a missing one.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(path: &[&str], expected: &str, value: Option<&Value>) -> Issue {
    issue(
        path,
        format!(
            "Invalid input: expected {expected}, received {}",
            received(value)
        ),
    )
}

fn string<'a>(path: &[&str], value: Option<&'a Value>) -> Checked<&'a str> {
    match value {
        Some(Value::String(text)) => Ok(text),
        other => Err(invalid_type(path, "string", other)),
    }
}

fn max_chars(path: &[&str], text: &str, max: usize) -> Checked<()> {
    if js::len16(text) > max {
        return Err(issue(
            path,
            format!("Too big: expected string to have <={max} characters"),
        ));
    }
    Ok(())
}

fn matching(
    path: &[&str],
    value: Option<&Value>,
    pattern: &Regex,
    message: &str,
) -> Checked<String> {
    let text = string(path, value)?;
    if !pattern.is_match(text) {
        return Err(issue(path, message));
    }
    Ok(text.to_string())
}

/// `oneLine(max)`: a string of at most `max` characters, put on one line, not blank.
fn one_line_field(path: &[&str], value: Option<&Value>, max: usize) -> Checked<String> {
    let text = string(path, value)?;
    max_chars(path, text, max)?;
    let line = one_line(text);
    if js::len16(&line) == 0 {
        return Err(issue(path, "must not be blank"));
    }
    Ok(line)
}

/// A `.strict()` object's unknown keys, reported after its fields.
fn unrecognized(path: &[&str], object: &Map<String, Value>, known: &[&str]) -> Checked<()> {
    let keys: Vec<String> = object
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    if keys.is_empty() {
        return Ok(());
    }
    let plural = if keys.len() > 1 { "s" } else { "" };
    Err(issue(
        path,
        format!("Unrecognized key{plural}: {}", keys.join(", ")),
    ))
}

fn object<'a>(path: &[&str], value: Option<&'a Value>) -> Checked<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        other => Err(invalid_type(path, "object", other)),
    }
}

fn sender(value: Option<&Value>) -> Checked<AgentMessageSender> {
    let map = object(&["sender"], value)?;
    let id = one_line_field(&["sender", "id"], map.get("id"), 64)?;
    let name = one_line_field(&["sender", "name"], map.get("name"), 128)?;
    unrecognized(&["sender"], map, &["id", "name"])?;
    Ok(AgentMessageSender { id, name })
}

fn attachment_ids(value: Option<&Value>) -> Checked<Vec<String>> {
    let items = match value {
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        other => return Err(invalid_type(&["attachmentIds"], "array", other)),
    };
    let mut ids = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let index = index.to_string();
        ids.push(matching(
            &["attachmentIds", &index],
            Some(item),
            &UUID,
            UUID_MESSAGE,
        )?);
    }
    if ids.len() > 5 {
        return Err(issue(
            &["attachmentIds"],
            "Too big: expected array to have <=5 items",
        ));
    }
    Ok(ids)
}

fn check_body(body: Option<&Value>) -> Checked<AgentMessageBody> {
    let map = object(&[], body)?;
    let id = matching(&["id"], map.get("id"), &UUID_V4, UUID_V4_MESSAGE)?;
    let message_id = matching(&["messageId"], map.get("messageId"), &UUID, UUID_MESSAGE)?;
    let conversation_id = matching(
        &["conversationId"],
        map.get("conversationId"),
        &UUID,
        UUID_MESSAGE,
    )?;
    let kind = match map.get("kind") {
        Some(Value::String(kind)) if kind == "message" => AgentMessageBodyKind::Message,
        Some(Value::String(kind)) if kind == "notice" => AgentMessageBodyKind::Notice,
        _ => {
            return Err(issue(
                &["kind"],
                "Invalid option: expected one of \"message\"|\"notice\"",
            ));
        }
    };
    let sender = sender(map.get("sender"))?;
    let content = string(&["content"], map.get("content"))?;
    max_chars(&["content"], content, 32_000)?;
    if js::trim(content).is_empty() {
        return Err(issue(&["content"], "content must not be blank"));
    }
    let expects_reply = match map.get("expectsReply") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        other => return Err(invalid_type(&["expectsReply"], "boolean", other)),
    };
    let attachment_ids = attachment_ids(map.get("attachmentIds"))?;
    unrecognized(
        &[],
        map,
        &[
            "id",
            "messageId",
            "conversationId",
            "kind",
            "sender",
            "content",
            "expectsReply",
            "attachmentIds",
        ],
    )?;
    Ok(AgentMessageBody {
        id,
        message_id,
        conversation_id,
        kind,
        sender,
        content: content.to_string(),
        expects_reply,
        attachment_ids,
    })
}

/// Validate a request body as the zod schema does. A refusal is the first issue
/// as `<path joined with '.' or 'body'>: <zod message>`, which the route answers
/// 400.
pub fn parse_agent_message(body: Option<&Value>) -> Result<AgentMessageBody, String> {
    check_body(body).map_err(|issue| {
        let path = if issue.path.is_empty() {
            "body".to_string()
        } else {
            issue.path.join(".")
        };
        format!("{path}: {}", issue.message)
    })
}

/// What each refusal of the inbound service is over HTTP.
fn refusal_status(code: &NackCode) -> Option<u16> {
    match code.as_str() {
        "unavailable" => Some(503),
        "unknown_thread" => Some(404),
        "id_conflict" => Some(409),
        _ => None,
    }
}

/// The 202 body: where the message was stored and whether its turn waits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageAccepted {
    pub message_id: String,
    pub thread_id: String,
    pub queued: bool,
    pub duplicate: bool,
}

/// A header's value as `req.get` reads it: repeated values joined with `, `.
fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<&str> = headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// POST /agents/agent-messages
async fn receive_agent_message(headers: HeaderMap, body: JsonBody) -> Response {
    // The ingress names a person signed in to it with these headers. People talk
    // to the agent in the conversation, and refusing them here keeps a browser
    // from posting as another agent.
    if PERSON_HEADERS
        .iter()
        .any(|name| headers.contains_key(*name))
    {
        return error_json(
            403,
            "Only another agent of the project sends agent messages.",
        );
    }

    // The ingress admits every member of the project, their API tokens and other
    // agents among them, so only the token it names says who sent this. Checked
    // before anything in the body is read.
    let token_id = header(&headers, TOKEN_ID_HEADER);
    if let Some(refusal) = not_the_delivery_service(
        CONFIG.agent_messages_token_id.as_deref(),
        token_id.as_deref(),
    ) {
        let mut fields = json!({ "reason": refusal.reason, "status": refusal.status });
        if let Some(token_id) = &token_id {
            fields["tokenId"] = Value::String(js::slice16(token_id, 0, 12));
        }
        log_warn!(fields, "[AgentMessages] Refused a delivery");
        return error_json(
            refusal.status,
            if refusal.status == 503 {
                "Agent messages are not set up on this agent yet."
            } else {
                "Only the delivery service posts agent messages."
            },
        );
    }

    let body = match parse_agent_message(body.0.as_ref()) {
        Ok(body) => body,
        Err(error) => return error_json(400, error),
    };

    let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
        return error_json(503, "The agent is still starting. Try again shortly.");
    };

    match store(&agent_id, &body).await {
        Ok(accepted) => json(202, accepted),
        Err(err) => {
            if let Some(refused) = err.downcast_ref::<InboundMessageError>() {
                if let Some(status) = refusal_status(&refused.code) {
                    return error_json(status, refused.message.clone());
                }
            }
            log_error!(
                json!({ "err": err_json(&err), "deliveryId": body.id }),
                "[AgentMessages] Could not store an agent message"
            );
            error_json(500, "The message could not be stored.")
        }
    }
}

async fn store(agent_id: &str, body: &AgentMessageBody) -> anyhow::Result<AgentMessageAccepted> {
    // The web conversation an earlier message of this conversation between
    // agents arrived in. One the runtime has not seen, an answer to the agent's
    // own message included, goes to the one conversation in single-thread mode,
    // else to the newest.
    let thread_id = match AGENT_CONVERSATION_SERVICE
        .thread_for(&body.conversation_id, agent_id)
        .await?
    {
        Some(thread_id) => thread_id,
        None => {
            CONVERSATION_SERVICE
                .get_or_create_latest_thread(agent_id, &CONFIG.owner_user_id())
                .await?
                .id
        }
    };
    let kind = match body.kind {
        AgentMessageBodyKind::Notice => AgentMessageKind::Notice,
        AgentMessageBodyKind::Message if body.expects_reply => AgentMessageKind::Ask,
        AgentMessageBodyKind::Message => AgentMessageKind::Message,
    };
    let mut acceptance = INBOUND_MESSAGE_SERVICE
        .accept(InboundMessage {
            id: body.id.clone(),
            thread_id,
            content: body.content.clone(),
            attachment_ids: body.attachment_ids.clone(),
            sender: None,
            agent_message: Some(AgentMessageOrigin {
                kind,
                sender_id: body.sender.id.clone(),
                sender_name: body.sender.name.clone(),
                message_id: body.message_id.clone(),
            }),
        })
        .await?;
    acceptance.release_turn();
    // The rest of this conversation between agents follows it here. The message
    // is stored either way, so a failure costs only where the next one goes.
    if let Err(err) = AGENT_CONVERSATION_SERVICE
        .remember(&body.conversation_id, &acceptance.message.thread_id)
        .await
    {
        log_warn!(
            json!({ "err": err_json(&err), "deliveryId": body.id }),
            "[AgentMessages] Could not keep where the conversation is"
        );
    }
    Ok(AgentMessageAccepted {
        message_id: acceptance.message.id,
        thread_id: acceptance.message.thread_id,
        queued: acceptance.queued,
        duplicate: acceptance.duplicate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::http::testing::{TestResponse, app, send};

    const DELIVERY: &str = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";
    const MESSAGE: &str = "a1b2c3d4-e5f6-4071-8293-a4b5c6d7e8f9";
    const CONVERSATION: &str = "b2c3d4e5-f607-4182-9304-b5c6d7e8f9a0";
    const DELIVERY_TOKEN_ID: &str = "3c1f0a9e-7b2d-4e8f-9a61-5d4c3b2a1f0e";

    fn delivery() -> Value {
        json!({
            "id": DELIVERY,
            "messageId": MESSAGE,
            "conversationId": CONVERSATION,
            "kind": "message",
            "sender": { "id": "agent-r", "name": "Researcher" },
            "content": "Can you check whether CI is green on main?",
            "expectsReply": true,
            "attachmentIds": [],
        })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut body = delivery();
        body[key] = value;
        body
    }

    async fn post(body: Value, headers: &[(&str, &str)]) -> TestResponse {
        let mut req =
            crate::support::http::testing::request("POST", "/agents/agent-messages", Some(body));
        for (name, value) in headers {
            req.headers_mut().insert(
                http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        send(app(router()), req).await
    }

    #[tokio::test]
    async fn refuses_a_person_the_ingress_names_with_403_even_with_the_delivery_token() {
        let res = post(
            delivery(),
            &[
                ("x-forwarded-user", "someone@example.com"),
                (TOKEN_ID_HEADER, DELIVERY_TOKEN_ID),
            ],
        )
        .await;
        assert_eq!(res.status, 403);
        assert_eq!(
            res.json(),
            json!({ "error": "Only another agent of the project sends agent messages." })
        );
    }

    #[tokio::test]
    async fn answers_503_while_agent_messages_token_id_is_unset() {
        let res = post(delivery(), &[(TOKEN_ID_HEADER, DELIVERY_TOKEN_ID)]).await;
        assert_eq!(res.status, 503);
        assert_eq!(
            res.json(),
            json!({ "error": "Agent messages are not set up on this agent yet." })
        );
    }

    #[test]
    fn accepts_only_the_delivery_service_token() {
        assert_eq!(
            not_the_delivery_service(None, Some(DELIVERY_TOKEN_ID)),
            Some(Refusal {
                status: 503,
                reason: "AGENT_MESSAGES_TOKEN_ID is not set"
            })
        );
        assert_eq!(
            not_the_delivery_service(Some(DELIVERY_TOKEN_ID), None),
            Some(Refusal {
                status: 401,
                reason: "the ingress named no API token"
            })
        );
        assert_eq!(
            not_the_delivery_service(Some(DELIVERY_TOKEN_ID), Some("another")),
            Some(Refusal {
                status: 401,
                reason: "another API token"
            })
        );
        assert_eq!(
            not_the_delivery_service(Some(DELIVERY_TOKEN_ID), Some(DELIVERY_TOKEN_ID)),
            None
        );
    }

    #[test]
    fn reads_a_delivery_as_the_schema_does() {
        let body = parse_agent_message(Some(&delivery())).unwrap();
        assert_eq!(body.kind, AgentMessageBodyKind::Message);
        assert!(body.expects_reply);
        assert_eq!(body.sender.name, "Researcher");

        let mut minimal = delivery();
        minimal.as_object_mut().unwrap().remove("expectsReply");
        minimal.as_object_mut().unwrap().remove("attachmentIds");
        let body = parse_agent_message(Some(&minimal)).unwrap();
        assert!(!body.expects_reply);
        assert!(body.attachment_ids.is_empty());
    }

    #[test]
    fn keeps_a_sender_on_one_line() {
        let body = parse_agent_message(Some(&with(
            "sender",
            json!({ "id": "agent-r", "name": "Research\n\u{7} Bot " }),
        )))
        .unwrap();
        assert_eq!(body.sender.name, "Research Bot");
    }

    #[test]
    fn refuses_a_bad_body_with_the_first_issue() {
        let cases = [
            (
                None,
                "body: Invalid input: expected object, received undefined",
            ),
            (
                Some(json!([])),
                "body: Invalid input: expected object, received array",
            ),
            (
                Some(with("id", json!("not-a-uuid"))),
                "id: must be a uuid v4",
            ),
            (
                Some(with("id", json!("a1b2c3d4-e5f6-1071-8293-a4b5c6d7e8f9"))),
                "id: must be a uuid v4",
            ),
            (
                Some(with("messageId", json!(7))),
                "messageId: Invalid input: expected string, received number",
            ),
            (
                Some(with("kind", json!("shout"))),
                "kind: Invalid option: expected one of \"message\"|\"notice\"",
            ),
            (
                Some(with("sender", json!({ "id": "a", "name": " \n " }))),
                "sender.name: must not be blank",
            ),
            (
                Some(with("sender", json!({ "id": "x".repeat(65), "name": "n" }))),
                "sender.id: Too big: expected string to have <=64 characters",
            ),
            (
                Some(with(
                    "sender",
                    json!({ "id": "a", "name": "n", "role": "x" }),
                )),
                "sender: Unrecognized key: \"role\"",
            ),
            (
                Some(with("content", json!("   "))),
                "content: content must not be blank",
            ),
            (
                Some(with("content", json!("x".repeat(32_001)))),
                "content: Too big: expected string to have <=32000 characters",
            ),
            (
                Some(with("expectsReply", json!("yes"))),
                "expectsReply: Invalid input: expected boolean, received string",
            ),
            (
                Some(with("attachmentIds", json!(["nope"]))),
                "attachmentIds.0: must be a uuid",
            ),
            (
                Some(with("extra", json!(1))),
                "body: Unrecognized key: \"extra\"",
            ),
        ];
        for (body, expected) in cases {
            assert_eq!(
                parse_agent_message(body.as_ref()).unwrap_err(),
                expected,
                "{body:?}"
            );
        }
        let six: Vec<Value> = (0..6).map(|_| json!(MESSAGE)).collect();
        assert_eq!(
            parse_agent_message(Some(&with("attachmentIds", Value::Array(six)))).unwrap_err(),
            "attachmentIds: Too big: expected array to have <=5 items"
        );
    }
}
