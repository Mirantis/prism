//! The Converse chat model (`AmazonBedrockChatLanguageModel`): the request, one
//! `POST /model/{id}/converse`, and the response as content, usage and metadata.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::api::{
    FetchFunction, combine_headers, encode_uri_component, failed_response_error,
    parse_json_response, post_json,
};
use super::convert_messages::{
    convert_to_amazon_bedrock_chat_messages, is_mistral_model, normalize_tool_call_id,
};
use super::prepare_tools::{PrepareToolsInput, prepare_tools};
use super::{is_anthropic_model, supports_native_structured_output, supports_strict_tools};
use crate::ai::errors::InvalidArgumentError;
use crate::ai::json::js_stringify;
use crate::ai::model::LanguageModel;
use crate::ai::provider::{
    FinishReason, Headers, LanguageModelV4CallOptions, LanguageModelV4Content,
    LanguageModelV4FinishReason, LanguageModelV4FunctionTool, LanguageModelV4GenerateResult,
    LanguageModelV4InputTokens, LanguageModelV4Message, LanguageModelV4OutputTokens,
    LanguageModelV4Part, LanguageModelV4Request, LanguageModelV4Response,
    LanguageModelV4ResponseFormat, LanguageModelV4Tool, LanguageModelV4ToolChoice,
    LanguageModelV4Usage, ProviderOptions, SupportedUrls, Warning,
};
use crate::ai::providers::anthropic::{get_model_capabilities, sanitize_json_schema};
use crate::support::js;

/// What a Converse model needs from its provider.
pub struct ChatConfig {
    pub base_url: Arc<dyn Fn() -> anyhow::Result<String> + Send + Sync>,
    pub headers: Arc<dyn Fn() -> Headers + Send + Sync>,
    pub fetch: FetchFunction,
    pub generate_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub model_family: Option<String>,
}

/// A Converse model (`amazon-bedrock`).
pub struct AmazonBedrockChatLanguageModel {
    model_id: String,
    config: Arc<ChatConfig>,
}

