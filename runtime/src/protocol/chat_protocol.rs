//! The chat socket's wire contract, `/api/ws`, version 2.
//!
//! This module is the contract: the gateway parses every inbound frame with these
//! types and builds every outbound one from them. Each client keeps its own copy
//! of the shapes, and the recorded frames in `src/protocol/fixtures/` are what
//! hold all of them to this one. Client authors read `docs/websocket-protocol.md`.
//!
//! Every frame is JSON text except voice and dictation audio, which travels as
//! binary frames outside this contract.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::ThreadMode;
use crate::constants::MAX_ATTACHMENTS_PER_MESSAGE;
use crate::db::models::MessageRole;
use crate::types::{InvokeError, InvokeErrorType};

/// The version a client names in `hello`. There is one; an older client is told to update.
pub const PROTOCOL_VERSION: i64 = 2;

/// Close codes the server uses, in the 4000 range the WebSocket spec leaves to
/// applications. A client acts on the code, never on the reason text.
#[derive(Debug, Clone, Copy)]
pub struct CloseCodes {
    /// The client speaks another protocol version, or skipped `hello`. Update the client.
    pub protocol_unsupported: u16,
    /// No `hello` arrived in time.
    pub hello_timeout: u16,
    /// The socket fell too far behind to be sent to. Reconnect and resume.
    pub slow_consumer: u16,
    /// A newer connection took this one's place at the per-agent cap. Reconnect if still wanted.
    pub replaced: u16,
}

pub const CLOSE_CODES: CloseCodes = CloseCodes {
    protocol_unsupported: 4426,
    hello_timeout: 4408,
    slow_consumer: 4008,
    replaced: 4001,
};

/// How long the server waits for `hello` before it closes the socket.
pub const HELLO_TIMEOUT_MS: i64 = 5_000;

/// The largest text frame the server reads. A 100 MB default is a denial of service.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// The longest message a person can send, in characters. Four bytes a character
/// at worst still leaves it inside `MAX_FRAME_BYTES`.
pub const MAX_MESSAGE_CHARS: usize = 200_000;

/// How often a client pings, and how long it waits for the `pong`, before it treats the socket as dead.
pub const CLIENT_PING_INTERVAL_MS: i64 = 25_000;
pub const CLIENT_PONG_DEADLINE_MS: i64 = 10_000;

/// A version-4 uuid, the only id a client may choose for a message. Checked
/// rather than trusted because it becomes the row's primary key.
pub static UUID_V4: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .expect("valid regex")
});

/// The message of a value that is not a v4 uuid.
pub const UUID_V4_MESSAGE: &str = "must be a uuid v4";

/// Any uuid. Threads and attachments are minted by the server, which does not
/// promise a version.
pub static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid regex")
});

/// The message of a value that is not a uuid.
pub const UUID_MESSAGE: &str = "must be a uuid";

/// Whether `text` is a version-4 uuid.
pub fn is_uuid_v4(text: &str) -> bool {
    UUID_V4.is_match(text)
}

/// Whether `text` is a uuid of any version.
pub fn is_uuid(text: &str) -> bool {
    UUID.is_match(text)
}

/// A client's name for one request, echoed back as `re` on the answer: 1 to 64
/// characters.
pub const REQUEST_ID_MAX_CHARS: usize = 64;

