//! `generateText`: a model call, and the loop of steps that runs the tools the
//! model calls and calls the model again with their results.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures::FutureExt;
use futures::future::{BoxFuture, join_all};
use indexmap::IndexMap;
use rand::Rng;
use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::VERSION;
use super::errors::{
    AbortError, InvalidArgumentError, InvalidToolInputError, JsonParseError, NoSuchToolError,
    SharedError, ToolChoiceViolationError, ensure_log_fields_registered, get_error_message,
};
use super::json::{bytes_to_base64, secure_json_parse};
use super::messages::{
    AssistantContent, AssistantContentPart, AssistantModelMessage, CustomPart, FilePart,
    FilePartData, ModelMessage, ReasoningFilePart, ReasoningPart, TextPart, ToolCallPart,
    ToolContentPart, ToolModelMessage, ToolResultPart,
};
use super::model::LanguageModel;
use super::prompt::{
    Instructions, Prompt, StandardizedPrompt, convert_to_language_model_prompt, download,
    merge_objects, standardize_prompt,
};
pub use super::provider::FinishReason;
use super::provider::{
    DataContent, FileData, Headers, JsonObject, LanguageModelV4CallOptions, LanguageModelV4Content,
    LanguageModelV4Source, LanguageModelV4ToolChoice, ProviderMetadata, ProviderOptions,
    ReasoningEffort, ToolResultOutput, Warning,
};
use super::retry::prepare_retries;
use super::telemetry::{
    GenerateTextEndEvent, GenerateTextStartEvent, GenerateTextStepStartEvent,
    LanguageModelCallEndEvent, LanguageModelCallStartEvent, OperationEndEvent, OperationStartEvent,
    TelemetryDispatcher, TelemetryOptions, ToolExecutionEndEvent, ToolExecutionStartEvent,
};
use super::tool::{
    Schema, Tool, ToolChoice, ToolExecutionOptions, ToolSet, ToolType, filter_active_tools,
    prepare_tool_choice, prepare_tools, safe_validate_types,
};
use super::usage::LanguageModelUsage;
use super::warnings::log_warnings;

const ID_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// `createIdGenerator({ prefix, size })()`: `prefix-` and `size` random characters.
pub fn create_id(prefix: &str, size: usize) -> String {
    let mut rng = rand::rng();
    let body: String = (0..size)
        .map(|_| ID_ALPHABET[rng.random_range(0..ID_ALPHABET.len())] as char)
        .collect();
    format!("{prefix}-{body}")
}

