//! Bedrock provider.
//!
//! Chat generation dispatches on the model family: Anthropic models go through the
//! Anthropic-native Bedrock provider (Messages API via InvokeModel), and any other
//! model — Kimi, Llama, Mistral, etc. — goes through the generic provider which
//! uses Bedrock's Converse API (which normalizes tool/message shapes across
//! vendors).
//!
//! Why this matters: the Anthropic-native provider hardcodes Anthropic's tool wire
//! format (`{ name, description, input_schema }`). Pointing it at a Kimi model
//! surfaces a Bedrock deserialization error ("Invalid 'tools': missing field type")
//! because Kimi expects OpenAI-shaped tool definitions.
//!
//! On the Converse branch, `converse_tool_images` moves each tool-result image into
//! the user turn beside it, since most Converse models read no image in a result.
//!
//! Routing: `create_bedrock_provider(base_url)` runs direct to AWS (unset) or
//! through the Mirantis Agent Platform LLM gateway (a `base_url` — the gateway re-signs, tracks
//! usage, and audits, so no local credentials are used). Direct mode has two auth
//! paths, picked automatically by the SDK from the environment:
//!
//! 1. Bearer token: when `AWS_BEARER_TOKEN_BEDROCK` is set, the Bedrock SDK
//!    short-circuits SigV4 and sends `Authorization: Bearer <token>` directly to
//!    Bedrock. The env var may hold a `__nexus_cred:<uuid>__` sentinel that the
//!    MITM proxy rewrites on the wire to the real Bedrock API key.
//!
//! 2. SigV4: when no bearer token is set, the SDK uses the shared credential
//!    provider options — ECS task role / container metadata in production,
//!    explicit access keys for local dev.

use std::sync::Arc;

use super::aws_credential_source::has_aws_credential_source;
use super::converse_tool_images::CONVERSE_TOOL_IMAGES;
use crate::ai::providers::amazon_bedrock::anthropic::create_bedrock_anthropic;
use crate::ai::providers::amazon_bedrock::{AmazonBedrockProviderSettings, create_amazon_bedrock};
use crate::ai::{LanguageModel, WrapLanguageModelOptions, with_llm_cache, wrap_language_model};
use crate::config::{CONFIG, Config};
use crate::lib::llm_providers::bedrock_model_id::is_anthropic_model_id;
use crate::lib::llm_providers::bedrock_shared::create_shared_bedrock_options;
use crate::lib::llm_providers::deferred_tools::{
    ANTHROPIC_DEFERRED_TOOLS, deferred_tools_when, supports_anthropic_deferred_tools,
};
use crate::lib::llm_providers::llm_provider::{
    ANTHROPIC_THINKING_OFF, BEDROCK_CACHE_POINT, CachePointFragment, CacheTtl,
    ClassificationSamplingParams, LlmProvider, NO_CACHE_POINT, PromptCacheState,
    anthropic_cache_point,
};
use crate::lib::llm_providers::tool_changes::{ANTHROPIC_TOOL_CHANGES, supports_tool_changes};
use crate::log_info;
use serde_json::json;

/// Create an Amazon Bedrock provider that dispatches on model family.
///
/// Returns a dispatcher for chat:
///  - Anthropic chat model IDs route through the Anthropic-native provider.
///  - Anything else routes through the generic Converse-API provider.
///
/// The settings Bedrock still needs: none through the gateway, with a bearer token
/// or explicit keys, or when the AWS default chain has a source. The bearer token
/// is the one the docs ask for.
pub async fn missing_bedrock_settings() -> Vec<String> {
    if !needs_credential_source(&CONFIG) || has_aws_credential_source().await {
        return Vec::new();
    }
    vec!["AWS_BEARER_TOKEN_BEDROCK".to_string()]
}

/// False when the gateway, a bearer token or explicit keys supply the credential,
/// so the AWS default chain is not asked.
fn needs_credential_source(config: &Config) -> bool {
    let set = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
    !(set(&config.nexus_llm_base_url)
        || set(&config.bedrock_api_key)
        || (set(&config.aws_access_key_id) && set(&config.aws_secret_access_key)))
}

/// `base_url` selects routing: unset → direct AWS (credentials via explicit keys or
/// the default credential chain); set → the Mirantis Agent Platform gateway, which does its own
/// signing (so no local credentials are attached).
pub fn create_bedrock_provider(base_url: Option<&str>) -> LlmProvider {
    log_info!(
        json!({ "routing": if base_url.is_some() { "nexus" } else { "direct" } }),
        "Creating Bedrock provider"
    );

    let shared_options = match base_url {
        Some(url) => AmazonBedrockProviderSettings {
            region: Some(CONFIG.aws_region.clone()),
            base_url: Some(url.to_string()),
            ..Default::default()
        },
        None => create_shared_bedrock_options(),
    };
    bedrock_provider_from(shared_options)
}

