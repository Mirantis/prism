//! `prism-server eval`: what the prompt eval set (`evals/`) asks of the backend, over
//! JSON lines on stdin and stdout.
//!
//! The runner writes `{ "id", "op", "params" }` and reads `{ "id", "result", "usage" }`
//! or `{ "id", "error", "usage" }`, where `usage` holds the tokens of the model calls the
//! operation made. Requests run concurrently. A turn's tool call goes to the runner as
//! `{ "toolCall": { "id", "call", "tool", "input" } }` and is answered with
//! `{ "toolResult": { "call", "output" } }` or `{ "toolResult": { "call", "error" } }`,
//! since the scenarios hold what each tool returns. Logs go to stderr.
//!
//! Each operation builds its request with the backend's own context, prompt builders,
//! tools and gates, against the database `DATABASE_URL` names and the configured model.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::Context as _;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::ai::{
    FinishReason, GenerateTextOptions, Instructions, ModelMessage, SystemModelMessage, Tool,
    ToolChoice, ToolSet, dynamic_tool, execute_fn, generate_text, json_schema, step_count_is,
};
use crate::config::{CONFIG, ModelSelectionMode};
use crate::constants::MAX_OUTPUT_TOKENS;
use crate::lib::classification::get_gate_request;
use crate::lib::llm_providers::create_provider::create_provider;
use crate::lib::llm_providers::llm_provider::{cache_request_options, cache_ttl_for};
use crate::lib::model_call::{ModelCallMeta, call_model};
use crate::lib::model_routing::{RoutedRequest, TurnModelReason, select_turn_model};
use crate::lib::model_selection::{ModelSelection, ModelTier, ModelTiers};
use crate::lib::task_tool::{Invoker, Subagent};
use crate::lib::tool_collection::{
    CollectToolsInput, collect_tools, filter_tools_by_mode, with_tools_cache_control,
};
use crate::lib::tool_output_limiter::{ToolOutputCaptureOptions, with_tool_output_capture};
use crate::lib::tool_risk_gate::{ToolRiskEvaluationInput, evaluate_tool_risk};
use crate::lib::tool_search::plan::{
    PlanToolSearchInput, ToolSearchPrompt, ToolSearchTelemetry, plan_tool_search,
};
use crate::lib::workspace_docs::{DocumentWriteActor, DocumentWriteMethod, WorkspaceDocField};
use crate::prompts::agent_message_prompt::render_agent_message;
use crate::prompts::compaction_prompt::COMPACTION_PROMPT;
use crate::prompts::computer_prompt::COMPUTER_INSTRUCTIONS;
use crate::prompts::context_builder::{
    ConversationMessage, PromptMode, build_conversation_history, build_system_prompt_parts,
};
use crate::prompts::scheduled_run_prompt::scheduled_run_prompt;
use crate::prompts::task_notification_prompt::{
    CodingTaskOutcome, render_coding_task_notification,
};
use crate::services::agent_workspace_service::{
    AGENT_WORKSPACE_SERVICE, CreateAgentInput, WriteWorkspaceDocInput, resolve_effective_model,
};
use crate::services::channel_adapter_interface::{ChannelName, ChatPlatform, LinkedTarget};
use crate::services::context_service::{AgentContextOptions, CONTEXT_SERVICE};
use crate::services::delivery_target_service::{DeliveryTarget, PostingCeiling, ceiling_of};
use crate::services::heartbeat_service::{HEARTBEAT_PROMPT, HEARTBEAT_SERVICE};
use crate::services::llm_call_service::{CountedUsage, LlmCallPurpose, counting_usage};
use crate::services::thread_reply_classifier_service::{
    ClassifyInput, GateAgent, ThreadAction, ThreadLine, ThreadPlatform, decide_thread_action,
};
use crate::services::web_chat_label::WEB_CHAT_LABEL;
use crate::services::webhook_service::render_webhook_turn_prompt;
use crate::support::js::len16;
use crate::templates::default_workspace::get_default_workspace_files;
use crate::tools::ask_questions::ask_questions_result;
use crate::tools::computer::{ALERT_THE_USER, get_computer_tools};
use crate::tools::meeting::{MeetingToolsInput, get_meeting_tools};
use crate::tools::shell::coding_agent::NOTIFIED_TASK_NEXT;
use crate::tools::shell::monitor::MONITOR_NEXT;
use crate::types::{
    AgentContext, AgentMessageOrigin, HeartbeatTrigger, InvokeMode, InvokeRequest, PromptSource,
    TaskLastSend,
};
use crate::utils::slack_formatter::slack_channel_label;
use crate::utils::teams_formatter::teams_channel_label;

