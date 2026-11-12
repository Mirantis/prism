//! Bedrock Mantle provider.
//!
//! Mantle is AWS's second Bedrock inference endpoint
//! (`https://bedrock-mantle.{region}.api.aws`), separate from `bedrock-runtime` and
//! recommended by AWS for new applications. It exposes three surfaces — OpenAI
//! Responses (`/v1/responses`), OpenAI Chat Completions (`/v1/chat/completions`),
//! and the **Anthropic Messages API** (`/anthropic/v1/messages`) — and serves
//! neither InvokeModel nor Converse.
//!
//! This provider implements the Anthropic surface only, which makes it structurally
//! identical to the Azure provider (Claude-on-Foundry) rather than to the native
//! Bedrock one: the Anthropic SDK pointed at mantle. Not the Bedrock Anthropic
//! factory, which appends `/model/{id}/invoke` (a path mantle does not serve), and
//! not the Bedrock mantle factory, which is OpenAI-compatible-only.
//!
//! Model IDs are plain Bedrock IDs but must be **bare**: mantle does not support
//! cross-region inference profiles, so `us.anthropic.…` is rejected with a 400.
//! Per-agent overrides stored in the DB (and the `~/.prism` bootstrap seed) have
//! those prefixes, so the dispatcher strips them — this is the one chokepoint every
//! override flows through, and it keeps the stored value portable if the operator
//! switches back to `LLM_PROVIDER=bedrock`.
//!
//! Routing: a `base_url` argument (the Lens Agents mantle mount, computed from
//! `NEXUS_API_URL` as `…/llm/bedrock-mantle/anthropic/{region}/v1`) overrides the
//! direct endpoint; unset → straight to the AWS endpoint.
//!
//! Auth: the Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK` — the same credential the
//! native path uses) is sent as the `x-api-key` header, with `anthropic-version:
//! 2023-06-01` added by the SDK. There is no SigV4 path here: the Anthropic SDK
//! cannot sign, so direct mode requires the key. The key may be a
//! `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire —
//! transparent here, as on the other two providers.
//!
//! Feature caveat: mantle rejects structured outputs (`output_config.format`) with a
//! 400. `invoke.rs` never asks for them; the one `generate_object` caller (the
//! thread reply classifier) already catches and falls back.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde_json::json;

use crate::ai::providers::anthropic::{AnthropicProviderSettings, create_anthropic};
use crate::ai::{LanguageModel, with_llm_cache};
use crate::config::{CONFIG, Config};
use crate::lib::llm_providers::bedrock_model_id::is_anthropic_model_id;
use crate::lib::llm_providers::llm_provider::{
    CacheTtl, LlmProvider, anthropic_cache_point, provider_options,
};
use crate::{log_info, log_warn};

/// Cross-region inference profile prefixes (`us.`, `eu.`, `global.`, …). These are
/// valid on bedrock-runtime and rejected by mantle.
static INFERENCE_PROFILE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(us-gov|us|eu|apac|jp|au|ca|global)\.").unwrap());

/// Model ids already warned about, so the diagnostic stays a diagnostic.
///
/// A migrated deployment whose agent row still holds `us.anthropic.…` hits the
/// stripping path on *every* chat turn, heartbeat gate and thread classification —
/// that is the steady state the feature exists to support, not an anomaly, and
/// warning each time buries the signal in its own noise. One line per distinct id
/// per process says the same thing once.
static WARNED_PREFIXED_IDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Same idea for model ids that aren't on mantle's Anthropic surface at all.
static WARNED_NON_ANTHROPIC_IDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Strip a cross-region inference profile prefix, so a model ID configured for
/// bedrock-runtime still resolves on mantle. Bare IDs and ARNs pass through.
pub fn to_bare_bedrock_model_id(model_id: &str) -> String {
    let bare = INFERENCE_PROFILE_PREFIX.replace(model_id, "").into_owned();
    if bare != model_id && WARNED_PREFIXED_IDS.lock().insert(model_id.to_string()) {
        log_warn!(
            json!({ "modelId": model_id, "bare": bare }),
            "Stripped cross-region inference-profile prefix — bedrock-mantle has no inference profiles"
        );
    }
    bare
}

