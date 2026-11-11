//! Centralized configuration: the single place for all environment reads.
//!
//! `CONFIG` (or `config()`) is built once from the process environment, after
//! `.env` is loaded (`lib::environment`). `Config::from_env` builds one from any
//! environment map, which is what the tests use.
//!
//! A value the operator set wrongly in a way that cannot run stops startup with
//! an error naming the variable. A value that can fall back to a default does so,
//! and the invalid text is kept in an `invalid_*` field for the startup warning.

use std::collections::HashMap;
use std::io::IsTerminal;
use std::sync::LazyLock;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

use crate::constants::{
    ATTACHMENT_CONTENT_TTL_HOURS, COMPACTION_TAIL_MESSAGES, COMPACTION_THRESHOLD_PERCENT,
    DEFAULT_HEARTBEAT_INTERVAL_MS, GOAL_MAX_TURNS, MAX_HEARTBEAT_INTERVAL_MS,
    MIN_HEARTBEAT_INTERVAL_MS, TOOL_OUTPUT_TTL_HOURS, TOOL_SEARCH_THRESHOLD_PERCENT,
};
use crate::lib::coding_agents::subscription::subscription_forced_in;
use crate::lib::llm_providers::bedrock_model_id::{is_anthropic_model_id, is_openai_bedrock_model_id};
use crate::lib::llm_providers::llm_provider::CacheTtl;
use crate::lib::loopback_host::is_loopback_hostname;
use crate::lib::managed_realtime::{RealtimeSource, resolve_realtime_configuration};
use crate::lib::origin_patterns::{OriginPattern, parse_origin_patterns};
use crate::lib::prism_settings::{
    AgentModelDefaults, read_agent_model_defaults, settings_path_for,
};

pub use crate::lib::environment::{DOTENV_LOAD_INFO, DotenvLoadInfo, dotenv_load_info};

/// An environment: variable name to value.
pub type Env = HashMap<String, String>;

// ============================================================================
// Named values
// ============================================================================

/// Which vendor the runtime talks to. One provider per container (matching one
/// AGENT_ID per container). Anything unrecognized falls back to the default,
/// `bedrock`, so an unset or mistyped value never silently breaks a Bedrock
/// deployment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LlmProviderName {
    #[serde(rename = "bedrock")]
    Bedrock,
    #[serde(rename = "azure")]
    Azure,
    #[serde(rename = "bedrock-mantle")]
    BedrockMantle,
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "openrouter")]
    Openrouter,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "litellm")]
    Litellm,
}

pub const LLM_PROVIDERS: [LlmProviderName; 7] = [
    LlmProviderName::Bedrock,
    LlmProviderName::Azure,
    LlmProviderName::BedrockMantle,
    LlmProviderName::Openai,
    LlmProviderName::Openrouter,
    LlmProviderName::Anthropic,
    LlmProviderName::Litellm,
];

impl LlmProviderName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bedrock => "bedrock",
            Self::Azure => "azure",
            Self::BedrockMantle => "bedrock-mantle",
            Self::Openai => "openai",
            Self::Openrouter => "openrouter",
            Self::Anthropic => "anthropic",
            Self::Litellm => "litellm",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        LLM_PROVIDERS.into_iter().find(|p| p.as_str() == text)
    }
}

/// Which vendor serves memory embeddings. Its own selection, decoupled from
/// `LLM_PROVIDER`: chat vendors don't all have embedding models, and an embedding
/// vendor need not serve chat. `none` disables embeddings entirely (memory rows
/// persist without vectors, vector search returns nothing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EmbeddingProviderName {
    #[serde(rename = "bedrock")]
    Bedrock,
    #[serde(rename = "azure-openai")]
    AzureOpenai,
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "openrouter")]
    Openrouter,
    #[serde(rename = "none")]
    None,
}

pub const EMBEDDING_PROVIDERS: [EmbeddingProviderName; 5] = [
    EmbeddingProviderName::Bedrock,
    EmbeddingProviderName::AzureOpenai,
    EmbeddingProviderName::Openai,
    EmbeddingProviderName::Openrouter,
    EmbeddingProviderName::None,
];

impl EmbeddingProviderName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bedrock => "bedrock",
            Self::AzureOpenai => "azure-openai",
            Self::Openai => "openai",
            Self::Openrouter => "openrouter",
            Self::None => "none",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        EMBEDDING_PROVIDERS.into_iter().find(|p| p.as_str() == text)
    }
}

/// How hard the in-meeting model thinks before it answers or picks a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RealtimeReasoningEffort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

pub const REALTIME_REASONING_EFFORTS: [RealtimeReasoningEffort; 5] = [
    RealtimeReasoningEffort::Minimal,
    RealtimeReasoningEffort::Low,
    RealtimeReasoningEffort::Medium,
    RealtimeReasoningEffort::High,
    RealtimeReasoningEffort::Xhigh,
];

impl RealtimeReasoningEffort {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        REALTIME_REASONING_EFFORTS
            .into_iter()
            .find(|e| e.as_str() == text)
    }
}

/// Server-side noise reduction over meeting audio: `off` sends no setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoiseReduction {
    Off,
    NearField,
    FarField,
}

impl NoiseReduction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::NearField => "near_field",
            Self::FarField => "far_field",
        }
    }
}

/// Whether what is said in a meeting reaches the runtime's own logs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeetingTranscriptLogging {
    Off,
    Full,
}

impl MeetingTranscriptLogging {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Full => "full",
        }
    }
}

/// THREAD_MODE: `multi` (the default) lets clients start and switch conversations;
/// `single` gives the agent one conversation that every client and every
/// autonomous run shares. Any other value runs `multi`, and index warns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadMode {
    Multi,
    Single,
}

pub const THREAD_MODES: [ThreadMode; 2] = [ThreadMode::Multi, ThreadMode::Single];

impl ThreadMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Multi => "multi",
            Self::Single => "single",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        THREAD_MODES.into_iter().find(|m| m.as_str() == text)
    }
}

/// Optional pre-execution risk evaluation for mutation-capable and otherwise
/// sensitive tools. Off by default, so existing deployments keep their latency
/// and behavior until an operator opts in. `observe` runs the classifier and
/// records its verdict without changing execution; `enforce` blocks rejected
/// calls and fails closed when the classifier is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolRiskGateMode {
    Off,
    Observe,
    Enforce,
}

pub const TOOL_RISK_GATE_MODES: [ToolRiskGateMode; 3] = [
    ToolRiskGateMode::Off,
    ToolRiskGateMode::Observe,
    ToolRiskGateMode::Enforce,
];

impl ToolRiskGateMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Observe => "observe",
            Self::Enforce => "enforce",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        TOOL_RISK_GATE_MODES
            .into_iter()
            .find(|m| m.as_str() == text)
    }
}

/// The coding agents the `coding_agent` tools hand a task to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CodingAgentName {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "codex")]
    Codex,
}

pub const CODING_AGENTS: [CodingAgentName; 2] =
    [CodingAgentName::ClaudeCode, CodingAgentName::Codex];

impl CodingAgentName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        CODING_AGENTS.into_iter().find(|a| a.as_str() == text)
    }
}

impl std::fmt::Display for CodingAgentName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Fixed or Auto model selection, as the deployment default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelSelectionMode {
    Fixed,
    Auto,
}

impl ModelSelectionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Auto => "auto",
        }
    }
}

/// One value per model tier, smallest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TierSet<T> {
    pub small: T,
    pub medium: T,
    pub large: T,
}

impl<T> TierSet<T> {
    /// The value for a tier named `small`, `medium` or `large`.
    pub fn get(&self, tier: &str) -> Option<&T> {
        match tier {
            "small" => Some(&self.small),
            "medium" => Some(&self.medium),
            "large" => Some(&self.large),
            _ => None,
        }
    }
}

/// Deployment defaults for Auto model selection (`lib/model_routing`). A column
/// the agent has not set falls back to these, as `model` falls back to
/// `chat_model_id`. No tier has a built-in default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelectionDefaults {
    pub mode: ModelSelectionMode,
    pub tiers: TierSet<Option<String>>,
}

/// One Claude Code tier, keyed by the backend Claude Code itself runs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeCodeTierModel {
    pub default: String,
    pub bedrock: String,
}

/// One Codex tier, keyed by the backend Codex runs on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexTierModel {
    pub openai: String,
    pub bedrock: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentModels {
    #[serde(rename = "claude-code")]
    pub claude_code: TierSet<ClaudeCodeTierModel>,
    pub codex: TierSet<CodexTierModel>,
}

/// Where the selected vendor's chat requests go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRouting {
    Nexus,
    Direct,
}

impl ChatRouting {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Nexus => "nexus",
            Self::Direct => "direct",
        }
    }
}

/// Which of override, gateway mount or vendor host named the chat endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatEndpointSource {
    Override,
    Gateway,
    Direct,
}

impl ChatEndpointSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Override => "override",
            Self::Gateway => "gateway",
            Self::Direct => "direct",
        }
    }
}

/// `TOOL_SEARCH`: `auto` defers the MCP tools above the threshold; `off` sends
/// every tool whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSearchMode {
    Auto,
    Off,
}

impl ToolSearchMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "off",
        }
    }
}

// ============================================================================
// The configuration
// ============================================================================

