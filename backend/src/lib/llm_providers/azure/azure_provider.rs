//! Azure provider — Claude via Microsoft Foundry.
//!
//! Azure serves Claude through the **Anthropic Messages API** on Microsoft Foundry
//! (`https://{resource}.services.ai.azure.com/anthropic/v1/messages`), NOT through
//! an OpenAI-compatible endpoint: the Anthropic SDK pointed at the Foundry
//! Anthropic endpoint. Model IDs are Foundry *deployment names* (which default to
//! Claude model IDs, e.g. `claude-opus-5`). `AZURE_FOUNDRY_BASE_URL` is the escape
//! hatch when an operator splits the resource's hosts.
//!
//! Routing: the `base_url` argument is the resolved chat endpoint —
//! `AZURE_FOUNDRY_BASE_URL`, else the Mirantis Agent Platform Azure gateway chat route
//! (`…/llm/azure/anthropic/v1`, mirroring Bedrock's `…/llm/bedrock/{region}`), else
//! the Foundry resource. `CONFIG.azure_chat_endpoint` decides between them.
//!
//! Auth: the key is sent as the `x-api-key` header (Foundry accepts both `api-key`
//! and `x-api-key`); `anthropic-version: 2023-06-01` is added by the SDK. The key
//! may be a `__nexus_cred:<uuid>__` sentinel that the MITM proxy rewrites on the
//! wire — transparent here, like the Bedrock bearer token.
//!
//! Feature caveat: Foundry deployments hosted on Azure reject structured outputs,
//! server-side tools, the MCP connector, and the Files API (400 by design).
//! `invoke.rs` only uses client-side tools, which are fully supported.

use std::sync::Arc;

use serde_json::json;

use crate::ai::providers::anthropic::{AnthropicProviderSettings, create_anthropic};
use crate::ai::{LanguageModel, with_llm_cache};
use crate::config::{CONFIG, Config};
use crate::lib::llm_providers::llm_provider::{
    ANTHROPIC_THINKING_OFF, CacheTtl, ClassificationSamplingParams, LlmProvider,
    anthropic_cache_point, provider_options,
};
use crate::log_info;

/// The settings the Anthropic SDK is created with for `base_url`.
fn azure_settings(config: &Config, base_url: Option<&str>) -> AnthropicProviderSettings {
    // On the gateway the real Foundry key (`api-key` from its NEXUS_AZURE_TOKEN) is
    // injected on the outbound leg, so no local key is needed — but the SDKs insist
    // on one, so fall back to a decoy (the same pattern the Mirantis Agent Platform sandbox uses
    // for its provisioned ANTHROPIC_API_KEY).
    let decoyable_key = config
        .azure_api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| {
            config
                .is_gateway_endpoint(base_url)
                .then(|| "nexus-managed".to_string())
        });
    AnthropicProviderSettings {
        api_key: decoyable_key,
        base_url: base_url.map(str::to_string),
        ..Default::default()
    }
}

pub fn create_azure_provider(base_url: Option<&str>) -> LlmProvider {
    create_azure_provider_for(&CONFIG, base_url)
}

fn create_azure_provider_for(config: &Config, base_url: Option<&str>) -> LlmProvider {
    let gateway_serves_it = config.is_gateway_endpoint(base_url);
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating Azure provider (Claude via Microsoft Foundry)"
    );

    // Chat/classification — Anthropic Messages API. The SDK builds
    // `${baseURL}/messages`, so the base must end at `…/anthropic/v1` (direct) or
    // `…/llm/azure/anthropic/v1` (gateway).
    let anthropic = Arc::new(create_anthropic(azure_settings(config, base_url)));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                Ok(with_llm_cache(anthropic.language_model(model_id)))
            },
        ),
        Arc::new(|_model_id: &str, ttl: Option<CacheTtl>| anthropic_cache_point(ttl)),
    );
    // Foundry-hosted deployments reject structured outputs (see the feature caveat
    // above), so ask the SDK for the tool-based JSON path rather than Anthropic's
    // native `output_config.format`.
    provider.structured_output_options = Some(provider_options(
        json!({ "anthropic": { "structuredOutputMode": "jsonTool" } }),
    ));
    // The default classification model, Haiku 5.5, rejects an explicit temperature
    // and can think unasked.
    provider.classification_provider_options = Some(ANTHROPIC_THINKING_OFF.clone());
    provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
    provider
}

