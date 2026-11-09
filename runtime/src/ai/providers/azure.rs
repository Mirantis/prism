//! The Azure OpenAI provider (`@ai-sdk/azure`), used for embeddings.

use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value;

use crate::ai::EmbeddingModel;
use crate::ai::errors::{InvalidArgumentError, LoadSettingError};
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::provider::Headers;
use crate::ai::providers::openai::api::{
    EnvLookup, FetchFunction, default_fetch, load_api_key, process_env, without_trailing_slash,
};
use crate::ai::providers::openai::{OpenAIConfig, OpenAIEmbeddingModel};

/// The `@ai-sdk/azure` version this provider follows; it ends its user agent.
pub const VERSION: &str = "4.0.99";

/// The `@ai-sdk/provider-utils` version `@ai-sdk/azure` posts through.
pub const PROVIDER_UTILS_VERSION: &str = "5.0.58";

/// `AzureOpenAIProviderSettings`.
#[derive(Clone, Default)]
pub struct AzureOpenAIProviderSettings {
    /// Sent as `api-key`; `None` reads `AZURE_API_KEY`.
    pub api_key: Option<String>,
    /// `https://{resourceName}.openai.azure.com/openai` unless `base_url` is set;
    /// `None` reads `AZURE_RESOURCE_NAME`.
    pub resource_name: Option<String>,
    pub base_url: Option<String>,
    /// Default `v1`.
    pub api_version: Option<String>,
    pub headers: Option<IndexMap<String, String>>,
    /// Puts the deployment in the path (`/deployments/{id}`) with an `api-version`.
    pub use_deployment_based_urls: bool,
    /// The `fetch` requests go through; default the global one.
    pub fetch: Option<FetchFunction>,
}

/// The provider `createAzure` returns.
pub struct AzureOpenAIProvider {
    pub settings: AzureOpenAIProviderSettings,
    /// What the base URL is, or why it does not parse; the latter fails every call.
    base_url_info: Result<BaseUrlInfo, InvalidArgumentError>,
    env: EnvLookup,
}

#[derive(Debug, Clone, Copy)]
struct BaseUrlInfo {
    is_azure_openai: bool,
    is_foundry_project: bool,
    is_versioned: bool,
}

/// `getAzureOpenAIBaseURLInfo`: whether the base URL is an Azure OpenAI host, a
/// Foundry project, and a complete `/openai/v1` URL.
fn base_url_info(base_url: Option<&str>) -> Result<BaseUrlInfo, InvalidArgumentError> {
    let Some(base_url) = base_url else {
        return Ok(BaseUrlInfo {
            is_azure_openai: true,
            is_foundry_project: false,
            is_versioned: false,
        });
    };
    let url = url::Url::parse(base_url).map_err(|_| InvalidArgumentError {
        message: "Invalid URL".to_string(),
        parameter: "baseURL".to_string(),
        value: Value::String(base_url.to_string()),
    })?;
    let hostname = url.host_str().unwrap_or_default();
    let is_azure_openai = hostname.ends_with(".openai.azure.com")
        || hostname.ends_with(".services.ai.azure.com")
        || hostname.ends_with(".cognitiveservices.azure.com");
    let pathname = url.path().trim_end_matches('/');
    Ok(BaseUrlInfo {
        is_azure_openai,
        is_foundry_project: hostname.ends_with(".services.ai.azure.com")
            && pathname.starts_with("/api/projects/"),
        is_versioned: is_azure_openai && pathname.to_lowercase().ends_with("/openai/v1"),
    })
}

static HOSTNAME_PART: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").unwrap());

pub fn create_azure(settings: AzureOpenAIProviderSettings) -> AzureOpenAIProvider {
    create_azure_with_env(settings, process_env())
}

/// `createAzure` reading environment fallbacks from `env`.
pub fn create_azure_with_env(
    settings: AzureOpenAIProviderSettings,
    env: EnvLookup,
) -> AzureOpenAIProvider {
    let base_url_info = base_url_info(settings.base_url.as_deref());
    AzureOpenAIProvider {
        settings,
        base_url_info,
        env,
    }
}

