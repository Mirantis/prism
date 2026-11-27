//! LiteLLM provider — an operator's own LiteLLM proxy.
//!
//! LiteLLM serves the Anthropic Messages API at `/v1/messages` and translates it to
//! whichever upstream model an alias routes to, so this is the Anthropic SDK at a
//! custom base URL, like the Azure provider. Model ids are the operator's aliases
//! and go to the proxy unchanged.
//!
//! Routing: the `base_url` argument is `LITELLM_BASE_URL`, else the Mirantis Agent Platform
//! `…/llm/litellm/anthropic/v1` mount. `CONFIG.litellm_endpoint` decides between
//! them. A proxy has no public host, so with neither there is no endpoint.
//!
//! Auth: `LITELLM_API_KEY`, sent as `x-api-key`. The gateway drops a client key and
//! injects its own, so on the gateway a decoy stands in for the key the SDK insists
//! on. Off the gateway, a missing key fails the model call before any request:
//! given no key, the SDK sends `ANTHROPIC_API_KEY`, a first-party credential, to the
//! proxy.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use futures::FutureExt;
use serde_json::{Value, json};

use crate::ai::providers::anthropic::{AnthropicProviderSettings, create_anthropic};
use crate::ai::{LanguageModel, with_llm_cache};
use crate::config::{CONFIG, Config};
use crate::lib::llm_providers::llm_provider::{
    CacheTtl, ClassificationSamplingParams, LlmProvider, anthropic_cache_point, provider_options,
};
use crate::lib::log_redaction::err_json;
use crate::{log_info, log_warn};

/// How long the startup check waits for the proxy's model list.
const MODEL_LIST_TIMEOUT_MS: u64 = 10_000;
/// How many served model ids a startup warning names.
const LISTED_MODELS: usize = 50;

/// The startup check's client. Node's `fetch` reads no proxy variables.
static MODEL_LIST_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("the model list client builds")
});

/// The key the SDK sends: `LITELLM_API_KEY`, else a decoy on the gateway.
fn lite_llm_api_key(config: &Config, base_url: Option<&str>) -> Option<String> {
    config
        .litellm_api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| {
            config
                .is_gateway_endpoint(base_url)
                .then(|| "nexus-managed".to_string())
        })
}

pub fn create_lite_llm_provider(base_url: Option<&str>) -> LlmProvider {
    create_lite_llm_provider_for(&CONFIG, base_url)
}

fn create_lite_llm_provider_for(config: &Config, base_url: Option<&str>) -> LlmProvider {
    let gateway_serves_it = config.is_gateway_endpoint(base_url);
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating LiteLLM provider"
    );

    let api_key = lite_llm_api_key(config, base_url);
    let anthropic = Arc::new(create_anthropic(AnthropicProviderSettings {
        api_key: api_key.clone(),
        base_url: base_url.map(str::to_string),
        ..Default::default()
    }));

    let has_key = api_key.is_some();
    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                if !has_key {
                    anyhow::bail!("LITELLM_API_KEY is not set");
                }
                Ok(with_llm_cache(anthropic.language_model(model_id)))
            },
        ),
        Arc::new(|_model_id: &str, ttl: Option<CacheTtl>| anthropic_cache_point(ttl)),
    );
    // An alias can route to any upstream. A forced tool call translates to all of
    // them, while native `output_config.format` reaches an Anthropic one only.
    provider.structured_output_options = Some(provider_options(
        json!({ "anthropic": { "structuredOutputMode": "jsonTool" } }),
    ));
    // No gate temperature, for the same reason: a GPT-5.x upstream rejects an
    // explicit one, and every model accepts its own default.
    provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
    if let Some(base_url) = base_url.filter(|url| !url.is_empty()) {
        let base_url = base_url.to_string();
        let checks = configured_models(config);
        provider.startup_check = Some(Arc::new(move || {
            check_models(base_url.clone(), api_key.clone(), checks.clone()).boxed()
        }));
    }
    provider
}

/// The configured aliases the startup check confirms, by variable name.
fn configured_models(config: &Config) -> Vec<(&'static str, String)> {
    vec![
        ("LITELLM_MODEL_ID", config.litellm_model_id.clone()),
        (
            "LITELLM_CLASSIFICATION_MODEL_ID",
            config.litellm_classification_model_id.clone(),
        ),
    ]
}

/// Warn when a configured model is not one the proxy serves, naming the ones it
/// does. The ids are aliases the operator made up, so a default the proxy does not
/// serve, or a typo, is otherwise a failed turn with nothing to say which alias is
/// right.
async fn check_models(
    base_url: String,
    api_key: Option<String>,
    checks: Vec<(&'static str, String)>,
) {
    let Some(api_key) = api_key else {
        return;
    };
    let served = match read_served_models(&base_url, &api_key).await {
        Ok(served) => served,
        Err(err) => {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[Startup] could not read the LiteLLM model list; the configured models are unchecked"
            );
            return;
        }
    };
    for (fields, message) in unserved_model_warnings(&served, &checks) {
        log_warn!(fields, "{}", message);
    }
}

