//! The Anthropic Messages API provider (`@ai-sdk/anthropic`): the language model's
//! non-streaming call, with the prompt, tool and option conversion it needs.
//!
//! `AnthropicMessagesLanguageModel` and `AnthropicMessagesConfig` are public so a
//! provider for another host of the Messages API (Claude on Bedrock) can build on
//! the model with its own URL, body transform and request signing.

mod cache_control;
mod fetch;
mod model;
mod options;
mod prompt;
mod response;
mod tools;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use indexmap::IndexMap;

use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::{Headers, InvalidArgumentError, LanguageModel, LoadApiKeyError, SupportedUrls};

pub use fetch::{
    FetchFunction, FetchRequest, FetchResponse, PROVIDER_UTILS_VERSION, default_fetch,
};
pub use model::{
    AnthropicLanguageModel, AnthropicMessagesConfig, AnthropicMessagesLanguageModel,
    BuildRequestUrlFunction, GenerateIdFunction, HeadersFunction, ModelCapabilities,
    PreparedRequest, SupportedUrlsFunction, TransformRequestBodyFunction, get_model_capabilities,
    has_dynamic_filtering_web_tool_without_code_execution, sanitize_json_schema,
};
pub use tools::ToolNameMapping;

/// The `@ai-sdk/anthropic` version this module follows; the request's `user-agent`
/// names it.
pub const VERSION: &str = "4.0.78";

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_API_VERSIONED_URL: &str = "https://api.anthropic.com/v1";

/// `AnthropicProviderSettings`.
#[derive(Clone, Default)]
pub struct AnthropicProviderSettings {
    /// Sent as `x-api-key`; `ANTHROPIC_API_KEY` when unset.
    pub api_key: Option<String>,
    /// Sent as `Authorization: Bearer`, in place of the API key.
    pub auth_token: Option<String>,
    /// Ends at `/v1`; `/messages` is appended. `ANTHROPIC_BASE_URL` when unset, else
    /// `https://api.anthropic.com/v1`.
    pub base_url: Option<String>,
    pub headers: Option<IndexMap<String, String>>,
    pub fetch: Option<FetchFunction>,
    pub generate_id: Option<GenerateIdFunction>,
    /// The provider id; `anthropic.messages` when unset.
    pub name: Option<String>,
}

/// The provider `createAnthropic` returns.
pub struct AnthropicProvider {
    pub settings: AnthropicProviderSettings,
    /// The base URL every model of the provider sends to.
    pub base_url: String,
    config: AnthropicMessagesConfig,
}

/// `loadOptionalSetting`: the given value, else the environment variable.
fn load_optional_setting(value: Option<&str>, environment_variable_name: &str) -> Option<String> {
    match value {
        Some(value) => Some(value.to_string()),
        None => std::env::var(environment_variable_name).ok(),
    }
}

/// `normalizeBaseURL`: a blank URL is refused, a trailing slash dropped, and the
/// bare API host gains its `/v1`.
fn normalize_base_url(base_url: Option<String>) -> Result<Option<String>, InvalidArgumentError> {
    let Some(base_url) = base_url else {
        return Ok(None);
    };
    if crate::support::js::trim(&base_url).is_empty() {
        return Err(InvalidArgumentError {
            message: "baseURL must be a non-empty string.".to_string(),
            parameter: "baseURL".to_string(),
            value: serde_json::Value::Null,
        });
    }
    let without_trailing_slash = base_url.strip_suffix('/').unwrap_or(&base_url).to_string();
    if without_trailing_slash == ANTHROPIC_API_URL {
        return Ok(Some(ANTHROPIC_API_VERSIONED_URL.to_string()));
    }
    Ok(Some(without_trailing_slash))
}

/// `loadApiKey({ apiKey, environmentVariableName: 'ANTHROPIC_API_KEY' })`.
fn load_api_key(api_key: Option<&str>) -> Result<String, LoadApiKeyError> {
    if let Some(api_key) = api_key {
        return Ok(api_key.to_string());
    }
    std::env::var("ANTHROPIC_API_KEY").map_err(|_| LoadApiKeyError {
        message: "Anthropic API key is missing. Pass it using the 'apiKey' parameter or the ANTHROPIC_API_KEY environment variable.".to_string(),
    })
}

/// The headers every request of the provider sends.
fn provider_headers(settings: &AnthropicProviderSettings) -> anyhow::Result<Headers> {
    let mut headers: Headers = IndexMap::new();
    headers.insert("anthropic-version".to_string(), "2023-06-01".to_string());
    match settings
        .auth_token
        .as_deref()
        .filter(|token| !token.is_empty())
    {
        Some(token) => {
            headers.insert("Authorization".to_string(), format!("Bearer {token}"));
        }
        None => {
            headers.insert(
                "x-api-key".to_string(),
                load_api_key(settings.api_key.as_deref())?,
            );
        }
    }
    if let Some(extra) = &settings.headers {
        headers.extend(extra.clone());
    }
    Ok(with_user_agent_suffix(
        Some(&headers),
        &format!("ai-sdk-anthropic/{VERSION}"),
    ))
}

/// The URLs a Messages model reads itself: images and PDFs over HTTP(S).
fn anthropic_supported_urls() -> SupportedUrls {
    let url = || regex::Regex::new(r"^https?://.*$").expect("the URL pattern compiles");
    let mut supported = SupportedUrls::new();
    supported.insert("image/*".to_string(), vec![url()]);
    supported.insert("application/pdf".to_string(), vec![url()]);
    supported
}

/// `createAnthropic`. A setting the SDK refuses at creation (a blank base URL, both
/// an API key and an auth token) fails every call of the provider's models.
pub fn create_anthropic(settings: AnthropicProviderSettings) -> AnthropicProvider {
    let mut creation_error = None;
    let base_url = match normalize_base_url(load_optional_setting(
        settings.base_url.as_deref(),
        "ANTHROPIC_BASE_URL",
    )) {
        Ok(base_url) => base_url.unwrap_or_else(|| ANTHROPIC_API_VERSIONED_URL.to_string()),
        Err(error) => {
            creation_error = Some(error);
            ANTHROPIC_API_VERSIONED_URL.to_string()
        }
    };
    let has = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
    if creation_error.is_none() && has(&settings.api_key) && has(&settings.auth_token) {
        creation_error = Some(InvalidArgumentError {
            message: "Both apiKey and authToken were provided. Please use only one authentication method.".to_string(),
            parameter: "apiKey/authToken".to_string(),
            value: serde_json::Value::Null,
        });
    }

    let header_settings = settings.clone();
    let headers: HeadersFunction = Arc::new(move || {
        let result = provider_headers(&header_settings);
        Box::pin(async move { result })
    });
    let mut config = AnthropicMessagesConfig::new(
        settings
            .name
            .clone()
            .unwrap_or_else(|| "anthropic.messages".to_string()),
        base_url.clone(),
    );
    config.headers = Some(headers);
    config.fetch = settings.fetch.clone();
    config.generate_id = settings.generate_id.clone();
    config.supported_urls = Some(Arc::new(anthropic_supported_urls));
    config.creation_error = creation_error;

    AnthropicProvider {
        settings,
        base_url,
        config,
    }
}

impl AnthropicProvider {
    /// `provider(modelId)`: a Messages API model.
    pub fn language_model(&self, model_id: &str) -> Arc<dyn LanguageModel> {
        Arc::new(AnthropicMessagesLanguageModel::new(
            model_id,
            self.config.clone(),
        ))
    }
}
