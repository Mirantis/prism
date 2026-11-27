//! The Responses API language model (`OpenAIResponsesLanguageModel`): the request
//! a call sends, and the content, usage and finish reason of its response.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Map, Value};

use super::api::{
    FetchFunction, combine_headers, generate_id, invalid_json_response,
    openai_failed_response_error, parse_json_body, post_json,
};
use super::capabilities::{
    OpenAILanguageModelCapabilities, SystemMessageMode, get_openai_language_model_capabilities,
};
use super::json_schema::normalize_openai_json_schema;
use super::responses_input::{
    ConvertInputOptions, configuration_update, convert_to_openai_responses_input,
};
use super::responses_options::{
    IncludeValue, Logprobs, OpenAIResponsesOptions, ReasoningContext, ReasoningMode, ServiceTier,
    SystemMessageModeOption, TOP_LOGPROBS_MAX, parse_provider_options,
};
use super::responses_tools::{PROVIDER_TOOL_NAMES, prepare_responses_tools};
use super::tools::TOOL_SEARCH_ID;
use crate::ai::errors::{ApiCallError, UnsupportedFunctionalityError};
use crate::ai::json::{js_stringify, normalize_numbers};
use crate::ai::model::LanguageModel;
use crate::ai::provider::{
    FinishReason, Headers, LanguageModelV4CallOptions, LanguageModelV4Content,
    LanguageModelV4FinishReason, LanguageModelV4FunctionTool, LanguageModelV4GenerateResult,
    LanguageModelV4InputTokens, LanguageModelV4OutputTokens, LanguageModelV4Request,
    LanguageModelV4Response, LanguageModelV4ResponseFormat, LanguageModelV4Source,
    LanguageModelV4StreamResult, LanguageModelV4Tool, LanguageModelV4Usage, ProviderMetadata,
    ReasoningEffort, SupportedUrls, Warning,
};
use crate::ai::providers::provider_utils::ToolNameMapping;
use crate::support::js::number;

/// How one provider reaches the OpenAI API (`OpenAIConfig`).
#[derive(Clone)]
pub struct OpenAIConfig {
    pub provider: String,
    /// The URL of an API path for a model: `(path, modelId)`.
    pub url: Arc<dyn Fn(&str, &str) -> anyhow::Result<String> + Send + Sync>,
    /// The provider's headers, built per request; a missing key fails here.
    pub headers: Arc<dyn Fn() -> anyhow::Result<Headers> + Send + Sync>,
    pub fetch: FetchFunction,
    /// The `@ai-sdk/provider-utils` version the user agent names.
    pub provider_utils_version: &'static str,
    /// Whether message input items carry `type: 'message'`.
    pub explicit_message_item_type: bool,
    /// Soft-deprecated: string file data starting with one of these is a file id.
    pub file_id_prefixes: Option<Vec<String>>,
}

pub struct OpenAIResponsesLanguageModel {
    model_id: String,
    config: OpenAIConfig,
}

impl OpenAIResponsesLanguageModel {
    pub fn new(model_id: &str, config: OpenAIConfig) -> Self {
        Self {
            model_id: model_id.to_string(),
            config,
        }
    }
}

static HTTP_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://.*$").unwrap());

/// What `prepareRequest` gives the call.
pub struct PreparedRequest {
    pub args: Value,
    pub warnings: Vec<Warning>,
    pub tool_name_mapping: ToolNameMapping,
    pub provider_options_name: String,
    /// The `store` provider option.
    pub store: Option<bool>,
}

fn reasoning_effort_text(reasoning: ReasoningEffort) -> &'static str {
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

/// `getConfigurationUpdateUnsupportedReason`: why a reasoning effort update cannot
/// be sent, if it cannot.
fn configuration_update_unsupported_reason(
    capabilities: &OpenAILanguageModelCapabilities,
    options: Option<&OpenAIResponsesOptions>,
) -> Option<&'static str> {
    if !capabilities.supports_configuration_update {
        return Some("reasoningEffortUpdate is only supported by GPT-6 and later models");
    }
    if options.is_some_and(|o| {
        o.reasoning_mode == Some(ReasoningMode::Pro)
            || o.context_management.is_some()
            || o.truncation == Some(super::responses_options::Truncation::Auto)
    }) {
        return Some(
            "reasoningEffortUpdate requires standard reasoning mode without automatic compaction or automatic truncation",
        );
    }
    None
}

