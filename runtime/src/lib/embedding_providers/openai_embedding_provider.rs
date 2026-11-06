//! OpenAI embeddings (a `text-embedding-3` model) — the `openai` embedding
//! provider. `OPENAI_BASE_URL` is one variable for the whole OpenAI surface, so
//! embeddings follow it wherever chat goes; `CONFIG.openai_endpoint` resolves it
//! against the gateway mount and this factory takes the result.

use std::sync::Arc;

use serde_json::json;

use crate::ai::EmbeddingModel;
use crate::ai::providers::openai::{OpenAIProviderSettings, create_openai};
use crate::config::{CONFIG, is_gateway_endpoint};
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_open_ai_embedding_provider(base_url: Option<&str>) -> EmbeddingProvider {
    // On the gateway the real key is injected on the outbound leg, so no local key
    // is needed — but the SDK insists on one, so fall back to a decoy (the same
    // pattern as the chat factories).
    let openai = Arc::new(create_openai(OpenAIProviderSettings {
        api_key: CONFIG
            .openai_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| is_gateway_endpoint(base_url).then(|| "managed".to_string())),
        // None → the SDK's own default, https://api.openai.com/v1.
        base_url: base_url.map(str::to_string),
        ..Default::default()
    }));
    EmbeddingProvider {
        model: Arc::new(move |model_id: &str| -> Arc<dyn EmbeddingModel> {
            openai.embedding(model_id)
        }),
        // text-embedding-3 truncates to the target under the `openai` key.
        provider_options: provider_options(
            json!({ "openai": { "dimensions": EMBEDDING_DIMENSIONS } }),
        ),
    }
}
