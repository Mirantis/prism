//! Anthropic provider — the first-party Anthropic API.
//!
//! Chat and classification speak the Anthropic Messages API at api.anthropic.com
//! (or `ANTHROPIC_BASE_URL`; must end at `/v1` — the SDK appends `/messages`).
//! Model IDs are bare first-party IDs (e.g. `claude-opus-5`). The other Claude
//! vendors are structural copies of this shape at other hosts; here the SDK's own
//! defaults already point at the right place.
//!
//! Per-agent overrides stored in the DB (and the `~/.prism` bootstrap seed) may have
//! Bedrock spellings from before a deployment switched vendors —
//! `us.anthropic.claude-opus-5`, `anthropic.claude-haiku-4-5-20251001-v1:0` — which
//! api.anthropic.com 404s. The dispatcher maps those to their embedded first-party
//! id, the same chokepoint normalization the mantle provider does for its prefix
//! rule, so switching an existing deployment over does not break its stored model.
//!
//! Routing: direct-only — the factory takes no base URL argument, and
//! `missing_anthropic_settings()` always requires the key. The key is sent as the
//! `x-api-key` header, with `anthropic-version` added by the SDK.
//!
//! api.anthropic.com accepts the SDK's native structured-output path (unlike
//! Foundry and mantle, which declare `structured_output_options`) and any positive
//! token cap, so those declarations stay unset. The gates send no temperature and
//! turn thinking off, because the default classification model, Haiku 5.5, rejects
//! the first and can do the second unasked.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use regex::Regex;
use serde_json::json;

use crate::ai::LanguageModel;
use crate::ai::providers::anthropic::{AnthropicProviderSettings, create_anthropic};
use crate::config::CONFIG;
use crate::lib::llm_providers::llm_provider::{
    ANTHROPIC_THINKING_OFF, CacheTtl, ClassificationSamplingParams, LlmProvider,
    anthropic_cache_point,
};
use crate::{log_info, log_warn};

/// A Bedrock spelling of a Claude id: an optional cross-region inference-profile
/// prefix, the `anthropic.` vendor prefix, then the first-party id, with an
/// optional `-v1:0`-style Bedrock version artifact. ARNs don't match and pass
/// through untouched.
static BEDROCK_ID_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:(?:us-gov|us|eu|apac|jp|au|ca|global)\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$",
    )
    .unwrap()
});

/// Model ids already warned about, so the diagnostic stays a diagnostic — a
/// migrated deployment whose agent row still holds a Bedrock spelling hits this on
/// every turn (same rationale as the mantle prefix warning).
static WARNED_BEDROCK_IDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Map a Bedrock spelling of a Claude id to the first-party id it embeds, so a
/// model ID configured for Bedrock still resolves on api.anthropic.com. Bare
/// first-party ids (and anything else) pass through unchanged.
pub fn to_first_party_model_id(model_id: &str) -> String {
    let Some(captures) = BEDROCK_ID_SHAPE.captures(model_id) else {
        return model_id.to_string();
    };
    let bare = captures[1].to_string();
    if WARNED_BEDROCK_IDS.lock().insert(model_id.to_string()) {
        log_warn!(
            json!({ "modelId": model_id, "bare": bare }),
            "Mapped a Bedrock-style model id to its first-party spelling — api.anthropic.com serves bare ids"
        );
    }
    bare
}

pub fn create_anthropic_provider() -> LlmProvider {
    log_info!(
        json!({ "routing": "direct" }),
        "Creating Anthropic provider (first-party Messages API)"
    );

    let anthropic = Arc::new(create_anthropic(AnthropicProviderSettings {
        // Explicit rather than the SDK's ambient ANTHROPIC_API_KEY fallback, so the
        // credential in use is the one config reports.
        api_key: CONFIG.anthropic_api_key.clone(),
        // None → the SDK's own default, https://api.anthropic.com/v1.
        base_url: CONFIG.anthropic_base_url.clone(),
        ..Default::default()
    }));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                Ok(anthropic.language_model(&to_first_party_model_id(model_id)))
            },
        ),
        Arc::new(|_model_id: &str, ttl: Option<CacheTtl>| anthropic_cache_point(ttl)),
    );
    provider.classification_provider_options = Some(ANTHROPIC_THINKING_OFF.clone());
    provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
    provider
}

/// The settings Anthropic still needs, by variable name; empty when it can serve
/// requests. Direct-only, so the API key is always required.
pub fn missing_anthropic_settings() -> Vec<String> {
    if CONFIG.anthropic_api_key.as_deref().unwrap_or("").is_empty() {
        vec!["ANTHROPIC_API_KEY".to_string()]
    } else {
        Vec::new()
    }
}