/// `withUserAgentSuffix`: header names lowercased and sorted, with the suffix
/// appended to `user-agent`.
pub fn with_user_agent_suffix(headers: Option<&Headers>, suffix: &str) -> Headers {
    let mut sorted: BTreeMap<String, String> = headers
        .map(|h| {
            h.iter()
                .map(|(k, v)| (k.to_lowercase(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    let current = sorted.get("user-agent").cloned().unwrap_or_default();
    let agent = [current.as_str(), suffix]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    sorted.insert("user-agent".to_string(), agent);
    sorted.into_iter().collect()
}

/// Sampling and length settings of a call (`LanguageModelCallOptions`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CallSettings {
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub seed: Option<i64>,
    pub reasoning: Option<ReasoningEffort>,
}

impl CallSettings {
    /// `prepareLanguageModelCallOptions`: refuses a `max_output_tokens` below 1.
    pub fn validate(&self) -> Result<(), InvalidArgumentError> {
        if let Some(n) = self.max_output_tokens
            && n < 1
        {
            return Err(InvalidArgumentError::new(
                "maxOutputTokens",
                json!(n),
                "maxOutputTokens must be >= 1",
            ));
        }
        Ok(())
    }

    /// The settings on a provider call.
    pub fn apply_to(&self, options: &mut LanguageModelV4CallOptions) {
        options.max_output_tokens = self.max_output_tokens;
        options.temperature = self.temperature;
        options.top_p = self.top_p;
        options.top_k = self.top_k;
        options.presence_penalty = self.presence_penalty;
        options.frequency_penalty = self.frequency_penalty;
        options.stop_sequences = self.stop_sequences.clone();
        options.seed = self.seed;
        options.reasoning = self.reasoning;
    }
}

/// What the SDK keeps of a step's request and response bodies.
#[derive(Debug, Clone, Copy, Default)]
pub struct GenerateTextInclude {
    pub request_body: bool,
    pub request_messages: bool,
    pub response_body: bool,
}

/// A condition that ends the loop of steps.
pub type StopCondition = Arc<dyn Fn(&[Arc<StepResult>]) -> bool + Send + Sync>;

/// `isStepCount(n)` / `stepCountIs(n)`: stop after `n` steps.
pub fn step_count_is(step_count: usize) -> StopCondition {
    Arc::new(move |steps| steps.len() == step_count)
}

/// `hasToolCall(...names)`: stop after a step that called one of the tools.
pub fn has_tool_call(tool_names: Vec<String>) -> StopCondition {
    Arc::new(move |steps| {
        steps.last().is_some_and(|step| {
            step.tool_calls()
                .iter()
                .any(|call| tool_names.contains(&call.tool_name))
        })
    })
}

/// `isLoopFinished()`: never stops the loop.
pub fn is_loop_finished() -> StopCondition {
    Arc::new(|_| false)
}

/// What `prepare_step` receives.
#[derive(Clone)]
pub struct PrepareStepOptions {
    pub steps: Vec<Arc<StepResult>>,
    pub step_number: usize,
    pub model: Arc<dyn LanguageModel>,
    pub instructions: Option<Instructions>,
    pub initial_instructions: Option<Instructions>,
    /// The messages the step would send: the previous step's messages and its response.
    pub messages: Vec<ModelMessage>,
    pub initial_messages: Vec<ModelMessage>,
    /// Every message the model's responses have added so far.
    pub response_messages: Vec<ModelMessage>,
    pub tools_context: JsonObject,
    pub runtime_context: JsonObject,
}

/// What `prepare_step` may change for one step. A `None` keeps the call's value.
#[derive(Clone, Default)]
pub struct PrepareStepResult {
    pub model: Option<Arc<dyn LanguageModel>>,
    pub tool_choice: Option<ToolChoice>,
    pub active_tools: Option<Vec<String>>,
    pub tool_order: Option<Vec<String>>,
    pub instructions: Option<Instructions>,
    pub system: Option<Instructions>,
    /// The messages to send in place of `PrepareStepOptions::messages`; they are
    /// also the base of the next step's messages.
    pub messages: Option<Vec<ModelMessage>>,
    pub tools_context: Option<JsonObject>,
    pub runtime_context: Option<JsonObject>,
    pub provider_options: Option<ProviderOptions>,
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub seed: Option<i64>,
    pub reasoning: Option<ReasoningEffort>,
}

/// `prepareStep`.
pub type PrepareStepFunction = Arc<
    dyn Fn(PrepareStepOptions) -> BoxFuture<'static, anyhow::Result<Option<PrepareStepResult>>>
        + Send
        + Sync,
>;

/// `onStepFinish`: called when a step ends. It cannot fail the call.
pub type OnStepFinishFunction =
    Arc<dyn Fn(Arc<StepResult>) -> BoxFuture<'static, ()> + Send + Sync>;

/// The options of `generate_text`.
#[derive(Clone)]
pub struct GenerateTextOptions {
    pub model: Arc<dyn LanguageModel>,
    pub tools: Option<ToolSet>,
    pub tool_choice: Option<ToolChoice>,
    /// The system instructions (`system` / `instructions`).
    pub system: Option<Instructions>,
    pub prompt: Option<Prompt>,
    pub messages: Option<Vec<ModelMessage>>,
    /// Whether `messages` may hold system messages.
    pub allow_system_in_messages: bool,
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub seed: Option<i64>,
    pub reasoning: Option<ReasoningEffort>,
    /// Retries of a failed provider call; 2 when `None`.
    pub max_retries: Option<i64>,
    pub abort_signal: Option<CancellationToken>,
    pub headers: Option<Headers>,
    /// When to stop the loop of steps; one step when `None`.
    pub stop_when: Option<Vec<StopCondition>>,
    pub telemetry: Option<TelemetryOptions>,
    pub provider_options: Option<ProviderOptions>,
    pub active_tools: Option<Vec<String>>,
    pub tool_order: Option<Vec<String>>,
    pub prepare_step: Option<PrepareStepFunction>,
    /// The call's context, for telemetry and `prepare_step`.
    pub runtime_context: JsonObject,
    /// Each tool's context by tool name, handed to its `execute`.
    pub tools_context: JsonObject,
    pub on_step_finish: Option<OnStepFinishFunction>,
    pub include: GenerateTextInclude,
}

impl GenerateTextOptions {
    /// Options with every setting at its default.
    pub fn new(model: Arc<dyn LanguageModel>) -> Self {
        Self {
            model,
            tools: None,
            tool_choice: None,
            system: None,
            prompt: None,
            messages: None,
            allow_system_in_messages: false,
            max_output_tokens: None,
            temperature: None,
            top_p: None,
            top_k: None,
            presence_penalty: None,
            frequency_penalty: None,
            stop_sequences: None,
            seed: None,
            reasoning: None,
            max_retries: None,
            abort_signal: None,
            headers: None,
            stop_when: None,
            telemetry: None,
            provider_options: None,
            active_tools: None,
            tool_order: None,
            prepare_step: None,
            runtime_context: JsonObject::new(),
            tools_context: JsonObject::new(),
            on_step_finish: None,
            include: GenerateTextInclude::default(),
        }
    }
}

/// The value a tool error carries: the error `execute` returned, the message of an
/// invalid call, or the JSON a provider-executed tool reported.
#[derive(Debug, Clone)]
pub enum ToolErrorValue {
    Error(SharedError),
    Message(String),
    Json(Value),
}

impl ToolErrorValue {
    /// `getErrorMessage(error)`.
    pub fn message(&self) -> String {
        match self {
            ToolErrorValue::Error(e) => get_error_message(e),
            ToolErrorValue::Message(m) => m.clone(),
            ToolErrorValue::Json(v) => super::errors::get_value_error_message(Some(v)),
        }
    }

    /// The error `execute` returned, as `T`.
    pub fn downcast_ref<T: std::error::Error + Send + Sync + 'static>(&self) -> Option<&T> {
        match self {
            ToolErrorValue::Error(e) => e.downcast_ref::<T>(),
            _ => None,
        }
    }

    /// `toJSONValue(error)`: an error object has no enumerable fields but the SDK's
    /// own name.
    fn to_json(&self) -> Value {
        match self {
            ToolErrorValue::Error(e) => {
                let name = super::errors::error_name(e);
                if name.starts_with("AI_") {
                    json!({ "name": name })
                } else {
                    json!({})
                }
            }
            ToolErrorValue::Message(m) => json!(m),
            ToolErrorValue::Json(v) => v.clone(),
        }
    }
}

impl Serialize for ToolErrorValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

fn serialize_shared_error<S: Serializer>(
    error: &Option<SharedError>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match error {
        Some(e) => ToolErrorValue::Error(e.clone()).serialize(serializer),
        None => serializer.serialize_none(),
    }
}

/// A tool call the model made, with its parsed input. An invalid call (unknown
/// tool, input that does not parse or match) has `invalid` and `error` set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedToolCall {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<ProviderMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_metadata: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_shared_error"
    )]
    pub error: Option<SharedError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A tool's result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedToolResult {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
    pub output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<ProviderMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_metadata: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preliminary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A tool call that failed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedToolError {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input: Value,
    pub error: ToolErrorValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_executed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<ProviderMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_metadata: Option<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A tool's outcome: a result or an error.
#[derive(Debug, Clone)]
pub enum ToolOutput {
    Result(TypedToolResult),
    Error(TypedToolError),
}

impl ToolOutput {
    pub fn tool_call_id(&self) -> &str {
        match self {
            ToolOutput::Result(r) => &r.tool_call_id,
            ToolOutput::Error(e) => &e.tool_call_id,
        }
    }

    fn into_content(self) -> ContentPart {
        match self {
            ToolOutput::Result(r) => ContentPart::ToolResult(r),
            ToolOutput::Error(e) => ContentPart::ToolError(e),
        }
    }
}

/// A file the model generated.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub base64: String,
    pub media_type: String,
}

impl GeneratedFile {
    /// The file's bytes.
    pub fn uint8_array(&self) -> Vec<u8> {
        super::json::base64_to_bytes(&self.base64).unwrap_or_default()
    }
}

/// One part of a step's content.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "custom")]
    Custom {
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "reasoning")]
    Reasoning {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "reasoning-file")]
    ReasoningFile {
        file: GeneratedFile,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "source")]
    Source(LanguageModelV4Source),
    #[serde(rename = "file")]
    File {
        file: GeneratedFile,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<ProviderMetadata>,
    },
    #[serde(rename = "tool-call")]
    ToolCall(TypedToolCall),
    #[serde(rename = "tool-result")]
    ToolResult(TypedToolResult),
    #[serde(rename = "tool-error")]
    ToolError(TypedToolError),
    #[serde(rename = "tool-approval-request")]
    ToolApprovalRequest {
        approval_id: String,
        tool_call: TypedToolCall,
    },
}

/// The model of a step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepModel {
    pub provider: String,
    pub model_id: String,
}

/// What the SDK keeps of a step's request.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelRequestMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<ModelMessage>>,
}

/// What the SDK keeps of a step's response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelResponseMetadata {
    pub id: String,
    #[serde(with = "crate::support::serde_iso")]
    pub timestamp: DateTime<Utc>,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<Headers>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
    /// The messages this step added: the assistant message and the tool results.
    pub messages: Vec<ModelMessage>,
}

/// A step's timing.
#[derive(Debug, Clone, Default)]
pub struct StepResultPerformance {
    pub effective_output_tokens_per_second: f64,
    pub output_tokens_per_second: Option<f64>,
    pub input_tokens_per_second: Option<f64>,
    pub effective_total_tokens_per_second: f64,
    pub step_time_ms: f64,
    pub response_time_ms: f64,
    pub tool_execution_ms: IndexMap<String, f64>,
    pub time_to_first_output_ms: Option<f64>,
}

fn tokens_per_second(tokens: Option<i64>, duration_ms: f64) -> f64 {
    let rate = (1000.0 * tokens.unwrap_or(0) as f64) / duration_ms;
    if rate.is_finite() { rate } else { 0.0 }
}

/// One step: one model call and the tools it ran.
#[derive(Debug, Clone)]
pub struct StepResult {
    pub call_id: String,
    pub step_number: usize,
    pub model: StepModel,
    pub tools_context: JsonObject,
    pub runtime_context: JsonObject,
    pub content: Vec<ContentPart>,
    pub finish_reason: FinishReason,
    pub raw_finish_reason: Option<String>,
    pub usage: LanguageModelUsage,
    pub performance: StepResultPerformance,
    pub warnings: Option<Vec<Warning>>,
    pub request: LanguageModelRequestMetadata,
    pub response: LanguageModelResponseMetadata,
    pub provider_metadata: Option<ProviderMetadata>,
}