/// The settings Azure still needs, by variable name; empty when it can serve
/// requests. Through the Mirantis Agent Platform gateway it needs none, since the gateway holds
/// the Foundry key. Direct mode needs an api-key and a Foundry endpoint.
pub fn missing_azure_settings() -> Vec<String> {
    missing_azure_settings_for(&CONFIG)
}

fn missing_azure_settings_for(config: &Config) -> Vec<String> {
    if config
        .nexus_azure_base_url
        .as_deref()
        .is_some_and(|url| !url.is_empty())
    {
        return Vec::new();
    }
    let mut missing = Vec::new();
    if config.azure_api_key.as_deref().unwrap_or("").is_empty() {
        missing.push("AZURE_API_KEY".to_string());
    }
    if config
        .azure_direct_endpoint
        .as_deref()
        .unwrap_or("")
        .is_empty()
    {
        missing.push("AZURE_RESOURCE_NAME (or AZURE_FOUNDRY_BASE_URL)".to_string());
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_config;
    use crate::lib::llm_providers::llm_provider::provider_options_json;

    const FOUNDRY: &str = "https://my-resource.services.ai.azure.com/anthropic/v1";
    const GATEWAY: (&str, &str) = ("NEXUS_API_URL", "https://gateway.example.com");
    const KEY: (&str, &str) = ("AZURE_API_KEY", "azure-key");
    const RESOURCE: (&str, &str) = ("AZURE_RESOURCE_NAME", "my-resource");

    #[test]
    fn sends_the_gates_no_temperature_which_haiku_5_5_rejects() {
        let provider = create_azure_provider_for(&test_config(&[KEY, RESOURCE]), Some(FOUNDRY));
        assert_eq!(
            serde_json::to_value(provider.classification_sampling_params.unwrap()).unwrap(),
            json!({})
        );
    }

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given() {
        let settings = azure_settings(&test_config(&[KEY, RESOURCE]), Some(FOUNDRY));
        assert_eq!(settings.api_key.as_deref(), Some("azure-key"));
        assert_eq!(settings.base_url.as_deref(), Some(FOUNDRY));
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_falls_back_to_a_decoy() {
        let config = test_config(&[GATEWAY]);
        let settings = azure_settings(
            &config,
            Some("https://gateway.example.com/llm/azure/anthropic/v1"),
        );
        assert_eq!(settings.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_override_on_the_gateway_host_also_gets_the_decoy() {
        let config = test_config(&[GATEWAY]);
        let settings = azure_settings(
            &config,
            Some("https://gateway.example.com/projects/p/llm/azure/anthropic/v1"),
        );
        assert_eq!(settings.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_endpoint_off_the_gateway_host_without_a_key_sends_no_decoy() {
        // A decoy would promise a credential injection that nothing performs.
        let settings = azure_settings(&test_config(&[GATEWAY]), Some(FOUNDRY));
        assert_eq!(settings.api_key, None);
    }

    #[test]
    fn chat_model_ids_dispatch_through_the_anthropic_provider() {
        let provider = create_azure_provider_for(&test_config(&[KEY]), Some(FOUNDRY));
        assert_eq!(
            provider.model("claude-opus-4-8").unwrap().model_id(),
            "claude-opus-4-8"
        );
    }

    #[test]
    fn asks_for_the_tool_based_json_path_since_foundry_rejects_native_structured_output() {
        let provider = create_azure_provider_for(&test_config(&[KEY]), Some(FOUNDRY));
        assert_eq!(
            provider_options_json(provider.structured_output_options.as_ref().unwrap()),
            json!({ "anthropic": { "structuredOutputMode": "jsonTool" } })
        );
    }

    #[test]
    fn missing_settings_are_none_with_a_key_and_a_foundry_endpoint() {
        assert!(missing_azure_settings_for(&test_config(&[KEY, RESOURCE])).is_empty());
    }

    #[test]
    fn missing_settings_are_none_on_the_gateway_without_a_key_or_resource() {
        assert!(missing_azure_settings_for(&test_config(&[GATEWAY])).is_empty());
    }

    #[test]
    fn missing_settings_name_the_endpoint_without_a_foundry_url_or_the_gateway() {
        assert_eq!(
            missing_azure_settings_for(&test_config(&[KEY])),
            ["AZURE_RESOURCE_NAME (or AZURE_FOUNDRY_BASE_URL)"]
        );
    }

    #[test]
    fn missing_settings_name_the_api_key_off_the_gateway() {
        assert_eq!(
            missing_azure_settings_for(&test_config(&[RESOURCE])),
            ["AZURE_API_KEY"]
        );
    }
}