#[derive(Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    /// Judged once, after URL normalization, so `127.1` or `::ffff:127.0.0.1`
    /// counts as loopback too. `listen` still receives `host` as written.
    pub listens_on_loopback: bool,
    /// `PRISM_ALLOWED_ORIGINS`: browser origins on other sites that may call the
    /// runtime, in the syntax of `lib/origin_patterns`. Empty by default.
    pub allowed_origins: Vec<OriginPattern>,
    /// The public address of the Web UI, without a trailing slash.
    pub public_url: Option<String>,
    /// Webhook senders POST here, apart from the Web UI and the management API.
    pub webhook_port: u16,
    pub webhook_public_url: Option<String>,
    /// Other agents' messages arrive here, apart from everything else.
    pub agent_messages_port: u16,
    /// Dev convenience default; production sets `DATABASE_URL=file:/data/agent.db`
    /// via start.sh so the container's mounted /data volume is used.
    pub database_url: String,
    pub bedrock_model_id: String,
    pub bedrock_classification_model_id: String,
    pub bedrock_embedding_model_id: String,
    pub aws_region: String,
    pub aws_access_key_id: Option<String>,
    pub aws_secret_access_key: Option<String>,
    /// Only needed for temporary credentials.
    pub aws_session_token: Option<String>,

    /// LLM provider selection. See the neutral `chat_model_id` /
    /// `classification_model_id` / `embedding_model_id` below, which the rest of
    /// the runtime reads instead of the vendor-specific fields.
    pub llm_provider: LlmProviderName,
    /// The unrecognized non-empty LLM_PROVIDER value, kept for the startup
    /// warning; `None` when the value was valid or unset.
    pub invalid_llm_provider: Option<String>,

    /// Embedding provider selection (EMBEDDING_PROVIDER). Its own feature
    /// (`lib/embedding_providers`), decoupled from `llm_provider`; unset derives
    /// the chat vendor's historical default.
    pub embedding_provider: EmbeddingProviderName,
    /// The unrecognized non-empty EMBEDDING_PROVIDER value, kept for the startup
    /// warning; `None` when the value was valid or unset.
    pub invalid_embedding_provider: Option<String>,

    /// Azure: Claude via Microsoft Foundry (used when LLM_PROVIDER=azure).
    /// Chat/classification speak the Anthropic Messages API at
    /// `azure_chat_endpoint`; embeddings go to Azure OpenAI (text-embedding-3
    /// deployment) on the same resource. Model IDs are Foundry deployment names.
    /// `azure_api_key` is sent as the `x-api-key` header; it may be a
    /// `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire.
    pub azure_resource_name: Option<String>,
    /// Foundry without the gateway, which is the question `isAzureConfigured`
    /// asks. Never the chat client's endpoint; that is `azure_chat_endpoint`.
    pub azure_direct_endpoint: Option<String>,
    /// The endpoint the Azure chat client uses: override, else gateway mount, else
    /// the resource's own host.
    pub azure_chat_endpoint: Option<String>,
    pub azure_api_key: Option<String>,
    /// Embeddings only; `None` → SDK default (`preview`).
    pub azure_api_version: Option<String>,
    pub azure_model_id: String,
    pub azure_classification_model_id: String,
    pub azure_embedding_model_id: String,
    pub nexus_azure_base_url: Option<String>,
    pub nexus_azure_open_ai_base_url: Option<String>,

    /// Bedrock Mantle (used when LLM_PROVIDER=bedrock-mantle). Chat/classification
    /// speak the Anthropic Messages API at `bedrock_mantle_chat_endpoint`; there is
    /// no embedding surface, so embeddings stay on Titan over bedrock-runtime.
    /// Model IDs are bare Bedrock IDs. `bedrock_api_key` is the same
    /// AWS_BEARER_TOKEN_BEDROCK the native Bedrock path uses, sent here as the
    /// `x-api-key` header; required for direct mode.
    pub bedrock_api_key: Option<String>,
    /// Mantle without the gateway, for `isBedrockMantleConfigured`. Never the
    /// chat client's endpoint; that is `bedrock_mantle_chat_endpoint`.
    pub bedrock_mantle_direct_endpoint: String,
    /// The endpoint the mantle chat client uses: override, else gateway mount,
    /// else the region's own host.
    pub bedrock_mantle_chat_endpoint: String,
    pub bedrock_mantle_model_id: String,
    pub bedrock_mantle_classification_model_id: String,
    pub bedrock_mantle_embedding_model_id: String,
    pub nexus_bedrock_mantle_base_url: Option<String>,

    /// OpenAI (used when LLM_PROVIDER=openai). Chat, classification and
    /// embeddings speak the OpenAI API on one surface, at `openai_endpoint`:
    /// OPENAI_BASE_URL if set, else the Lens Agents `…/llm/openai/v1` mount when
    /// NEXUS_API_URL is set, else api.openai.com (`None`).
    pub openai_model_id: String,
    pub openai_classification_model_id: String,
    pub openai_embedding_model_id: String,
    pub openai_endpoint: Option<String>,
    pub nexus_openai_base_url: Option<String>,

    /// OpenRouter (used when LLM_PROVIDER=openrouter). Same OpenAI surface, a
    /// different vendor behind it, at `openrouter_endpoint`. Direct it needs
    /// `openrouter_api_key`; on the gateway that key is held for you. Model ids
    /// are `vendor/model`.
    pub openrouter_model_id: String,
    pub openrouter_classification_model_id: String,
    pub openrouter_embedding_model_id: String,
    pub openrouter_endpoint: String,
    pub openrouter_api_key: Option<String>,
    pub nexus_openrouter_base_url: Option<String>,

    /// Anthropic (used when LLM_PROVIDER=anthropic): direct to api.anthropic.com
    /// (or `anthropic_base_url`), the one vendor with no gateway mount, so
    /// `anthropic_api_key` is always required.
    pub anthropic_api_key: Option<String>,
    pub anthropic_model_id: String,
    pub anthropic_classification_model_id: String,
    pub anthropic_base_url: Option<String>,

    /// LiteLLM (used when LLM_PROVIDER=litellm): an operator's own LiteLLM proxy,
    /// in the Anthropic Messages format at `litellm_endpoint`. Direct it needs
    /// `litellm_api_key`. Model ids are the operator's aliases.
    pub litellm_model_id: String,
    pub litellm_classification_model_id: String,
    pub litellm_api_key: Option<String>,
    pub litellm_endpoint: Option<String>,
    pub nexus_litellm_base_url: Option<String>,

    /// AGENT_ID is optional: when unset, `resolveOrBootstrapSingleAgent` either
    /// picks up the existing row or creates one, and sets it here.
    agent_id: RwLock<Option<String>>,

    /// The API token id the ingress names in `x-forwarded-token-id` for the
    /// delivery service of agent messages (routes/agent_messages). `None` until
    /// set: deliveries then answer 503, so the service sends them again later.
    pub agent_messages_token_id: Option<String>,

    /// First-boot bootstrap defaults. OWNER_USER_ID's default is the
    /// "local-owner" sentinel; boot replaces it with the agent row's `userId`.
    owner_user_id: RwLock<String>,
    pub agent_name: String,
    pub team_name: String,

    /// Per-agent model overrides seeded onto a freshly-bootstrapped agent, read
    /// from the shared `~/.prism/settings.json`. Read once at startup.
    pub agent_defaults: AgentModelDefaults,

    /// A directory of identity documents (`soulMd.md`, `agentMd.md`, …) that a
    /// freshly-bootstrapped agent starts with instead of the default templates.
    pub workspace_seed_dir: Option<String>,

    pub nexus_api_url: Option<String>,

    /// Slack: bot token and optional app-id safety check.
    pub slack_bot_token: Option<String>,
    pub slack_expected_app_id: Option<String>,

    /// Microsoft Teams: a Single Tenant Entra app registration behind an Azure
    /// Bot resource. TEAMS_APP_PASSWORD is the client secret, or on Lens Agents
    /// the sentinel of an OAuth client-credentials credential.
    pub teams_app_id: Option<String>,
    pub teams_app_password: Option<String>,
    pub teams_app_tenant_id: Option<String>,
    /// The bot endpoint's own port. It serves POST /agents/teams/messages and
    /// nothing else, so it is the one port a deployment publishes to Microsoft.
    pub teams_port: u16,

    /// External MCP server URL, injected as NEXUS_MCP_URL by the Lens Agents
    /// sandbox. Already a complete URL; do NOT append /mcp. `None` when unset.
    pub nexus_mcp_url: Option<String>,

    /// Langfuse observability (optional; disabled when keys are not set).
    pub langfuse_secret_key: Option<String>,
    pub langfuse_public_key: Option<String>,
    pub langfuse_base_url: String,

    /// Lens Agents LLM proxy base URL for native Bedrock. Also carries mantle's
    /// embedding leg, since Titan is bedrock-runtime-only.
    pub nexus_llm_base_url: Option<String>,
    /// The selected vendor's gateway chat mount. An override may send chat
    /// elsewhere; `chat_routing` is where it goes.
    pub nexus_chat_base_url: Option<String>,
    /// Where the selected vendor's chat requests go, and which of override,
    /// gateway mount or vendor host named that endpoint. For the startup log.
    pub chat_routing: ChatRouting,
    pub chat_endpoint_source: ChatEndpointSource,
    pub chat_endpoint_for_log: String,

    /// OpenTelemetry (optional; disabled when empty).
    pub otel_endpoint: String,
    /// Optional API key sent as the `x-api-key` header.
    pub otel_api_key: String,
    /// Identifies the deployment for OTel resource routing.
    pub deployment_environment: String,
    /// The OTel `product.name` resource attribute; empty omits it.
    pub product_name: String,
    /// The OTel `service.version` resource attribute; empty omits it.
    pub service_version: String,

    /// The runtime's own version, as the updater compares it: the release tag
    /// baked into the packaged binary, else the image's SERVICE_VERSION, else "".
    pub app_version: String,

    /// DISABLE_UPDATER=1 (or =true) turns off update checks, autoupdate, and the
    /// manual update command.
    pub disable_updater: bool,

    pub program_status_reports: bool,

    /// THREAD_MODE: `multi` or `single`. `invalid_thread_mode` is the
    /// unrecognized non-empty value, kept for the startup warning.
    pub thread_mode: ThreadMode,
    pub invalid_thread_mode: Option<String>,

    /// Goals: `goal_max_turns` overrides the GOAL_MAX_TURNS hard cap.
    /// `goal_default_token_budget` is the per-goal token budget applied when the
    /// caller doesn't specify one; `None` means unbounded.
    pub goal_max_turns: i64,
    pub goal_default_token_budget: Option<i64>,

    /// How long attachment content (the media file) is kept before the hourly
    /// sweep deletes it. The metadata row survives.
    pub attachment_content_ttl_ms: i64,
    pub tool_output_ttl_ms: i64,

    /// Provider-neutral model IDs. For Azure these are deployment names; on
    /// bedrock-mantle they are bare Bedrock IDs. The embedding id follows
    /// `embedding_provider`; "" means embeddings are disabled.
    pub chat_model_id: String,
    pub classification_model_id: String,
    /// Auto model selection defaults: the mode and the three tiers an agent
    /// falls back to where its own columns are null.
    pub model_selection: ModelSelectionDefaults,
    pub embedding_model_id: String,

    /// Fast-model pre-execution policy gate for sensitive tool calls. Invalid
    /// values resolve to off; index emits a startup warning using the companion
    /// field.
    pub tool_risk_gate_mode: ToolRiskGateMode,
    pub invalid_tool_risk_gate_mode: Option<String>,

    /// The default coding agent; detection at boot replaces it when the operator
    /// named none (`lib/coding_agents/availability`).
    coding_agent: RwLock<CodingAgentName>,
    pub coding_agent_models: CodingAgentModels,
    /// Filled at boot by `lib/coding_agents/availability`; until then, no agent
    /// is offered.
    available_coding_agents: RwLock<Vec<CodingAgentName>>,
    /// The operator's explicit choice, which detection leaves alone.
    pub configured_coding_agent: Option<CodingAgentName>,
    /// CLAUDE_CODE_SUBSCRIPTION=true runs every Claude Code task on the Claude
    /// subscription signed in to the CLI's home, and on nothing else.
    pub claude_code_subscription: bool,
    /// CODEX_SUBSCRIPTION=true runs every Codex task on the ChatGPT subscription
    /// signed in to the CLI's home, and on nothing else.
    pub codex_subscription: bool,
    /// CLAUDE_CODE_SKIP_PERMISSIONS=true runs every Claude Code edit task with its
    /// permission checks off; a plan task stays in plan mode.
    pub claude_code_skip_permissions: bool,

    /// Overrides the input-context window used by the context-window indicator,
    /// for a model neither the bundled catalog nor the boot-time refresh knows.
    /// A non-numeric or non-positive value is ignored.
    pub context_window_tokens: Option<i64>,

    /// Registry to refresh the model-window catalog from, once at startup.
    /// Opt-in: `None` unless set.
    pub models_dev_url: Option<String>,

    /// Auto-compaction trigger, as a percent of the model's context window.
    /// `None` means disabled (COMPACTION_THRESHOLD_PERCENT=0); otherwise 1–100.
    pub compaction_threshold_percent: Option<i64>,

    /// TOOL_SEARCH and TOOL_SEARCH_THRESHOLD_PERCENT; the invalid values are kept
    /// for the startup warning.
    pub tool_search: ToolSearchMode,
    pub invalid_tool_search: Option<String>,
    pub tool_search_threshold_percent: f64,
    pub invalid_tool_search_threshold: Option<String>,
    pub heartbeat_interval_ms: i64,

    /// Newest messages excluded from compaction and kept verbatim in the
    /// context. 0 is legal.
    pub compaction_tail_messages: i64,

    /// Whether a large chat conversation is compacted before its one-hour cache
    /// expires, under CHAT_CACHE_TTL=1h. IDLE_COMPACTION=off turns it off.
    pub idle_compaction: bool,

    /// How long a chat turn asks the provider to keep its prompt cache.
    pub chat_cache_ttl: CacheTtl,

    /// Live voice meetings. The meeting tools are only registered when
    /// `openai_realtime_api_key` is set and the container has the browser and
    /// audio toolchain.
    pub openai_api_key: Option<String>,
    pub openai_realtime_model: String,
    /// Explicit voice override, else capability-based managed discovery or
    /// direct voice.
    pub openai_realtime_url: Option<String>,
    pub openai_realtime_api_key: Option<String>,
    pub realtime_source: RealtimeSource,
    pub realtime_provider: Option<String>,
    pub realtime_unavailable_reason: Option<String>,
    pub openai_realtime_voice: String,
    /// OPENAI_REALTIME_REASONING_EFFORT, default `high`; empty sends no setting
    /// and leaves the choice to the API (`None`).
    pub openai_realtime_reasoning_effort: Option<RealtimeReasoningEffort>,
    pub openai_transcription_model: String,
    pub noise_reduction: NoiseReduction,
    /// MEETING_TRANSCRIPT_LOGGING, default `off`: whether a meeting's speech may
    /// appear in the runtime's logs.
    pub meeting_transcript_logging: MeetingTranscriptLogging,
    pub google_bot_email: Option<String>,
    pub google_bot_password: Option<String>,
    pub meeting_timeout_minutes: i64,
    pub meeting_admission_timeout_ms: i64,

    /// The gateway's own origin, for `is_gateway_endpoint`.
    nexus_origin: Option<String>,
}

