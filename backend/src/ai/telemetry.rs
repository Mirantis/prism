//! Telemetry: the SDK writes no span itself. It calls the integrations registered
//! with `register_telemetry` (or given in a call's `TelemetryOptions`) at the points
//! where the TypeScript SDK opens its `ai.generateText`, `ai.generateText.doGenerate`,
//! `ai.toolCall`, `ai.generateObject` and `ai.embed` spans, with the same data.
//! The Langfuse layer implements `Telemetry`.

use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use indexmap::IndexMap;
use parking_lot::RwLock;
use serde_json::Value;

use super::generate_text::{
    ContentPart, LanguageModelRequestMetadata, LanguageModelResponseMetadata, StepResult,
    StepResultPerformance, ToolOutput, TypedToolCall, TypedToolResult,
};
use super::messages::ModelMessage;
use super::prompt::{Instructions, Prompt};
use super::provider::{
    FinishReason, Headers, JsonObject, LanguageModelV4Prompt, LanguageModelV4Tool,
    LanguageModelV4ToolChoice, ProviderMetadata, ProviderOptions, ReasoningEffort, Warning,
};
use super::tool::{ToolChoice, ToolSet};
use super::usage::LanguageModelUsage;

/// A call's telemetry settings (`experimental_telemetry`).
#[derive(Clone, Default)]
pub struct TelemetryOptions {
    /// `Some(false)` turns telemetry off for the call.
    pub is_enabled: Option<bool>,
    /// Whether spans record the prompt. Recorded unless `Some(false)`.
    pub record_inputs: Option<bool>,
    /// Whether spans record the completion. Recorded unless `Some(false)`.
    pub record_outputs: Option<bool>,
    pub function_id: Option<String>,
    /// The `runtime_context` keys spans may carry; every other key is left out.
    pub include_runtime_context: Option<IndexMap<String, bool>>,
    /// Integrations for this call only, in place of the registered ones.
    pub integrations: Option<Vec<Arc<dyn Telemetry>>>,
}

impl std::fmt::Debug for TelemetryOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryOptions")
            .field("is_enabled", &self.is_enabled)
            .field("record_inputs", &self.record_inputs)
            .field("record_outputs", &self.record_outputs)
            .field("function_id", &self.function_id)
            .field("include_runtime_context", &self.include_runtime_context)
            .finish()
    }
}

/// The call settings every event carries (`recordInputs`, `recordOutputs`,
/// `functionId`).
#[derive(Debug, Clone, Default)]
pub struct TelemetryMeta {
    pub record_inputs: Option<bool>,
    pub record_outputs: Option<bool>,
    pub function_id: Option<String>,
}

/// `ai.generateText` begins.
#[derive(Clone)]
pub struct GenerateTextStartEvent {
    pub call_id: String,
    pub operation_id: &'static str,
    pub provider: String,
    pub model_id: String,
    pub instructions: Option<Instructions>,
    pub messages: Vec<ModelMessage>,
    pub tools: Option<ToolSet>,
    pub tool_choice: Option<ToolChoice>,
    pub active_tools: Option<Vec<String>>,
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub seed: Option<i64>,
    pub reasoning: Option<ReasoningEffort>,
    pub max_retries: u32,
    pub headers: Headers,
    pub provider_options: Option<ProviderOptions>,
    pub runtime_context: JsonObject,
}

/// `ai.generateObject` begins.
#[derive(Debug, Clone)]
pub struct GenerateObjectStartEvent {
    pub call_id: String,
    pub operation_id: &'static str,
    pub provider: String,
    pub model_id: String,
    pub system: Option<Instructions>,
    pub prompt: Option<Prompt>,
    pub messages: Option<Vec<ModelMessage>>,
    pub max_output_tokens: Option<i64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub seed: Option<i64>,
    pub max_retries: u32,
    pub headers: Headers,
    pub provider_options: Option<ProviderOptions>,
    pub output: &'static str,
    pub schema: Option<Value>,
    pub schema_name: Option<String>,
    pub schema_description: Option<String>,
}

/// `ai.embed` or `ai.embedMany` begins.
#[derive(Debug, Clone)]
pub struct EmbedStartEvent {
    pub call_id: String,
    pub operation_id: &'static str,
    pub runtime_context: JsonObject,
    pub provider: String,
    pub model_id: String,
    /// The value (`ai.embed`) or the values (`ai.embedMany`).
    pub value: Value,
    pub dimensions: Option<i64>,
    pub max_retries: u32,
    pub headers: Headers,
    pub provider_options: Option<ProviderOptions>,
}

