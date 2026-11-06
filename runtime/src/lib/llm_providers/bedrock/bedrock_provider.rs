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
//! through the Lens Agents LLM gateway (a `base_url` — the gateway re-signs, tracks
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

use super::converse_tool_images::CONVERSE_TOOL_IMAGES;
use crate::ai::providers::amazon_bedrock::anthropic::create_bedrock_anthropic;
use crate::ai::providers::amazon_bedrock::{AmazonBedrockProviderSettings, create_amazon_bedrock};
use crate::ai::{LanguageModel, WrapLanguageModelOptions, wrap_language_model};
use crate::config::CONFIG;
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
/// `base_url` selects routing: unset → direct AWS (credentials via explicit keys or
/// the default credential chain); set → the Lens Agents gateway, which does its own
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
    let anthropic = Arc::new(create_bedrock_anthropic(shared_options.clone()));
    let generic = Arc::new(create_amazon_bedrock(shared_options));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                if is_anthropic_model_id(model_id) {
                    Ok(anthropic.language_model(model_id))
                } else {
                    Ok(wrap_language_model(WrapLanguageModelOptions {
                        model: generic.language_model(model_id),
                        middleware: Arc::new(CONVERSE_TOOL_IMAGES),
                    }))
                }
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
