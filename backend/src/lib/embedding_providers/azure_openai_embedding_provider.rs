//! Azure OpenAI embeddings (a `text-embedding-3` deployment) — the `azure-openai`
//! embedding provider. An AI Services/Foundry resource serving Claude chat on its
//! Anthropic surface serves embeddings from its OpenAI surface with the same
//! resource-level key; the deployment must exist on the resource, else memory
//! embedding fails open (the embedding service catches and returns null).
//!
//! `base_url` selects routing: set → the Nexus gateway's `…/llm/azure/openai/v1`
//! mount (the SDK treats a non-*.openai.azure.com base as a custom gateway and
//! appends `/embeddings` bare, landing on the resource's `/openai/v1/embeddings`);
//! unset → the endpoint derived from the resource name.

use std::sync::Arc;

use serde_json::json;

use crate::ai::EmbeddingModel;
use crate::ai::providers::azure::{AzureOpenAIProviderSettings, create_azure};
use crate::config::{CONFIG, Config};
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_azure_open_ai_embedding_provider(base_url: Option<&str>) -> EmbeddingProvider {
    let azure = Arc::new(create_azure(azure_settings(&CONFIG, base_url)));
    EmbeddingProvider {
        model: Arc::new(move |model_id: &str| -> Arc<dyn EmbeddingModel> {
            azure.embedding(model_id)
        }),
        // text-embedding-3 truncates to the target under the `openai` key.
        provider_options: provider_options(
            json!({ "openai": { "dimensions": EMBEDDING_DIMENSIONS } }),
        ),
    }
}

/// The SDK settings for `base_url`.
fn azure_settings(config: &Config, base_url: Option<&str>) -> AzureOpenAIProviderSettings {
    // Through Nexus the gateway injects the real key on the outbound leg, so no
    // local key is needed — but the SDK insists on one, so fall back to a decoy (the
    // same pattern as the chat factories).
    match base_url {
        Some(url) => AzureOpenAIProviderSettings {
            api_key: Some(
                config
                    .azure_api_key
                    .clone()
                    .filter(|key| !key.is_empty())
                    .unwrap_or_else(|| "managed".to_string()),
            ),
            base_url: Some(url.to_string()),
            ..Default::default()
        },
        None => AzureOpenAIProviderSettings {
            api_key: config.azure_api_key.clone(),
            resource_name: config.azure_resource_name.clone(),
            // None → SDK default
            api_version: config
                .azure_api_version
                .clone()
                .filter(|version| !version.is_empty()),
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::provider_options_json;

    fn config(pairs: &[(&str, &str)]) -> Config {
        let env = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::load(&env, &mut |_, _| {}).unwrap()
    }

    #[test]
    fn direct_routing_derives_the_endpoint_from_the_resource_name() {
        let c = config(&[
            ("AZURE_API_KEY", "azure-key"),
            ("AZURE_RESOURCE_NAME", "my-resource"),
        ]);
        let s = azure_settings(&c, None);
        assert_eq!(s.api_key.as_deref(), Some("azure-key"));
        assert_eq!(s.resource_name.as_deref(), Some("my-resource"));
        assert_eq!(s.base_url, None);
        assert_eq!(s.api_version, None);
    }

    #[test]
    fn forwards_the_api_version_when_set() {
        let c = config(&[("AZURE_API_VERSION", "2024-10-21")]);
        assert_eq!(
            azure_settings(&c, None).api_version.as_deref(),
            Some("2024-10-21")
        );
    }

    #[test]
    fn nexus_routing_rides_the_gateway_openai_mount() {
        let mount = "https://nexus.example/llm/azure/openai/v1";
        let s = azure_settings(&config(&[]), Some(mount));
        assert_eq!(s.api_key.as_deref(), Some("managed"));
        assert_eq!(s.base_url.as_deref(), Some(mount));
        assert_eq!(s.resource_name, None);

        let s = azure_settings(&config(&[("AZURE_API_KEY", "azure-key")]), Some(mount));
        assert_eq!(s.api_key.as_deref(), Some("azure-key"));
    }

    #[test]
    fn declares_the_dimensions_fragment_under_the_openai_key() {
        assert_eq!(
            provider_options_json(&create_azure_open_ai_embedding_provider(None).provider_options),
            json!({ "openai": { "dimensions": 1024 } })
        );
    }
}