// ============================================================================
// Client → server
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloClient {
    /// 1 to 64 characters.
    pub name: String,
    /// At most 64 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResume {
    /// 1 to 64 characters.
    pub stream_id: String,
    /// A non-negative integer.
    pub seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloPayload {
    /// An integer.
    pub protocol: i64,
    pub client: HelloClient,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<HelloResume>,
}

/// `{ type: 'hello', id, payload }`, the first frame a client sends.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "hello")]
pub struct HelloFrame {
    pub id: String,
    pub payload: HelloPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessage {
    /// A v4 uuid (`must be a uuid v4`).
    pub id: String,
    /// A uuid (`must be a uuid`).
    pub thread_id: String,
    /// At most `MAX_MESSAGE_CHARS` characters.
    pub content: String,
    /// Uuids, at most `MAX_ATTACHMENTS_PER_MESSAGE`; `[]` when absent. A message
    /// needs text or an attachment (`a message needs text or an attachment`).
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SendPayload {
    pub message: SendMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SendFrame {
    pub id: String,
    pub payload: SendPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelPayload {
    /// A uuid.
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CancelFrame {
    pub id: String,
    pub payload: CancelPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PingFrame {
    pub id: String,
}

/// Voice and dictation keep the fields they had; `docs/voice-chat.md` and
/// `docs/dictation.md` describe them, and the gateway reads each one with care
/// of its own. The envelope is what changes: any object, `{}` when absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LooseFrame {
    pub id: String,
    #[serde(default)]
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DictationStopPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DictationStopFrame {
    pub id: String,
    #[serde(default)]
    pub payload: DictationStopPayload,
}

/// Every frame a client may send after `hello`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientFrame {
    #[serde(rename = "send")]
    Send(SendFrame),
    #[serde(rename = "cancel")]
    Cancel(CancelFrame),
    #[serde(rename = "ping")]
    Ping(PingFrame),
    #[serde(rename = "voice_start")]
    VoiceStart(LooseFrame),
    #[serde(rename = "voice_stop")]
    VoiceStop(LooseFrame),
    #[serde(rename = "dictation_start")]
    DictationStart(LooseFrame),
    #[serde(rename = "dictation_stop")]
    DictationStop(DictationStopFrame),
}

impl ClientFrame {
    /// The frame's `type`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Send(_) => "send",
            Self::Cancel(_) => "cancel",
            Self::Ping(_) => "ping",
            Self::VoiceStart(_) => "voice_start",
            Self::VoiceStop(_) => "voice_stop",
            Self::DictationStart(_) => "dictation_start",
            Self::DictationStop(_) => "dictation_stop",
        }
    }

    /// The request id the answer names as `re`.
    pub fn id(&self) -> &str {
        match self {
            Self::Send(f) => &f.id,
            Self::Cancel(f) => &f.id,
            Self::Ping(f) => &f.id,
            Self::VoiceStart(f) | Self::VoiceStop(f) | Self::DictationStart(f) => &f.id,
            Self::DictationStop(f) => &f.id,
        }
    }
}

/// Validates a `hello` frame as the contract's schema does: `type` is `hello`,
/// `id` is 1 to 64 characters, `payload.protocol` an integer, `payload.client.name`
/// 1 to 64 characters, `payload.client.version` at most 64, and `payload.resume`,
/// when present, has a `streamId` of 1 to 64 characters and a non-negative
/// integer `seq`. Unknown keys are dropped. `Err` holds the first issue's message,
/// worded as zod 4 words it.
pub fn parse_hello_frame(raw: &Value) -> Result<HelloFrame, String> {
    let mut issues = zod::Issues::default();
    let frame = zod::object(Some(raw), &mut issues).map(|obj| {
        zod::literal(obj.get("type"), "hello", &mut issues);
        let id = zod::request_id(obj.get("id"), &mut issues);
        let payload = zod::object(obj.get("payload"), &mut issues).map(|payload| {
            let protocol = zod::int(payload.get("protocol"), &mut issues);
            let client = zod::object(payload.get("client"), &mut issues).map(|client| {
                let name = zod::string(client.get("name"), Some(1), Some(64), &mut issues);
                let version = match client.get("version") {
                    None => None,
                    some => zod::string(some, None, Some(64), &mut issues),
                };
                HelloClient {
                    name: name.unwrap_or_default(),
                    version,
                }
            });
            let resume = match payload.get("resume") {
                None => None,
                some => zod::object(some, &mut issues).map(|resume| {
                    let stream_id =
                        zod::string(resume.get("streamId"), Some(1), Some(64), &mut issues);
                    let seq = zod::int(resume.get("seq"), &mut issues);
                    if let Some(seq) = seq {
                        zod::nonnegative(seq, &mut issues);
                    }
                    HelloResume {
                        stream_id: stream_id.unwrap_or_default(),
                        seq: seq.unwrap_or_default() as i64,
                    }
                }),
            };
            (protocol, client, resume)
        });
        (id, payload)
    });
    issues.first()?;
    let Some((Some(id), Some((Some(protocol), Some(client), resume)))) = frame else {
        return Err(zod::INVALID_INPUT.to_string());
    };
    Ok(HelloFrame {
        id,
        payload: HelloPayload {
            protocol: protocol as i64,
            client,
            resume,
        },
    })
}

/// Validates a frame a client sends after `hello`: a `type` naming one of the
/// `ClientFrame` variants, `id` of 1 to 64 characters, and that variant's
/// payload. A `send` message has a v4 uuid `id` (`must be a uuid v4`), a uuid
/// `threadId` (`must be a uuid`), `content` of at most `MAX_MESSAGE_CHARS`
/// characters, at most `MAX_ATTACHMENTS_PER_MESSAGE` uuid `attachmentIds`
/// (`[]` when absent), and text or an attachment
/// (`a message needs text or an attachment`, checked after the fields). A
/// `cancel` payload has a uuid `threadId`. Voice and dictation payloads are any
/// object (`{}` when absent); `dictation_stop`'s `commit` is a boolean when
/// present. Unknown keys are dropped. `Err` holds the first issue's message, as
/// the gateway's `nack` sends it, worded as zod 4 words it.
pub fn parse_client_frame(raw: &Value) -> Result<ClientFrame, String> {
    let mut issues = zod::Issues::default();
    let Some(obj) = zod::object(Some(raw), &mut issues) else {
        return Err(issues.first().unwrap_err());
    };
    let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
    let frame = match kind {
        "send" => {
            let id = zod::request_id(obj.get("id"), &mut issues);
            let message = zod::object(obj.get("payload"), &mut issues)
                .and_then(|payload| zod::send_message(payload.get("message"), &mut issues));
            id.zip(message).map(|(id, message)| {
                ClientFrame::Send(SendFrame {
                    id,
                    payload: SendPayload { message },
                })
            })
        }
        "cancel" => {
            let id = zod::request_id(obj.get("id"), &mut issues);
            let thread_id = zod::object(obj.get("payload"), &mut issues).and_then(|payload| {
                zod::matching(
                    payload.get("threadId"),
                    &UUID,
                    UUID_MESSAGE,
                    None,
                    &mut issues,
                )
            });
            id.zip(thread_id).map(|(id, thread_id)| {
                ClientFrame::Cancel(CancelFrame {
                    id,
                    payload: CancelPayload { thread_id },
                })
            })
        }
        "ping" => zod::request_id(obj.get("id"), &mut issues)
            .map(|id| ClientFrame::Ping(PingFrame { id })),
        "voice_start" | "voice_stop" | "dictation_start" => {
            let id = zod::request_id(obj.get("id"), &mut issues);
            let payload = match obj.get("payload") {
                None => Some(Map::new()),
                some => zod::record(some, &mut issues),
            };
            id.zip(payload).map(|(id, payload)| {
                let frame = LooseFrame { id, payload };
                match kind {
                    "voice_start" => ClientFrame::VoiceStart(frame),
                    "voice_stop" => ClientFrame::VoiceStop(frame),
                    _ => ClientFrame::DictationStart(frame),
                }
            })
        }
        "dictation_stop" => {
            let id = zod::request_id(obj.get("id"), &mut issues);
            let payload = match obj.get("payload") {
                None => Some(DictationStopPayload::default()),
                some => zod::object(some, &mut issues).map(|payload| DictationStopPayload {
                    commit: match payload.get("commit") {
                        None => None,
                        some => zod::boolean(some, &mut issues),
                    },
                }),
            };
            id.zip(payload)
                .map(|(id, payload)| ClientFrame::DictationStop(DictationStopFrame { id, payload }))
        }
        _ => {
            return Err(format!(
                "Invalid discriminator value. Expected {}",
                CLIENT_FRAME_TYPES
                    .iter()
                    .map(|t| format!("'{t}'"))
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }
    };
    issues.first()?;
    frame.ok_or_else(|| zod::INVALID_INPUT.to_string())
}

/// The `type` of every frame a client may send after `hello`, in the order the
/// contract lists them.
const CLIENT_FRAME_TYPES: [&str; 7] = [
    "send",
    "cancel",
    "ping",
    "voice_start",
    "voice_stop",
    "dictation_start",
    "dictation_stop",
];

/// Validation as the contract's zod 4 schemas do it: every field is checked in the
/// schema's key order, every issue is kept, and the first one's message is the
/// answer. A check that runs after a field's type was wrong does not run, as zod
/// skips the checks of an aborted value.
mod zod {
    use serde_json::{Map, Value};

    use super::{
        MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_CHARS, SendMessage, UUID, UUID_MESSAGE, UUID_V4,
        UUID_V4_MESSAGE,
    };
    use crate::support::js;

    pub(super) const INVALID_INPUT: &str = "Invalid input";

    /// The issues found so far, each with whether it aborts the checks after it.
    #[derive(Default)]
    pub(super) struct Issues(Vec<(String, bool)>);

    impl Issues {
        fn push(&mut self, message: impl Into<String>, aborts: bool) {
            self.0.push((message.into(), aborts));
        }

        /// The first issue's message, as `Err`.
        pub(super) fn first(&self) -> Result<(), String> {
            match self.0.first() {
                Some((message, _)) => Err(message.clone()),
                None => Ok(()),
            }
        }

        fn len(&self) -> usize {
            self.0.len()
        }

        /// Whether an issue from `start` on aborts later checks.
        fn aborted_since(&self, start: usize) -> bool {
            self.0[start..].iter().any(|(_, aborts)| *aborts)
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

    fn invalid_type(expected: &str, value: Option<&Value>, issues: &mut Issues) {
        issues.push(
            format!(
                "Invalid input: expected {expected}, received {}",
                received(value)
            ),
            true,
        );
    }

    pub(super) fn object<'a>(
        value: Option<&'a Value>,
        issues: &mut Issues,
    ) -> Option<&'a Map<String, Value>> {
        match value {
            Some(Value::Object(map)) => Some(map),
            other => {
                invalid_type("object", other, issues);
                None
            }
        }
    }

    /// `z.record(z.string(), z.unknown())`.
    pub(super) fn record(value: Option<&Value>, issues: &mut Issues) -> Option<Map<String, Value>> {
        match value {
            Some(Value::Object(map)) => Some(map.clone()),
            other => {
                invalid_type("record", other, issues);
                None
            }
        }
    }

    pub(super) fn literal(value: Option<&Value>, expected: &str, issues: &mut Issues) {
        if value.and_then(Value::as_str) != Some(expected) {
            issues.push(format!("Invalid input: expected \"{expected}\""), true);
        }
    }

    pub(super) fn boolean(value: Option<&Value>, issues: &mut Issues) -> Option<bool> {
        match value {
            Some(Value::Bool(flag)) => Some(*flag),
            other => {
                invalid_type("boolean", other, issues);
                None
            }
        }
    }

    /// `z.string()` with its `min` and `max` lengths in UTF-16 code units.
    pub(super) fn string(
        value: Option<&Value>,
        min: Option<usize>,
        max: Option<usize>,
        issues: &mut Issues,
    ) -> Option<String> {
        let Some(Value::String(text)) = value else {
            invalid_type("string", value, issues);
            return None;
        };
        let len = js::len16(text);
        if let Some(min) = min.filter(|min| len < *min) {
            issues.push(
                format!("Too small: expected string to have >={min} characters"),
                false,
            );
        }
        if let Some(max) = max.filter(|max| len > *max) {
            issues.push(
                format!("Too big: expected string to have <={max} characters"),
                false,
            );
        }
        Some(text.clone())
    }

    /// A string that must match `pattern`, worded with `message` when it does not.
    pub(super) fn matching(
        value: Option<&Value>,
        pattern: &regex::Regex,
        message: &str,
        max: Option<usize>,
        issues: &mut Issues,
    ) -> Option<String> {
        let text = string(value, None, max, issues)?;
        if !pattern.is_match(&text) {
            issues.push(message, false);
        }
        Some(text)
    }

    /// A client's name for one request: 1 to 64 characters.
    pub(super) fn request_id(value: Option<&Value>, issues: &mut Issues) -> Option<String> {
        string(value, Some(1), Some(super::REQUEST_ID_MAX_CHARS), issues)
    }

    /// `z.number().int()`, within the safe integer range.
    pub(super) fn int(value: Option<&Value>, issues: &mut Issues) -> Option<f64> {
        let Some(number) = value.and_then(Value::as_f64) else {
            invalid_type("number", value, issues);
            return None;
        };
        if number.fract() != 0.0 {
            issues.push("Invalid input: expected int, received number", true);
            return None;
        }
        const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
        if number > MAX_SAFE {
            issues.push("Too big: expected int to be <=9007199254740991", false);
        } else if number < -MAX_SAFE {
            issues.push("Too small: expected int to be >=-9007199254740991", false);
        }
        Some(number)
    }

    /// `.nonnegative()`.
    pub(super) fn nonnegative(number: f64, issues: &mut Issues) {
        if number < 0.0 {
            issues.push("Too small: expected number to be >=0", false);
        }
    }

    /// A `send` request's message, with the check that it holds text or a file run
    /// after its fields, unless one of them aborted it.
    pub(super) fn send_message(value: Option<&Value>, issues: &mut Issues) -> Option<SendMessage> {
        let start = issues.len();
        let message = object(value, issues)?;
        let id = matching(message.get("id"), &UUID_V4, UUID_V4_MESSAGE, None, issues);
        let thread_id = matching(message.get("threadId"), &UUID, UUID_MESSAGE, None, issues);
        let content = string(
            message.get("content"),
            None,
            Some(MAX_MESSAGE_CHARS),
            issues,
        );
        let attachment_ids = match message.get("attachmentIds") {
            None => Some(Vec::new()),
            Some(Value::Array(items)) => {
                let ids: Vec<Option<String>> = items
                    .iter()
                    .map(|item| matching(Some(item), &UUID, UUID_MESSAGE, None, issues))
                    .collect();
                if items.len() > MAX_ATTACHMENTS_PER_MESSAGE {
                    issues.push(
                        format!(
                            "Too big: expected array to have <={MAX_ATTACHMENTS_PER_MESSAGE} items"
                        ),
                        false,
                    );
                }
                ids.into_iter().collect::<Option<Vec<String>>>()
            }
            other => {
                invalid_type("array", other, issues);
                None
            }
        };
        if !issues.aborted_since(start) {
            let has_text = content
                .as_deref()
                .is_some_and(|content| !js::trim(content).is_empty());
            let has_file = attachment_ids.as_ref().is_some_and(|ids| !ids.is_empty());
            if !has_text && !has_file {
                issues.push("a message needs text or an attachment", false);
            }
        }
        Some(SendMessage {
            id: id?,
            thread_id: thread_id?,
            content: content?,
            attachment_ids: attachment_ids?,
        })
    }
}

// ============================================================================
// Server → client
// ============================================================================

/// The state of one conversation's work, as every client sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Queued,
    Running,
    Idle,
}

impl TurnState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Idle => "idle",
        }
    }
}

/// How a turn that went idle ended. Absent on a thread that was only ever queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Failed,
}

impl TurnOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEventPayload {
    pub thread_id: String,
    pub state: TurnState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TurnOutcome>,
    /// What went wrong, when `outcome` is `failed`. Written for a person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The `error` of a failed turn. The details go to the log.
pub const TURN_FAILED: &str = "The agent could not answer. Try again.";

/// The `error` of a turn that failed on the spending limit, which a retry does not lift.
pub const SPENDING_LIMIT_REACHED: &str = "The AI spending limit is reached.";

/// The `error` of a turn whose reply is an error report.
pub fn turn_error(error: &InvokeError) -> &'static str {
    match error.kind {
        InvokeErrorType::BudgetExceeded => SPENDING_LIMIT_REACHED,
        InvokeErrorType::Generic => TURN_FAILED,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPayload {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: i64,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
}

/// What a message from another agent is: a `message`, an `ask` that waits for an
/// answer, or a `notice` the delivery service itself sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageKind {
    Message,
    Ask,
    Notice,
}

impl AgentMessageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Ask => "ask",
            Self::Notice => "notice",
        }
    }
}

