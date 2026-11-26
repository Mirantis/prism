//! Agent Runtime Types
//!
//! Request/response contracts for the agent runtime.

use std::fmt;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::lib::model_selection::ModelSelection;
use crate::lib::tool_lifecycle::ToolLifecycleListener;
use crate::prompts::context_builder::{ConversationMessage, SteeringMessage};
use crate::protocol::chat_protocol::AgentMessageKind;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::delivery_target_service::PostingCeiling;

// ============================================================================
// Agent Status
// ============================================================================

/// `ENABLED` or `STOPPED`, the stored heartbeat status.
pub use crate::db::models::AgentHeartbeatStatus;

// ============================================================================
// Context
// ============================================================================

#[derive(Debug, Clone)]
pub struct AgentContext {
    pub soul_md: String,
    pub user_md: String,
    pub memory_md: String,
    pub heartbeat_md: String,
    pub bootstrap_md: String,
    pub vision_md: String,
    pub agent_md: String,
    pub agent_name: String,
    pub agent_id: String,
    pub user_id: String,
    pub model: Option<String>,
    /// Heartbeat-specific model override; falls back to `model`, then env default.
    pub heartbeat_model: Option<String>,
    /// Cron/scheduled-task model override; falls back to `model`, then env default.
    pub cron_model: Option<String>,
    /// Fixed or Auto, with the Auto tiers; deployment defaults already applied.
    pub model_selection: ModelSelection,
    /// When false, only the final text step is delivered to the channel.
    pub verbose: bool,
    /// When true, the workspace markdown files are read-only: the tools that write
    /// them are withheld from the tool set and their writes refused. A snapshot for
    /// prompt-building and tool collection; `agentWorkspaceService.isLockedIn()`
    /// re-reads the flag at write time.
    pub locked_in: bool,
    pub is_bootstrap_phase: bool,
    pub conversation_summary: Option<String>,
    /// Whether the messages the summary replaced are stored rows that
    /// `read_compacted_history` reads. A thread read live from a channel keeps them
    /// in the channel instead.
    pub compacted_history_readable: bool,
    pub recent_messages: Vec<ConversationMessage>,
    /// Where a heartbeat, scheduled-task or webhook run may post (see InvokeRequest).
    pub posting_ceiling: Option<PostingCeiling>,
    /// What earlier runs of a recurring task, the heartbeat or a goal sent, for a run that reads no history.
    pub last_send: Option<TaskLastSend>,
    /// Per-turn runtime events surfaced authoritatively in the system prompt.
    pub runtime_notices: Option<Vec<String>>,
}

// ============================================================================
// Invoke Request (used by heartbeat, cron, subagent, chat)
// ============================================================================

/// A message a channel queued to start the heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelTriggerMessage {
    pub sender: String,
    pub text: String,
    pub timestamp: String,
}

/// The messages one channel queued since the last heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatTrigger {
    /// How the prompt names the channel's platform.
    pub platform: String,
    /// The channel the messages were posted in, as send_message names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<TriggerPlace>,
    pub messages: Vec<ChannelTriggerMessage>,
}

/// A channel that started the heartbeat: its send_message target and its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPlace {
    pub target: String,
    pub name: String,
}

/// What kind of run an invocation is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InvokeMode {
    #[default]
    Chat,
    Heartbeat,
    Cron,
    Subagent,
    Goal,
    Webhook,
}

impl InvokeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Heartbeat => "heartbeat",
            Self::Cron => "cron",
            Self::Subagent => "subagent",
            Self::Goal => "goal",
            Self::Webhook => "webhook",
        }
    }
}

impl fmt::Display for InvokeMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Mid-turn steering source, awaited at every step boundary.
pub type SteeringSource = Arc<dyn Fn() -> BoxFuture<'static, Vec<SteeringMessage>> + Send + Sync>;

/// Called once the turn has read the thread's history, with the rows it read.
pub type HistoryReadListener = Arc<dyn Fn(&[ConversationMessage]) + Send + Sync>;

