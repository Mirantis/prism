//! Unified Agent Invocation
//!
//! The runtime is self-sufficient: it builds its own context from the
//! shared database, connects to MCP servers for tools, calls `generate_text`, and
//! returns the response.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::{Context as TaskContext, Poll};

use futures::future::BoxFuture;
use futures::stream::BoxStream;
use futures::{Stream, StreamExt};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::ai::json::js_stringify;
use crate::ai::{
    ContentPart, FinishReason, GenerateTextOptions, GenerateTextResult, Instructions,
    LanguageModel, ModelMessage, PrepareStepOptions, PrepareStepResult, StepResult, StopCondition,
    SystemModelMessage, ToolChoice, ToolErrorValue, ToolSet, step_count_is,
};
use crate::config::CONFIG;
use crate::constants::{COMPACTION_FALLBACK_WINDOW_TOKENS, MAX_OUTPUT_TOKENS, STEP_LIMIT};
use crate::db::models::MessageRole;
use crate::lib::context_window::ContextUsageSnapshot;
use crate::lib::llm_errors::{
    build_error_step, build_refusal_step, is_context_overflow_error, is_rejected_request_error,
};
use crate::lib::llm_providers::create_provider::{create_provider, missing_provider_settings};
use crate::lib::llm_providers::deferred_tools::{LOAD_TOOLS_NAME, record_deferral_refusal};
use crate::lib::llm_providers::llm_provider::{
    CachePointFragment, DeferredToolProtocol, LlmProvider, ProviderOptionsFragment,
    ToolChangeProtocol, cache_request_options, cache_ttl_for, merge_provider_options,
};
use crate::lib::log_redaction::err_json;
use crate::lib::model_call::{ModelCallMeta, apply_telemetry, call_model};
use crate::lib::model_routing::{RoutedRequest, select_turn_model};
use crate::lib::pending_file_writes::{PendingFileWrites, create_pending_file_writes};
use crate::lib::spend_context::{
    SpendContext, SpendSource, SpendSourceKind, carried, current_spend_context, with_spend_context,
};
use crate::lib::step_usage::{fold_step_usage, to_step_usage};
use crate::lib::task_tool::{Invoker, Subagent};
use crate::lib::telemetry::{LangfuseTelemetry, langfuse_telemetry, track_event};
use crate::lib::tool_collection::{CollectToolsInput, collect_tools, with_tools_cache_control};
use crate::lib::tool_lifecycle::{with_tool_lifecycle_events, with_tool_lifecycle_events_on};
use crate::lib::tool_output_limiter::{
    RenderToolResultOptions, SpilledToolOutput, ToolOutputCaptureOptions, render_tool_result,
    render_tool_result_detailed, unwrap_tool_output, with_tool_output_capture,
};
use crate::lib::tool_risk_gate::{ToolRiskGateError, ToolRiskGateOptions, with_tool_risk_gate};
use crate::lib::tool_search::plan::{
    PlanToolSearchInput, ToolSearchPlan, ToolSearchPrompt, ToolSearchTelemetry, plan_tool_search,
};
use crate::prompts::channel_prompt::get_channel_behavior_instructions;
use crate::prompts::computer_prompt::computer_help_notices;
use crate::prompts::context_builder::{
    PromptMode, SystemPromptPart, build_conversation_history, build_recalled_memories,
    build_recent_memories, build_steering_message, build_system_prompt_parts, build_user_message,
    recalled_memory_content, recent_memory_content,
};
use crate::prompts::early_stopping_prompt::EARLY_STOPPING_PROMPT;
use crate::prompts::resume_prompt::RESUMED_RUN_NOTICE;
use crate::prompts::task_tool_prompt::get_task_tool_instructions;
use crate::protocol::chat_protocol::{TURN_FAILED, turn_error};
use crate::services::agent_status_service::AGENT_STATUS_SERVICE;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::compaction_service::{
    ArmIdleInput, AutoCompactFork, COMPACTION_SERVICE, CompactionFork, IdleInput, to_fork_rows,
};
use crate::services::computer::computer_access::{ComputerCaller, ComputerUse, IdleWrapper};
use crate::services::computer::computer_help_service::{COMPUTER_HELP_SERVICE, waits_for_answer};
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::computer::supported::has_computer_for_mode;
use crate::services::context_service::{AgentContextOptions, CONTEXT_SERVICE};
use crate::services::context_usage_service::{CONTEXT_USAGE_SERVICE, RecordInput};
use crate::services::conversation_service::{CONVERSATION_SERVICE, MessageInput};
use crate::services::conversation_thread_activity_service::{
    CONVERSATION_THREAD_ACTIVITY_SERVICE, ThreadActivity,
};
use crate::services::llm_call_service::LlmCallPurpose;
use crate::services::program_status_service::{PROGRAM_STATUS_SERVICE, TurnEnding, TurnHandle};
use crate::services::tool_ledger_service::{
    AnchoredToolChange, DeclareInput, TOOL_LEDGER_SERVICE, summary_tool_options,
};
use crate::support::js::{self, len16};
use crate::support::{now_iso, now_ms};
use crate::tools::share_file::SHARE_FILE_TOOL_NAME;
use crate::types::{
    AgentContext, InvokeError, InvokeErrorType, InvokeMode, InvokeRequest, InvokeResponse,
    InvokeStep, ToolCallRecord,
};
use crate::utils::async_channel::AsyncChannel;
use crate::{log_error, log_info, log_warn};

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
pub async fn build_turn_request(
    context: &AgentContext,
    request: &InvokeRequest,
    subagents: &[Subagent],
    tool_changes: Option<&[AnchoredToolChange]>,
    tool_search: Option<&ToolSearchPrompt>,
) -> anyhow::Result<TurnRequest> {
    // Stable vs dynamic parts, for granular caching.
    let mut system_parts = build_system_prompt_parts(
        context,
        PromptMode::from(request.mode),
        request.heartbeat_triggers.as_deref(),
        request.workspace_root.as_deref(),
    )
    .await?;

    // Append channel/task instructions to the stable (cacheable) part.
    let subagent_mode = request.mode == InvokeMode::Subagent;
    if let Some(stable_part) = system_parts.iter_mut().find(|p| p.cacheable) {
        if let Some(channel_label) = request.channel_label.as_deref().filter(|l| !l.is_empty())
            && !subagent_mode
        {
            stable_part.text.push_str("\n\n");
            stable_part
                .text
                .push_str(&get_channel_behavior_instructions(channel_label));
        }

        if !subagents.is_empty() && !subagent_mode {
            log_info!(
                "Adding task tool instructions for {} subagent(s)",
                subagents.len()
            );
            stable_part.text.push_str("\n\n");
            stable_part
                .text
                .push_str(&get_task_tool_instructions(subagents));
        }

        if let Some(catalog) = tool_search
            .and_then(|search| search.catalog.as_deref())
            .filter(|catalog| !catalog.is_empty())
        {
            stable_part.text.push_str("\n\n");
            stable_part.text.push_str(catalog);
        }
    }

    // Messages are already model messages with structured tool call/result pairs.
    // The channel prompt explains the sender tags, so a turn without it reads none.
    let sender_tags = request
        .channel_label
        .as_deref()
        .is_some_and(|label| !label.is_empty());
    let history = build_conversation_history(
        context,
        tool_changes.unwrap_or(&[]),
        tool_search,
        sender_tags,
    );
    let mut messages = history.messages;

    // Chat: the prompt is already in history (the conversation engine stores it
    // before invoke). Heartbeat/cron: the prompt is NOT in history, so it is always
    // appended. A coalesced steering follow-up sets `append_prompt` because its
    // prompt sits earlier in history than the previous turn's replies. A stopped
    // turn can store its last reply after this prompt's row and the ones handed over
    // with it, so those are restated in order, files included (see InvokeRequest).
    // A follow-up also restates the messages handed to it after the previous reply,
    // which it reads as history, so the newest instruction stays last.
    let chat = request.mode == InvokeMode::Chat;
    let restated = if chat && !request.append_prompt {
        restated_after_reply(context, request.prompt_message_id.as_deref(), sender_tags)
    } else {
        Vec::new()
    };
    if !restated.is_empty() {
        messages.extend(restated);
    } else if !chat || request.append_prompt || messages.is_empty() {
        messages.push(ModelMessage::user(request.prompt.clone()));
    }
    if chat && request.append_prompt {
        messages.extend(restated_after_follow_up(
            context,
            request.appended_message_ids.as_deref().unwrap_or(&[]),
            sender_tags,
        ));
    }
    if request.after_restart {
        messages.push(ModelMessage::user(RESUMED_RUN_NOTICE));
    }

    Ok(TurnRequest {
        system_parts,
        messages,
        tool_change_messages: history.trailing_tool_changes,
    })
}

