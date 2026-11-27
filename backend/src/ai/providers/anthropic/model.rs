//! `AnthropicLanguageModel`: one Messages API call (`doGenerate`), from the call
//! options to the request body and from the response to the generate result.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use futures::future::BoxFuture;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::cache_control::CacheControlValidator;
use super::fetch::{FetchFunction, invalid_response, post_json_to_api};
use super::options::{
    AnthropicLanguageModelOptions, ContextManagementEdit, Effort, Fallbacks, SkillOption,
    StructuredOutputMode, Thinking, ThinkingDisplay, ThinkingType, parse_provider_options,
};
use super::prompt::{convert_to_anthropic_prompt, object};
use super::response::{
    CitationDocument, ContentContext, convert_anthropic_usage, map_anthropic_stop_reason,
    map_content, parse_response, response_metadata,
};
use super::tools::{PROVIDER_TOOL_NAMES, PrepareToolsInput, prepare_tools};
use crate::ai::generate_text::generate_id;
use crate::ai::json::js_number_text;
use crate::ai::providers::provider_utils::ToolNameMapping;
use crate::ai::{
    Headers, InvalidArgumentError, LanguageModel, LanguageModelV4CallOptions,
    LanguageModelV4FinishReason, LanguageModelV4FunctionTool, LanguageModelV4GenerateResult,
    LanguageModelV4Message, LanguageModelV4Part, LanguageModelV4Request, LanguageModelV4Response,
    LanguageModelV4ResponseFormat, LanguageModelV4Tool, LanguageModelV4ToolChoice, ReasoningEffort,
    SupportedUrls, Warning,
};
use crate::support::js::number;

/// The request headers a model sends, resolved on each call; resolving can fail
/// (a missing API key).
pub type HeadersFunction =
    Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Headers>> + Send + Sync>;

/// `buildRequestUrl(baseURL, isStreaming)`.
pub type BuildRequestUrlFunction = Arc<dyn Fn(&str, bool) -> String + Send + Sync>;

/// `transformRequestBody(args, betas)`: the body actually sent, from the Messages
/// API arguments and the request's betas.
pub type TransformRequestBodyFunction =
    Arc<dyn Fn(Value, &IndexSet<String>) -> Value + Send + Sync>;

/// `supportedUrls()`.
pub type SupportedUrlsFunction = Arc<dyn Fn() -> SupportedUrls + Send + Sync>;

/// `generateId()`.
pub type GenerateIdFunction = Arc<dyn Fn() -> String + Send + Sync>;

/// `AnthropicLanguageModelConfig`: where and how a Messages model sends its call.
/// A wrapper for another host (Claude on Bedrock) sets the URL builder, the body
/// transform and a `fetch` that signs the request.
#[derive(Clone)]
pub struct AnthropicMessagesConfig {
    /// The provider id, such as `anthropic.messages`. Its first dot-separated
    /// segment is also a `providerOptions` key the model reads.
    pub provider: String,
    pub base_url: String,
    pub headers: Option<HeadersFunction>,
    pub fetch: Option<FetchFunction>,
    pub build_request_url: Option<BuildRequestUrlFunction>,
    pub transform_request_body: Option<TransformRequestBodyFunction>,
    pub supported_urls: Option<SupportedUrlsFunction>,
    pub generate_id: Option<GenerateIdFunction>,
    pub supports_native_structured_output: Option<bool>,
    pub supports_strict_tools: Option<bool>,
    /// A setting the provider refused when it was created; every call fails with it.
    pub(super) creation_error: Option<InvalidArgumentError>,
}

impl AnthropicMessagesConfig {
    /// A config with only the provider id and the base URL.
    pub fn new(provider: impl Into<String>, base_url: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            base_url: base_url.into(),
            headers: None,
            fetch: None,
            build_request_url: None,
            transform_request_body: None,
            supported_urls: None,
            generate_id: None,
            supports_native_structured_output: None,
            supports_strict_tools: None,
            creation_error: None,
        }
    }
}

/// A Messages API language model.
pub struct AnthropicMessagesLanguageModel {
    model_id: String,
    config: AnthropicMessagesConfig,
}

/// The SDK's own name for the model.
pub type AnthropicLanguageModel = AnthropicMessagesLanguageModel;

/// What `prepare_request` builds: the Messages API arguments and what the call
/// needs besides them.
pub struct PreparedRequest {
    pub args: Value,
    pub warnings: Vec<Warning>,
    pub betas: IndexSet<String>,
    pub uses_json_response_tool: bool,
    pub tool_name_mapping: ToolNameMapping,
    pub provider_options_name: String,
    pub used_custom_provider_key: bool,
}

/// What a model id says about the model (`getModelCapabilities`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelCapabilities {
    pub max_output_tokens: i64,
    pub supports_structured_output: bool,
    pub supports_adaptive_thinking: bool,
    pub rejects_sampling_parameters: bool,
    pub supports_xhigh_effort: bool,
    pub rejects_thinking_disabled_above_high_effort: bool,
    /// Thinking is always adaptive: `thinking.type` `disabled` and `enabled` are
    /// rejected with a 400.
    pub rejects_thinking_disabled: bool,
    /// Budget-based thinking (`thinking.type` `enabled` with `budget_tokens`) is
    /// rejected with a 400. Only adaptive thinking is supported.
    pub rejects_budget_thinking: bool,
    /// Forced tool use (`tool_choice` `any` or a named tool) is rejected with a 400.
    pub rejects_forced_tool_use: bool,
    /// Supports `thinking.type` `between_tools`, the lowest thinking setting on
    /// models that reject disabled thinking.
    pub supports_between_tools_thinking: bool,
    pub is_known_model: bool,
}

static SONNET_4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"claude-sonnet-4(?:-|@)").unwrap());
static OPUS_4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"claude-opus-4(?:-|@)").unwrap());
static LEGACY_CLAUDE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"claude-(?:instant(?:-|$)|v?2(?:$|[-.:])|3(?:$|[-.]))").unwrap());

#[allow(clippy::too_many_arguments)]
const fn capabilities(
    max_output_tokens: i64,
    supports_structured_output: bool,
    supports_adaptive_thinking: bool,
    rejects_sampling_parameters: bool,
    supports_xhigh_effort: bool,
    rejects_thinking_disabled_above_high_effort: bool,
    rejects_thinking_disabled: bool,
    rejects_budget_thinking: bool,
    rejects_forced_tool_use: bool,
    supports_between_tools_thinking: bool,
    is_known_model: bool,
) -> ModelCapabilities {
    ModelCapabilities {
        max_output_tokens,
        supports_structured_output,
        supports_adaptive_thinking,
        rejects_sampling_parameters,
        supports_xhigh_effort,
        rejects_thinking_disabled_above_high_effort,
        rejects_thinking_disabled,
        rejects_budget_thinking,
        rejects_forced_tool_use,
        supports_between_tools_thinking,
        is_known_model,
    }
}