impl AmazonBedrockChatLanguageModel {
    pub fn new(model_id: &str, config: Arc<ChatConfig>) -> Self {
        Self {
            model_id: model_id.to_string(),
            config,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StructuredOutputMode {
    OutputFormat,
    JsonTool,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ThinkingType {
    Enabled,
    Disabled,
    Adaptive,
}

impl ThinkingType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Adaptive => "adaptive",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningConfig {
    #[serde(rename = "type")]
    thinking_type: Option<ThinkingType>,
    budget_tokens: Option<f64>,
    max_reasoning_effort: Option<MaxReasoningEffort>,
    display: Option<ThinkingDisplay>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MaxReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl MaxReasoningEffort {
    fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ThinkingDisplay {
    Omitted,
    Summarized,
}

impl ThinkingDisplay {
    fn as_str(self) -> &'static str {
        match self {
            Self::Omitted => "omitted",
            Self::Summarized => "summarized",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ServiceTier {
    Reserved,
    Priority,
    Default,
    Flex,
}

impl ServiceTier {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Priority => "priority",
            Self::Default => "default",
            Self::Flex => "flex",
        }
    }
}

/// `amazonBedrockLanguageModelChatOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatOptions {
    structured_output_mode: Option<StructuredOutputMode>,
    additional_model_request_fields: Option<Map<String, Value>>,
    reasoning_config: Option<ReasoningConfig>,
    anthropic_beta: Option<Vec<String>>,
    service_tier: Option<ServiceTier>,
    request_metadata: Option<indexmap::IndexMap<String, String>>,
}

/// The `anthropic` options Converse reads.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnthropicOptions {
    disable_parallel_tool_use: Option<bool>,
    structured_output_mode: Option<StructuredOutputMode>,
}

/// `parseProviderOptions`: `None` when the provider has no options, an error when
/// they do not match the schema.
fn parse_provider_options<T: serde::de::DeserializeOwned>(
    provider: &str,
    provider_options: Option<&ProviderOptions>,
) -> anyhow::Result<Option<T>> {
    let Some(value) = provider_options
        .and_then(|o| o.get(provider))
        .filter(|v| !v.is_null())
    else {
        return Ok(None);
    };
    let parsed = if value.is_object() {
        serde_json::from_value::<T>(value.clone()).ok()
    } else {
        None
    };
    match parsed {
        Some(parsed) => Ok(Some(parsed)),
        None => Err(InvalidArgumentError {
            message: format!("invalid {provider} provider options"),
            parameter: "providerOptions".to_string(),
            value: Value::Null,
        }
        .into()),
    }
}

/// What `get_args` builds.
struct Args {
    command: Value,
    warnings: Vec<Warning>,
    uses_json_instruction: bool,
    uses_json_response_tool: bool,
}

fn unsupported(feature: &str, details: Option<String>) -> Warning {
    Warning::Unsupported {
        feature: feature.to_string(),
        details,
    }
}

/// A JSON number as JavaScript writes it.
fn number(value: f64) -> Value {
    js::number(value)
}

/// `isNova2ReasoningModel`.
fn is_nova2_reasoning_model(model_id: &str) -> bool {
    model_id.contains("amazon.nova-2-lite-v1:0")
}

/// `injectJsonInstructionIntoMessages` with the Converse suffix.
fn inject_json_instruction(
    prompt: Vec<LanguageModelV4Message>,
    schema: Option<&Value>,
) -> Vec<LanguageModelV4Message> {
    const SUFFIX: &str = "You MUST answer with only a JSON object that matches the JSON schema above. Do not wrap it in markdown fences or include any other text.";
    let mut rest = prompt;
    let (existing, provider_options) = match rest.first() {
        Some(LanguageModelV4Message::System {
            content,
            provider_options,
        }) => {
            let pair = (content.clone(), provider_options.clone());
            rest.remove(0);
            pair
        }
        _ => (String::new(), None),
    };
    let mut lines: Vec<String> = Vec::new();
    if !existing.is_empty() {
        lines.push(existing);
        lines.push(String::new());
    }
    if let Some(schema) = schema {
        lines.push("JSON schema:".to_string());
        lines.push(js_stringify(schema));
    }
    lines.push(SUFFIX.to_string());
    let system = LanguageModelV4Message::System {
        content: lines.join("\n"),
        provider_options,
    };
    std::iter::once(system).chain(rest).collect()
}

impl AmazonBedrockChatLanguageModel {
    fn get_args(&self, options: &LanguageModelV4CallOptions) -> anyhow::Result<Args> {
        let provider_options = options.provider_options.as_ref();
        let mut bedrock: ChatOptions =
            match parse_provider_options::<ChatOptions>("amazonBedrock", provider_options)? {
                Some(parsed) => parsed,
                None => parse_provider_options::<ChatOptions>("bedrock", provider_options)?
                    .unwrap_or_default(),
            };
        let anthropic: Option<AnthropicOptions> =
            parse_provider_options("anthropic", provider_options)?;

        let mut warnings: Vec<Warning> = Vec::new();
        let capabilities = get_model_capabilities(&self.model_id);

        if options.frequency_penalty.is_some() {
            warnings.push(unsupported("frequencyPenalty", None));
        }
        if options.presence_penalty.is_some() {
            warnings.push(unsupported("presencePenalty", None));
        }
        if options.seed.is_some() {
            warnings.push(unsupported("seed", None));
        }

        let mut temperature = options.temperature;
        let mut top_k = options.top_k;
        let mut top_p = options.top_p;
        if capabilities.rejects_sampling_parameters {
            let model_id = &self.model_id;
            if temperature.is_some() {
                warnings.push(unsupported(
                    "temperature",
                    Some(format!(
                        "temperature is not supported by {model_id} and will be ignored"
                    )),
                ));
                temperature = None;
            }
            if top_k.is_some() {
                warnings.push(unsupported(
                    "topK",
                    Some(format!(
                        "topK is not supported by {model_id} and will be ignored"
                    )),
                ));
                top_k = None;
            }
            if top_p.is_some() {
                warnings.push(unsupported(
                    "topP",
                    Some(format!(
                        "topP is not supported by {model_id} and will be ignored"
                    )),
                ));
                top_p = None;
            }
        }

        static OPENAI_MODEL_ID: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^(?:[^.]+\.)?(openai\..+)$").expect("valid regex"));
        let openai_model_id = OPENAI_MODEL_ID
            .captures(&self.model_id)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        let is_openai_model = openai_model_id.is_some();
        let is_openai_gpt_oss_model = openai_model_id
            .as_deref()
            .is_some_and(|id| id.starts_with("openai.gpt-oss-"));
        let is_nova_reasoning_model = is_nova2_reasoning_model(&self.model_id);
        let should_normalize_temperature = !is_openai_model || is_openai_gpt_oss_model;

        if let Some(value) = temperature.filter(|_| should_normalize_temperature) {
            if value > 1.0 {
                warnings.push(unsupported(
                    "temperature",
                    Some(format!(
                        "{} exceeds bedrock maximum of 1.0. clamped to 1.0",
                        js::number_text(value)
                    )),
                ));
                temperature = Some(1.0);
            } else if value < 0.0 {
                warnings.push(unsupported(
                    "temperature",
                    Some(format!(
                        "{} is below bedrock minimum of 0. clamped to 0",
                        js::number_text(value)
                    )),
                ));
                temperature = Some(0.0);
            }
        }

        let is_anthropic = is_anthropic_model(
            &self.model_id,
            self.config.model_family.as_deref(),
            bedrock
                .reasoning_config
                .as_ref()
                .and_then(|r| r.budget_tokens),
        );

        let thinking_type = bedrock
            .reasoning_config
            .as_ref()
            .and_then(|r| r.thinking_type);
        let is_thinking_enabled = matches!(
            thinking_type,
            Some(ThinkingType::Enabled) | Some(ThinkingType::Adaptive)
        );

        let structured_output_mode = bedrock
            .structured_output_mode
            .or(anthropic.as_ref().and_then(|a| a.structured_output_mode))
            .unwrap_or(StructuredOutputMode::Auto);

        if structured_output_mode == StructuredOutputMode::JsonTool
            && let Some(fields) = bedrock.additional_model_request_fields.as_mut()
            && let Some(Value::Object(output_config)) = fields.get("output_config").cloned()
        {
            let mut without_format = output_config;
            without_format.remove("format");
            if without_format.is_empty() {
                fields.remove("output_config");
            } else {
                fields.insert("output_config".into(), Value::Object(without_format));
            }
        }

        let response_schema = match &options.response_format {
            Some(LanguageModelV4ResponseFormat::Json {
                schema: Some(schema),
                ..
            }) => Some(schema.clone()),
            _ => None,
        };
        let tools = options.tools.as_deref();
        let model_supports_native_structured_output =
            supports_native_structured_output(&self.model_id)
                && (capabilities.supports_structured_output
                    || is_thinking_enabled
                    || self.config.model_family.as_deref() == Some("anthropic"));
        let use_native_structured_output = is_anthropic
            && response_schema.is_some()
            && (structured_output_mode == StructuredOutputMode::OutputFormat
                || (structured_output_mode == StructuredOutputMode::Auto
                    && model_supports_native_structured_output));
        let use_json_instruction = !use_native_structured_output
            && is_anthropic
            && response_schema.is_some()
            && (capabilities.rejects_forced_tool_use
                || (structured_output_mode != StructuredOutputMode::JsonTool
                    && !supports_strict_tools(&self.model_id)
                    && tools.is_some_and(|t| !t.is_empty())));

        let json_response_tool = match &response_schema {
            Some(schema) if !use_native_structured_output && !use_json_instruction => {
                Some(LanguageModelV4Tool::Function(LanguageModelV4FunctionTool {
                    name: "json".to_string(),
                    input_schema: schema.clone(),
                    description: Some("Respond with a JSON object.".to_string()),
                    input_examples: None,
                    provider_options: None,
                    strict: None,
                }))
            }
            _ => None,
        };

        let tools_with_json: Option<Vec<LanguageModelV4Tool>> = match &json_response_tool {
            Some(tool) => Some(
                tools
                    .unwrap_or_default()
                    .iter()
                    .cloned()
                    .chain(std::iter::once(tool.clone()))
                    .collect(),
            ),
            None => options.tools.clone(),
        };
        let tool_choice = if json_response_tool.is_some() {
            Some(LanguageModelV4ToolChoice::Required)
        } else {
            options.tool_choice.clone()
        };
        let prepared = prepare_tools(PrepareToolsInput {
            tools: tools_with_json.as_deref(),
            tool_choice: tool_choice.as_ref(),
            model_id: &self.model_id,
            model_family: self.config.model_family.as_deref(),
            reasoning_budget_tokens: bedrock
                .reasoning_config
                .as_ref()
                .and_then(|r| r.budget_tokens),
            disable_parallel_tool_use: anthropic.as_ref().and_then(|a| a.disable_parallel_tool_use),
            rejects_forced_tool_use: capabilities.rejects_forced_tool_use,
        })?;
        warnings.extend(prepared.tool_warnings.iter().cloned());

        if let Some(additional) = &prepared.additional_tools {
            let fields = bedrock
                .additional_model_request_fields
                .get_or_insert_with(Map::new);
            for (key, value) in additional {
                fields.insert(key.clone(), value.clone());
            }
        }

        if !prepared.betas.is_empty() || bedrock.anthropic_beta.is_some() {
            let mut merged = bedrock.anthropic_beta.clone().unwrap_or_default();
            merged.extend(prepared.betas.iter().cloned());
            bedrock
                .additional_model_request_fields
                .get_or_insert_with(Map::new)
                .insert("anthropic_beta".into(), json!(merged));
        }

        let reasoning = bedrock.reasoning_config.clone().unwrap_or_default();
        let thinking_budget = match thinking_type {
            Some(ThinkingType::Enabled) => reasoning.budget_tokens,
            _ => None,
        };
        let thinking_display = match thinking_type {
            Some(ThinkingType::Adaptive) => reasoning.display,
            _ => None,
        };
        let is_anthropic_thinking_enabled = is_anthropic && is_thinking_enabled;

        let mut inference_config = Map::new();
        if let Some(max) = options.max_output_tokens {
            inference_config.insert("maxTokens".into(), json!(max));
        }
        if let Some(value) = temperature {
            inference_config.insert("temperature".into(), number(value));
        }
        if let Some(value) = top_p {
            inference_config.insert("topP".into(), number(value));
        }
        if let Some(value) = top_k {
            inference_config.insert("topK".into(), number(value));
        }
        if let Some(stops) = &options.stop_sequences {
            inference_config.insert("stopSequences".into(), json!(stops));
        }

        if is_anthropic_thinking_enabled {
            if let Some(budget) = thinking_budget {
                let max_tokens = match inference_config.get("maxTokens").and_then(Value::as_f64) {
                    Some(max) => max + budget,
                    // The SDK's default of 4096 plus the thinking budget.
                    None => budget + 4096.0,
                };
                inference_config.insert("maxTokens".into(), number(max_tokens));
                bedrock
                    .additional_model_request_fields
                    .get_or_insert_with(Map::new)
                    .insert(
                        "thinking".into(),
                        json!({ "type": "enabled", "budget_tokens": number(budget) }),
                    );
            } else if thinking_type == Some(ThinkingType::Adaptive) {
                let mut thinking = Map::new();
                thinking.insert("type".into(), json!("adaptive"));
                if let Some(display) = thinking_display {
                    thinking.insert("display".into(), json!(display.as_str()));
                }
                bedrock
                    .additional_model_request_fields
                    .get_or_insert_with(Map::new)
                    .insert("thinking".into(), Value::Object(thinking));
            }
        } else if !is_anthropic {
            if reasoning.budget_tokens.is_some() {
                warnings.push(unsupported(
                    "budgetTokens",
                    Some("budgetTokens applies only to Anthropic models on Bedrock and will be ignored for this model.".to_string()),
                ));
            }
            if thinking_type == Some(ThinkingType::Adaptive) {
                warnings.push(unsupported(
                    "adaptive thinking",
                    Some(
                        "adaptive thinking type applies only to Anthropic models on Bedrock."
                            .to_string(),
                    ),
                ));
            }
        }

        if let Some(effort) = reasoning.max_reasoning_effort {
            let fields = bedrock
                .additional_model_request_fields
                .get_or_insert_with(Map::new);
            if is_anthropic {
                let mut output_config = fields
                    .get("output_config")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                output_config.insert("effort".into(), json!(effort.as_str()));
                fields.insert("output_config".into(), Value::Object(output_config));
            } else if is_openai_model {
                if is_openai_gpt_oss_model {
                    fields.insert("reasoning_effort".into(), json!(effort.as_str()));
                } else {
                    let mut reasoning_field = fields
                        .get("reasoning")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    reasoning_field.insert("effort".into(), json!(effort.as_str()));
                    fields.insert("reasoning".into(), Value::Object(reasoning_field));
                }
            } else {
                let mut config = Map::new();
                if let Some(t) = thinking_type.filter(|t| *t != ThinkingType::Adaptive) {
                    config.insert("type".into(), json!(t.as_str()));
                }
                if let Some(budget) = thinking_budget {
                    config.insert("budgetTokens".into(), number(budget));
                }
                config.insert("maxReasoningEffort".into(), json!(effort.as_str()));
                fields.insert("reasoningConfig".into(), Value::Object(config));
            }
        }

        if is_nova_reasoning_model
            && thinking_type == Some(ThinkingType::Enabled)
            && matches!(
                reasoning.max_reasoning_effort,
                Some(MaxReasoningEffort::High)
                    | Some(MaxReasoningEffort::Xhigh)
                    | Some(MaxReasoningEffort::Max)
            )
            && inference_config.contains_key("maxTokens")
        {
            inference_config.shift_remove("maxTokens");
            warnings.push(unsupported(
                "maxOutputTokens",
                Some(format!(
                    "maxOutputTokens is not supported by {} when high reasoning is enabled and will be ignored",
                    self.model_id
                )),
            ));
        }

        if use_native_structured_output && let Some(schema) = &response_schema {
            let fields = bedrock
                .additional_model_request_fields
                .get_or_insert_with(Map::new);
            let mut output_config = fields
                .get("output_config")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            output_config.insert(
                "format".into(),
                json!({ "type": "json_schema", "schema": sanitize_json_schema(schema) }),
            );
            fields.insert("output_config".into(), Value::Object(output_config));
        }

        if is_anthropic_thinking_enabled {
            for (key, feature, details) in [
                (
                    "temperature",
                    "temperature",
                    "temperature is not supported when thinking is enabled",
                ),
                (
                    "topP",
                    "topP",
                    "topP is not supported when thinking is enabled",
                ),
                (
                    "topK",
                    "topK",
                    "topK is not supported when thinking is enabled",
                ),
            ] {
                if inference_config.contains_key(key) {
                    inference_config.shift_remove(key);
                    warnings.push(unsupported(feature, Some(details.to_string())));
                }
            }
        }

        // OpenAI models refuse stopSequences on Converse; all but gpt-oss also
        // refuse temperature and topP.
        if is_openai_model {
            let features: &[&str] = if is_openai_gpt_oss_model {
                &["stopSequences"]
            } else {
                &["temperature", "topP", "stopSequences"]
            };
            for feature in features {
                if inference_config.contains_key(*feature) {
                    inference_config.shift_remove(*feature);
                    warnings.push(unsupported(
                        feature,
                        Some(format!(
                            "{feature} is not supported by this OpenAI model on the Converse API"
                        )),
                    ));
                }
            }
        }

        let tool_config = prepared.tool_config;
        let has_any_tools = tool_config
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|t| !t.is_empty())
            || prepared.additional_tools.is_some();
        let mut prompt = options.prompt.clone();
        if !has_any_tools {
            let has_tool_content = prompt.iter().any(|message| {
                message.parts().is_some_and(|parts| {
                    parts.iter().any(|p| {
                        matches!(
                            p,
                            LanguageModelV4Part::ToolCall { .. }
                                | LanguageModelV4Part::ToolResult { .. }
                        )
                    })
                })
            });
            if has_tool_content {
                prompt = prompt
                    .into_iter()
                    .filter_map(|mut message| {
                        if let Some(parts) = message.parts_mut() {
                            parts.retain(|p| {
                                !matches!(
                                    p,
                                    LanguageModelV4Part::ToolCall { .. }
                                        | LanguageModelV4Part::ToolResult { .. }
                                )
                            });
                            if parts.is_empty() {
                                return None;
                            }
                        }
                        Some(message)
                    })
                    .collect();
                warnings.push(unsupported(
                    "toolContent",
                    Some("Tool calls and results removed from conversation because Bedrock does not support tool content without active tools.".to_string()),
                ));
            }
        }

        if use_json_instruction {
            prompt = inject_json_instruction(prompt, response_schema.as_ref());
        }

        let converted =
            convert_to_amazon_bedrock_chat_messages(&prompt, is_mistral_model(&self.model_id))?;

        let mut filtered_options = provider_options
            .and_then(|o| {
                o.get("amazonBedrock")
                    .filter(|v| !v.is_null())
                    .or_else(|| o.get("bedrock").filter(|v| !v.is_null()))
            })
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in [
            "reasoningConfig",
            "additionalModelRequestFields",
            "serviceTier",
            "structuredOutputMode",
            "requestMetadata",
        ] {
            filtered_options.shift_remove(key);
        }

        let mut command = Map::new();
        command.insert("system".into(), Value::Array(converted.system));
        command.insert("messages".into(), Value::Array(converted.messages));
        if let Some(fields) = bedrock.additional_model_request_fields {
            command.insert("additionalModelRequestFields".into(), Value::Object(fields));
        }
        if is_anthropic {
            command.insert(
                "additionalModelResponseFieldPaths".into(),
                json!(["/delta/stop_sequence"]),
            );
        }
        if !inference_config.is_empty() {
            command.insert("inferenceConfig".into(), Value::Object(inference_config));
        }
        if let Some(tier) = bedrock.service_tier {
            command.insert("serviceTier".into(), json!({ "type": tier.as_str() }));
        }
        if let Some(metadata) = bedrock.request_metadata {
            command.insert("requestMetadata".into(), json!(metadata));
        }
        for (key, value) in filtered_options {
            command.insert(key, value);
        }
        if tool_config
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|t| !t.is_empty())
        {
            command.insert("toolConfig".into(), Value::Object(tool_config));
        }

        Ok(Args {
            command: Value::Object(command),
            warnings,
            uses_json_instruction: use_json_instruction,
            uses_json_response_tool: json_response_tool.is_some(),
        })
    }
}

/// Keeps the first JSON object of a text, when the model was asked for JSON in the
/// prompt and may wrap it in prose.
#[derive(Default)]
struct JsonObjectTextExtractor {
    started: bool,
    completed: bool,
    depth: i64,
    in_string: bool,
    escaped: bool,
}

impl JsonObjectTextExtractor {
    fn process(&mut self, text: &str) -> String {
        let mut result = String::new();
        for character in text.chars() {
            if self.completed {
                break;
            }
            if !self.started {
                if character != '{' {
                    continue;
                }
                self.started = true;
                self.depth = 1;
                result.push(character);
                continue;
            }
            result.push(character);
            if self.escaped {
                self.escaped = false;
                continue;
            }
            if character == '\\' && self.in_string {
                self.escaped = true;
                continue;
            }
            if character == '"' {
                self.in_string = !self.in_string;
                continue;
            }
            if self.in_string {
                continue;
            }
            if character == '{' {
                self.depth += 1;
            } else if character == '}' {
                self.depth -= 1;
                if self.depth == 0 {
                    self.completed = true;
                }
            }
        }
        result
    }
}

/// `mapAmazonBedrockFinishReason`.
fn map_finish_reason(finish_reason: &str, is_json_response_from_tool: bool) -> FinishReason {
    match finish_reason {
        "stop_sequence" | "end_turn" => FinishReason::Stop,
        "max_tokens" => FinishReason::Length,
        "content_filtered" | "guardrail_intervened" => FinishReason::ContentFilter,
        "tool_use" if is_json_response_from_tool => FinishReason::Stop,
        "tool_use" => FinishReason::ToolCalls,
        _ => FinishReason::Other,
    }
}

// The response, as far as the SDK's schema reads it.

#[derive(Deserialize)]
#[allow(dead_code)]
struct Metrics {
    #[serde(rename = "latencyMs")]
    latency_ms: f64,
}

#[derive(Deserialize)]
struct CitationText {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize)]
struct CitationsContent {
    #[serde(default)]
    content: Option<Vec<CitationText>>,
}

#[derive(Deserialize)]
struct ToolUse {
    #[serde(rename = "toolUseId")]
    tool_use_id: String,
    name: String,
    #[serde(default)]
    input: Option<Value>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(default)]
    text: Option<String>,
    #[serde(default, rename = "citationsContent")]
    citations_content: Option<CitationsContent>,
    #[serde(default, rename = "toolUse")]
    tool_use: Option<ToolUse>,
    #[serde(default, rename = "reasoningContent")]
    reasoning_content: Option<Value>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OutputMessage {
    content: Vec<ContentBlock>,
    role: String,
}

#[derive(Deserialize)]
struct Output {
    message: OutputMessage,
}

#[derive(Deserialize)]
struct ResponseDelta {
    #[serde(default)]
    stop_sequence: Option<String>,
}

#[derive(Deserialize)]
struct AdditionalResponseFields {
    #[serde(default)]
    delta: Option<ResponseDelta>,
}

#[derive(Deserialize)]
struct PerformanceConfig {
    latency: String,
}

#[derive(Deserialize)]
struct ServiceTierResponse {
    #[serde(rename = "type")]
    tier_type: String,
}

#[derive(Deserialize)]
struct CacheDetail {
    #[serde(rename = "inputTokens")]
    #[allow(dead_code)]
    input_tokens: f64,
    #[allow(dead_code)]
    ttl: String,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(rename = "inputTokens")]
    input_tokens: f64,
    #[serde(rename = "outputTokens")]
    output_tokens: f64,
    #[serde(rename = "totalTokens")]
    #[allow(dead_code)]
    total_tokens: f64,
    #[serde(default, rename = "cacheReadInputTokens")]
    cache_read_input_tokens: Option<f64>,
    #[serde(default, rename = "cacheWriteInputTokens")]
    cache_write_input_tokens: Option<f64>,
    #[serde(default, rename = "cacheDetails")]
    cache_details: Option<Vec<CacheDetail>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ConverseResponse {
    #[serde(default)]
    metrics: Option<Metrics>,
    output: Output,
    #[serde(rename = "stopReason")]
    stop_reason: String,
    #[serde(default, rename = "additionalModelResponseFields")]
    additional_model_response_fields: Option<AdditionalResponseFields>,
    #[serde(default)]
    trace: Option<Value>,
    #[serde(default, rename = "performanceConfig")]
    performance_config: Option<PerformanceConfig>,
    #[serde(default, rename = "serviceTier")]
    service_tier: Option<ServiceTierResponse>,
    usage: Usage,
}

/// The parsed object zod returns for one with a catch-all: the schema's keys in
/// schema order, then the others in input order.
fn zod_order(raw: &Value, known: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(object) = raw.as_object() else {
        return out;
    };
    for key in known {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    for (key, value) in object {
        if !known.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// The usage object as the response schema returns it.
fn raw_usage(raw: &Value) -> Map<String, Value> {
    let mut usage = zod_order(
        raw,
        &[
            "inputTokens",
            "outputTokens",
            "totalTokens",
            "cacheReadInputTokens",
            "cacheWriteInputTokens",
            "cacheDetails",
        ],
    );
    if let Some(Value::Array(details)) = usage.get("cacheDetails").cloned() {
        let ordered: Vec<Value> = details
            .iter()
            .map(|d| Value::Object(zod_order(d, &["inputTokens", "ttl"])))
            .collect();
        usage.insert("cacheDetails".into(), Value::Array(ordered));
    }
    usage
}

/// `convertAmazonBedrockUsage`.
fn convert_usage(usage: &Usage, raw: Map<String, Value>) -> LanguageModelV4Usage {
    let input = usage.input_tokens as i64;
    let output = usage.output_tokens as i64;
    let cache_read = usage.cache_read_input_tokens.unwrap_or(0.0) as i64;
    let cache_write = usage.cache_write_input_tokens.unwrap_or(0.0) as i64;
    LanguageModelV4Usage {
        input_tokens: LanguageModelV4InputTokens {
            total: Some(input + cache_read + cache_write),
            no_cache: Some(input),
            cache_read: Some(cache_read),
            cache_write: Some(cache_write),
        },
        output_tokens: LanguageModelV4OutputTokens {
            total: Some(output),
            text: Some(output),
            reasoning: None,
        },
        raw: Some(raw),
    }
}

fn reasoning_metadata(payload: Value) -> Map<String, Value> {
    let mut metadata = Map::new();
    metadata.insert("amazonBedrock".into(), payload.clone());
    metadata.insert("bedrock".into(), payload);
    metadata
}

#[async_trait]
impl LanguageModel for AmazonBedrockChatLanguageModel {
    fn provider(&self) -> &str {
        "amazon-bedrock"
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn supported_urls(&self) -> SupportedUrls {
        let s3 = Regex::new(r"^s3://").expect("valid regex");
        let mut urls = SupportedUrls::new();
        urls.insert("image/*".to_string(), vec![s3.clone()]);
        urls.insert("video/*".to_string(), vec![s3]);
        urls
    }

    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        let Args {
            command,
            warnings,
            uses_json_instruction,
            uses_json_response_tool,
        } = self.get_args(&options)?;

        let url = format!(
            "{}/model/{}/converse",
            (self.config.base_url)()?,
            encode_uri_component(&self.model_id)
        );
        let config_headers = (self.config.headers)();
        let headers = combine_headers(&[Some(&config_headers), options.headers.as_ref()]);
        let response = post_json(
            &url,
            &headers,
            &command,
            options.abort_signal.as_ref(),
            &self.config.fetch,
        )
        .await?;
        if !response.ok() {
            return Err(failed_response_error(&response, &url, &command, |error| {
                error.message.clone()
            }));
        }
        let (parsed, raw): (ConverseResponse, Value) =
            parse_json_response(&response, &url, &command)?;
        let response_headers = response.headers.clone();

        let mut content: Vec<LanguageModelV4Content> = Vec::new();
        let mut is_json_response_from_tool = false;
        let mut extractor = uses_json_instruction.then(JsonObjectTextExtractor::default);
        let is_mistral = is_mistral_model(&self.model_id);

        for part in &parsed.output.message.content {
            let texts: Vec<&String> = match &part.text {
                Some(text) => vec![text],
                None => part
                    .citations_content
                    .as_ref()
                    .and_then(|c| c.content.as_ref())
                    .map(|items| items.iter().filter_map(|i| i.text.as_ref()).collect())
                    .unwrap_or_default(),
            };
            for text in texts {
                let text = match extractor.as_mut() {
                    Some(extractor) => extractor.process(text),
                    None => text.clone(),
                };
                content.push(LanguageModelV4Content::Text {
                    text,
                    provider_metadata: None,
                });
            }

            if let Some(reasoning) = &part.reasoning_content {
                if let Some(text_block) = reasoning.get("reasoningText") {
                    let text = text_block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let signature = text_block
                        .get("signature")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty());
                    content.push(LanguageModelV4Content::Reasoning {
                        text,
                        provider_metadata: signature
                            .map(|s| reasoning_metadata(json!({ "signature": s }))),
                    });
                } else if let Some(redacted) = reasoning.get("redactedReasoning") {
                    let data = redacted.get("data").and_then(Value::as_str).unwrap_or("");
                    content.push(LanguageModelV4Content::Reasoning {
                        text: String::new(),
                        provider_metadata: Some(reasoning_metadata(
                            json!({ "redactedData": data }),
                        )),
                    });
                } else if let Some(redacted) = reasoning.get("redactedContent") {
                    content.push(LanguageModelV4Content::Reasoning {
                        text: String::new(),
                        provider_metadata: Some(reasoning_metadata(
                            json!({ "redactedContent": redacted }),
                        )),
                    });
                }
            }

            if let Some(tool_use) = &part.tool_use {
                if uses_json_response_tool && tool_use.name == "json" {
                    is_json_response_from_tool = true;
                    content.push(LanguageModelV4Content::Text {
                        text: js_stringify(tool_use.input.as_ref().unwrap_or(&Value::Null)),
                        provider_metadata: None,
                    });
                } else {
                    let raw_id = if tool_use.tool_use_id.is_empty() {
                        (self.config.generate_id)()
                    } else {
                        tool_use.tool_use_id.clone()
                    };
                    let input = match &tool_use.input {
                        Some(input) if !input.is_null() => js_stringify(input),
                        _ => "{}".to_string(),
                    };
                    content.push(LanguageModelV4Content::ToolCall {
                        tool_call_id: normalize_tool_call_id(&raw_id, is_mistral),
                        tool_name: tool_use.name.clone(),
                        input,
                        provider_executed: None,
                        dynamic: None,
                        provider_metadata: None,
                    });
                }
            }
        }

        let stop_sequence = parsed
            .additional_model_response_fields
            .as_ref()
            .and_then(|f| f.delta.as_ref())
            .and_then(|d| d.stop_sequence.clone());
        let raw_usage = raw_usage(raw.get("usage").unwrap_or(&Value::Null));

        // The schema requires `usage`, so the metadata is always present.
        let mut payload = Map::new();
        if let Some(trace) = parsed.trace.as_ref().filter(|t| t.is_object()) {
            payload.insert("trace".into(), trace.clone());
        }
        if let Some(performance) = &parsed.performance_config {
            payload.insert(
                "performanceConfig".into(),
                json!({ "latency": performance.latency }),
            );
        }
        if let Some(tier) = &parsed.service_tier {
            payload.insert("serviceTier".into(), json!({ "type": tier.tier_type }));
        }
        if parsed.usage.cache_write_input_tokens.is_some() || parsed.usage.cache_details.is_some() {
            let mut usage = Map::new();
            if let Some(write) = raw_usage
                .get("cacheWriteInputTokens")
                .filter(|v| !v.is_null())
            {
                usage.insert("cacheWriteInputTokens".into(), write.clone());
            }
            if let Some(details) = raw_usage.get("cacheDetails").filter(|v| !v.is_null()) {
                usage.insert("cacheDetails".into(), details.clone());
            }
            payload.insert("usage".into(), Value::Object(usage));
        }
        if is_json_response_from_tool {
            payload.insert("isJsonResponseFromTool".into(), json!(true));
        }
        payload.insert("stopSequence".into(), json!(stop_sequence));
        let payload = Value::Object(payload);
        let mut provider_metadata = Map::new();
        provider_metadata.insert("amazonBedrock".into(), payload.clone());
        provider_metadata.insert("bedrock".into(), payload);

        let timestamp = response_headers
            .get("date")
            .and_then(|d| chrono::DateTime::parse_from_rfc2822(d).ok())
            .map(|d| d.with_timezone(&chrono::Utc));

        Ok(LanguageModelV4GenerateResult {
            content,
            finish_reason: LanguageModelV4FinishReason {
                unified: map_finish_reason(&parsed.stop_reason, is_json_response_from_tool),
                raw: Some(parsed.stop_reason.clone()),
            },
            usage: convert_usage(&parsed.usage, raw_usage),
            provider_metadata: Some(provider_metadata),
            request: Some(LanguageModelV4Request {
                body: Some(command),
            }),
            response: Some(LanguageModelV4Response {
                id: response_headers.get("x-amzn-requestid").cloned(),
                timestamp,
                model_id: Some(self.model_id.clone()),
                headers: Some(response_headers),
                body: None,
            }),
            warnings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_first_json_object_across_chunks() {
        let mut extractor = JsonObjectTextExtractor::default();
        assert_eq!(
            extractor.process("Sure: {\"a\": \"}\\\"\", "),
            "{\"a\": \"}\\\"\", "
        );
        assert_eq!(extractor.process("\"b\": {}} trailing {"), "\"b\": {}}");
        assert_eq!(extractor.process("more"), "");
    }

    #[test]
    fn maps_stop_reasons() {
        assert_eq!(map_finish_reason("end_turn", false), FinishReason::Stop);
        assert_eq!(map_finish_reason("tool_use", true), FinishReason::Stop);
        assert_eq!(
            map_finish_reason("tool_use", false),
            FinishReason::ToolCalls
        );
        assert_eq!(
            map_finish_reason("guardrail_intervened", false),
            FinishReason::ContentFilter
        );
        assert_eq!(
            map_finish_reason("something_new", false),
            FinishReason::Other
        );
    }

    #[test]
    fn injects_the_json_instruction_into_the_system_message() {
        let prompt: Vec<LanguageModelV4Message> = serde_json::from_value(json!([
            { "role": "system", "content": "Be brief." },
            { "role": "user", "content": [{ "type": "text", "text": "Hi" }] }
        ]))
        .unwrap();
        let injected = inject_json_instruction(prompt, Some(&json!({ "type": "object" })));
        assert_eq!(
            serde_json::to_value(&injected).unwrap()[0]["content"],
            "Be brief.\n\nJSON schema:\n{\"type\":\"object\"}\nYou MUST answer with only a JSON object that matches the JSON schema above. Do not wrap it in markdown fences or include any other text."
        );
        assert_eq!(injected.len(), 2);
    }
}