impl StepResult {
    /// The text of the step: its text parts joined.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// The reasoning parts, as assistant message parts.
    pub fn reasoning(&self) -> Vec<AssistantContentPart> {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Reasoning {
                    text,
                    provider_metadata,
                } => Some(AssistantContentPart::Reasoning(ReasoningPart {
                    text: text.clone(),
                    provider_options: provider_metadata.clone(),
                })),
                ContentPart::ReasoningFile {
                    file,
                    provider_metadata,
                } => Some(AssistantContentPart::ReasoningFile(ReasoningFilePart {
                    data: FilePartData::Data(DataContent::Base64(file.base64.clone())),
                    media_type: file.media_type.clone(),
                    provider_options: provider_metadata.clone(),
                })),
                _ => None,
            })
            .collect()
    }

    /// The reasoning text, or `None` when there is none.
    pub fn reasoning_text(&self) -> Option<String> {
        let text: String = self
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Reasoning { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        if text.is_empty() { None } else { Some(text) }
    }

    pub fn files(&self) -> Vec<&GeneratedFile> {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::File { file, .. } => Some(file),
                _ => None,
            })
            .collect()
    }

    pub fn sources(&self) -> Vec<&LanguageModelV4Source> {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Source(source) => Some(source),
                _ => None,
            })
            .collect()
    }

    pub fn tool_calls(&self) -> Vec<&TypedToolCall> {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect()
    }

    pub fn static_tool_calls(&self) -> Vec<&TypedToolCall> {
        self.tool_calls()
            .into_iter()
            .filter(|c| c.dynamic != Some(true))
            .collect()
    }

    pub fn dynamic_tool_calls(&self) -> Vec<&TypedToolCall> {
        self.tool_calls()
            .into_iter()
            .filter(|c| c.dynamic == Some(true))
            .collect()
    }

    pub fn tool_results(&self) -> Vec<&TypedToolResult> {
        self.content
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolResult(result) => Some(result),
                _ => None,
            })
            .collect()
    }

    pub fn static_tool_results(&self) -> Vec<&TypedToolResult> {
        self.tool_results()
            .into_iter()
            .filter(|r| r.dynamic != Some(true))
            .collect()
    }

    pub fn dynamic_tool_results(&self) -> Vec<&TypedToolResult> {
        self.tool_results()
            .into_iter()
            .filter(|r| r.dynamic == Some(true))
            .collect()
    }

    /// `restrictStepResult`: the step with only the runtime context telemetry may see.
    fn restricted(&self, dispatcher: &TelemetryDispatcher) -> StepResult {
        StepResult {
            runtime_context: dispatcher.filter_context(&self.runtime_context),
            tools_context: JsonObject::new(),
            ..self.clone()
        }
    }
}

/// The result of `generate_text`.
#[derive(Debug, Clone)]
pub struct GenerateTextResult {
    /// Every step, in order. There is at least one.
    pub steps: Vec<Arc<StepResult>>,
    /// The usage summed over all steps.
    pub total_usage: LanguageModelUsage,
    initial_response_messages: Vec<ModelMessage>,
    output: Option<String>,
}

impl GenerateTextResult {
    pub fn final_step(&self) -> &StepResult {
        self.steps
            .last()
            .expect("a generation has at least one step")
    }

    /// The final step's text.
    pub fn text(&self) -> String {
        self.final_step().text()
    }

    /// The content of every step.
    pub fn content(&self) -> Vec<ContentPart> {
        self.steps
            .iter()
            .flat_map(|s| s.content.iter().cloned())
            .collect()
    }

    /// The usage summed over all steps (`usage` is `totalUsage`).
    pub fn usage(&self) -> &LanguageModelUsage {
        &self.total_usage
    }

    pub fn finish_reason(&self) -> FinishReason {
        self.final_step().finish_reason
    }

    pub fn raw_finish_reason(&self) -> Option<&str> {
        self.final_step().raw_finish_reason.as_deref()
    }

    pub fn reasoning_text(&self) -> Option<String> {
        self.final_step().reasoning_text()
    }

    pub fn tool_calls(&self) -> Vec<&TypedToolCall> {
        self.steps.iter().flat_map(|s| s.tool_calls()).collect()
    }

    pub fn tool_results(&self) -> Vec<&TypedToolResult> {
        self.steps.iter().flat_map(|s| s.tool_results()).collect()
    }

    pub fn files(&self) -> Vec<&GeneratedFile> {
        self.steps.iter().flat_map(|s| s.files()).collect()
    }

    pub fn sources(&self) -> Vec<&LanguageModelV4Source> {
        self.steps.iter().flat_map(|s| s.sources()).collect()
    }

    pub fn warnings(&self) -> Vec<Warning> {
        self.steps
            .iter()
            .flat_map(|s| s.warnings.clone().unwrap_or_default())
            .collect()
    }

    pub fn provider_metadata(&self) -> Option<&ProviderMetadata> {
        self.final_step().provider_metadata.as_ref()
    }

    /// The final step's response; its `messages` are that step's alone.
    pub fn response(&self) -> &LanguageModelResponseMetadata {
        &self.final_step().response
    }

    pub fn request(&self) -> &LanguageModelRequestMetadata {
        &self.final_step().request
    }

    /// Every message the generation added.
    pub fn response_messages(&self) -> Vec<ModelMessage> {
        let mut messages = self.initial_response_messages.clone();
        for step in &self.steps {
            messages.extend(step.response.messages.iter().cloned());
        }
        messages
    }

    /// The parsed text output; an error when the final step produced none.
    pub fn output(&self) -> anyhow::Result<&str> {
        self.output
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("No output generated."))
    }
}

async fn race_abort<T>(
    future: impl std::future::Future<Output = anyhow::Result<T>>,
    abort: Option<&CancellationToken>,
) -> anyhow::Result<T> {
    match abort {
        Some(token) => {
            if token.is_cancelled() {
                return Err(AbortError::operation().into());
            }
            tokio::select! {
                result = future => result,
                _ = token.cancelled() => Err(AbortError::operation().into()),
            }
        }
        None => future.await,
    }
}

/// `safeParseJSON({ text, schema })`.
fn safe_parse_json(text: &str, schema: Option<&Schema>) -> anyhow::Result<Value> {
    let value =
        secure_json_parse(text).map_err(|e| JsonParseError::new(text, anyhow::Error::new(e)))?;
    match schema {
        None => Ok(value),
        Some(schema) => safe_validate_types(&value, schema).map_err(anyhow::Error::new),
    }
}

struct RawToolCall<'a> {
    tool_call_id: &'a str,
    tool_name: &'a str,
    input: &'a str,
    provider_executed: Option<bool>,
    dynamic: Option<bool>,
    provider_metadata: &'a Option<ProviderMetadata>,
}

fn parse_provider_executed_dynamic(call: &RawToolCall<'_>) -> anyhow::Result<TypedToolCall> {
    let value = if call.input.trim().is_empty() {
        json!({})
    } else {
        safe_parse_json(call.input, None)
            .map_err(|e| InvalidToolInputError::new(call.tool_name, call.input, e))?
    };
    Ok(TypedToolCall {
        tool_call_id: call.tool_call_id.to_string(),
        tool_name: call.tool_name.to_string(),
        input: value,
        provider_executed: Some(true),
        provider_metadata: call.provider_metadata.clone(),
        tool_metadata: None,
        dynamic: Some(true),
        invalid: None,
        error: None,
        title: None,
    })
}

