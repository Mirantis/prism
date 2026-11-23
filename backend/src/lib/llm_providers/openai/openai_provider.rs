//! OpenAI provider — the official OpenAI API.
//!
//! Unlike the other vendors this one serves OpenAI models, not Claude.
//! `create_openai()(modelId)` dispatches to the **Responses API** (the SDK's
//! default), so a custom endpoint — direct override or gateway — must serve
//! `/responses`, not just `/chat/completions`.
//!
//! Routing: the `base_url` argument is the resolved endpoint — `OPENAI_BASE_URL`,
//! else the Mirantis Agent Platform OpenAI mount (`…/llm/openai/v1`), else `None` for
//! api.openai.com. `CONFIG.openai_endpoint` decides between them, so nothing is
//! chosen here. The gateway appends the client path to its configured OpenAI root
//! and injects the API key on the outbound leg. Realtime voice resolves its own
//! endpoint and credential in config; it can also use managed OpenAI.
//!
//! Auth: OPENAI_API_KEY for chat/embeddings, sent as a bearer header. It may be a
//! `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire — read
//! verbatim, never trimmed or validated. An endpoint on the gateway needs no local
//! key (the gateway holds its own), but the SDK insists on one, so fall back to a
//! decoy like the Azure/mantle factories do.
//!
//! The provider object itself — the Responses dispatcher, the empty cache-point
//! fragment (OpenAI caching is automatic) and the three classification
//! declarations GPT-5.x needs — comes from `openai_compatible`, which is the SDK
//! surface rather than this vendor. Everything decided here is what makes it
//! *OpenAI*: the endpoint, the key and the bare model ids.

use std::sync::Arc;

use serde_json::json;

use crate::config::{CONFIG, Config};
use crate::lib::llm_providers::deferred_tools::{
    OPENAI_DEFERRED_TOOLS, deferred_tools_when, supports_open_ai_deferred_tools,
};
use crate::lib::llm_providers::llm_provider::{
    CacheTtl, LlmProvider, ProviderOptionsFragment, provider_options,
};
use crate::lib::llm_providers::openai_compatible::{
    OpenAiCompatibleOptions, create_open_ai_compatible_provider,
};
use crate::log_info;

pub fn create_open_ai_provider(base_url: Option<&str>) -> LlmProvider {
    let mut provider = create_open_ai_compatible_provider(open_ai_options(&CONFIG, base_url));
    provider.deferred_tools = Some(deferred_tools_when(
        supports_open_ai_deferred_tools,
        &OPENAI_DEFERRED_TOOLS,
    ));
    provider.cache_request = Some(Arc::new(open_ai_cache_request));
    provider.cache_ttl_ms = Some(Arc::new(open_ai_cache_ttl_ms));
    provider
}

/// The key and endpoint the OpenAI SDK gets under `config`, after the startup line
/// that names the routing.
fn open_ai_options(config: &Config, base_url: Option<&str>) -> OpenAiCompatibleOptions {
    let gateway_serves_it = config.is_gateway_endpoint(base_url);
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating OpenAI provider"
    );
    OpenAiCompatibleOptions {
        // On the gateway the real key is injected on the outbound leg, so no local
        // key is needed — but the SDK insists on one, so fall back to a decoy (the
        // same pattern as the Azure and mantle factories).
        api_key: config
            .openai_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| gateway_serves_it.then(|| "nexus-managed".to_string())),
        // None → the SDK's own default, https://api.openai.com/v1.
        base_url: base_url.map(str::to_string),
        fetch: None,
    }
}

/// `1h` asks for a 12-hour entry, the one lifetime OpenAI offers past its 30-minute
/// default. `prompt_cache_options` exists from GPT-5.6 on, and an earlier model
/// refuses it, so `5m` sends nothing. Under `1h` a request that must not write sends
/// explicit mode, which writes nothing without breakpoints. Under `5m` such a
/// request writes its prompt once; that is the trade for sending nothing an earlier
/// model refuses.
pub(crate) fn open_ai_cache_request(
    _model_id: &str,
    ttl: CacheTtl,
    write: bool,
) -> ProviderOptionsFragment {
    if ttl != CacheTtl::OneHour {
        return provider_options(json!({}));
    }
    let options = if write {
        json!({ "ttl": "12h" })
    } else {
        json!({ "mode": "explicit" })
    };
    provider_options(json!({ "openai": { "promptCacheOptions": options } }))
}