/// The request body under construction: keys in the order the SDK writes them, a
/// `None` value standing for `undefined`.
struct Args(Vec<(&'static str, Option<Value>)>);

impl Args {
    fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| v.as_ref())
    }

    fn set(&mut self, key: &'static str, value: Option<Value>) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }

    fn delete(&mut self, key: &str) {
        self.0.retain(|(k, _)| *k != key);
    }

    fn into_value(self) -> Value {
        let mut out = Map::new();
        for (key, value) in self.0 {
            if let Some(value) = value {
                out.insert(key.to_string(), value);
            }
        }
        normalize_numbers(Value::Object(out))
    }
}

pub(super) fn string(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

/// `prepareRequest`: the request body, the warnings, and what parsing the response
/// needs.
pub fn prepare_request(
    model_id: &str,
    config: &OpenAIConfig,
    options: &LanguageModelV4CallOptions,
) -> anyhow::Result<PreparedRequest> {
    let mut warnings: Vec<Warning> = Vec::new();
    let capabilities = get_openai_language_model_capabilities(model_id);

    let unsupported_setting = |feature: &str| Warning::Unsupported {
        feature: feature.to_string(),
        details: None,
    };
    if options.top_k.is_some() {
        warnings.push(unsupported_setting("topK"));
    }
    if options.seed.is_some() {
        warnings.push(unsupported_setting("seed"));
    }
    if options.presence_penalty.is_some() {
        warnings.push(unsupported_setting("presencePenalty"));
    }
    if options.frequency_penalty.is_some() {
        warnings.push(unsupported_setting("frequencyPenalty"));
    }
    if options.stop_sequences.is_some() {
        warnings.push(unsupported_setting("stopSequences"));
    }

    let provider_options_name = if config.provider.contains("azure") {
        "azure"
    } else {
        "openai"
    };
    let mut openai_options: Option<OpenAIResponsesOptions> =
        parse_provider_options(provider_options_name, options.provider_options.as_ref())?;
    if openai_options.is_none() && provider_options_name != "openai" {
        openai_options = parse_provider_options("openai", options.provider_options.as_ref())?;
    }
    let opts = openai_options.as_ref();

    if opts.is_some_and(|o| o.allowed_tools.is_some()) {
        return Err(UnsupportedFunctionalityError::new("allowedTools").into());
    }

    let mut resolved_reasoning_effort: Option<String> =
        opts.and_then(|o| o.reasoning_effort.clone()).or_else(|| {
            options
                .reasoning
                .filter(|r| *r != ReasoningEffort::ProviderDefault)
                .map(|r| reasoning_effort_text(r).to_string())
        });
    if let (Some(effort), Some(supported)) = (
        resolved_reasoning_effort.as_deref(),
        capabilities.supported_reasoning_efforts,
    ) && !supported.contains(&effort)
    {
        warnings.push(Warning::Unsupported {
            feature: "reasoningEffort".to_string(),
            details: Some(format!(
                "{model_id} only supports the following reasoning efforts: {}",
                supported.join(", ")
            )),
        });
        resolved_reasoning_effort = None;
    }

    let resolved_reasoning_summary: Option<String> =
        match opts.and_then(|o| o.reasoning_summary.clone()) {
            Some(summary) => Some(summary),
            None => resolved_reasoning_effort
                .as_deref()
                .filter(|effort| *effort != "none")
                .map(|_| "detailed".to_string()),
        };

    let is_reasoning_model = opts
        .and_then(|o| o.force_reasoning)
        .unwrap_or(capabilities.is_reasoning_model);

    if opts.is_some_and(|o| o.conversation.is_some() && o.previous_response_id.is_some()) {
        warnings.push(Warning::Unsupported {
            feature: "conversation".to_string(),
            details: Some(
                "conversation and previousResponseId cannot be used together".to_string(),
            ),
        });
    }

    let tools = options.tools.as_deref();
    let tool_name_mapping = ToolNameMapping::new(tools, PROVIDER_TOOL_NAMES);
    let prepared_tools = prepare_responses_tools(
        tools,
        options.tool_choice.as_ref(),
        &tool_name_mapping,
        capabilities.supports_async_tool_calling,
    )?;

    let update_unsupported_reason = configuration_update_unsupported_reason(&capabilities, opts);

    let tool_search_tool_name = tools.and_then(|tools| {
        tools.iter().find_map(|tool| match tool {
            LanguageModelV4Tool::Provider(tool) if tool.id == TOOL_SEARCH_ID => {
                Some(tool.name.as_str())
            }
            _ => None,
        })
    });
    let system_message_mode = match opts.and_then(|o| o.system_message_mode) {
        Some(SystemMessageModeOption::System) => SystemMessageMode::System,
        Some(SystemMessageModeOption::Developer) => SystemMessageMode::Developer,
        Some(SystemMessageModeOption::Remove) => SystemMessageMode::Remove,
        None if is_reasoning_model => SystemMessageMode::Developer,
        None => capabilities.system_message_mode,
    };
    let (mut input, input_warnings) = convert_to_openai_responses_input(
        &options.prompt,
        &ConvertInputOptions {
            tool_name_mapping: &tool_name_mapping,
            system_message_mode,
            provider_options_name,
            explicit_message_item_type: config.explicit_message_item_type,
            file_id_prefixes: config.file_id_prefixes.as_deref(),
            pass_through_unsupported_files: opts
                .and_then(|o| o.pass_through_unsupported_files)
                .unwrap_or(false),
            store: opts.and_then(|o| o.store).unwrap_or(true),
            is_reasoning_model,
            has_conversation: opts.is_some_and(|o| o.conversation.is_some()),
            has_previous_response_id: opts.is_some_and(|o| o.previous_response_id.is_some()),
            tool_search_tool_name,
            output_schema_tool_names: &prepared_tools.output_schema_tool_names,
            configuration_update_unsupported_reason: update_unsupported_reason,
        },
    )?;
    warnings.extend(input_warnings);

    // The schema accepts update efforts supported by any model; this one may not.
    let update_effort_unsupported_reason = |effort: Option<&str>| -> Option<String> {
        let (effort, supported) = (effort?, capabilities.supported_reasoning_efforts?);
        (!supported.contains(&effort)).then(|| {
            format!(
                "{model_id} only supports the following reasoning efforts: {}",
                supported.join(", ")
            )
        })
    };
    let update_effort = |item: &Value| -> Option<String> {
        (item.get("type").and_then(Value::as_str) == Some("configuration_update"))
            .then(|| item["reasoning"]["effort"].as_str().map(str::to_string))
            .flatten()
    };
    for item in &input {
        if let Some(effort) = update_effort(item)
            && let Some(reason) = update_effort_unsupported_reason(Some(&effort))
        {
            return Err(UnsupportedFunctionalityError::with_message(
                "Message-level reasoningEffortUpdate",
                &reason,
            )
            .into());
        }
    }

    if let Some(effort) = opts.and_then(|o| o.reasoning_effort_update) {
        let effort = super::responses_input::effort_text(effort);
        let reason = update_unsupported_reason
            .map(str::to_string)
            .or_else(|| update_effort_unsupported_reason(Some(effort)));
        match reason {
            Some(reason) => warnings.push(Warning::Unsupported {
                feature: "reasoningEffortUpdate".to_string(),
                details: Some(reason),
            }),
            None => {
                // A first item that already sets this effort would make an adjacent
                // pair, which OpenAI rejects.
                if input.first().and_then(update_effort).as_deref() != Some(effort) {
                    input.insert(0, configuration_update(effort));
                }
            }
        }
    }

    // Conversion and prepending can make updates adjacent.
    for pair in input.windows(2) {
        if update_effort(&pair[0]).is_some() && update_effort(&pair[1]).is_some() {
            return Err(UnsupportedFunctionalityError::new(
                "Adjacent reasoning effort configuration updates",
            )
            .into());
        }
    }

    // A compaction trigger is a request control that OpenAI requires as the last
    // input item.
    if opts.and_then(|o| o.compaction_trigger) == Some(true) {
        let mut trigger = Map::new();
        trigger.insert("type".to_string(), string("compaction_trigger"));
        input.push(Value::Object(trigger));
    }

    let strict_json_schema = opts.and_then(|o| o.strict_json_schema).unwrap_or(true);
    let normalized_response_format_schema = match &options.response_format {
        Some(LanguageModelV4ResponseFormat::Json {
            schema: Some(schema),
            ..
        }) => {
            let (schema, schema_warnings) = normalize_openai_json_schema(schema)?;
            warnings.extend(schema_warnings);
            Some(schema)
        }
        _ => None,
    };

    let mut include: Option<Vec<String>> = opts
        .and_then(|o| o.include.as_ref())
        .map(|values| values.iter().map(|v| v.as_str().to_string()).collect());
    let mut add_include = |key: &str| match &mut include {
        None => include = Some(vec![key.to_string()]),
        Some(list) if !list.iter().any(|v| v == key) => list.push(key.to_string()),
        Some(_) => {}
    };

    // When logprobs are requested, include them.
    let top_logprobs = match opts.and_then(|o| o.logprobs) {
        Some(Logprobs::Count(count)) => Some(count),
        Some(Logprobs::Flag(true)) => Some(TOP_LOGPROBS_MAX as f64),
        _ => None,
    };
    if top_logprobs.is_some_and(|n| n != 0.0) {
        add_include(IncludeValue::MessageOutputTextLogprobs.as_str());
    }

    let store = opts.and_then(|o| o.store);
    // store defaults to true in the Responses API, so check for false exactly.
    if store == Some(false) && is_reasoning_model {
        add_include(IncludeValue::ReasoningEncryptedContent.as_str());
    }

    let text = {
        let is_json = matches!(
            options.response_format,
            Some(LanguageModelV4ResponseFormat::Json { .. })
        );
        let verbosity = opts.and_then(|o| o.text_verbosity);
        (is_json || verbosity.is_some()).then(|| {
            let mut text = Map::new();
            if let Some(LanguageModelV4ResponseFormat::Json {
                name, description, ..
            }) = &options.response_format
            {
                let mut format = Map::new();
                match normalized_response_format_schema {
                    Some(schema) => {
                        format.insert("type".to_string(), string("json_schema"));
                        format.insert("strict".to_string(), Value::Bool(strict_json_schema));
                        format.insert(
                            "name".to_string(),
                            string(name.clone().unwrap_or_else(|| "response".to_string())),
                        );
                        if let Some(description) = description {
                            format.insert("description".to_string(), string(description.clone()));
                        }
                        format.insert("schema".to_string(), schema);
                    }
                    None => {
                        format.insert("type".to_string(), string("json_object"));
                    }
                }
                text.insert("format".to_string(), Value::Object(format));
            }
            if let Some(verbosity) = verbosity {
                text.insert("verbosity".to_string(), string(verbosity.as_str()));
            }
            Value::Object(text)
        })
    };

    let reasoning = (is_reasoning_model
        && (resolved_reasoning_effort.is_some()
            || resolved_reasoning_summary.is_some()
            || opts.is_some_and(|o| o.reasoning_mode.is_some() || o.reasoning_context.is_some())))
    .then(|| {
        let mut reasoning = Map::new();
        if let Some(effort) = &resolved_reasoning_effort {
            reasoning.insert("effort".to_string(), string(effort.clone()));
        }
        if let Some(summary) = &resolved_reasoning_summary {
            reasoning.insert("summary".to_string(), string(summary.clone()));
        }
        if let Some(mode) = opts.and_then(|o| o.reasoning_mode) {
            let mode = match mode {
                ReasoningMode::Standard => "standard",
                ReasoningMode::Pro => "pro",
            };
            reasoning.insert("mode".to_string(), string(mode));
        }
        if let Some(context) = opts.and_then(|o| o.reasoning_context) {
            let context = match context {
                ReasoningContext::Auto => "auto",
                ReasoningContext::CurrentTurn => "current_turn",
                ReasoningContext::AllTurns => "all_turns",
            };
            reasoning.insert("context".to_string(), string(context));
        }
        Value::Object(reasoning)
    });

    let mut args = Args(vec![
        ("model", Some(string(model_id))),
        ("input", Some(Value::Array(input.clone()))),
        ("temperature", options.temperature.map(number)),
        ("top_p", options.top_p.map(number)),
        (
            "max_output_tokens",
            options.max_output_tokens.map(Value::from),
        ),
        ("text", text),
        (
            "conversation",
            opts.and_then(|o| o.conversation.clone()).map(string),
        ),
        (
            "max_tool_calls",
            opts.and_then(|o| o.max_tool_calls.clone())
                .map(Value::Number),
        ),
        ("metadata", opts.and_then(|o| o.metadata.clone())),
        (
            "parallel_tool_calls",
            opts.and_then(|o| o.parallel_tool_calls).map(Value::Bool),
        ),
        (
            "previous_response_id",
            opts.and_then(|o| o.previous_response_id.clone())
                .map(string),
        ),
        ("store", store.map(Value::Bool)),
        ("user", opts.and_then(|o| o.user.clone()).map(string)),
        (
            "instructions",
            opts.and_then(|o| o.instructions.clone()).map(string),
        ),
        (
            "service_tier",
            opts.and_then(|o| o.service_tier)
                .map(|t| string(t.as_str())),
        ),
        (
            "include",
            include
                .clone()
                .map(|list| Value::Array(list.into_iter().map(string).collect())),
        ),
        (
            "prompt_cache_key",
            opts.and_then(|o| o.prompt_cache_key.clone()).map(string),
        ),
        (
            "prompt_cache_options",
            opts.and_then(|o| o.prompt_cache_options.as_ref())
                .map(|o| o.to_json()),
        ),
        (
            "prompt_cache_retention",
            opts.and_then(|o| o.prompt_cache_retention).map(|r| {
                string(match r {
                    super::responses_options::PromptCacheRetention::InMemory => "in_memory",
                    super::responses_options::PromptCacheRetention::Day => "24h",
                })
            }),
        ),
        (
            "safety_identifier",
            opts.and_then(|o| o.safety_identifier.clone()).map(string),
        ),
        ("top_logprobs", top_logprobs.map(number)),
        (
            "truncation",
            opts.and_then(|o| o.truncation).map(|t| {
                string(match t {
                    super::responses_options::Truncation::Auto => "auto",
                    super::responses_options::Truncation::Disabled => "disabled",
                })
            }),
        ),
    ]);
    if let Some(context_management) = opts.and_then(|o| o.context_management.as_ref()) {
        let entries = context_management
            .iter()
            .map(|cm| {
                let mut entry = Map::new();
                entry.insert("type".to_string(), string("compaction"));
                entry.insert(
                    "compact_threshold".to_string(),
                    number(cm.compact_threshold),
                );
                Value::Object(entry)
            })
            .collect();
        args.set("context_management", Some(Value::Array(entries)));
    }
    if reasoning.is_some() {
        args.set("reasoning", reasoning);
    }

    if capabilities.supports_configuration_update && args.get("prompt_cache_retention").is_some() {
        args.set("prompt_cache_retention", None);
        warnings.push(Warning::Unsupported {
            feature: "promptCacheRetention".to_string(),
            details: Some(
                "promptCacheRetention is not supported by GPT-6 and later models; use promptCacheOptions instead"
                    .to_string(),
            ),
        });
    }

    // Remove the settings reasoning models do not take.
    if is_reasoning_model {
        // Input updates change the effort sampling parameters are checked against.
        let mut effective_effort = resolved_reasoning_effort.clone();
        for item in &input {
            if let Some(effort) = update_effort(item) {
                effective_effort = Some(effort);
            }
        }
        // Supported models take temperature, topP and logprobs with reasoning off.
        if !(effective_effort.as_deref() == Some("none")
            && capabilities.supports_non_reasoning_parameters)
        {
            if args.get("temperature").is_some() {
                args.set("temperature", None);
                warnings.push(Warning::Unsupported {
                    feature: "temperature".to_string(),
                    details: Some("temperature is not supported for reasoning models".to_string()),
                });
            }
            if args.get("top_p").is_some() {
                args.set("top_p", None);
                warnings.push(Warning::Unsupported {
                    feature: "topP".to_string(),
                    details: Some("topP is not supported for reasoning models".to_string()),
                });
            }
            let includes_logprobs = include
                .as_ref()
                .is_some_and(|list| list.iter().any(|v| v == "message.output_text.logprobs"));
            if capabilities.supported_reasoning_efforts.is_some()
                && (args.get("top_logprobs").is_some() || includes_logprobs)
            {
                args.set("top_logprobs", None);
                let filtered: Option<Vec<String>> = include.as_ref().map(|list| {
                    list.iter()
                        .filter(|v| *v != "message.output_text.logprobs")
                        .cloned()
                        .collect()
                });
                args.set(
                    "include",
                    filtered
                        .filter(|list| !list.is_empty())
                        .map(|list| Value::Array(list.into_iter().map(string).collect())),
                );
                warnings.push(Warning::Unsupported {
                    feature: "logprobs".to_string(),
                    details: Some("logprobs is not supported for reasoning models".to_string()),
                });
            }
        }
    } else {
        let unsupported_option = |feature: &str| Warning::Unsupported {
            feature: feature.to_string(),
            details: Some(format!(
                "{feature} is not supported for non-reasoning models"
            )),
        };
        if opts.is_some_and(|o| o.reasoning_effort.is_some()) {
            warnings.push(unsupported_option("reasoningEffort"));
        }
        if opts.is_some_and(|o| o.reasoning_summary.is_some()) {
            warnings.push(unsupported_option("reasoningSummary"));
        }
        if opts.is_some_and(|o| o.reasoning_mode.is_some()) {
            warnings.push(unsupported_option("reasoningMode"));
        }
        if opts.is_some_and(|o| o.reasoning_context.is_some()) {
            warnings.push(unsupported_option("reasoningContext"));
        }
    }

    let service_tier = opts.and_then(|o| o.service_tier);
    if service_tier == Some(ServiceTier::Flex) && !capabilities.supports_flex_processing {
        warnings.push(Warning::Unsupported {
            feature: "serviceTier".to_string(),
            details: Some(
                "flex processing is only available for o3, o4-mini, and gpt-5 models".to_string(),
            ),
        });
        args.delete("service_tier");
    }
    if matches!(
        service_tier,
        Some(ServiceTier::Priority) | Some(ServiceTier::Fast)
    ) && !capabilities.supports_priority_processing
    {
        warnings.push(Warning::Unsupported {
            feature: "serviceTier".to_string(),
            details: Some(
                "priority processing is only available for supported models (gpt-4, gpt-5, gpt-5-mini, o3, o4-mini) and requires Enterprise access. gpt-5-nano is not supported"
                    .to_string(),
            ),
        });
        args.delete("service_tier");
    }

    args.set("tools", prepared_tools.tools.map(Value::Array));
    args.set("tool_choice", prepared_tools.tool_choice);
    warnings.extend(prepared_tools.tool_warnings);

    Ok(PreparedRequest {
        args: args.into_value(),
        warnings,
        tool_name_mapping,
        provider_options_name: provider_options_name.to_string(),
        store,
    })
}

#[async_trait]
impl LanguageModel for OpenAIResponsesLanguageModel {
    fn provider(&self) -> &str {
        &self.config.provider
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn supported_urls(&self) -> SupportedUrls {
        let mut urls = SupportedUrls::new();
        urls.insert("image/*".to_string(), vec![HTTP_URL.clone()]);
        urls.insert("application/pdf".to_string(), vec![HTTP_URL.clone()]);
        urls
    }

    async fn do_generate(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        let PreparedRequest {
            args: body,
            warnings,
            tool_name_mapping,
            provider_options_name,
            ..
        } = prepare_request(&self.model_id, &self.config, &options)?;
        let url = (self.config.url)("/responses", &self.model_id)?;

        let provider_headers = (self.config.headers)()?;
        let headers = combine_headers(&[Some(&provider_headers), options.headers.as_ref()]);
        let response = post_json(
            &url,
            &headers,
            &body,
            options.abort_signal.as_ref(),
            &self.config.fetch,
            self.config.provider_utils_version,
        )
        .await?;
        if !response.ok() {
            return Err(openai_failed_response_error(&response, &url, &body));
        }
        let raw = parse_json_body(&response, &url, &body)?;
        let parsed = ParsedResponse::from_raw(&raw)
            .map_err(|cause| invalid_json_response(&response, &url, &body, cause))?;

        let api_error = |message: String, status_code: u16| -> anyhow::Error {
            let mut error = ApiCallError::new(
                message,
                url.clone(),
                body.clone(),
                Some(status_code),
                Some(response.headers.clone()),
                Some(js_stringify(&raw)),
            );
            error.is_retryable = false;
            error.into()
        };
        if let Some(message) = &parsed.error_message {
            return Err(api_error(message.clone(), 400));
        }
        let Some(output) = &parsed.output else {
            let message = match &parsed.incomplete_reason {
                Some(detail) => format!("Responses API returned no output ({detail})"),
                None => "Responses API returned no output".to_string(),
            };
            return Err(api_error(message, 500));
        };

        let function_tools: Vec<&LanguageModelV4FunctionTool> = options
            .tools
            .iter()
            .flatten()
            .filter_map(|tool| match tool {
                LanguageModelV4Tool::Function(tool) => Some(tool),
                LanguageModelV4Tool::Provider(_) => None,
            })
            .collect();
        let wants_logprobs = options
            .provider_options
            .as_ref()
            .and_then(|o| o.get(&provider_options_name))
            .and_then(|o| o.get("logprobs"))
            .is_some_and(super::responses_input::is_truthy);
        let mapped = map_output(
            output,
            &provider_options_name,
            &tool_name_mapping,
            &function_tools,
            wants_logprobs,
        );

        let mut response_metadata = Map::new();
        if let Some(id) = &parsed.id {
            response_metadata.insert("responseId".to_string(), string(id.clone()));
        }
        if !mapped.logprobs.is_empty() {
            response_metadata.insert(
                "logprobs".to_string(),
                Value::Array(mapped.logprobs.clone()),
            );
        }
        if let Some(Value::String(tier)) = raw.get("service_tier") {
            response_metadata.insert("serviceTier".to_string(), string(tier.clone()));
        }
        if let Some(context) = &parsed.reasoning_context {
            response_metadata.insert("reasoningContext".to_string(), string(context.clone()));
        }
        let mut provider_metadata = ProviderMetadata::new();
        provider_metadata.insert(
            provider_options_name.clone(),
            Value::Object(response_metadata),
        );

        Ok(LanguageModelV4GenerateResult {
            content: mapped.content,
            finish_reason: LanguageModelV4FinishReason {
                unified: map_finish_reason(
                    parsed.incomplete_reason.as_deref(),
                    mapped.has_function_call,
                ),
                raw: parsed.incomplete_reason.clone(),
            },
            usage: convert_usage(raw.get("usage")),
            provider_metadata: Some(provider_metadata),
            request: Some(LanguageModelV4Request {
                body: Some(body.clone()),
            }),
            response: Some(LanguageModelV4Response {
                id: parsed.id.clone(),
                timestamp: parsed.created_at.and_then(timestamp_of),
                model_id: parsed.model.clone(),
                headers: Some(response.headers.clone()),
                body: Some(raw.clone()),
            }),
            warnings,
        })
    }

    async fn do_stream(
        &self,
        options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4StreamResult> {
        super::responses_stream::do_stream(&self.model_id, &self.config, options).await
    }
}

/// `new Date(created_at * 1000)`.
pub(super) fn timestamp_of(created_at: f64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis((created_at * 1000.0).trunc() as i64)
}

/// `mapOpenAIResponseFinishReason`.
pub(super) fn map_finish_reason(reason: Option<&str>, has_function_call: bool) -> FinishReason {
    match reason {
        None => {
            if has_function_call {
                FinishReason::ToolCalls
            } else {
                FinishReason::Stop
            }
        }
        Some("max_output_tokens") => FinishReason::Length,
        Some("content_filter") => FinishReason::ContentFilter,
        Some(_) => {
            if has_function_call {
                FinishReason::ToolCalls
            } else {
                FinishReason::Other
            }
        }
    }
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_f64).map(|n| n as i64)
}

/// `convertOpenAIResponsesUsage`.
pub(super) fn convert_usage(usage: Option<&Value>) -> LanguageModelV4Usage {
    let Some(Value::Object(usage)) = usage else {
        return LanguageModelV4Usage::default();
    };
    let input_tokens = as_i64(usage.get("input_tokens")).unwrap_or(0);
    let output_tokens = as_i64(usage.get("output_tokens")).unwrap_or(0);
    let input_details = usage.get("input_tokens_details");
    let cached_tokens = as_i64(input_details.and_then(|d| d.get("cached_tokens"))).unwrap_or(0);
    let cache_write_tokens = as_i64(input_details.and_then(|d| d.get("cache_write_tokens")));
    let reasoning_tokens = as_i64(
        usage
            .get("output_tokens_details")
            .and_then(|d| d.get("reasoning_tokens")),
    )
    .unwrap_or(0);
    LanguageModelV4Usage {
        input_tokens: LanguageModelV4InputTokens {
            total: Some(input_tokens),
            no_cache: Some(input_tokens - cached_tokens - cache_write_tokens.unwrap_or(0)),
            cache_read: Some(cached_tokens),
            cache_write: cache_write_tokens,
        },
        output_tokens: LanguageModelV4OutputTokens {
            total: Some(output_tokens),
            text: Some(output_tokens - reasoning_tokens),
            reasoning: Some(reasoning_tokens),
        },
        raw: Some(usage.clone()),
    }
}

/// The top level of a response, checked as `openaiResponsesResponseSchema` checks
/// it.
struct ParsedResponse {
    id: Option<String>,
    created_at: Option<f64>,
    error_message: Option<String>,
    model: Option<String>,
    output: Option<Vec<Value>>,
    reasoning_context: Option<String>,
    incomplete_reason: Option<String>,
}

pub(super) fn invalid(message: &str) -> anyhow::Error {
    anyhow::anyhow!("{message}")
}

/// `value` when the key is absent, null, or the given kind.
pub(super) fn optional<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    nullable: bool,
    check: fn(&Value) -> bool,
) -> anyhow::Result<Option<&'a Value>> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Null) if nullable => Ok(None),
        Some(value) if check(value) => Ok(Some(value)),
        Some(_) => Err(invalid(&format!("invalid {key}"))),
    }
}

