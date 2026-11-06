//! The shape every LLM vendor factory returns.
//!
//! A provider is a chat dispatcher — model id to `LanguageModel` — plus the
//! per-vendor declarations below, so callers of `create_provider()` never have to
//! know which vendor or route (direct or gateway) is in use. Every factory returns
//! this one struct, which pins the vendors to one contract.

use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::ai::{LanguageModel, SystemModelMessage, Tool, ToolResultOutput};
use crate::config::CONFIG;

/// A `providerOptions` fragment — vendor namespace → option bag. It is the AI
/// SDK's own `ProviderOptions`, so it is accepted wherever the SDK asks for
/// `providerOptions`.
pub type ProviderOptionsFragment = crate::ai::ProviderOptions;

/// A `providerOptions` fragment from its JSON form (`{ namespace: { key: value } }`).
pub fn provider_options(value: Value) -> ProviderOptionsFragment {
    serde_json::from_value(value).expect("a providerOptions fragment is an object of objects")
}

/// The JSON form of a `providerOptions` fragment.
pub fn provider_options_json(fragment: &ProviderOptionsFragment) -> Value {
    serde_json::to_value(fragment).unwrap_or(Value::Object(Map::new()))
}

/// Merge `providerOptions` fragments one namespace deep, so two fragments declared
/// for the same vendor namespace combine instead of the later one silently
/// clobbering the earlier.
pub fn merge_provider_options<'a>(
    fragments: impl IntoIterator<Item = Option<&'a ProviderOptionsFragment>>,
) -> ProviderOptionsFragment {
    let mut merged = Map::new();
    for fragment in fragments.into_iter().flatten() {
        let Value::Object(namespaces) = provider_options_json(fragment) else {
            continue;
        };
        for (namespace, options) in namespaces {
            let slot = merged
                .entry(namespace)
                .or_insert_with(|| Value::Object(Map::new()));
            if let (Value::Object(target), Value::Object(source)) = (slot, options) {
                for (key, value) in source {
                    target.insert(key, value);
                }
            }
        }
    }
    provider_options(Value::Object(merged))
}

/// Whether a tool is sent deferred, in any vendor's `providerOptions`.
pub fn is_deferred_tool(tool: &Tool) -> bool {
    let Some(options) = tool.provider_options.as_ref() else {
        return false;
    };
    match provider_options_json(options) {
        Value::Object(namespaces) => namespaces
            .values()
            .any(|options| options.get("deferLoading") == Some(&Value::Bool(true))),
        _ => false,
    }
}

/// Whether a tool became available or stopped being available.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolChangeType {
    #[serde(rename = "tool_addition")]
    ToolAddition,
    #[serde(rename = "tool_removal")]
    ToolRemoval,
}

impl ToolChangeType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ToolAddition => "tool_addition",
            Self::ToolRemoval => "tool_removal",
        }
    }
}

/// One tool that became available, or stopped being available, between two turns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChange {
    #[serde(rename = "type")]
    pub kind: ToolChangeType,
    pub tool_name: String,
}

/// How one model is told that the tools of a conversation changed: the tool stays
/// declared, and a system message in the history names the change.
#[derive(Clone)]
pub struct ToolChangeProtocol {
    /// `providerOptions` for a declared tool that loads only when an addition names it.
    pub deferred_tool: ProviderOptionsFragment,
    /// The system message that announces `changes`.
    pub announce: fn(&[ToolChange]) -> SystemModelMessage,
}

/// What one `load_tools` call asks for: exact names, a keyword query, or both.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolLoadRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

/// What the runtime answered to one `load_tools` call. It is the call's stored result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolLoad {
    pub loaded: Vec<String>,
    pub unmatched: Vec<String>,
    /// Deferred tool names near the unmatched ones.
    pub suggestions: Vec<String>,
}

/// A deferred tool's definition, for a vendor whose load result defines the tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeferredToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Map<String, Value>,
}