/// The user rows from the prompt's row on, as history renders them, when the
/// history ends on an agent row stored after the prompt's row; otherwise none.
fn restated_after_reply(
    context: &AgentContext,
    prompt_message_id: Option<&str>,
    sender_tags: bool,
) -> Vec<ModelMessage> {
    let Some(prompt_message_id) = prompt_message_id.filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    let rows = &context.recent_messages;
    let Some(at) = rows.iter().position(|row| row.id == prompt_message_id) else {
        return Vec::new();
    };
    if at == rows.len() - 1 || rows[rows.len() - 1].role != MessageRole::Agent {
        return Vec::new();
    }
    rows[at..]
        .iter()
        .filter(|row| row.role == MessageRole::User)
        .filter_map(|row| build_user_message(row, sender_tags))
        .collect()
}

/// The user rows stored after both the last agent row and the rows of a
/// follow-up's appended prompt, as history renders them; none when history
/// has none of those rows, as a thread provider that gives rows its own ids reads it.
fn restated_after_follow_up(
    context: &AgentContext,
    appended_message_ids: &[String],
    sender_tags: bool,
) -> Vec<ModelMessage> {
    let rows = &context.recent_messages;
    if !rows
        .iter()
        .any(|row| appended_message_ids.contains(&row.id))
    {
        return Vec::new();
    }
    let mut after = rows.len();
    while after > 0
        && rows[after - 1].role != MessageRole::Agent
        && !appended_message_ids.contains(&rows[after - 1].id)
    {
        after -= 1;
    }
    rows[after..]
        .iter()
        .filter(|row| row.role == MessageRole::User)
        .filter_map(|row| build_user_message(row, sender_tags))
        .collect()
}

// ============================================================================
// The step stream
// ============================================================================

/// Hands one value to the stream's consumer and waits until it has taken it, as a
/// generator's `yield` does.
struct Yielder<T> {
    slot: Arc<Mutex<Option<T>>>,
}

impl<T: Unpin> Yielder<T> {
    fn yield_(&self, item: T) -> YieldFuture<'_, T> {
        YieldFuture {
            slot: &self.slot,
            item: Some(item),
        }
    }
}

struct YieldFuture<'a, T> {
    slot: &'a Mutex<Option<T>>,
    item: Option<T>,
}

impl<T: Unpin> Future for YieldFuture<'_, T> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<()> {
        let this = self.get_mut();
        if let Some(item) = this.item.take() {
            *this.slot.lock() = Some(item);
            return Poll::Pending;
        }
        if this.slot.lock().is_some() {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    }
}

/// A stream driven by one producer future: the producer runs only while the
/// consumer asks for the next value, and dropping the stream drops the producer
/// where it stands.
struct Generator<T> {
    slot: Arc<Mutex<Option<T>>>,
    producer: Option<BoxFuture<'static, ()>>,
}

impl<T> Stream for Generator<T> {
    type Item = T;

    fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<T>> {
        let this = self.get_mut();
        let Some(producer) = this.producer.as_mut() else {
            return Poll::Ready(this.slot.lock().take());
        };
        let done = producer.as_mut().poll(cx).is_ready();
        if done {
            this.producer = None;
        }
        if let Some(item) = this.slot.lock().take() {
            return Poll::Ready(Some(item));
        }
        if done {
            Poll::Ready(None)
        } else {
            Poll::Pending
        }
    }
}

fn generate<T, F, Fut>(producer: F) -> BoxStream<'static, T>
where
    T: Send + Unpin + 'static,
    F: FnOnce(Yielder<T>) -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
{
    let slot = Arc::new(Mutex::new(None));
    let yielder = Yielder { slot: slot.clone() };
    Box::pin(Generator {
        slot,
        producer: Some(Box::pin(producer(yielder))),
    })
}

/// Where a turn's steps go: the consumer, and the turn's ending, which a step's
/// error sets.
struct StepOut {
    yielder: Yielder<anyhow::Result<InvokeStep>>,
    ending: Arc<Mutex<TurnEnding>>,
}

impl StepOut {
    async fn step(&self, step: InvokeStep) {
        if let Some(error) = &step.error {
            self.ending.lock().error = Some(turn_error(error).to_string());
        }
        self.yielder.yield_(Ok(step)).await;
    }
}

/// Reports how the turn ended to the agent's state when it is dropped, whichever
/// exit the turn takes.
struct TurnReport {
    handle: TurnHandle,
    ending: Arc<Mutex<TurnEnding>>,
}

impl Drop for TurnReport {
    fn drop(&mut self) {
        self.handle.end(self.ending.lock().clone());
    }
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
/// reports for both. Every other run reports how it ended to the agent's state,
/// whichever exit it takes.
pub fn invoke_stream(request: InvokeRequest) -> BoxStream<'static, anyhow::Result<InvokeStep>> {
    generate(move |yielder| async move {
        let ending = Arc::new(Mutex::new(TurnEnding::default()));
        // A subagent runs inside its parent's turn, which reports for both.
        let report = (request.mode != InvokeMode::Subagent).then(|| TurnReport {
            handle: PROGRAM_STATUS_SERVICE.begin_turn(),
            ending: ending.clone(),
        });
        let out = StepOut {
            yielder,
            ending: ending.clone(),
        };
        if let Err(error) = stream_invocation(request, &out).await {
            ending.lock().error = Some(TURN_FAILED.to_string());
            drop(report);
            out.yielder.yield_(Err(error)).await;
        }
    })
}

/// The cleanup every exit of an invocation runs once its work has begun: the
/// thread's activity mark, the computers it held, the turn's context measurement
/// and the agent's processing count. A stream dropped mid-turn runs it on drop.
struct InvocationCleanup {
    activity: Mutex<Option<Arc<ThreadActivity>>>,
    computer_use: Arc<ComputerUse>,
    thread_id: Option<String>,
    agent_id: String,
    done: AtomicBool,
}

impl InvocationCleanup {
    async fn run(&self) -> anyhow::Result<()> {
        if self.done.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.release();
        // Persist the turn's final context measurement: one write per turn rather
        // than per step. Runs for canceled turns too: the prompt was still built and
        // sent, so the reading is real. `finalize` swallows its own persistence
        // failures, so it cannot mask whatever brought us here.
        if let Some(thread_id) = &self.thread_id {
            CONTEXT_USAGE_SERVICE.finalize(thread_id).await;
        }
        AGENT_STATUS_SERVICE
            .set_done_processing(&self.agent_id)
            .await
    }

    fn release(&self) {
        if let Some(activity) = self.activity.lock().take() {
            activity.end();
        }
        COMPUTER_SERVICE.finish(&self.computer_use);
    }
}

impl Drop for InvocationCleanup {
    fn drop(&mut self) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        self.release();
        let thread_id = self.thread_id.clone();
        let agent_id = self.agent_id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Some(thread_id) = &thread_id {
                    CONTEXT_USAGE_SERVICE.finalize(thread_id).await;
                }
                if let Err(err) = AGENT_STATUS_SERVICE.set_done_processing(&agent_id).await {
                    log_warn!(
                        json!({ "err": err_json(&err) }),
                        "Failed to mark the agent done processing"
                    );
                }
            });
        }
    }
}

/// The purpose a turn's model calls are recorded under.
fn purpose_for(mode: InvokeMode) -> LlmCallPurpose {
    match mode {
        InvokeMode::Chat => LlmCallPurpose::Chat,
        InvokeMode::Heartbeat => LlmCallPurpose::Heartbeat,
        InvokeMode::Cron => LlmCallPurpose::Cron,
        InvokeMode::Subagent => LlmCallPurpose::Subagent,
        InvokeMode::Goal => LlmCallPurpose::Goal,
        InvokeMode::Webhook => LlmCallPurpose::Webhook,
    }
}