/// The dispatcher and the vendor's declarations, on resolved provider settings.
/// Every model is handed out behind the E2E LLM cache.
fn bedrock_provider_from(shared_options: AmazonBedrockProviderSettings) -> LlmProvider {
    let anthropic = Arc::new(create_bedrock_anthropic(shared_options.clone()));
    let generic = Arc::new(create_amazon_bedrock(shared_options));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                let model = if is_anthropic_model_id(model_id) {
                    anthropic.language_model(model_id)?
                } else {
                    wrap_language_model(WrapLanguageModelOptions {
                        model: generic.language_model(model_id),
                        middleware: Arc::new(CONVERSE_TOOL_IMAGES),
                    })
                };
                Ok(with_llm_cache(model))
            },
        ),
        Arc::new(prompt_cache_fragment),
    );
    // Haiku 5.5, the classification default, rejects an explicit temperature and
    // can think unasked. The Anthropic SDK reads `anthropic.thinking` for Bedrock
    // models too.
    provider.classification_provider_options = Some(ANTHROPIC_THINKING_OFF.clone());
    provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
    // Derived from the fragment rather than repeating the rule, so the startup line
    // cannot disagree with what the request has.
    provider.prompt_cache_state = Some(Arc::new(|model_id: &str| {
        if prompt_cache_fragment(model_id, None).is_empty() {
            PromptCacheState::Off
        } else {
            PromptCacheState::On
        }
    }));
    // Every model on the list is a Claude id, so it runs on the Anthropic Messages
    // branch; Converse never gets one.
    provider.tool_changes = Some(Arc::new(|model_id: &str| {
        if supports_tool_changes(model_id) {
            Some(&*ANTHROPIC_TOOL_CHANGES)
        } else {
            None
        }
    }));
    provider.deferred_tools = Some(deferred_tools_when(
        supports_anthropic_deferred_tools,
        &ANTHROPIC_DEFERRED_TOOLS,
    ));
    provider
}

/// Bedrock model families known to accept a Converse prompt-cache breakpoint.
///
/// Empty, which is the honest answer and not an oversight. A Bedrock model without
/// prompt-cache support answers a request that has a `cachePoint` block with "You
/// invoked an unsupported model or your request did not allow prompt caching", so
/// every turn fails, and no source this runtime can read says which model supports
/// one: AWS publishes no per-model capability, the Bedrock SDK has none (its one
/// model-support module answers tool and structured-output questions), and the
/// model catalog holds context windows only. A guess here is a dead agent.
///
/// This list is the extension point. Add the family fragment — matched inside the
/// model id, so one entry covers the `us.`/`eu.`/`global.` inference profiles and
/// the version suffixes — once a citable source establishes that family's support.
const CONVERSE_PROMPT_CACHE_FAMILIES: &[&str] = &[];

