//! Unified Agent Invocation
//!
//! The runtime is self-sufficient: it builds its own context from the
//! shared database, connects to MCP servers for tools, calls `generate_text`, and
//! returns the response.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::atomic::AtomicBool;

use futures::StreamExt;
use futures::stream::BoxStream;
use regex::Regex;
use serde_json::Value;

use crate::ai::ModelMessage;
use crate::lib::step_usage::fold_step_usage;
use crate::lib::task_tool::Subagent;
use crate::lib::tool_output_limiter::unwrap_tool_output;
use crate::lib::tool_search::plan::ToolSearchPrompt;
use crate::log_info;
use crate::prompts::context_builder::SystemPromptPart;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::tool_ledger_service::AnchoredToolChange;
use crate::support::js::len16;
use crate::tools::share_file::SHARE_FILE_TOOL_NAME;
use crate::types::{AgentContext, InvokeError, InvokeRequest, InvokeResponse, InvokeStep, UIBlock};

/// The system prompt parts and opening messages of a turn.
#[derive(Debug, Clone)]
pub struct TurnRequest {
    pub system_parts: Vec<SystemPromptPart>,
    pub messages: Vec<ModelMessage>,
    /// The tool-change announcements that go last on the turn's first step: the
    /// API takes one only after a user turn and before an assistant turn.
    pub tool_change_messages: Vec<ModelMessage>,
}

/// The system prompt parts and the opening messages of a turn: the context's
/// parts, with the channel and Task-tool blocks appended to the cached part, and
/// the thread, with the prompt appended where the thread does not hold it.
///
/// The parts come from `build_system_prompt_parts(context, mode, heartbeat
/// triggers, workspace root)`. To the cacheable part, each after `\n\n`: the
/// channel behavior (`get_channel_behavior_instructions`) when `channel_label` is
/// set and the mode is not `subagent`; the Task-tool block when there are
/// subagents and the mode is not `subagent` (logged as
/// `Adding task tool instructions for {n} subagent(s)`); and the tool search
/// catalog when there is one.
///
/// Messages are `build_conversation_history` with sender tags when
/// `channel_label` is set. Chat holds its prompt in history; any other mode, an
/// `append_prompt` follow-up, or an empty history appends `prompt` as a user
/// message. A chat turn that is not a follow-up first restates, as history
/// renders them, the user rows from `prompt_message_id` on when history ends on
/// an agent row stored after that row (`restated_after_reply`); when there are
/// such rows they replace the appended prompt. A chat follow-up then restates the
/// user rows stored after both the last agent row and the appended rows
/// (`restated_after_follow_up`). `after_restart` appends `RESUMED_RUN_NOTICE` as a
/// user message last.
pub async fn build_turn_request(
    context: &AgentContext,
    request: &InvokeRequest,
    subagents: &[Subagent],
    tool_changes: Option<&[AnchoredToolChange]>,
    tool_search: Option<&ToolSearchPrompt>,
) -> anyhow::Result<TurnRequest> {
    todo!()
}

/// The user rows from the prompt's row on, as history renders them, when the
/// history ends on an agent row stored after the prompt's row; otherwise none.
fn restated_after_reply(
    context: &AgentContext,
    prompt_message_id: Option<&str>,
    sender_tags: bool,
) -> Vec<ModelMessage> {
    todo!()
}

/// The user rows stored after both the last agent row and the rows of a
/// follow-up's appended prompt, as history renders them; none when history
/// has none of those rows, as a thread provider that gives rows its own ids reads it.
fn restated_after_follow_up(
    context: &AgentContext,
    appended_message_ids: &[String],
    sender_tags: bool,
) -> Vec<ModelMessage> {
    todo!()
}

/// Stream agent execution as a sequence of steps.
///
/// Owns preflight (provider settings + agent id), agent-context fetch, tool
/// collection, generation, and error formatting. Errors are yielded as friendly
/// steps (via `build_error_step`) rather than returned, so consumers just iterate;
/// only a failure outside that handling ends the stream with an error.
///
/// 1. Preflight: short-circuit with a placeholder step if misconfigured
/// 2. Fetch agent context from the local database
/// 3. Fetch the external MCP token and connect to MCP servers for tools
/// 4. Build the system prompt + message history
/// 5. Call `generate_text` and yield each step as its `on_step_finish` fires
/// 6. On step-limit, make a follow-up summary call and yield its result
///
/// A `subagent` run streams without reporting a turn, since its parent's turn
/// reports for both. Every other run reports how it ended to the agent's state
/// (`PROGRAM_STATUS_SERVICE.begin_turn()`, ended with `turn_error` of a step's
/// error, or `TURN_FAILED` when the stream fails), whichever exit it takes.
pub fn invoke_stream(request: InvokeRequest) -> BoxStream<'static, anyhow::Result<InvokeStep>> {
    todo!()
}