/// The caller a computer use is for.
fn computer_caller(request: &InvokeRequest) -> ComputerCaller {
    ComputerCaller {
        user_id: request.user_id.clone(),
        agent_id: request.agent_id.clone(),
        thread_id: request.thread_id.clone(),
        mode: request.mode.as_str().to_string(),
        origin_channel: request.origin_channel,
        origin_channel_id: request.origin_channel_id.clone(),
    }
}

/// `ending.cancelled` is set when a stop ends the turn: the caller's, or the computer's.
async fn stream_invocation(mut request: InvokeRequest, out: &StepOut) -> anyhow::Result<()> {
    // The thread is in use again, so a pending idle compaction would summarize a
    // stale view of it.
    if let Some(thread_id) = &request.thread_id {
        COMPACTION_SERVICE.cancel_idle(thread_id);
    }
    let start_time = now_ms();

    // Preflight: short-circuit before any DB call.
    let missing_settings = missing_provider_settings().await;
    if !missing_settings.is_empty() {
        log_error!(
            json!({ "provider": CONFIG.llm_provider.as_str(), "missingSettings": missing_settings }),
            "LLM provider not configured, returning placeholder response"
        );
        out.step(InvokeStep {
            text: format!(
                "I am not fully configured yet: the {} LLM provider needs {}.",
                CONFIG.llm_provider.as_str(),
                missing_settings.join(" and ")
            ),
            tool_calls: Vec::new(),
            // An error, so autonomous runs deliver the notice instead of withholding it.
            error: Some(InvokeError {
                kind: InvokeErrorType::Generic,
                detail: Some(format!("missing {}", missing_settings.join(", "))),
            }),
            ..Default::default()
        })
        .await;
        return Ok(());
    }

    if request.agent_id.is_empty() {
        log_error!("Agent ID is missing in the request");
        out.step(InvokeStep {
            text: "I apologize, but I am not sure which agent to use. Please specify an agent ID."
                .to_string(),
            tool_calls: Vec::new(),
            ..Default::default()
        })
        .await;
        return Ok(());
    }
    let agent_id = request.agent_id.clone();
    let computer_use =
        COMPUTER_SERVICE.create_use(computer_caller(&request), request.abort_signal.as_ref());
    request.abort_signal = Some(computer_use.signal.clone());

    // Chat always sees history. A thread-bound cron run ("continue in this
    // conversation") also needs it so the resumed agent remembers what it was
    // waiting for; plain cron/heartbeat/goal stay history-less by design (goal turns
    // restate their objective rather than replay history).
    let include_conversation = request.mode == InvokeMode::Chat
        || (request.mode == InvokeMode::Cron && request.thread_id.is_some());

    // Fetch context. Failures become friendly error steps.
    let mut context = match CONTEXT_SERVICE
        .get_agent_context(
            &request.user_id,
            AgentContextOptions {
                agent_id: request.agent_id.clone(),
                thread_id: request.thread_id.clone(),
                include_conversation: Some(include_conversation),
                verbose: request.verbose,
            },
        )
        .await
    {
        Ok(context) => context,
        Err(error) => {
            computer_use.failed.store(true, Ordering::SeqCst);
            COMPUTER_SERVICE.finish(&computer_use);
            out.step(build_error_step(&error)).await;
            return Ok(());
        }
    };
    if let Some(on_history_read) = &request.on_history_read {
        on_history_read(&context.recent_messages);
    }

    let cleanup = InvocationCleanup {
        activity: Mutex::new(None),
        computer_use: computer_use.clone(),
        thread_id: request.thread_id.clone(),
        agent_id: agent_id.clone(),
        done: AtomicBool::new(false),
    };
    let outcome = run_invocation(
        request,
        &mut context,
        &computer_use,
        &cleanup,
        include_conversation,
        start_time,
        out,
    )
    .await;
    let finished = cleanup.run().await;
    outcome.and(finished)
}

/// The tool set and the inputs a turn builds each model request from.
struct RequestInputs {
    request: InvokeRequest,
    agent_id: String,
    context: Arc<AgentContext>,
    model_id: String,
    cache_point: CachePointFragment,
    gated_tools: ToolSet,
    /// The turn's finished steps, which `load_tools`'s events count from.
    steps_finished: Arc<AtomicUsize>,
    deferrable: Vec<String>,
    subagents: Vec<Subagent>,
    tool_change_protocol: Option<&'static ToolChangeProtocol>,
    include_conversation: bool,
    memory_blocks: Vec<String>,
    guard: Arc<AtomicBool>,
}

/// The tool options of the early-stop summary request.
#[derive(Clone, Default)]
struct SummaryTools {
    tools: Option<ToolSet>,
    tool_choice: Option<ToolChoice>,
    allow_system_in_messages: bool,
    stop_when: Option<StopCondition>,
}

/// The tools, system prompt and messages of one model request.
#[derive(Clone)]
struct ModelRequest {
    tool_search_active: bool,
    deferred_count: usize,
    declared: bool,
    cached_tools: ToolSet,
    summary_declares_tools: bool,
    summary_tools: SummaryTools,
    messages: Vec<ModelMessage>,
    tool_change_messages: Vec<ModelMessage>,
    cached_system: Vec<SystemModelMessage>,
}

impl RequestInputs {
    fn guard_context(&self, stage: InvokeStage) -> TrailingAssistantContext {
        TrailingAssistantContext {
            agent_id: self.agent_id.clone(),
            user_id: self.request.user_id.clone(),
            mode: self.request.mode.as_str().to_string(),
            stage,
            guard: self.guard.clone(),
        }
    }