const EVAL_USER_ID: &str = "eval-user";
/// A second agent with one subagent, so only the scenarios that ask for it get the Task tool.
const PARENT_AGENT_ID: &str = "0e7a1000-0000-4000-8000-000000000002";
const SUBAGENT_ID: &str = "0e7a1000-0000-4000-8000-000000000003";
const SUBAGENT_NAME: &str = "investigator";

/// The agent every scenario runs as: the one `AGENT_ID` names.
fn eval_agent_id() -> anyhow::Result<String> {
    CONFIG
        .agent_id()
        .filter(|id| !id.is_empty())
        .context("AGENT_ID is not set")
}

/// Lines to stdout, and the tool calls waiting for the runner's answer.
struct Channel {
    out: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_call: AtomicU64,
}

impl Channel {
    /// Ask the runner what a tool call returns.
    async fn tool_call(&self, request: u64, tool: &str, input: Value) -> anyhow::Result<Value> {
        let call = self.next_call.fetch_add(1, Ordering::SeqCst);
        let (answer, answered) = oneshot::channel();
        self.pending.lock().insert(call, answer);
        let _ = self.out.send(json!({
            "toolCall": { "id": request, "call": call, "tool": tool, "input": input },
        }));
        match answered.await {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(message)) => Err(anyhow::anyhow!(message)),
            Err(_) => anyhow::bail!("the eval runner went away"),
        }
    }

    fn answer(&self, result: &Value) {
        let Some(call) = result["call"].as_u64() else {
            return;
        };
        let Some(answer) = self.pending.lock().remove(&call) else {
            return;
        };
        let _ = answer.send(match result.get("error") {
            Some(error) => Err(error.as_str().unwrap_or("the tool failed").to_string()),
            None => Ok(result.get("output").cloned().unwrap_or(Value::Null)),
        });
    }
}

/// Read requests until stdin closes; answer each as it finishes.
pub async fn main() -> i32 {
    crate::logger::write_to_stderr();
    if let Err(err) = crate::db::run_sync(|conn| crate::db::migrate(conn).map(|_| ())) {
        eprintln!("[eval] could not migrate the database: {err:#}");
        return 1;
    }

    let (out, mut lines_out) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = lines_out.recv().await {
            let mut text = line.to_string();
            text.push('\n');
            if stdout.write_all(text.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                return;
            }
        }
    });
    let channel = Arc::new(Channel {
        out: out.clone(),
        pending: Mutex::new(HashMap::new()),
        next_call: AtomicU64::new(1),
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut running = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            eprintln!("[eval] not JSON: {line}");
            continue;
        };
        if let Some(result) = message.get("toolResult") {
            channel.answer(result);
            continue;
        }
        let channel = channel.clone();
        let out = out.clone();
        running.push(tokio::spawn(async move {
            let id = message["id"].as_u64().unwrap_or(0);
            let op = message["op"].as_str().unwrap_or_default().to_string();
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let (outcome, usage) = counting_usage(run(&op, params, id, &channel)).await;
            let usage = add(usage, outcome.as_ref().ok().and_then(|o| o.usage));
            let reply = match outcome {
                Ok(done) => json!({ "id": id, "result": done.result, "usage": usage }),
                Err(err) => json!({ "id": id, "error": format!("{err:#}"), "usage": usage }),
            };
            let _ = out.send(reply);
        }));
    }
    for task in running {
        let _ = task.await;
    }
    drop(out);
    drop(channel);
    let _ = writer.await;
    0
}

/// What an operation answers, with the usage of a model call it made outside
/// `call_model`, which records no row.
struct Done {
    result: Value,
    usage: Option<CountedUsage>,
}

impl From<Value> for Done {
    fn from(result: Value) -> Self {
        Done {
            result,
            usage: None,
        }
    }
}

