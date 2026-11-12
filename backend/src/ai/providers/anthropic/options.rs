//! The provider options the Anthropic model reads (`anthropicLanguageModelOptions`,
//! the file part and system message options), parsed as the SDK's zod schemas
//! parse them: unknown keys are dropped, a value of the wrong type refuses the call.

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::ai::{InvalidArgumentError, ProviderOptions};

/// `parseProviderOptions`: `None` when `provider_options` has no `provider` entry,
/// the parsed options when it validates, else `invalid {provider} provider options`.
pub(super) fn parse_provider_options<T: for<'de> Deserialize<'de>>(
    provider: &str,
    provider_options: Option<&ProviderOptions>,
    validate: impl Fn(&T) -> bool,
) -> anyhow::Result<Option<T>> {
    let Some(value) = provider_options.and_then(|options| options.get(provider)) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    match serde_json::from_value::<T>(value.clone()) {
        Ok(parsed) if validate(&parsed) => Ok(Some(parsed)),
        _ => Err(invalid_provider_options(provider)),
    }
}

pub(super) fn invalid_provider_options(provider: &str) -> anyhow::Error {
    InvalidArgumentError {
        message: format!("invalid {provider} provider options"),
        parameter: "providerOptions".to_string(),
        value: Value::Null,
    }
    .into()
}

/// `thinking.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ThinkingType {
    Adaptive,
    Enabled,
    Disabled,
    BetweenTools,
}

impl ThinkingType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Adaptive => "adaptive",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::BetweenTools => "between_tools",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BlockBinding {
    pub prefix_mismatch_behavior: PrefixMismatchBehavior,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum PrefixMismatchBehavior {
    Error,
    DropBlock,
}

impl PrefixMismatchBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::DropBlock => "drop_block",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum ThinkingDisplay {
    Omitted,
    Summarized,
    Updates,
}

impl ThinkingDisplay {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Omitted => "omitted",
            Self::Summarized => "summarized",
            Self::Updates => "updates",
        }
    }
}

/// `thinking`: one of the four typed forms, or a binding without a type. Only the
/// keys of the matched form survive the parse.
#[derive(Debug, Clone, Default)]
pub(super) struct Thinking {
    pub kind: Option<ThinkingType>,
    pub budget_tokens: Option<f64>,
    pub display: Option<ThinkingDisplay>,
    pub block_binding: Option<BlockBinding>,
}

impl Thinking {
    pub fn of(kind: ThinkingType) -> Self {
        Self {
            kind: Some(kind),
            ..Default::default()
        }
    }
}

impl<'de> Deserialize<'de> for Thinking {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            #[serde(default, rename = "type")]
            kind: Option<ThinkingType>,
            #[serde(default)]
            budget_tokens: Option<f64>,
            #[serde(default)]
            display: Option<ThinkingDisplay>,
            #[serde(default)]
            block_binding: Option<BlockBinding>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let thinking = match raw.kind {
            Some(ThinkingType::Adaptive) => Thinking {
                kind: raw.kind,
                display: raw.display,
                block_binding: raw.block_binding,
                ..Default::default()
            },
            Some(ThinkingType::Enabled) => Thinking {
                kind: raw.kind,
                budget_tokens: raw.budget_tokens,
                ..Default::default()
            },
            Some(kind) => Thinking::of(kind),
            None => match raw.block_binding {
                Some(binding) => Thinking {
                    block_binding: Some(binding),
                    ..Default::default()
                },
                None => {
                    return Err(serde::de::Error::custom(
                        "thinking needs a type or a block binding",
                    ));
                }
            },
        };
        Ok(thinking)
    }
}

