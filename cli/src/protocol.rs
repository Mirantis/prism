//! The terminal UI's copy of the chat socket contract, `/api/ws`, version 2.
//!
//! The runtime's `backend/src/protocol/chat_protocol.rs` is the authority, and
//! `docs/websocket-protocol.md` describes it. The recorded session in
//! `backend/src/protocol/fixtures/` holds both copies to the same frames.
//! Payloads are read leniently: a field of the wrong type is dropped, never fatal.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Metadata of a stored file (never its bytes).
#[derive(Clone, Debug, PartialEq)]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub media_type: String,
    pub size_bytes: f64,
    pub category: String,
    /// The server's retention sweep deleted the content; only the metadata is left.
    pub expired: bool,
    /// An image the message's text places with an `attachment:` reference.
    pub inline: bool,
}

impl AttachmentMeta {
    pub fn parse(v: &Value) -> Option<AttachmentMeta> {
        let obj = v.as_object()?;
        Some(AttachmentMeta {
            id: obj.get("id")?.as_str()?.to_string(),
            filename: obj.get("filename")?.as_str()?.to_string(),
            size_bytes: obj.get("sizeBytes")?.as_f64()?,
            media_type: obj
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            category: obj
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            expired: obj.get("expired").and_then(Value::as_bool) == Some(true),
            inline: obj.get("inline").and_then(Value::as_bool) == Some(true),
        })
    }
}

pub const PROTOCOL_VERSION: u64 = 2;

pub const CLOSE_PROTOCOL_UNSUPPORTED: u16 = 4426;

pub const CLIENT_PING_INTERVAL_MS: u64 = 25_000;
pub const CLIENT_PONG_DEADLINE_MS: u64 = 10_000;

/// The longest message the runtime stores. A longer one is refused before it is sent.
pub const MAX_MESSAGE_CHARS: usize = 200_000;

/// What the terminal UI shows for a failed turn whose event has no `error`.
pub const TURN_FAILED_TEXT: &str = "The response failed.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnState {
    Queued,
    Running,
    Idle,
}