pub(super) fn required<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    check: fn(&Value) -> bool,
) -> anyhow::Result<&'a Value> {
    match object.get(key) {
        Some(value) if check(value) => Ok(value),
        _ => Err(invalid(&format!("invalid {key}"))),
    }
}

pub(super) fn is_string(value: &Value) -> bool {
    value.is_string()
}

pub(super) fn is_number(value: &Value) -> bool {
    value.is_number()
}

pub(super) fn is_object(value: &Value) -> bool {
    value.is_object()
}

pub(super) fn is_array(value: &Value) -> bool {
    value.is_array()
}

pub(super) fn is_bool(value: &Value) -> bool {
    value.is_boolean()
}

pub(super) fn is_string_or_null(value: &Value) -> bool {
    value.is_string() || value.is_null()
}

/// The output item types the response schema knows. The ones this port maps are
/// checked field by field; the others belong to hosted tools the request refuses.
const KNOWN_ITEM_TYPES: &[&str] = &[
    "message",
    "web_search_call",
    "file_search_call",
    "code_interpreter_call",
    "image_generation_call",
    "local_shell_call",
    "function_call",
    "program",
    "program_output",
    "custom_tool_call",
    "computer_call",
    "reasoning",
    "mcp_call",
    "mcp_list_tools",
    "mcp_approval_request",
    "apply_patch_call",
    "shell_call",
    "compaction",
    "shell_call_output",
    "tool_search_call",
    "tool_search_output",
];