/// The runtime search that a vendor's `load_tools` tool calls.
#[derive(Clone)]
pub struct ToolLoader {
    pub description: String,
    pub load: Arc<dyn Fn(&ToolLoadRequest) -> ToolLoad + Send + Sync>,
    pub definition: Arc<dyn Fn(&str) -> Option<DeferredToolDefinition> + Send + Sync>,
}

/// A stored `load_tools` call, as history holds it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredToolLoad {
    pub id: String,
    pub input: Value,
    pub result: ToolLoad,
}

/// A stored `load_tools` call as a later request sends it.
#[derive(Debug, Clone)]
pub struct ReplayedToolLoad {
    pub id: String,
    pub input: Value,
    pub output: ToolResultOutput,
}

/// How one model loads a tool whose schema the request sends deferred: the
/// provider keeps the tool out of the model's context until a `load_tools` result
/// names it.
#[derive(Clone)]
pub struct DeferredToolProtocol {
    /// `providerOptions` for a tool sent deferred.
    pub deferred_tool: ProviderOptionsFragment,
    /// The `load_tools` tool on this vendor.
    pub load_tool: fn(Arc<ToolLoader>) -> Tool,
    /// Whether the SDK sends the tools block under tool choice 'none'. A request
    /// that replays a load has to declare the tools the load names.
    pub keeps_tools_under_none: bool,
    /// A stored `load_tools` call as a later request sends it. `result.loaded`
    /// names only tools that request declares, since a result that names an
    /// undeclared tool fails the request.
    pub replay: fn(&StoredToolLoad, &ToolLoader) -> ReplayedToolLoad,
}

/// Turns extended thinking off on an Anthropic Messages request. Thinking tokens
/// count against the gates' 16-token output cap, and a gate whose cap runs out
/// before the verdict returns empty text.
pub static ANTHROPIC_THINKING_OFF: LazyLock<ProviderOptionsFragment> = LazyLock::new(|| {
    provider_options(json!({ "anthropic": { "thinking": { "type": "disabled" } } }))
});

/// How long a request asks its cache entries to stay warm. `1h` asks for the
/// vendor's longer lifetime, whose writes cost more (2× input instead of 1.25× on
/// Claude), so it pays only where people pause between turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum CacheTtl {
    #[default]
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

impl CacheTtl {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::FiveMinutes => "5m",
            Self::OneHour => "1h",
        }
    }
}

/// The cache a run of `mode` asks for: `CHAT_CACHE_TTL` for a chat turn, five
/// minutes for any other.
pub fn cache_ttl_for(mode: &str) -> CacheTtl {
    if mode == "chat" {
        CONFIG.chat_cache_ttl
    } else {
        CacheTtl::FiveMinutes
    }
}

/// A `providerOptions` fragment that marks a prompt-cache breakpoint on whatever
/// element has it (a system message, a chat message, the last tool). The
/// Claude-serving vendors declare Anthropic's ephemeral cacheControl — the point of
/// routing it through the provider is that callers never hardcode a vendor
/// namespace. A vendor whose prompt caching is automatic (OpenAI) declares the
/// empty fragment instead: merging it into `providerOptions` is a no-op on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CachePointFragment {
    /// Anthropic's ephemeral prompt-cache breakpoint:
    /// `{ anthropic: { cacheControl: { type: 'ephemeral', ttl?: '1h' } } }`.
    Anthropic { one_hour: bool },
    /// Bedrock Converse's own breakpoint — a `cachePoint` block in the request,
    /// which is a different wire form and a different `providerOptions` namespace
    /// than Anthropic's `cache_control`: `{ bedrock: { cachePoint: { type: 'default' } } }`.
    /// The Bedrock SDK reads it from `bedrock` (or `amazonBedrock`) and drops any
    /// other namespace without an error, so a fragment aimed at the wrong one costs
    /// a silent cache miss on every request rather than a failure anyone would notice.
    Bedrock,
    /// `{}`: no breakpoint.
    None,
}