fn add(a: CountedUsage, b: Option<CountedUsage>) -> CountedUsage {
    let b = b.unwrap_or_default();
    CountedUsage {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> anyhow::Result<T> {
    serde_json::from_value(params).context("unreadable params")
}

async fn run(op: &str, params: Value, id: u64, channel: &Arc<Channel>) -> anyhow::Result<Done> {
    match op {
        "info" => Ok(info().into()),
        "setup" => setup().await.map(Done::from),
        "render" => render(parse(params)?).map(Done::from),
        "ceiling" => {
            let input: CeilingParams = parse(params)?;
            Ok(serde_json::to_value(ceiling_of(&input.target, input.linked))?.into())
        }
        "turn" => turn(parse(params)?, id, channel).await.map(Done::from),
        "riskGate" => risk_gate(parse(params)?).await.map(Done::from),
        "summarize" => summarize(parse(params)?).await.map(Done::from),
        "threadGate" => thread_gate(parse(params)?).await.map(Done::from),
        "route" => route(parse(params)?).await.map(Done::from),
        "judge" => judge(parse(params)?).await,
        "promptSize" => prompt_size().await.map(Done::from),
        other => anyhow::bail!("unknown op {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// The run's identity, the agents and the texts the scenarios quote
// ---------------------------------------------------------------------------

fn info() -> Value {
    json!({
        "provider": CONFIG.llm_provider.as_str(),
        "chatModel": resolve_effective_model(None),
        "classificationModel": CONFIG.classification_model_id,
        "texts": {
            "heartbeatPrompt": HEARTBEAT_PROMPT,
            "alertTheUser": ALERT_THE_USER,
            "defaultHeartbeatMd": get_default_workspace_files().heartbeat_md,
            "askQuestionsResult": ask_questions_result(),
            "notifiedTaskNext": NOTIFIED_TASK_NEXT,
            "monitorNext": MONITOR_NEXT,
        },
    })
}

/// Create the agents the scenarios run as: default templates, onboarding finished.
async fn setup() -> anyhow::Result<Value> {
    let eval_agent = eval_agent_id()?;
    let agent = |id: &str, name: &str, agent_type| CreateAgentInput {
        id: id.to_string(),
        user_id: EVAL_USER_ID.to_string(),
        name: name.to_string(),
        agent_type,
        team_name: "Platform".to_string(),
        documents: None,
    };
    use crate::db::models::AgentType;
    AGENT_WORKSPACE_SERVICE
        .create_agent(agent(&eval_agent, "Atlas", AgentType::Agent))
        .await?;
    AGENT_WORKSPACE_SERVICE
        .create_agent(agent(PARENT_AGENT_ID, "Atlas", AgentType::Agent))
        .await?;
    AGENT_WORKSPACE_SERVICE
        .create_agent(agent(SUBAGENT_ID, SUBAGENT_NAME, AgentType::Subagent))
        .await?;
    AGENT_WORKSPACE_SERVICE
        .add_subagent(
            PARENT_AGENT_ID,
            SUBAGENT_ID,
            Some("Investigates production incidents from logs, metrics and recent deploys."),
        )
        .await?;
    // A new agent starts in its onboarding script; the scenarios are about an agent in use.
    AGENT_WORKSPACE_SERVICE
        .write_workspace_doc(WriteWorkspaceDocInput {
            agent_id: eval_agent,
            field: WorkspaceDocField::BootstrapMd,
            content: String::new(),
            actor: DocumentWriteActor::Agent,
            method: DocumentWriteMethod::Clear,
            reason: "Onboarding finished.".to_string(),
        })
        .await?;
    Ok(json!({ "subagentName": SUBAGENT_NAME }))
}

/// A coding task's outcome, as the scenarios name it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalCodingTaskOutcome {
    task_id: String,
    agent: String,
    stop_reason: String,
    turns: Option<u64>,
    session_id: Option<String>,
    result: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RenderParams {
    /// A scheduled task's run prompt.
    ScheduledRun {
        instruction: String,
        #[serde(rename = "lastSend")]
        last_send: Option<TaskLastSend>,
    },
    /// Another agent's message as the model reads it.
    AgentMessage {
        origin: AgentMessageOrigin,
        text: String,
    },
    /// The runtime's report that a coding task ended, as the engine stores it.
    CodingTaskNotification { outcome: EvalCodingTaskOutcome },
    /// A heartbeat's run prompt, with the channel messages that started it.
    Heartbeat {
        triggers: Option<Vec<HeartbeatTrigger>>,
    },
    /// A webhook event's run prompt.
    Webhook {
        instruction: String,
        payload: Map<String, Value>,
        #[serde(rename = "eventType")]
        event_type: String,
        route: String,
    },
}

fn render(params: RenderParams) -> anyhow::Result<Value> {
    let text = match params {
        RenderParams::ScheduledRun {
            instruction,
            last_send,
        } => scheduled_run_prompt(&instruction, last_send.as_ref()),
        RenderParams::AgentMessage { origin, text } => render_agent_message(&origin, &text),
        RenderParams::CodingTaskNotification { outcome } => {
            render_coding_task_notification(&CodingTaskOutcome {
                task_id: outcome.task_id,
                agent: outcome.agent,
                stop_reason: outcome.stop_reason,
                turns: outcome.turns,
                session_id: outcome.session_id,
                result: outcome.result,
            })
        }
        RenderParams::Heartbeat { triggers: Some(t) } => {
            HEARTBEAT_SERVICE.build_triggered_heartbeat_prompt(&t)
        }
        RenderParams::Heartbeat { triggers: None } => HEARTBEAT_SERVICE.build_heartbeat_prompt(),
        RenderParams::Webhook {
            instruction,
            payload,
            event_type,
            route,
        } => render_webhook_turn_prompt(Some(&instruction), &payload, &event_type, &route),
    };
    Ok(Value::String(text))
}

#[derive(Deserialize)]
struct CeilingParams {
    target: DeliveryTarget,
    linked: Vec<LinkedTarget>,
}

// ---------------------------------------------------------------------------
// A turn of the agent
// ---------------------------------------------------------------------------

/// The agent's context as a turn reads it, with `history` as its thread.
async fn agent_context(history: Vec<ConversationMessage>) -> anyhow::Result<AgentContext> {
    let mut context = CONTEXT_SERVICE
        .get_agent_context(
            EVAL_USER_ID,
            AgentContextOptions {
                agent_id: eval_agent_id()?,
                thread_id: None,
                include_conversation: Some(false),
                verbose: None,
            },
        )
        .await?;
    context.recent_messages = history;
    Ok(context)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelParam {
    name: String,
    platform: ChatPlatform,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtraTool {
    name: String,
    description: Option<String>,
    input_schema: Value,
}

/// Fields a run's service sets on the agent's context.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextOverrides {
    heartbeat_md: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnParams {
    mode: InvokeMode,
    #[serde(default)]
    history: Vec<ConversationMessage>,
    #[serde(default)]
    prompt: String,
    channel: Option<ChannelParam>,
    #[serde(default)]
    web_chat: bool,
    #[serde(default)]
    with_subagent: bool,
    max_steps: Option<usize>,
    #[serde(default)]
    computer: bool,
    #[serde(default)]
    extra_tools: Vec<ExtraTool>,
    last_send: Option<TaskLastSend>,
    #[serde(default)]
    context: ContextOverrides,
    posting_ceiling: Option<PostingCeiling>,
    heartbeat_triggers: Option<Vec<HeartbeatTrigger>>,
    /// A turn bound to a stored conversation, for the tools only such a turn gets.
    thread_id: Option<String>,
}

fn purpose_of(mode: InvokeMode) -> anyhow::Result<LlmCallPurpose> {
    serde_json::from_value(json!(mode.as_str())).context("no call purpose for the mode")
}

/// Run one turn the way `invoke_stream` builds it: the agent's context, the mode's
/// tools, and the system prompt and messages from `build_turn_request`. Every tool's
/// execution is the runner's.
async fn turn(
    params: TurnParams,
    request_id: u64,
    channel: &Arc<Channel>,
) -> anyhow::Result<Value> {
    let eval_agent = eval_agent_id()?;
    let mut context = agent_context(params.history).await?;
    context.last_send = params.last_send.clone();
    context.posting_ceiling = params.posting_ceiling.clone();
    if let Some(heartbeat_md) = params.context.heartbeat_md {
        context.heartbeat_md = heartbeat_md;
    }
    let agent_id = if params.with_subagent {
        PARENT_AGENT_ID.to_string()
    } else {
        eval_agent
    };
    let mode = params.mode;
    let model_id = resolve_effective_model(context.model.as_deref());
    let provider = create_provider();
    let ttl = cache_ttl_for(mode.as_str());
    let cache_point = provider.cache_point(&model_id, Some(ttl));

    let task_invoker: Invoker =
        Arc::new(|_| Box::pin(async { anyhow::bail!("The eval stubs the Task tool.") }));
    let collected = collect_tools(CollectToolsInput {
        computer_use: None,
        user_id: EVAL_USER_ID.to_string(),
        agent_id: agent_id.clone(),
        thread_id: params.thread_id.clone(),
        mode: mode.as_str().to_string(),
        origin_channel: Some(match params.channel.as_ref().map(|c| c.platform) {
            Some(ChatPlatform::Slack) => ChannelName::Slack,
            Some(ChatPlatform::Teams) => ChannelName::Teams,
            None => ChannelName::Websocket,
        }),
        origin_channel_id: None,
        posting_ceiling: params.posting_ceiling.clone(),
        workspace_root: None,
        task_invoker,
        register_attachment_injection: None,
        pending_file_writes: None,
        locked_in: context.locked_in,
    })
    .await?;
    let subagents: Vec<Subagent> = collected
        .subagents
        .iter()
        .map(|s| Subagent {
            name: s.name.clone(),
            description: s.description.clone(),
        })
        .collect();
    let plan = plan_tool_search(PlanToolSearchInput {
        tools: collected.tools,
        deferrable: collected.deferrable,
        protocol: provider.deferred_tools(&model_id),
        model_id: model_id.clone(),
        telemetry: ToolSearchTelemetry {
            user_id: EVAL_USER_ID.to_string(),
            agent_id: agent_id.clone(),
            mode: mode.as_str().to_string(),
        },
    })
    .await;

    let channel_label = match (&params.channel, params.web_chat) {
        (Some(c), _) => Some(match c.platform {
            ChatPlatform::Slack => slack_channel_label(&c.name),
            ChatPlatform::Teams => teams_channel_label(&c.name),
        }),
        (None, true) => Some(WEB_CHAT_LABEL.to_string()),
        (None, false) => None,
    };
    let request = InvokeRequest {
        user_id: EVAL_USER_ID.to_string(),
        agent_id: agent_id.clone(),
        mode,
        prompt: params.prompt,
        heartbeat_triggers: params.heartbeat_triggers,
        channel_label,
        ..Default::default()
    };
    let tool_search = ToolSearchPrompt {
        catalog: plan.catalog.clone(),
        replay_tool_call: plan.replay_tool_call.clone(),
    };
    let turn =
        crate::invoke::build_turn_request(&context, &request, &subagents, None, Some(&tool_search))
            .await?;
    let mut parts = turn.system_parts;
    if params.computer && !parts.iter().any(|p| p.text.contains(COMPUTER_INSTRUCTIONS)) {
        parts.insert(
            0,
            crate::prompts::context_builder::SystemPromptPart {
                text: COMPUTER_INSTRUCTIONS.to_string(),
                cacheable: false,
            },
        );
    }
    let system: Vec<SystemModelMessage> = parts
        .iter()
        .map(|part| SystemModelMessage {
            content: part.text.clone(),
            provider_options: part.cacheable.then(|| cache_point.to_provider_options()),
        })
        .collect();

    let mut tools = plan.tools.clone();
    if params.computer {
        tools.extend(get_computer_tools(None, None, Some(mode.as_str())));
    }
    for extra in params.extra_tools {
        tools.insert(
            extra.name,
            dynamic_tool(Tool {
                description: extra.description,
                input_schema: json_schema(extra.input_schema),
                ..Default::default()
            }),
        );
    }
    let stubbed = stub_tools(tools, request_id, channel.clone());
    let deferred: HashSet<String> = plan.deferred.iter().cloned().collect();
    let tools = with_tools_cache_control(
        with_tool_output_capture(stubbed, ToolOutputCaptureOptions::default()),
        cache_point,
        &deferred,
    );

    let mut options = GenerateTextOptions::new(provider.model(&model_id)?);
    options.system = Some(Instructions::Messages(system));
    options.messages = Some(turn.messages);
    options.tools = Some(tools);
    options.tool_choice = Some(ToolChoice::Auto);
    options.max_output_tokens = Some(MAX_OUTPUT_TOKENS);
    options.provider_options = Some(cache_request_options(&provider, &model_id, ttl, true));
    options.stop_when = Some(vec![step_count_is(params.max_steps.unwrap_or(1))]);
    let result = call_model(
        ModelCallMeta {
            purpose: purpose_of(mode)?,
            thread_id: None,
            agent_id: Some(agent_id),
        },
        options,
    )
    .await?;

    let calls: Vec<Value> = result
        .steps
        .iter()
        .enumerate()
        .flat_map(|(index, step)| {
            step.tool_calls()
                .into_iter()
                .map(move |call| {
                    json!({ "tool": call.tool_name, "input": call.input, "step": index + 1 })
                })
                .collect::<Vec<_>>()
        })
        .collect();
    Ok(json!({
        "calls": calls,
        "text": result.text().to_string(),
        "finished": result.finish_reason() != FinishReason::ToolCalls,
    }))
}

/// The tools block as it is, with each tool's execution asking the runner.
fn stub_tools(tools: ToolSet, request_id: u64, channel: Arc<Channel>) -> ToolSet {
    tools
        .into_iter()
        .map(|(name, tool)| {
            let channel = channel.clone();
            let tool_name = name.clone();
            let execute = execute_fn(move |input, _| {
                let channel = channel.clone();
                let tool_name = tool_name.clone();
                async move { channel.tool_call(request_id, &tool_name, input).await }
            });
            (
                name,
                Tool {
                    execute: Some(execute),
                    ..tool
                },
            )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The gates and the compaction
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RiskGateParams {
    mode: InvokeMode,
    prompt: String,
    #[serde(default)]
    prompt_source: Option<PromptSource>,
    /// The person's earlier messages in the thread, oldest first.
    #[serde(default)]
    earlier: Vec<String>,
    tool: String,
    input: Value,
}

/// The tool risk gate's decision on one call, with the tool's real description and
/// the agent's own guide as the policy.
async fn risk_gate(params: RiskGateParams) -> anyhow::Result<Value> {
    let eval_agent = eval_agent_id()?;
    let context = agent_context(Vec::new()).await?;
    let task_invoker: Invoker =
        Arc::new(|_| Box::pin(async { anyhow::bail!("The eval stubs the Task tool.") }));
    let collected = collect_tools(CollectToolsInput {
        computer_use: None,
        user_id: EVAL_USER_ID.to_string(),
        agent_id: eval_agent.clone(),
        thread_id: None,
        mode: params.mode.as_str().to_string(),
        origin_channel: None,
        origin_channel_id: None,
        posting_ceiling: None,
        workspace_root: None,
        task_invoker,
        register_attachment_injection: None,
        pending_file_writes: None,
        locked_in: context.locked_in,
    })
    .await?;
    let tool = collected.tools.get(&params.tool).with_context(|| {
        format!(
            "No tool named {} in {} mode.",
            params.tool,
            params.mode.as_str()
        )
    })?;
    let decision = evaluate_tool_risk(ToolRiskEvaluationInput {
        tool_name: params.tool.clone(),
        tool_description: tool.description.clone(),
        input: params.input,
        invocation_mode: params.mode.as_str().to_string(),
        initial_prompt: params.prompt.clone(),
        initial_prompt_source: params.prompt_source,
        messages: params
            .earlier
            .into_iter()
            .chain(std::iter::once(params.prompt))
            .map(ModelMessage::user)
            .collect(),
        agent_guide: Some(context.agent_md.clone()),
        user_id: EVAL_USER_ID.to_string(),
        agent_id: eval_agent,
        abort_signal: None,
    })
    .await?;
    Ok(serde_json::to_value(decision.decision)?)
}

#[derive(Deserialize)]
struct SummarizeParams {
    history: Vec<ConversationMessage>,
}

/// The summary a compaction of `history` writes: the chat system prompt and the
/// thread, then the compaction prompt. A summary cut off at the output budget is an
/// error, as the backend refuses one too.
async fn summarize(params: SummarizeParams) -> anyhow::Result<Value> {
    let context = agent_context(params.history).await?;
    let model_id = resolve_effective_model(context.model.as_deref());
    let system: Vec<SystemModelMessage> =
        build_system_prompt_parts(&context, PromptMode::Chat, None, None)
            .await?
            .into_iter()
            .map(|part| SystemModelMessage {
                content: part.text,
                provider_options: None,
            })
            .collect();
    let mut messages = build_conversation_history(&context, &[], None, false).messages;
    messages.push(ModelMessage::user(COMPACTION_PROMPT));
    let mut options = GenerateTextOptions::new(create_provider().model(&model_id)?);
    options.system = Some(Instructions::Messages(system));
    options.messages = Some(messages);
    options.max_output_tokens = Some(MAX_OUTPUT_TOKENS);
    let result = call_model(
        ModelCallMeta {
            purpose: LlmCallPurpose::Compaction,
            thread_id: None,
            agent_id: Some(eval_agent_id()?),
        },
        options,
    )
    .await?;
    if result.finish_reason() == FinishReason::Length {
        anyhow::bail!("The summary was cut off at the output limit.");
    }
    Ok(Value::String(result.text().to_string()))
}

#[derive(Deserialize)]
struct ThreadGateParams {
    platform: ChatPlatform,
    agent: GateAgent,
    lines: Vec<ThreadLine>,
}

/// The thread reply classifier's verdict on the last of `lines`.
async fn thread_gate(params: ThreadGateParams) -> anyhow::Result<Value> {
    let name = match params.platform {
        ChatPlatform::Slack => "Slack",
        ChatPlatform::Teams => "Microsoft Teams",
    };
    let action = decide_thread_action(&ClassifyInput {
        platform: ThreadPlatform {
            channel: params.platform,
            name: name.to_string(),
        },
        agent_id: eval_agent_id()?,
        agent: params.agent,
        lines: params.lines,
    })
    .await?;
    Ok(Value::String(
        match action {
            ThreadAction::Respond => "respond",
            ThreadAction::Ignore => "ignore",
        }
        .to_string(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteParams {
    request: String,
    #[serde(default)]
    history: Vec<ConversationMessage>,
    tiers: Option<Vec<ModelTier>>,
    mode: Option<InvokeMode>,
}

/// The tier Auto model selection picks for a request, offered `tiers`. A chat request
/// is the prompt; a scheduled one is wrapped as for a task without a thread; a
/// heartbeat's is its checks, which the classifier reads in place of the heartbeat
/// prompt. A classifier that gave no verdict is an error, since its fallback runs the
/// large tier and would pass a scenario that expects it.
async fn route(params: RouteParams) -> anyhow::Result<Value> {
    let mode = params.mode.unwrap_or(InvokeMode::Chat);
    let prompt = match mode {
        InvokeMode::Heartbeat => HEARTBEAT_PROMPT.to_string(),
        InvokeMode::Cron => scheduled_run_prompt(&params.request, None),
        _ => params.request.clone(),
    };
    let mut history = params.history;
    if mode == InvokeMode::Chat {
        history.push(serde_json::from_value(json!({
            "id": format!("eval-message-{}", history.len() + 1),
            "role": "USER",
            "content": prompt,
        }))?);
    }
    let mut context = agent_context(history).await?;
    if mode == InvokeMode::Heartbeat {
        context.heartbeat_md = params.request.clone();
    }
    let offered = params
        .tiers
        .unwrap_or_else(|| vec![ModelTier::Small, ModelTier::Large]);
    let tier = |tier: ModelTier, name: &str| {
        offered
            .contains(&tier)
            .then(|| format!("eval-{name}-model"))
    };
    context.model_selection = ModelSelection {
        mode: ModelSelectionMode::Auto,
        tiers: ModelTiers {
            small: tier(ModelTier::Small, "small"),
            medium: tier(ModelTier::Medium, "medium"),
            large: tier(ModelTier::Large, "large"),
        },
    };
    let choice = select_turn_model(
        &context,
        &RoutedRequest {
            mode: mode.as_str().to_string(),
            prompt,
            thread_id: None,
            agent_id: eval_agent_id()?,
            user_id: EVAL_USER_ID.to_string(),
            abort_signal: None,
        },
        &create_provider(),
    )
    .await?;
    match (choice.reason, choice.tier) {
        (TurnModelReason::Classified, Some(tier)) => Ok(serde_json::to_value(tier)?),
        (reason, _) => anyhow::bail!(
            "Routing did not classify the request ({}).",
            serde_json::to_value(reason)?
        ),
    }
}

#[derive(Deserialize)]
struct JudgeParams {
    rubric: String,
    reply: String,
}

/// Ask the classification model a yes-or-no question about a reply: the runner's grader.
/// The call is the eval's own, not backend spend, so it records no row, and its usage
/// is returned beside the answer.
async fn judge(params: JudgeParams) -> anyhow::Result<Done> {
    let gate = get_gate_request()?;
    let mut options = GenerateTextOptions::new(gate.model);
    options.provider_options = Some(gate.provider_options);
    options.temperature = gate.sampling_params.temperature;
    options.max_output_tokens = Some(16);
    options.system = Some(Instructions::Text(
        "You grade a reply that an AI agent gave its user. Answer with one word: YES or NO."
            .to_string(),
    ));
    // The question goes after the reply: asked in the system prompt instead, the
    // classification model answered NO to a reply that plainly said YES.
    options.messages = Some(vec![ModelMessage::user(format!(
        "<reply>\n{}\n</reply>\n\n{}",
        params.reply, params.rubric
    ))]);
    let result = generate_text(options).await?;
    Ok(Done {
        result: Value::String(result.text().to_string()),
        usage: Some(CountedUsage {
            input_tokens: result.usage().input_tokens.unwrap_or(0),
            output_tokens: result.usage().output_tokens.unwrap_or(0),
        }),
    })
}

// ---------------------------------------------------------------------------
// The size of the prompt
// ---------------------------------------------------------------------------

/// The characters of the chat system prompt without the identity documents, those of
/// the documents a new agent is seeded with, and those of the built-in tools'
/// descriptions (the tool's and its parameters'), the computer tools left out. In
/// UTF-16 units, as the TypeScript runtime counted them.
async fn prompt_size() -> anyhow::Result<Value> {
    let eval_agent = eval_agent_id()?;
    let context = agent_context(Vec::new()).await?;
    let mut bare = context.clone();
    for field in [
        &mut bare.soul_md,
        &mut bare.agent_md,
        &mut bare.user_md,
        &mut bare.memory_md,
        &mut bare.heartbeat_md,
        &mut bare.vision_md,
    ] {
        field.clear();
    }
    let chars = |parts: Vec<crate::prompts::context_builder::SystemPromptPart>| -> usize {
        parts.iter().map(|p| len16(&p.text)).sum()
    };
    let full = chars(build_system_prompt_parts(&context, PromptMode::Chat, None, None).await?);
    let product_text = chars(build_system_prompt_parts(&bare, PromptMode::Chat, None, None).await?);

    let task_invoker: Invoker = Arc::new(|_| Box::pin(async { anyhow::bail!("Not invoked.") }));
    let collected = collect_tools(CollectToolsInput {
        computer_use: None,
        user_id: EVAL_USER_ID.to_string(),
        agent_id: eval_agent.clone(),
        thread_id: None,
        mode: "chat".to_string(),
        origin_channel: None,
        origin_channel_id: None,
        posting_ceiling: None,
        workspace_root: None,
        task_invoker,
        register_attachment_injection: None,
        pending_file_writes: None,
        locked_in: false,
    })
    .await?;
    let meeting_tools = filter_tools_by_mode(
        get_meeting_tools(MeetingToolsInput {
            user_id: EVAL_USER_ID.to_string(),
            agent_id: eval_agent,
            ..Default::default()
        }),
        "chat",
    );
    let mut tool_descriptions = 0;
    for (name, tool) in collected.tools.iter().chain(meeting_tools.iter()) {
        if name.starts_with("computer_") {
            continue;
        }
        tool_descriptions += tool.description.as_deref().map(len16).unwrap_or(0)
            + schema_description_chars(tool.input_schema.json_schema());
    }
    Ok(json!({
        "productText": product_text,
        "seededTemplates": full - product_text,
        "toolDescriptions": tool_descriptions,
    }))
}

/// The characters of every `description` string in a JSON schema.
fn schema_description_chars(node: &Value) -> usize {
    match node {
        Value::Array(items) => items.iter().map(schema_description_chars).sum(),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| match value {
                Value::String(text) if key == "description" => len16(text),
                other => schema_description_chars(other),
            })
            .sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_every_description_in_a_schema() {
        let schema = json!({
            "type": "object",
            "description": "abc",
            "properties": {
                "a": { "type": "string", "description": "de" },
                "b": { "anyOf": [{ "description": "f" }, { "type": "number" }] },
            },
        });
        assert_eq!(schema_description_chars(&schema), 6);
    }

    #[test]
    fn renders_a_webhook_prompt_and_a_scheduled_run_prompt() {
        let webhook: RenderParams = serde_json::from_value(json!({
            "kind": "webhook",
            "instruction": "Report the deploy.",
            "payload": { "service": "api" },
            "eventType": "unknown",
            "route": "deploy-events",
        }))
        .unwrap();
        let rendered = render(webhook).unwrap();
        assert!(rendered.as_str().unwrap().contains("Report the deploy."));
        let scheduled: RenderParams =
            serde_json::from_value(json!({ "kind": "scheduledRun", "instruction": "Check CI." }))
                .unwrap();
        assert!(
            render(scheduled)
                .unwrap()
                .as_str()
                .unwrap()
                .contains("Check CI.")
        );
    }

    #[test]
    fn answers_a_tool_call_with_its_output_or_its_error() {
        let (out, _lines) = mpsc::unbounded_channel();
        let channel = Channel {
            out,
            pending: Mutex::new(HashMap::new()),
            next_call: AtomicU64::new(1),
        };
        let (ok, ok_answer) = oneshot::channel();
        let (failed, failed_answer) = oneshot::channel();
        channel.pending.lock().insert(1, ok);
        channel.pending.lock().insert(2, failed);
        channel.answer(&json!({ "call": 1, "output": { "sent": true } }));
        channel.answer(&json!({ "call": 2, "error": "refused" }));
        assert_eq!(
            ok_answer.blocking_recv().unwrap(),
            Ok(json!({ "sent": true }))
        );
        assert_eq!(
            failed_answer.blocking_recv().unwrap(),
            Err("refused".to_string())
        );
    }
}
