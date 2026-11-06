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
use crate::config::CONFIG;
use crate::lib::embedding_providers::embedding_provider::{
    EMBEDDING_DIMENSIONS, EmbeddingProvider,
};
use crate::lib::llm_providers::bedrock_shared::create_shared_bedrock_options;
use crate::lib::llm_providers::llm_provider::provider_options;

pub fn create_bedrock_embedding_provider(base_url: Option<&str>) -> EmbeddingProvider {
    let settings = match base_url {
        Some(url) => AmazonBedrockProviderSettings {
            region: Some(CONFIG.aws_region.clone()),
            base_url: Some(url.to_string()),
            ..Default::default()
        },
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