    /// The tools, system prompt and messages of one model request. A turn builds a
    /// second one, with no deferred tools, when the API refuses the first (see
    /// `fail`).
    async fn build(
        &self,
        protocol: Option<&'static DeferredToolProtocol>,
    ) -> anyhow::Result<ModelRequest> {
        let request = &self.request;
        // Above the threshold the MCP tools go deferred, behind `load_tools` and the
        // catalog. `load_tools` is added after the gate: the tool it loads is gated
        // on each call. It reports its calls like the gated tools, so a step that
        // only loads tools is a step too.
        let mut tool_search: ToolSearchPlan = plan_tool_search(PlanToolSearchInput {
            tools: self.gated_tools.clone(),
            deferrable: self.deferrable.clone(),
            protocol,
            model_id: self.model_id.clone(),
            telemetry: ToolSearchTelemetry {
                user_id: request.user_id.clone(),
                agent_id: self.agent_id.clone(),
                mode: request.mode.as_str().to_string(),
            },
        })
        .await;
        tool_search.tools = with_tool_lifecycle_events_on(
            tool_search.tools,
            LOAD_TOOLS_NAME,
            request.on_tool_event.clone(),
            self.steps_finished.clone(),
        );
        // A request that replays the conversation sends the conversation's declared
        // tool list, so the tools block stays the same when the tool set changes
        // (see tool_ledger_service.rs).
        let declared = match (
            self.tool_change_protocol,
            request.thread_id.as_deref(),
            self.include_conversation,
        ) {
            (Some(protocol), Some(thread_id), true) => {
                let row_ids: Vec<String> = self
                    .context
                    .recent_messages
                    .iter()
                    .map(|row| row.id.clone())
                    .collect();
                Some(
                    TOOL_LEDGER_SERVICE
                        .declare(DeclareInput {
                            thread_id,
                            model_id: &self.model_id,
                            protocol,
                            available: &tool_search.tools,
                            row_ids: &row_ids,
                        })
                        .await,
                )
            }
            _ => None,
        };
        let deferred: HashSet<String> = declared
            .as_ref()
            .map(|declared| declared.deferred.iter().cloned().collect())
            .unwrap_or_default();
        let cached_tools = with_tools_cache_control(
            declared
                .as_ref()
                .map(|declared| declared.tools.clone())
                .unwrap_or_else(|| tool_search.tools.clone()),
            self.cache_point,
            &deferred,
        );
        // The catalog and the replayed loads follow the tools block the request sends.
        let tool_search_prompt = match &declared {
            Some(declared) => (tool_search.prompt_for)(declared.tools.clone(), deferred).await,
            None => ToolSearchPrompt {
                catalog: tool_search.catalog.clone(),
                replay_tool_call: tool_search.replay_tool_call.clone(),
            },
        };
        // A summary request keeps the tools block when history names a declared or
        // loaded tool, or the API refuses the request. The Anthropic SDK drops the
        // block under tool choice 'none', so there the summary runs under 'auto' and
        // refuses every call; the OpenAI SDK keeps it under 'none'.
        let summary_declares_tools = declared.is_some() || tool_search.summary_declares_tools;
        let summary_tools = if summary_declares_tools {
            let options = summary_tool_options(&cached_tools);
            SummaryTools {
                tools: Some(options.tools),
                tool_choice: Some(options.tool_choice),
                allow_system_in_messages: options.allow_system_in_messages,
                stop_when: Some(options.stop_when),
            }
        } else if tool_search.active {
            SummaryTools {
                tools: Some(cached_tools.clone()),
                tool_choice: Some(ToolChoice::None),
                ..Default::default()
            }
        } else {
            SummaryTools::default()
        };

        // Build the system prompt parts and the messages.
        let turn_request = build_turn_request(
            &self.context,
            request,
            &self.subagents,
            declared
                .as_ref()
                .map(|declared| declared.tool_changes.as_slice()),
            Some(&tool_search_prompt),
        )
        .await?;
        let mut messages = turn_request.messages;

        // Checked before the recall is appended, so it judges the history the thread
        // actually has. The recall is an unconditional trailing user turn, which makes
        // any assistant-terminated array provider-valid; checking after it would be
        // the silent fix-up this function exists to refuse.
        warn_on_trailing_assistant(&messages, &self.guard_context(InvokeStage::Initial));
        for content in &self.memory_blocks {
            messages.push(ModelMessage::user(content.clone()));
        }

        // Prompt caching: system prompt parts marked cacheable get cache breakpoints.
        // [0] stable prefix — identity, soul, important memories, instructions. The
        // one system breakpoint: the dynamic part behind it has only the date, and a
        // change there still hits this one.
        //
        // Bedrock allows 4. The Anthropic Messages path spends 3: this, the last
        // message (via prepare_step) and the last tool. On Converse the fragment is
        // empty for every model, so it spends 0.
        let cached_system: Vec<SystemModelMessage> = turn_request
            .system_parts
            .iter()
            .map(|part| SystemModelMessage {
                content: part.text.clone(),
                provider_options: part
                    .cacheable
                    .then(|| self.cache_point.to_provider_options()),
            })
            .collect();
        // The last message breakpoint is handled by prepare_step (re-applied each step
        // as messages grow during tool use). Setting it here would leave a stale
        // breakpoint on the original last message, wasting a slot on step 2+.

        log_info!(
            "{} in {} mode: {} tool(s), {} message(s)",
            self.context.agent_name,
            request.mode.as_str(),
            cached_tools.len(),
            messages.len()
        );
        Ok(ModelRequest {
            tool_search_active: tool_search.active,
            deferred_count: tool_search.deferred.len(),
            declared: declared.is_some(),
            cached_tools,
            summary_declares_tools,
            summary_tools,
            messages,
            tool_change_messages: turn_request.tool_change_messages,
            cached_system,
        })
    }
}

/// One turn's model calls and what they share.
struct Turn {
    inputs: RequestInputs,
    provider: LlmProvider,
    model: Arc<dyn LanguageModel>,
    cache_request: ProviderOptionsFragment,
    channel: Arc<AsyncChannel<InvokeStep>>,
    ending: Arc<Mutex<TurnEnding>>,
    computer_use: Arc<ComputerUse>,
    model_request: Mutex<ModelRequest>,
    /// Steering messages already folded into this turn, each pinned to the index it
    /// was inserted at. The injections are not part of the SDK's own message list,
    /// so they are re-spliced each step to stay in the conversation at a stable
    /// position.
    injections: Mutex<Vec<(usize, ModelMessage)>>,
    /// Messages a tool asks to append to the running conversation, for content a
    /// tool result cannot hold and that must arrive as a user message of its own.
    pending_attachment_injections: Arc<Mutex<Vec<ModelMessage>>>,
    pending_file_writes: Arc<dyn PendingFileWrites>,
    /// The turn's latest occupancy snapshot and raw token count: `finalize` drops
    /// the service's tracked entry, so these are the only post-turn copies.
    last_snapshot: Mutex<Option<ContextUsageSnapshot>>,
    last_measured_tokens: Mutex<Option<i64>>,
    /// Shared with the tools, whose events name the step a call runs in.
    steps_finished: Arc<AtomicUsize>,
    retried_in_full: AtomicBool,
    refused_deferral: AtomicBool,
    was_canceled: AtomicBool,
}

impl Turn {
    fn request(&self) -> &InvokeRequest {
        &self.inputs.request
    }

    fn aborted(&self) -> bool {
        self.request()
            .abort_signal
            .as_ref()
            .is_some_and(|signal| signal.is_cancelled())
    }

    /// LLM-call tracing; one metadata set reused across this turn's calls.
    fn telemetry(&self, function_id: &str) -> LangfuseTelemetry {
        let request = self.request();
        let mut identifiers = IndexMap::new();
        identifiers.insert("userId".to_string(), request.user_id.clone());
        identifiers.insert(
            "sessionId".to_string(),
            request.thread_id.clone().unwrap_or_default(),
        );
        identifiers.insert(
            "agentName".to_string(),
            self.inputs.context.agent_name.clone(),
        );
        langfuse_telemetry(function_id, Some(identifiers), None)
    }

    /// The turn's request ingredients as a compaction fork (see
    /// compaction_service.rs). Shared by the success hook (threshold trigger) and
    /// the error hook (overflow recovery), which extend it differently.
    fn compaction_fork_base(&self, thread_id: &str) -> CompactionFork {
        let model_request = self.model_request.lock().clone();
        CompactionFork {
            user_id: self.request().user_id.clone(),
            agent_id: self.inputs.agent_id.clone(),
            thread_id: thread_id.to_string(),
            model_id: self.inputs.model_id.clone(),
            model: self.model.clone(),
            cache_point: self.inputs.cache_point,
            cache_request: self.cache_request.clone(),
            system: model_request.cached_system,
            tools: model_request.cached_tools,
            declared_tools: model_request.summary_declares_tools,
            messages: model_request.messages,
            injections: self
                .injections
                .lock()
                .iter()
                .map(|(_, message)| message.clone())
                .collect(),
            context_rows: to_fork_rows(&self.inputs.context.recent_messages),
        }
    }

    /// The request sent in full was answered: the model sends every tool in full
    /// from now on.
    fn confirm_deferral_refusal(&self) {
        if !self.refused_deferral.swap(false, Ordering::SeqCst) {
            return;
        }
        let model_id = &self.inputs.model_id;
        if !record_deferral_refusal(model_id) {
            return;
        }
        log_warn!(
            "Model {} refuses deferred tools; sending every tool in full until restart",
            model_id
        );
        track_event(
            "tool search refused",
            Some(&self.request().user_id),
            Some(props(&[
                ("agent.id", self.inputs.agent_id.clone()),
                ("invoke.mode", self.request().mode.as_str().to_string()),
                ("llm.model", model_id.clone()),
            ])),
        );
    }