impl AzureOpenAIProvider {
    /// `getResourceName`: the setting or `AZURE_RESOURCE_NAME`, which has to be one
    /// DNS label, since it becomes part of the request host.
    fn resource_name(
        settings: &AzureOpenAIProviderSettings,
        env: &EnvLookup,
    ) -> anyhow::Result<String> {
        let resource_name = match &settings.resource_name {
            Some(name) => name.clone(),
            None => env("AZURE_RESOURCE_NAME").ok_or_else(|| LoadSettingError {
                message: "Azure OpenAI resource name setting is missing. Pass it using the 'resourceName' parameter or the AZURE_RESOURCE_NAME environment variable.".to_string(),
            })?,
        };
        if !HOSTNAME_PART.is_match(&resource_name) {
            return Err(InvalidArgumentError {
                message: "Invalid Azure resource name. Expected a single DNS label (letters, digits, and hyphens). Use `baseURL` for custom endpoints.".to_string(),
                parameter: "resourceName".to_string(),
                value: Value::Null,
            }
            .into());
        }
        Ok(resource_name)
    }

    fn config(&self, provider: &str) -> OpenAIConfig {
        let settings = self.settings.clone();
        let env = self.env.clone();
        let info = self.base_url_info.clone();
        let url_settings = self.settings.clone();
        let url_env = self.env.clone();
        OpenAIConfig {
            provider: provider.to_string(),
            url: Arc::new(move |path: &str, model_id: &str| {
                let info = info.clone()?;
                let prefix = match &url_settings.base_url {
                    Some(base_url) => without_trailing_slash(base_url),
                    None => format!(
                        "https://{}.openai.azure.com/openai",
                        Self::resource_name(&url_settings, &url_env)?
                    ),
                };
                let full = if url_settings.use_deployment_based_urls {
                    format!("{prefix}/deployments/{model_id}{path}")
                } else if !info.is_azure_openai || info.is_versioned {
                    // Custom gateways and complete v1 URLs own their routing and
                    // versioning.
                    format!("{prefix}{path}")
                } else {
                    format!("{prefix}/v1{path}")
                };
                let mut url = url::Url::parse(&full)?;
                if url_settings.use_deployment_based_urls
                    || (info.is_azure_openai && !info.is_versioned && !info.is_foundry_project)
                {
                    let api_version = url_settings
                        .api_version
                        .clone()
                        .unwrap_or_else(|| "v1".to_string());
                    set_search_param(&mut url, "api-version", &api_version);
                }
                Ok(url.to_string())
            }),
            headers: Arc::new(move || {
                let key = load_api_key(
                    settings.api_key.as_deref(),
                    "AZURE_API_KEY",
                    "Azure OpenAI",
                    &env,
                )?;
                let mut headers = Headers::new();
                headers.insert("api-key".to_string(), key);
                for (name, value) in settings.headers.iter().flatten() {
                    headers.insert(name.clone(), value.clone());
                }
                Ok(with_user_agent_suffix(
                    Some(&headers),
                    &format!("ai-sdk-azure/{VERSION}"),
                ))
            }),
            fetch: self.settings.fetch.clone().unwrap_or_else(default_fetch),
            provider_utils_version: PROVIDER_UTILS_VERSION,
            explicit_message_item_type: false,
            file_id_prefixes: None,
        }
    }

    /// `provider.embedding(deploymentName)`.
    pub fn embedding(&self, model_id: &str) -> Arc<dyn EmbeddingModel> {
        Arc::new(OpenAIEmbeddingModel::new(
            model_id,
            self.config("azure.embeddings"),
        ))
    }
}