/// The configuration of this process, built from the environment once, after
/// `.env` is loaded. A value that stops startup prints its error and exits.
#[cfg(not(test))]
pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    LazyLock::force(&DOTENV_LOAD_INFO);
    match Config::from_env(&crate::lib::environment::process_env()) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("Error: {err:#}");
            std::process::exit(1);
        }
    }
});

/// Unit tests read a fixed configuration, never the developer's environment or
/// `.env`: the values the TypeScript suite's global config mock gave, on the
/// built-in defaults. `gateway.example.com` is the gateway host, as there.
#[cfg(test)]
pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    let env: Env = [
        ("AGENT_ID", "test-agent-id"),
        ("OWNER_USER_ID", "test-owner-id"),
        ("DATABASE_URL", "file::memory:"),
        (
            "BEDROCK_MODEL_ID",
            "anthropic.claude-3-sonnet-20240229-v1:0",
        ),
        (
            "BEDROCK_CLASSIFICATION_MODEL_ID",
            "anthropic.claude-3-haiku-20240307-v1:0",
        ),
        ("NEXUS_MCP_URL", "http://localhost:3002/mcp"),
        ("OPENAI_TRANSCRIPTION_MODEL", "gpt-realtime-whisper"),
        ("PRISM_PROGRAM_STATUS", "off"),
        ("PRISM_SETTINGS_PATH", "/nonexistent/prism-settings.json"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let mut config = Config::load(&env, &mut |_, _| {}).expect("test config loads");
    config.nexus_origin = Some("https://gateway.example.com".to_string());
    config.set_available_coding_agents(vec![CodingAgentName::ClaudeCode]);
    config
});

/// The configuration of this process (`CONFIG`).
pub fn config() -> &'static Config {
    &CONFIG
}

/// Whether the Lens Agents gateway serves `url`, and so holds the vendor
/// credential for it. The origin lowercases the host and drops a default port,
/// and it ignores the path, so any mount on the gateway host matches. An unset or
/// unparseable value on either side answers false: such an endpoint fails in the
/// request regardless, and the SDK then reports the missing key itself.
pub fn is_gateway_endpoint(url: Option<&str>) -> bool {
    CONFIG.is_gateway_endpoint(url)
}

impl Config {
    pub fn agent_id(&self) -> Option<String> {
        self.agent_id.read().clone()
    }

    pub fn set_agent_id(&self, agent_id: Option<String>) {
        *self.agent_id.write() = agent_id;
    }

    pub fn owner_user_id(&self) -> String {
        self.owner_user_id.read().clone()
    }

    pub fn set_owner_user_id(&self, owner_user_id: String) {
        *self.owner_user_id.write() = owner_user_id;
    }

    pub fn coding_agent(&self) -> CodingAgentName {
        *self.coding_agent.read()
    }

    pub fn set_coding_agent(&self, agent: CodingAgentName) {
        *self.coding_agent.write() = agent;
    }

    pub fn available_coding_agents(&self) -> Vec<CodingAgentName> {
        self.available_coding_agents.read().clone()
    }

    pub fn set_available_coding_agents(&self, agents: Vec<CodingAgentName>) {
        *self.available_coding_agents.write() = agents;
    }

    /// See the free function `is_gateway_endpoint`.
    pub fn is_gateway_endpoint(&self, url: Option<&str>) -> bool {
        let origin = origin_of(url);
        self.nexus_origin.is_some() && origin == self.nexus_origin
    }