    /// Fold in any mid-turn steering messages, then re-apply the cache breakpoint on
    /// the latest last message so the growing conversation prefix is cached between
    /// steps (Bedrock does not support automatic caching; only the direct Anthropic
    /// API does).
    async fn prepare_step(&self, options: PrepareStepOptions) -> PrepareStepResult {
        // Rebuilt from the SDK's discrete pieces, not from the hook's own
        // `messages`: a returned `messages` override is the base for later steps, so
        // `messages` already holds the previous step's injections and cache
        // breakpoint. Splicing onto it duplicates each injection per remaining step
        // and spends a cache block per step.
        let mut base: Vec<ModelMessage> = options.initial_messages;
        let first_step = options.response_messages.is_empty();
        base.extend(options.response_messages);
        // On the first step the turn's tool-change announcements close the array,
        // and no user turn may follow one, so an injection goes before them.
        let insert_at = if first_step {
            base.len()
                .saturating_sub(self.model_request.lock().tool_change_messages.len())
        } else {
            base.len()
        };

        // Async so the steering source can load a mid-turn message's files before
        // shaping it.
        let steering = match &self.request().steering {
            Some(source) => source().await,
            None => Vec::new(),
        };
        for pending in steering {
            let files = match &pending.attachments {
                Some(attachments) if !attachments.is_empty() => {
                    format!(", {} file(s)", attachments.len())
                }
                _ => String::new(),
            };
            log_info!(
                "Steering the in-flight turn with a mid-turn message ({} chars{})",
                len16(&pending.text),
                files
            );
            self.injections
                .lock()
                .push((insert_at, build_steering_message(&pending)));
        }

        // Documents view_attachment registered since the last step boundary, pinned
        // at this step's tail so each lands right after the tool result that
        // attached it, then re-spliced every later step like any other injection.
        let attached: Vec<ModelMessage> = self
            .pending_attachment_injections
            .lock()
            .drain(..)
            .collect();
        {
            let mut injections = self.injections.lock();
            for message in attached {
                injections.push((insert_at, message));
            }
        }

        // A step boundary is the exact scope: the previous step's tools have all
        // settled and the next step's calls do not exist yet, so nothing can be
        // waiting and nothing can leak across steps.
        self.pending_file_writes.clear();

        // Splice highest index first so each injection lands before the step-message
        // it was recorded against, unshifted by the others.
        let mut merged = base;
        for (at, message) in self.injections.lock().iter().rev() {
            merged.insert((*at).min(merged.len()), message.clone());
        }

        // The breakpoint goes on the last message that is not a tool-change
        // announcement: the provider sends an announcement without the text block a
        // breakpoint would sit on.
        if let Some(stamp) = merged
            .iter_mut()
            .rev()
            .find(|message| !matches!(message, ModelMessage::System(_)))
        {
            let fragment = self.inputs.cache_point.to_provider_options();
            let stamped = merge_provider_options([stamp.provider_options(), Some(&fragment)]);
            *stamp.provider_options_mut() = Some(stamped);
        }

        warn_on_trailing_assistant(&merged, &self.inputs.guard_context(InvokeStage::Step));
        PrepareStepResult {
            messages: Some(merged),
            ..Default::default()
        }
    }

    /// Convert an SDK step to an `InvokeStep` and push it to the channel.
    ///
    /// What is stored is the *model-facing* view, not the raw execute() return: the
    /// same rendering and the same cut the model saw this turn, so replaying it
    /// costs what the live turn cost.
    fn on_step_finish(&self, step: &StepResult) {
        self.steps_finished.fetch_add(1, Ordering::SeqCst);
        self.confirm_deferral_refusal();
        let model_id = &self.inputs.model_id;

        let step_tool_calls = step_tool_calls(step);
        let text = step.text();
        let tool_calls = step.tool_calls();
        let tool_results = step.tool_results();
        let attachment_ids = extract_attachment_ids(
            tool_calls
                .iter()
                .map(|call| (call.tool_name.as_str(), call.tool_call_id.as_str())),
            tool_results
                .iter()
                .map(|result| (result.tool_call_id.as_str(), &result.output)),
        );
        let usage = to_step_usage(model_id, Some(&step.usage));
        let input_tokens = step.usage.input_tokens;
        let output_tokens = step.usage.output_tokens;

        // Context occupancy for the context-window indicator. Only for turns bound to
        // a thread: heartbeat, webhook and subagent runs pass no thread id, and their
        // prompt is not any thread's history.
        if let Some(thread_id) = &self.request().thread_id {
            let recorded = CONTEXT_USAGE_SERVICE.record(RecordInput {
                user_id: self.request().user_id.clone(),
                thread_id: thread_id.clone(),
                model_id: model_id.clone(),
                input_tokens,
                output_tokens,
            });
            if recorded.is_some() {
                *self.last_snapshot.lock() = recorded;
            }
            if let Some(input_tokens) = input_tokens {
                *self.last_measured_tokens.lock() = Some(input_tokens + output_tokens.unwrap_or(0));
            }
        }

        self.channel.push(InvokeStep {
            text,
            tool_calls: step_tool_calls,
            usage,
            attachment_ids: (!attachment_ids.is_empty()).then_some(attachment_ids),
            ..Default::default()
        });
    }

    /// The model call with its options, and what the turn does when it returns.
    async fn send(self: &Arc<Self>) -> anyhow::Result<()> {
        let request = self.request();
        let model_request = self.model_request.lock().clone();

        let mut params = GenerateTextOptions::new(self.model.clone());
        params.system = Some(Instructions::Messages(model_request.cached_system.clone()));
        let mut messages = model_request.messages.clone();
        messages.extend(model_request.tool_change_messages.iter().cloned());
        params.messages = Some(messages);
        // The SDK refuses a system message inside `messages` without this.
        params.allow_system_in_messages = model_request.declared;
        params.tools =
            (!model_request.cached_tools.is_empty()).then(|| model_request.cached_tools.clone());
        params.tool_choice = Some(ToolChoice::Auto);
        params.max_output_tokens = Some(MAX_OUTPUT_TOKENS);
        params.provider_options = Some(self.cache_request.clone());
        params.stop_when = Some(vec![step_count_is(STEP_LIMIT as usize)]);
        params.abort_signal = request.abort_signal.clone();
        apply_telemetry(
            &mut params,
            self.telemetry(&format!("invoke-{}", request.mode.as_str())),
        );
        let turn = self.clone();
        params.prepare_step = Some(Arc::new(move |options| {
            let turn = turn.clone();
            Box::pin(async move { Ok(Some(turn.prepare_step(options).await)) })
        }));
        let turn = self.clone();
        params.on_step_finish = Some(Arc::new(move |step| {
            let turn = turn.clone();
            Box::pin(async move { turn.on_step_finish(&step) })
        }));

        let result = call_model(
            ModelCallMeta {
                purpose: purpose_for(request.mode),
                thread_id: request.thread_id.clone(),
                agent_id: Some(request.agent_id.clone()),
                request_id: None,
                source: None,
            },
            params,
        )
        .await?;
        self.on_success(result).await
    }

