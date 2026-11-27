//! OpenRouter provider.
//!
//! OpenRouter is not a fifth cloud but a reseller: one credential reaches hundreds
//! of models across dozens of vendors, which makes it the shortest path to a
//! running agent — no cloud account, no IAM, no region. Its API is
//! OpenAI-compatible (it serves `/responses` alongside `/chat/completions`), so the
//! provider object comes from `openai_compatible` — the same Responses dispatcher,
//! cache-point fragment and classification declarations the OpenAI provider uses.
//! Its own factory rather than a flag on that one, so the startup log names who is
//! actually serving the call and either vendor can diverge without disturbing the
//! other.
//!
//! What is OpenRouter-specific lives here:
//!
//!  - **The endpoint.** Direct that is `https://openrouter.ai/api/v1` — spelled out
//!    because the SDK's own default is api.openai.com, which is not where these
//!    model ids resolve. Through the gateway it is `…/llm/openrouter/openai/v1`,
//!    *not* `…/llm/openai/v1`: the managed-inference gate compares the path's
//!    backend against the one the project's policy selected and answers 403 on a
//!    mismatch, so borrowing the openai mount fails every call.
//!    `OPENROUTER_BASE_URL` outranks both. `CONFIG.openrouter_endpoint` resolves
//!    that order and this factory takes the result, so the endpoint is never
//!    chosen twice.
//!  - **Model ids are `vendor/model`** (see `CONFIG.openrouter_model_id`), so the
//!    bare ids that are correct against api.openai.com are not ones OpenRouter can
//!    route.
//!
//!  - **App attribution.** Every request names the app OpenRouter credits the
//!    usage to (`open_router_attribution_headers`). The gateway forwards these
//!    headers, so they arrive on both paths.
//!
//! Auth: `OPENROUTER_API_KEY`, sent as a bearer header, read verbatim so it may be
//! a `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire. An
//! endpoint on the gateway needs no local key — the gateway holds the OpenRouter
//! credential and injects it on the outbound leg — but the SDK insists on one, so
//! fall back to a decoy like the Azure/mantle factories do.

use indexmap::IndexMap;
use serde_json::json;

use crate::config::{CONFIG, Config};
use crate::lib::llm_providers::llm_provider::LlmProvider;
use crate::lib::llm_providers::openai_compatible::{
    OpenAiCompatibleOptions, create_open_ai_compatible_provider,
};
use crate::log_info;

pub fn create_open_router_provider(base_url: &str) -> LlmProvider {
    create_open_ai_compatible_provider(open_router_options(&CONFIG, base_url))
}

/// The key and endpoint the OpenAI SDK gets under `config`, after the startup line
/// that names the routing.
fn open_router_options(config: &Config, base_url: &str) -> OpenAiCompatibleOptions {
    let gateway_serves_it = config.is_gateway_endpoint(Some(base_url));
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating OpenRouter provider"
    );
    OpenAiCompatibleOptions {
        // On the gateway the real key is injected on the outbound leg, so no local
        // key is needed — but the SDK insists on one, so fall back to a decoy (the
        // same pattern as the Azure and mantle factories).
        api_key: config
            .openrouter_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| gateway_serves_it.then(|| "nexus-managed".to_string())),
        base_url: Some(base_url.to_string()),
        fetch: None,
        headers: Some(open_router_attribution_headers(config)),
        middleware: Vec::new(),
    }
}

/// OpenRouter's app attribution headers (openrouter.ai/docs/app-attribution).
/// The referer is the app's id; without it OpenRouter creates no app page.
pub fn open_router_attribution_headers(config: &Config) -> IndexMap<String, String> {
    IndexMap::from([
        (
            "HTTP-Referer".to_string(),
            config.openrouter_app_url.clone(),
        ),
        (
            "X-OpenRouter-Title".to_string(),
            config.openrouter_app_title.clone(),
        ),
        (
            "X-OpenRouter-Categories".to_string(),
            "personal-agent".to_string(),
        ),
    ])
}

/// The settings OpenRouter still needs, by variable name; empty when it can serve
/// requests. Through the gateway it needs none, since the gateway holds the key.
pub fn missing_open_router_settings() -> Vec<String> {
    missing_open_router_settings_in(&CONFIG)
}