impl CachePointFragment {
    /// Whether the fragment has no namespace (`Object.keys(fragment).length === 0`).
    pub fn is_empty(&self) -> bool {
        matches!(self, Self::None)
    }

    /// The fragment as `providerOptions` JSON.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Anthropic { one_hour: false } => {
                json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } })
            }
            Self::Anthropic { one_hour: true } => {
                json!({ "anthropic": { "cacheControl": { "type": "ephemeral", "ttl": "1h" } } })
            }
            Self::Bedrock => json!({ "bedrock": { "cachePoint": { "type": "default" } } }),
            Self::None => json!({}),
        }
    }

    /// The fragment as the SDK's `providerOptions`.
    pub fn to_provider_options(&self) -> ProviderOptionsFragment {
        provider_options(self.to_json())
    }
}

/// The fragment the Claude-serving vendors declare as their `cachePoint`.
pub const ANTHROPIC_CACHE_POINT: CachePointFragment =
    CachePointFragment::Anthropic { one_hour: false };

/// The same breakpoint asking for a one-hour entry.
pub const ANTHROPIC_CACHE_POINT_1H: CachePointFragment =
    CachePointFragment::Anthropic { one_hour: true };

/// The Anthropic breakpoint for `ttl`, which every vendor that sends Anthropic's
/// cacheControl declares. The operator who sets `CHAT_CACHE_TTL` checks that the
/// model accepts the lifetime.
pub fn anthropic_cache_point(ttl: Option<CacheTtl>) -> CachePointFragment {
    if ttl == Some(CacheTtl::OneHour) {
        ANTHROPIC_CACHE_POINT_1H
    } else {
        ANTHROPIC_CACHE_POINT
    }
}

/// The fragment Bedrock's Converse surface reads.
pub const BEDROCK_CACHE_POINT: CachePointFragment = CachePointFragment::Bedrock;

const FIVE_MINUTES_MS: i64 = 5 * 60 * 1000;
const ONE_HOUR_MS: i64 = 60 * 60 * 1000;

/// How long an entry a request of `ttl` writes for `model_id` stays warm without a
/// read: what the vendor declares, else an hour for a breakpoint that asks for one,
/// else five minutes.
pub fn cache_ttl_ms(provider: &LlmProvider, model_id: &str, ttl: CacheTtl) -> i64 {
    if let Some(declared) = provider.cache_ttl_ms.as_ref().map(|f| f(model_id, ttl)) {
        return declared;
    }
    match provider.cache_point(model_id, Some(ttl)) {
        CachePointFragment::Anthropic { one_hour: true } => ONE_HOUR_MS,
        _ => FIVE_MINUTES_MS,
    }
}

/// The request-level `providerOptions` a request of `ttl` sends; `write: false`
/// asks for no new entry.
pub fn cache_request_options(
    provider: &LlmProvider,
    model_id: &str,
    ttl: CacheTtl,
    write: bool,
) -> ProviderOptionsFragment {
    match provider.cache_request.as_ref() {
        Some(request) => request(model_id, ttl, write),
        None => provider_options(json!({})),
    }
}

/// The fragment for vendors whose prompt caching needs no breakpoints — and for the
/// ones whose support for them is unknown. Both mean "send nothing", which merges
/// into `providerOptions` as a no-op.
pub const NO_CACHE_POINT: CachePointFragment = CachePointFragment::None;

/// Whether one model gets a prompt-cache breakpoint, as the startup line reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptCacheState {
    On,
    Off,
}

impl PromptCacheState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
        }
    }
}

/// Sampling params for classification/gate calls (`{ temperature?: number }`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ClassificationSamplingParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

/// The chat dispatcher: a model id to a language model. LiteLLM's fails when no
/// key is set.
pub type ModelDispatcher =
    Arc<dyn Fn(&str) -> anyhow::Result<Arc<dyn LanguageModel>> + Send + Sync>;

