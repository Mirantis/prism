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
use crate::config::CONFIG;
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_azure_open_ai_embedding_provider(base_url: Option<&str>) -> EmbeddingProvider {
    // Through Nexus the gateway injects the real key on the outbound leg, so no
    // local key is needed — but the SDK insists on one, so fall back to a decoy (the
    // same pattern as the chat factories).
    let settings = match base_url {
        Some(url) => AzureOpenAIProviderSettings {
            api_key: Some(
                CONFIG
                    .azure_api_key
                    .clone()
                    .filter(|key| !key.is_empty())
                    .unwrap_or_else(|| "managed".to_string()),
            ),
            base_url: Some(url.to_string()),
            ..Default::default()
        },
        None => AzureOpenAIProviderSettings {
            api_key: CONFIG.azure_api_key.clone(),
            resource_name: CONFIG.azure_resource_name.clone(),
            // None → SDK default
            api_version: CONFIG
                .azure_api_version
                .clone()
                .filter(|version| !version.is_empty()),
            ..Default::default()
        },
    };
    let azure = Arc::new(create_azure(settings));
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
