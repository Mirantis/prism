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

use axum::Json;
use axum::Router;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::post;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::protocol::chat_protocol::NackCode;

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

/// Why a request is not the delivery service's, or `None` when it is:
/// - `AGENT_MESSAGES_TOKEN_ID` unset: 503 `AGENT_MESSAGES_TOKEN_ID is not set`
/// - no token named: 401 `the ingress named no API token`
/// - another token: 401 `another API token`
fn not_the_delivery_service(token_id: Option<&str>) -> Option<Refusal> {
    todo!()
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

/// The sending agent. zod `.strict()`: another key is refused.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AgentMessageSender {
    /// At most 64 characters, then `one_line`, then not blank.
    pub id: String,
    /// At most 128 characters, then `one_line`, then not blank.
    pub name: String,
}

/// The body of `POST /agents/agent-messages`, as the zod schema reads it.
/// zod `.strict()`: a key not listed here is refused.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageBody {
    /// The delivery's id, which becomes the stored message's. A uuid v4
    /// (`must be a uuid v4`).
    pub id: String,
    /// The message's own id, which a reply names. Any uuid (`must be a uuid`).
    pub message_id: String,
    /// Any uuid (`must be a uuid`).
    pub conversation_id: String,
    /// `message` or `notice`.
    pub kind: AgentMessageBodyKind,
    pub sender: AgentMessageSender,
    /// At most 32,000 characters, and not blank after trimming
    /// (`content must not be blank`).
    pub content: String,
    /// Default `false`.
    #[serde(default)]
    pub expects_reply: bool,
    /// At most 5 uuids. Default `[]`.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

/// Validate a request body as the zod schema does. A refusal is the first issue
/// as `<path joined with '.' or 'body'>: <zod message>`, or `Invalid body.` when
/// there is none, which the route answers 400.
pub fn parse_agent_message(body: &Value) -> Result<AgentMessageBody, String> {
    todo!()
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

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// POST /agents/agent-messages
///
/// In order:
/// - A request naming a person (`x-forwarded-user` or `x-forwarded-user-id`
///   present) answers 403 `Only another agent of the project sends agent messages.`
///   People talk to the agent in the conversation, and refusing them here keeps a
///   browser from posting as another agent.
/// - The ingress admits every member of the project, their API tokens and other
///   agents among them, so only the token it names says who sent this. Checked
///   before anything in the body is read: a refusal logs a warning
///   `[AgentMessages] Refused a delivery` with `reason`, `status` and the first 12
///   characters of `tokenId`, and answers 503
///   `Agent messages are not set up on this agent yet.` or 401
///   `Only the delivery service posts agent messages.`.
/// - A body the schema refuses answers 400.
/// - No `config.agent_id` answers 503 `The agent is still starting. Try again shortly.`
///
/// The web conversation an earlier message of this conversation between agents
/// arrived in (`AGENT_CONVERSATION_SERVICE.thread_for`) takes the message; one the
/// runtime has not seen, an answer to the agent's own message included, goes to
/// `get_or_create_latest_thread(agent_id, config.owner_user_id)`. The message goes
/// to `INBOUND_MESSAGE_SERVICE.accept` with no sender and an `agentMessage` whose
/// kind is `notice`, else `ask` when it expects a reply, else `message`. The rest
/// of the conversation between agents follows it there (`remember`); a failure of
/// that logs a warning `[AgentMessages] Could not keep where the conversation is`
/// with `err` and `deliveryId`, and the route still answers 202
/// `AgentMessageAccepted`.
///
/// An `InboundMessageError` with a mapped code answers that status with its
/// message; any other failure logs `[AgentMessages] Could not store an agent
/// message` (with `err` and `deliveryId`) and answers 500
/// `The message could not be stored.`.
///
/// The body is read as any JSON value, since the 400 text is the schema's.
async fn receive_agent_message(headers: HeaderMap, Json(body): Json<Value>) -> Response {
    todo!()
}