    /// Builds the configuration from `env`, logging its warnings.
    pub fn from_env(env: &Env) -> anyhow::Result<Config> {
        Self::load(env, &mut |fields, msg| crate::log_warn!(fields, "{}", msg))
    }

    /// Builds the configuration from `env`, handing each warning to `warn` in
    /// the order the TypeScript runtime logged them.
    pub(crate) fn load(env: &Env, warn: &mut dyn FnMut(Value, &str)) -> anyhow::Result<Config> {
        let e = Reader(env);

        let nexus_api_url = e.get("NEXUS_API_URL").map(str::to_string);
        let project_id = e.get("PROJECT_ID").map(str::to_string);
        let port = parse_port(e.or("PORT").unwrap_or("3003"), "PORT")?;
        let webhook_port = parse_port(e.or("WEBHOOK_PORT").unwrap_or("3004"), "WEBHOOK_PORT")?;
        if webhook_port == port {
            anyhow::bail!("WEBHOOK_PORT must differ from PORT");
        }
        // Messages from the other agents of the project arrive on a port of their
        // own (`create_agent_messages_app`), so the API above never serves them.
        let agent_messages_port =
            crate::support::js::parse_int(e.or("AGENT_MESSAGES_PORT").unwrap_or("3005"))
                .filter(|p| (1..=65535).contains(p))
                .map(|p| p as u16)
                .ok_or_else(|| anyhow::anyhow!("AGENT_MESSAGES_PORT must be a port number"))?;
        if agent_messages_port == port {
            anyhow::bail!("AGENT_MESSAGES_PORT must differ from PORT");
        }
        if agent_messages_port == webhook_port {
            anyhow::bail!("AGENT_MESSAGES_PORT must differ from WEBHOOK_PORT");
        }
        // Loopback by default, so only this machine connects. The container image
        // sets `PRISM_HOST=0.0.0.0`, which is what a published port needs.
        let host = e
            .get("PRISM_HOST")
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .unwrap_or("127.0.0.1")
            .to_string();
        let listens_on_loopback = is_loopback_hostname(&host);

        let allowed_origins = read_allowed_origins(&e, &host, listens_on_loopback)?;

        let public_url = e
            .get("PRISM_PUBLIC_URL")
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(str::to_string)
            .or_else(|| {
                ingress_origin(
                    &e,
                    &ingress_port_name(&e, port).unwrap_or_else(|| "web".to_string()),
                )
            })
            .map(|u| trim_trailing_slashes(&u).to_string())
            .filter(|u| !u.is_empty());
        // Discover the webhook URL from the deployment's named port metadata.
        let webhook_public_url = ingress_port_name(&e, webhook_port)
            .filter(|name| !name.is_empty())
            .and_then(|name| ingress_origin(&e, &name))
            .map(|u| trim_trailing_slashes(&u).to_string())
            .filter(|u| !u.is_empty());
        let aws_region = e.or("AWS_REGION").unwrap_or("us-east-1").to_string();

        let raw_llm_provider = e.or("LLM_PROVIDER").unwrap_or("").trim().to_lowercase();
        let parsed_llm_provider = LlmProviderName::parse(&raw_llm_provider);
        let llm_provider = parsed_llm_provider.unwrap_or(LlmProviderName::Bedrock);
        // Kept for the startup warning: a fallback to bedrock on a value nobody
        // meant as bedrock otherwise surfaces only as a refused gateway call.
        let invalid_llm_provider = (!raw_llm_provider.is_empty() && parsed_llm_provider.is_none())
            .then(|| raw_llm_provider.clone());

        // The gateway mounts: `/projects/{projectId}/llm/…` with PROJECT_ID set,
        // `/llm/…` (auto-resolve) without. `None` when NEXUS_API_URL is unset.
        let nexus_root = nexus_api_url
            .as_deref()
            .filter(|u| !u.is_empty())
            .map(|api| match project_id.as_deref() {
                Some(project) if !project.is_empty() => format!("{api}/projects/{project}/llm"),
                _ => format!("{api}/llm"),
            });
        let mount = |path: String| nexus_root.as_ref().map(|root| format!("{root}/{path}"));
        // Native Bedrock (bedrock-runtime). This mount also carries the `bedrock`
        // embedding provider's leg, so on `bedrock-mantle` it stays in use even
        // though chat rides `nexus_bedrock_mantle_base_url`.
        let nexus_llm_base_url = mount(format!("bedrock/{aws_region}"));
        // Azure: the gateway exposes the two Foundry surfaces separately. Both
        // bases end at `/v1` for the proxied URLs to land on
        // `…/anthropic/v1/messages` and `…/openai/v1/embeddings`.
        let nexus_azure_base_url = mount("azure/anthropic/v1".to_string());
        let nexus_azure_open_ai_base_url = mount("azure/openai/v1".to_string());
        // Bedrock Mantle's Anthropic surface. Keyless: the gateway holds the
        // Bedrock credential.
        let nexus_bedrock_mantle_base_url =
            mount(format!("bedrock-mantle/anthropic/{aws_region}/v1"));
        // OpenAI: one mount carries chat, classification and embeddings. Keyless.
        let nexus_openai_base_url = mount("openai/v1".to_string());
        // OpenRouter: it must be this mount rather than `/llm/openai/*`, since the
        // managed-inference gate compares the path's backend against the policy's.
        let nexus_openrouter_base_url = mount("openrouter/openai/v1".to_string());
        // LiteLLM's Anthropic surface. The gateway meters this backend by the
        // cost LiteLLM reports, so it must be this mount.
        let nexus_litellm_base_url = mount("litellm/anthropic/v1".to_string());

        // The selected vendor's gateway chat mount. No gateway mount serves
        // api.anthropic.com, so anthropic chat is always direct.
        let nexus_chat_base_url = match llm_provider {
            LlmProviderName::Bedrock => nexus_llm_base_url.clone(),
            LlmProviderName::Azure => nexus_azure_base_url.clone(),
            LlmProviderName::BedrockMantle => nexus_bedrock_mantle_base_url.clone(),
            LlmProviderName::Openai => nexus_openai_base_url.clone(),
            LlmProviderName::Openrouter => nexus_openrouter_base_url.clone(),
            LlmProviderName::Anthropic => None,
            LlmProviderName::Litellm => nexus_litellm_base_url.clone(),
        };

        // The gateway's own origin. The credential decision turns on one
        // question: does this request reach the gateway, which injects the vendor
        // key on the outbound leg?
        let nexus_origin = origin_of(nexus_api_url.as_deref());

        // Azure's direct Foundry Anthropic endpoint: the explicit override, else
        // the one derived from the resource name. It must end at `/anthropic/v1`.
        let azure_resource_name = e.get("AZURE_RESOURCE_NAME").map(str::to_string);
        let azure_foundry_override = e.or("AZURE_FOUNDRY_BASE_URL").map(str::to_string);
        let azure_resource_endpoint = azure_resource_name
            .as_deref()
            .filter(|name| !name.is_empty())
            .map(|name| format!("https://{name}.services.ai.azure.com/anthropic/v1"));
        let azure_direct_endpoint = azure_foundry_override
            .clone()
            .or_else(|| azure_resource_endpoint.clone());

        // The Bedrock API key. Mantle's Anthropic surface needs it explicitly
        // (sent as `x-api-key`). May be a `__nexus_cred:<uuid>__` sentinel.
        let bedrock_api_key = e.get("AWS_BEARER_TOKEN_BEDROCK").map(str::to_string);

        // Bedrock Mantle's direct chat endpoint. Must end at `/anthropic/v1`.
        let bedrock_mantle_override = e.or("BEDROCK_MANTLE_BASE_URL").map(str::to_string);
        let bedrock_mantle_region_endpoint =
            format!("https://bedrock-mantle.{aws_region}.api.aws/anthropic/v1");
        let bedrock_mantle_direct_endpoint = bedrock_mantle_override
            .clone()
            .unwrap_or_else(|| bedrock_mantle_region_endpoint.clone());

        // The chat and classification defaults use the `global.` inference
        // profile: it costs less than a regional one and has the same limits.
        let bedrock_model_id = e.or_default("BEDROCK_MODEL_ID", "global.anthropic.claude-opus-5-5");
        let bedrock_classification_model_id = e.or_default(
            "BEDROCK_CLASSIFICATION_MODEL_ID",
            "global.anthropic.claude-haiku-5-5",
        );
        let bedrock_embedding_model_id =
            e.or_default("BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0");
        // Azure model IDs are deployment names. AZURE_EMBEDDING_MODEL_ID='' skips
        // embedding entirely.
        let azure_model_id = e.or_default("AZURE_MODEL_ID", "claude-opus-5");
        let azure_classification_model_id =
            e.or_default("AZURE_CLASSIFICATION_MODEL_ID", "claude-haiku-5-5");
        let azure_embedding_model_id =
            e.get_or("AZURE_EMBEDDING_MODEL_ID", "text-embedding-3-small");
        // Mantle model IDs are bare Bedrock IDs and do not fall back to the
        // BEDROCK_* vars, which may hold a prefixed value mantle rejects. Mantle
        // serves no embedding models, so embeddings stay on Titan over
        // bedrock-runtime; BEDROCK_MANTLE_EMBEDDING_MODEL_ID='' disables them.
        let bedrock_mantle_model_id =
            e.or_default("BEDROCK_MANTLE_MODEL_ID", "anthropic.claude-opus-5");
        let bedrock_mantle_classification_model_id = e.or_default(
            "BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID",
            "anthropic.claude-haiku-4-5",
        );
        let bedrock_mantle_embedding_model_id = e.get_or(
            "BEDROCK_MANTLE_EMBEDDING_MODEL_ID",
            &bedrock_embedding_model_id,
        );
        // OpenAI model IDs. OPENAI_EMBEDDING_MODEL_ID='' disables embeddings.
        let openai_model_id = e.or_default("OPENAI_MODEL_ID", "gpt-5.6-sol");
        let openai_classification_model_id =
            e.or_default("OPENAI_CLASSIFICATION_MODEL_ID", "gpt-5.6-luna");
        let openai_embedding_model_id =
            e.get_or("OPENAI_EMBEDDING_MODEL_ID", "text-embedding-3-small");
        // OpenRouter model IDs are `vendor/model`. Embeddings default to off: the
        // vendors it routes differ in native dimensionality and the index is
        // fixed at 1024.
        let openrouter_model_id = e.or_default("OPENROUTER_MODEL_ID", "openai/gpt-5.6-sol");
        let openrouter_classification_model_id =
            e.or_default("OPENROUTER_CLASSIFICATION_MODEL_ID", "openai/gpt-5.6-luna");
        let openrouter_embedding_model_id = e.get_or("OPENROUTER_EMBEDDING_MODEL_ID", "");
        let openrouter_override = e.or("OPENROUTER_BASE_URL").map(str::to_string);
        let openrouter_api_key = e.get("OPENROUTER_API_KEY").map(str::to_string);
        // Must serve the Responses API. Does not move the Realtime WebSocket.
        let openai_override = e.or("OPENAI_BASE_URL").map(str::to_string);

        // Chat/embedding credential and legacy fallback for direct Realtime.
        let openai_api_key = e.get("OPENAI_API_KEY").map(str::to_string);

        // Anthropic model IDs: bare first-party IDs on api.anthropic.com.
        let anthropic_model_id = e.or_default("ANTHROPIC_MODEL_ID", "claude-opus-5");
        let anthropic_classification_model_id =
            e.or_default("ANTHROPIC_CLASSIFICATION_MODEL_ID", "claude-haiku-5-5");
        let anthropic_api_key = e.get("ANTHROPIC_API_KEY").map(str::to_string);
        // Must end at `/v1`; `None` → the SDK's own default.
        let anthropic_base_url = e.or("ANTHROPIC_BASE_URL").map(str::to_string);

        // LiteLLM model ids are the operator's own aliases.
        let litellm_model_id = e.or_default("LITELLM_MODEL_ID", "claude-opus-5-5");
        let litellm_classification_model_id =
            e.or_default("LITELLM_CLASSIFICATION_MODEL_ID", "claude-haiku-5-5");
        let litellm_api_key = e.get("LITELLM_API_KEY").map(str::to_string);
        // Normalised to end at `/v1` with no trailing slash: LiteLLM serves the
        // Messages API only under `/v1`, and the startup check appends `/models`.
        let litellm_override = with_v1(e.get("LITELLM_BASE_URL"));

        // The endpoint each vendor's client uses, in precedence order: the
        // explicit `*_BASE_URL` override, else the gateway mount, else the
        // vendor's own host.
        let azure_chat_endpoint = azure_foundry_override
            .clone()
            .or_else(|| nexus_azure_base_url.clone())
            .or_else(|| azure_resource_endpoint.clone());
        let bedrock_mantle_chat_endpoint = bedrock_mantle_override
            .clone()
            .or_else(|| nexus_bedrock_mantle_base_url.clone())
            .unwrap_or_else(|| bedrock_mantle_region_endpoint.clone());
        let openai_endpoint = openai_override
            .clone()
            .or_else(|| nexus_openai_base_url.clone());
        let openrouter_endpoint = openrouter_override
            .clone()
            .or_else(|| nexus_openrouter_base_url.clone())
            .unwrap_or_else(|| OPENROUTER_DIRECT_BASE_URL.to_string());
        let litellm_endpoint = litellm_override
            .clone()
            .or_else(|| nexus_litellm_base_url.clone());

        // The selected vendor's chat endpoint and the override that supplied it,
        // for the startup log. Anthropic has no mount, so its override is its
        // whole endpoint.
        let (chat_endpoint, chat_override): (Option<String>, Option<String>) = match llm_provider {
            LlmProviderName::Bedrock => (nexus_llm_base_url.clone(), None),
            LlmProviderName::Azure => (azure_chat_endpoint.clone(), azure_foundry_override.clone()),
            LlmProviderName::BedrockMantle => (
                Some(bedrock_mantle_chat_endpoint.clone()),
                bedrock_mantle_override.clone(),
            ),
            LlmProviderName::Openai => (openai_endpoint.clone(), openai_override.clone()),
            LlmProviderName::Openrouter => (
                Some(openrouter_endpoint.clone()),
                openrouter_override.clone(),
            ),
            LlmProviderName::Anthropic => (anthropic_base_url.clone(), anthropic_base_url.clone()),
            LlmProviderName::Litellm => (litellm_endpoint.clone(), litellm_override.clone()),
        };
        // `Override` next to `ChatRouting::Nexus` is an override that replaced a
        // derived mount.
        let chat_endpoint_source = if chat_override.is_some() {
            ChatEndpointSource::Override
        } else if nexus_chat_base_url.is_some() && chat_endpoint == nexus_chat_base_url {
            ChatEndpointSource::Gateway
        } else {
            ChatEndpointSource::Direct
        };

        let (chat_model_id, classification_model_id) = match llm_provider {
            LlmProviderName::Bedrock => (
                bedrock_model_id.clone(),
                bedrock_classification_model_id.clone(),
            ),
            LlmProviderName::Azure => (
                azure_model_id.clone(),
                azure_classification_model_id.clone(),
            ),
            LlmProviderName::BedrockMantle => (
                bedrock_mantle_model_id.clone(),
                bedrock_mantle_classification_model_id.clone(),
            ),
            LlmProviderName::Openai => (
                openai_model_id.clone(),
                openai_classification_model_id.clone(),
            ),
            LlmProviderName::Openrouter => (
                openrouter_model_id.clone(),
                openrouter_classification_model_id.clone(),
            ),
            LlmProviderName::Anthropic => (
                anthropic_model_id.clone(),
                anthropic_classification_model_id.clone(),
            ),
            LlmProviderName::Litellm => (
                litellm_model_id.clone(),
                litellm_classification_model_id.clone(),
            ),
        };

        // MODEL_MODE=auto needs a small and a large model.
        let model_mode = if e.get("MODEL_MODE").unwrap_or("").trim().to_lowercase() == "auto" {
            ModelSelectionMode::Auto
        } else {
            ModelSelectionMode::Fixed
        };
        let auto_tier = |name: &str| {
            e.get(name)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        };
        let auto_model_tiers = TierSet {
            small: auto_tier("AUTO_MODEL_SMALL"),
            medium: auto_tier("AUTO_MODEL_MEDIUM"),
            large: auto_tier("AUTO_MODEL_LARGE"),
        };
        if model_mode == ModelSelectionMode::Auto {
            let mut missing = Vec::new();
            if auto_model_tiers.small.is_none() {
                missing.push("AUTO_MODEL_SMALL");
            }
            if auto_model_tiers.large.is_none() {
                missing.push("AUTO_MODEL_LARGE");
            }
            if !missing.is_empty() {
                anyhow::bail!("MODEL_MODE=auto needs {}", missing.join(" and "));
            }
        }

        // The default when EMBEDDING_PROVIDER is unset or unrecognized: each chat
        // vendor's historical embedding vendor. anthropic serves no embedding
        // models, so it borrows OpenAI's when a local key is present or the
        // gateway's openai mount can hold one, and otherwise runs without
        // vectors. litellm runs without them.
        let embedding_default = match llm_provider {
            LlmProviderName::Bedrock | LlmProviderName::BedrockMantle => {
                EmbeddingProviderName::Bedrock
            }
            LlmProviderName::Azure => EmbeddingProviderName::AzureOpenai,
            LlmProviderName::Openai => EmbeddingProviderName::Openai,
            LlmProviderName::Openrouter => EmbeddingProviderName::Openrouter,
            LlmProviderName::Anthropic => {
                if openai_api_key.as_deref().is_some_and(|k| !k.is_empty())
                    || nexus_openai_base_url.is_some()
                {
                    EmbeddingProviderName::Openai
                } else {
                    EmbeddingProviderName::None
                }
            }
            LlmProviderName::Litellm => EmbeddingProviderName::None,
        };
        let raw_embedding_provider = e
            .or("EMBEDDING_PROVIDER")
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let parsed_embedding_provider = EmbeddingProviderName::parse(&raw_embedding_provider);
        let embedding_provider = parsed_embedding_provider.unwrap_or(embedding_default);
        // Empty means unset, the documented way to ask for the default, so only a
        // non-empty mismatch counts.
        let invalid_embedding_provider = (!raw_embedding_provider.is_empty()
            && parsed_embedding_provider.is_none())
        .then(|| raw_embedding_provider.clone());

        // The embedding model id, keyed off the embedding provider. When a
        // bedrock-mantle deployment embeds on Titan, the mantle-scoped var stays
        // authoritative.
        let embedding_model_id = match embedding_provider {
            EmbeddingProviderName::Bedrock => {
                if llm_provider == LlmProviderName::BedrockMantle {
                    bedrock_mantle_embedding_model_id.clone()
                } else {
                    bedrock_embedding_model_id.clone()
                }
            }
            EmbeddingProviderName::AzureOpenai => azure_embedding_model_id.clone(),
            EmbeddingProviderName::Openai => openai_embedding_model_id.clone(),
            EmbeddingProviderName::Openrouter => openrouter_embedding_model_id.clone(),
            EmbeddingProviderName::None => String::new(),
        };

        // Pinned to a snapshot rather than the `gpt-realtime` alias, which follows
        // OpenAI's current snapshot and shifts turn-taking under a live deployment.
        let openai_realtime_model = e.or_default("OPENAI_REALTIME_MODEL", "gpt-realtime-2.1");
        // One resolver owns managed discovery and explicit/direct voice.
        let realtime_configuration = resolve_realtime_configuration(env)?;
        // `marin` is markedly better for conversation than the API's `alloy`.
        let openai_realtime_voice = e.or_default("OPENAI_REALTIME_VOICE", "marin");
        // Empty sends nothing and lets the API pick. An unrecognized level falls
        // back to `high` rather than failing the boot.
        let openai_realtime_reasoning_effort = match e.get("OPENAI_REALTIME_REASONING_EFFORT") {
            Some(raw) if raw.trim().is_empty() => None,
            Some(raw) => Some(
                RealtimeReasoningEffort::parse(&raw.trim().to_lowercase())
                    .unwrap_or(RealtimeReasoningEffort::High),
            ),
            None => Some(RealtimeReasoningEffort::High),
        };
        // Transcriber for dictation, and for reading a meeting back in the log.
        let openai_transcription_model =
            e.or_default("OPENAI_TRANSCRIPTION_MODEL", "gpt-live-transcribe");

        // Server-side noise reduction over meeting audio. Off by default: what
        // arrives is the call's mixed output, already cleaned once.
        let noise_reduction = match e
            .or("OPENAI_NOISE_REDUCTION")
            .unwrap_or("off")
            .trim()
            .to_lowercase()
            .as_str()
        {
            "near_field" => NoiseReduction::NearField,
            "far_field" => NoiseReduction::FarField,
            _ => NoiseReduction::Off,
        };

        // Whether what is said in a meeting reaches the runtime's own logs. Off by
        // default; an unrecognized value, empty included, is off.
        let meeting_transcript_logging = if e
            .or("MEETING_TRANSCRIPT_LOGGING")
            .unwrap_or("off")
            .trim()
            .to_lowercase()
            == "full"
        {
            MeetingTranscriptLogging::Full
        } else {
            MeetingTranscriptLogging::Off
        };

        let raw_thread_mode = e.or("THREAD_MODE").unwrap_or("").trim().to_lowercase();
        let parsed_thread_mode = ThreadMode::parse(&raw_thread_mode);
        let thread_mode = parsed_thread_mode.unwrap_or(ThreadMode::Multi);
        let invalid_thread_mode = (!raw_thread_mode.is_empty() && parsed_thread_mode.is_none())
            .then(|| raw_thread_mode.clone());

        // PRISM_PROGRAM_STATUS: `on` or `off` sets whether the runtime reports the
        // agent's state on its stdout with OSC 7501. Any other value reports when
        // stdout is a terminal, as in a sandbox.
        let program_status_reports = match e
            .get("PRISM_PROGRAM_STATUS")
            .unwrap_or("")
            .trim()
            .to_lowercase()
            .as_str()
        {
            "on" => true,
            "off" => false,
            _ => std::io::stdout().is_terminal(),
        };

        // Google account the meeting bot signs in as.
        let google_bot_email = e.get("GOOGLE_BOT_EMAIL").map(str::to_string);
        let google_bot_password = e.get("GOOGLE_BOT_PASSWORD").map(str::to_string);

        // Hard cap on one call. Junk or non-positive falls back to the default
        // rather than disabling the cap.
        let meeting_timeout_minutes =
            crate::support::js::parse_int(e.get("MEETING_TIMEOUT_MINUTES").unwrap_or(""))
                .filter(|v| *v > 0)
                .unwrap_or(60);

        // How long to wait in the waiting room for a host to click "Admit".
        let meeting_admission_timeout_ms =
            crate::support::js::parse_int(e.get("MEETING_ADMISSION_TIMEOUT_SECONDS").unwrap_or(""))
                .filter(|v| *v > 0)
                .unwrap_or(300)
                * 1000;

        // A zero or negative window would make the context indicator divide by
        // nothing, so both collapse to `None` (the bundled snapshot).
        let context_window_tokens =
            crate::support::js::parse_int(e.or("CONTEXT_WINDOW_TOKENS").unwrap_or(""))
                .filter(|v| *v > 0);

        // Opt-in: `None` unless the operator names a registry URL, so the runtime
        // makes no outbound call of its own by default.
        let models_dev_url = Some(e.get("MODELS_DEV_URL").unwrap_or("").trim())
            .filter(|u| !u.is_empty())
            .map(str::to_string);

        // 0 explicitly disables auto-compaction; 1–100 is a valid percent;
        // anything else falls back to the default.
        let raw_compaction_threshold =
            crate::support::js::parse_int(e.get("COMPACTION_THRESHOLD_PERCENT").unwrap_or(""));
        let compaction_threshold_percent = match raw_compaction_threshold {
            Some(0) => None,
            Some(v) if (1..=100).contains(&v) => Some(v),
            _ => Some(COMPACTION_THRESHOLD_PERCENT),
        };

        // TOOL_SEARCH: `auto` (the default) or `off`. Any other value runs `auto`.
        let raw_tool_search = e.get("TOOL_SEARCH").unwrap_or("").trim().to_lowercase();
        let tool_search = if raw_tool_search == "off" {
            ToolSearchMode::Off
        } else {
            ToolSearchMode::Auto
        };
        let invalid_tool_search = (!["", "auto", "off"].contains(&raw_tool_search.as_str()))
            .then(|| raw_tool_search.clone());

        // A percent of the model's window, 0 to 100; 0 defers whenever a tool can
        // be deferred. Anything else takes the default.
        let raw_tool_search_threshold = e
            .get("TOOL_SEARCH_THRESHOLD_PERCENT")
            .unwrap_or("")
            .trim()
            .to_string();
        let parsed_tool_search_threshold =
            crate::support::js::number_from(&raw_tool_search_threshold);
        let valid_tool_search_threshold = !raw_tool_search_threshold.is_empty()
            && parsed_tool_search_threshold
                .is_some_and(|v| v.is_finite() && (0.0..=100.0).contains(&v));
        let tool_search_threshold_percent = if valid_tool_search_threshold {
            parsed_tool_search_threshold.unwrap_or(TOOL_SEARCH_THRESHOLD_PERCENT)
        } else {
            TOOL_SEARCH_THRESHOLD_PERCENT
        };
        let invalid_tool_search_threshold = (!raw_tool_search_threshold.is_empty()
            && !valid_tool_search_threshold)
            .then(|| raw_tool_search_threshold.clone());

        // Tail size: 0 is legal; junk or negative falls back.
        let compaction_tail_messages =
            crate::support::js::parse_int(e.get("COMPACTION_TAIL_MESSAGES").unwrap_or(""))
                .filter(|v| *v >= 0)
                .unwrap_or(COMPACTION_TAIL_MESSAGES);

        // Idle compaction is on unless IDLE_COMPACTION is `off`.
        let idle_compaction = e
            .get("IDLE_COMPACTION")
            .map(|v| v.trim().to_lowercase())
            .as_deref()
            != Some("off");

        // The prompt-cache lifetime a chat turn asks for: `5m` unless
        // CHAT_CACHE_TTL is `1h`.
        let chat_cache_ttl = if e
            .get("CHAT_CACHE_TTL")
            .map(|v| v.trim().to_lowercase())
            .as_deref()
            == Some("1h")
        {
            CacheTtl::OneHour
        } else {
            CacheTtl::FiveMinutes
        };

        let raw_tool_risk_gate_mode = e
            .get("TOOL_RISK_GATE_MODE")
            .unwrap_or("off")
            .trim()
            .to_lowercase();
        let parsed_tool_risk_gate_mode = ToolRiskGateMode::parse(&raw_tool_risk_gate_mode);
        let tool_risk_gate_mode = parsed_tool_risk_gate_mode.unwrap_or(ToolRiskGateMode::Off);
        let invalid_tool_risk_gate_mode = parsed_tool_risk_gate_mode
            .is_none()
            .then(|| raw_tool_risk_gate_mode.clone());

        // Which agents are actually available is asked of the execution
        // environment at boot (`lib/coding_agents/availability`); until it has
        // been, no agent is offered.
        let raw_coding_agent = e.get("CODING_AGENT").map(|v| v.trim().to_lowercase());
        let parsed_coding_agent = raw_coding_agent.as_deref().and_then(CodingAgentName::parse);
        let is_valid_coding_agent =
            raw_coding_agent.as_deref().is_none_or(str::is_empty) || parsed_coding_agent.is_some();
        let configured_coding_agent = if is_valid_coding_agent {
            parsed_coding_agent
        } else {
            None
        };
        let coding_agent = configured_coding_agent.unwrap_or(CodingAgentName::ClaudeCode);
        if !is_valid_coding_agent {
            // No effective agent to name yet: detection picks it, and reports it on
            // its own startup line.
            warn(
                json!({ "configuredAgent": raw_coding_agent }),
                "[Startup] invalid CODING_AGENT; using the detected default",
            );
        }

        let process_env = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let claude_code_subscription =
            subscription_forced_in(&process_env, CodingAgentName::ClaudeCode);
        let codex_subscription = subscription_forced_in(&process_env, CodingAgentName::Codex);
        let claude_code_skip_permissions = e
            .get("CLAUDE_CODE_SKIP_PERMISSIONS")
            .is_some_and(|v| v.trim().to_lowercase() == "true");

        let mut model_override = |name: &str| -> Option<String> {
            let raw = e.get(name)?;
            let model = raw.trim();
            if !model.is_empty() {
                return Some(model.to_string());
            }
            warn(
                json!({ "variable": name }),
                "[Startup] empty coding agent model override; using the default",
            );
            None
        };
        let claude_overrides = TierSet {
            small: model_override("CLAUDE_CODE_MODEL_SMALL"),
            medium: model_override("CLAUDE_CODE_MODEL_MEDIUM"),
            large: model_override("CLAUDE_CODE_MODEL_LARGE"),
        };
        let codex_overrides = TierSet {
            small: model_override("CODEX_MODEL_SMALL"),
            medium: model_override("CODEX_MODEL_MEDIUM"),
            large: model_override("CODEX_MODEL_LARGE"),
        };
        // The Codex tier, by the same rule as `claude_code_tier`.
        let codex_tier =
            |override_model: &Option<String>, openai: &str, bedrock: &str| CodexTierModel {
                openai: match override_model {
                    Some(model) if !is_openai_bedrock_model_id(model) => model.clone(),
                    _ => openai.to_string(),
                },
                bedrock: override_model
                    .clone()
                    .unwrap_or_else(|| bedrock.to_string()),
            };
        let coding_agent_models = CodingAgentModels {
            // Keyed by the backend Claude Code itself runs on, which its own
            // credentials decide. On Bedrock the `haiku` and `sonnet` aliases
            // resolve to older releases, which cannot run Claude Code's auto
            // permission mode and so refuse every edit.
            claude_code: TierSet {
                small: claude_code_tier(
                    &claude_overrides.small,
                    "haiku",
                    "global.anthropic.claude-haiku-5-5",
                ),
                medium: claude_code_tier(
                    &claude_overrides.medium,
                    "sonnet",
                    "global.anthropic.claude-sonnet-5-5",
                ),
                large: claude_code_tier(&claude_overrides.large, "opus", "opus"),
            },
            // Reuse the repository's model choices: luna is the fast
            // classification model, sol is the main model, and terra is the Codex
            // adapter's existing Bedrock default.
            codex: TierSet {
                small: codex_tier(
                    &codex_overrides.small,
                    "gpt-5.6-luna",
                    "openai.gpt-5.6-luna",
                ),
                medium: codex_tier(
                    &codex_overrides.medium,
                    "gpt-5.6-terra",
                    "openai.gpt-5.6-terra",
                ),
                large: codex_tier(&codex_overrides.large, "gpt-5.6-sol", "openai.gpt-5.6-sol"),
            },
        };

        let agent_messages_token_id = e
            .get("AGENT_MESSAGES_TOKEN_ID")
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let agent_defaults =
            read_agent_model_defaults(&settings_path_for(e.get("PRISM_SETTINGS_PATH")));
        let chat_routing = if Self::origin_matches(&nexus_origin, chat_endpoint.as_deref()) {
            ChatRouting::Nexus
        } else {
            ChatRouting::Direct
        };
        let app_version = if crate::lib::environment::is_sea() {
            option_env!("PRISM_VERSION").unwrap_or("").to_string()
        } else {
            e.or("SERVICE_VERSION").unwrap_or("").to_string()
        };
        let goal_max_turns = match e.or("GOAL_MAX_TURNS") {
            Some(raw) => crate::support::js::parse_int(raw).unwrap_or(GOAL_MAX_TURNS),
            None => GOAL_MAX_TURNS,
        };
        let goal_default_token_budget = e
            .or("GOAL_DEFAULT_TOKEN_BUDGET")
            .and_then(crate::support::js::parse_int);
        let attachment_content_ttl_ms = hours_to_ms(resolve_ttl_hours(
            &e,
            "ATTACHMENT_TTL_HOURS",
            ATTACHMENT_CONTENT_TTL_HOURS,
        ));
        let tool_output_ttl_ms = hours_to_ms(resolve_ttl_hours(
            &e,
            "TOOL_OUTPUT_TTL_HOURS",
            TOOL_OUTPUT_TTL_HOURS,
        ));
        let heartbeat_interval_ms = resolve_heartbeat_interval_ms(&e, warn);

        Ok(Config {
            port,
            host,
            listens_on_loopback,
            allowed_origins,
            public_url,
            webhook_port,
            webhook_public_url,
            agent_messages_port,
            database_url: e.get_or("DATABASE_URL", "file:./agent.db"),
            bedrock_model_id,
            bedrock_classification_model_id,
            bedrock_embedding_model_id,
            aws_region,
            aws_access_key_id: e.get("AWS_ACCESS_KEY_ID").map(str::to_string),
            aws_secret_access_key: e.get("AWS_SECRET_ACCESS_KEY").map(str::to_string),
            aws_session_token: e.get("AWS_SESSION_TOKEN").map(str::to_string),
            llm_provider,
            invalid_llm_provider,
            embedding_provider,
            invalid_embedding_provider,
            azure_resource_name,
            azure_direct_endpoint,
            azure_chat_endpoint,
            azure_api_key: e.get("AZURE_API_KEY").map(str::to_string),
            azure_api_version: e.get("AZURE_API_VERSION").map(str::to_string),
            azure_model_id,
            azure_classification_model_id,
            azure_embedding_model_id,
            nexus_azure_base_url,
            nexus_azure_open_ai_base_url,
            bedrock_api_key,
            bedrock_mantle_direct_endpoint,
            bedrock_mantle_chat_endpoint,
            bedrock_mantle_model_id,
            bedrock_mantle_classification_model_id,
            bedrock_mantle_embedding_model_id,
            nexus_bedrock_mantle_base_url,
            openai_model_id,
            openai_classification_model_id,
            openai_embedding_model_id,
            openai_endpoint,
            nexus_openai_base_url,
            openrouter_model_id,
            openrouter_classification_model_id,
            openrouter_embedding_model_id,
            openrouter_endpoint,
            openrouter_api_key,
            nexus_openrouter_base_url,
            anthropic_api_key,
            anthropic_model_id,
            anthropic_classification_model_id,
            anthropic_base_url,
            litellm_model_id,
            litellm_classification_model_id,
            litellm_api_key,
            litellm_endpoint,
            nexus_litellm_base_url,
            agent_id: RwLock::new(e.get("AGENT_ID").map(str::to_string)),
            agent_messages_token_id,
            owner_user_id: RwLock::new(
                e.or_default("OWNER_USER_ID", "00000000-0000-0000-0000-000000000001"),
            ),
            agent_name: e.or_default("AGENT_NAME", "Prism"),
            team_name: e.or_default("TEAM_NAME", "Local"),
            agent_defaults,
            workspace_seed_dir: e.get("PRISM_WORKSPACE_SEED_DIR").map(str::to_string),
            nexus_api_url,
            slack_bot_token: e.get("SLACK_BOT_TOKEN").map(str::to_string),
            slack_expected_app_id: e.get("SLACK_EXPECTED_APP_ID").map(str::to_string),
            teams_app_id: e.get("TEAMS_APP_ID").map(str::to_string),
            teams_app_password: e.get("TEAMS_APP_PASSWORD").map(str::to_string),
            teams_app_tenant_id: e.get("TEAMS_APP_TENANT_ID").map(str::to_string),
            teams_port: parse_port(e.or("TEAMS_PORT").unwrap_or("3979"), "TEAMS_PORT")?,
            nexus_mcp_url: e.get("NEXUS_MCP_URL").map(str::to_string),
            langfuse_secret_key: e.get("LANGFUSE_SECRET_KEY").map(str::to_string),
            langfuse_public_key: e.get("LANGFUSE_PUBLIC_KEY").map(str::to_string),
            langfuse_base_url: e.or_default("LANGFUSE_BASE_URL", "http://localhost:3100"),
            nexus_llm_base_url,
            nexus_chat_base_url,
            chat_routing,
            chat_endpoint_source,
            chat_endpoint_for_log: endpoint_for_log(chat_endpoint.as_deref()),
            otel_endpoint: e.or_default("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
            otel_api_key: e.or_default("OTEL_EXPORTER_OTLP_API_KEY", ""),
            deployment_environment: e.or_default("DEPLOYMENT_ENVIRONMENT", "development"),
            product_name: e.or_default("PRODUCT_NAME", ""),
            service_version: e.or_default("SERVICE_VERSION", ""),
            app_version,
            disable_updater: ["1", "true"].contains(
                &e.or("DISABLE_UPDATER")
                    .unwrap_or("")
                    .trim()
                    .to_lowercase()
                    .as_str(),
            ),
            program_status_reports,
            thread_mode,
            invalid_thread_mode,
            goal_max_turns,
            goal_default_token_budget,
            attachment_content_ttl_ms,
            tool_output_ttl_ms,
            chat_model_id,
            classification_model_id,
            model_selection: ModelSelectionDefaults {
                mode: model_mode,
                tiers: auto_model_tiers,
            },
            embedding_model_id,
            tool_risk_gate_mode,
            invalid_tool_risk_gate_mode,
            coding_agent: RwLock::new(coding_agent),
            coding_agent_models,
            available_coding_agents: RwLock::new(Vec::new()),
            configured_coding_agent,
            claude_code_subscription,
            codex_subscription,
            claude_code_skip_permissions,
            context_window_tokens,
            models_dev_url,
            compaction_threshold_percent,
            tool_search,
            invalid_tool_search,
            tool_search_threshold_percent,
            invalid_tool_search_threshold,
            heartbeat_interval_ms,
            compaction_tail_messages,
            idle_compaction,
            chat_cache_ttl,
            openai_api_key,
            openai_realtime_model,
            openai_realtime_url: realtime_configuration.url,
            openai_realtime_api_key: realtime_configuration.api_key,
            realtime_source: realtime_configuration.source,
            realtime_provider: realtime_configuration.provider,
            realtime_unavailable_reason: realtime_configuration.unavailable_reason,
            openai_realtime_voice,
            openai_realtime_reasoning_effort,
            openai_transcription_model,
            noise_reduction,
            meeting_transcript_logging,
            google_bot_email,
            google_bot_password,
            meeting_timeout_minutes,
            meeting_admission_timeout_ms,
            nexus_origin,
        })
    }

    fn origin_matches(nexus_origin: &Option<String>, url: Option<&str>) -> bool {
        nexus_origin.is_some() && origin_of(url) == *nexus_origin
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// OpenRouter's own endpoint, spelled out because the SDK's default is
/// api.openai.com, which is not where a `vendor/model` id resolves.
pub const OPENROUTER_DIRECT_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// Reads an environment the way the TypeScript runtime read `process.env`.
struct Reader<'a>(&'a Env);

impl<'a> Reader<'a> {
    /// `process.env.NAME`: present, possibly empty.
    fn get(&self, name: &str) -> Option<&'a str> {
        self.0.get(name).map(String::as_str)
    }

    /// `process.env.NAME || …`: an empty value counts as unset.
    fn or(&self, name: &str) -> Option<&'a str> {
        self.get(name).filter(|v| !v.is_empty())
    }

