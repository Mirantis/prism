//! OpenAI embeddings (a `text-embedding-3` model) — the `openai` embedding
//! provider. `OPENAI_BASE_URL` is one variable for the whole OpenAI surface, so
//! embeddings follow it wherever chat goes; `CONFIG.openai_endpoint` resolves it
//! against the gateway mount and this factory takes the result.

use std::sync::Arc;

use serde_json::json;

use crate::ai::EmbeddingModel;
use crate::ai::providers::openai::{OpenAIProviderSettings, create_openai};
use crate::config::{CONFIG, Config};
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_open_ai_embedding_provider(base_url: Option<&str>) -> EmbeddingProvider {
    let openai = Arc::new(create_openai(openai_settings(&CONFIG, base_url)));
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

/// The SDK settings for `base_url`.
fn openai_settings(config: &Config, base_url: Option<&str>) -> OpenAIProviderSettings {
    // On the gateway the real key is injected on the outbound leg, so no local key
    // is needed — but the SDK insists on one, so fall back to a decoy (the same
    // pattern as the chat factories).
    OpenAIProviderSettings {
        api_key: config
            .openai_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| {
                config
                    .is_gateway_endpoint(base_url)
                    .then(|| "managed".to_string())
            }),
        // None → the SDK's own default, https://api.openai.com/v1.
        base_url: base_url.map(str::to_string),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::provider_options_json;

    /// A configuration whose gateway is `gateway.example.com`.
    fn config(pairs: &[(&str, &str)]) -> Config {
        let env = [("NEXUS_API_URL", "https://gateway.example.com")]
            .iter()
            .chain(pairs)
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::load(&env, &mut |_, _| {}).unwrap()
    }

    #[test]
    fn no_endpoint_leaves_the_sdk_default() {
        let s = openai_settings(&config(&[("OPENAI_API_KEY", "sk-test")]), None);
        assert_eq!(s.api_key.as_deref(), Some("sk-test"));
        assert_eq!(s.base_url, None);
    }

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given() {
        let s = openai_settings(
            &config(&[("OPENAI_API_KEY", "sk-test")]),
            Some("https://openai.example/v1"),
        );
        assert_eq!(s.base_url.as_deref(), Some("https://openai.example/v1"));
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_gets_a_decoy() {
        let s = openai_settings(
            &config(&[]),
            Some("https://gateway.example.com/llm/openai/v1"),
        );
        assert_eq!(s.api_key.as_deref(), Some("managed"));
    }

    #[test]
    fn an_endpoint_off_the_gateway_host_without_a_key_sends_no_decoy() {
        // A decoy would promise a credential injection that nothing performs.
        let s = openai_settings(&config(&[]), Some("https://openai.example/v1"));
        assert_eq!(s.api_key, None);
        assert_eq!(openai_settings(&config(&[]), None).api_key, None);
    }

    #[test]
    fn a_nexus_cred_sentinel_key_reaches_the_sdk_verbatim() {
        let sentinel = "__nexus_cred:00000000-0000-0000-0000-000000000000__";
        let s = openai_settings(&config(&[("OPENAI_API_KEY", sentinel)]), None);
        assert_eq!(s.api_key.as_deref(), Some(sentinel));
    }

    #[test]
    fn declares_the_dimensions_fragment_under_the_openai_key() {
        assert_eq!(
            provider_options_json(&create_open_ai_embedding_provider(None).provider_options),
            json!({ "openai": { "dimensions": 1024 } })
        );
    }
}