impl ParsedResponse {
    fn from_raw(raw: &Value) -> anyhow::Result<Self> {
        let Value::Object(top) = raw else {
            return Err(invalid("the response is not an object"));
        };
        let id = optional(top, "id", false, is_string)?
            .and_then(Value::as_str)
            .map(str::to_string);
        let created_at = optional(top, "created_at", false, is_number)?.and_then(Value::as_f64);
        let error_message = match optional(top, "error", true, is_object)? {
            None => None,
            Some(error) => {
                let error = error.as_object().expect("an object");
                let message = required(error, "message", is_string)?;
                required(error, "type", is_string)?;
                optional(error, "param", true, is_string)?;
                required(error, "code", is_string)?;
                message.as_str().map(str::to_string)
            }
        };
        let model = optional(top, "model", false, is_string)?
            .and_then(Value::as_str)
            .map(str::to_string);
        let output = match optional(top, "output", false, is_array)? {
            None => None,
            Some(items) => {
                let items = items.as_array().expect("an array");
                for item in items {
                    check_output_item(item)?;
                }
                Some(items.clone())
            }
        };
        optional(top, "service_tier", true, is_string)?;
        let reasoning_context = match optional(top, "reasoning", true, is_object)? {
            None => None,
            Some(reasoning) => optional(
                reasoning.as_object().expect("an object"),
                "context",
                true,
                is_string,
            )?
            .and_then(Value::as_str)
            .map(str::to_string),
        };
        let incomplete_reason = match optional(top, "incomplete_details", true, is_object)? {
            None => None,
            Some(details) => Some(
                required(details.as_object().expect("an object"), "reason", is_string)?
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            ),
        };
        if let Some(usage) = optional(top, "usage", true, is_object)? {
            check_usage(usage.as_object().expect("an object"))?;
        }
        Ok(Self {
            id,
            created_at,
            error_message,
            model,
            output,
            reasoning_context,
            incomplete_reason,
        })
    }
}