fn do_parse_tool_call(call: &RawToolCall<'_>, tools: &ToolSet) -> anyhow::Result<TypedToolCall> {
    let Some(tool) = tools.get(call.tool_name) else {
        if call.provider_executed == Some(true) && call.dynamic == Some(true) {
            return parse_provider_executed_dynamic(call);
        }
        return Err(
            NoSuchToolError::new(call.tool_name, Some(tools.keys().cloned().collect())).into(),
        );
    };
    let parsed = if call.input.trim().is_empty() {
        safe_validate_types(&json!({}), &tool.input_schema).map_err(anyhow::Error::new)
    } else {
        safe_parse_json(call.input, Some(&tool.input_schema))
    };
    let value = parsed.map_err(|e| InvalidToolInputError::new(call.tool_name, call.input, e))?;
    Ok(TypedToolCall {
        tool_call_id: call.tool_call_id.to_string(),
        tool_name: call.tool_name.to_string(),
        input: value,
        provider_executed: call.provider_executed,
        provider_metadata: call.provider_metadata.clone(),
        tool_metadata: tool.metadata.clone(),
        dynamic: if tool.is_dynamic() { Some(true) } else { None },
        invalid: None,
        error: None,
        title: tool.title.clone(),
    })
}

/// `parseToolCall`: the call with its input parsed and checked. A call that fails
/// either way comes back invalid, with the error, rather than failing the step.
fn parse_tool_call(
    call: &RawToolCall<'_>,
    tools: Option<&ToolSet>,
    abort: Option<&CancellationToken>,
) -> anyhow::Result<TypedToolCall> {
    let attempt = match tools {
        None => {
            if call.provider_executed == Some(true) && call.dynamic == Some(true) {
                parse_provider_executed_dynamic(call)
            } else {
                Err(NoSuchToolError::new(call.tool_name, None).into())
            }
        }
        Some(tools) => do_parse_tool_call(call, tools),
    };
    match attempt {
        Ok(parsed) => Ok(parsed),
        Err(error) => {
            if abort.is_some_and(|t| t.is_cancelled()) {
                return Err(AbortError::operation().into());
            }
            let input = secure_json_parse(call.input)
                .unwrap_or_else(|_| Value::String(call.input.to_string()));
            let tool = tools.and_then(|t| t.get(call.tool_name));
            Ok(TypedToolCall {
                tool_call_id: call.tool_call_id.to_string(),
                tool_name: call.tool_name.to_string(),
                input,
                provider_executed: call.provider_executed,
                provider_metadata: call.provider_metadata.clone(),
                tool_metadata: tool.and_then(|t| t.metadata.clone()),
                dynamic: Some(true),
                invalid: Some(true),
                error: Some(Arc::new(error)),
                title: tool.and_then(|t| t.title.clone()),
            })
        }
    }
}

/// How a tool output becomes a model output.
enum ErrorMode {
    None,
    Text,
    Json,
}

/// `createToolModelOutput`.
async fn create_tool_model_output(
    tool_call_id: &str,
    input: &Value,
    output: Result<&Value, &ToolErrorValue>,
    tool: Option<&Tool>,
    mode: ErrorMode,
) -> anyhow::Result<ToolResultOutput> {
    match (mode, output) {
        (ErrorMode::Text, Err(error)) => {
            return Ok(ToolResultOutput::ErrorText {
                value: error.message(),
                provider_options: None,
            });
        }
        (ErrorMode::Json, Err(error)) => {
            return Ok(ToolResultOutput::ErrorJson {
                value: error.to_json(),
                provider_options: None,
            });
        }
        _ => {}
    }
    let value = match output {
        Ok(v) => v.clone(),
        Err(e) => e.to_json(),
    };
    if let Some(to_model_output) = tool.and_then(|t| t.to_model_output.clone()) {
        return to_model_output(super::tool::ToModelOutputOptions {
            tool_call_id: tool_call_id.to_string(),
            input: input.clone(),
            output: value,
        })
        .await;
    }
    Ok(match value {
        Value::String(text) => ToolResultOutput::Text {
            value: text,
            provider_options: None,
        },
        other => ToolResultOutput::Json {
            value: other,
            provider_options: None,
        },
    })
}

/// `convertLanguageModelContent`: a provider's content with tool calls parsed and
/// the tools' outputs after it.
async fn convert_language_model_content(
    content: &[LanguageModelV4Content],
    tool_calls: &[TypedToolCall],
    tool_outputs: &[ToolOutput],
    tools: Option<&ToolSet>,
    abort: Option<&CancellationToken>,
) -> anyhow::Result<Vec<ContentPart>> {
    let mut parts = Vec::with_capacity(content.len() + tool_outputs.len());
    let find = |id: &str| tool_calls.iter().find(|c| c.tool_call_id == id);
    for part in content {
        match part {
            LanguageModelV4Content::Text {
                text,
                provider_metadata,
            } => parts.push(ContentPart::Text {
                text: text.clone(),
                provider_metadata: provider_metadata.clone(),
            }),
            LanguageModelV4Content::Reasoning {
                text,
                provider_metadata,
            } => parts.push(ContentPart::Reasoning {
                text: text.clone(),
                provider_metadata: provider_metadata.clone(),
            }),
            LanguageModelV4Content::Custom {
                kind,
                provider_metadata,
            } => parts.push(ContentPart::Custom {
                kind: kind.clone(),
                provider_metadata: provider_metadata.clone(),
            }),
            LanguageModelV4Content::Source(source) => {
                parts.push(ContentPart::Source(source.clone()))
            }
            LanguageModelV4Content::File {
                media_type,
                data,
                provider_metadata,
            }
            | LanguageModelV4Content::ReasoningFile {
                media_type,
                data,
                provider_metadata,
            } => {
                let base64 = match data {
                    FileData::Data { data } => data.to_base64(),
                    FileData::Url { url, .. } => bytes_to_base64(&download(url, abort).await?.data),
                    FileData::Text { text } => text.clone(),
                    FileData::Reference { .. } => String::new(),
                };
                let file = GeneratedFile {
                    base64,
                    media_type: media_type.clone(),
                };
                if matches!(part, LanguageModelV4Content::File { .. }) {
                    parts.push(ContentPart::File {
                        file,
                        provider_metadata: provider_metadata.clone(),
                    });
                } else {
                    parts.push(ContentPart::ReasoningFile {
                        file,
                        provider_metadata: provider_metadata.clone(),
                    });
                }
            }
            LanguageModelV4Content::ToolCall { tool_call_id, .. } => {
                let call = find(tool_call_id)
                    .ok_or_else(|| anyhow::anyhow!("Tool call {tool_call_id} not found."))?;
                parts.push(ContentPart::ToolCall(call.clone()));
            }
            LanguageModelV4Content::ToolResult {
                tool_call_id,
                tool_name,
                result,
                is_error,
                dynamic,
                provider_metadata,
                ..
            } => {
                let (input, call_dynamic, tool_metadata) = match find(tool_call_id) {
                    Some(call) => (call.input.clone(), call.dynamic, call.tool_metadata.clone()),
                    None => {
                        let tool = tools.and_then(|t| t.get(tool_name));
                        let deferred = matches!(
                            tool.map(|t| &t.tool_type),
                            Some(ToolType::Provider {
                                supports_deferred_results: Some(true),
                                ..
                            })
                        );
                        if !deferred {
                            return Err(anyhow::anyhow!("Tool call {tool_call_id} not found."));
                        }
                        (Value::Null, *dynamic, tool.and_then(|t| t.metadata.clone()))
                    }
                };
                if *is_error == Some(true) {
                    parts.push(ContentPart::ToolError(TypedToolError {
                        tool_call_id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        input,
                        error: ToolErrorValue::Json(result.clone()),
                        provider_executed: Some(true),
                        provider_metadata: provider_metadata.clone(),
                        tool_metadata,
                        dynamic: call_dynamic,
                        title: None,
                    }));
                } else {
                    parts.push(ContentPart::ToolResult(TypedToolResult {
                        tool_call_id: tool_call_id.clone(),
                        tool_name: tool_name.clone(),
                        input,
                        output: result.clone(),
                        provider_executed: Some(true),
                        provider_metadata: provider_metadata.clone(),
                        tool_metadata,
                        dynamic: call_dynamic,
                        preliminary: None,
                        title: None,
                    }));
                }
            }
            LanguageModelV4Content::ToolApprovalRequest {
                approval_id,
                tool_call_id,
                ..
            } => {
                let call = find(tool_call_id).ok_or_else(|| {
                    anyhow::anyhow!(
                        "Tool call {tool_call_id} not found for approval request {approval_id}."
                    )
                })?;
                parts.push(ContentPart::ToolApprovalRequest {
                    approval_id: approval_id.clone(),
                    tool_call: call.clone(),
                });
            }
        }
    }
    parts.extend(tool_outputs.iter().cloned().map(ToolOutput::into_content));
    Ok(parts)
}

