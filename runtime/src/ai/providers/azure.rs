//! The Azure OpenAI provider (`@ai-sdk/azure`), used for embeddings.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::ai::EmbeddingModel;

/// `AzureOpenAIProviderSettings`.
#[derive(Clone, Default)]
pub struct AzureOpenAIProviderSettings {
    pub api_key: Option<String>,
    /// `https://{resourceName}.openai.azure.com/openai` unless `base_url` is set.
    pub resource_name: Option<String>,
    pub base_url: Option<String>,
    pub api_version: Option<String>,
    pub headers: Option<IndexMap<String, String>>,
}

/// The provider `createAzure` returns.
pub struct AzureOpenAIProvider {
    pub settings: AzureOpenAIProviderSettings,
}

pub fn create_azure(settings: AzureOpenAIProviderSettings) -> AzureOpenAIProvider {
    AzureOpenAIProvider { settings }
}

impl AzureOpenAIProvider {
    /// `provider.embedding(deploymentName)`.
    pub fn embedding(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        todo!()
    }
}
