//! Titan embeddings on bedrock-runtime — the `bedrock` embedding provider. Serves
//! both `bedrock` and `bedrock-mantle` chat deployments, since mantle has no
//! embedding models of its own.
//!
//! `base_url` selects routing exactly as in `create_bedrock_provider`: unset →
//! direct to AWS with resolved credentials; set → the Nexus gateway
//! (`…/llm/bedrock/{region}`), which does its own signing.

use std::sync::Arc;

use serde_json::json;

use crate::ai::EmbeddingModel;
use crate::ai::providers::amazon_bedrock::{AmazonBedrockProviderSettings, create_amazon_bedrock};
use crate::config::{CONFIG, Config};
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::bedrock_shared::create_shared_bedrock_options;
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_bedrock_embedding_provider(base_url: Option<&str>) -> EmbeddingProvider {
    let settings = match base_url {
        Some(url) => gateway_settings(&CONFIG, url),
        None => create_shared_bedrock_options(),
    };
    let bedrock = Arc::new(create_amazon_bedrock(settings));
    EmbeddingProvider {
        model: Arc::new(move |model_id: &str| -> Arc<dyn EmbeddingModel> {
            bedrock.embedding(model_id)
        }),
        // Titan v2 takes the truncation target under the `bedrock` key.
        provider_options: provider_options(
            json!({ "bedrock": { "dimensions": EMBEDDING_DIMENSIONS } }),
        ),
    }
}

/// Through the gateway: the region and the mount, and no credentials, since the
/// gateway signs.
fn gateway_settings(config: &Config, base_url: &str) -> AmazonBedrockProviderSettings {
    AmazonBedrockProviderSettings {
        region: Some(config.aws_region.clone()),
        base_url: Some(base_url.to_string()),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::provider_options_json;

    #[test]
    fn attaches_no_credentials_when_routed_through_nexus() {
        let env = [
            ("AWS_REGION", "us-west-2"),
            ("AWS_ACCESS_KEY_ID", "explicit-key"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let config = Config::load(&env, &mut |_, _| {}).unwrap();
        let s = gateway_settings(&config, "https://nexus.example/llm/bedrock/us-east-1");
        assert_eq!(s.region.as_deref(), Some("us-west-2"));
        assert_eq!(
            s.base_url.as_deref(),
            Some("https://nexus.example/llm/bedrock/us-east-1")
        );
        assert_eq!(s.access_key_id, None);
        assert_eq!(s.secret_access_key, None);
        assert_eq!(s.api_key, None);
        assert!(s.credential_provider.is_none());
    }

    #[test]
    fn delegates_model_lookup_and_declares_the_bedrock_dimensions_fragment() {
        let provider =
            create_bedrock_embedding_provider(Some("https://nexus.example/llm/bedrock/us-east-1"));
        assert_eq!(
            provider.model("amazon.titan-embed-text-v2:0").model_id(),
            "amazon.titan-embed-text-v2:0"
        );
        assert_eq!(
            provider_options_json(&provider.provider_options),
            json!({ "bedrock": { "dimensions": 1024 } })
        );
    }
}