/// `url.searchParams.set(name, value)`: the first pair of that name takes the
/// value and the others go; a new pair goes last.
fn set_search_param(url: &mut url::Url, name: &str, value: &str) {
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut replaced = false;
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in pairs {
        if k == name {
            if !replaced {
                out.push((k, value.to_string()));
                replaced = true;
            }
            continue;
        }
        out.push((k, v));
    }
    if !replaced {
        out.push((name.to_string(), value.to_string()));
    }
    url.query_pairs_mut().clear().extend_pairs(out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::errors::ApiCallError;
    use crate::ai::json::js_stringify;
    use crate::ai::provider::EmbeddingModelV4CallOptions;
    use crate::ai::providers::openai::api::{FetchRequest, FetchResponse};
    use bytes::Bytes;
    use parking_lot::Mutex;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("testdata/openai_sdk.json")).unwrap()
    }

    fn settings(value: &Value) -> AzureOpenAIProviderSettings {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        AzureOpenAIProviderSettings {
            api_key: text("apiKey"),
            resource_name: text("resourceName"),
            base_url: text("baseURL"),
            api_version: text("apiVersion"),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn embedding_calls_match_the_sdk() {
        let fixture = fixture();
        for case in fixture["embeddings"].as_array().unwrap() {
            if case["provider"] != "azure" {
                continue;
            }
            let name = case["name"].as_str().unwrap();
            let captured: Arc<Mutex<Option<FetchRequest>>> = Arc::new(Mutex::new(None));
            let sink = captured.clone();
            let status = case["status"].as_u64().unwrap() as u16;
            let status_text = case["statusText"].as_str().unwrap().to_string();
            let body = case["responseBody"].as_str().unwrap().to_string();
            let fetch: FetchFunction = Arc::new(move |request| {
                *sink.lock() = Some(request);
                let (status_text, body) = (status_text.clone(), body.clone());
                Box::pin(async move {
                    Ok(FetchResponse {
                        status,
                        status_text,
                        headers: [("content-type".to_string(), "application/json".to_string())]
                            .into_iter()
                            .collect(),
                        body: Bytes::from(body),
                    })
                })
            });
            let mut provider_settings = settings(&case["settings"]);
            provider_settings.fetch = Some(fetch);
            let no_env: EnvLookup = Arc::new(|_| None);
            let model = create_azure_with_env(provider_settings, no_env)
                .embedding(case["modelId"].as_str().unwrap());
            assert_eq!(
                model.provider(),
                case["modelProvider"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(model.max_embeddings_per_call(), Some(2048), "{name}");
            let options: EmbeddingModelV4CallOptions =
                serde_json::from_value(case["options"].clone()).unwrap();
            let result = model.do_embed(options).await;

            let request = captured.lock().clone();
            match (&request, case.get("url")) {
                (Some(request), Some(url)) => {
                    assert_eq!(request.url, url.as_str().unwrap(), "{name}");
                    assert_eq!(request.body, case["body"].as_str().unwrap(), "{name}");
                    let headers = serde_json::to_value(&request.headers).unwrap();
                    assert_eq!(
                        js_stringify(&headers),
                        js_stringify(&case["headers"]),
                        "{name}"
                    );
                }
                (None, None) => {}
                _ => panic!("{name}: the request was sent in one runtime only"),
            }
            match (result, case.get("error")) {
                (Ok(result), None) => {
                    let actual = serde_json::to_value(&result).unwrap();
                    assert_eq!(actual["embeddings"], case["result"]["embeddings"], "{name}");
                    assert_eq!(actual["usage"], case["result"]["usage"], "{name}");
                    assert_eq!(
                        actual["response"]["body"], case["result"]["response"]["body"],
                        "{name}"
                    );
                }
                (Err(err), Some(expected)) => {
                    assert_eq!(
                        err.to_string(),
                        expected["message"].as_str().unwrap(),
                        "{name}"
                    );
                    assert_eq!(
                        crate::ai::error_name(&err),
                        expected["name"].as_str().unwrap(),
                        "{name}"
                    );
                    if let Some(api) = err.downcast_ref::<ApiCallError>() {
                        assert_eq!(api.data.as_ref(), expected.get("data"), "{name}");
                        assert_eq!(Some(api.url.as_str()), expected["url"].as_str(), "{name}");
                    }
                }
                (Ok(_), Some(_)) => panic!("{name}: the SDK failed"),
                (Err(err), None) => panic!("{name}: {err}"),
            }
        }
    }

    #[test]
    fn a_missing_resource_name_names_the_variable() {
        let no_env: EnvLookup = Arc::new(|_| None);
        let err =
            AzureOpenAIProvider::resource_name(&AzureOpenAIProviderSettings::default(), &no_env)
                .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Azure OpenAI resource name setting is missing. Pass it using the 'resourceName' parameter or the AZURE_RESOURCE_NAME environment variable."
        );
    }

    #[test]
    fn deployment_based_urls_name_the_deployment() {
        let provider = create_azure_with_env(
            AzureOpenAIProviderSettings {
                resource_name: Some("res".to_string()),
                use_deployment_based_urls: true,
                api_version: Some("2024-10-21".to_string()),
                ..Default::default()
            },
            Arc::new(|_| None),
        );
        let config = provider.config("azure.embeddings");
        assert_eq!(
            (config.url)("/embeddings", "emb").unwrap(),
            "https://res.openai.azure.com/openai/deployments/emb/embeddings?api-version=2024-10-21"
        );
    }
}