#[derive(Clone, Default)]
pub struct InvokeRequest {
    pub user_id: String,
    pub agent_id: String,
    pub mode: InvokeMode,
    pub prompt: String,
    /// Who wrote `prompt`; `None` is the person. The tool risk gate reads a prompt
    /// from other agents or a task notification as authorizing nothing, instead of
    /// as the person's request.
    pub prompt_source: Option<PromptSource>,
    pub thread_id: Option<String>,
    /// Override the agent's persisted verbose flag for this invocation.
    pub verbose: Option<bool>,
    /// Optional per-thread workspace root for shell tools' cwd. When unset, shell
    /// tools fall back to the global SHELL_WORKSPACE_ROOT (see `resolve_workspace`).
    pub workspace_root: Option<String>,
    /// Originating channel of this turn, threaded through so the `create_goal`
    /// tool can record where to deliver a goal's autonomous turns. Defaults to
    /// `websocket` when unset.
    pub origin_channel: Option<ChannelName>,
    pub origin_channel_id: Option<String>,
    /// The shared channel this turn's message was posted in, as the system prompt
    /// names it, with what the agent sees and how it addresses people there. Set,
    /// the prompt gets the channel participation guidelines.
    pub channel_label: Option<String>,
    /// Where a heartbeat, scheduled-task or webhook run may post. Set, nothing the
    /// run writes is delivered unless the agent posts it with `send_message`.
    pub posting_ceiling: Option<PostingCeiling>,
    /// What earlier runs of a recurring task, the heartbeat or a goal sent, for a run that reads no history.
    pub last_send: Option<TaskLastSend>,
    /// Messages that channels queued for this heartbeat, one entry per channel.
    pub heartbeat_triggers: Option<Vec<HeartbeatTrigger>>,
    /// Transient, authoritative notices about events that occurred while
    /// preparing this turn (e.g. an attachment that failed to download). Injected
    /// into the system prompt: the model follows these far more reliably than
    /// text embedded in the user message.
    pub runtime_notices: Option<Vec<String>>,
    /// When provided, cancelling this token stops the in-flight LLM generation
    /// (the underlying provider request is cancelled). On cancel, `invoke_stream`
    /// closes the step stream without surfacing an error step; already-completed
    /// steps are preserved.
    pub abort_signal: Option<CancellationToken>,
    /// Mid-turn steering source, awaited at every step boundary. Each message it
    /// returns is appended to the message array as a user turn, text and any files
    /// alike, so a message the user sent while this turn was running reaches the
    /// model on its next step instead of waiting for a turn of its own (see
    /// `threadTurnService`). Async so the source can load attachment bytes.
    pub steering: Option<SteeringSource>,
    /// Called once the turn has read the thread's history, with the rows it read. A
    /// message handed to the turn that is among them, with all of its files, reaches
    /// the model through history, so it must not be injected again by `steering`.
    pub on_history_read: Option<HistoryReadListener>,
    /// Fired around each tool execution (started/completed).
    /// Purely observational; listener errors never affect the turn.
    pub on_tool_event: Option<ToolLifecycleListener>,
    /// Append `prompt` as the final user message even in chat mode, where the
    /// prompt normally arrives via history (the conversation engine stores it
    /// before invoking).
    ///
    /// Set by the coalesced follow-up turn, whose prompt restates messages that
    /// already sit earlier in history, before the previous turn's replies, so
    /// history alone would leave the array ending on an assistant turn, which
    /// Bedrock/Anthropic reject.
    pub append_prompt: bool,
    /// The stored rows of an appended prompt's messages. A user row stored after
    /// them and after the last agent row was handed to this turn and read as
    /// history, so it is restated after the prompt, which keeps a newer correction last.
    pub appended_message_ids: Option<Vec<String>>,
    /// The stored row of a chat prompt. When the history ends on an agent row
    /// stored after it, every user row from it on is restated after that row, as
    /// history renders it: a turn that was stopped may store its last reply after
    /// the next messages arrived, and history alone would then end on the assistant.
    pub prompt_message_id: Option<String>,
    /// The request an `invoke()` run's model calls are spent on. `None`: a new id per
    /// run. A subagent run spends on its parent's request.
    pub request_id: Option<String>,
    /// The scheduled task, webhook or goal an `invoke()` run serves, which its spending is listed under.
    pub source_id: Option<String>,
    /// The run starts work that a restart may have stopped part-way. The model is
    /// told in a message after the prompt, so the cached prefix before it holds.
    pub after_restart: bool,
}

impl fmt::Debug for InvokeRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InvokeRequest")
            .field("user_id", &self.user_id)
            .field("agent_id", &self.agent_id)
            .field("mode", &self.mode)
            .field("thread_id", &self.thread_id)
            .field("prompt_source", &self.prompt_source)
            .field("append_prompt", &self.append_prompt)
            .field("after_restart", &self.after_restart)
            .finish_non_exhaustive()
    }
}

// ============================================================================
// Response Types
// ============================================================================

/// What a cut did to a tool result. Structured on purpose: the
/// `[INCOMPLETE OUTPUT …]` notice inside `output` is written for the model, and a
/// consumer that needs to know a result was cut should not have to parse prose
/// that the notice's wording is free to change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputTruncation {
    /// Chars in the full rendering, before the cut.
    pub total_chars: i64,
    /// Head + tail chars kept, excluding the notice.
    pub kept_chars: i64,
    /// Chars dropped, accumulated across every pass (see `tool_output_limiter`).
    pub omitted_chars: i64,
    /// Id of the saved copy holding the whole output, when one was written. Absent
    /// when saving was off or failed: a cut still happened, there is just nothing to
    /// read back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spill_id: Option<String>,
}

/// An exchange that continues one a restart interrupted. `message_ids` names every
/// stored message it owes an answer; `unsaved` is what the interrupted turn did
/// that history does not hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumedReply {
    pub message_ids: Vec<String>,
    pub unsaved: Vec<ToolCallRecord>,
    pub unsent_attachment_ids: Vec<String>,
}

