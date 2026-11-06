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
    todo!()
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
    todo!()
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
}
