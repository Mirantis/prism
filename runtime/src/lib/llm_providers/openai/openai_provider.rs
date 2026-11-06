//! OpenAI provider — the official OpenAI API.
//!
//! Unlike the other vendors this one serves OpenAI models, not Claude.
//! `create_openai()(modelId)` dispatches to the **Responses API** (the SDK's
//! default), so a custom endpoint — direct override or gateway — must serve
//! `/responses`, not just `/chat/completions`.
//!
//! Routing: the `base_url` argument is the resolved endpoint — `OPENAI_BASE_URL`,
//! else the Lens Agents OpenAI mount (`…/llm/openai/v1`), else `None` for
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

use crate::config::{CONFIG, is_gateway_endpoint};
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
    let gateway_serves_it = is_gateway_endpoint(base_url);
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating OpenAI provider"
    );

    let mut provider = create_open_ai_compatible_provider(OpenAiCompatibleOptions {
        // On the gateway the real key is injected on the outbound leg, so no local
        // key is needed — but the SDK insists on one, so fall back to a decoy (the
        // same pattern as the Azure and mantle factories).
        api_key: CONFIG
            .openai_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| gateway_serves_it.then(|| "nexus-managed".to_string())),
        // None → the SDK's own default, https://api.openai.com/v1.
        base_url: base_url.map(str::to_string),
    });
    provider.deferred_tools = Some(deferred_tools_when(
        supports_open_ai_deferred_tools,
        &OPENAI_DEFERRED_TOOLS,
    ));
    provider.cache_request = Some(Arc::new(open_ai_cache_request));
    provider.cache_ttl_ms = Some(Arc::new(open_ai_cache_ttl_ms));
    provider
}

/// `1h` asks for a 12-hour entry, the one lifetime OpenAI offers past its 30-minute
/// default. `prompt_cache_options` exists from GPT-5.6 on, and an earlier model
/// refuses it, so `5m` sends nothing. Under `1h` a request that must not write sends
/// explicit mode, which writes nothing without breakpoints. Under `5m` such a
/// request writes its prompt once; that is the trade for sending nothing an earlier
/// model refuses.
fn open_ai_cache_request(_model_id: &str, ttl: CacheTtl, write: bool) -> ProviderOptionsFragment {
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

fn open_ai_cache_ttl_ms(_model_id: &str, ttl: CacheTtl) -> i64 {
    if ttl == CacheTtl::OneHour {
        12 * 60 * 60 * 1000
    } else {
        30 * 60 * 1000
    }
}

/// The settings OpenAI still needs, by variable name; empty when it can serve
/// requests. Through the gateway it needs none, since the gateway holds the key.
pub fn missing_open_ai_settings() -> Vec<String> {
    if CONFIG.nexus_open_ai_base_url.is_some() {
        return Vec::new();
    }
    if CONFIG.openai_api_key.as_deref().unwrap_or("").is_empty() {
        vec!["OPENAI_API_KEY".to_string()]
    } else {
        Vec::new()
    }
}