/// The prompt-cache breakpoint fragment for one Bedrock model.
///
/// Dispatched like the model itself, because the breakpoint belongs to the
/// protocol rather than to the vendor: the Anthropic-native provider reads
/// Anthropic's namespace, Converse reads Bedrock's, and a fragment in the wrong one
/// is discarded without an error.
///
/// Claude always gets its breakpoint. A Converse model gets one only when its
/// family is on the list above, so a model whose support is unknown runs uncached
/// instead of failing every turn.
fn prompt_cache_fragment(model_id: &str, ttl: Option<CacheTtl>) -> CachePointFragment {
    if is_anthropic_model_id(model_id) {
        return anthropic_cache_point(ttl);
    }
    let known_to_cache = CONVERSE_PROMPT_CACHE_FAMILIES
        .iter()
        .any(|family| model_id.contains(family));
    if known_to_cache {
        BEDROCK_CACHE_POINT
    } else {
        NO_CACHE_POINT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_config;

    fn provider() -> LlmProvider {
        bedrock_provider_from(AmazonBedrockProviderSettings {
            region: Some("us-west-2".into()),
            api_key: Some("test-key".into()),
            ..Default::default()
        })
    }

    #[test]
    fn routes_anthropic_model_ids_through_the_anthropic_native_provider() {
        let model = provider()
            .model("global.anthropic.claude-opus-5-5")
            .unwrap();
        assert_eq!(model.provider(), "bedrock.anthropic.messages");
        assert_eq!(model.model_id(), "global.anthropic.claude-opus-5-5");
    }

    #[test]
    fn routes_other_model_ids_through_the_converse_provider() {
        let model = provider().model("moonshotai.kimi-k2.5").unwrap();
        assert_eq!(model.provider(), "amazon-bedrock");
        assert_eq!(model.model_id(), "moonshotai.kimi-k2.5");
    }

    #[test]
    fn declares_no_structured_output_options() {
        assert!(provider().structured_output_options.is_none());
    }

    #[test]
    fn sends_the_gates_no_temperature() {
        assert_eq!(
            provider().classification_sampling_params,
            Some(ClassificationSamplingParams::default())
        );
        assert_eq!(
            serde_json::to_value(ClassificationSamplingParams::default()).unwrap(),
            json!({})
        );
    }

    #[test]
    fn gives_anthropic_models_the_anthropic_cache_control_fragment() {
        assert_eq!(
            provider()
                .cache_point("global.anthropic.claude-opus-5-5", None)
                .to_json(),
            json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } })
        );
    }

    #[test]
    fn asks_a_claude_model_for_the_cache_lifetime_it_is_given() {
        let provider = provider();
        let one_hour =
            json!({ "anthropic": { "cacheControl": { "type": "ephemeral", "ttl": "1h" } } });
        let five_minutes = json!({ "anthropic": { "cacheControl": { "type": "ephemeral" } } });
        let point = |id: &str, ttl| provider.cache_point(id, Some(ttl)).to_json();
        assert_eq!(
            point("global.anthropic.claude-opus-5-5", CacheTtl::OneHour),
            one_hour
        );
        assert_eq!(
            point(
                "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                CacheTtl::OneHour
            ),
            one_hour
        );
        assert_eq!(
            point("global.anthropic.claude-opus-5-5", CacheTtl::FiveMinutes),
            five_minutes
        );
        assert_eq!(point("us.xai.grok-4.6", CacheTtl::OneHour), json!({}));
    }

    /// A Bedrock model without prompt-cache support refuses a request that has a
    /// `cachePoint` block, and no source names the Converse models that have it.
    #[test]
    fn gives_no_converse_model_a_breakpoint() {
        let provider = provider();
        for id in [
            "us.xai.grok-4.6",
            "global.xai.grok-4.6",
            "us.amazon.nova-2-lite-v1:0",
            "moonshotai.kimi-k2.5",
            "meta.llama3-70b-instruct-v1:0",
        ] {
            assert!(provider.cache_point(id, None).is_empty(), "{id}");
        }
    }

    #[test]
    fn reports_prompt_cache_state_on_for_claude_and_off_for_converse() {
        let provider = provider();
        assert_eq!(
            provider.prompt_cache_state("global.anthropic.claude-opus-5-5"),
            Some(PromptCacheState::On)
        );
        assert_eq!(
            provider.prompt_cache_state("us.xai.grok-4.6"),
            Some(PromptCacheState::Off)
        );
        assert_eq!(
            provider.prompt_cache_state("us.amazon.nova-2-lite-v1:0"),
            Some(PromptCacheState::Off)
        );
    }

    #[test]
    fn takes_mid_conversation_tool_changes_on_the_listed_claude_models() {
        let provider = provider();
        let tool_changes = provider.tool_changes.as_ref().unwrap();
        for id in [
            "global.anthropic.claude-opus-5-5",
            "us.anthropic.claude-opus-5-5",
            "anthropic.claude-opus-5-5",
            "global.anthropic.claude-opus-4-8",
            "us.anthropic.claude-sonnet-5-5",
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
        ] {
            assert!(
                tool_changes(id).is_some_and(|p| std::ptr::eq(p, &*ANTHROPIC_TOOL_CHANGES)),
                "{id}"
            );
        }
        for id in [
            "global.anthropic.claude-opus-5",
            "global.anthropic.claude-sonnet-5",
            "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            "us.xai.grok-4.6",
            "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
        ] {
            assert!(tool_changes(id).is_none(), "{id}");
        }
    }

    #[test]
    fn defers_tools_on_claude_4_and_later() {
        let provider = provider();
        let deferred = provider.deferred_tools.as_ref().unwrap();
        for id in [
            "global.anthropic.claude-opus-5-5",
            "us.anthropic.claude-opus-4-7",
            "global.anthropic.claude-haiku-5-5",
            "global.anthropic.claude-opus-6",
            "global.anthropic.claude-sonnet-6-1",
            "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            "us.anthropic.claude-opus-4-20250514-v1:0",
        ] {
            assert!(
                deferred(id).is_some_and(|p| std::ptr::eq(p, &*ANTHROPIC_DEFERRED_TOOLS)),
                "{id}"
            );
        }
        for id in [
            "anthropic.claude-3-5-sonnet-20241022-v2:0",
            "anthropic.claude-v2:1",
            "anthropic.claude-instant-v1",
            "us.xai.grok-4.6",
            "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
        ] {
            assert!(deferred(id).is_none(), "{id}");
        }
    }

    #[test]
    fn asks_the_aws_chain_only_when_nothing_else_supplies_a_credential() {
        let base = [
            ("LLM_PROVIDER", "bedrock"),
            ("AWS_BEARER_TOKEN_BEDROCK", ""),
            ("AWS_ACCESS_KEY_ID", ""),
            ("AWS_SECRET_ACCESS_KEY", ""),
        ];
        assert!(needs_credential_source(&test_config(&base)));
        for set in [
            vec![("NEXUS_API_URL", "https://gateway.example.com")],
            vec![("AWS_BEARER_TOKEN_BEDROCK", "example-token")],
            vec![
                ("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE"),
                ("AWS_SECRET_ACCESS_KEY", "example-secret"),
            ],
        ] {
            let vars: Vec<(&str, &str)> = base
                .iter()
                .filter(|(k, _)| !set.iter().any(|(s, _)| s == k))
                .copied()
                .chain(set.iter().copied())
                .collect();
            assert!(!needs_credential_source(&test_config(&vars)), "{set:?}");
        }
        // One key of the pair is not a credential.
        assert!(needs_credential_source(&test_config(&[
            ("LLM_PROVIDER", "bedrock"),
            ("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
        ])));
    }
}
