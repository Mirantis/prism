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

use crate::config::{CONFIG, Config, LlmProviderName};
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

/// The vendor factory a configuration selects, with the endpoint it is handed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderRoute<'a> {
    Bedrock(Option<&'a str>),
    Azure(Option<&'a str>),
    BedrockMantle(&'a str),
    Openai(Option<&'a str>),
    Openrouter(&'a str),
    Anthropic,
    Litellm(Option<&'a str>),
}

fn route(config: &Config) -> ProviderRoute<'_> {
    match config.llm_provider {
        LlmProviderName::Azure => ProviderRoute::Azure(config.azure_chat_endpoint.as_deref()),
        LlmProviderName::BedrockMantle => {
            ProviderRoute::BedrockMantle(&config.bedrock_mantle_chat_endpoint)
        }
        LlmProviderName::Openai => ProviderRoute::Openai(config.openai_endpoint.as_deref()),
        LlmProviderName::Openrouter => ProviderRoute::Openrouter(&config.openrouter_endpoint),
        LlmProviderName::Anthropic => ProviderRoute::Anthropic,
        LlmProviderName::Litellm => ProviderRoute::Litellm(config.litellm_endpoint.as_deref()),
        LlmProviderName::Bedrock => ProviderRoute::Bedrock(config.nexus_llm_base_url.as_deref()),
    }
}

pub fn create_provider() -> LlmProvider {
    match route(&CONFIG) {
        ProviderRoute::Azure(endpoint) => create_azure_provider(endpoint),
        ProviderRoute::BedrockMantle(endpoint) => create_bedrock_mantle_provider(endpoint),
        ProviderRoute::Openai(endpoint) => create_open_ai_provider(endpoint),
        ProviderRoute::Openrouter(endpoint) => create_open_router_provider(endpoint),
        ProviderRoute::Anthropic => create_anthropic_provider(),
        ProviderRoute::Litellm(endpoint) => create_lite_llm_provider(endpoint),
        ProviderRoute::Bedrock(endpoint) => create_bedrock_provider(endpoint),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::test_config;

    const GATEWAY: (&str, &str) = ("NEXUS_API_URL", "https://gateway.example.com");
    const BEDROCK_MOUNT: &str = "https://gateway.example.com/llm/bedrock/us-east-1";
    const MANTLE_MOUNT: &str =
        "https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1";
    const OPENROUTER_MOUNT: &str = "https://gateway.example.com/llm/openrouter/openai/v1";
    const LITELLM_MOUNT: &str = "https://gateway.example.com/llm/litellm/anthropic/v1";

    #[test]
    fn bedrock_without_a_gateway_goes_direct() {
        let config = test_config(&[]);
        assert_eq!(route(&config), ProviderRoute::Bedrock(None));
    }

    #[test]
    fn bedrock_with_a_gateway_takes_the_gateway_base_url() {
        let config = test_config(&[GATEWAY]);
        assert_eq!(route(&config), ProviderRoute::Bedrock(Some(BEDROCK_MOUNT)));
    }

    #[test]
    fn azure_takes_the_resolved_azure_chat_endpoint() {
        let config = test_config(&[
            ("LLM_PROVIDER", "azure"),
            ("AZURE_RESOURCE_NAME", "my-resource"),
        ]);
        assert_eq!(
            route(&config),
            ProviderRoute::Azure(Some(
                "https://my-resource.services.ai.azure.com/anthropic/v1"
            ))
        );
    }

    #[test]
    fn azure_foundry_base_url_reaches_the_factory_with_the_mount_set() {
        let config = test_config(&[
            ("LLM_PROVIDER", "azure"),
            GATEWAY,
            (
                "AZURE_FOUNDRY_BASE_URL",
                "https://foundry.example/anthropic/v1",
            ),
        ]);
        assert_eq!(
            route(&config),
            ProviderRoute::Azure(Some("https://foundry.example/anthropic/v1"))
        );
    }

    #[test]
    fn bedrock_mantle_takes_the_resolved_mantle_endpoint() {
        let config = test_config(&[("LLM_PROVIDER", "bedrock-mantle")]);
        assert_eq!(
            route(&config),
            ProviderRoute::BedrockMantle("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1")
        );
        let config = test_config(&[("LLM_PROVIDER", "bedrock-mantle"), GATEWAY]);
        assert_eq!(route(&config), ProviderRoute::BedrockMantle(MANTLE_MOUNT));
    }

    #[test]
    fn bedrock_mantle_base_url_reaches_the_factory_with_the_mount_set() {
        let config = test_config(&[
            ("LLM_PROVIDER", "bedrock-mantle"),
            GATEWAY,
            (
                "BEDROCK_MANTLE_BASE_URL",
                "https://mantle.internal/anthropic/v1",
            ),
        ]);
        assert_eq!(
            route(&config),
            ProviderRoute::BedrockMantle("https://mantle.internal/anthropic/v1")
        );
    }

    #[test]
    fn openai_with_nothing_configured_takes_the_sdk_default() {
        let config = test_config(&[("LLM_PROVIDER", "openai")]);
        assert_eq!(route(&config), ProviderRoute::Openai(None));
    }

    #[test]
    fn openai_base_url_reaches_the_factory_with_the_mount_set() {
        let override_url = "https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1";
        let config = test_config(&[
            ("LLM_PROVIDER", "openai"),
            GATEWAY,
            ("OPENAI_BASE_URL", override_url),
        ]);
        assert_eq!(route(&config), ProviderRoute::Openai(Some(override_url)));
    }

    #[test]
    fn openrouter_takes_the_openrouter_endpoint_never_the_openai_one() {
        // Both speak the same OpenAI-shaped protocol, so the endpoint is the only
        // thing that distinguishes them, and the mount is what the managed-inference
        // gate checks.
        let config = test_config(&[("LLM_PROVIDER", "openrouter"), GATEWAY]);
        assert_eq!(route(&config), ProviderRoute::Openrouter(OPENROUTER_MOUNT));
    }

    #[test]
    fn openrouter_base_url_reaches_the_factory_with_the_mount_set() {
        let config = test_config(&[
            ("LLM_PROVIDER", "openrouter"),
            GATEWAY,
            ("OPENROUTER_BASE_URL", "https://proxy.example/openrouter/v1"),
        ]);
        assert_eq!(
            route(&config),
            ProviderRoute::Openrouter("https://proxy.example/openrouter/v1")
        );
    }

    #[test]
    fn anthropic_stays_direct_even_with_every_gateway_mount_set() {
        assert_eq!(
            route(&test_config(&[("LLM_PROVIDER", "anthropic")])),
            ProviderRoute::Anthropic
        );
        assert_eq!(
            route(&test_config(&[("LLM_PROVIDER", "anthropic"), GATEWAY])),
            ProviderRoute::Anthropic
        );
    }

    #[test]
    fn litellm_takes_the_resolved_lite_llm_endpoint_never_another_backends_mount() {
        // The gateway meters LiteLLM by the cost LiteLLM reports, on its own mount.
        let config = test_config(&[("LLM_PROVIDER", "litellm"), GATEWAY]);
        assert_eq!(route(&config), ProviderRoute::Litellm(Some(LITELLM_MOUNT)));
    }

    #[test]
    fn bedrock_needs_no_settings_since_the_aws_sdk_finds_its_credentials_at_request_time() {
        // The unit test configuration runs bedrock.
        assert!(missing_provider_settings().is_empty());
    }
}