/// `toResponseMessages`: the assistant message and the tool message a step adds.
async fn to_response_messages(
    content: &[ContentPart],
    tools: Option<&ToolSet>,
) -> anyhow::Result<Vec<ModelMessage>> {
    let mut messages = Vec::new();
    let mut tool_call_order: HashMap<String, usize> = HashMap::new();
    let mut assistant: Vec<AssistantContentPart> = Vec::new();
    let tool_of = |name: &str| tools.and_then(|t| t.get(name));

    for part in content {
        match part {
            ContentPart::Source(_) | ContentPart::ToolApprovalRequest { .. } => {}
            ContentPart::ToolResult(r) if r.provider_executed != Some(true) => {}
            ContentPart::ToolError(e) if e.provider_executed != Some(true) => {}
            ContentPart::Text {
                text,
                provider_metadata,
            } => {
                if text.is_empty() {
                    continue;
                }
                assistant.push(AssistantContentPart::Text(TextPart {
                    text: text.clone(),
                    provider_options: provider_metadata.clone(),
                }));
            }
            ContentPart::Custom {
                kind,
                provider_metadata,
            } => assistant.push(AssistantContentPart::Custom(CustomPart {
                kind: kind.clone(),
                provider_options: provider_metadata.clone(),
            })),
            ContentPart::Reasoning {
                text,
                provider_metadata,
            } => assistant.push(AssistantContentPart::Reasoning(ReasoningPart {
                text: text.clone(),
                provider_options: provider_metadata.clone(),
            })),
            ContentPart::File {
                file,
                provider_metadata,
            } => assistant.push(AssistantContentPart::File(FilePart {
                data: FilePartData::Data(DataContent::Base64(file.base64.clone())),
                filename: None,
                media_type: file.media_type.clone(),
                provider_options: provider_metadata.clone(),
            })),
            ContentPart::ReasoningFile {
                file,
                provider_metadata,
            } => assistant.push(AssistantContentPart::ReasoningFile(ReasoningFilePart {
                data: FilePartData::Data(DataContent::Base64(file.base64.clone())),
                media_type: file.media_type.clone(),
                provider_options: provider_metadata.clone(),
            })),
            ContentPart::ToolCall(call) => {
                let next = tool_call_order.len();
                tool_call_order
                    .entry(call.tool_call_id.clone())
                    .or_insert(next);
                let input = if call.invalid == Some(true)
                    && !matches!(call.input, Value::Object(_) | Value::Array(_) | Value::Null)
                {
                    json!({})
                } else {
                    call.input.clone()
                };
                assistant.push(AssistantContentPart::ToolCall(ToolCallPart {
                    tool_call_id: call.tool_call_id.clone(),
                    tool_name: call.tool_name.clone(),
                    input,
                    provider_executed: call.provider_executed,
                    provider_options: call.provider_metadata.clone(),
                }));
            }
            ContentPart::ToolResult(result) => {
                let output = create_tool_model_output(
                    &result.tool_call_id,
                    &result.input,
                    Ok(&result.output),
                    tool_of(&result.tool_name),
                    ErrorMode::None,
                )
                .await?;
                assistant.push(AssistantContentPart::ToolResult(ToolResultPart {
                    tool_call_id: result.tool_call_id.clone(),
                    tool_name: result.tool_name.clone(),
                    output,
                    provider_options: result.provider_metadata.clone(),
                }));
            }
            ContentPart::ToolError(error) => {
                let output = create_tool_model_output(
                    &error.tool_call_id,
                    &error.input,
                    Err(&error.error),
                    tool_of(&error.tool_name),
                    ErrorMode::Json,
                )
                .await?;
                assistant.push(AssistantContentPart::ToolResult(ToolResultPart {
                    tool_call_id: error.tool_call_id.clone(),
                    tool_name: error.tool_name.clone(),
                    output,
                    provider_options: error.provider_metadata.clone(),
                }));
            }
        }
    }
    if !assistant.is_empty() {
        messages.push(ModelMessage::Assistant(AssistantModelMessage {
            content: AssistantContent::Parts(assistant),
            provider_options: None,
        }));
    }

    let mut results: Vec<ToolResultPart> = Vec::new();
    for part in content {
        let (id, name, input, output, provider_executed, metadata, is_error) = match part {
            ContentPart::ToolResult(r) => (
                &r.tool_call_id,
                &r.tool_name,
                &r.input,
                Ok(&r.output),
                r.provider_executed,
                &r.provider_metadata,
                false,
            ),
            ContentPart::ToolError(e) => (
                &e.tool_call_id,
                &e.tool_name,
                &e.input,
                Err(&e.error),
                e.provider_executed,
                &e.provider_metadata,
                true,
            ),
            _ => continue,
        };
        if provider_executed == Some(true) {
            continue;
        }
        let output = create_tool_model_output(
            id,
            input,
            output,
            tool_of(name),
            if is_error {
                ErrorMode::Text
            } else {
                ErrorMode::None
            },
        )
        .await?;
        results.push(ToolResultPart {
            tool_call_id: id.clone(),
            tool_name: name.clone(),
            output,
            provider_options: metadata.clone(),
        });
    }
    if !results.is_empty() {
        let mut indexed: Vec<(usize, ToolResultPart)> = results.into_iter().enumerate().collect();
        indexed.sort_by(|(ia, a), (ib, b)| {
            let oa = tool_call_order.get(&a.tool_call_id);
            let ob = tool_call_order.get(&b.tool_call_id);
            match (oa, ob) {
                (None, None) => ia.cmp(ib),
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                (Some(x), Some(y)) => x.cmp(y).then(ia.cmp(ib)),
            }
        });
        messages.push(ModelMessage::Tool(ToolModelMessage {
            content: indexed
                .into_iter()
                .map(|(_, part)| ToolContentPart::ToolResult(part))
                .collect(),
            provider_options: None,
        }));
    }
    Ok(messages)
}