    /// `process.env.NAME || fallback`.
    fn or_default(&self, name: &str, fallback: &str) -> String {
        self.or(name).unwrap_or(fallback).to_string()
    }

    /// `process.env.NAME ?? fallback`: an empty value is kept.
    fn get_or(&self, name: &str, fallback: &str) -> String {
        self.get(name).unwrap_or(fallback).to_string()
    }
}

/// A port from `parseInt`. A value that is not a port stops startup.
fn parse_port(text: &str, name: &str) -> anyhow::Result<u16> {
    crate::support::js::parse_int(text)
        .filter(|p| (0..=65535).contains(p))
        .map(|p| p as u16)
        .ok_or_else(|| anyhow::anyhow!("{name} must be a port number"))
}

fn trim_trailing_slashes(text: &str) -> &str {
    text.trim_end_matches('/')
}

/// `PRISM_ALLOWED_ORIGINS`: browser origins on other sites that may call the
/// runtime, in the syntax of `lib/origin_patterns`. An invalid entry stops
/// startup. The list gives those pages the whole runtime, so it is only for a
/// runtime behind an authenticating proxy. A loopback listen stops startup too:
/// that is the standalone install, which has no auth, and at startup a proxy
/// forwarding to it (the origin guard accepts its `X-Forwarded-Host`) looks the
/// same. A wider listen is accepted as stated, including a container published
/// on a loopback host port, so the proxy in front is the operator's to provide.
fn read_allowed_origins(
    e: &Reader<'_>,
    host: &str,
    listens_on_loopback: bool,
) -> anyhow::Result<Vec<OriginPattern>> {
    let patterns = parse_origin_patterns(e.get("PRISM_ALLOWED_ORIGINS").unwrap_or(""))
        .map_err(|err| anyhow::anyhow!("PRISM_ALLOWED_ORIGINS: {err}"))?;
    if !patterns.is_empty() && listens_on_loopback {
        anyhow::bail!(
            "PRISM_ALLOWED_ORIGINS is set while PRISM_HOST is the loopback address {host}. \
             The setting is only for a runtime behind an authenticating proxy. \
             Behind a proxy on this machine, set PRISM_HOST to a non-loopback address and \
             firewall the port; otherwise unset PRISM_ALLOWED_ORIGINS."
        );
    }
    Ok(patterns)
}