/// One message, for any role. A client upserts it by `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEventPayload {
    pub id: String,
    pub thread_id: String,
    pub role: MessageRole,
    pub content: String,
    pub triggered_by: String,
    pub tool_calls: Option<Vec<Value>>,
    pub blocks: Option<Vec<Value>>,
    pub is_compacted: bool,
    /// ISO 8601 with milliseconds. Clients order a thread by `(createdAt, id)`.
    pub created_at: String,
    pub attachments: Option<Vec<AttachmentPayload>>,
    /// Who wrote a USER message, when the Lens Agents sign-in named the connection.
    /// `sender_id` tells one person from another; compare it with `welcome.you.id`.
    /// `sender_name` is for display. Neither is ever used to decide what is allowed.
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    /// What a message from another agent is (`triggeredBy: AGENT_MESSAGE`). Null
    /// on every other message.
    #[serde(default)]
    pub agent_message_kind: Option<AgentMessageKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEventPayload {
    pub thread_id: String,
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

/// Everything the stream carries. Each has a `seq`, so a client that misses some
/// can say where it stopped and have them again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "lowercase")]
pub enum StreamEvent {
    Message(MessageEventPayload),
    Turn(TurnEventPayload),
    Thread(ThreadEventPayload),
    Context(Map<String, Value>),
    Compaction(Map<String, Value>),
    Computer(Map<String, Value>),
    Update(Map<String, Value>),
}

impl StreamEvent {
    /// The event's `type`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Message(_) => "message",
            Self::Turn(_) => "turn",
            Self::Thread(_) => "thread",
            Self::Context(_) => "context",
            Self::Compaction(_) => "compaction",
            Self::Computer(_) => "computer",
            Self::Update(_) => "update",
        }
    }
}