/// The provider every model call goes through: the chat dispatcher plus the
/// vendor's declarations. Optional members are `None` where the TypeScript object
/// left them undefined.
#[derive(Clone)]
pub struct LlmProvider {
    /// `(modelId) => LanguageModel`.
    pub dispatch: ModelDispatcher,
    /// The prompt-cache breakpoint fragment for one model; see `CachePointFragment`.
    ///
    /// Keyed on the model rather than fixed per provider because a single vendor
    /// can serve two protocols: Bedrock routes Claude through the Anthropic
    /// Messages API and everything else through Converse, and the two read their
    /// breakpoints from different namespaces. Getting it wrong is invisible — the
    /// SDK drops an unrecognized namespace silently — so the choice belongs beside
    /// the dispatcher that picks the protocol, not at the call site.
    ///
    /// `ttl` is the lifetime the breakpoint asks for. A vendor that sends
    /// Anthropic's breakpoint sends it as given; one without breakpoints returns
    /// the empty fragment and states any lifetime through `cache_request` and
    /// `cache_ttl_ms`.
    pub cache_point: Arc<dyn Fn(&str, Option<CacheTtl>) -> CachePointFragment + Send + Sync>,
    /// Request-level `providerOptions` for a vendor whose cache lifetime is a
    /// setting of the request rather than of a breakpoint; `None` when
    /// `cache_point` says everything. `write: false` asks for a request that reads
    /// and writes no entry, where the vendor can send one. Every request of a
    /// thread sends the same `ttl`, since an entry of another lifetime replaces the
    /// thread's entry instead of reading it.
    pub cache_request:
        Option<Arc<dyn Fn(&str, CacheTtl, bool) -> ProviderOptionsFragment + Send + Sync>>,
    /// How long an entry stays warm, for a vendor whose lifetime `cache_point` does
    /// not show.
    pub cache_ttl_ms: Option<Arc<dyn Fn(&str, CacheTtl) -> i64 + Send + Sync>>,
    /// Whether one model gets a prompt-cache breakpoint on this vendor, for the
    /// startup line to report; `None` when the vendor has nothing to say and the
    /// line omits the field.
    ///
    /// Only a vendor whose answer varies by model declares it, which today is
    /// Bedrock alone: it serves Claude over the Anthropic Messages API and
    /// everything else over Converse, so the same deployment caches or does not
    /// depending on `BEDROCK_MODEL_ID`. A vendor with one answer for every model
    /// it serves reports nothing, because `cache_point` alone cannot say which
    /// answer that is — the empty fragment covers both "caching is automatic here"
    /// (OpenAI) and "this model takes no breakpoint".
    pub prompt_cache_state: Option<Arc<dyn Fn(&str) -> PromptCacheState + Send + Sync>>,
    /// How one model takes a mid-conversation tool change, or `None` when it takes
    /// none. A model that does keeps one declared tool list for the life of a
    /// conversation, so a change of tools keeps the prompt cache.
    ///
    /// Keyed on the model, and an allowlist: the SDK sends the change to any model,
    /// and a model without support rejects the whole request.
    pub tool_changes:
        Option<Arc<dyn Fn(&str) -> Option<&'static ToolChangeProtocol> + Send + Sync>>,
    /// How one model loads a deferred tool, or `None` when it loads none, and every
    /// tool is then sent whole. An allowlist keyed on the model, since each entry is
    /// measured live.
    pub deferred_tools:
        Option<Arc<dyn Fn(&str) -> Option<&'static DeferredToolProtocol> + Send + Sync>>,
    /// A check the vendor runs once at startup, logging what the operator has to
    /// fix; `None` when the vendor has nothing to verify. It never fails.
    ///
    /// LiteLLM declares it: its model ids are the operator's own aliases, so only
    /// the proxy's model list can confirm that the configured ones exist.
    pub startup_check: Option<Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>>,
    /// `providerOptions` to merge into structured-output (`generate_object`) calls
    /// on this vendor, or `None` when the SDK's default path already works.
    ///
    /// This exists so vendor quirks stay behind the seam. Left to itself the SDK
    /// sends Anthropic's native `output_config.format` for any model id it
    /// recognizes, which some platforms reject — but a caller like the thread reply
    /// classifier has no business knowing which. It asks the active provider what
    /// to send and forwards it.
    pub structured_output_options: Option<ProviderOptionsFragment>,
    /// `providerOptions` to merge into every classification/gate call on this
    /// vendor, or `None` when the model's defaults already suit them.
    ///
    /// The gates run a small model with `temperature: 0` and tiny output-token
    /// budgets — assumptions a reasoning model breaks (GPT-5.x rejects non-default
    /// temperature outside `reasoningEffort: 'none'`, and reasoning tokens would
    /// eat the budget before the verdict; Haiku 5.5 can think unasked). The vendor
    /// knows what its classification model needs; the gate call sites don't.
    pub classification_provider_options: Option<ProviderOptionsFragment>,
    /// Smallest `maxOutputTokens` a classification/gate call may send on this
    /// vendor; `None` when any positive cap is legal. The OpenAI Responses API
    /// rejects caps below 16 outright, and a gate whose every call errors is a gate
    /// disabled (fail-open or fail-closed, per site). Carried through
    /// `get_gate_request()` so a latency-tuned site can keep a tighter cap on the
    /// vendors that allow one.
    pub classification_min_output_tokens: Option<i64>,
    /// Sampling params for classification/gate calls. `None` means the default,
    /// `{ temperature: 0 }` — deterministic verdicts, which Haiku 4.5 accepts. A
    /// vendor whose models reject or strip an explicit temperature (Haiku 5.5,
    /// GPT-5.x reasoning models; whether the SDK even forwards it depends on its
    /// per-model support matrix) declares `{}` so the gates omit the param
    /// entirely — the same omit-rather-than-track rule the main invoke path applies
    /// to sampling params.
    pub classification_sampling_params: Option<ClassificationSamplingParams>,
}