/// `GET {base_url}/models`: the ids of the models the proxy serves.
async fn read_served_models(base_url: &str, api_key: &str) -> anyhow::Result<Vec<String>> {
    let response = MODEL_LIST_CLIENT
        .get(format!("{base_url}/models"))
        .header("x-api-key", api_key)
        .timeout(Duration::from_millis(MODEL_LIST_TIMEOUT_MS))
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("GET /models answered {}", response.status().as_u16());
    }
    let body: Value = response.json().await?;
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("Cannot read properties of undefined (reading 'map')"))?;
    Ok(data
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

/// The warning fields and message for each configured model the proxy does not
/// serve, in the order of `checks`.
fn unserved_model_warnings(
    served: &[String],
    checks: &[(&'static str, String)],
) -> Vec<(Value, String)> {
    checks
        .iter()
        .filter(|(_, model)| !served.contains(model))
        .map(|(variable, model)| {
            (
                json!({
                    "variable": variable,
                    "model": model,
                    "served": &served[..served.len().min(LISTED_MODELS)],
                    "servedCount": served.len(),
                }),
                format!(
                    "[Startup] the LiteLLM proxy does not serve {model}; set {variable} to one of the models it serves"
                ),
            )
        })
        .collect()
}

/// The settings LiteLLM still needs, by variable name; empty when it can serve
/// requests. Through the gateway it needs none, since the gateway holds the key.
/// Direct mode needs the proxy's address and a key.
pub fn missing_lite_llm_settings() -> Vec<String> {
    missing_lite_llm_settings_for(&CONFIG)
}

fn missing_lite_llm_settings_for(config: &Config) -> Vec<String> {
    if config.is_gateway_endpoint(config.litellm_endpoint.as_deref()) {
        return Vec::new();
    }
    let mut missing = Vec::new();
    if config.litellm_endpoint.as_deref().unwrap_or("").is_empty() {
        missing.push("LITELLM_BASE_URL".to_string());
    }
    if config.litellm_api_key.as_deref().unwrap_or("").is_empty() {
        missing.push("LITELLM_API_KEY".to_string());
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_config;
    use crate::lib::llm_providers::llm_provider::provider_options_json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PROXY: &str = "https://litellm.example.com/v1";
    const MOUNT: &str = "https://gateway.example.com/projects/p/llm/litellm/anthropic/v1";
    const GATEWAY: (&str, &str) = ("NEXUS_API_URL", "https://gateway.example.com");
    const KEY: (&str, &str) = ("LITELLM_API_KEY", "sk-litellm");

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given_with_the_lite_llm_key() {
        let config = test_config(&[KEY]);
        assert_eq!(
            lite_llm_api_key(&config, Some(PROXY)).as_deref(),
            Some("sk-litellm")
        );
        let provider = create_lite_llm_provider_for(&config, Some(PROXY));
        assert_eq!(
            provider.model("claude-opus-5-5").unwrap().provider(),
            "anthropic.messages"
        );
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_falls_back_to_a_decoy() {
        let config = test_config(&[GATEWAY]);
        assert_eq!(
            lite_llm_api_key(&config, Some(MOUNT)).as_deref(),
            Some("nexus-managed")
        );
    }

    #[test]
    fn off_the_gateway_without_a_key_fails_the_model_call_before_any_request() {
        let provider = create_lite_llm_provider_for(&test_config(&[]), Some(PROXY));
        let err = provider.model("claude-opus-5-5").err().unwrap();
        assert_eq!(err.to_string(), "LITELLM_API_KEY is not set");
    }

    #[test]
    fn passes_the_alias_to_the_proxy_unchanged() {
        let provider = create_lite_llm_provider_for(&test_config(&[KEY]), Some(PROXY));
        assert_eq!(
            provider
                .model("anthropic.claude-opus-5")
                .unwrap()
                .model_id(),
            "anthropic.claude-opus-5"
        );
    }

    #[test]
    fn asks_for_the_tool_based_json_path_which_translates_to_any_upstream() {
        let provider = create_lite_llm_provider_for(&test_config(&[KEY]), Some(PROXY));
        assert_eq!(
            provider_options_json(provider.structured_output_options.as_ref().unwrap()),
            json!({ "anthropic": { "structuredOutputMode": "jsonTool" } })
        );
    }

    #[test]
    fn sends_the_gates_no_temperature_and_marks_anthropic_breakpoints() {
        let provider = create_lite_llm_provider_for(&test_config(&[KEY]), Some(PROXY));
        assert_eq!(
            serde_json::to_value(provider.classification_sampling_params.unwrap()).unwrap(),
            json!({})
        );
        assert_eq!(
            provider.cache_point("any-alias", None).to_json(),
            json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } })
        );
    }

    #[test]
    fn declares_no_startup_check_without_an_endpoint() {
        let provider = create_lite_llm_provider_for(&test_config(&[KEY]), None);
        assert!(provider.startup_check.is_none());
        let provider = create_lite_llm_provider_for(&test_config(&[KEY]), Some(PROXY));
        assert!(provider.startup_check.is_some());
    }

    /// Serves one request with `status` and `body`, and returns the request's head.
    async fn serve_once(
        status: &str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!(
            "http://127.0.0.1:{}/v1",
            listener.local_addr().unwrap().port()
        );
        let status = status.to_string();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&head).to_string()
        });
        (base_url, handle)
    }

    #[tokio::test]
    async fn asks_the_proxy_for_its_models_with_the_key_the_chat_calls_send() {
        let (base_url, server) = serve_once(
            "200 OK",
            r#"{"object":"list","data":[{"id":"claude-opus-5-5","object":"model"},{"id":"claude-haiku-4-5","object":"model"}]}"#,
        )
        .await;
        let served = read_served_models(&base_url, "sk-litellm").await.unwrap();
        assert_eq!(served, ["claude-opus-5-5", "claude-haiku-4-5"]);
        let head = server.await.unwrap();
        assert!(head.starts_with("GET /v1/models HTTP/1.1"), "{head}");
        assert!(
            head.to_lowercase()
                .contains("\r\nx-api-key: sk-litellm\r\n"),
            "{head}"
        );
    }

    #[tokio::test]
    async fn a_refused_model_list_is_an_error_naming_the_status() {
        let (base_url, _server) = serve_once("401 Unauthorized", r#"{"error":"auth"}"#).await;
        let err = read_served_models(&base_url, "sk-litellm")
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "GET /models answered 401");
    }

    #[tokio::test]
    async fn without_a_key_the_check_asks_the_proxy_nothing() {
        // Nothing listens on this address; a request would fail and log.
        check_models("http://127.0.0.1:9/v1".to_string(), None, vec![]).await;
    }

    fn served(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn checks(chat: &str, classification: &str) -> Vec<(&'static str, String)> {
        vec![
            ("LITELLM_MODEL_ID", chat.to_string()),
            (
                "LITELLM_CLASSIFICATION_MODEL_ID",
                classification.to_string(),
            ),
        ]
    }

    #[test]
    fn is_quiet_when_both_aliases_are_served() {
        let served = served(&["claude-opus-5-5", "claude-haiku-4-5"]);
        assert!(
            unserved_model_warnings(&served, &checks("claude-opus-5-5", "claude-haiku-4-5"))
                .is_empty()
        );
    }

    #[test]
    fn names_the_variable_and_the_served_models_when_the_chat_model_differs() {
        let served = served(&["opus", "claude-haiku-4-5"]);
        let warnings =
            unserved_model_warnings(&served, &checks("claude-opus-5-5", "claude-haiku-4-5"));
        assert_eq!(
            warnings,
            [(
                json!({
                    "variable": "LITELLM_MODEL_ID",
                    "model": "claude-opus-5-5",
                    "served": ["opus", "claude-haiku-4-5"],
                    "servedCount": 2,
                }),
                "[Startup] the LiteLLM proxy does not serve claude-opus-5-5; set LITELLM_MODEL_ID to one of the models it serves".to_string(),
            )]
        );
    }

    #[test]
    fn warns_about_a_classification_alias_the_proxy_does_not_serve() {
        let served = served(&["claude-opus-5-5", "claude-haiku-4-5"]);
        let warnings =
            unserved_model_warnings(&served, &checks("claude-opus-5-5", "claude-haiku-4.5"));
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].0["variable"], "LITELLM_CLASSIFICATION_MODEL_ID");
        assert_eq!(
            warnings[0].1,
            "[Startup] the LiteLLM proxy does not serve claude-haiku-4.5; set LITELLM_CLASSIFICATION_MODEL_ID to one of the models it serves"
        );
    }

    #[test]
    fn names_at_most_50_served_models_with_the_full_count() {
        let ids: Vec<String> = (0..120).map(|i| format!("model-{i}")).collect();
        let warnings = unserved_model_warnings(&ids, &checks("missing", "missing"));
        assert_eq!(warnings[0].0["served"], json!(ids[..50]));
        assert_eq!(warnings[0].0["servedCount"], 120);
    }

    #[test]
    fn missing_settings_are_none_with_a_key_and_the_proxy_endpoint() {
        let config = test_config(&[KEY, ("LITELLM_BASE_URL", PROXY)]);
        assert!(missing_lite_llm_settings_for(&config).is_empty());
    }

    #[test]
    fn missing_settings_are_none_on_the_gateway_mount_without_a_key() {
        let config = test_config(&[GATEWAY]);
        assert_eq!(
            config.litellm_endpoint.as_deref(),
            Some("https://gateway.example.com/llm/litellm/anthropic/v1")
        );
        assert!(missing_lite_llm_settings_for(&config).is_empty());
    }

    #[test]
    fn missing_settings_name_the_key_off_the_gateway() {
        let config = test_config(&[("LITELLM_BASE_URL", PROXY)]);
        assert_eq!(missing_lite_llm_settings_for(&config), ["LITELLM_API_KEY"]);
    }

    #[test]
    fn missing_settings_name_the_proxy_address_and_the_key_without_an_endpoint() {
        assert_eq!(
            missing_lite_llm_settings_for(&test_config(&[])),
            ["LITELLM_BASE_URL", "LITELLM_API_KEY"]
        );
    }
}