/// One result a run reported, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReport {
    pub text: String,
    pub at: i64,
}

/// What earlier runs of a recurring task or the heartbeat sent, and the newest
/// result since, for a run that reads no history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLastSend {
    /// One line per message: where it went, then its text.
    pub messages: String,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_report: Option<TaskReport>,
    /// The heartbeat's results of the runs since the oldest send in `messages`, newest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reports: Option<Vec<TaskReport>>,
}

/// The runtime's report that background work the agent started in a conversation
/// has ended. It is never the person's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotificationOrigin {
    /// The background task's id, which is also the id of the stored notification.
    pub task_id: String,
}

/// Who wrote a turn's prompt: the person, other agents of the project, or the
/// runtime in a task notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptSource {
    #[default]
    Person,
    Agent,
    Task,
}

/// Where a message from another agent of the project came from. It is a
/// colleague's request, never the person's words. `ask` is a message whose sender
/// waits for an answer, and `notice` is what the delivery service itself says
/// about the agent's messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageOrigin {
    pub kind: AgentMessageKind,
    pub sender_id: String,
    pub sender_name: String,
    /// The message's id, which a reply names.
    pub message_id: String,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub tool: String,
    pub input: String,
    /// The model-facing text for this result: the cut view when it was cut, not the
    /// raw `execute()` return. `build_conversation_history` replays it verbatim.
    pub output: String,
    pub success: bool,
    pub timestamp: String,
    /// Marks `output` as the rendered model-facing view (stored as `rendered: true`).
    /// Stamped on every new record, cut or not, because it is the replay
    /// discriminator: a row without it predates this contract and holds
    /// `JSON.stringify(raw)`, which replay has to parse and render instead.
    ///
    /// "Has truncation metadata" cannot serve as the discriminator. An untruncated new
    /// row would fall through to the legacy path, and a rendered text that happens to
    /// be valid JSON (an MCP tool whose text block is JSON) would be parsed and
    /// re-stringified into different bytes.
    #[serde(default, skip_serializing_if = "is_false")]
    pub rendered: bool,
    /// Present only when the model-facing view was cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<ToolOutputTruncation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvokeErrorType {
    BudgetExceeded,
    Generic,
}

impl InvokeErrorType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::BudgetExceeded => "budget_exceeded",
            Self::Generic => "generic",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvokeError {
    #[serde(rename = "type")]
    pub kind: InvokeErrorType,
    #[serde(default)]
    pub detail: Option<String>,
}

/// Provider-reported token usage for one model call, or for several summed
/// together. `input_tokens` is the full prompt and already includes cache reads
/// and writes, so a cache hit rate divides `cache_read_tokens` by the sum of the
/// three details; a zero sum means the provider reported no breakdown. Summed
/// across steps this is spend, counting the prompt once per step as the provider
/// bills it; `services/context_usage_service` measures context size instead.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepUsage {
    pub model: String,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub no_cache_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeStep {
    pub text: String,
    pub tool_calls: Vec<ToolCallRecord>,
    /// What the provider reported for this step, absent when it reports nothing.
    /// `invoke` records each step against `llm_calls`; nothing writes usage onto
    /// a message row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StepUsage>,
    /// Ids of MessageAttachment rows the agent shared during this step (via the
    /// share_file tool). The delivery layer links these to the published message
    /// and each channel adapter renders/uploads them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<String>>,
    /// Set when this step represents a friendly error message produced by
    /// `invoke_stream`'s error path (so `invoke` can surface structured metadata
    /// in `InvokeResponse.error` without needing its own error handling).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<InvokeError>,
    /// Set on the summary step `invoke_stream` asks for once the run reaches `STEP_LIMIT`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub step_limit: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokeResponse {
    pub response: String,
    pub tool_calls: Vec<ToolCallRecord>,
    /// Aggregated across all steps: files the agent shared this invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_ids: Option<Vec<String>>,
    /// Every step's usage summed, absent when no step reported any. The goal loop
    /// meters its budget against `total_tokens`. Nothing persists this: each step
    /// was already recorded against `llm_calls` as it finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<StepUsage>,
    pub steps: Vec<InvokeStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<InvokeError>,
    /// The run reached `STEP_LIMIT` and ended on a forced summary, with no tool run after it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub step_limit_reached: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_tool_call_record_as_stored_rows_hold_it() {
        let record = ToolCallRecord {
            tool: "shell_exec".into(),
            input: "{}".into(),
            output: "ok".into(),
            success: true,
            timestamp: "2026-01-01T00:00:00.000Z".into(),
            rendered: true,
            truncated: None,
        };
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"tool":"shell_exec","input":"{}","output":"ok","success":true,"timestamp":"2026-01-01T00:00:00.000Z","rendered":true}"#
        );
        let legacy: ToolCallRecord = serde_json::from_str(
            r#"{"tool":"t","input":"{}","output":"\"x\"","success":false,"timestamp":"t"}"#,
        )
        .unwrap();
        assert!(!legacy.rendered);
    }
}