/// The start of an operation; `operation_id` tells which.
#[derive(Clone)]
pub enum OperationStartEvent {
    GenerateText(Box<GenerateTextStartEvent>),
    GenerateObject(Box<GenerateObjectStartEvent>),
    Embed(Box<EmbedStartEvent>),
}

/// A step of `ai.generateText` begins.
#[derive(Clone)]
pub struct GenerateTextStepStartEvent {
    pub call_id: String,
    pub provider: String,
    pub model_id: String,
    pub step_number: usize,
    pub instructions: Option<Instructions>,
    pub messages: Vec<ModelMessage>,
    pub tool_choice: Option<ToolChoice>,
    pub active_tools: Option<Vec<String>>,
    pub steps: Vec<Arc<StepResult>>,
    pub provider_options: Option<ProviderOptions>,
    pub runtime_context: JsonObject,
    pub prompt_messages: LanguageModelV4Prompt,
    pub step_tools: Option<Vec<LanguageModelV4Tool>>,
    pub step_tool_choice: LanguageModelV4ToolChoice,
}

/// The provider call of a step (`ai.generateText.doGenerate`) begins.
#[derive(Debug, Clone)]
pub struct LanguageModelCallStartEvent {
    pub call_id: String,
    pub provider: String,
    pub model_id: String,
    pub instructions: Option<Instructions>,
    pub messages: Vec<ModelMessage>,
    pub tools: Option<Vec<LanguageModelV4Tool>>,
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

/// The provider call of a step returned and was parsed.
#[derive(Clone)]
pub struct LanguageModelCallEndEvent {
    pub call_id: String,
    pub provider: String,
    pub model_id: String,
    pub finish_reason: FinishReason,
    pub usage: LanguageModelUsage,
    pub content: Vec<ContentPart>,
    pub response_id: String,
    pub provider_metadata: Option<ProviderMetadata>,
    pub performance: StepResultPerformance,
}

/// A tool's `execute` begins (`ai.toolCall`).
#[derive(Clone)]
pub struct ToolExecutionStartEvent {
    pub call_id: String,
    pub tool_call: TypedToolCall,
    pub messages: Arc<Vec<ModelMessage>>,
    pub tool_context: Value,
}

/// A tool's `execute` ended.
#[derive(Clone)]
pub struct ToolExecutionEndEvent {
    pub call_id: String,
    pub tool_call: TypedToolCall,
    pub messages: Arc<Vec<ModelMessage>>,
    pub tool_context: Value,
    pub tool_output: ToolOutput,
    pub tool_execution_ms: f64,
}

/// `ai.generateText` ended.
#[derive(Clone)]
pub struct GenerateTextEndEvent {
    pub call_id: String,
    pub step_number: usize,
    pub provider: String,
    pub model_id: String,
    pub runtime_context: JsonObject,
    pub finish_reason: FinishReason,
    pub raw_finish_reason: Option<String>,
    pub total_usage: LanguageModelUsage,
    pub text: String,
    pub reasoning_text: Option<String>,
    pub tool_calls: Vec<TypedToolCall>,
    pub tool_results: Vec<TypedToolResult>,
    pub response_messages: Vec<ModelMessage>,
    pub warnings: Vec<Warning>,
    pub request: LanguageModelRequestMetadata,
    pub response: LanguageModelResponseMetadata,
    pub provider_metadata: Option<ProviderMetadata>,
    pub steps: Vec<Arc<StepResult>>,
}

/// The provider call of `ai.generateObject` begins.
#[derive(Debug, Clone)]
pub struct GenerateObjectStepStartEvent {
    pub call_id: String,
    pub step_number: usize,
    pub provider: String,
    pub model_id: String,
    pub provider_options: Option<ProviderOptions>,
    pub headers: Headers,
    pub prompt_messages: LanguageModelV4Prompt,
}

/// The provider call of `ai.generateObject` returned.
#[derive(Debug, Clone)]
pub struct GenerateObjectStepEndEvent {
    pub call_id: String,
    pub step_number: usize,
    pub provider: String,
    pub model_id: String,
    pub finish_reason: FinishReason,
    pub usage: LanguageModelUsage,
    pub object_text: String,
    pub reasoning: Option<String>,
    pub warnings: Vec<Warning>,
    pub request: LanguageModelRequestMetadata,
    pub response: LanguageModelResponseMetadata,
    pub provider_metadata: Option<ProviderMetadata>,
}

/// `ai.generateObject` ended.
#[derive(Debug, Clone)]
pub struct GenerateObjectEndEvent {
    pub call_id: String,
    pub object: Value,
    pub reasoning: Option<String>,
    pub finish_reason: FinishReason,
    pub usage: LanguageModelUsage,
    pub warnings: Vec<Warning>,
    pub request: LanguageModelRequestMetadata,
    pub response: LanguageModelResponseMetadata,
    pub provider_metadata: Option<ProviderMetadata>,
}

/// A provider embedding call (`ai.embed.doEmbed`, `ai.embedMany.doEmbed`) begins.
#[derive(Debug, Clone)]
pub struct EmbeddingModelCallStartEvent {
    pub call_id: String,
    pub embed_call_id: String,
    pub operation_id: &'static str,
    pub provider: String,
    pub model_id: String,
    pub values: Vec<String>,
    pub dimensions: Option<i64>,
}

/// A provider embedding call returned.
#[derive(Debug, Clone)]
pub struct EmbeddingModelCallEndEvent {
    pub call_id: String,
    pub embed_call_id: String,
    pub operation_id: &'static str,
    pub provider: String,
    pub model_id: String,
    pub values: Vec<String>,
    pub embeddings: Vec<Vec<f64>>,
    pub tokens: f64,
}

/// `ai.embed` or `ai.embedMany` ended.
#[derive(Debug, Clone)]
pub struct EmbedEndEvent {
    pub call_id: String,
    pub operation_id: &'static str,
    pub runtime_context: JsonObject,
    pub provider: String,
    pub model_id: String,
    pub value: Value,
    pub embedding: Value,
    pub tokens: f64,
    pub warnings: Vec<Warning>,
    pub provider_metadata: Option<ProviderMetadata>,
}

/// The end of an operation.
#[derive(Clone)]
pub enum OperationEndEvent {
    GenerateText(Box<GenerateTextEndEvent>),
    GenerateObject(Box<GenerateObjectEndEvent>),
    Embed(Box<EmbedEndEvent>),
}

/// A telemetry integration (`Telemetry` in the SDK). Every hook is optional.
pub trait Telemetry: Send + Sync {
    fn on_start(&self, _event: &OperationStartEvent, _meta: &TelemetryMeta) {}
    fn on_step_start(&self, _event: &GenerateTextStepStartEvent, _meta: &TelemetryMeta) {}
    fn on_language_model_call_start(
        &self,
        _event: &LanguageModelCallStartEvent,
        _meta: &TelemetryMeta,
    ) {
    }
    fn on_language_model_call_end(
        &self,
        _event: &LanguageModelCallEndEvent,
        _meta: &TelemetryMeta,
    ) {
    }
    fn on_tool_execution_start(&self, _event: &ToolExecutionStartEvent, _meta: &TelemetryMeta) {}
    fn on_tool_execution_end(&self, _event: &ToolExecutionEndEvent, _meta: &TelemetryMeta) {}
    fn on_step_end(&self, _event: &StepResult, _meta: &TelemetryMeta) {}
    fn on_object_step_start(&self, _event: &GenerateObjectStepStartEvent, _meta: &TelemetryMeta) {}
    fn on_object_step_end(&self, _event: &GenerateObjectStepEndEvent, _meta: &TelemetryMeta) {}
    fn on_embed_start(&self, _event: &EmbeddingModelCallStartEvent, _meta: &TelemetryMeta) {}
    fn on_embed_end(&self, _event: &EmbeddingModelCallEndEvent, _meta: &TelemetryMeta) {}
    fn on_end(&self, _event: &OperationEndEvent, _meta: &TelemetryMeta) {}
    fn on_error(&self, _call_id: &str, _error: &anyhow::Error, _meta: &TelemetryMeta) {}
    /// `executeTool`: runs a tool's `execute` in the integration's context, so
    /// the work it starts nests under the tool's span.
    fn execute_tool(
        &self,
        _call_id: &str,
        _tool_call_id: &str,
        execute: BoxFuture<'static, anyhow::Result<Value>>,
    ) -> BoxFuture<'static, anyhow::Result<Value>> {
        execute
    }
}

