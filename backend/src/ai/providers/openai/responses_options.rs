//! The `openai` provider options of a Responses API call
//! (`openaiLanguageModelResponsesOptionsSchema`), and `parseProviderOptions`.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ai::errors::InvalidArgumentError;
use crate::ai::provider::ProviderOptions;

pub const TOP_LOGPROBS_MAX: i64 = 20;

/// `parseProviderOptions`: the options under `provider`, `None` when there are
/// none, or `invalid <provider> provider options` when they do not match.
pub fn parse_provider_options<T: DeserializeOwned>(
    provider: &str,
    provider_options: Option<&ProviderOptions>,
) -> Result<Option<T>, InvalidArgumentError> {
    let Some(value) = provider_options
        .and_then(|options| options.get(provider))
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    serde_json::from_value::<T>(value.clone())
        .map(Some)
        .map_err(|_| InvalidArgumentError {
            message: format!("invalid {provider} provider options"),
            parameter: "providerOptions".to_string(),
            value: value.clone(),
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum IncludeValue {
    #[serde(rename = "reasoning.encrypted_content")]
    ReasoningEncryptedContent,
    #[serde(rename = "file_search_call.results")]
    FileSearchCallResults,
    #[serde(rename = "web_search_call.results")]
    WebSearchCallResults,
    #[serde(rename = "message.output_text.logprobs")]
    MessageOutputTextLogprobs,
}

impl IncludeValue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReasoningEncryptedContent => "reasoning.encrypted_content",
            Self::FileSearchCallResults => "file_search_call.results",
            Self::WebSearchCallResults => "web_search_call.results",
            Self::MessageOutputTextLogprobs => "message.output_text.logprobs",
        }
    }
}

/// `logprobs`: `true` for the most, or a count from 1 to 20.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Logprobs {
    Flag(bool),
    Count(f64),
}

impl<'de> Deserialize<'de> for Logprobs {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::Bool(flag) => Ok(Self::Flag(flag)),
            Value::Number(n) => {
                let count = n.as_f64().unwrap_or(f64::NAN);
                if (1.0..=TOP_LOGPROBS_MAX as f64).contains(&count) {
                    Ok(Self::Count(count))
                } else {
                    Err(serde::de::Error::custom("logprobs out of range"))
                }
            }
            _ => Err(serde::de::Error::custom(
                "logprobs must be a boolean or a number",
            )),
        }
    }
}