    async fn on_success(self: &Arc<Self>, result: GenerateTextResult) -> anyhow::Result<()> {
        self.confirm_deferral_refusal();
        let request = self.request();
        let model_id = &self.inputs.model_id;

        // A refusal ends the turn with no text, no tool calls and no error, so nothing
        // downstream has anything to publish. Checked across every step rather than
        // on the final one: a turn that spoke before it declined has already told the
        // user something, and a second message adds nothing.
        if result.finish_reason() == FinishReason::ContentFilter
            && !result
                .steps
                .iter()
                .any(|step| !js::trim(&step.text()).is_empty())
        {
            log_info!(
                "Model declined the request in {} mode",
                request.mode.as_str()
            );
            track_event(
                "invocation refused",
                Some(&request.user_id),
                Some(props(&[
                    ("invoke.mode", request.mode.as_str().to_string()),
                    ("agent.id", request.agent_id.clone()),
                ])),
            );
            self.channel.push(build_refusal_step());
        }

        let mut early_stopping_text: Option<String> = None;

        // If the step limit was reached, make a follow-up call to get a final summary.
        if result.steps.len() >= STEP_LIMIT as usize {
            let assistant_text = summarize_steps(&result.steps);
            log_info!(
                "Step limit ({}) reached, requesting final summary of ({} chars) from the agent",
                STEP_LIMIT,
                len16(&assistant_text)
            );

            // Mid-turn steering messages go along in arrival order: they were part
            // of this turn's conversation, but `summarize_steps` only collapses the
            // model's own steps, so without this the summary would answer the
            // original prompt and ignore what the user said since. The
            // pending-injection drain covers a document viewed on the very step that
            // hit the limit: no prepare_step ran after it.
            let model_request = self.model_request.lock().clone();
            let mut summary_messages = model_request.messages.clone();
            summary_messages.extend(
                self.injections
                    .lock()
                    .iter()
                    .map(|(_, message)| message.clone()),
            );
            summary_messages.extend(self.pending_attachment_injections.lock().drain(..));
            summary_messages.push(ModelMessage::assistant(assistant_text));
            summary_messages.push(ModelMessage::user(EARLY_STOPPING_PROMPT.as_str()));
            warn_on_trailing_assistant(
                &summary_messages,
                &self.inputs.guard_context(InvokeStage::EarlyStopping),
            );

            let mut params = GenerateTextOptions::new(self.model.clone());
            params.system = Some(Instructions::Messages(model_request.cached_system.clone()));
            params.messages = Some(summary_messages);
            let summary_tools = model_request.summary_tools.clone();
            params.tools = summary_tools.tools;
            params.tool_choice = summary_tools.tool_choice;
            params.allow_system_in_messages = summary_tools.allow_system_in_messages;
            params.stop_when = summary_tools.stop_when.map(|stop| vec![stop]);
            params.max_output_tokens = Some(MAX_OUTPUT_TOKENS);
            params.provider_options = Some(self.cache_request.clone());
            params.abort_signal = request.abort_signal.clone();
            apply_telemetry(&mut params, self.telemetry("invoke-early-stopping"));

            let summary_result = call_model(
                ModelCallMeta {
                    purpose: LlmCallPurpose::EarlyStopping,
                    thread_id: request.thread_id.clone(),
                    agent_id: Some(request.agent_id.clone()),
                    request_id: None,
                    source: None,
                },
                params,
            )
            .await?;

            let summary_text = summary_result.text();
            let summary_usage = to_step_usage(model_id, Some(summary_result.usage()));
            early_stopping_text = Some(summary_text.clone());
            self.channel.push(InvokeStep {
                text: summary_text,
                tool_calls: Vec::new(),
                usage: summary_usage,
                step_limit: true,
                ..Default::default()
            });
        }

        // Auto-compaction fork: hand this turn's request ingredients to the
        // compaction service so its summarize call reuses the cached
        // tools+system+history prefix. All trigger policy lives in the service; this
        // only fires for thread-bound turns that completed with a measurement and
        // real history. When the model's window is unknown, a trigger-only fallback
        // window stands in: the meter shows nothing for such models, but the thread
        // must still compact eventually rather than grow until the provider
        // hard-rejects it.
        let trigger_snapshot = self.last_snapshot.lock().clone().or_else(|| {
            let thread_id = request.thread_id.clone()?;
            let used_tokens = (*self.last_measured_tokens.lock())?;
            let percent = (100.0 * used_tokens as f64 / COMPACTION_FALLBACK_WINDOW_TOKENS as f64
                + 0.5)
                .floor() as i64;
            Some(ContextUsageSnapshot {
                thread_id,
                model_id: model_id.clone(),
                used_tokens,
                window_tokens: COMPACTION_FALLBACK_WINDOW_TOKENS,
                used_percent: percent.min(100),
            })
        });
        if let (Some(thread_id), Some(snapshot)) = (request.thread_id.as_deref(), trigger_snapshot)
            && !self.inputs.context.recent_messages.is_empty()
        {
            let final_assistant_text = [
                summarize_steps(&result.steps),
                early_stopping_text.unwrap_or_default(),
            ]
            .into_iter()
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
            let used_tokens = snapshot.used_tokens;
            COMPACTION_SERVICE.maybe_auto_compact(AutoCompactFork {
                fork: self.compaction_fork_base(thread_id),
                final_assistant_text,
                snapshot,
            });
            if request.mode == InvokeMode::Chat {
                COMPACTION_SERVICE.arm_idle(ArmIdleInput {
                    thread: IdleInput {
                        user_id: request.user_id.clone(),
                        agent_id: self.inputs.agent_id.clone(),
                        thread_id: thread_id.to_string(),
                    },
                    provider: &self.provider,
                    model_id: model_id.clone(),
                    used_tokens,
                });
            }
        }

        self.channel.close();
        Ok(())
    }

    /// A failed model call: a stop closes the stream quietly, an overflow triggers
    /// recovery compaction, a first request refused with deferred tools is sent
    /// again with every tool in full (the outcome of that send is returned), and
    /// anything else becomes a friendly error step.
    async fn fail(self: &Arc<Self>, error: anyhow::Error) -> Option<anyhow::Result<()>> {
        let request = self.request();
        // User-initiated cancellation: the caller aborted our signal, so generation
        // failed with an abort. Close the stream quietly: already-completed steps
        // were already pushed and stay delivered, and an "I encountered an error…"
        // bubble is not wanted. We own the signal, so `aborted` is the discriminator.
        if self.aborted() {
            self.was_canceled.store(true, Ordering::SeqCst);
            self.ending.lock().cancelled = Some(true);
            self.channel.close();
            return None;
        }
        // Overflow recovery: a turn that outgrew the window never reaches the success
        // hook, and every later turn rebuilds the same oversized context and rejects
        // again, so this one error class triggers compaction directly. The service
        // shrinks the summarize input until it fits; the friendly error step below
        // still delivers as usual.
        if let Some(thread_id) = request.thread_id.as_deref()
            && !self.inputs.context.recent_messages.is_empty()
            && is_context_overflow_error(&error)
        {
            log_warn!(
                "[Compaction] turn overflowed the context window for thread {}; triggering recovery compaction",
                thread_id
            );
            COMPACTION_SERVICE.maybe_compact_after_overflow(self.compaction_fork_base(thread_id));
        }
        // A turn's first request refused with deferred tools is sent again with every
        // tool in full. Any 400 counts, since the APIs word that refusal differently;
        // the second answer is what records the model. Only a request before the
        // first step is sent again, since a step's tools have run.
        let tool_search_active = self.model_request.lock().tool_search_active;
        if !self.retried_in_full.load(Ordering::SeqCst)
            && self.steps_finished.load(Ordering::SeqCst) == 0
            && tool_search_active
            && is_rejected_request_error(&error)
        {
            log_warn!(
                json!({ "err": err_json(&error) }),
                "Model {} refused a request that deferred tools; sending it with every tool in full",
                self.inputs.model_id
            );
            self.retried_in_full.store(true, Ordering::SeqCst);
            let mut next = match self.inputs.build(None).await {
                Ok(next) => next,
                Err(error) => return Some(Err(error)),
            };
            // Steering messages the refused request took are sent at its tail.
            next.messages
                .extend(self.injections.lock().drain(..).map(|(_, message)| message));
            *self.model_request.lock() = next;
            self.refused_deferral.store(true, Ordering::SeqCst);
            return Some(self.send().await);
        }
        // Surface the error as a friendly step so consumers need no separate
        // error-handling path. `build_error_step` is the single formatter for
        // LLM/runtime errors (budget-aware).
        self.computer_use.failed.store(true, Ordering::SeqCst);
        self.channel.push(build_error_step(&error));
        self.channel.close();
        None
    }

    /// The model call and every retry its failure asks for.
    async fn run(self: Arc<Self>) {
        let mut outcome = self.send().await;
        while let Err(error) = outcome {
            match self.fail(error).await {
                Some(next) => outcome = next,
                None => return,
            }
        }
    }
}

