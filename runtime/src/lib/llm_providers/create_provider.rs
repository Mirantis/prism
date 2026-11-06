//! Unified LLM provider factory.
//!
//! Two orthogonal choices:
//!  - Vendor: `CONFIG.llm_provider` (`bedrock` default, `azure`, `bedrock-mantle`,
//!    `openai`, `openrouter`, `anthropic`, or `litellm`).
//!  - Endpoint: each vendor's factory takes the endpoint config resolved for it —
//!    the explicit `*_BASE_URL` override, else the Lens Agents gateway mount, else
//!    the vendor's own host. The factory receives one endpoint and chooses nothing,
//!    so the precedence is written once.
//!
//! Every underlying factory returns the same shape — `LlmProvider`, a dispatcher
//! from model id to `LanguageModel` — so callers don't have to care which vendor or
//! route is in use.
//!
//! **bedrock-mantle** is AWS's second Bedrock inference endpoint
//! (`bedrock-mantle.{region}.api.aws`; a Lens Agents managed-inference backend), not
//! a variant of the `bedrock` branch: it serves neither InvokeModel nor Converse, so
//! it needs its own factory. Of its three surfaces — OpenAI Responses, OpenAI Chat
//! Completions, and Anthropic Messages — only `/anthropic/v1` is implemented, which
//! makes the provider a structural copy of the Azure one (the Anthropic SDK at a
//! custom base URL) rather than of the native Bedrock one. One consequence worth
//! knowing at this seam: model IDs must be **bare** (mantle has no cross-region
//! inference profiles, so the mantle dispatcher strips `us.`/`eu.`/… prefixes).
//!
//! **openai** is the one vendor serving OpenAI models rather than Claude, on a
//! single surface: chat and classification ride one base URL — the Lens Agents
//! `…/llm/openai/v1` mount or api.openai.com direct. Realtime voice resolves its
//! managed or direct endpoint separately in config. **openrouter** rides the same
//! OpenAI-compatible surface at openrouter.ai (or the `…/llm/openrouter/openai/v1`
//! mount) with `vendor/model` ids; see `openrouter/openrouter_provider.rs`.
//!
//! **anthropic** is the first-party Anthropic API, and the one vendor that is
//! **direct-only**: no gateway mount serves api.anthropic.com, so its factory takes
//! no base URL and `ANTHROPIC_API_KEY` is always required. Model IDs are bare
//! first-party IDs (`claude-opus-5`).
//!
//! **litellm** is an operator's own LiteLLM proxy, spoken to in the Anthropic
//! Messages format at `LITELLM_BASE_URL` or the `…/llm/litellm/anthropic/v1` mount.
//! Model IDs are the operator's aliases.

use crate::config::{CONFIG, LlmProviderName};
use crate::lib::llm_providers::anthropic::anthropic_provider::{
    create_anthropic_provider, missing_anthropic_settings,
};
use crate::lib::llm_providers::azure::azure_provider::{
    create_azure_provider, missing_azure_settings,
};
use crate::lib::llm_providers::bedrock::bedrock_provider::create_bedrock_provider;
use crate::lib::llm_providers::bedrock_mantle::bedrock_mantle_provider::{
    create_bedrock_mantle_provider, missing_bedrock_mantle_settings,
};
use crate::lib::llm_providers::litellm::litellm_provider::{
    create_lite_llm_provider, missing_lite_llm_settings,
};
use crate::lib::llm_providers::llm_provider::LlmProvider;
use crate::lib::llm_providers::openai::openai_provider::{
    create_open_ai_provider, missing_open_ai_settings,
};
use crate::lib::llm_providers::openrouter::openrouter_provider::{
    create_open_router_provider, missing_open_router_settings,
};

pub fn create_provider() -> LlmProvider {
    match CONFIG.llm_provider {
        LlmProviderName::Azure => create_azure_provider(CONFIG.azure_chat_endpoint.as_deref()),
        LlmProviderName::BedrockMantle => {
            create_bedrock_mantle_provider(&CONFIG.bedrock_mantle_chat_endpoint)
        }
        LlmProviderName::Openai => create_open_ai_provider(CONFIG.openai_endpoint.as_deref()),
        LlmProviderName::Openrouter => create_open_router_provider(&CONFIG.openrouter_endpoint),
        LlmProviderName::Anthropic => create_anthropic_provider(),
        LlmProviderName::Litellm => create_lite_llm_provider(CONFIG.litellm_endpoint.as_deref()),
        LlmProviderName::Bedrock => create_bedrock_provider(CONFIG.nexus_llm_base_url.as_deref()),
    }
}

/// The settings the selected provider still needs, by variable name; empty when it
/// can serve requests. Every model id has a default, so what can be missing is a
/// key or an endpoint.
pub fn missing_provider_settings() -> Vec<String> {
    match CONFIG.llm_provider {
        LlmProviderName::Azure => missing_azure_settings(),
        LlmProviderName::BedrockMantle => missing_bedrock_mantle_settings(),
        LlmProviderName::Openai => missing_open_ai_settings(),
        LlmProviderName::Openrouter => missing_open_router_settings(),
        LlmProviderName::Anthropic => missing_anthropic_settings(),
        LlmProviderName::Litellm => missing_lite_llm_settings(),
        // Bedrock finds its credentials through the AWS SDK's own chain (the task
        // role in ECS) when a request is made.
        LlmProviderName::Bedrock => Vec::new(),
    }
}