pub(crate) fn open_ai_cache_ttl_ms(_model_id: &str, ttl: CacheTtl) -> i64 {
    if ttl == CacheTtl::OneHour {
        12 * 60 * 60 * 1000
    } else {
        30 * 60 * 1000
    }
}

/// The settings OpenAI still needs, by variable name; empty when it can serve
/// requests. Through the gateway it needs none, since the gateway holds the key.
pub fn missing_open_ai_settings() -> Vec<String> {
    missing_open_ai_settings_in(&CONFIG)
}

fn missing_open_ai_settings_in(config: &Config) -> Vec<String> {
    if config.nexus_openai_base_url.is_some() {
        return Vec::new();
    }
    if config.openai_api_key.as_deref().unwrap_or("").is_empty() {
        vec!["OPENAI_API_KEY".to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::config::Env;
    use crate::lib::llm_providers::llm_provider::{
        ClassificationSamplingParams, cache_request_options, cache_ttl_ms, provider_options_json,
    };

    pub(crate) const GATEWAY: &str = "https://gateway.example.com";

    /// A configuration from `pairs` on the built-in defaults.
    pub(crate) fn config(pairs: &[(&str, &str)]) -> Config {
        let env: Env = [
            ("PRISM_SETTINGS_PATH", "/nonexistent/prism-settings.json"),
            ("DATABASE_URL", "file::memory:"),
        ]
        .iter()
        .chain(pairs.iter())
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        Config::load(&env, &mut |_, _| {}).expect("config loads")
    }

    fn with_key() -> Config {
        config(&[("OPENAI_API_KEY", "sk-test"), ("NEXUS_API_URL", GATEWAY)])
    }

    fn without_key() -> Config {
        config(&[("NEXUS_API_URL", GATEWAY)])
    }

    #[test]
    fn no_endpoint_leaves_the_sdk_default() {
        let options = open_ai_options(&with_key(), None);
        assert_eq!(options.api_key.as_deref(), Some("sk-test"));
        assert_eq!(options.base_url, None);
    }

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given() {
        let options = open_ai_options(&with_key(), Some("https://openai.example/v1"));
        assert_eq!(
            options.base_url.as_deref(),
            Some("https://openai.example/v1")
        );
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_gets_a_decoy() {
        let options = open_ai_options(
            &without_key(),
            Some("https://gateway.example.com/llm/openai/v1"),
        );
        assert_eq!(options.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_override_on_the_gateway_host_also_gets_the_decoy() {
        // The endpoint an operator names on the gateway host is still served by the
        // gateway, which holds the vendor credential.
        let options = open_ai_options(
            &without_key(),
            Some("https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1"),
        );
        assert_eq!(options.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_endpoint_off_the_gateway_host_without_a_key_sends_no_decoy() {
        // The decoy means "the gateway injects the real key"; an endpoint the gateway
        // does not serve gets no such promise, so the SDK reports the missing key.
        let options = open_ai_options(&without_key(), Some("https://openai.example/v1"));
        assert_eq!(options.api_key, None);
    }

    #[test]
    fn no_endpoint_and_no_key_leaves_the_sdk_fallback() {
        assert_eq!(open_ai_options(&without_key(), None).api_key, None);
    }

    #[test]
    fn a_sentinel_key_reaches_the_sdk_verbatim() {
        let sentinel = "__nexus_cred:00000000-0000-0000-0000-000000000000__";
        let options = open_ai_options(&config(&[("OPENAI_API_KEY", sentinel)]), None);
        assert_eq!(options.api_key.as_deref(), Some(sentinel));
    }

    #[test]
    fn chat_model_ids_dispatch_to_the_responses_api() {
        let model = create_open_ai_provider(None).model("gpt-5.6-sol").unwrap();
        assert_eq!(model.model_id(), "gpt-5.6-sol");
        assert_eq!(model.provider(), "openai.responses");
    }

    #[test]
    fn declares_the_empty_cache_point() {
        assert!(
            create_open_ai_provider(None)
                .cache_point("gpt-5.6", None)
                .is_empty()
        );
    }

    #[test]
    fn asks_for_a_12_hour_entry_under_1h_and_nothing_at_the_default() {
        let provider = create_open_ai_provider(None);
        let options = |ttl, write| {
            provider_options_json(&cache_request_options(&provider, "gpt-5.6-sol", ttl, write))
        };
        assert_eq!(options(CacheTtl::FiveMinutes, true), json!({}));
        assert_eq!(options(CacheTtl::FiveMinutes, false), json!({}));
        assert_eq!(
            options(CacheTtl::OneHour, true),
            json!({ "openai": { "promptCacheOptions": { "ttl": "12h" } } })
        );
        // Explicit mode with no breakpoint writes nothing: a live gpt-5.6-sol request
        // reported cache_write_tokens 0 where the same prompt in implicit mode wrote
        // 6,022.
        assert_eq!(
            options(CacheTtl::OneHour, false),
            json!({ "openai": { "promptCacheOptions": { "mode": "explicit" } } })
        );
        assert_eq!(
            cache_ttl_ms(&provider, "gpt-5.6-sol", CacheTtl::FiveMinutes),
            30 * 60 * 1000
        );
        assert_eq!(
            cache_ttl_ms(&provider, "gpt-5.6-sol", CacheTtl::OneHour),
            12 * 60 * 60 * 1000
        );
    }

    #[test]
    fn declares_no_structured_output_options() {
        assert!(
            create_open_ai_provider(None)
                .structured_output_options
                .is_none()
        );
    }

    #[test]
    fn pins_classification_calls_to_reasoning_effort_none() {
        let provider = create_open_ai_provider(None);
        assert_eq!(
            provider_options_json(provider.classification_provider_options.as_ref().unwrap()),
            json!({ "openai": { "reasoningEffort": "none" } })
        );
    }

    #[test]
    fn declares_the_responses_api_output_token_floor() {
        assert_eq!(
            create_open_ai_provider(None).classification_min_output_tokens,
            Some(16)
        );
    }

    #[test]
    fn declares_empty_gate_sampling_params() {
        assert_eq!(
            create_open_ai_provider(None).classification_sampling_params,
            Some(ClassificationSamplingParams::default())
        );
    }

    #[test]
    fn defers_tools_on_models_that_name_no_refusing_version() {
        // A refusal sends the request again in full.
        let provider = create_open_ai_provider(None);
        for model_id in [
            "gpt-5.6-sol",
            "gpt-6-luna",
            "gpt-6.1-terra",
            "gpt-6.2-sol",
            "gpt-7",
            "gpt-oss-120b",
            "o3",
        ] {
            assert!(
                provider
                    .deferred_tools(model_id)
                    .is_some_and(|p| std::ptr::eq(p, &*OPENAI_DEFERRED_TOOLS)),
                "{model_id}"
            );
        }
    }

    #[test]
    fn defers_no_tool_on_models_that_refuse() {
        // gpt-5.5 rejects a client tool search; gpt-5.4 takes one only without stored
        // responses.
        let provider = create_open_ai_provider(None);
        for model_id in ["gpt-5.5", "gpt-5.4", "gpt-5", "gpt-4.1", "gpt-4o"] {
            assert!(provider.deferred_tools(model_id).is_none(), "{model_id}");
        }
    }

    #[test]
    fn needs_nothing_with_a_key() {
        assert!(missing_open_ai_settings_in(&config(&[("OPENAI_API_KEY", "sk-test")])).is_empty());
    }

    #[test]
    fn needs_nothing_on_the_gateway_mount_without_a_key() {
        // The gateway holds the key.
        assert!(missing_open_ai_settings_in(&without_key()).is_empty());
    }

    #[test]
    fn names_the_key_when_there_is_no_gateway_mount() {
        assert_eq!(
            missing_open_ai_settings_in(&config(&[])),
            vec!["OPENAI_API_KEY".to_string()]
        );
    }
}