/// `executeToolCall`: runs one tool; `None` when the tool does not run here. A
/// failure becomes a tool error, never an error of the step.
async fn execute_tool_call(
    call: &TypedToolCall,
    tools: &ToolSet,
    call_id: &str,
    messages: Arc<Vec<ModelMessage>>,
    abort: Option<CancellationToken>,
    tools_context: &JsonObject,
    dispatcher: &TelemetryDispatcher,
) -> Option<(ToolOutput, f64)> {
    let tool = tools.get(&call.tool_name)?;
    let execute = tool.execute.clone()?;
    let context = tools_context
        .get(&call.tool_name)
        .cloned()
        .unwrap_or(Value::Null);
    if dispatcher.is_active() {
        dispatcher.on_tool_execution_start(&ToolExecutionStartEvent {
            call_id: call_id.to_string(),
            tool_call: call.clone(),
            messages: messages.clone(),
            tool_context: context.clone(),
        });
    }
    let options = ToolExecutionOptions {
        tool_call_id: call.tool_call_id.clone(),
        messages: messages.clone(),
        abort_signal: abort,
        context: context.clone(),
    };
    let started = Instant::now();
    let execution = dispatcher.execute_tool(
        call_id,
        &call.tool_call_id,
        execute(call.input.clone(), options),
    );
    let outcome = AssertUnwindSafe(execution).catch_unwind().await;
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let dynamic = Some(tool.is_dynamic());
    let output = match outcome {
        Ok(Ok(value)) => ToolOutput::Result(TypedToolResult {
            tool_call_id: call.tool_call_id.clone(),
            tool_name: call.tool_name.clone(),
            input: call.input.clone(),
            output: value,
            provider_executed: None,
            provider_metadata: call.provider_metadata.clone(),
            tool_metadata: call.tool_metadata.clone(),
            dynamic,
            preliminary: None,
            title: None,
        }),
        Ok(Err(error)) => tool_error(call, ToolErrorValue::Error(Arc::new(error)), dynamic),
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "tool panicked".to_string());
            tool_error(
                call,
                ToolErrorValue::Error(Arc::new(anyhow::anyhow!(message))),
                dynamic,
            )
        }
    };
    if dispatcher.is_active() {
        dispatcher.on_tool_execution_end(&ToolExecutionEndEvent {
            call_id: call_id.to_string(),
            tool_call: call.clone(),
            messages,
            tool_context: context,
            tool_output: output.clone(),
            tool_execution_ms: elapsed,
        });
    }
    Some((output, elapsed))
}

fn tool_error(call: &TypedToolCall, error: ToolErrorValue, dynamic: Option<bool>) -> ToolOutput {
    ToolOutput::Error(TypedToolError {
        tool_call_id: call.tool_call_id.clone(),
        tool_name: call.tool_name.clone(),
        input: call.input.clone(),
        error,
        provider_executed: None,
        provider_metadata: call.provider_metadata.clone(),
        tool_metadata: call.tool_metadata.clone(),
        dynamic,
        title: None,
    })
}

