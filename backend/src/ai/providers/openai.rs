//! The OpenAI provider (`@ai-sdk/openai`): the Responses API and embeddings.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::ai::errors::InvalidArgumentError;
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::provider::Headers;
use crate::ai::{EmbeddingModel, LanguageModel};

pub mod api;
pub mod capabilities;
pub mod embedding;
pub mod json_schema;
pub mod responses;
pub mod responses_input;
pub mod responses_options;
pub mod responses_tools;
pub mod tools;

#[cfg(test)]
mod tests;

use api::{
    EnvLookup, FetchFunction, default_fetch, load_api_key, load_optional_setting, process_env,
    validate_base_url, without_trailing_slash,
};
pub use embedding::OpenAIEmbeddingModel;
pub use responses::{OpenAIConfig, OpenAIResponsesLanguageModel};

/// The `@ai-sdk/openai` version this provider follows; it ends its user agent.
pub const VERSION: &str = "4.0.99";

/// The `@ai-sdk/provider-utils` version `@ai-sdk/openai` posts through.
pub const PROVIDER_UTILS_VERSION: &str = "5.0.65";

/// `OpenAIProviderSettings`.
#[derive(Clone, Default)]
pub struct OpenAIProviderSettings {
    /// Sent as `Authorization: Bearer`; `None` reads `OPENAI_API_KEY`.
    pub api_key: Option<String>,
    /// Ends at `/v1`; `None` reads `OPENAI_BASE_URL`, else `https://api.openai.com/v1`.
    pub base_url: Option<String>,
    pub organization: Option<String>,
    pub project: Option<String>,
    pub headers: Option<IndexMap<String, String>>,
    /// The provider name in model provider ids; default `openai`.
    pub name: Option<String>,
    /// The `fetch` requests go through; default the global one.
    pub fetch: Option<FetchFunction>,
}

/// The provider `createOpenAI` returns.
pub struct OpenAIProvider {
    pub settings: OpenAIProviderSettings,
    /// The base URL, or why the setting was refused; a refused one fails every call.
    base_url: Result<String, InvalidArgumentError>,
    provider_name: String,
    env: EnvLookup,
}

pub fn create_openai(settings: OpenAIProviderSettings) -> OpenAIProvider {
    create_openai_with_env(settings, process_env())
}

/// `createOpenAI` reading environment fallbacks from `env`.
pub fn create_openai_with_env(settings: OpenAIProviderSettings, env: EnvLookup) -> OpenAIProvider {
    let base_url = validate_base_url(load_optional_setting(
        settings.base_url.as_deref(),
        "OPENAI_BASE_URL",
        &env,
    ))
    .map(|url| {
        url.map(|url| without_trailing_slash(&url))
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string())
    });
    let provider_name = settings
        .name
        .clone()
        .unwrap_or_else(|| "openai".to_string());
    OpenAIProvider {
        settings,
        base_url,
        provider_name,
        env,
    }
}

impl OpenAIProvider {
    fn config(&self, kind: &str) -> OpenAIConfig {
        let base_url = self.base_url.clone();
        let settings = self.settings.clone();
        let env = self.env.clone();
        OpenAIConfig {
            provider: format!("{}.{kind}", self.provider_name),
            url: Arc::new(move |path: &str, _model_id: &str| {
                let base_url = base_url.clone()?;
                Ok(format!("{base_url}{path}"))
            }),
            headers: Arc::new(move || {
                let key = load_api_key(
                    settings.api_key.as_deref(),
                    "OPENAI_API_KEY",
                    "OpenAI",
                    &env,
                )?;
                let mut headers = Headers::new();
                headers.insert("Authorization".to_string(), format!("Bearer {key}"));
                if let Some(organization) = &settings.organization {
                    headers.insert("OpenAI-Organization".to_string(), organization.clone());
                }
                if let Some(project) = &settings.project {
                    headers.insert("OpenAI-Project".to_string(), project.clone());
                }
                for (name, value) in settings.headers.iter().flatten() {
                    headers.insert(name.clone(), value.clone());
                }
                Ok(with_user_agent_suffix(
                    Some(&headers),
                    &format!("ai-sdk-openai/{VERSION}"),
                ))
            }),
            fetch: self.settings.fetch.clone().unwrap_or_else(default_fetch),
            provider_utils_version: PROVIDER_UTILS_VERSION,
            explicit_message_item_type: false,
            // Soft-deprecated in the SDK, still on by default.
            file_id_prefixes: Some(vec!["file-".to_string()]),
        }
    }

    /// `provider(modelId)`: a Responses API model.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        Arc::new(OpenAIResponsesLanguageModel::new(
            model_id,
            self.config("responses"),
        ))
    }

    /// `provider.embedding(modelId)`.
    pub fn embedding(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        let mut config = self.config("embedding");
        config.file_id_prefixes = None;
        Arc::new(OpenAIEmbeddingModel::new(model_id, config))
    }
}