impl LlmProvider {
    /// A provider with the two required members and every optional one unset.
    pub fn new(
        dispatch: ModelDispatcher,
        cache_point: Arc<dyn Fn(&str, Option<CacheTtl>) -> CachePointFragment + Send + Sync>,
    ) -> Self {
        Self {
            dispatch,
            cache_point,
            cache_request: None,
            cache_ttl_ms: None,
            prompt_cache_state: None,
            tool_changes: None,
            deferred_tools: None,
            startup_check: None,
            structured_output_options: None,
            classification_provider_options: None,
            classification_min_output_tokens: None,
            classification_sampling_params: None,
        }
    }

    /// The language model for `model_id`: `provider(modelId)`.
    pub fn model(&self, model_id: &str) -> anyhow::Result<Arc<dyn LanguageModel>> {
        (self.dispatch)(model_id)
    }

    /// The prompt-cache breakpoint fragment for one model.
    pub fn cache_point(&self, model_id: &str, ttl: Option<CacheTtl>) -> CachePointFragment {
        (self.cache_point)(model_id, ttl)
    }

    /// `provider.promptCacheState?.(modelId)`.
    pub fn prompt_cache_state(&self, model_id: &str) -> Option<PromptCacheState> {
        self.prompt_cache_state.as_ref().map(|f| f(model_id))
    }

    /// `provider.toolChanges?.(modelId)`.
    pub fn tool_changes(&self, model_id: &str) -> Option<&'static ToolChangeProtocol> {
        self.tool_changes.as_ref().and_then(|f| f(model_id))
    }

    /// `provider.deferredTools?.(modelId)`.
    pub fn deferred_tools(&self, model_id: &str) -> Option<&'static DeferredToolProtocol> {
        self.deferred_tools.as_ref().and_then(|f| f(model_id))
    }
}