static INTEGRATIONS: LazyLock<RwLock<Vec<Arc<dyn Telemetry>>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));

/// `registerTelemetry`: integrations every later call reports to.
pub fn register_telemetry(integration: Arc<dyn Telemetry>) {
    INTEGRATIONS.write().push(integration);
}

/// The integrations a call reports to, with its settings.
#[derive(Clone, Default)]
pub struct TelemetryDispatcher {
    integrations: Vec<Arc<dyn Telemetry>>,
    pub meta: TelemetryMeta,
    include_runtime_context: Option<IndexMap<String, bool>>,
}

impl TelemetryDispatcher {
    /// `createTelemetryDispatcher`: none when the call turns telemetry off.
    pub fn new(options: Option<&TelemetryOptions>) -> Self {
        if options.and_then(|o| o.is_enabled) == Some(false) {
            return Self::default();
        }
        let integrations = match options.and_then(|o| o.integrations.clone()) {
            Some(list) => list,
            None => INTEGRATIONS.read().clone(),
        };
        Self {
            integrations,
            meta: TelemetryMeta {
                record_inputs: options.and_then(|o| o.record_inputs),
                record_outputs: options.and_then(|o| o.record_outputs),
                function_id: options.and_then(|o| o.function_id.clone()),
            },
            include_runtime_context: options.and_then(|o| o.include_runtime_context.clone()),
        }
    }