/// Aggregating wrapper: drains `invoke_stream` into a single response.
///
/// All preflight, context fetch, and friendly error formatting live in
/// `invoke_stream`; errors arrive as yielded steps (with optional structured
/// `error` metadata).
pub async fn invoke(request: InvokeRequest) -> anyhow::Result<InvokeResponse> {
    // Best-effort lookup so the log line below has the agent name.
    // `invoke_stream` does its own context fetch; this re-queries purely
    // for logging and tolerates failures (e.g. agent not found).
    let mut agent_name = "Agent".to_string();
    if !request.agent_id.is_empty()
        && let Ok(agent) = AGENT_WORKSPACE_SERVICE.get_agent().await
    {
        agent_name = agent.name;
    }

    let mut steps: Vec<InvokeStep> = Vec::new();
    let mut error_meta: Option<InvokeError> = None;

    let mut stream = invoke_stream(request);
    while let Some(step) = stream.next().await {
        let step = step?;
        if let Some(error) = &step.error {
            error_meta = Some(error.clone());
        }
        steps.push(step);
    }

    let all_tool_calls: Vec<_> = steps
        .iter()
        .flat_map(|s| s.tool_calls.iter().cloned())
        .collect();
    let response = join_step_texts(&steps);
    let all_blocks: Vec<UIBlock> = steps
        .iter()
        .flat_map(|s| s.blocks.iter().flatten().cloned())
        .collect();
    let all_attachment_ids: Vec<String> = steps
        .iter()
        .flat_map(|s| s.attachment_ids.iter().flatten().cloned())
        .collect();
    let usages: Vec<_> = steps.iter().filter_map(|s| s.usage.clone()).collect();
    let usage = fold_step_usage(&usages);
    let total_tokens = usage.as_ref().map(|u| u.total_tokens).unwrap_or(0);

    log_info!(
        "{} responded: {} chars, {} tool call(s), {} token(s)",
        agent_name,
        len16(&response),
        all_tool_calls.len(),
        total_tokens
    );

    let step_limit_reached = steps.iter().any(|s| s.step_limit);
    Ok(InvokeResponse {
        response,
        tool_calls: all_tool_calls,
        blocks: (!all_blocks.is_empty()).then_some(all_blocks),
        attachment_ids: (!all_attachment_ids.is_empty()).then_some(all_attachment_ids),
        usage,
        steps,
        error: error_meta,
        step_limit_reached,
    })
}

/// Which request of an invocation a check runs before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InvokeStage {
    Initial,
    Step,
    EarlyStopping,
}

impl InvokeStage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Step => "step",
            Self::EarlyStopping => "early-stopping",
        }
    }
}

/// What `warn_on_trailing_assistant` reports with. `guard` is shared by every
/// call in one invocation.
#[derive(Debug, Clone, Copy)]
pub struct TrailingAssistantContext<'a> {
    pub agent_id: &'a str,
    pub user_id: &'a str,
    pub mode: &'a str,
    pub stage: InvokeStage,
    pub guard: &'a AtomicBool,
}

/// Pre-flight tripwire: warn when a request is about to go out with an
/// assistant-terminated message array.
///
/// Bedrock/Anthropic reject those outright ("This model does not support
/// assistant message prefill. The conversation must end with a user message."),
/// and the user only ever sees the generic error bubble, with nothing in the
/// telemetry to say which turn shape produced it. This fires before the call so
/// the condition is attributable to a mode, stage, and agent.
///
/// Flags an assistant tail and nothing else. A trailing `tool` message is fine:
/// both the Bedrock and Anthropic converters fold a run of `tool`/`user` messages
/// into one provider-level user turn, so tool results terminate the array as a
/// user turn on the wire. A `system` tail or an empty array is not a prefill risk.
///
/// Detection only: deliberately does not repair the array. The point is to
/// confirm that turn steering keeps the trailing-user invariant on its own; a
/// silent fix-up here would hide a regression instead of reporting it.
///
/// Logs `LLM request ends on an assistant turn: {n} message(s) (mode={mode},
/// stage={stage}) — the provider will reject this as assistant prefill` at warn,
/// per call. Emits the `invocation trailing assistant` telemetry event (props
/// `agent.id`, `invoke.mode`, `invoke.stage`, `messages.count` as a string) at most
/// once per invocation, through `guard`.
pub fn warn_on_trailing_assistant(
    messages: &[ModelMessage],
    context: &TrailingAssistantContext<'_>,
) {
    todo!()
}