/// A stream event with its position: `{ type, payload, seq }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SequencedEvent {
    #[serde(flatten)]
    pub event: StreamEvent,
    pub seq: i64,
}

/// Who a connection is, or nulls when the sign-in did not say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WelcomeYou {
    pub id: Option<String>,
    pub name: Option<String>,
}

/// A conversation with work queued or running, in the `welcome` snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTurn {
    pub thread_id: String,
    /// `queued` or `running`, never `idle`.
    pub state: TurnState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WelcomeSnapshot {
    pub turns: Vec<SnapshotTurn>,
    pub computer: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WelcomePayload {
    pub protocol: i64,
    /// Names this process's stream. A different one on reconnect means the replay is gone.
    pub stream_id: String,
    /// The `seq` of the last event before this socket went live.
    pub seq: i64,
    /// True when every event after the client's cursor follows this frame.
    pub resumed: bool,
    /// Who this connection is, or nulls when the sign-in did not say.
    pub you: WelcomeYou,
    /// `single`: the agent has one conversation, which `POST /threads` returns and
    /// `GET /threads` lists alone, so a client shows no way to start or switch one.
    pub thread_mode: ThreadMode,
    pub snapshot: WelcomeSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAckPayload {
    pub message_id: String,
    /// A stream position at or after the stored message's `message` event.
    pub seq: i64,
    /// True when the message waits behind a turn in another conversation.
    pub queued: bool,
    /// True when this id was already stored and nothing new happened.
    pub duplicate: bool,
}

/// An `ack` payload: a send's, or `{}` for any other request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AckPayload {
    Send(SendAckPayload),
    Empty {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NackCode {
    ProtocolUnsupported,
    Invalid,
    UnknownThread,
    IdConflict,
    RateLimited,
    Unavailable,
    Failed,
}

impl NackCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ProtocolUnsupported => "protocol_unsupported",
            Self::Invalid => "invalid",
            Self::UnknownThread => "unknown_thread",
            Self::IdConflict => "id_conflict",
            Self::RateLimited => "rate_limited",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NackPayload {
    pub code: NackCode,
    pub message: String,
    /// Present on `rate_limited`: when the same request may be tried again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
}

/// A frame for one socket rather than the stream. It carries no `seq`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DirectFrame {
    Welcome {
        payload: WelcomePayload,
    },
    Ack {
        re: String,
        payload: AckPayload,
    },
    Nack {
        re: Option<String>,
        payload: NackPayload,
    },
    Pong {
        re: String,
    },
    VoiceHello {
        payload: Value,
    },
    VoiceState {
        payload: Value,
    },
    VoiceError {
        payload: Value,
    },
    VoiceClear,
    DictationHello {
        payload: Value,
    },
    DictationDelta {
        payload: Value,
    },
    DictationResult {
        payload: Value,
    },
    DictationError {
        payload: Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SESSION: &str = include_str!("../../../src/protocol/fixtures/v2-session.json");

    fn log() -> Vec<Value> {
        let session: Value = serde_json::from_str(SESSION).unwrap();
        session["log"].as_array().unwrap().clone()
    }

    #[test]
    fn reads_every_recorded_frame_into_its_type() {
        for entry in log() {
            let Some(frame) = entry.get("frame") else {
                continue;
            };
            match (
                entry["direction"].as_str().unwrap(),
                frame["type"].as_str().unwrap(),
            ) {
                ("sent", "chat") => {}
                ("sent", "hello") => {
                    let hello: HelloFrame = serde_json::from_value(frame.clone()).unwrap();
                    assert_eq!(serde_json::to_value(&hello).unwrap(), *frame);
                }
                ("sent", _) => {
                    let parsed: ClientFrame = serde_json::from_value(frame.clone()).unwrap();
                    assert_eq!(parsed.type_name(), frame["type"]);
                }
                ("received", _) if frame.get("seq").is_some() => {
                    let event: SequencedEvent = serde_json::from_value(frame.clone()).unwrap();
                    let written = serde_json::to_value(&event).unwrap();
                    if event.event.type_name() == "message" {
                        // Recorded before `agentMessageKind`, which every message now has.
                        let mut expected = frame.clone();
                        expected["payload"]
                            .as_object_mut()
                            .unwrap()
                            .insert("agentMessageKind".into(), Value::Null);
                        assert_eq!(written, expected);
                    } else {
                        assert_eq!(written, *frame);
                    }
                    let keys: Vec<&String> = written.as_object().unwrap().keys().collect();
                    assert_eq!(keys, ["type", "payload", "seq"]);
                }
                ("received", _) => {
                    let direct: DirectFrame = serde_json::from_value(frame.clone()).unwrap();
                    assert_eq!(
                        serde_json::to_string(&direct).unwrap(),
                        serde_json::to_string(frame).unwrap()
                    );
                }
                (direction, kind) => panic!("unexpected {direction} {kind}"),
            }
        }
    }

    #[test]
    fn closes_a_client_from_before_protocol_2_with_the_update_code() {
        let closed = log()
            .into_iter()
            .find(|e| e["client"] == "old-client" && e["direction"] == "closed")
            .unwrap();
        assert_eq!(closed["code"], i64::from(CLOSE_CODES.protocol_unsupported));
    }

    #[test]
    fn writes_the_small_frames_as_clients_read_them() {
        let empty_ack = DirectFrame::Ack {
            re: "c-1".into(),
            payload: AckPayload::Empty {},
        };
        assert_eq!(
            serde_json::to_string(&empty_ack).unwrap(),
            r#"{"type":"ack","re":"c-1","payload":{}}"#
        );
        assert_eq!(
            serde_json::to_string(&DirectFrame::VoiceClear).unwrap(),
            r#"{"type":"voice_clear"}"#
        );
        let nack = DirectFrame::Nack {
            re: None,
            payload: NackPayload {
                code: NackCode::RateLimited,
                message: "Too many requests.".into(),
                retry_after_ms: Some(5),
            },
        };
        assert_eq!(
            serde_json::to_string(&nack).unwrap(),
            r#"{"type":"nack","re":null,"payload":{"code":"rate_limited","message":"Too many requests.","retryAfterMs":5}}"#
        );
    }

    #[test]
    fn names_the_error_a_failed_turn_shows() {
        let budget = InvokeError {
            kind: InvokeErrorType::BudgetExceeded,
            detail: None,
        };
        let generic = InvokeError {
            kind: InvokeErrorType::Generic,
            detail: Some("x".into()),
        };
        assert_eq!(turn_error(&budget), SPENDING_LIMIT_REACHED);
        assert_eq!(turn_error(&generic), TURN_FAILED);
    }

    #[test]
    fn checks_uuids() {
        assert!(is_uuid_v4("a636fe73-e7b4-4981-ae24-e45381e8ed59"));
        assert!(!is_uuid_v4("a636fe73-e7b4-1981-ae24-e45381e8ed59"));
        assert!(is_uuid("a636fe73-e7b4-1981-ae24-e45381e8ed59"));
        assert!(!is_uuid("not-a-uuid"));
    }

    #[test]
    fn accepts_every_recorded_request_apart_from_the_ones_sent_to_be_refused() {
        for entry in log() {
            if entry["direction"] != "sent" {
                continue;
            }
            let frame = &entry["frame"];
            if frame["type"] == "chat" {
                continue; // the client from before protocol 2
            }
            let accepted = if frame["type"] == "hello" {
                parse_hello_frame(frame).is_ok()
            } else {
                parse_client_frame(frame).is_ok()
            };
            assert_eq!(accepted, frame["id"] != "send-bad", "{frame}");
        }
    }

    #[test]
    fn reads_a_recorded_request_into_its_type() {
        for entry in log() {
            let frame = &entry["frame"];
            if entry["direction"] != "sent" || frame["type"] == "chat" || frame["id"] == "send-bad"
            {
                continue;
            }
            if frame["type"] == "hello" {
                assert_eq!(
                    parse_hello_frame(frame).unwrap(),
                    serde_json::from_value::<HelloFrame>(frame.clone()).unwrap()
                );
            } else {
                assert_eq!(
                    parse_client_frame(frame).unwrap(),
                    serde_json::from_value::<ClientFrame>(frame.clone()).unwrap()
                );
            }
        }
    }

    fn send(message: Value) -> Value {
        json!({ "type": "send", "id": "s-1", "payload": { "message": message } })
    }

    const MESSAGE_ID: &str = "a636fe73-e7b4-4981-ae24-e45381e8ed59";
    const THREAD_ID: &str = "d046783b-f46e-43b5-b4bb-247e6b1915bf";

    #[test]
    fn words_a_refused_request_as_zod_does() {
        let cases = [
            (
                json!("hi"),
                "Invalid input: expected object, received string",
            ),
            (json!([]), "Invalid input: expected object, received array"),
            (
                json!({ "type": "chat" }),
                "Invalid discriminator value. Expected 'send' | 'cancel' | 'ping' | 'voice_start' | 'voice_stop' | 'dictation_start' | 'dictation_stop'",
            ),
            (
                json!({ "type": "ping" }),
                "Invalid input: expected string, received undefined",
            ),
            (
                json!({ "type": "ping", "id": "" }),
                "Too small: expected string to have >=1 characters",
            ),
            (
                json!({ "type": "ping", "id": "x".repeat(65) }),
                "Too big: expected string to have <=64 characters",
            ),
            (
                send(
                    json!({ "id": "not-a-uuid", "threadId": THREAD_ID, "content": "x", "attachmentIds": [] }),
                ),
                "must be a uuid v4",
            ),
            (
                send(json!({ "id": MESSAGE_ID, "threadId": "t", "content": "x" })),
                "must be a uuid",
            ),
            (
                send(json!({ "id": MESSAGE_ID, "threadId": THREAD_ID, "content": "   " })),
                "a message needs text or an attachment",
            ),
            (
                send(json!({ "id": MESSAGE_ID, "threadId": THREAD_ID, "content": 3 })),
                "Invalid input: expected string, received number",
            ),
            (
                json!({ "type": "cancel", "id": "c", "payload": { "threadId": 1 } }),
                "Invalid input: expected string, received number",
            ),
            (
                json!({ "type": "voice_start", "id": "v", "payload": [] }),
                "Invalid input: expected record, received array",
            ),
            (
                json!({ "type": "dictation_stop", "id": "d", "payload": { "commit": "yes" } }),
                "Invalid input: expected boolean, received string",
            ),
        ];
        for (frame, message) in cases {
            assert_eq!(parse_client_frame(&frame).unwrap_err(), message, "{frame}");
        }
    }

    #[test]
    fn fills_the_defaults_and_drops_unknown_keys() {
        let parsed = parse_client_frame(&json!({
            "type": "send",
            "id": "s",
            "extra": true,
            "payload": { "message": { "id": MESSAGE_ID, "threadId": THREAD_ID, "content": "hi" } },
        }))
        .unwrap();
        let ClientFrame::Send(frame) = parsed else {
            panic!("a send");
        };
        assert!(frame.payload.message.attachment_ids.is_empty());
        let stop = parse_client_frame(&json!({ "type": "dictation_stop", "id": "d" })).unwrap();
        assert_eq!(
            stop,
            ClientFrame::DictationStop(DictationStopFrame {
                id: "d".into(),
                payload: DictationStopPayload { commit: None },
            })
        );
        let voice = parse_client_frame(&json!({ "type": "voice_stop", "id": "v" })).unwrap();
        assert_eq!(
            voice,
            ClientFrame::VoiceStop(LooseFrame {
                id: "v".into(),
                payload: Map::new(),
            })
        );
    }

    #[test]
    fn refuses_a_hello_of_another_shape() {
        let hello = |payload: Value| json!({ "type": "hello", "id": "h", "payload": payload });
        assert!(
            parse_hello_frame(&hello(
                json!({ "protocol": 2, "client": { "name": "web" } })
            ))
            .is_ok()
        );
        assert_eq!(
            parse_hello_frame(&hello(
                json!({ "protocol": 2.5, "client": { "name": "web" } })
            ))
            .unwrap_err(),
            "Invalid input: expected int, received number"
        );
        assert_eq!(
            parse_hello_frame(&hello(json!({
                "protocol": 2,
                "client": { "name": "web" },
                "resume": { "streamId": "s", "seq": -1 },
            })))
            .unwrap_err(),
            "Too small: expected number to be >=0"
        );
        assert_eq!(
            parse_hello_frame(&json!({ "type": "chat", "id": "h", "payload": {} })).unwrap_err(),
            "Invalid input: expected \"hello\""
        );
    }
}
