//! The OpenAI-shaped provider both `openai` and `openrouter` are built from.
//!
//! Two vendors reach the OpenAI SDK: the official API, and OpenRouter, whose own
//! API is OpenAI-compatible. What differs between them — the endpoint, the
//! credential, the model-id convention, the startup log line — stays in their own
//! factories; everything here is a property of the *SDK surface*:
//! `create_openai()(modelId)` dispatches to the Responses API, prompt caching is
//! automatic (no breakpoints), and the Responses API's own limits shape what a gate
//! call may send.
//!
//! Shared rather than duplicated because those last three are a matched set: a copy
//! that drifts on one of them fails at the gate, not at startup — every
//! classification call 400s and the gate is silently disabled. One definition keeps
//! the two vendors from diverging by accident, and each keeps its own factory so it
//! can diverge on purpose.
//!
//! Classification caveat (why the three gate declarations exist): elsewhere the
//! gates run the classification model with `temperature: 0` and tiny output-token
//! budgets — assumptions GPT-5.x breaks three ways. `reasoningEffort: 'none'`
//! (reasoning tokens would eat the budget before the verdict), a 16-token output
//! floor (the Responses API rejects any `max_output_tokens` below 16, and a gate
//! whose every call 400s is a gate disabled), and empty sampling params — GPT-5.x
//! models reject an explicit temperature outside effort 'none', and whether the SDK
//! even forwards it there depends on its per-model support matrix. Omitting the
//! param beats tracking any of that, which is the same rule the main invoke path
//! applies: it sends no sampling params at all and runs the chat model at its
//! default reasoning effort.

use std::sync::Arc;

use serde_json::json;

use crate::ai::LanguageModel;
use crate::ai::providers::openai::{OpenAIProviderSettings, create_openai};
use crate::lib::llm_providers::llm_provider::{
    CacheTtl, ClassificationSamplingParams, LlmProvider, NO_CACHE_POINT, provider_options,
};

#[derive(Debug, Clone, Default)]
pub struct OpenAiCompatibleOptions {
    /// Key sent as the bearer header; `None` leaves the SDK's env fallback.
    pub api_key: Option<String>,
    /// Endpoint ending at `/v1`; `None` → the SDK default, api.openai.com.
    pub base_url: Option<String>,
}

pub fn create_open_ai_compatible_provider(options: OpenAiCompatibleOptions) -> LlmProvider {
    let openai = Arc::new(create_openai(OpenAIProviderSettings {
        api_key: options.api_key,
        base_url: options.base_url,
        ..Default::default()
    }));

    let mut provider = LlmProvider::new(
        Arc::new(
            move |model_id: &str| -> anyhow::Result<Arc<dyn LanguageModel>> {
                Ok(openai.language_model(model_id))
            },
        ),
        // No breakpoints: OpenAI caches long prompts automatically, so there is
        // nothing to mark and the empty fragment merges into `providerOptions` as a
        // no-op. Same on OpenRouter for the openai models it routes; a vendor whose
        // caching *is* explicit (Anthropic, Gemini) would want its own
        // `cache_control` marker, which the OpenAI SDK has no way to send — so an
        // OpenRouter deployment pointed at those models runs uncached rather than
        // wrong. Off the default path (the defaults are `openai/*`), and the fix
        // when someone wants it is a cache point of OpenRouter's own, not a setting
        // here.
        Arc::new(|_model_id: &str, _ttl: Option<CacheTtl>| NO_CACHE_POINT),
    );
    // See the classification caveat in the header: reasoning off, or the gates'
    // tiny token budgets are spent on reasoning instead of the verdict. Written for
    // GPT-5.x, which is what both vendors' defaults name; OpenRouter forwards the
    // field to whatever vendor a `vendor/model` id selects, and one that doesn't
    // understand it ignores it.
    provider.classification_provider_options = Some(provider_options(
        json!({ "openai": { "reasoningEffort": "none" } }),
    ));
    // The Responses API rejects max_output_tokens < 16.
    provider.classification_min_output_tokens = Some(16);
    // No explicit temperature: GPT-5.x rejects or strips it (see header).
    provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
    provider
}
