//! LiteLLM provider — an operator's own LiteLLM proxy.
//!
//! LiteLLM serves the Anthropic Messages API at `/v1/messages` and translates it to
//! whichever upstream model an alias routes to, so this is the Anthropic SDK at a
//! custom base URL, like the Azure provider. Model ids are the operator's aliases
//! and go to the proxy unchanged.
//!
//! Routing: the `base_url` argument is `LITELLM_BASE_URL`, else the Lens Agents
//! `…/llm/litellm/anthropic/v1` mount. `CONFIG.litellm_endpoint` decides between
//! them. A proxy has no public host, so with neither there is no endpoint.
//!
//! Auth: `LITELLM_API_KEY`, sent as `x-api-key`. The gateway drops a client key and
//! injects its own, so on the gateway a decoy stands in for the key the SDK insists
//! on. Off the gateway, a missing key fails the model call before any request:
//! given no key, the SDK sends `ANTHROPIC_API_KEY`, a first-party credential, to the
//! proxy.

use std::sync::Arc;

use futures::FutureExt;
use serde_json::json;

use crate::ai::LanguageModel;
use crate::ai::providers::anthropic::{AnthropicProviderSettings, create_anthropic};
use crate::config::{CONFIG, is_gateway_endpoint};
use crate::lib::llm_providers::llm_provider::{
    CacheTtl, ClassificationSamplingParams, LlmProvider, anthropic_cache_point, provider_options,
};
use crate::log_info;

/// How long the startup check waits for the proxy's model list.
const MODEL_LIST_TIMEOUT_MS: u64 = 10_000;
/// How many served model ids a startup warning names.
const LISTED_MODELS: usize = 50;

pub fn create_lite_llm_provider(base_url: Option<&str>) -> LlmProvider {
    let gateway_serves_it = is_gateway_endpoint(base_url);
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating LiteLLM provider"
    );

    let api_key = CONFIG
        .litellm_api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| gateway_serves_it.then(|| "nexus-managed".to_string()));
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
                Ok(anthropic.language_model(model_id))
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
    if let Some(base_url) = base_url {
        let base_url = base_url.to_string();
        provider.startup_check = Some(Arc::new(move || {
            check_models(base_url.clone(), api_key.clone()).boxed()
        }));
    }
    provider
}

/// Warn when a configured model is not one the proxy serves, naming the ones it
/// does. The ids are aliases the operator made up, so a default the proxy does not
/// serve, or a typo, is otherwise a failed turn with nothing to say which alias is
/// right.
///
/// `GET ${baseURL}/models` with `x-api-key` and a `MODEL_LIST_TIMEOUT_MS` deadline;
/// a failure (including a non-2xx, `GET /models answered ${status}`) logs `{ err }`
/// `[Startup] could not read the LiteLLM model list; the configured models are
/// unchecked` and returns. Then, for `LITELLM_MODEL_ID` and
/// `LITELLM_CLASSIFICATION_MODEL_ID` in that order, a model missing from `data[].id`
/// logs `{ variable, model, served: served.slice(0, LISTED_MODELS), servedCount }`
/// `[Startup] the LiteLLM proxy does not serve ${model}; set ${variable} to one of
/// the models it serves`. Without a key it does nothing.
async fn check_models(base_url: String, api_key: Option<String>) {
    todo!()
}

/// The settings LiteLLM still needs, by variable name; empty when it can serve
/// requests. Through the gateway it needs none, since the gateway holds the key.
/// Direct mode needs the proxy's address and a key.
pub fn missing_lite_llm_settings() -> Vec<String> {
    if is_gateway_endpoint(CONFIG.litellm_endpoint.as_deref()) {
        return Vec::new();
    }
    let mut missing = Vec::new();
    if CONFIG.litellm_endpoint.as_deref().unwrap_or("").is_empty() {
        missing.push("LITELLM_BASE_URL".to_string());
    }
    if CONFIG.litellm_api_key.as_deref().unwrap_or("").is_empty() {
        missing.push("LITELLM_API_KEY".to_string());
    }
    missing
}