/// The settings the Anthropic SDK is created with for `base_url`.
fn bedrock_mantle_settings(config: &Config, base_url: &str) -> AnthropicProviderSettings {
    // On the gateway the real Bedrock credential is injected on the outbound leg, so
    // no local key is needed — but the SDK insists on one, so fall back to a decoy
    // (same pattern as the Azure provider).
    let decoyable_key = config
        .bedrock_api_key
        .clone()
        .filter(|key| !key.is_empty())
        .or_else(|| {
            config
                .is_gateway_endpoint(Some(base_url))
                .then(|| "nexus-managed".to_string())
        });
    AnthropicProviderSettings {
        api_key: decoyable_key,
        base_url: Some(base_url.to_string()),
        ..Default::default()
    }
}

/// Create a Bedrock Mantle provider.
///
/// `base_url` is the resolved chat endpoint — `BEDROCK_MANTLE_BASE_URL`, else the
/// Lens Agents mantle mount, else the AWS mantle host for the region.
/// `CONFIG.bedrock_mantle_chat_endpoint` decides between them. An endpoint on the
/// gateway has the credential itself; anywhere else needs the Bedrock API key.
pub fn create_bedrock_mantle_provider(base_url: &str) -> LlmProvider {
    create_bedrock_mantle_provider_for(&CONFIG, base_url)
}

fn create_bedrock_mantle_provider_for(config: &Config, base_url: &str) -> LlmProvider {
    let gateway_serves_it = config.is_gateway_endpoint(Some(base_url));
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating Bedrock Mantle provider (Anthropic Messages surface)"
    );

    // Chat/classification — the SDK builds `${baseURL}/messages`, so the base must
    // end at `…/anthropic/v1` (direct) or
    // `…/llm/bedrock-mantle/anthropic/{region}/v1` (gateway).
    let anthropic = Arc::new(create_anthropic(bedrock_mantle_settings(config, base_url)));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                let bare = to_bare_bedrock_model_id(model_id);
                if !is_anthropic_model_id(&bare)
                    && WARNED_NON_ANTHROPIC_IDS.lock().insert(bare.clone())
                {
                    // Mantle's other surfaces (OpenAI Responses / Chat Completions) aren't
                    // implemented here, so a non-Anthropic model 404s. Warn rather than
                    // throw — the model ID is operator config, and a log beats a cryptic
                    // 404. Deduped for the same reason as the prefix warning: a
                    // misconfigured model id is a standing condition, not a per-request
                    // event.
                    log_warn!(
                        json!({ "modelId": bare }),
                        "bedrock-mantle exposes only its Anthropic surface here; a non-Anthropic model will not resolve"
                    );
                }
                Ok(with_llm_cache(anthropic.language_model(&bare)))
            },
        ),
        Arc::new(|_model_id: &str, ttl: Option<CacheTtl>| anthropic_cache_point(ttl)),
    );
    // Mantle rejects Anthropic's native structured-output path with a 400
    // ("output_config.format: Extra inputs are not permitted"), so ask the SDK for
    // the tool-based JSON path instead.
    provider.structured_output_options = Some(provider_options(
        json!({ "anthropic": { "structuredOutputMode": "jsonTool" } }),
    ));
    provider
}

/// The settings Bedrock Mantle still needs, by variable name; empty when it can
/// serve requests. Through the gateway it needs none, since the gateway holds the
/// Bedrock credential. Direct mode needs the API key: unlike the native Bedrock
/// provider there is no SigV4 fallback, and without an explicit key the Anthropic
/// SDK would pick up an ambient `ANTHROPIC_API_KEY` instead.
pub fn missing_bedrock_mantle_settings() -> Vec<String> {
    missing_bedrock_mantle_settings_for(&CONFIG)
}

