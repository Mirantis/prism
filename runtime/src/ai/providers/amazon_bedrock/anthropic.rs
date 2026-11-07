//! Claude on Bedrock through the Anthropic Messages body over InvokeModel
//! (`@ai-sdk/amazon-bedrock/anthropic`).

use std::sync::Arc;

use super::AmazonBedrockProviderSettings;
use crate::ai::LanguageModel;

/// The provider `createBedrockAnthropic` returns.
pub struct BedrockAnthropicProvider {
    pub settings: AmazonBedrockProviderSettings,
}

pub fn create_bedrock_anthropic(
    settings: AmazonBedrockProviderSettings,
) -> BedrockAnthropicProvider {
    BedrockAnthropicProvider { settings }
}

impl BedrockAnthropicProvider {
    /// `provider(modelId)`.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        todo!()
    }
}