/// `generateText`: calls the model, runs the tools it calls, and calls it again with
/// their results until a stop condition holds or a step calls no tool.
pub async fn generate_text(options: GenerateTextOptions) -> anyhow::Result<GenerateTextResult> {
    ensure_log_fields_registered();
    let GenerateTextOptions {
        model,
        tools,
        tool_choice,
        system,
        prompt,
        messages,
        allow_system_in_messages,
        max_output_tokens,
        temperature,
        top_p,
        top_k,
        presence_penalty,
        frequency_penalty,
        stop_sequences,
        seed,
        reasoning,
        max_retries,
        abort_signal,
        headers,
        stop_when,
        telemetry,
        provider_options,
        active_tools,
        tool_order,
        prepare_step,
        mut runtime_context,
        mut tools_context,
        on_step_finish,
        include,
    } = options;

    let stop_conditions = stop_when.unwrap_or_else(|| vec![step_count_is(1)]);
    let retry = prepare_retries(max_retries, abort_signal.clone())?;
    let call_settings = CallSettings {
        max_output_tokens,
        temperature,
        top_p,
        top_k,
        presence_penalty,
        frequency_penalty,
        stop_sequences,
        seed,
        reasoning,
    };
    call_settings.validate()?;
    let headers = with_user_agent_suffix(headers.as_ref(), &format!("ai/{VERSION}"));
    let initial_prompt = standardize_prompt(system, prompt, messages, allow_system_in_messages)?;
    let call_id = create_id("call", 24);
    let dispatcher = TelemetryDispatcher::new(telemetry.as_ref());

    if dispatcher.is_active() {
        dispatcher.on_start(&OperationStartEvent::GenerateText(Box::new(
            GenerateTextStartEvent {
                call_id: call_id.clone(),
                operation_id: "ai.generateText",
                provider: model.provider().to_string(),
                model_id: model.model_id().to_string(),
                instructions: initial_prompt.instructions.clone(),
                messages: initial_prompt.messages.clone(),
                tools: tools.clone(),
                tool_choice: tool_choice.clone(),
                active_tools: active_tools.clone(),
                max_output_tokens: call_settings.max_output_tokens,
                temperature: call_settings.temperature,
                top_p: call_settings.top_p,
                top_k: call_settings.top_k,
                presence_penalty: call_settings.presence_penalty,
                frequency_penalty: call_settings.frequency_penalty,
                stop_sequences: call_settings.stop_sequences.clone(),
                seed: call_settings.seed,
                reasoning: call_settings.reasoning,
                max_retries: retry.max_retries,
                headers: headers.clone(),
                provider_options: provider_options.clone(),
                runtime_context: dispatcher.filter_context(&runtime_context),
            },
        )));
    }

    let outcome: anyhow::Result<GenerateTextResult> = async {
        let initial_messages = initial_prompt.messages.clone();
        let initial_response_messages: Vec<ModelMessage> = Vec::new();
        let mut steps: Vec<Arc<StepResult>> = Vec::new();
        let mut instructions_for_next_step = initial_prompt.instructions.clone();
        let mut messages_for_next_step: Vec<ModelMessage> = initial_messages.clone();
        let mut pending_deferred: HashSet<String> = HashSet::new();

        loop {
            if !steps.is_empty() && abort_signal.as_ref().is_some_and(|t| t.is_cancelled()) {
                return Err(AbortError::operation().into());
            }
            let step_number = steps.len();
            let accumulated_response_messages: Vec<ModelMessage> = initial_response_messages
                .iter()
                .cloned()
                .chain(steps.iter().flat_map(|s| s.response.messages.iter().cloned()))
                .collect();
            let step_input_messages = std::mem::take(&mut messages_for_next_step);

            let prepared = match &prepare_step {
                Some(prepare) => prepare(PrepareStepOptions {
                    steps: steps.clone(),
                    step_number,
                    model: model.clone(),
                    instructions: instructions_for_next_step.clone(),
                    initial_instructions: initial_prompt.instructions.clone(),
                    messages: step_input_messages.clone(),
                    initial_messages: initial_messages.clone(),
                    response_messages: accumulated_response_messages,
                    tools_context: tools_context.clone(),
                    runtime_context: runtime_context.clone(),
                })
                .await?
                .unwrap_or_default(),
                None => PrepareStepResult::default(),
            };

            let step_model = prepared.model.clone().unwrap_or_else(|| model.clone());
            let step_instructions =
                prepared.instructions.clone().or_else(|| prepared.system.clone()).or_else(|| instructions_for_next_step.clone());
            if let Some(context) = prepared.runtime_context.clone() {
                runtime_context = context;
            }
            if let Some(context) = prepared.tools_context.clone() {
                tools_context = context;
            }
            let step_active = prepared.active_tools.clone().or_else(|| active_tools.clone());
            let step_tool_set = filter_active_tools(tools.as_ref(), step_active.as_deref());
            let step_tool_order = prepared.tool_order.clone().or_else(|| tool_order.clone());
            let step_tools = prepare_tools(step_tool_set.as_ref(), step_tool_order.as_deref());
            let step_tool_choice_option = prepared.tool_choice.clone().or_else(|| tool_choice.clone());
            let step_tool_choice = prepare_tool_choice(step_tool_choice_option.as_ref());
            let step_messages = prepared.messages.clone().unwrap_or(step_input_messages);

            let provider_prefix = step_model.provider().split('.').next().unwrap_or_default().to_string();
            let prompt_messages = convert_to_language_model_prompt(
                &StandardizedPrompt { instructions: step_instructions.clone(), messages: step_messages.clone() },
                &step_model.supported_urls(),
                abort_signal.as_ref(),
                Some(&provider_prefix),
            )
            .await?;
            let step_provider_options = merge_objects(provider_options.as_ref(), prepared.provider_options.as_ref());
            let step_settings = CallSettings {
                max_output_tokens: prepared.max_output_tokens.or(call_settings.max_output_tokens),
                temperature: prepared.temperature.or(call_settings.temperature),
                top_p: prepared.top_p.or(call_settings.top_p),
                top_k: prepared.top_k.or(call_settings.top_k),
                presence_penalty: prepared.presence_penalty.or(call_settings.presence_penalty),
                frequency_penalty: prepared.frequency_penalty.or(call_settings.frequency_penalty),
                stop_sequences: prepared.stop_sequences.clone().or_else(|| call_settings.stop_sequences.clone()),
                seed: prepared.seed.or(call_settings.seed),
                reasoning: prepared.reasoning.or(call_settings.reasoning),
            };
            step_settings.validate()?;

            if dispatcher.is_active() {
                dispatcher.on_step_start(&GenerateTextStepStartEvent {
                    call_id: call_id.clone(),
                    provider: step_model.provider().to_string(),
                    model_id: step_model.model_id().to_string(),
                    step_number,
                    instructions: step_instructions.clone(),
                    messages: step_messages.clone(),
                    tool_choice: step_tool_choice_option.clone(),
                    active_tools: step_active.clone(),
                    steps: steps.iter().map(|s| Arc::new(s.restricted(&dispatcher))).collect(),
                    provider_options: step_provider_options.clone(),
                    runtime_context: dispatcher.filter_context(&runtime_context),
                    prompt_messages: prompt_messages.clone(),
                    step_tools: step_tools.clone(),
                    step_tool_choice: step_tool_choice.clone(),
                });
                dispatcher.on_language_model_call_start(&LanguageModelCallStartEvent {
                    call_id: call_id.clone(),
                    provider: step_model.provider().to_string(),
                    model_id: step_model.model_id().to_string(),
                    instructions: step_instructions.clone(),
                    messages: step_messages.clone(),
                    tools: step_tools.clone(),
                    max_output_tokens: step_settings.max_output_tokens,
                    temperature: step_settings.temperature,
                    top_p: step_settings.top_p,
                    top_k: step_settings.top_k,
                    presence_penalty: step_settings.presence_penalty,
                    frequency_penalty: step_settings.frequency_penalty,
                    stop_sequences: step_settings.stop_sequences.clone(),
                    seed: step_settings.seed,
                    reasoning: step_settings.reasoning,
                });
            }

            let mut call_options = LanguageModelV4CallOptions {
                tools: step_tools.clone(),
                tool_choice: Some(step_tool_choice.clone()),
                response_format: None,
                prompt: prompt_messages,
                provider_options: step_provider_options.clone(),
                abort_signal: abort_signal.clone(),
                headers: Some(headers.clone()),
                ..Default::default()
            };
            step_settings.apply_to(&mut call_options);

            let step_started = Instant::now();
            let response = retry
                .run(|| {
                    let model = step_model.clone();
                    let options = call_options.clone();
                    let abort = abort_signal.clone();
                    async move { race_abort(model.do_generate(options), abort.as_ref()).await }
                })
                .await?;
            let response_time_ms = step_started.elapsed().as_secs_f64() * 1000.0;
            let provider_response = response.response.clone().unwrap_or_default();
            let response_id = provider_response.id.clone().unwrap_or_else(|| create_id("aitxt", 24));
            let response_timestamp = provider_response.timestamp.unwrap_or_else(Utc::now);
            let response_model_id =
                provider_response.model_id.clone().unwrap_or_else(|| step_model.model_id().to_string());
            let step_usage = LanguageModelUsage::from_v4(&response.usage);
            let finish_reason = response.finish_reason.unified;

            let mut step_tool_calls: Vec<TypedToolCall> = Vec::new();
            for part in &response.content {
                if let LanguageModelV4Content::ToolCall {
                    tool_call_id,
                    tool_name,
                    input,
                    provider_executed,
                    dynamic,
                    provider_metadata,
                } = part
                {
                    let raw = RawToolCall {
                        tool_call_id,
                        tool_name,
                        input,
                        provider_executed: *provider_executed,
                        dynamic: *dynamic,
                        provider_metadata,
                    };
                    step_tool_calls.push(parse_tool_call(&raw, step_tool_set.as_ref(), abort_signal.as_ref())?);
                }
            }

            if dispatcher.is_active() {
                let model_call_content = convert_language_model_content(
                    &response.content,
                    &step_tool_calls,
                    &[],
                    tools.as_ref(),
                    abort_signal.as_ref(),
                )
                .await?;
                dispatcher.on_language_model_call_end(&LanguageModelCallEndEvent {
                    call_id: call_id.clone(),
                    provider: step_model.provider().to_string(),
                    model_id: response_model_id.clone(),
                    finish_reason,
                    usage: step_usage.clone(),
                    content: model_call_content,
                    response_id: response_id.clone(),
                    provider_metadata: response.provider_metadata.clone(),
                    performance: StepResultPerformance {
                        effective_output_tokens_per_second: tokens_per_second(step_usage.output_tokens, response_time_ms),
                        effective_total_tokens_per_second: tokens_per_second(
                            sum_counts(step_usage.input_tokens, step_usage.output_tokens),
                            response_time_ms,
                        ),
                        response_time_ms,
                        ..Default::default()
                    },
                });
            }

            let enforced = match &step_tool_choice {
                LanguageModelV4ToolChoice::Required | LanguageModelV4ToolChoice::Tool { .. } => Some(&step_tool_choice),
                _ => None,
            };
            if let Some(enforced) = enforced {
                let satisfied = step_tool_calls.iter().any(|call| match enforced {
                    LanguageModelV4ToolChoice::Tool { tool_name } => &call.tool_name == tool_name,
                    _ => true,
                });
                if !satisfied {
                    let message = match enforced {
                        LanguageModelV4ToolChoice::Tool { tool_name } => {
                            format!("Model response did not contain a call to the required tool '{tool_name}'.")
                        }
                        _ => "Model response did not contain a tool call even though tool choice was required."
                            .to_string(),
                    };
                    return Err(ToolChoiceViolationError {
                        message,
                        tool_choice: enforced.clone(),
                        finish_reason,
                        provider: step_model.provider().to_string(),
                        model_id: step_model.model_id().to_string(),
                    }
                    .into());
                }
            }

            let tool_messages = Arc::new(step_messages.clone());
            for call in &step_tool_calls {
                if call.invalid == Some(true) {
                    continue;
                }
                let Some(tool) = step_tool_set.as_ref().and_then(|t| t.get(&call.tool_name)) else {
                    continue;
                };
                if tool.on_input_start.is_none() && tool.on_input_available.is_none() {
                    continue;
                }
                let options = ToolExecutionOptions {
                    tool_call_id: call.tool_call_id.clone(),
                    messages: tool_messages.clone(),
                    abort_signal: abort_signal.clone(),
                    context: tools_context.get(&call.tool_name).cloned().unwrap_or(Value::Null),
                };
                if let Some(on_start) = &tool.on_input_start {
                    on_start(options.clone()).await?;
                }
                if let Some(on_available) = &tool.on_input_available {
                    on_available(call.input.clone(), options).await?;
                }
            }

            let mut client_tool_outputs: Vec<ToolOutput> = Vec::new();
            for call in step_tool_calls.iter().filter(|c| c.invalid == Some(true) && c.dynamic == Some(true)) {
                if call.provider_executed == Some(true) {
                    continue;
                }
                let message = call.error.as_ref().map(|e| get_error_message(e)).unwrap_or_else(|| "unknown error".into());
                client_tool_outputs.push(ToolOutput::Error(TypedToolError {
                    tool_call_id: call.tool_call_id.clone(),
                    tool_name: call.tool_name.clone(),
                    input: call.input.clone(),
                    error: ToolErrorValue::Message(message),
                    provider_executed: None,
                    provider_metadata: None,
                    tool_metadata: None,
                    dynamic: Some(true),
                    title: None,
                }));
            }

            let client_tool_calls: Vec<&TypedToolCall> =
                step_tool_calls.iter().filter(|c| c.provider_executed != Some(true)).collect();
            let mut tool_execution_ms: IndexMap<String, f64> = IndexMap::new();
            if let Some(execution_tools) = step_tool_set.as_ref()
                && matches!(finish_reason, FinishReason::Stop | FinishReason::ToolCalls) {
                    let runnable: Vec<&TypedToolCall> =
                        client_tool_calls.iter().copied().filter(|c| c.invalid != Some(true)).collect();
                    let results = join_all(runnable.into_iter().map(|call| {
                        execute_tool_call(
                            call,
                            execution_tools,
                            &call_id,
                            tool_messages.clone(),
                            abort_signal.clone(),
                            &tools_context,
                            &dispatcher,
                        )
                    }))
                    .await;
                    for (output, ms) in results.into_iter().flatten() {
                        tool_execution_ms.insert(output.tool_call_id().to_string(), ms);
                        client_tool_outputs.push(output);
                    }
                }

            let step_time_ms = step_started.elapsed().as_secs_f64() * 1000.0;
            let performance = StepResultPerformance {
                effective_output_tokens_per_second: tokens_per_second(step_usage.output_tokens, response_time_ms),
                output_tokens_per_second: None,
                input_tokens_per_second: None,
                effective_total_tokens_per_second: tokens_per_second(
                    sum_counts(step_usage.input_tokens, step_usage.output_tokens),
                    response_time_ms,
                ),
                step_time_ms,
                response_time_ms,
                tool_execution_ms,
                time_to_first_output_ms: None,
            };

            for call in &step_tool_calls {
                if call.provider_executed != Some(true) {
                    continue;
                }
                let deferred = matches!(
                    step_tool_set.as_ref().and_then(|t| t.get(&call.tool_name)).map(|t| &t.tool_type),
                    Some(ToolType::Provider { supports_deferred_results: Some(true), .. })
                );
                let answered = response.content.iter().any(|part| {
                    matches!(part, LanguageModelV4Content::ToolResult { tool_call_id, .. } if *tool_call_id == call.tool_call_id)
                });
                if deferred && !answered {
                    pending_deferred.insert(call.tool_call_id.clone());
                }
            }
            for part in &response.content {
                if let LanguageModelV4Content::ToolResult { tool_call_id, .. } = part {
                    pending_deferred.remove(tool_call_id);
                }
            }

            let step_content = convert_language_model_content(
                &response.content,
                &step_tool_calls,
                &client_tool_outputs,
                tools.as_ref(),
                abort_signal.as_ref(),
            )
            .await?;
            let step_response_messages = to_response_messages(&step_content, tools.as_ref()).await?;

            let step_request = LanguageModelRequestMetadata {
                body: if include.request_body { response.request.as_ref().and_then(|r| r.body.clone()) } else { None },
                messages: if include.request_messages { Some(step_messages.clone()) } else { None },
            };
            let step_response = LanguageModelResponseMetadata {
                id: response_id,
                timestamp: response_timestamp,
                model_id: response_model_id,
                headers: provider_response.headers.clone(),
                body: if include.response_body { provider_response.body.clone() } else { None },
                messages: step_response_messages.clone(),
            };

            let step = Arc::new(StepResult {
                call_id: call_id.clone(),
                step_number,
                model: StepModel {
                    provider: step_model.provider().to_string(),
                    model_id: step_model.model_id().to_string(),
                },
                tools_context: tools_context.clone(),
                runtime_context: runtime_context.clone(),
                content: step_content,
                finish_reason,
                raw_finish_reason: response.finish_reason.raw.clone(),
                usage: step_usage,
                performance,
                warnings: Some(response.warnings.clone()),
                request: step_request,
                response: step_response,
                provider_metadata: response.provider_metadata.clone(),
            });

            log_warnings(&response.warnings, Some(step_model.provider()), Some(step_model.model_id()));

            steps.push(step.clone());
            instructions_for_next_step = step_instructions;
            let mut next_messages = step_messages;
            next_messages.extend(step_response_messages);
            messages_for_next_step = next_messages;

            if let Some(callback) = &on_step_finish {
                callback(step.clone()).await;
            }
            if dispatcher.is_active() {
                dispatcher.on_step_end(&step.restricted(&dispatcher));
            }

            let all_answered = client_tool_outputs.len() == client_tool_calls.len();
            let more_to_do = !client_tool_calls.is_empty() || !pending_deferred.is_empty();
            if !(all_answered && more_to_do) {
                break;
            }
            if stop_conditions.iter().any(|condition| condition(&steps)) {
                break;
            }
        }

        let total_usage =
            steps.iter().fold(LanguageModelUsage::default(), |total, step| total.add(&step.usage));
        let last = steps.last().expect("one step").clone();
        let output = if last.finish_reason == FinishReason::Stop
            || (last.finish_reason != FinishReason::ToolCalls && !last.text().is_empty())
        {
            Some(last.text())
        } else {
            None
        };
        let result = GenerateTextResult { steps, total_usage, initial_response_messages, output };

        if dispatcher.is_active() {
            let restricted: Vec<Arc<StepResult>> =
                result.steps.iter().map(|s| Arc::new(s.restricted(&dispatcher))).collect();
            dispatcher.on_end(&OperationEndEvent::GenerateText(Box::new(GenerateTextEndEvent {
                call_id: call_id.clone(),
                step_number: last.step_number,
                provider: last.model.provider.clone(),
                model_id: last.model.model_id.clone(),
                runtime_context: dispatcher.filter_context(&last.runtime_context),
                finish_reason: last.finish_reason,
                raw_finish_reason: last.raw_finish_reason.clone(),
                total_usage: result.total_usage.clone(),
                text: last.text(),
                reasoning_text: last.reasoning_text(),
                tool_calls: result.tool_calls().into_iter().cloned().collect(),
                tool_results: result.tool_results().into_iter().cloned().collect(),
                response_messages: result.response_messages(),
                warnings: result.warnings(),
                request: last.request.clone(),
                response: last.response.clone(),
                provider_metadata: last.provider_metadata.clone(),
                steps: restricted,
            })));
        }
        Ok(result)
    }
    .await;

    if let Err(error) = &outcome {
        dispatcher.on_error(&call_id, error);
    }
    outcome
}

fn sum_counts(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    if a.is_none() && b.is_none() {
        None
    } else {
        Some(a.unwrap_or(0) + b.unwrap_or(0))
    }
}

#[cfg(test)]
#[path = "generate_text_tests.rs"]
mod tests;