/// `getModelCapabilities`: what the model id names, matched by family.
pub fn get_model_capabilities(model_id: &str) -> ModelCapabilities {
    let has = |family: &str| model_id.contains(family);
    if has("claude-sonnet-5-5") {
        capabilities(
            128000, true, true, true, true, true, true, true, true, true, true,
        )
    } else if has("claude-opus-5-5") {
        capabilities(
            128000, true, true, true, true, true, true, true, true, false, true,
        )
    } else if has("claude-haiku-5-5") {
        // Thinking can be turned off, but only up to `high` effort.
        capabilities(
            128000, true, true, true, true, true, false, true, false, false, true,
        )
    } else if has("claude-opus-5") {
        capabilities(
            128000, true, true, true, true, true, false, false, false, false, true,
        )
    } else if has("claude-fable-5-1") {
        capabilities(
            128000, true, true, true, true, false, true, true, true, false, true,
        )
    } else if has("claude-fable-5") {
        capabilities(
            128000, true, true, true, true, false, true, true, false, false, true,
        )
    } else if has("claude-opus-4-8") || has("claude-opus-4-7") || has("claude-sonnet-5") {
        capabilities(
            128000, true, true, true, true, false, false, false, false, false, true,
        )
    } else if has("claude-sonnet-4-6") || has("claude-opus-4-6") {
        capabilities(
            128000, true, true, false, false, false, false, false, false, false, true,
        )
    } else if has("claude-sonnet-4-5") || has("claude-opus-4-5") || has("claude-haiku-4-5") {
        capabilities(
            64000, true, false, false, false, false, false, false, false, false, true,
        )
    } else if has("claude-opus-4-1") {
        capabilities(
            32000, true, false, false, false, false, false, false, false, false, true,
        )
    } else if SONNET_4.is_match(model_id) {
        capabilities(
            64000, false, false, false, false, false, false, false, false, false, true,
        )
    } else if OPUS_4.is_match(model_id) {
        capabilities(
            32000, false, false, false, false, false, false, false, false, false, true,
        )
    } else if has("claude-3-haiku") {
        capabilities(
            4096, false, false, false, false, false, false, false, false, false, true,
        )
    } else if LEGACY_CLAUDE.is_match(model_id) {
        capabilities(
            4096, false, false, false, false, false, false, false, false, false, false,
        )
    } else if has("claude-") {
        // Known and legacy Claude families are handled above, so any remaining
        // Claude id is newer than the known list. It stays unknown so callers still
        // receive the maxOutputTokens compatibility warning.
        capabilities(
            128000, true, true, true, true, true, false, false, false, false, false,
        )
    } else {
        // Non-Claude models (served through Anthropic-compatible APIs) keep
        // conservative defaults.
        capabilities(
            4096, false, false, false, false, false, false, false, false, false, false,
        )
    }
}

/// `hasDynamicFilteringWebToolWithoutCodeExecution`: a dynamic-filtering web tool
/// may run code without the code execution tool, and such calls are dynamic.
pub fn has_dynamic_filtering_web_tool_without_code_execution(tools: Option<&Value>) -> bool {
    let Some(Value::Array(tools)) = tools else {
        return false;
    };
    let mut has_dynamic_filtering_web_tool = false;
    let mut has_code_execution_tool = false;
    for tool in tools {
        let kind = tool.get("type").and_then(Value::as_str);
        if matches!(
            kind,
            Some("web_fetch_20260209")
                | Some("web_fetch_20260318")
                | Some("web_search_20260209")
                | Some("web_search_20260318")
        ) {
            has_dynamic_filtering_web_tool = true;
            continue;
        }
        if matches!(
            kind,
            Some("code_execution_20250522")
                | Some("code_execution_20250825")
                | Some("code_execution_20260120")
        ) {
            has_code_execution_tool = true;
            break;
        }
    }
    has_dynamic_filtering_web_tool && !has_code_execution_tool
}

fn compatibility(feature: &str, details: String) -> Warning {
    Warning::Compatibility {
        feature: feature.to_string(),
        details: Some(details),
    }
}

fn reasoning_name(reasoning: ReasoningEffort) -> &'static str {
    match reasoning {
        ReasoningEffort::ProviderDefault => "provider-default",
        ReasoningEffort::None => "none",
        ReasoningEffort::Minimal => "minimal",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
        ReasoningEffort::Max => "max",
    }
}

/// `resolveAnthropicReasoningConfig`: the top-level `reasoning` as thinking and
/// effort, for a call whose provider options name no effort.
fn resolve_anthropic_reasoning_config(
    reasoning: ReasoningEffort,
    model_id: &str,
    capabilities: &ModelCapabilities,
    warnings: &mut Vec<Warning>,
) -> Option<(Option<Thinking>, Option<Effort>)> {
    if reasoning == ReasoningEffort::ProviderDefault {
        return None;
    }
    if reasoning == ReasoningEffort::None {
        // `between_tools` is the lowest thinking setting on models that support it:
        // no upfront thinking, only short progress notes between tool calls.
        if capabilities.supports_between_tools_thinking {
            return Some((Some(Thinking::of(ThinkingType::BetweenTools)), None));
        }
        // Models that always run adaptive thinking cannot disable it; low effort
        // keeps the thinking short.
        if capabilities.rejects_thinking_disabled {
            warnings.push(compatibility(
                "reasoning",
                format!(
                    "reasoning 'none' is not supported by {model_id}; it always uses adaptive thinking. Using effort 'low' to minimize thinking instead."
                ),
            ));
            return Some((None, Some(Effort::Low)));
        }
        return Some((Some(Thinking::of(ThinkingType::Disabled)), None));
    }

    let level = reasoning_name(reasoning);
    if capabilities.supports_adaptive_thinking {
        let effort = match reasoning {
            ReasoningEffort::Minimal | ReasoningEffort::Low => Effort::Low,
            ReasoningEffort::Medium => Effort::Medium,
            ReasoningEffort::High => Effort::High,
            ReasoningEffort::Xhigh if capabilities.supports_xhigh_effort => Effort::Xhigh,
            _ => Effort::Max,
        };
        if effort.as_str() != level {
            warnings.push(compatibility(
                "reasoning",
                format!(
                    "reasoning \"{level}\" is not directly supported by this model. mapped to effort \"{}\".",
                    effort.as_str()
                ),
            ));
        }
        let thinking = Thinking {
            kind: Some(ThinkingType::Adaptive),
            display: Some(ThinkingDisplay::Summarized),
            ..Default::default()
        };
        return Some((Some(thinking), Some(effort)));
    }

    let percentage = match reasoning {
        ReasoningEffort::Minimal => 0.02,
        ReasoningEffort::Low => 0.1,
        ReasoningEffort::Medium => 0.3,
        ReasoningEffort::High => 0.6,
        ReasoningEffort::Xhigh => 0.9,
        _ => 0.95,
    };
    let max = capabilities.max_output_tokens as f64;
    let budget = max.min(1024f64.max((max * percentage).round()));
    let thinking = Thinking {
        kind: Some(ThinkingType::Enabled),
        budget_tokens: Some(budget),
        ..Default::default()
    };
    Some((Some(thinking), None))
}

