//! OpenRouter embeddings — the `openrouter` embedding provider. openrouter.ai
//! serves `/embeddings` on its OpenAI-compatible surface, so this is the OpenAI SDK
//! pointed at OpenRouter's endpoint with the OpenRouter key. No default model: the
//! vendors OpenRouter routes differ in native dimensionality while the memory index
//! is fixed, so `OPENROUTER_EMBEDDING_MODEL_ID` stays empty (embeddings off) until
//! the operator names one — `openai/text-embedding-3-small` truncates to 1024 and
//! works.
//!
//! `base_url` is the resolved endpoint: `OPENROUTER_BASE_URL`, else the gateway's
//! `…/llm/openrouter/openai/v1` mount, else openrouter.ai. That variable is one
//! endpoint for the whole surface, so embeddings follow it wherever chat goes.

use std::sync::Arc;

use serde_json::json;

use crate::ai::EmbeddingModel;
use crate::ai::providers::openai::{OpenAIProviderSettings, create_openai};
use crate::config::{CONFIG, is_gateway_endpoint};
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_open_router_embedding_provider(base_url: &str) -> EmbeddingProvider {
    // On the gateway the real key is injected on the outbound leg, so no local key
    // is needed — but the SDK insists on one, so fall back to a decoy (the same
    // pattern as the chat factories).
    let openai = Arc::new(create_openai(OpenAIProviderSettings {
        api_key: CONFIG
            .openrouter_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| is_gateway_endpoint(Some(base_url)).then(|| "managed".to_string())),
        base_url: Some(base_url.to_string()),
        ..Default::default()
    }));
    EmbeddingProvider {
        model: Arc::new(move |model_id: &str| -> Arc<dyn EmbeddingModel> {
            openai.embedding(model_id)
        }),
        // OpenRouter rides the OpenAI SDK, so the truncation target goes under the
        // `openai` key — a fragment addressed to another SDK is silently ignored and
        // the model returns its native dimensionality.
        provider_options: provider_options(
            json!({ "openai": { "dimensions": EMBEDDING_DIMENSIONS } }),
        ),
    }
}