impl TurnState {
    fn parse(s: &str) -> Option<TurnState> {
        match s {
            "queued" => Some(TurnState::Queued),
            "running" => Some(TurnState::Running),
            "idle" => Some(TurnState::Idle),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnEvent {
    pub thread_id: String,
    pub state: TurnState,
    pub outcome: Option<TurnOutcome>,
    pub error: Option<String>,
}

impl TurnEvent {
    pub fn parse(v: &Value) -> Option<TurnEvent> {
        let thread_id = v.get("threadId")?.as_str()?.to_string();
        let state = TurnState::parse(v.get("state")?.as_str()?)?;
        let outcome = match v.get("outcome").and_then(Value::as_str) {
            Some("completed") => Some(TurnOutcome::Completed),
            Some("cancelled") => Some(TurnOutcome::Cancelled),
            Some("failed") => Some(TurnOutcome::Failed),
            _ => None,
        };
        let error = v.get("error").and_then(Value::as_str).map(str::to_string);
        Some(TurnEvent {
            thread_id,
            state,
            outcome,
            error,
        })
    }
}

/// Who a connection is, as the platform sign-in named it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Viewer {
    pub id: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadMode {
    Single,
    Multi,
}

#[derive(Clone, Debug)]
pub struct Welcome {
    pub stream_id: String,
    pub seq: u64,
    pub resumed: bool,
    pub you: Viewer,
    /// The conversations working at the welcome, with their state.
    pub turns: Vec<(String, TurnState)>,
}

impl Welcome {
    pub fn parse(v: &Value) -> Option<Welcome> {
        let you = v.get("you");
        let field = |name: &str| {
            you.and_then(|y| y.get(name))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let turns = v
            .get("snapshot")
            .and_then(|s| s.get("turns"))
            .and_then(Value::as_array)
            .map(|turns| {
                turns
                    .iter()
                    .filter_map(|t| {
                        let id = t.get("threadId")?.as_str()?.to_string();
                        let state = TurnState::parse(t.get("state")?.as_str()?)?;
                        Some((id, state))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Welcome {
            stream_id: v.get("streamId")?.as_str()?.to_string(),
            seq: v.get("seq")?.as_u64()?,
            resumed: v.get("resumed").and_then(Value::as_bool).unwrap_or(false),
            you: Viewer {
                id: field("id"),
                name: field("name"),
            },
            turns,
        })
    }
}

/// One numbered event of the stream.
#[derive(Clone, Debug)]
pub struct StreamEvent {
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct SendAck {
    pub message_id: String,
    pub duplicate: bool,
}

/// A message this client sends. `id` is a uuid v4 the client keeps until it is confirmed.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub id: String,
    pub thread_id: String,
    pub content: String,
    pub attachment_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Agent,
    System,
}

/// One message of a conversation, as the terminal UI keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct TuiMessage {
    pub id: String,
    pub thread_id: String,
    pub role: Role,
    pub content: String,
    pub triggered_by: String,
    pub tool_calls: Value,
    pub blocks: Value,
    pub created_at: String,
    pub attachments: Option<Vec<AttachmentMeta>>,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub agent_message_kind: Option<String>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn coerce_attachments(raw: Option<&Value>) -> Option<Vec<AttachmentMeta>> {
    let list = raw?.as_array()?;
    let valid: Vec<AttachmentMeta> = list.iter().filter_map(AttachmentMeta::parse).collect();
    if valid.is_empty() { None } else { Some(valid) }
}

pub fn coerce_message(raw: &Value) -> Option<TuiMessage> {
    let obj = raw.as_object()?;
    let id = obj.get("id")?.as_str()?.to_string();
    let content = obj.get("content")?.as_str()?.to_string();
    let role = match obj.get("role").and_then(Value::as_str) {
        Some("USER") => Role::User,
        Some("SYSTEM") => Role::System,
        _ => Role::Agent,
    };
    let string = |name: &str| obj.get(name).and_then(Value::as_str).map(str::to_string);
    let null_if_absent = |name: &str| match obj.get(name) {
        None | Some(Value::Null) => Value::Null,
        Some(v) => v.clone(),
    };
    Some(TuiMessage {
        id,
        thread_id: string("threadId").unwrap_or_default(),
        role,
        content,
        triggered_by: string("triggeredBy").unwrap_or_else(|| "USER_INPUT".into()),
        tool_calls: null_if_absent("toolCalls"),
        blocks: null_if_absent("blocks"),
        created_at: string("createdAt").unwrap_or_else(now_iso),
        attachments: coerce_attachments(obj.get("attachments")),
        sender_id: string("senderId"),
        sender_name: string("senderName"),
        agent_message_kind: string("agentMessageKind")
            .filter(|k| matches!(k.as_str(), "message" | "ask" | "notice")),
    })
}

/// How much of the model's context window a thread is using.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextUsage {
    pub thread_id: String,
    pub model_id: String,
    pub used_tokens: f64,
    pub window_tokens: f64,
    pub used_percent: f64,
}

pub fn coerce_context_usage(raw: &Value) -> Option<ContextUsage> {
    Some(ContextUsage {
        thread_id: raw.get("threadId")?.as_str()?.to_string(),
        model_id: raw.get("modelId")?.as_str()?.to_string(),
        used_tokens: raw.get("usedTokens")?.as_f64()?,
        window_tokens: raw.get("windowTokens")?.as_f64()?,
        used_percent: raw.get("usedPercent")?.as_f64()?,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompactionEvent {
    pub thread_id: String,
    pub status: String,
    pub trigger: String,
    pub messages_compacted: Option<f64>,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub idle: bool,
}

pub fn coerce_compaction(raw: &Value) -> Option<CompactionEvent> {
    let status = raw.get("status")?.as_str()?;
    let trigger = raw.get("trigger")?.as_str()?;
    if !matches!(status, "started" | "completed" | "failed" | "skipped")
        || !matches!(trigger, "auto" | "manual")
    {
        return None;
    }
    Some(CompactionEvent {
        thread_id: raw.get("threadId")?.as_str()?.to_string(),
        status: status.into(),
        trigger: trigger.into(),
        messages_compacted: raw.get("messagesCompacted").and_then(Value::as_f64),
        error: raw.get("error").and_then(Value::as_str).map(str::to_string),
        detail: raw
            .get("detail")
            .and_then(Value::as_str)
            .map(str::to_string),
        idle: raw.get("idle").and_then(Value::as_bool) == Some(true),
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdateEvent {
    pub status: String,
    pub version: String,
    pub error_code: Option<String>,
}

pub fn coerce_update(raw: &Value) -> Option<UpdateEvent> {
    let status = raw.get("status")?.as_str()?;
    if !matches!(status, "available" | "updating" | "failed") {
        return None;
    }
    Some(UpdateEvent {
        status: status.into(),
        version: raw.get("version")?.as_str()?.to_string(),
        error_code: raw
            .get("errorCode")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// A resumable conversation, as `GET /threads` lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadSummary {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: String,
    pub workspace_root: Option<String>,
    pub branch: Option<String>,
    pub context_usage: Option<ContextUsage>,
}

pub fn coerce_thread_summary(raw: &Value) -> Option<ThreadSummary> {
    let obj = raw.as_object()?;
    let string = |name: &str| obj.get(name).and_then(Value::as_str).map(str::to_string);
    Some(ThreadSummary {
        id: obj.get("id")?.as_str()?.to_string(),
        title: string("title"),
        updated_at: string("updatedAt").unwrap_or_else(now_iso),
        workspace_root: string("workspaceRoot"),
        branch: string("branch"),
        context_usage: obj.get("contextUsage").and_then(coerce_context_usage),
    })
}

/// A sign-in the agent asked for, taken off a chat message's blocks.
#[derive(Clone, Debug, PartialEq)]
pub struct SignInRequest {
    pub id: String,
    pub reason: String,
    pub site: Option<String>,
    /// The page asks for the password alone.
    pub password_only: bool,
    pub thread_id: Option<String>,
}

/// The sign-in in a message's blocks, when it holds one that is still waiting.
pub fn sign_in_request_in(blocks: &Value) -> Option<SignInRequest> {
    for block in blocks.as_array()? {
        if block.get("type").and_then(Value::as_str) != Some("computer_help") {
            continue;
        }
        if block.get("credentials").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if block.get("status").and_then(Value::as_str) != Some("waiting") {
            continue;
        }
        let (Some(id), Some(reason)) = (
            block.get("id").and_then(Value::as_str),
            block.get("reason").and_then(Value::as_str),
        ) else {
            continue;
        };
        return Some(SignInRequest {
            id: id.into(),
            reason: reason.into(),
            site: block
                .get("site")
                .and_then(Value::as_str)
                .map(str::to_string),
            password_only: block.get("credentialFields").and_then(Value::as_str)
                == Some("password"),
            thread_id: None,
        });
    }
    None
}

/// The id of a sign-in in a message's blocks that is no longer waiting.
pub fn ended_sign_in_in(blocks: &Value) -> Option<String> {
    for block in blocks.as_array()? {
        if block.get("type").and_then(Value::as_str) != Some("computer_help") {
            continue;
        }
        if block.get("credentials").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if block.get("status").and_then(Value::as_str) != Some("waiting")
            && let Some(id) = block.get("id").and_then(Value::as_str)
        {
            return Some(id.into());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerces_a_message_leniently() {
        let m = coerce_message(
            &json!({"id":"m1","content":"hi","role":"NOPE","attachments":[{"id":1}]}),
        )
        .unwrap();
        assert_eq!(m.role, Role::Agent);
        assert_eq!(m.triggered_by, "USER_INPUT");
        assert!(m.attachments.is_none());
        assert!(coerce_message(&json!({"id":"m1"})).is_none());
    }

    #[test]
    fn a_partial_context_frame_is_dropped() {
        assert!(
            coerce_context_usage(&json!({"threadId":"t","modelId":"m","usedTokens":1})).is_none()
        );
    }

    #[test]
    fn reads_a_waiting_sign_in() {
        let blocks = json!([{"type":"computer_help","credentials":true,"status":"waiting","id":"h1","reason":"Log in","credentialFields":"password"}]);
        let r = sign_in_request_in(&blocks).unwrap();
        assert_eq!(r.id, "h1");
        assert!(r.password_only);
        assert_eq!(ended_sign_in_in(&blocks), None);
        let done =
            json!([{"type":"computer_help","credentials":true,"status":"answered","id":"h1"}]);
        assert_eq!(ended_sign_in_in(&done).as_deref(), Some("h1"));
    }
}