/// `effort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
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
#[serde(rename_all = "camelCase")]
pub(super) enum StructuredOutputMode {
    OutputFormat,
    JsonTool,
    Auto,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CacheControlOption {
    #[serde(rename = "type")]
    pub kind: EphemeralLiteral,
    #[serde(default)]
    pub ttl: Option<CacheTtlOption>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum EphemeralLiteral {
    Ephemeral,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub(super) enum CacheTtlOption {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

impl CacheControlOption {
    /// The parsed object, `{ type, ttl? }`.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), Value::from("ephemeral"));
        if let Some(ttl) = self.ttl {
            let ttl = match ttl {
                CacheTtlOption::FiveMinutes => "5m",
                CacheTtlOption::OneHour => "1h",
            };
            map.insert("ttl".into(), Value::from(ttl));
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MetadataOption {
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolConfigurationOption {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct McpServerOption {
    #[serde(rename = "type")]
    pub kind: UrlLiteral,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub authorization_token: Option<String>,
    #[serde(default)]
    pub tool_configuration: Option<ToolConfigurationOption>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum UrlLiteral {
    Url,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(super) enum SkillOption {
    Anthropic {
        skill_id: String,
        #[serde(default)]
        version: Option<String>,
    },
    Custom {
        provider_reference: indexmap::IndexMap<String, String>,
        #[serde(default)]
        version: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ContainerOption {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub skills: Option<Vec<SkillOption>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct TaskBudgetOption {
    #[serde(rename = "type")]
    pub kind: TokensLiteral,
    pub total: f64,
    #[serde(default)]
    pub remaining: Option<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum TokensLiteral {
    Tokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Speed {
    Fast,
    Standard,
}

impl Speed {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Standard => "standard",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ServiceTier {
    Auto,
    StandardOnly,
}

impl ServiceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::StandardOnly => "standard_only",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum InferenceGeo {
    Us,
    Global,
}

impl InferenceGeo {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Us => "us",
            Self::Global => "global",
        }
    }
}

/// One entry of `fallbacks`: the parsed object, in the schema's key order.
#[derive(Debug, Clone)]
pub(super) struct FallbackOption(pub Value);

impl<'de> Deserialize<'de> for FallbackOption {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            model: String,
            #[serde(default)]
            max_tokens: Option<i64>,
            #[serde(default)]
            thinking: Option<Map<String, Value>>,
            #[serde(default)]
            output_config: Option<Map<String, Value>>,
            #[serde(default)]
            speed: Option<Speed>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let mut map = Map::new();
        map.insert("model".into(), Value::from(raw.model));
        if let Some(value) = raw.max_tokens {
            map.insert("max_tokens".into(), Value::from(value));
        }
        if let Some(value) = raw.thinking {
            map.insert("thinking".into(), Value::Object(value));
        }
        if let Some(value) = raw.output_config {
            map.insert("output_config".into(), Value::Object(value));
        }
        if let Some(value) = raw.speed {
            map.insert("speed".into(), Value::from(value.as_str()));
        }
        Ok(FallbackOption(Value::Object(map)))
    }
}

/// `fallbacks`: `'default'` or a list of models.
#[derive(Debug, Clone)]
pub(super) enum Fallbacks {
    Default,
    Models(Vec<FallbackOption>),
}

impl<'de> Deserialize<'de> for Fallbacks {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Text(String),
            Models(Vec<FallbackOption>),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Text(text) if text == "default" => Ok(Fallbacks::Default),
            Raw::Text(_) => Err(serde::de::Error::custom("fallbacks")),
            Raw::Models(models) => Ok(Fallbacks::Models(models)),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SafeguardOption {
    #[serde(rename = "type")]
    pub kind: DangerousToolUseLiteral,
    #[serde(default)]
    pub classifier_context: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum DangerousToolUseLiteral {
    DangerousToolUse,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CompactionOption {
    #[serde(rename = "type")]
    pub kind: SummarizeLiteral,
    #[serde(default)]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum SummarizeLiteral {
    Summarize,
}

/// One `contextManagement.edits` entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub(super) enum ContextManagementEdit {
    #[serde(rename = "clear_tool_uses_20250919", rename_all = "camelCase")]
    ClearToolUses {
        #[serde(default)]
        trigger: Option<TypedValue>,
        #[serde(default)]
        keep: Option<TypedValue>,
        #[serde(default)]
        clear_at_least: Option<TypedValue>,
        #[serde(default)]
        clear_tool_inputs: Option<bool>,
        #[serde(default)]
        exclude_tools: Option<Vec<String>>,
    },
    #[serde(rename = "clear_thinking_20251015")]
    ClearThinking {
        #[serde(default)]
        keep: Option<ThinkingKeep>,
    },
    #[serde(rename = "compact_20260112", rename_all = "camelCase")]
    Compact {
        #[serde(default)]
        trigger: Option<TypedValue>,
        #[serde(default)]
        pause_after_compaction: Option<bool>,
        #[serde(default)]
        instructions: Option<String>,
    },
}

/// `{ type, value }` of a trigger or a keep rule.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct TypedValue {
    #[serde(rename = "type")]
    pub kind: String,
    pub value: f64,
}

impl TypedValue {
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "type": self.kind, "value": crate::support::js::number(self.value) })
    }
}

/// `keep` of `clear_thinking_20251015`: `'all'` or `{ type: 'thinking_turns', value }`.
#[derive(Debug, Clone)]
pub(super) enum ThinkingKeep {
    All,
    Turns(TypedValue),
}

impl<'de> Deserialize<'de> for ThinkingKeep {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Text(String),
            Turns(TypedValue),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Text(text) if text == "all" => Ok(ThinkingKeep::All),
            Raw::Turns(value) if value.kind == "thinking_turns" => Ok(ThinkingKeep::Turns(value)),
            _ => Err(serde::de::Error::custom("keep")),
        }
    }
}

impl ThinkingKeep {
    pub fn to_json(&self) -> Value {
        match self {
            Self::All => Value::from("all"),
            Self::Turns(value) => value.to_json(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ContextManagementOption {
    pub edits: Vec<ContextManagementEdit>,
}

/// `anthropicLanguageModelOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnthropicLanguageModelOptions {
    #[serde(default)]
    pub send_reasoning: Option<bool>,
    #[serde(default)]
    pub structured_output_mode: Option<StructuredOutputMode>,
    #[serde(default)]
    pub thinking: Option<Thinking>,
    #[serde(default)]
    pub disable_parallel_tool_use: Option<bool>,
    #[serde(default)]
    pub cache_control: Option<CacheControlOption>,
    #[serde(default)]
    pub metadata: Option<MetadataOption>,
    #[serde(default)]
    pub mcp_servers: Option<Vec<McpServerOption>>,
    #[serde(default)]
    pub container: Option<ContainerOption>,
    #[serde(default)]
    pub tool_streaming: Option<bool>,
    #[serde(default)]
    pub effort: Option<Effort>,
    #[serde(default)]
    pub task_budget: Option<TaskBudgetOption>,
    #[serde(default)]
    pub speed: Option<Speed>,
    #[serde(default)]
    pub service_tier: Option<ServiceTier>,
    #[serde(default)]
    pub inference_geo: Option<InferenceGeo>,
    #[serde(default)]
    pub fallbacks: Option<Fallbacks>,
    #[serde(default)]
    pub anthropic_beta: Option<Vec<String>>,
    #[serde(default)]
    pub safeguards: Option<Vec<SafeguardOption>>,
    #[serde(default)]
    pub compaction: Option<CompactionOption>,
    #[serde(default)]
    pub context_management: Option<ContextManagementOption>,
}

impl AnthropicLanguageModelOptions {
    /// The checks the schema makes beyond types: the task budget's integer bounds.
    pub fn is_valid(&self) -> bool {
        if let Some(budget) = &self.task_budget {
            let total_ok = budget.total.fract() == 0.0 && budget.total >= 20000.0;
            let remaining_ok = budget
                .remaining
                .is_none_or(|value| value.fract() == 0.0 && value >= 0.0);
            if !total_ok || !remaining_ok {
                return false;
            }
        }
        true
    }

    /// `Object.assign({}, self, other)`: every option `other` states wins.
    pub fn merged_with(self, other: Self) -> Self {
        Self {
            send_reasoning: other.send_reasoning.or(self.send_reasoning),
            structured_output_mode: other.structured_output_mode.or(self.structured_output_mode),
            thinking: other.thinking.or(self.thinking),
            disable_parallel_tool_use: other
                .disable_parallel_tool_use
                .or(self.disable_parallel_tool_use),
            cache_control: other.cache_control.or(self.cache_control),
            metadata: other.metadata.or(self.metadata),
            mcp_servers: other.mcp_servers.or(self.mcp_servers),
            container: other.container.or(self.container),
            tool_streaming: other.tool_streaming.or(self.tool_streaming),
            effort: other.effort.or(self.effort),
            task_budget: other.task_budget.or(self.task_budget),
            speed: other.speed.or(self.speed),
            service_tier: other.service_tier.or(self.service_tier),
            inference_geo: other.inference_geo.or(self.inference_geo),
            fallbacks: other.fallbacks.or(self.fallbacks),
            anthropic_beta: other.anthropic_beta.or(self.anthropic_beta),
            safeguards: other.safeguards.or(self.safeguards),
            compaction: other.compaction.or(self.compaction),
            context_management: other.context_management.or(self.context_management),
        }
    }
}

/// `anthropicFilePartProviderOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnthropicFilePartOptions {
    #[serde(default)]
    pub container_upload: Option<bool>,
    #[serde(default)]
    pub citations: Option<CitationsOption>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CitationsOption {
    pub enabled: bool,
}

/// `anthropicSystemMessageProviderOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnthropicSystemMessageOptions {
    #[serde(default)]
    pub clear_at: Option<ClearAt>,
    #[serde(default)]
    pub effort: Option<Effort>,
    #[serde(default)]
    pub tool_changes: Option<Vec<ToolChangeOption>>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ClearAt {
    NextUserMessage,
}

/// One `toolChanges` entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolChangeOption {
    #[serde(rename = "type")]
    pub kind: ToolChangeKind,
    pub tool_name: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ToolChangeKind {
    ToolAddition,
    ToolRemoval,
}

impl ToolChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ToolAddition => "tool_addition",
            Self::ToolRemoval => "tool_removal",
        }
    }
}

/// `anthropicReasoningMetadataSchema`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnthropicReasoningMetadata {
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub redacted_data: Option<String>,
}