/// The invocation from the point it marks the agent busy until its steps are
/// delivered. `cleanup` holds what the caller releases afterwards.
async fn run_invocation(
    request: InvokeRequest,
    context: &mut AgentContext,
    computer_use: &Arc<ComputerUse>,
    cleanup: &InvocationCleanup,
    include_conversation: bool,
    start_time: i64,
    out: &StepOut,
) -> anyhow::Result<()> {
    let agent_id = request.agent_id.clone();
    AGENT_STATUS_SERVICE
        .set_processing(&request.agent_id)
        .await?;
    let activity = Arc::new(CONVERSATION_THREAD_ACTIVITY_SERVICE.begin(&request).await);
    *cleanup.activity.lock() = Some(activity.clone());
    let idle: IdleWrapper = Arc::new(move |wait| {
        let activity = activity.clone();
        Box::pin(async move { activity.idle(wait).await })
    });
    *computer_use.idle.lock() = Some(idle);

    context.posting_ceiling = request.posting_ceiling.clone();
    if matches!(
        request.mode,
        InvokeMode::Cron | InvokeMode::Heartbeat | InvokeMode::Goal
    ) {
        context.last_send = request.last_send.clone();
    }

    // Per-turn runtime notices, surfaced as an authoritative system-prompt section
    // (e.g. an attachment that failed to download).
    context.runtime_notices = request.runtime_notices.clone();
    let mode = request.mode.as_str();
    if has_computer_for_mode(mode) {
        let help = COMPUTER_HELP_SERVICE
            .for_turn(&computer_caller(&request))
            .await?;
        let computers = COMPUTER_SERVICE.notice(mode);
        let mut notices = request.runtime_notices.clone().unwrap_or_default();
        notices.extend(computers);
        notices.extend(computer_help_notices(&help, waits_for_answer(mode)));
        context.runtime_notices = Some(notices);
    }

    // Create provider and model: `create_provider` picks the configured vendor and
    // routing (direct vs the Mirantis Agent Platform gateway).
    let provider = create_provider();
    let turn_model = select_turn_model(context, &RoutedRequest::from(&request), &provider).await?;
    let model_id = turn_model.model_id.clone();
    let tier_note = match turn_model.tier {
        Some(tier) => format!(" ({} tier, {})", tier.as_str(), turn_model.reason.as_str()),
        None => String::new(),
    };
    log_info!(
        "Invoking in {} mode with model {}{} for agent {}",
        mode,
        model_id,
        tier_note,
        context.agent_name
    );

    let model = provider.model(&model_id)?;
    let cache_point = provider.cache_point(&model_id, Some(cache_ttl_for(mode)));
    let cache_request = cache_request_options(&provider, &model_id, cache_ttl_for(mode), true);
    let tool_change_protocol = provider.tool_changes(&model_id);
    let deferred_tool_protocol = provider.deferred_tools(&model_id);

    // Queue for messages a tool asks to append to the running conversation. A tool
    // pushes here while its step runs; prepare_step drains the queue at the next
    // step boundary into the injections, which pin each message right after the
    // tool result that asked for it.
    let pending_attachment_injections: Arc<Mutex<Vec<ModelMessage>>> =
        Arc::new(Mutex::new(Vec::new()));

    // The current step's file writes, so `share_file` can wait for a write to the
    // file it is about to read rather than racing it: a step's tool calls run
    // concurrently, and reading first captures the file as it was before the edit.
    // Scoped to one step by the `clear()` in prepare_step.
    let pending_file_writes = create_pending_file_writes();

    // Collect tools (see lib/tool_collection.rs).
    let task_invoker: Invoker = Arc::new(|request| Box::pin(invoke(request)));
    let injections = pending_attachment_injections.clone();
    let collected = collect_tools(CollectToolsInput {
        computer_use: Some(computer_use.clone()),
        user_id: request.user_id.clone(),
        agent_id: request.agent_id.clone(),
        thread_id: request.thread_id.clone(),
        mode: mode.to_string(),
        origin_channel: request.origin_channel,
        origin_channel_id: request.origin_channel_id.clone(),
        posting_ceiling: request.posting_ceiling.clone(),
        heartbeat_triggered: request.heartbeat_triggers.is_some(),
        workspace_root: request.workspace_root.clone(),
        task_invoker,
        register_attachment_injection: Some(Arc::new(move |message| {
            injections.lock().push(message);
        })),
        pending_file_writes: Some(pending_file_writes.clone()),
        // While locked in, the workspace-markdown writers are withheld.
        locked_in: context.locked_in,
    })
    .await?;

    // Wrap tools with lifecycle events, output capture, the optional pre-execution
    // risk gate, and cache control. The order keeps two invariants together:
    //
    //  - lifecycle innermost, so the "is running <tool>…" indicator clears when the
    //    tool itself finishes rather than after the saved copy is written;
    //  - the gate outside lifecycle, so a rejected call never claims the underlying
    //    tool started running.
    //
    // The gate sits outside the capture too: a rejected call produces no result, so
    // there is nothing to cut or save.
    let steps_finished = Arc::new(AtomicUsize::new(0));
    let observed_tools = with_tool_lifecycle_events(
        collected.tools,
        request.on_tool_event.clone(),
        steps_finished.clone(),
    );
    let limited_tools = with_tool_output_capture(
        observed_tools,
        ToolOutputCaptureOptions {
            workspace_root: request.workspace_root.clone(),
            ..Default::default()
        },
    );
    let gated_tools = with_tool_risk_gate(
        limited_tools,
        ToolRiskGateOptions {
            mode: CONFIG.tool_risk_gate_mode,
            invocation_mode: mode.to_string(),
            initial_prompt: request.prompt.clone(),
            initial_prompt_source: request.prompt_source,
            // Read as policy by the classifier, not as evidence; see the gate.
            agent_guide: Some(context.agent_md.clone()),
            user_id: request.user_id.clone(),
            agent_id: request.agent_id.clone(),
            evaluate: None,
        },
    );

    // A new conversation opens with what the agent recorded in the hours before it,
    // then every turn gets what its message matched in the memory store. Each block
    // is a user turn that follows the question. A run of user messages merges into
    // one provider turn, so the model sees the blocks and the question together.
    //
    // They go after the question rather than before it, because that is where the
    // stored rows sort: the engine writes the user's message before the turn runs.
    // Matching that order is what lets a replayed thread rebuild the prompt that ran.
    //
    // Recorded on chat turns only. The row lets a replayed thread rebuild the prompt
    // that produced its stored answers, which needs the question stored too, and
    // only chat stores it. A goal or a thread-bound cron task appends its prompt at
    // invoke time and never writes it down, so a row there would be an orphan block
    // with no question, once per run, each replaying into every later chat turn.
    let recording_thread_id = if request.mode == InvokeMode::Chat {
        request.thread_id.clone()
    } else {
        None
    };
    let recent = match &recording_thread_id {
        Some(_) => build_recent_memories(context).await?,
        None => None,
    };
    let recalled = build_recalled_memories(
        context,
        Some(&request.prompt),
        recent.as_ref().map(|recent| recent.entry_ids.as_slice()),
    )
    .await?;
    let mut memory_blocks: Vec<String> = Vec::new();
    if let Some(recent) = &recent {
        memory_blocks.push(recent_memory_content(&recent.text));
    }
    if let Some(recalled) = &recalled {
        memory_blocks.push(recalled_memory_content(recalled));
    }
    if let Some(thread_id) = &recording_thread_id {
        for content in &memory_blocks {
            // Best effort: a turn must not fail because a block could not be
            // recorded. The block is in this request either way; only the replay is
            // lost.
            let mut input = MessageInput::new(
                content.clone(),
                MessageRole::User,
                crate::db::models::MessageTrigger::UserInput,
            );
            input.internal_step = Some(true);
            if let Err(err) = CONVERSATION_SERVICE.add_message(thread_id, input).await {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "Failed to record a memory block of the turn"
                );
            }
        }
    }

    let subagents: Vec<Subagent> = collected
        .subagents
        .iter()
        .map(|subagent| Subagent {
            name: subagent.name.clone(),
            description: subagent.description.clone(),
        })
        .collect();
    let context = Arc::new(context.clone());
    let inputs = RequestInputs {
        request,
        agent_id: agent_id.clone(),
        context: context.clone(),
        model_id: model_id.clone(),
        cache_point,
        gated_tools,
        steps_finished: steps_finished.clone(),
        deferrable: collected.deferrable,
        subagents,
        tool_change_protocol,
        include_conversation,
        memory_blocks,
        // Shared by every `warn_on_trailing_assistant` call in this invocation, and
        // set once it has reported. A 100-step turn checks the array at each step, so
        // without it one bad turn would emit a hundred identical events.
        guard: Arc::new(AtomicBool::new(false)),
    };
    let model_request = inputs.build(deferred_tool_protocol).await?;

    // Call generate_text and yield steps as they complete.
    let channel: Arc<AsyncChannel<InvokeStep>> = Arc::new(AsyncChannel::new());
    let turn = Arc::new(Turn {
        inputs,
        provider,
        model,
        cache_request,
        channel: channel.clone(),
        ending: out.ending.clone(),
        computer_use: computer_use.clone(),
        model_request: Mutex::new(model_request),
        injections: Mutex::new(Vec::new()),
        pending_attachment_injections,
        pending_file_writes,
        last_snapshot: Mutex::new(None),
        last_measured_tokens: Mutex::new(None),
        steps_finished,
        retried_in_full: AtomicBool::new(false),
        refused_deferral: AtomicBool::new(false),
        was_canceled: AtomicBool::new(false),
    });
    // The turn's model calls are spent where the stream is read.
    tokio::spawn(carried(turn.clone().run()));

    // Yield steps as they arrive. Errors from generation surface as a final friendly
    // step (with optional structured `error` metadata) via `build_error_step`.
    while let Some(step) = channel.next().await {
        out.step(step?).await;
    }

    // A user-aborted turn is reported as a distinct event (not "completed") so
    // cancellations are measurable. `invoke_stream` is the single convergence point
    // for every cancel path (WS cancel message + HTTP disconnect), so it owns this
    // event; callers do not emit their own.
    let was_canceled = turn.was_canceled.load(Ordering::SeqCst);
    let request = turn.request();
    let mut entries: Vec<(&str, String)> = vec![
        ("agent.id", agent_id),
        ("invoke.mode", request.mode.as_str().to_string()),
        (
            "invocation.duration_ms",
            (now_ms() - start_time).to_string(),
        ),
        ("llm.model", model_id),
        (
            "llm.model_mode",
            context.model_selection.mode.as_str().to_string(),
        ),
    ];
    // A stop during routing reads as a fallback, so a canceled turn reports no reason.
    if !was_canceled {
        entries.push(("llm.tier_reason", turn_model.reason.as_str().to_string()));
    }
    if let Some(tier) = turn_model.tier {
        entries.push(("llm.tier", tier.as_str().to_string()));
    }
    entries.push((
        "tools.deferred",
        turn.model_request.lock().deferred_count.to_string(),
    ));
    track_event(
        if was_canceled {
            "invocation canceled"
        } else {
            "invocation completed"
        },
        Some(&request.user_id),
        Some(props(&entries)),
    );
    Ok(())
}