/// Join non-empty step texts into a single string.
fn join_step_texts(steps: &[InvokeStep]) -> String {
    steps
        .iter()
        .map(|s| s.text.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Summarize steps including tool calls and their results for context.
///
/// Per step: `[Tool: {name}] Input: {JSON input}` per call, `[Result] {text}` per
/// result (a spilled output's own text, else `render_tool_result` of the output),
/// then the step text when non-empty; joined with blank lines, `(no output)` when
/// empty. Every result goes through the limiter, because this text is
/// interpolated into a prompt (the early-stopping summary): stringifying an
/// oversized result would serialize the envelope and the untouched original
/// inside it, the whole payload the cut just removed.
fn summarize_steps(steps: &[crate::ai::StepResult]) -> String {
    todo!()
}

/// Collect attachment ids produced by `share_file` tool calls in a step.
///
/// Reads the structured `execute()` return value (preserved on the tool results
/// even though the model-facing view is truncated by the output limiter), so
/// there's no fragile string parsing. Matches results to calls by tool call id
/// and keeps only successful shares that returned an `attachmentId`.
///
/// `tool_calls` yields `(tool name, tool call id)`, `tool_results` yields
/// `(tool call id, output)`.
pub fn extract_attachment_ids<'a>(
    tool_calls: impl IntoIterator<Item = (&'a str, &'a str)>,
    tool_results: impl IntoIterator<Item = (&'a str, &'a Value)>,
) -> Vec<String> {
    // Index results once rather than scanning per share_file call.
    // `unwrap_tool_output` because an oversized result arrives wrapped: the tool's own
    // return travels inside it, which is the whole reason the wrapper keeps it.
    let output_by_id: HashMap<&str, &Value> = tool_results
        .into_iter()
        .map(|(id, output)| (id, unwrap_tool_output(output)))
        .collect();
    let mut ids = Vec::new();
    for (tool_name, tool_call_id) in tool_calls {
        if tool_name != SHARE_FILE_TOOL_NAME {
            continue;
        }
        let Some(Value::Object(out)) = output_by_id.get(tool_call_id).copied() else {
            continue;
        };
        if out.get("success") == Some(&Value::Bool(false)) {
            continue;
        }
        if let Some(Value::String(id)) = out.get("attachmentId") {
            ids.push(id.clone());
        }
    }
    ids
}

static JSON_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"```json\s*((?s:.)*?)\s*```").expect("valid regex"));

/// Extract UI blocks from a response: the `blocks` array of the first fenced
/// `json` block, when it has one.
fn extract_blocks(response: &str) -> Option<Vec<UIBlock>> {
    let captures = JSON_FENCE.captures(response)?;
    let parsed: Value = serde_json::from_str(&captures[1]).ok()?;
    let blocks = parsed.get("blocks")?;
    if !blocks.is_array() {
        return None;
    }
    serde_json::from_value(blocks.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collects_the_ids_of_successful_shares_only() {
        let ok = json!({ "success": true, "attachmentId": "a-1" });
        let failed = json!({ "success": false, "attachmentId": "a-2" });
        let other = json!({ "attachmentId": "a-3" });
        let ids = extract_attachment_ids(
            [
                ("share_file", "c1"),
                ("share_file", "c2"),
                ("shell_exec", "c3"),
            ],
            [("c1", &ok), ("c2", &failed), ("c3", &other)],
        );
        assert_eq!(ids, ["a-1"]);
    }

    #[test]
    fn reads_blocks_from_a_fenced_json_block() {
        let blocks =
            extract_blocks("text\n```json\n{\"blocks\":[{\"type\":\"card\"}]}\n```").unwrap();
        assert_eq!(blocks[0].r#type, "card");
        assert!(extract_blocks("no blocks").is_none());
    }
}