fn missing_open_router_settings_in(config: &Config) -> Vec<String> {
    if config.nexus_openrouter_base_url.is_some() {
        return Vec::new();
    }
    if config
        .openrouter_api_key
        .as_deref()
        .unwrap_or("")
        .is_empty()
    {
        vec!["OPENROUTER_API_KEY".to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::{
        ClassificationSamplingParams, provider_options_json,
    };
    use crate::lib::llm_providers::openai::openai_provider::tests::{GATEWAY, config};

    const OPENROUTER_DIRECT: &str = "https://openrouter.ai/api/v1";

    fn with_key() -> Config {
        config(&[
            ("OPENROUTER_API_KEY", "sk-or-test"),
            ("NEXUS_API_URL", GATEWAY),
        ])
    }

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given() {
        // Config resolves openrouter.ai when nothing else applies, because the SDK's
        // own default is api.openai.com, where a `vendor/model` id does not resolve.
        let options = open_router_options(&with_key(), OPENROUTER_DIRECT);
        assert_eq!(options.api_key.as_deref(), Some("sk-or-test"));
        assert_eq!(options.base_url.as_deref(), Some(OPENROUTER_DIRECT));
    }

    #[test]
    fn a_sentinel_key_reaches_the_sdk_verbatim() {
        let sentinel = "__nexus_cred:00000000-0000-0000-0000-000000000000__";
        let options = open_router_options(
            &config(&[("OPENROUTER_API_KEY", sentinel)]),
            OPENROUTER_DIRECT,
        );
        assert_eq!(options.api_key.as_deref(), Some(sentinel));
    }

    #[test]
    fn names_prism_as_the_app_by_default() {
        let options = open_router_options(&with_key(), OPENROUTER_DIRECT);
        assert_eq!(
            options.headers,
            Some(IndexMap::from([
                (
                    "HTTP-Referer".to_string(),
                    "https://github.com/Mirantis/prism".to_string()
                ),
                ("X-OpenRouter-Title".to_string(), "Prism".to_string()),
                (
                    "X-OpenRouter-Categories".to_string(),
                    "personal-agent".to_string()
                ),
            ]))
        );
    }

    #[test]
    fn a_product_running_prism_names_its_own_app() {
        let headers = open_router_attribution_headers(&config(&[
            ("OPENROUTER_APP_URL", "https://example-product.example"),
            ("OPENROUTER_APP_TITLE", "Example Product"),
        ]));
        assert_eq!(headers["HTTP-Referer"], "https://example-product.example");
        assert_eq!(headers["X-OpenRouter-Title"], "Example Product");
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_gets_a_decoy() {
        // The gateway holds the OpenRouter credential and injects it outbound; an
        // OpenAI key in the environment is a different vendor's and is never sent.
        let config = config(&[("OPENAI_API_KEY", "sk-test"), ("NEXUS_API_URL", GATEWAY)]);
        let options = open_router_options(
            &config,
            "https://gateway.example.com/llm/openrouter/openai/v1",
        );
        assert_eq!(options.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_override_on_the_gateway_host_also_gets_the_decoy() {
        let options = open_router_options(
            &config(&[("NEXUS_API_URL", GATEWAY)]),
            "https://gateway.example.com/projects/p/llm/openrouter/openai/v1",
        );
        assert_eq!(options.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_endpoint_off_the_gateway_host_without_a_key_sends_no_decoy() {
        // A decoy would promise a credential injection that nothing performs.
        let options = open_router_options(
            &config(&[("NEXUS_API_URL", GATEWAY)]),
            "https://proxy.example/openrouter/v1",
        );
        assert_eq!(options.api_key, None);
    }

    #[test]
    fn dispatches_vendor_qualified_chat_model_ids() {
        let model = create_open_router_provider(OPENROUTER_DIRECT)
            .model("anthropic/claude-sonnet-5")
            .unwrap();
        assert_eq!(model.model_id(), "anthropic/claude-sonnet-5");
        assert_eq!(model.provider(), "openai.responses");
    }

    #[test]
    fn has_the_openai_surface_gate_declarations() {
        // The defaults are `openai/*` models, so the same GPT-5.x constraints apply:
        // reasoning off, a 16-token floor, and no explicit temperature.
        let provider = create_open_router_provider(OPENROUTER_DIRECT);
        assert_eq!(
            provider_options_json(provider.classification_provider_options.as_ref().unwrap()),
            json!({ "openai": { "reasoningEffort": "none" } })
        );
        assert_eq!(provider.classification_min_output_tokens, Some(16));
        assert_eq!(
            provider.classification_sampling_params,
            Some(ClassificationSamplingParams::default())
        );
        assert!(provider.cache_point("openai/gpt-5.6", None).is_empty());
    }

    #[test]
    fn needs_nothing_with_a_key_and_no_embedding_model() {
        // OpenRouter ships no default embedding model.
        assert!(
            missing_open_router_settings_in(&config(&[("OPENROUTER_API_KEY", "sk-or-test")]))
                .is_empty()
        );
    }

    #[test]
    fn needs_nothing_on_the_gateway_mount_without_a_key() {
        // The gateway holds the key.
        assert!(missing_open_router_settings_in(&config(&[("NEXUS_API_URL", GATEWAY)])).is_empty());
    }

    #[test]
    fn names_the_key_when_there_is_no_gateway_mount() {
        assert_eq!(
            missing_open_router_settings_in(&config(&[])),
            vec!["OPENROUTER_API_KEY".to_string()]
        );
    }
}