/// The `providerOptions` key a provider id names: its first dot-separated segment.
fn get_provider_options_name(provider: &str) -> &str {
    match provider.find('.') {
        Some(index) => &provider[..index],
        None => provider,
    }
}

/// The custom names of toolset tools (the computer toolset), mapped to the
/// toolset name the API uses.
fn get_anthropic_toolset_names(tools: Option<&[LanguageModelV4Tool]>) -> IndexMap<String, String> {
    let mut names = IndexMap::new();
    for tool in tools.unwrap_or_default() {
        if let LanguageModelV4Tool::Provider(tool) = tool
            && tool.id == "anthropic.computer_toolset_20260801"
        {
            names.insert(tool.name.clone(), "computer".to_string());
        }
    }
    names
}

const SUPPORTED_STRING_FORMATS: &[&str] = &[
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
];

const DESCRIPTION_CONSTRAINT_KEYS: &[&str] = &[
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "not",
];

/// `sanitizeJsonSchema`: the schema without the keywords Anthropic rejects in
/// `output_config.format.schema`; their constraints move into the description.
pub fn sanitize_json_schema(definition: &Value) -> Value {
    match definition {
        Value::Object(schema) => Value::Object(sanitize_schema(schema)),
        other => other.clone(),
    }
}

fn sanitize_map(definitions: &Value) -> Value {
    match definitions {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(name, definition)| (name.clone(), sanitize_json_schema(definition)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn sanitize_list(definitions: &Value) -> Value {
    match definitions {
        Value::Array(items) => Value::Array(items.iter().map(sanitize_json_schema).collect()),
        other => other.clone(),
    }
}

fn sanitize_schema(schema: &Map<String, Value>) -> Map<String, Value> {
    let present = |key: &str| schema.get(key).filter(|value| !value.is_null());
    let mut result = Map::new();
    if let Some(reference) = present("$ref") {
        result.insert("$ref".into(), reference.clone());
        return result;
    }
    for key in ["$schema", "$id", "title", "description"] {
        if let Some(value) = present(key) {
            result.insert(key.into(), value.clone());
        }
    }
    for key in ["default", "const"] {
        if let Some(value) = schema.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    for key in ["enum", "type"] {
        if let Some(value) = present(key) {
            result.insert(key.into(), value.clone());
        }
    }
    if let Some(any_of) = present("anyOf") {
        result.insert("anyOf".into(), sanitize_list(any_of));
    } else if let Some(one_of) = present("oneOf") {
        result.insert("anyOf".into(), sanitize_list(one_of));
    }
    if let Some(all_of) = present("allOf") {
        result.insert("allOf".into(), sanitize_list(all_of));
    }
    if let Some(definitions) = present("definitions") {
        result.insert("definitions".into(), sanitize_map(definitions));
    }
    if let Some(definitions) = present("$defs") {
        result.insert("$defs".into(), sanitize_map(definitions));
    }
    let properties = present("properties");
    if schema.get("type").and_then(Value::as_str) == Some("object") || properties.is_some() {
        if let Some(properties) = properties {
            result.insert("properties".into(), sanitize_map(properties));
        }
        result.insert("additionalProperties".into(), Value::Bool(false));
        if let Some(required) = present("required") {
            result.insert("required".into(), required.clone());
        }
    }
    if let Some(items) = present("items") {
        let items = match items {
            Value::Array(_) => sanitize_list(items),
            other => sanitize_json_schema(other),
        };
        result.insert("items".into(), items);
    }
    let format = schema.get("format").and_then(Value::as_str);
    if let Some(format) = format.filter(|format| SUPPORTED_STRING_FORMATS.contains(format)) {
        result.insert("format".into(), Value::from(format));
    }

    let mut descriptions: Vec<String> = Vec::new();
    for key in DESCRIPTION_CONSTRAINT_KEYS {
        match schema.get(*key) {
            None | Some(Value::Null) | Some(Value::Bool(false)) => {}
            Some(value) => descriptions.push(format!(
                "{}: {}",
                format_constraint_name(key),
                match value {
                    Value::String(text) => text.clone(),
                    other => crate::ai::json::js_stringify(other),
                }
            )),
        }
    }
    if let Some(format) = format.filter(|format| !SUPPORTED_STRING_FORMATS.contains(format)) {
        descriptions.push(format!("format: {format}"));
    }
    if !descriptions.is_empty() {
        let constraint = format!("{}.", descriptions.join("; "));
        let description = match result.get("description").and_then(Value::as_str) {
            Some(existing) => format!("{existing}\n{constraint}"),
            None => constraint,
        };
        result.insert("description".into(), Value::from(description));
    }
    result
}

/// `minLength` → `min length`.
fn format_constraint_name(key: &str) -> String {
    let mut out = String::new();
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push(' ');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

impl AnthropicMessagesLanguageModel {
    pub fn new(model_id: impl Into<String>, config: AnthropicMessagesConfig) -> Self {
        Self {
            model_id: model_id.into(),
            config,
        }
    }

    pub fn config(&self) -> &AnthropicMessagesConfig {
        &self.config
    }

    /// `AnthropicLanguageModel.prepareRequest`: the Messages API arguments for one
    /// call, with the warnings and betas they come with.
    pub fn prepare_request(
        model_id: &str,
        config: &AnthropicMessagesConfig,
        options: &LanguageModelV4CallOptions,
        stream: bool,
        user_supplied_betas: IndexSet<String>,
    ) -> anyhow::Result<PreparedRequest> {
        let mut warnings: Vec<Warning> = Vec::new();

        if options.frequency_penalty.is_some() {
            warnings.push(Warning::unsupported("frequencyPenalty", None));
        }
        if options.presence_penalty.is_some() {
            warnings.push(Warning::unsupported("presencePenalty", None));
        }
        if options.seed.is_some() {
            warnings.push(Warning::unsupported("seed", None));
        }

        let mut temperature = options.temperature;
        let mut top_k = options.top_k;
        let mut top_p = options.top_p;
        if let Some(value) = temperature {
            if value > 1.0 {
                warnings.push(Warning::unsupported(
                    "temperature",
                    Some(format!(
                        "{} exceeds anthropic maximum of 1.0. clamped to 1.0",
                        js_number_text(value)
                    )),
                ));
                temperature = Some(1.0);
            } else if value < 0.0 {
                warnings.push(Warning::unsupported(
                    "temperature",
                    Some(format!(
                        "{} is below anthropic minimum of 0. clamped to 0",
                        js_number_text(value)
                    )),
                ));
                temperature = Some(0.0);
            }
        }

        let json_schema = match &options.response_format {
            Some(LanguageModelV4ResponseFormat::Json { schema, .. }) => {
                if schema.is_none() {
                    warnings.push(Warning::unsupported(
                        "responseFormat",
                        Some(
                            "JSON response format requires a schema. The response format is ignored."
                                .to_string(),
                        ),
                    ));
                }
                schema.as_ref()
            }
            _ => None,
        };

        let provider_options_name = get_provider_options_name(&config.provider).to_string();
        let provider_options = options.provider_options.as_ref();
        let canonical = parse_provider_options::<AnthropicLanguageModelOptions>(
            "anthropic",
            provider_options,
            AnthropicLanguageModelOptions::is_valid,
        )?;
        let custom = if provider_options_name != "anthropic" {
            parse_provider_options::<AnthropicLanguageModelOptions>(
                &provider_options_name,
                provider_options,
                AnthropicLanguageModelOptions::is_valid,
            )?
        } else {
            None
        };
        let used_custom_provider_key = custom.is_some();
        let mut anthropic_options = canonical
            .unwrap_or_default()
            .merged_with(custom.unwrap_or_default());

        let capabilities = get_model_capabilities(model_id);
        let max_output_tokens_for_model = capabilities.max_output_tokens;

        if !capabilities.is_known_model && options.max_output_tokens.is_none() {
            warnings.push(compatibility(
                "maxOutputTokens",
                format!(
                    "The model \"{model_id}\" is unknown. The max output tokens have been limited to {max_output_tokens_for_model}. Set maxOutputTokens explicitly to override this limit."
                ),
            ));
        }

        if capabilities.rejects_sampling_parameters {
            if temperature.is_some() {
                warnings.push(Warning::unsupported(
                    "temperature",
                    Some(format!(
                        "temperature is not supported by {model_id} and will be ignored"
                    )),
                ));
                temperature = None;
            }
            if top_k.is_some() {
                warnings.push(Warning::unsupported(
                    "topK",
                    Some(format!(
                        "topK is not supported by {model_id} and will be ignored"
                    )),
                ));
                top_k = None;
            }
            if top_p.is_some() {
                warnings.push(Warning::unsupported(
                    "topP",
                    Some(format!(
                        "topP is not supported by {model_id} and will be ignored"
                    )),
                ));
                top_p = None;
            }
        }

        let is_anthropic_model = capabilities.is_known_model || model_id.contains("claude-");
        let supports_structured_output = config.supports_native_structured_output.unwrap_or(true)
            && capabilities.supports_structured_output;
        let supports_strict_tools =
            config.supports_strict_tools.unwrap_or(true) && capabilities.supports_structured_output;

        let structured_output_mode = anthropic_options
            .structured_output_mode
            .unwrap_or(StructuredOutputMode::Auto);
        let mut use_structured_output = structured_output_mode
            == StructuredOutputMode::OutputFormat
            || (structured_output_mode == StructuredOutputMode::Auto && supports_structured_output);

        // The JSON response tool relies on forced tool use, which some models reject.
        // Fall back to native structured outputs when the model supports them.
        if !use_structured_output
            && capabilities.rejects_forced_tool_use
            && supports_structured_output
            && json_schema.is_some()
        {
            warnings.push(Warning::unsupported(
                "providerOptions.anthropic.structuredOutputMode",
                Some(format!(
                    "structuredOutputMode 'jsonTool' is not supported by {model_id} because it rejects forced tool use. Using 'outputFormat' instead."
                )),
            ));
            use_structured_output = true;
        }

        let json_response_tool = json_schema
            .filter(|_| !use_structured_output)
            .map(|schema| LanguageModelV4FunctionTool {
                name: "json".to_string(),
                input_schema: schema.clone(),
                description: Some("Respond with a JSON object.".to_string()),
                input_examples: None,
                provider_options: None,
                strict: None,
            });

        if json_response_tool.is_some()
            && anthropic_options.disable_parallel_tool_use == Some(false)
        {
            warnings.push(Warning::unsupported(
                "providerOptions.anthropic.disableParallelToolUse",
                Some(
                    "`disableParallelToolUse: false` is ignored when using the JSON response tool. Parallel tool use is disabled to ensure a single coherent JSON tool call."
                        .to_string(),
                ),
            ));
        }

        if anthropic_options.context_management.is_some() && anthropic_options.compaction.is_some()
        {
            return Err(InvalidArgumentError {
                message: "Anthropic provider options `compaction` and `contextManagement` cannot be used together.".to_string(),
                parameter: "providerOptions".to_string(),
                value: Value::Null,
            }
            .into());
        }

        // One validator tracks the breakpoints across tools and messages.
        let mut cache_control_validator = CacheControlValidator::new();
        let tool_name_mapping = ToolNameMapping::new(options.tools.as_deref(), PROVIDER_TOOL_NAMES);
        let toolset_names = get_anthropic_toolset_names(options.tools.as_deref());

        let converted = convert_to_anthropic_prompt(
            &options.prompt,
            anthropic_options.send_reasoning.unwrap_or(true),
            &mut warnings,
            &mut cache_control_validator,
            &tool_name_mapping,
            &toolset_names,
        )?;
        let mut betas = converted.betas;
        let messages_prompt = converted.prompt;

        // The top-level `reasoning` maps to thinking and effort when the provider
        // options name no effort. Provider options always take precedence.
        if let Some(reasoning) = options.reasoning
            && anthropic_options.effort.is_none()
            && let Some((thinking, effort)) = resolve_anthropic_reasoning_config(
                reasoning,
                model_id,
                &capabilities,
                &mut warnings,
            )
        {
            if anthropic_options.thinking.is_none() {
                anthropic_options.thinking = thinking;
            }
            let disabled = anthropic_options.thinking.as_ref().and_then(|t| t.kind)
                == Some(ThinkingType::Disabled);
            if effort.is_some() && !disabled {
                anthropic_options.effort = effort;
            }
        }

        // Some models always run adaptive thinking and reject `disabled` thinking
        // with a 400. The setting is dropped and the request stays adaptive.
        if capabilities.rejects_thinking_disabled {
            let disabled = anthropic_options.thinking.as_ref().and_then(|t| t.kind)
                == Some(ThinkingType::Disabled);
            if disabled && capabilities.supports_between_tools_thinking {
                warnings.push(Warning::unsupported(
                    "providerOptions.anthropic.thinking",
                    Some(format!(
                        "thinking cannot be disabled for {model_id}. Using 'between_tools' thinking, the lowest thinking setting, instead."
                    )),
                ));
                anthropic_options.thinking = Some(Thinking::of(ThinkingType::BetweenTools));
            } else if disabled {
                warnings.push(Warning::unsupported(
                    "providerOptions.anthropic.thinking",
                    Some(format!(
                        "thinking cannot be disabled for {model_id}; it always uses adaptive thinking. The thinking setting has been removed. Lower 'effort' to reduce thinking."
                    )),
                ));
                anthropic_options.thinking = None;
            }
        }

        // Models that only support adaptive thinking reject budget-based thinking
        // with a 400; adaptive thinking runs instead, with `effort` in control.
        if capabilities.rejects_budget_thinking
            && anthropic_options.thinking.as_ref().and_then(|t| t.kind)
                == Some(ThinkingType::Enabled)
        {
            let details = if capabilities.rejects_thinking_disabled {
                format!(
                    "budget-based thinking is not supported by {model_id}; it always uses adaptive thinking. Using adaptive thinking instead. Use 'effort' to control how much the model thinks."
                )
            } else {
                format!(
                    "budget-based thinking is not supported by {model_id}. Using adaptive thinking instead. Use 'effort' to control how much the model thinks."
                )
            };
            warnings.push(Warning::unsupported(
                "providerOptions.anthropic.thinking",
                Some(details),
            ));
            anthropic_options.thinking = Some(Thinking::of(ThinkingType::Adaptive));
        }

        let high_effort =
            |effort: Option<Effort>| matches!(effort, Some(Effort::Xhigh) | Some(Effort::Max));

        // Newer models allow disabling thinking only up to `high` effort.
        if capabilities.rejects_thinking_disabled_above_high_effort
            && anthropic_options.thinking.as_ref().and_then(|t| t.kind)
                == Some(ThinkingType::Disabled)
            && high_effort(anthropic_options.effort)
        {
            warnings.push(Warning::unsupported(
                "providerOptions.anthropic.effort",
                Some(format!(
                    "effort '{}' is not supported by {model_id} when thinking is disabled. The effort has been lowered to 'high'.",
                    anthropic_options.effort.map(Effort::as_str).unwrap_or_default()
                )),
            ));
            anthropic_options.effort = Some(Effort::High);
        }

        // `between_tools` thinking is only accepted at `low`, `medium` and `high`
        // effort.
        if anthropic_options.thinking.as_ref().and_then(|t| t.kind)
            == Some(ThinkingType::BetweenTools)
            && high_effort(anthropic_options.effort)
        {
            warnings.push(Warning::unsupported(
                "providerOptions.anthropic.effort",
                Some(format!(
                    "effort '{}' is not supported with 'between_tools' thinking. The effort has been lowered to 'high'.",
                    anthropic_options.effort.map(Effort::as_str).unwrap_or_default()
                )),
            ));
            anthropic_options.effort = Some(Effort::High);
        }

        let thinking = anthropic_options.thinking.clone();
        let thinking_type = thinking.as_ref().and_then(|t| t.kind);
        let is_thinking = matches!(
            thinking_type,
            Some(ThinkingType::Enabled)
                | Some(ThinkingType::Adaptive)
                | Some(ThinkingType::BetweenTools)
        );
        let thinking_block_binding = thinking.as_ref().and_then(|t| t.block_binding.clone());
        // `disabled` is still sent: some models default thinking on, and leaving it
        // out would spend the max_tokens budget on thinking.
        let send_thinking = is_thinking
            || thinking_type == Some(ThinkingType::Disabled)
            || thinking_block_binding.is_some();
        let mut thinking_budget = if thinking_type == Some(ThinkingType::Enabled) {
            thinking.as_ref().and_then(|t| t.budget_tokens)
        } else {
            None
        };
        let thinking_display = if thinking_type == Some(ThinkingType::Adaptive) {
            thinking.as_ref().and_then(|t| t.display)
        } else {
            None
        };

        let max_tokens = options
            .max_output_tokens
            .unwrap_or(max_output_tokens_for_model) as f64;

        let mut thinking_json = send_thinking.then(|| {
            object([
                ("type", thinking_type.map(|kind| Value::from(kind.as_str()))),
                ("budget_tokens", thinking_budget.map(number)),
                ("display", thinking_display.map(|display| Value::from(display.as_str()))),
                (
                    "block_binding",
                    thinking_block_binding.as_ref().map(|binding| {
                        json!({ "prefix_mismatch_behavior": binding.prefix_mismatch_behavior.as_str() })
                    }),
                ),
            ])
        });

        let mut sent_temperature = temperature;
        let mut sent_top_k = top_k;
        let mut sent_top_p = top_p;
        let mut sent_max_tokens = max_tokens;
        if is_thinking {
            if thinking_type == Some(ThinkingType::Enabled) && thinking_budget.is_none() {
                warnings.push(compatibility(
                    "extended thinking",
                    "thinking budget is required when thinking is enabled. using default budget of 1024 tokens."
                        .to_string(),
                ));
                thinking_json = Some(json!({ "type": "enabled", "budget_tokens": 1024 }));
                thinking_budget = Some(1024.0);
            }
            if sent_temperature.is_some() {
                sent_temperature = None;
                warnings.push(Warning::unsupported(
                    "temperature",
                    Some("temperature is not supported when thinking is enabled".to_string()),
                ));
            }
            if top_k.is_some() {
                sent_top_k = None;
                warnings.push(Warning::unsupported(
                    "topK",
                    Some("topK is not supported when thinking is enabled".to_string()),
                ));
            }
            if top_p.is_some() {
                sent_top_p = None;
                warnings.push(Warning::unsupported(
                    "topP",
                    Some("topP is not supported when thinking is enabled".to_string()),
                ));
            }
            // The thinking budget is spent out of the output tokens.
            sent_max_tokens = max_tokens + thinking_budget.unwrap_or(0.0);
        } else if is_anthropic_model && top_p.is_some() && temperature.is_some() {
            // Only known Anthropic models refuse temperature and topP together;
            // other models behind the Anthropic API may require both.
            warnings.push(Warning::unsupported(
                "topP",
                Some("topP is not supported when temperature is set. topP is ignored.".to_string()),
            ));
            sent_top_p = None;
        }

        // A known model's own limit caps max tokens, so a model switch keeps working.
        if capabilities.is_known_model && sent_max_tokens > max_output_tokens_for_model as f64 {
            if options.max_output_tokens.is_some() {
                warnings.push(Warning::unsupported(
                    "maxOutputTokens",
                    Some(format!(
                        "{} (maxOutputTokens + thinkingBudget) is greater than {model_id} {max_output_tokens_for_model} max output tokens. The max output tokens have been limited to {max_output_tokens_for_model}.",
                        js_number_text(sent_max_tokens)
                    )),
                ));
            }
            sent_max_tokens = max_output_tokens_for_model as f64;
        }

        let effort = anthropic_options.effort;
        let task_budget = anthropic_options.task_budget.as_ref();
        let output_format = json_schema.filter(|_| use_structured_output);
        let output_config = (effort.is_some() || task_budget.is_some() || output_format.is_some())
            .then(|| {
                object([
                    ("effort", effort.map(|effort| Value::from(effort.as_str()))),
                    (
                        "task_budget",
                        task_budget.map(|budget| {
                            object([
                                ("type", Some(Value::from("tokens"))),
                                ("total", Some(number(budget.total))),
                                ("remaining", budget.remaining.map(number)),
                            ])
                        }),
                    ),
                    (
                        "format",
                        output_format.map(|schema| {
                            json!({ "type": "json_schema", "schema": sanitize_json_schema(schema) })
                        }),
                    ),
                ])
            });

        let fallbacks = match &anthropic_options.fallbacks {
            Some(Fallbacks::Default) => Some(Value::from("default")),
            Some(Fallbacks::Models(models)) if !models.is_empty() => Some(Value::Array(
                models.iter().map(|model| model.0.clone()).collect(),
            )),
            _ => None,
        };

        let mcp_servers = anthropic_options
            .mcp_servers
            .as_ref()
            .filter(|servers| !servers.is_empty())
            .map(|servers| {
                Value::Array(
                    servers
                        .iter()
                        .map(|server| {
                            object([
                                ("type", Some(Value::from("url"))),
                                ("name", Some(Value::from(server.name.clone()))),
                                ("url", Some(Value::from(server.url.clone()))),
                                (
                                    "authorization_token",
                                    server.authorization_token.clone().map(Value::from),
                                ),
                                (
                                    "tool_configuration",
                                    server.tool_configuration.as_ref().map(|configuration| {
                                        object([
                                            (
                                                "allowed_tools",
                                                configuration
                                                    .allowed_tools
                                                    .clone()
                                                    .map(|tools| json!(tools)),
                                            ),
                                            ("enabled", configuration.enabled.map(Value::Bool)),
                                        ])
                                    }),
                                ),
                            ])
                        })
                        .collect(),
                )
            });

        let container_skills = anthropic_options
            .container
            .as_ref()
            .and_then(|container| container.skills.as_ref())
            .filter(|skills| !skills.is_empty());
        let container = match &anthropic_options.container {
            None => None,
            Some(container) => match container_skills {
                Some(skills) => {
                    let mut entries = Vec::new();
                    for skill in skills {
                        entries.push(match skill {
                            SkillOption::Anthropic { skill_id, version } => object([
                                ("type", Some(Value::from("anthropic"))),
                                ("skill_id", Some(Value::from(skill_id.clone()))),
                                ("version", version.clone().map(Value::from)),
                            ]),
                            SkillOption::Custom {
                                provider_reference,
                                version,
                            } => {
                                let Some(id) = provider_reference.get("anthropic") else {
                                    let available = provider_reference
                                        .keys()
                                        .cloned()
                                        .collect::<Vec<_>>()
                                        .join(", ");
                                    anyhow::bail!(
                                        "No provider reference found for provider 'anthropic'. Available providers: {available}"
                                    );
                                };
                                object([
                                    ("type", Some(Value::from("custom"))),
                                    ("skill_id", Some(Value::from(id.clone()))),
                                    ("version", version.clone().map(Value::from)),
                                ])
                            }
                        });
                    }
                    Some(object([
                        ("id", container.id.clone().map(Value::from)),
                        ("skills", Some(Value::Array(entries))),
                    ]))
                }
                None => container.id.clone().map(Value::from),
            },
        };

        let safeguards = anthropic_options
            .safeguards
            .as_ref()
            .filter(|safeguards| !safeguards.is_empty())
            .map(|safeguards| {
                Value::Array(
                    safeguards
                        .iter()
                        .map(|safeguard| {
                            object([
                                ("type", Some(Value::from("dangerous_tool_use"))),
                                (
                                    "classifier_context",
                                    safeguard.classifier_context.clone().map(Value::Object),
                                ),
                            ])
                        })
                        .collect(),
                )
            });

        let compaction = anthropic_options.compaction.as_ref().map(|compaction| {
            object([
                ("type", Some(Value::from("summarize"))),
                (
                    "instructions",
                    compaction.instructions.clone().map(Value::from),
                ),
            ])
        });

        let context_management = anthropic_options
            .context_management
            .as_ref()
            .map(|management| {
                let edits: Vec<Value> = management
                    .edits
                    .iter()
                    .map(|edit| match edit {
                        ContextManagementEdit::ClearToolUses {
                            trigger,
                            keep,
                            clear_at_least,
                            clear_tool_inputs,
                            exclude_tools,
                        } => object([
                            ("type", Some(Value::from("clear_tool_uses_20250919"))),
                            ("trigger", trigger.as_ref().map(|t| t.to_json())),
                            ("keep", keep.as_ref().map(|k| k.to_json())),
                            (
                                "clear_at_least",
                                clear_at_least.as_ref().map(|c| c.to_json()),
                            ),
                            ("clear_tool_inputs", clear_tool_inputs.map(Value::Bool)),
                            (
                                "exclude_tools",
                                exclude_tools.clone().map(|tools| json!(tools)),
                            ),
                        ]),
                        ContextManagementEdit::ClearThinking { keep } => object([
                            ("type", Some(Value::from("clear_thinking_20251015"))),
                            ("keep", keep.as_ref().map(|k| k.to_json())),
                        ]),
                        ContextManagementEdit::Compact {
                            trigger,
                            pause_after_compaction,
                            instructions,
                        } => object([
                            ("type", Some(Value::from("compact_20260112"))),
                            ("trigger", trigger.as_ref().map(|t| t.to_json())),
                            (
                                "pause_after_compaction",
                                pause_after_compaction.map(Value::Bool),
                            ),
                            ("instructions", instructions.clone().map(Value::from)),
                        ]),
                    })
                    .collect();
                json!({ "edits": edits })
            });

        if mcp_servers.is_some() {
            betas.insert("mcp-client-2025-04-04".to_string());
        }
        if safeguards.is_some() {
            betas.insert("dangerous-tool-use-2026-09-03".to_string());
        }
        if anthropic_options.compaction.is_some() {
            betas.insert("compact-2026-09-04".to_string());
        }
        if let Some(management) = &anthropic_options.context_management {
            betas.insert("context-management-2025-06-27".to_string());
            if management
                .edits
                .iter()
                .any(|edit| matches!(edit, ContextManagementEdit::Compact { .. }))
            {
                betas.insert("compact-2026-01-12".to_string());
            }
        }
        if container_skills.is_some() {
            betas.insert("code-execution-2025-08-25".to_string());
            betas.insert("skills-2025-10-02".to_string());
            betas.insert("files-api-2025-04-14".to_string());
            let has_code_execution = options.tools.iter().flatten().any(|tool| {
                matches!(tool, LanguageModelV4Tool::Provider(tool)
                    if tool.id == "anthropic.code_execution_20250825"
                        || tool.id == "anthropic.code_execution_20260120")
            });
            if !has_code_execution {
                warnings.push(Warning::Other {
                    message: "code execution tool is required when using skills".to_string(),
                });
            }
        }
        if anthropic_options.task_budget.is_some() {
            betas.insert("task-budgets-2026-03-13".to_string());
        }
        if anthropic_options.speed == Some(super::options::Speed::Fast) {
            betas.insert("fast-mode-2026-02-01".to_string());
        }
        if thinking_display == Some(ThinkingDisplay::Updates) {
            betas.insert("thinking-display-updates-2026-08-18".to_string());
        }
        if thinking_block_binding.is_some() {
            betas.insert("thinking-binding-controls-2026-08-01".to_string());
        }
        match &anthropic_options.fallbacks {
            Some(Fallbacks::Default) => {
                betas.insert("server-side-fallback-2026-07-01".to_string());
            }
            Some(Fallbacks::Models(models)) if !models.is_empty() => {
                betas.insert("server-side-fallback-2026-06-01".to_string());
            }
            _ => {}
        }

        let default_eager_input_streaming =
            stream && anthropic_options.tool_streaming.unwrap_or(true);

        let prepared_tools = match &json_response_tool {
            Some(json_tool) => {
                let mut tools = options.tools.clone().unwrap_or_default();
                tools.push(LanguageModelV4Tool::Function(json_tool.clone()));
                prepare_tools(
                    PrepareToolsInput {
                        tools,
                        tool_choice: Some(&LanguageModelV4ToolChoice::Required),
                        disable_parallel_tool_use: Some(true),
                        supports_structured_output: false,
                        supports_strict_tools,
                        default_eager_input_streaming,
                        rejects_forced_tool_use: capabilities.rejects_forced_tool_use,
                    },
                    &mut cache_control_validator,
                )
            }
            None => prepare_tools(
                PrepareToolsInput {
                    tools: options.tools.clone().unwrap_or_default(),
                    tool_choice: options.tool_choice.as_ref(),
                    disable_parallel_tool_use: anthropic_options.disable_parallel_tool_use,
                    supports_structured_output,
                    supports_strict_tools,
                    default_eager_input_streaming,
                    rejects_forced_tool_use: capabilities.rejects_forced_tool_use,
                },
                &mut cache_control_validator,
            ),
        };

        let cache_warnings = cache_control_validator.into_warnings();

        let args = object([
            ("model", Some(Value::from(model_id))),
            ("max_tokens", Some(number(sent_max_tokens))),
            ("temperature", sent_temperature.map(number)),
            ("top_k", sent_top_k.map(number)),
            ("top_p", sent_top_p.map(number)),
            (
                "stop_sequences",
                options.stop_sequences.clone().map(|stops| json!(stops)),
            ),
            ("thinking", thinking_json),
            ("output_config", output_config),
            (
                "speed",
                anthropic_options
                    .speed
                    .map(|speed| Value::from(speed.as_str())),
            ),
            (
                "service_tier",
                anthropic_options
                    .service_tier
                    .map(|tier| Value::from(tier.as_str())),
            ),
            (
                "inference_geo",
                anthropic_options
                    .inference_geo
                    .map(|geo| Value::from(geo.as_str())),
            ),
            ("fallbacks", fallbacks),
            (
                "cache_control",
                anthropic_options
                    .cache_control
                    .as_ref()
                    .map(|control| control.to_json()),
            ),
            (
                "metadata",
                anthropic_options
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.user_id.clone())
                    .map(|user_id| json!({ "user_id": user_id })),
            ),
            ("mcp_servers", mcp_servers),
            ("container", container),
            ("system", messages_prompt.system.map(Value::Array)),
            ("messages", Some(Value::Array(messages_prompt.messages))),
            ("safeguards", safeguards),
            ("compaction", compaction),
            ("context_management", context_management),
            ("tools", prepared_tools.tools.map(Value::Array)),
            ("tool_choice", prepared_tools.tool_choice),
            ("stream", stream.then_some(Value::Bool(true))),
        ]);

        warnings.extend(prepared_tools.tool_warnings);
        warnings.extend(cache_warnings);

        let mut all_betas: IndexSet<String> = betas;
        all_betas.extend(prepared_tools.betas);
        all_betas.extend(user_supplied_betas);
        all_betas.extend(anthropic_options.anthropic_beta.clone().unwrap_or_default());

        Ok(PreparedRequest {
            args,
            warnings,
            betas: all_betas,
            uses_json_response_tool: json_response_tool.is_some(),
            tool_name_mapping,
            provider_options_name,
            used_custom_provider_key,
        })
    }

    async fn config_headers(&self) -> anyhow::Result<Option<Headers>> {
        match &self.config.headers {
            Some(headers) => Ok(Some(headers().await?)),
            None => Ok(None),
        }
    }

    /// `combineHeaders(configHeaders, headers, { 'anthropic-beta' })`.
    async fn get_headers(
        &self,
        betas: &IndexSet<String>,
        headers: Option<&Headers>,
    ) -> anyhow::Result<Headers> {
        let mut combined: Headers = IndexMap::new();
        if let Some(config_headers) = self.config_headers().await? {
            combined.extend(config_headers);
        }
        if let Some(headers) = headers {
            combined.extend(headers.clone());
        }
        if !betas.is_empty() {
            combined.insert(
                "anthropic-beta".to_string(),
                betas.iter().cloned().collect::<Vec<_>>().join(","),
            );
        }
        Ok(combined)
    }

    /// The betas the config's and the call's `anthropic-beta` headers name.
    async fn get_betas_from_headers(
        &self,
        request_headers: Option<&Headers>,
    ) -> anyhow::Result<IndexSet<String>> {
        let config_headers = self.config_headers().await?;
        let config_beta = config_headers
            .as_ref()
            .and_then(|headers| headers.get("anthropic-beta"))
            .cloned()
            .unwrap_or_default();
        let request_beta = request_headers
            .and_then(|headers| headers.get("anthropic-beta"))
            .cloned()
            .unwrap_or_default();
        let mut betas = IndexSet::new();
        for beta in config_beta
            .to_lowercase()
            .split(',')
            .chain(request_beta.to_lowercase().split(','))
        {
            let beta = crate::support::js::trim(beta);
            if !beta.is_empty() {
                betas.insert(beta.to_string());
            }
        }
        Ok(betas)
    }

    fn build_request_url(&self, is_streaming: bool) -> String {
        match &self.config.build_request_url {
            Some(build) => build(&self.config.base_url, is_streaming),
            None => format!("{}/messages", self.config.base_url),
        }
    }

    fn transform_request_body(&self, args: &Value, betas: &IndexSet<String>) -> Value {
        match &self.config.transform_request_body {
            Some(transform) => transform(args.clone(), betas),
            None => args.clone(),
        }
    }

    /// The documents of the prompt's user messages that have citations enabled, in
    /// the order a citation's `document_index` counts them.
    fn extract_citation_documents(prompt: &[LanguageModelV4Message]) -> Vec<CitationDocument> {
        let mut documents = Vec::new();
        for message in prompt {
            let LanguageModelV4Message::User { content, .. } = message else {
                continue;
            };
            for part in content {
                let LanguageModelV4Part::File {
                    filename,
                    media_type,
                    provider_options,
                    ..
                } = part
                else {
                    continue;
                };
                if media_type != "application/pdf" && media_type != "text/plain" {
                    continue;
                }
                let enabled = provider_options
                    .as_ref()
                    .and_then(|options| options.get("anthropic"))
                    .and_then(|anthropic| anthropic.get("citations"))
                    .and_then(|citations| citations.get("enabled"))
                    .is_some_and(super::cache_control::is_truthy);
                if !enabled {
                    continue;
                }
                documents.push(CitationDocument {
                    title: filename
                        .clone()
                        .unwrap_or_else(|| "Untitled Document".to_string()),
                    filename: filename.clone(),
                    media_type: media_type.clone(),
                });
            }
        }
        documents
    }
}

#[async_trait]
impl LanguageModel for AnthropicMessagesLanguageModel {
    fn provider(&self) -> &str {
        &self.config.provider
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn supported_urls(&self) -> SupportedUrls {
        self.config
            .supported_urls
            .as_ref()
            .map(|supported| supported())
            .unwrap_or_default()
    }

    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        if let Some(error) = &self.config.creation_error {
            return Err(error.clone().into());
        }
        let user_supplied_betas = self
            .get_betas_from_headers(options.headers.as_ref())
            .await?;
        let PreparedRequest {
            args,
            warnings,
            betas,
            uses_json_response_tool,
            tool_name_mapping,
            provider_options_name,
            used_custom_provider_key,
        } = Self::prepare_request(
            &self.model_id,
            &self.config,
            &options,
            false,
            user_supplied_betas,
        )?;

        let mut citation_documents = Self::extract_citation_documents(&options.prompt);
        let mark_code_execution_dynamic =
            has_dynamic_filtering_web_tool_without_code_execution(args.get("tools"));

        let url = self.build_request_url(false);
        let headers = self.get_headers(&betas, options.headers.as_ref()).await?;
        let body = self.transform_request_body(&args, &betas);
        let response = post_json_to_api(
            &url,
            headers,
            &body,
            self.config.fetch.as_ref(),
            options.abort_signal.clone(),
        )
        .await?;
        let (parsed, usage) = parse_response(&response.value)
            .map_err(|cause| invalid_response(&response, &url, &body, cause))?;

        let default_generate_id: &dyn Fn() -> String = &generate_id;
        let generate_id_fn: &dyn Fn() -> String = match &self.config.generate_id {
            Some(generate) => generate.as_ref(),
            None => default_generate_id,
        };
        let (content, is_json_response_from_tool) = map_content(
            &parsed.content,
            &mut citation_documents,
            &ContentContext {
                uses_json_response_tool,
                tool_name_mapping: &tool_name_mapping,
                mark_code_execution_dynamic,
                generate_id: generate_id_fn,
            },
        );

        let anthropic_metadata = Value::Object(response_metadata(&parsed, &usage));
        let mut provider_metadata = Map::new();
        provider_metadata.insert("anthropic".into(), anthropic_metadata.clone());
        if used_custom_provider_key && provider_options_name != "anthropic" {
            provider_metadata.insert(provider_options_name, anthropic_metadata);
        }

        Ok(LanguageModelV4GenerateResult {
            content,
            finish_reason: LanguageModelV4FinishReason {
                unified: map_anthropic_stop_reason(
                    parsed.stop_reason.as_deref(),
                    is_json_response_from_tool,
                ),
                raw: parsed.stop_reason.clone(),
            },
            usage: convert_anthropic_usage(&usage),
            provider_metadata: Some(provider_metadata),
            request: Some(LanguageModelV4Request { body: Some(args) }),
            response: Some(LanguageModelV4Response {
                id: parsed.id.clone(),
                timestamp: None,
                model_id: parsed.model.clone(),
                headers: Some(response.headers),
                body: Some(response.value),
            }),
            warnings,
        })
    }
}
