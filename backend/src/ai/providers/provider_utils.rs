//! The `@ai-sdk/provider-utils` helpers every provider shares: settings, headers,
//! error text and provider tool names.

use std::collections::HashMap;
use std::sync::Arc;

use crate::ai::provider::{Headers, LanguageModelV4Tool};

/// Reads an environment variable, as `process.env[name]`.
pub type EnvLookup = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The process environment.
pub fn process_env() -> EnvLookup {
    Arc::new(|name: &str| std::env::var(name).ok())
}

/// `loadOptionalSetting`: the setting, else the environment variable.
pub fn load_optional_setting(
    setting_value: Option<&str>,
    environment_variable_name: &str,
    env: &EnvLookup,
) -> Option<String> {
    match setting_value {
        Some(value) => Some(value.to_string()),
        None => env(environment_variable_name),
    }
}

/// `combineHeaders`: later headers replace earlier ones of the same name.
pub fn combine_headers(parts: &[Option<&Headers>]) -> Headers {
    let mut combined = Headers::new();
    for headers in parts.iter().flatten() {
        for (name, value) in headers.iter() {
            combined.insert(name.clone(), value.clone());
        }
    }
    combined
}

/// `withoutTrailingSlash`.
pub fn without_trailing_slash(url: &str) -> String {
    url.strip_suffix('/').unwrap_or(url).to_string()
}

/// The innermost message of an error chain: undici's `cause.message`.
pub fn innermost_message(err: &(dyn std::error::Error + 'static)) -> String {
    let mut current = err;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

/// Maps the name a caller gave a provider tool to its name on the API, and back.
/// A name without a mapping maps to itself.
#[derive(Debug, Clone, Default)]
pub struct ToolNameMapping {
    custom_to_provider: HashMap<String, String>,
    provider_to_custom: HashMap<String, String>,
}

impl ToolNameMapping {
    /// `createToolNameMapping` over the request's tools, with the provider's
    /// `(tool id, API name)` pairs.
    pub fn new(
        tools: Option<&[LanguageModelV4Tool]>,
        provider_tool_names: &[(&str, &str)],
    ) -> Self {
        let mut mapping = Self::default();
        for tool in tools.unwrap_or_default() {
            let LanguageModelV4Tool::Provider(tool) = tool else {
                continue;
            };
            let Some((_, provider_name)) =
                provider_tool_names.iter().find(|(id, _)| *id == tool.id)
            else {
                continue;
            };
            mapping
                .custom_to_provider
                .insert(tool.name.clone(), provider_name.to_string());
            mapping
                .provider_to_custom
                .insert(provider_name.to_string(), tool.name.clone());
        }
        mapping
    }

    pub fn to_provider_tool_name(&self, custom_tool_name: &str) -> String {
        self.custom_to_provider
            .get(custom_tool_name)
            .cloned()
            .unwrap_or_else(|| custom_tool_name.to_string())
    }

    pub fn to_custom_tool_name(&self, provider_tool_name: &str) -> String {
        self.provider_to_custom
            .get(provider_tool_name)
            .cloned()
            .unwrap_or_else(|| provider_tool_name.to_string())
    }
}