pub(super) fn check_usage(usage: &Map<String, Value>) -> anyhow::Result<()> {
    required(usage, "input_tokens", is_number)?;
    required(usage, "output_tokens", is_number)?;
    optional(usage, "total_tokens", false, is_number)?;
    if let Some(details) = optional(usage, "input_tokens_details", true, is_object)? {
        let details = details.as_object().expect("an object");
        for key in [
            "cached_tokens",
            "cache_write_tokens",
            "orchestration_input_tokens",
            "orchestration_input_cached_tokens",
        ] {
            optional(details, key, true, is_number)?;
        }
        if let Some(ttl) = optional(details, "cache_write_tokens_details", true, is_object)? {
            let ttl = ttl.as_object().expect("an object");
            for key in ["ttl_30m_tokens", "ttl_12h_tokens"] {
                optional(ttl, key, true, is_number)?;
            }
        }
    }
    if let Some(details) = optional(usage, "output_tokens_details", true, is_object)? {
        let details = details.as_object().expect("an object");
        for key in ["reasoning_tokens", "orchestration_output_tokens"] {
            optional(details, key, true, is_number)?;
        }
    }
    Ok(())
}

fn check_output_item(item: &Value) -> anyhow::Result<()> {
    let Value::Object(item) = item else {
        return Err(invalid("an output item is not an object"));
    };
    let kind = required(item, "type", is_string)?
        .as_str()
        .unwrap_or_default();
    if !KNOWN_ITEM_TYPES.contains(&kind) {
        return Err(invalid(&format!("unknown output item type {kind}")));
    }
    match kind {
        "message" => {
            if item.get("role").and_then(Value::as_str) != Some("assistant") {
                return Err(invalid("invalid role"));
            }
            required(item, "id", is_string)?;
            if let Some(phase) = optional(item, "phase", true, is_string)?
                && !matches!(phase.as_str(), Some("commentary" | "final_answer"))
            {
                return Err(invalid("invalid phase"));
            }
            for part in required(item, "content", is_array)?
                .as_array()
                .expect("an array")
            {
                let Value::Object(part) = part else {
                    return Err(invalid("invalid content part"));
                };
                if part.get("type").and_then(Value::as_str) != Some("output_text") {
                    return Err(invalid("invalid content part type"));
                }
                required(part, "text", is_string)?;
                optional(part, "logprobs", true, is_array)?;
                for annotation in required(part, "annotations", is_array)?
                    .as_array()
                    .expect("an array")
                {
                    annotation_in_schema_order(annotation)
                        .ok_or_else(|| invalid("invalid annotation"))?;
                }
            }
        }
        "function_call" => {
            for key in ["call_id", "name", "arguments", "id"] {
                required(item, key, is_string)?;
            }
            optional(item, "async", true, is_bool)?;
            optional(item, "namespace", true, is_string)?;
            if let Some(caller) = optional(item, "caller", true, is_object)? {
                match caller.get("type").and_then(Value::as_str) {
                    Some("direct") => {}
                    Some("program") if caller.get("caller_id").is_some_and(Value::is_string) => {}
                    _ => return Err(invalid("invalid caller")),
                }
            }
        }
        "custom_tool_call" => {
            for key in ["call_id", "name", "input", "id"] {
                required(item, key, is_string)?;
            }
            optional(item, "async", true, is_bool)?;
        }
        "reasoning" => {
            required(item, "id", is_string)?;
            optional(item, "encrypted_content", true, is_string)?;
            for summary in required(item, "summary", is_array)?
                .as_array()
                .expect("an array")
            {
                let Value::Object(summary) = summary else {
                    return Err(invalid("invalid summary"));
                };
                if summary.get("type").and_then(Value::as_str) != Some("summary_text") {
                    return Err(invalid("invalid summary type"));
                }
                required(summary, "text", is_string)?;
            }
        }
        "tool_search_call" | "tool_search_output" => {
            required(item, "id", is_string)?;
            if !matches!(
                item.get("execution").and_then(Value::as_str),
                Some("server" | "client")
            ) {
                return Err(invalid("invalid execution"));
            }
            required(item, "call_id", is_string_or_null)?;
            if !matches!(
                item.get("status").and_then(Value::as_str),
                Some("in_progress" | "completed" | "incomplete")
            ) {
                return Err(invalid("invalid status"));
            }
            if kind == "tool_search_output" {
                let tools = required(item, "tools", is_array)?
                    .as_array()
                    .expect("an array");
                if !tools.iter().all(Value::is_object) {
                    return Err(invalid("invalid tools"));
                }
            }
        }
        "compaction" => {
            required(item, "id", is_string)?;
            required(item, "encrypted_content", is_string)?;
        }
        _ => {}
    }
    Ok(())
}