/// Telemetry props in the order given.
fn props(entries: &[(&str, String)]) -> IndexMap<String, String> {
    entries
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

/// The tool calls of a step as the record stores them: the model-facing view of
/// each result, a gate refusal's summary, or an empty output for a failed call.
fn step_tool_calls(step: &StepResult) -> Vec<ToolCallRecord> {
    let tool_results = step.tool_results();
    step.tool_calls()
        .into_iter()
        .map(|call| {
            let result = tool_results
                .iter()
                .find(|result| result.tool_call_id == call.tool_call_id);
            let risk_error = step.content.iter().find_map(|part| match part {
                ContentPart::ToolError(error) if error.tool_call_id == call.tool_call_id => {
                    match &error.error {
                        ToolErrorValue::Error(shared) => shared
                            .chain()
                            .find_map(|cause| cause.downcast_ref::<ToolRiskGateError>())
                            .cloned(),
                        _ => None,
                    }
                }
                _ => None,
            });
            // An oversized result was already rendered and saved at execute time;
            // reuse that, so the id the model was given is the id on the record.
            let rendered =
                result.map(
                    |result| match SpilledToolOutput::from_value(&result.output) {
                        Some(spilled) => crate::lib::tool_output_limiter::RenderedToolResult {
                            text: spilled.text,
                            truncation: Some(spilled.truncation),
                        },
                        None => render_tool_result_detailed(
                            &result.output,
                            &RenderToolResultOptions {
                                tool_name: Some(call.tool_name.clone()),
                                ..Default::default()
                            },
                        ),
                    },
                );
            let output = match (&rendered, &risk_error) {
                (Some(rendered), _) => rendered.text.clone(),
                // A gate refusal has no tool result to render: the summary of *why*
                // is what the record holds, and it is already small.
                (None, Some(risk_error)) => js_stringify(&json!({
                    "error": risk_error.to_string(),
                    "code": risk_error.code.as_str(),
                    "risk": risk_error.risk,
                    "category": risk_error.category,
                })),
                (None, None) => String::new(),
            };
            ToolCallRecord {
                tool: call.tool_name.clone(),
                input: js_stringify(&call.input),
                output,
                success: result.is_some(),
                timestamp: now_iso(),
                // Only where a render produced the string. On a gate refusal the
                // output is a hand-built summary and on a failed call it is empty, and
                // neither is a model-facing view.
                rendered: rendered.is_some(),
                truncated: rendered.and_then(|rendered| rendered.truncation),
            }
        })
        .collect()
}

/// The spend context of an `invoke()` run: its own request, started by its mode. A
/// subagent runs inside its parent's request.
fn spend_context_for(request: &InvokeRequest) -> SpendContext {
    let parent = current_spend_context();
    let Some(kind) = SpendSourceKind::of_mode(request.mode) else {
        return parent.unwrap_or_else(|| SpendContext {
            request_id: uuid::Uuid::new_v4().to_string(),
            thread_id: request.thread_id.clone(),
            source: None,
        });
    };
    SpendContext {
        request_id: request
            .request_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        thread_id: request.thread_id.clone(),
        source: Some(SpendSource {
            kind,
            id: request.source_id.clone(),
        }),
    }
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

    // A run's calls are its own request, so an autonomous run started from inside a
    // chat turn is not spent on that turn's message.
    let spend = spend_context_for(&request);
    with_spend_context(spend, async {
        let mut stream = invoke_stream(request);
        while let Some(step) = stream.next().await {
            let step = step?;
            if let Some(error) = &step.error {
                error_meta = Some(error.clone());
            }
            steps.push(step);
        }
        anyhow::Ok(())
    })
    .await?;

    let all_tool_calls: Vec<_> = steps
        .iter()
        .flat_map(|s| s.tool_calls.iter().cloned())
        .collect();
    let response = join_step_texts(&steps);
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
#[derive(Debug, Clone)]
pub struct TrailingAssistantContext {
    pub agent_id: String,
    pub user_id: String,
    pub mode: String,
    pub stage: InvokeStage,
    pub guard: Arc<AtomicBool>,
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
/// Emits the telemetry event at most once per invocation (via the shared
/// `guard`), so a multi-step turn cannot report the same condition up to
/// `STEP_LIMIT` times. The log line is per call, which is bounded in practice: a
/// request the provider rejects never reaches a second step.
pub fn warn_on_trailing_assistant(messages: &[ModelMessage], context: &TrailingAssistantContext) {
    if !matches!(messages.last(), Some(ModelMessage::Assistant(_))) {
        return;
    }

    log_warn!(
        "LLM request ends on an assistant turn: {} message(s) (mode={}, stage={}) — the provider will reject this as assistant prefill",
        messages.len(),
        context.mode,
        context.stage.as_str()
    );

    if !context.guard.swap(true, Ordering::SeqCst) {
        track_event(
            "invocation trailing assistant",
            Some(&context.user_id),
            Some(props(&[
                ("agent.id", context.agent_id.clone()),
                ("invoke.mode", context.mode.clone()),
                ("invoke.stage", context.stage.as_str().to_string()),
                ("messages.count", messages.len().to_string()),
            ])),
        );
    }
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
/// Every result goes through the limiter, because this text is interpolated into a
/// prompt (the early-stopping summary). Stringifying an oversized result would
/// serialize the envelope and the untouched original inside it: the whole payload
/// the cut just removed, in a prompt.
fn summarize_steps(steps: &[Arc<StepResult>]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for step in steps {
        for call in step.tool_calls() {
            parts.push(format!(
                "[Tool: {}] Input: {}",
                call.tool_name,
                js_stringify(&call.input)
            ));
        }
        for result in step.tool_results() {
            let output = match SpilledToolOutput::from_value(&result.output) {
                Some(spilled) => spilled.text,
                None => render_tool_result(&result.output, &RenderToolResultOptions::default()),
            };
            parts.push(format!("[Result] {output}"));
        }
        let text = step.text();
        if !text.is_empty() {
            parts.push(text);
        }
    }
    let joined = parts.join("\n\n");
    if joined.is_empty() {
        "(no output)".to_string()
    } else {
        joined
    }
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

#[cfg(test)]
mod tests;
