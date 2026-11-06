//! The Anthropic Messages API provider (`@ai-sdk/anthropic`).

use std::sync::Arc;

use indexmap::IndexMap;

use crate::ai::LanguageModel;

/// `AnthropicProviderSettings`.
#[derive(Clone, Default)]
pub struct AnthropicProviderSettings {
    /// Sent as `x-api-key`.
    pub api_key: Option<String>,
    /// Ends at `/v1`; `/messages` is appended. Default `https://api.anthropic.com/v1`.
    pub base_url: Option<String>,
    pub headers: Option<IndexMap<String, String>>,
}

/// The provider `createAnthropic` returns.
pub struct AnthropicProvider {
    pub settings: AnthropicProviderSettings,
}

pub fn create_anthropic(settings: AnthropicProviderSettings) -> AnthropicProvider {
    AnthropicProvider { settings }
}

impl AnthropicProvider {
    /// `provider(modelId)`: a Messages API model.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        todo!()
    }
}