/// An annotation as zod parses it: the keys of its kind in schema order; `None`
/// when it matches no kind.
pub(super) fn annotation_in_schema_order(annotation: &Value) -> Option<Value> {
    let annotation = annotation.as_object()?;
    let kind = annotation.get("type")?.as_str()?;
    let keys: &[(&str, fn(&Value) -> bool)] = match kind {
        "url_citation" => &[
            ("start_index", is_number),
            ("end_index", is_number),
            ("url", is_string),
            ("title", is_string),
        ],
        "file_citation" => &[
            ("file_id", is_string),
            ("filename", is_string),
            ("index", is_number),
        ],
        "container_file_citation" => &[
            ("container_id", is_string),
            ("file_id", is_string),
            ("filename", is_string),
            ("start_index", is_number),
            ("end_index", is_number),
        ],
        "file_path" => &[("file_id", is_string), ("index", is_number)],
        _ => return None,
    };
    let mut out = Map::new();
    out.insert("type".to_string(), string(kind));
    for (key, check) in keys {
        let value = annotation.get(*key).filter(|v| check(v))?;
        out.insert(key.to_string(), value.clone());
    }
    Some(Value::Object(out))
}

/// `mapOpenAIResponsesAnnotationSource`.
pub(super) fn annotation_source(
    annotation: &Value,
    name: &str,
    id: String,
) -> LanguageModelV4Source {
    let kind = annotation["type"].as_str().unwrap_or_default();
    if kind == "url_citation" {
        return LanguageModelV4Source::Url {
            id,
            url: annotation["url"].as_str().unwrap_or_default().to_string(),
            title: annotation["title"].as_str().map(str::to_string),
            provider_metadata: None,
        };
    }
    let filename = if kind == "file_path" {
        annotation["file_id"].as_str()
    } else {
        annotation["filename"].as_str()
    }
    .unwrap_or_default()
    .to_string();
    let mut metadata = Map::new();
    metadata.insert("type".to_string(), string(kind));
    metadata.insert("fileId".to_string(), annotation["file_id"].clone());
    if kind == "container_file_citation" {
        metadata.insert(
            "containerId".to_string(),
            annotation["container_id"].clone(),
        );
    } else {
        metadata.insert("index".to_string(), annotation["index"].clone());
    }
    let mut provider_metadata = ProviderMetadata::new();
    provider_metadata.insert(name.to_string(), Value::Object(metadata));
    LanguageModelV4Source::Document {
        id,
        media_type: if kind == "file_path" {
            "application/octet-stream".to_string()
        } else {
            "text/plain".to_string()
        },
        title: filename.clone(),
        filename: Some(filename),
        provider_metadata: Some(provider_metadata),
    }
}