/// The name the deployment gives a port. Example:
/// `LENS_SANDBOX_INGRESS_PORTS=web=3003,metrics=9090` names port 3003 `web`.
fn ingress_port_name(e: &Reader<'_>, for_port: u16) -> Option<String> {
    let ports = e.get("LENS_SANDBOX_INGRESS_PORTS")?;
    ports
        .split(',')
        .map(|entry| entry.trim().split('=').collect::<Vec<_>>())
        .find_map(|parts| {
            let value = parts
                .get(1)
                .and_then(|v| crate::support::js::number_from(v));
            (value == Some(f64::from(for_port))).then(|| parts[0].to_string())
        })
}

/// The first public origin of a named port. Example:
/// `NEXUS_INGRESS_ORIGINS_WEB=https://prism.example.com,https://alias.example.com`.
fn ingress_origin(e: &Reader<'_>, port_name: &str) -> Option<String> {
    let name = format!(
        "NEXUS_INGRESS_ORIGINS_{}",
        port_name.to_uppercase().replace('-', "_")
    );
    e.get(&name)
        .and_then(|value| value.split(',').next())
        .map(|first| first.trim().to_string())
}

/// Ends a URL at `/v1` with no trailing slash; `None` for an unset or empty value.
fn with_v1(url: Option<&str>) -> Option<String> {
    let url = url.filter(|u| !u.is_empty())?;
    let trimmed = trim_trailing_slashes(url);
    Some(if trimmed.ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    })
}

