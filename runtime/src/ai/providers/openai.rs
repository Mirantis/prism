//! The OpenAI provider (`@ai-sdk/openai`): the Responses API and embeddings.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::ai::{EmbeddingModel, LanguageModel};

/// `OpenAIProviderSettings`.
#[derive(Clone, Default)]
pub struct OpenAIProviderSettings {
    /// Sent as `Authorization: Bearer`.
    pub api_key: Option<String>,
    /// Ends at `/v1`. Default `https://api.openai.com/v1`.
    pub base_url: Option<String>,
    pub organization: Option<String>,
    pub project: Option<String>,
    pub headers: Option<IndexMap<String, String>>,
}

/// The provider `createOpenAI` returns.
pub struct OpenAIProvider {
    pub settings: OpenAIProviderSettings,
}

pub fn create_openai(settings: OpenAIProviderSettings) -> OpenAIProvider {
    OpenAIProvider { settings }
}

impl OpenAIProvider {
    /// `provider(modelId)`: a Responses API model.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        todo!()
    }

    /// `provider.embedding(modelId)`.
    pub fn embedding(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        todo!()
    }
}
