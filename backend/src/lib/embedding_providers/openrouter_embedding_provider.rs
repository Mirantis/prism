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
use crate::config::{CONFIG, Config};
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::llm_provider::provider_options;
use crate::lib::llm_providers::openrouter::openrouter_provider::open_router_attribution_headers;

pub fn create_open_router_embedding_provider(base_url: &str) -> EmbeddingProvider {
    let openai = Arc::new(create_openai(openrouter_settings(&CONFIG, base_url)));
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

/// The SDK settings for `base_url`.
fn openrouter_settings(config: &Config, base_url: &str) -> OpenAIProviderSettings {
    // On the gateway the real key is injected on the outbound leg, so no local key
    // is needed — but the SDK insists on one, so fall back to a decoy (the same
    // pattern as the chat factories).
    OpenAIProviderSettings {
        api_key: config
            .openrouter_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| {
                config
                    .is_gateway_endpoint(Some(base_url))
                    .then(|| "managed".to_string())
            }),
        base_url: Some(base_url.to_string()),
        headers: Some(open_router_attribution_headers(config)),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::gateway_test_config;
    use crate::lib::llm_providers::llm_provider::provider_options_json;

    const OPENROUTER_DIRECT: &str = "https://openrouter.ai/api/v1";

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given() {
        let s = openrouter_settings(
            &gateway_test_config(&[("OPENROUTER_API_KEY", "sk-or-test")]),
            OPENROUTER_DIRECT,
        );
        assert_eq!(s.api_key.as_deref(), Some("sk-or-test"));
        assert_eq!(s.base_url.as_deref(), Some(OPENROUTER_DIRECT));
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_falls_back_to_a_decoy() {
        let mount = "https://gateway.example.com/llm/openrouter/openai/v1";
        let s = openrouter_settings(&gateway_test_config(&[]), mount);
        assert_eq!(s.api_key.as_deref(), Some("managed"));
        assert_eq!(s.base_url.as_deref(), Some(mount));
    }

    #[test]
    fn an_endpoint_off_the_gateway_host_without_a_key_sends_no_decoy() {
        let s = openrouter_settings(
            &gateway_test_config(&[]),
            "https://proxy.example/openrouter/v1",
        );
        assert_eq!(s.api_key, None);
    }

    #[test]
    fn names_the_same_app_as_chat() {
        let config = gateway_test_config(&[
            ("OPENROUTER_APP_URL", "https://example-product.example"),
            ("OPENROUTER_APP_TITLE", "Example Product"),
        ]);
        let s = openrouter_settings(&config, OPENROUTER_DIRECT);
        assert_eq!(s.headers, Some(open_router_attribution_headers(&config)));
        assert_eq!(s.headers.unwrap()["X-OpenRouter-Title"], "Example Product");
    }

    #[test]
    fn declares_the_dimensions_fragment_under_the_openai_key() {
        assert_eq!(
            provider_options_json(
                &create_open_router_embedding_provider(OPENROUTER_DIRECT).provider_options
            ),
            json!({ "openai": { "dimensions": 1024 } })
        );
    }
}
