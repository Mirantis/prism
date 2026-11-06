//! The Amazon Bedrock provider (`@ai-sdk/amazon-bedrock`): Converse, the Anthropic
//! Messages branch (`anthropic`), and Titan embeddings.

pub mod anthropic;

use std::sync::Arc;

use futures::future::BoxFuture;
use indexmap::IndexMap;

use crate::ai::{EmbeddingModel, LanguageModel};

/// Resolved AWS credentials for SigV4.
#[derive(Clone, Debug, Default)]
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

/// Resolves credentials on each request, as the SDK's `credentialProvider`.
pub type CredentialProvider = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<AwsCredentials>> + Send + Sync>;

/// `AmazonBedrockProviderSettings`.
#[derive(Clone, Default)]
pub struct AmazonBedrockProviderSettings {
    pub region: Option<String>,
    /// Replaces `https://bedrock-runtime.{region}.amazonaws.com`.
    pub base_url: Option<String>,
    /// Bearer API key; `AWS_BEARER_TOKEN_BEDROCK` when unset.
    pub api_key: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
    pub credential_provider: Option<CredentialProvider>,
    pub headers: Option<IndexMap<String, String>>,
}

/// The provider `createAmazonBedrock` returns.
pub struct AmazonBedrockProvider {
    pub settings: AmazonBedrockProviderSettings,
}

pub fn create_amazon_bedrock(settings: AmazonBedrockProviderSettings) -> AmazonBedrockProvider {
    AmazonBedrockProvider { settings }
}

impl AmazonBedrockProvider {
    /// `provider(modelId)`: a Converse model.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        todo!()
    }

    /// `provider.embedding(modelId)`: Titan over InvokeModel.
    pub fn embedding(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        todo!()
    }
}