/// `promptCacheOptions`, with keys in schema order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PromptCacheOptions {
    #[serde(default)]
    pub mode: Option<PromptCacheMode>,
    #[serde(default)]
    pub ttl: Option<PromptCacheTtl>,
    #[serde(default)]
    pub prewarm: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptCacheMode {
    Implicit,
    Explicit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum PromptCacheTtl {
    #[serde(rename = "30m")]
    ThirtyMinutes,
    #[serde(rename = "12h")]
    TwelveHours,
}

impl PromptCacheOptions {
    /// The options as the request sends them.
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        if let Some(mode) = self.mode {
            let text = match mode {
                PromptCacheMode::Implicit => "implicit",
                PromptCacheMode::Explicit => "explicit",
            };
            out.insert("mode".to_string(), Value::String(text.to_string()));
        }
        if let Some(ttl) = self.ttl {
            let text = match ttl {
                PromptCacheTtl::ThirtyMinutes => "30m",
                PromptCacheTtl::TwelveHours => "12h",
            };
            out.insert("ttl".to_string(), Value::String(text.to_string()));
        }
        if let Some(prewarm) = self.prewarm {
            out.insert("prewarm".to_string(), Value::Bool(prewarm));
        }
        Value::Object(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum PromptCacheRetention {
    #[serde(rename = "in_memory")]
    InMemory,
    #[serde(rename = "24h")]
    Day,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffortUpdate {
    None,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningMode {
    Standard,
    Pro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContext {
    Auto,
    CurrentTurn,
    AllTurns,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceTier {
    Auto,
    Flex,
    Priority,
    Fast,
    Ultrafast,
    Default,
}

impl ServiceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Flex => "flex",
            Self::Priority => "priority",
            Self::Fast => "fast",
            Self::Ultrafast => "ultrafast",
            Self::Default => "default",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextVerbosity {
    Low,
    Medium,
    High,
}

impl TextVerbosity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Truncation {
    Auto,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemMessageModeOption {
    System,
    Developer,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextManagement {
    #[serde(rename = "type")]
    pub kind: CompactionType,
    #[serde(rename = "compactThreshold")]
    pub compact_threshold: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompactionType {
    Compaction,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedTools {
    pub tool_names: Vec<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// The `openai` provider options of a Responses API call. Unknown keys are dropped,
/// as zod drops them.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIResponsesOptions {
    #[serde(default)]
    pub conversation: Option<String>,
    #[serde(default)]
    pub include: Option<Vec<IncludeValue>>,
    #[serde(default)]
    pub include_web_search_sources: Option<bool>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub logprobs: Option<Logprobs>,
    #[serde(default)]
    pub max_tool_calls: Option<serde_json::Number>,
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub parallel_tool_calls: Option<bool>,
    #[serde(default)]
    pub previous_response_id: Option<String>,
    #[serde(default)]
    pub prompt_cache_key: Option<String>,
    #[serde(default)]
    pub prompt_cache_options: Option<PromptCacheOptions>,
    #[serde(default)]
    pub prompt_cache_retention: Option<PromptCacheRetention>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub reasoning_effort_update: Option<ReasoningEffortUpdate>,
    #[serde(default)]
    pub reasoning_mode: Option<ReasoningMode>,
    #[serde(default)]
    pub reasoning_context: Option<ReasoningContext>,
    #[serde(default)]
    pub reasoning_summary: Option<String>,
    #[serde(default)]
    pub safety_identifier: Option<String>,
    #[serde(default)]
    pub service_tier: Option<ServiceTier>,
    #[serde(default)]
    pub store: Option<bool>,
    #[serde(default)]
    pub pass_through_unsupported_files: Option<bool>,
    #[serde(default)]
    pub strict_json_schema: Option<bool>,
    #[serde(default)]
    pub text_verbosity: Option<TextVerbosity>,
    #[serde(default)]
    pub truncation: Option<Truncation>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub system_message_mode: Option<SystemMessageModeOption>,
    #[serde(default)]
    pub force_reasoning: Option<bool>,
    #[serde(default)]
    pub context_management: Option<Vec<ContextManagement>>,
    #[serde(default)]
    pub compaction_trigger: Option<bool>,
    #[serde(default)]
    pub allowed_tools: Option<AllowedTools>,
}

/// `openaiResponsesSystemMessageOptionsSchema`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMessageOptions {
    #[serde(default)]
    pub reasoning_effort_update: Option<ReasoningEffortUpdate>,
}

/// `openaiResponsesReasoningProviderOptionsSchema`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningPartOptions {
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub reasoning_encrypted_content: Option<String>,
}

/// `openaiResponsesToolResultOptionsSchema`: tools a result adds to the request.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultOptions {
    #[serde(default)]
    pub additional_tools: Option<Vec<Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::provider_options;
    use serde_json::json;

    #[test]
    fn reads_the_options_the_runtime_sends() {
        let options = provider_options(json!({
            "openai": { "reasoningEffort": "none", "promptCacheOptions": { "ttl": "12h", "x": 1 } }
        }));
        let parsed: OpenAIResponsesOptions = parse_provider_options("openai", Some(&options))
            .unwrap()
            .unwrap();
        assert_eq!(parsed.reasoning_effort.as_deref(), Some("none"));
        assert_eq!(
            parsed.prompt_cache_options.unwrap().to_json(),
            json!({ "ttl": "12h" })
        );
    }

    #[test]
    fn refuses_an_option_outside_the_schema() {
        let options =
            provider_options(json!({ "openai": { "promptCacheOptions": { "ttl": "1h" } } }));
        let err =
            parse_provider_options::<OpenAIResponsesOptions>("openai", Some(&options)).unwrap_err();
        assert_eq!(err.message, "invalid openai provider options");
    }

    #[test]
    fn no_options_under_the_name_is_none() {
        let options = provider_options(json!({ "anthropic": { "x": 1 } }));
        assert!(
            parse_provider_options::<OpenAIResponsesOptions>("openai", Some(&options))
                .unwrap()
                .is_none()
        );
    }
}