/// `{ [name]: metadata }`.
pub(super) fn metadata_under(name: &str, metadata: Map<String, Value>) -> ProviderMetadata {
    let mut out = ProviderMetadata::new();
    out.insert(name.to_string(), Value::Object(metadata));
    out
}

struct MappedOutput {
    content: Vec<LanguageModelV4Content>,
    logprobs: Vec<Value>,
    has_function_call: bool,
}

/// The response's output items as content parts.
fn map_output(
    output: &[Value],
    name: &str,
    tool_name_mapping: &ToolNameMapping,
    function_tools: &[&LanguageModelV4FunctionTool],
    wants_logprobs: bool,
) -> MappedOutput {
    let mut content = Vec::new();
    let mut logprobs = Vec::new();
    let has_web_search_action_sources = output.iter().any(|item| {
        item["type"] == "web_search_call"
            && item["action"]["type"] == "search"
            && item["action"]["sources"]
                .as_array()
                .is_some_and(|sources| sources.iter().any(|s| s["type"] == "url"))
    });
    let has_file_search_results = output.iter().any(|item| {
        item["type"] == "file_search_call"
            && item["results"].as_array().is_some_and(|r| !r.is_empty())
    });
    // Whether a call the client runs was made.
    let mut has_function_call = false;
    let mut hosted_tool_search_call_ids: Vec<String> = Vec::new();

    for item in output {
        let str_of = |key: &str| item[key].as_str().unwrap_or_default().to_string();
        match item["type"].as_str().unwrap_or_default() {
            "reasoning" => {
                let mut summaries: Vec<String> = item["summary"]
                    .as_array()
                    .map(|s| {
                        s.iter()
                            .map(|p| p["text"].as_str().unwrap_or_default().to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                // An item without summary parts gives one empty reasoning part.
                if summaries.is_empty() {
                    summaries.push(String::new());
                }
                for summary in summaries {
                    let mut metadata = Map::new();
                    metadata.insert("itemId".to_string(), item["id"].clone());
                    metadata.insert(
                        "reasoningEncryptedContent".to_string(),
                        item.get("encrypted_content")
                            .cloned()
                            .unwrap_or(Value::Null),
                    );
                    content.push(LanguageModelV4Content::Reasoning {
                        text: summary,
                        provider_metadata: Some(metadata_under(name, metadata)),
                    });
                }
            }

            "tool_search_call" => {
                let call_id = item["call_id"].as_str().map(str::to_string);
                let tool_call_id = call_id.clone().unwrap_or_else(|| str_of("id"));
                let is_hosted = item["execution"] == "server";
                if is_hosted {
                    hosted_tool_search_call_ids.push(tool_call_id.clone());
                }
                let mut input = Map::new();
                if let Some(arguments) = item.get("arguments") {
                    input.insert("arguments".to_string(), arguments.clone());
                }
                input.insert("call_id".to_string(), item["call_id"].clone());
                let mut metadata = Map::new();
                metadata.insert("itemId".to_string(), item["id"].clone());
                content.push(LanguageModelV4Content::ToolCall {
                    tool_call_id,
                    tool_name: tool_name_mapping.to_custom_tool_name("tool_search"),
                    input: js_stringify(&Value::Object(input)),
                    provider_executed: is_hosted.then_some(true),
                    dynamic: None,
                    provider_metadata: Some(metadata_under(name, metadata)),
                });
            }

            "tool_search_output" => {
                let tool_call_id = item["call_id"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        (!hosted_tool_search_call_ids.is_empty())
                            .then(|| hosted_tool_search_call_ids.remove(0))
                    })
                    .unwrap_or_else(|| str_of("id"));
                let mut result = Map::new();
                result.insert("tools".to_string(), item["tools"].clone());
                let mut metadata = Map::new();
                metadata.insert("itemId".to_string(), item["id"].clone());
                content.push(LanguageModelV4Content::ToolResult {
                    tool_call_id,
                    tool_name: tool_name_mapping.to_custom_tool_name("tool_search"),
                    result: Value::Object(result),
                    is_error: None,
                    preliminary: None,
                    dynamic: None,
                    provider_metadata: Some(metadata_under(name, metadata)),
                });
            }

            "message" => {
                for part in item["content"].as_array().into_iter().flatten() {
                    if wants_logprobs
                        && let Some(part_logprobs) = part.get("logprobs").filter(|l| l.is_array())
                    {
                        logprobs.push(part_logprobs.clone());
                    }
                    let annotations: Vec<Value> = part["annotations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(annotation_in_schema_order)
                        .collect();
                    let mut metadata = Map::new();
                    metadata.insert("itemId".to_string(), item["id"].clone());
                    if let Some(phase) = item.get("phase").filter(|p| !p.is_null()) {
                        metadata.insert("phase".to_string(), phase.clone());
                    }
                    if !annotations.is_empty() {
                        metadata
                            .insert("annotations".to_string(), Value::Array(annotations.clone()));
                    }
                    content.push(LanguageModelV4Content::Text {
                        text: part["text"].as_str().unwrap_or_default().to_string(),
                        provider_metadata: Some(metadata_under(name, metadata)),
                    });
                    for annotation in &annotations {
                        // Citation sources stand in only where retrieval data is missing.
                        let kind = annotation["type"].as_str().unwrap_or_default();
                        if (kind == "url_citation" && has_web_search_action_sources)
                            || (kind == "file_citation" && has_file_search_results)
                        {
                            continue;
                        }
                        content.push(LanguageModelV4Content::Source(annotation_source(
                            annotation,
                            name,
                            generate_id(),
                        )));
                    }
                }
            }

            "function_call" => {
                has_function_call = true;
                let call_id = str_of("call_id");
                let tool_name = str_of("name");
                let arguments = str_of("arguments");
                if let Some(expanded) = expand_parallel_tool_call(
                    &call_id,
                    &tool_name,
                    &arguments,
                    function_tools,
                    name,
                    &str_of("id"),
                ) {
                    content.extend(expanded);
                    continue;
                }
                let mut metadata = Map::new();
                metadata.insert("itemId".to_string(), item["id"].clone());
                if let Some(is_async) = item.get("async").filter(|v| !v.is_null()) {
                    metadata.insert("async".to_string(), is_async.clone());
                }
                if let Some(namespace) = item.get("namespace").filter(|v| !v.is_null()) {
                    metadata.insert("namespace".to_string(), namespace.clone());
                }
                if let Some(caller) = item.get("caller").filter(|v| !v.is_null()) {
                    let caller = if caller["type"] == "program" {
                        let mut mapped = Map::new();
                        mapped.insert("type".to_string(), string("program"));
                        mapped.insert("callerId".to_string(), caller["caller_id"].clone());
                        Value::Object(mapped)
                    } else {
                        let mut mapped = Map::new();
                        mapped.insert("type".to_string(), caller["type"].clone());
                        Value::Object(mapped)
                    };
                    metadata.insert("caller".to_string(), caller);
                }
                content.push(LanguageModelV4Content::ToolCall {
                    tool_call_id: call_id,
                    tool_name,
                    input: arguments,
                    provider_executed: None,
                    dynamic: None,
                    provider_metadata: Some(metadata_under(name, metadata)),
                });
            }

            "custom_tool_call" => {
                has_function_call = true;
                let mut metadata = Map::new();
                metadata.insert("itemId".to_string(), item["id"].clone());
                if let Some(is_async) = item.get("async").filter(|v| !v.is_null()) {
                    metadata.insert("async".to_string(), is_async.clone());
                }
                content.push(LanguageModelV4Content::ToolCall {
                    tool_call_id: str_of("call_id"),
                    tool_name: tool_name_mapping.to_custom_tool_name(&str_of("name")),
                    input: js_stringify(&item["input"]),
                    provider_executed: None,
                    dynamic: None,
                    provider_metadata: Some(metadata_under(name, metadata)),
                });
            }

            "compaction" => {
                let mut metadata = Map::new();
                metadata.insert("type".to_string(), string("compaction"));
                metadata.insert("itemId".to_string(), item["id"].clone());
                metadata.insert(
                    "encryptedContent".to_string(),
                    item["encrypted_content"].clone(),
                );
                content.push(LanguageModelV4Content::Custom {
                    kind: "openai.compaction".to_string(),
                    provider_metadata: Some(metadata_under(name, metadata)),
                });
            }

            // Items of hosted tools the request refuses, and the MCP tool list.
            _ => {}
        }
    }

    MappedOutput {
        content,
        logprobs,
        has_function_call,
    }
}

pub(super) const PARALLEL_TOOL_NAME: &str = "parallel";
const RECIPIENT_NAME_PREFIX: &str = "functions.";

/// `expandParallelToolCall`: the calls inside OpenAI's internal `parallel` wrapper,
/// when every nested recipient is a declared function tool.
pub(super) fn expand_parallel_tool_call(
    tool_call_id: &str,
    tool_name: &str,
    input: &str,
    tools: &[&LanguageModelV4FunctionTool],
    name: &str,
    item_id: &str,
) -> Option<Vec<LanguageModelV4Content>> {
    if tool_name != PARALLEL_TOOL_NAME || tools.iter().any(|t| t.name == PARALLEL_TOOL_NAME) {
        return None;
    }
    let parsed = crate::ai::json::secure_json_parse(input).ok()?;
    let tool_uses = parsed.as_object()?.get("tool_uses")?.as_array()?;
    if tool_uses.is_empty() {
        return None;
    }
    let available: HashSet<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    let mut expanded = Vec::new();
    for (index, tool_use) in tool_uses.iter().enumerate() {
        let tool_use = tool_use.as_object()?;
        let recipient = tool_use.get("recipient_name")?.as_str()?;
        let parameters = tool_use.get("parameters").filter(|p| p.is_object())?;
        let inner_name = recipient.strip_prefix(RECIPIENT_NAME_PREFIX)?;
        if inner_name.is_empty() || !available.contains(inner_name) {
            return None;
        }
        let mut wrapper = Map::new();
        wrapper.insert("itemId".to_string(), string(item_id));
        wrapper.insert("toolCallId".to_string(), string(tool_call_id));
        wrapper.insert("toolName".to_string(), string(tool_name));
        wrapper.insert("input".to_string(), string(input));
        wrapper.insert("index".to_string(), Value::from(index));
        wrapper.insert("count".to_string(), Value::from(tool_uses.len()));
        let mut metadata = Map::new();
        metadata.insert("parallelToolCall".to_string(), Value::Object(wrapper));
        expanded.push(LanguageModelV4Content::ToolCall {
            tool_call_id: format!("{tool_call_id}_{index}"),
            tool_name: inner_name.to_string(),
            input: js_stringify(parameters),
            provider_executed: None,
            dynamic: None,
            provider_metadata: Some(metadata_under(name, metadata)),
        });
    }
    Some(expanded)
}