/// Scheme, host and port of an http(s) URL; `None` for anything else, so a value
/// that is unset, unparseable or of another scheme never matches. Two opaque URLs
/// both take the origin `"null"`, which would compare equal.
fn origin_of(url: Option<&str>) -> Option<String> {
    let url = url.filter(|u| !u.is_empty())?;
    let parsed = Url::parse(url).ok()?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// Origin and path only. An endpoint may carry a credential in its userinfo or
/// its query string, and neither belongs in a log; a value that does not parse is
/// named rather than printed, for the same reason.
fn endpoint_for_log(url: Option<&str>) -> String {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return "vendor default".to_string();
    };
    match Url::parse(url) {
        Ok(parsed) => format!("{}{}", parsed.origin().ascii_serialization(), parsed.path()),
        Err(_) => "invalid".to_string(),
    }
}

/// One coding agent tier: an override that is a Bedrock ID serves Bedrock only,
/// because the vendor's API and subscription refuse it; the same agent can run
/// its tasks on either, so the other backend keeps its own default.
fn claude_code_tier(
    override_model: &Option<String>,
    default: &str,
    bedrock: &str,
) -> ClaudeCodeTierModel {
    ClaudeCodeTierModel {
        default: match override_model {
            Some(model) if !is_anthropic_model_id(model) => model.clone(),
            _ => default.to_string(),
        },
        bedrock: override_model
            .clone()
            .unwrap_or_else(|| bedrock.to_string()),
    }
}

