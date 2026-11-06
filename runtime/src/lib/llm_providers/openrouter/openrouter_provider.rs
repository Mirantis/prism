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
//! Auth: `OPENROUTER_API_KEY`, sent as a bearer header, read verbatim so it may be
//! a `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire. An
//! endpoint on the gateway needs no local key — the gateway holds the OpenRouter
//! credential and injects it on the outbound leg — but the SDK insists on one, so
//! fall back to a decoy like the Azure/mantle factories do.

use serde_json::json;

use crate::config::{CONFIG, is_gateway_endpoint};
use crate::lib::llm_providers::llm_provider::LlmProvider;
use crate::lib::llm_providers::openai_compatible::{
    OpenAiCompatibleOptions, create_open_ai_compatible_provider,
};
use crate::log_info;

pub fn create_open_router_provider(base_url: &str) -> LlmProvider {
    let gateway_serves_it = is_gateway_endpoint(Some(base_url));
    log_info!(
        json!({ "routing": if gateway_serves_it { "nexus" } else { "direct" } }),
        "Creating OpenRouter provider"
    );

    create_open_ai_compatible_provider(OpenAiCompatibleOptions {
        // On the gateway the real key is injected on the outbound leg, so no local
        // key is needed — but the SDK insists on one, so fall back to a decoy (the
        // same pattern as the Azure and mantle factories).
        api_key: CONFIG
            .openrouter_api_key
            .clone()
            .filter(|key| !key.is_empty())
            .or_else(|| gateway_serves_it.then(|| "nexus-managed".to_string())),
        base_url: Some(base_url.to_string()),
    })
}

/// The settings OpenRouter still needs, by variable name; empty when it can serve
/// requests. Through the gateway it needs none, since the gateway holds the key.
pub fn missing_open_router_settings() -> Vec<String> {
    if CONFIG.nexus_open_router_base_url.is_some() {
        return Vec::new();
    }
    if CONFIG
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