fn missing_bedrock_mantle_settings_for(config: &Config) -> Vec<String> {
    if config
        .nexus_bedrock_mantle_base_url
        .as_deref()
        .is_some_and(|url| !url.is_empty())
    {
        return Vec::new();
    }
    if config.bedrock_api_key.as_deref().unwrap_or("").is_empty() {
        vec!["AWS_BEARER_TOKEN_BEDROCK".to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::llm_providers::llm_provider::{provider_options_json, test_config};

    const MANTLE: &str = "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1";
    const MOUNT: &str = "https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1";
    const GATEWAY: (&str, &str) = ("NEXUS_API_URL", "https://gateway.example.com");
    const KEY: (&str, &str) = ("AWS_BEARER_TOKEN_BEDROCK", "bedrock-key");

    #[test]
    fn keeps_the_gate_default_of_temperature_0_which_haiku_4_5_accepts() {
        let provider = create_bedrock_mantle_provider_for(&test_config(&[KEY]), MANTLE);
        assert!(provider.classification_sampling_params.is_none());
    }

    #[test]
    fn sends_requests_to_the_endpoint_it_is_given() {
        let settings = bedrock_mantle_settings(&test_config(&[KEY]), MANTLE);
        assert_eq!(settings.api_key.as_deref(), Some("bedrock-key"));
        assert_eq!(settings.base_url.as_deref(), Some(MANTLE));
    }

    #[test]
    fn a_gateway_endpoint_without_a_local_key_falls_back_to_a_decoy() {
        let settings = bedrock_mantle_settings(&test_config(&[GATEWAY]), MOUNT);
        assert_eq!(settings.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_override_on_the_gateway_host_also_gets_the_decoy() {
        let settings = bedrock_mantle_settings(
            &test_config(&[GATEWAY]),
            "https://gateway.example.com/projects/p/llm/mantle/anthropic/v1",
        );
        assert_eq!(settings.api_key.as_deref(), Some("nexus-managed"));
    }

    #[test]
    fn an_endpoint_off_the_gateway_host_without_a_key_sends_no_decoy() {
        // A decoy would promise a credential injection that nothing performs.
        let settings = bedrock_mantle_settings(&test_config(&[GATEWAY]), MANTLE);
        assert_eq!(settings.api_key, None);
    }

    fn dispatched(model_id: &str) -> String {
        create_bedrock_mantle_provider_for(&test_config(&[KEY]), MANTLE)
            .model(model_id)
            .unwrap()
            .model_id()
            .to_string()
    }

    #[test]
    fn dispatches_bare_anthropic_model_ids_unchanged() {
        assert_eq!(
            dispatched("anthropic.claude-opus-5"),
            "anthropic.claude-opus-5"
        );
    }

    #[test]
    fn strips_the_cross_region_inference_profile_prefix() {
        for configured in [
            "us.anthropic.claude-opus-5",
            "eu.anthropic.claude-opus-5",
            "apac.anthropic.claude-opus-5",
            "us-gov.anthropic.claude-opus-5",
            "global.anthropic.claude-opus-5",
        ] {
            assert_eq!(dispatched(configured), "anthropic.claude-opus-5");
        }
    }

    #[test]
    fn leaves_an_inference_profile_arn_alone() {
        let arn =
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5";
        assert_eq!(dispatched(arn), arn);
    }

    #[test]
    fn still_dispatches_a_non_anthropic_model_id() {
        assert_eq!(dispatched("openai.gpt-oss-120b"), "openai.gpt-oss-120b");
    }

    #[test]
    fn asks_for_the_tool_based_json_path_since_mantle_rejects_native_structured_output() {
        let provider = create_bedrock_mantle_provider_for(&test_config(&[KEY]), MANTLE);
        assert_eq!(
            provider_options_json(provider.structured_output_options.as_ref().unwrap()),
            json!({ "anthropic": { "structuredOutputMode": "jsonTool" } })
        );
    }

    #[test]
    fn to_bare_bedrock_model_id_strips_any_case_of_prefix() {
        for (input, expected) in [
            ("us.anthropic.claude-opus-5", "anthropic.claude-opus-5"),
            ("US.anthropic.claude-opus-5", "anthropic.claude-opus-5"),
            ("jp.anthropic.claude-opus-5", "anthropic.claude-opus-5"),
        ] {
            assert_eq!(to_bare_bedrock_model_id(input), expected);
        }
        for input in [
            "anthropic.claude-opus-5",
            "amazon.titan-embed-text-v2:0",
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5",
        ] {
            assert_eq!(to_bare_bedrock_model_id(input), input);
        }
    }

    #[test]
    fn missing_settings_are_none_with_a_key() {
        assert!(missing_bedrock_mantle_settings_for(&test_config(&[KEY])).is_empty());
    }

    #[test]
    fn missing_settings_are_none_on_the_gateway_without_a_key() {
        assert!(missing_bedrock_mantle_settings_for(&test_config(&[GATEWAY])).is_empty());
    }

    #[test]
    fn missing_settings_name_the_bedrock_api_key_off_the_gateway() {
        assert_eq!(
            missing_bedrock_mantle_settings_for(&test_config(&[])),
            ["AWS_BEARER_TOKEN_BEDROCK"]
        );
    }
}
