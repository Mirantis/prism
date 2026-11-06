//! Classification-gate model factory.
//!
//! Goes through the unified `create_provider()`, so it inherits whatever vendor and
//! routing (direct or gateway) the runtime is configured for. The classifier uses a
//! fast model (`classification_model_id`) supported on either provider.
//!
//! Kept in its own module (rather than in `create_provider.rs`) so the provider
//! factories never import `create_provider`, keeping that a leaf factory with no
//! import cycle.

use std::sync::Arc;

use crate::ai::LanguageModel;
use crate::config::CONFIG;
use crate::lib::llm_providers::create_provider::create_provider;
use crate::lib::llm_providers::llm_provider::{
    ClassificationSamplingParams, ProviderOptionsFragment, merge_provider_options, provider_options,
};

/// The sampling params a gate sends when the vendor declares none:
/// `{ temperature: 0 }`.
pub const DEFAULT_GATE_SAMPLING: ClassificationSamplingParams = ClassificationSamplingParams {
    temperature: Some(0.0),
};

/// Everything a plain-text (`generate_text`) gate call needs.
#[derive(Clone)]
pub struct GateRequest {
    pub model: Arc<dyn LanguageModel>,
    /// The active vendor's classification `providerOptions` — empty when the
    /// model's defaults already suit the gates.
    pub provider_options: ProviderOptionsFragment,
    /// Smallest legal `maxOutputTokens` on the active vendor (0 = any). Most gates
    /// simply cap at 16 — the highest floor any vendor has — but a latency-tuned
    /// site can take `max(its_cap, min_output_tokens)` to keep a tighter cap where
    /// that is legal.
    pub min_output_tokens: i64,
    /// Applied to the call where `temperature: 0` used to be hardcoded:
    /// deterministic verdicts on the vendors that accept the param, omitted
    /// entirely on the ones that reject or strip it.
    pub sampling_params: ClassificationSamplingParams,
}

/// Everything a structured-output (`generate_object`) classification call needs.
#[derive(Clone)]
pub struct ClassificationRequest {
    pub model: Arc<dyn LanguageModel>,
    /// The classification options (see `get_gate_request`) plus whatever the
    /// vendor needs for structured output specifically.
    pub provider_options: ProviderOptionsFragment,
    /// See `GateRequest::sampling_params` — same contract.
    pub sampling_params: ClassificationSamplingParams,
}

/// Everything a plain-text (`generate_text`) gate call needs: the model, and the
/// active vendor's classification `providerOptions` — empty when the model's
/// defaults already suit the gates.
///
/// Both come from **one** `create_provider()`. That matters: the factory is not a
/// cheap accessor. On Bedrock it builds a fresh AWS credential-provider chain and
/// instantiates two SDK clients, so resolving the model and the options separately
/// would pay that twice on what is a per-message hot path.
///
/// Callers take `provider_options` as given rather than naming a vendor: that a
/// GPT-5.x classification model needs reasoning pinned off for the gates'
/// `temperature: 0` and tiny token budgets to hold is the provider's business, not
/// theirs.
///
/// Fails where the provider's dispatcher fails (LiteLLM without a key).
pub fn get_gate_request() -> anyhow::Result<GateRequest> {
    let provider = create_provider();
    Ok(GateRequest {
        model: provider.model(&CONFIG.classification_model_id)?,
        provider_options: provider
            .classification_provider_options
            .clone()
            .unwrap_or_else(|| provider_options(serde_json::json!({}))),
        min_output_tokens: provider.classification_min_output_tokens.unwrap_or(0),
        sampling_params: provider
            .classification_sampling_params
            .unwrap_or(DEFAULT_GATE_SAMPLING),
    })
}

/// Everything a structured-output (`generate_object`) classification call needs:
/// the model, and the active vendor's `providerOptions` — the classification
/// options (see `get_gate_request`) plus whatever the vendor needs for structured
/// output specifically (some platforms reject the SDK's native path — which ones is
/// the provider's business, not the caller's).
pub fn get_classification_request() -> anyhow::Result<ClassificationRequest> {
    let provider = create_provider();
    Ok(ClassificationRequest {
        model: provider.model(&CONFIG.classification_model_id)?,
        provider_options: merge_provider_options([
            provider.classification_provider_options.as_ref(),
            provider.structured_output_options.as_ref(),
        ]),
        sampling_params: provider
            .classification_sampling_params
            .unwrap_or(DEFAULT_GATE_SAMPLING),
    })
}