/// `Number.parseFloat`: the longest numeric prefix after leading whitespace.
fn parse_float(text: &str) -> Option<f64> {
    static PREFIX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
            .expect("valid regex")
    });
    let text = text.trim_start();
    let found = PREFIX.find(text)?.as_str();
    match found.trim_start_matches(['+', '-']) {
        "Infinity" => Some(if found.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        }),
        _ => found.parse::<f64>().ok(),
    }
}

/// A retention in hours. Junk parses to nothing and a non-positive TTL would
/// expire everything on the next sweep, so both fall back to `default_hours`.
fn resolve_ttl_hours(e: &Reader<'_>, name: &str, default_hours: i64) -> f64 {
    parse_float(e.get(name).unwrap_or(""))
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(default_hours as f64)
}

fn hours_to_ms(hours: f64) -> i64 {
    (hours * 60.0 * 60.0 * 1000.0).round() as i64
}

/// Heartbeat interval of a new agent. An unset value takes the default
/// silently; a set value that is not an integer between the minimum and the
/// maximum warns and takes it too.
fn resolve_heartbeat_interval_ms(e: &Reader<'_>, warn: &mut dyn FnMut(Value, &str)) -> i64 {
    let raw = e.get("HEARTBEAT_INTERVAL_MS").unwrap_or("").trim();
    if raw.is_empty() {
        return DEFAULT_HEARTBEAT_INTERVAL_MS;
    }
    if let Some(parsed) = crate::support::js::number_from(raw)
        && parsed.fract() == 0.0
        && parsed >= MIN_HEARTBEAT_INTERVAL_MS as f64
        && parsed <= MAX_HEARTBEAT_INTERVAL_MS as f64
    {
        return parsed as i64;
    }
    warn(
        json!({ "configured": raw, "minimumMs": MIN_HEARTBEAT_INTERVAL_MS, "maximumMs": MAX_HEARTBEAT_INTERVAL_MS }),
        "[Startup] invalid HEARTBEAT_INTERVAL_MS; using the default",
    );
    DEFAULT_HEARTBEAT_INTERVAL_MS
}

#[cfg(test)]
mod tests;