    /// Whether any integration listens; events are built only then.
    pub fn is_active(&self) -> bool {
        !self.integrations.is_empty()
    }

    /// `filterIncludedContext`: the keys the call opted in, and no others.
    pub fn filter_context(&self, context: &JsonObject) -> JsonObject {
        context
            .iter()
            .filter(|(key, _)| {
                self.include_runtime_context
                    .as_ref()
                    .and_then(|i| i.get(*key))
                    == Some(&true)
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    fn each(&self, f: impl Fn(&dyn Telemetry)) {
        for integration in &self.integrations {
            f(integration.as_ref());
        }
    }

    pub fn on_start(&self, event: &OperationStartEvent) {
        self.each(|i| i.on_start(event, &self.meta));
    }

    pub fn on_step_start(&self, event: &GenerateTextStepStartEvent) {
        self.each(|i| i.on_step_start(event, &self.meta));
    }

    pub fn on_language_model_call_start(&self, event: &LanguageModelCallStartEvent) {
        self.each(|i| i.on_language_model_call_start(event, &self.meta));
    }

    pub fn on_language_model_call_end(&self, event: &LanguageModelCallEndEvent) {
        self.each(|i| i.on_language_model_call_end(event, &self.meta));
    }

    /// Wraps a tool's `execute` future in each integration's context.
    pub fn execute_tool(
        &self,
        call_id: &str,
        tool_call_id: &str,
        execute: BoxFuture<'static, anyhow::Result<Value>>,
    ) -> BoxFuture<'static, anyhow::Result<Value>> {
        self.integrations
            .iter()
            .fold(execute, |future, integration| {
                integration.execute_tool(call_id, tool_call_id, future)
            })
    }

    pub fn on_tool_execution_start(&self, event: &ToolExecutionStartEvent) {
        self.each(|i| i.on_tool_execution_start(event, &self.meta));
    }

    pub fn on_tool_execution_end(&self, event: &ToolExecutionEndEvent) {
        self.each(|i| i.on_tool_execution_end(event, &self.meta));
    }

    pub fn on_step_end(&self, event: &StepResult) {
        self.each(|i| i.on_step_end(event, &self.meta));
    }

    pub fn on_object_step_start(&self, event: &GenerateObjectStepStartEvent) {
        self.each(|i| i.on_object_step_start(event, &self.meta));
    }

    pub fn on_object_step_end(&self, event: &GenerateObjectStepEndEvent) {
        self.each(|i| i.on_object_step_end(event, &self.meta));
    }

    pub fn on_embed_start(&self, event: &EmbeddingModelCallStartEvent) {
        self.each(|i| i.on_embed_start(event, &self.meta));
    }

    pub fn on_embed_end(&self, event: &EmbeddingModelCallEndEvent) {
        self.each(|i| i.on_embed_end(event, &self.meta));
    }

    pub fn on_end(&self, event: &OperationEndEvent) {
        self.each(|i| i.on_end(event, &self.meta));
    }

    pub fn on_error(&self, call_id: &str, error: &anyhow::Error) {
        self.each(|i| i.on_error(call_id, error, &self.meta));
    }
}
