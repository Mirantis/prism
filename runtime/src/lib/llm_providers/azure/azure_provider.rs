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
//! `AZURE_FOUNDRY_BASE_URL`, else the Lens Agents Azure gateway chat route
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

use crate::ai::LanguageModel;
use crate::ai::providers::anthropic::{AnthropicProviderSettings, create_anthropic};
use crate::config::{CONFIG, is_gateway_endpoint};
use crate::lib::llm_providers::llm_provider::{
    ANTHROPIC_THINKING_OFF, CacheTtl, ClassificationSamplingParams, LlmProvider,
    anthropic_cache_point, provider_options,
};
use crate::log_info;

pub fn create_azure_provider(base_url: Option<&str>) -> LlmProvider {
    let gateway_serves_it = is_gateway_endpoint(base_url);
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating Azure provider (Claude via Microsoft Foundry)"
    );

    // Chat/classification — Anthropic Messages API. The SDK builds
    // `${baseURL}/messages`, so the base must end at `…/anthropic/v1` (direct) or
    // `…/llm/azure/anthropic/v1` (gateway).
    //
    // On the gateway the real Foundry key (`api-key` from its NEXUS_AZURE_TOKEN) is
    // injected on the outbound leg, so no local key is needed — but the SDKs insist
    // on one, so fall back to a decoy (the same pattern the Lens Agents sandbox uses
    // for its provisioned ANTHROPIC_API_KEY).
    let decoyable_key = CONFIG
        .azure_api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| gateway_serves_it.then(|| "nexus-managed".to_string()));
    let anthropic = Arc::new(create_anthropic(AnthropicProviderSettings {
        api_key: decoyable_key,
        base_url: base_url.map(str::to_string),
        ..Default::default()
    }));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                Ok(anthropic.language_model(model_id))
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
/// requests. Through the Lens Agents gateway it needs none, since the gateway holds
/// the Foundry key. Direct mode needs an api-key and a Foundry endpoint.
pub fn missing_azure_settings() -> Vec<String> {
    if CONFIG.nexus_azure_base_url.is_some() {
        return Vec::new();
    }
    let mut missing = Vec::new();
    if CONFIG.azure_api_key.as_deref().unwrap_or("").is_empty() {
        missing.push("AZURE_API_KEY".to_string());
    }
    if CONFIG
        .azure_direct_endpoint
        .as_deref()
        .unwrap_or("")
        .is_empty()
    {
        missing.push("AZURE_RESOURCE_NAME (or AZURE_FOUNDRY_BASE_URL)".to_string());
    }
    missing
}
