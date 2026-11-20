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
    ClassificationSamplingParams, LlmProvider, ProviderOptionsFragment, merge_provider_options,
    provider_options,
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
    gate_request_of(&create_provider())
}

/// `get_gate_request` for one provider.
fn gate_request_of(provider: &LlmProvider) -> anyhow::Result<GateRequest> {
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
    classification_request_of(&create_provider())
}

/// `get_classification_request` for one provider.
fn classification_request_of(provider: &LlmProvider) -> anyhow::Result<ClassificationRequest> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{LanguageModelV4CallOptions, LanguageModelV4GenerateResult};
    use crate::lib::llm_providers::llm_provider::{NO_CACHE_POINT, provider_options_json};
    use async_trait::async_trait;
    use serde_json::{Value, json};

    struct Named(String);

    #[async_trait]
    impl LanguageModel for Named {
        fn provider(&self) -> &str {
            "stub"
        }

        fn model_id(&self) -> &str {
            &self.0
        }

        async fn do_generate(
            &self,
            _options: LanguageModelV4CallOptions,
        ) -> anyhow::Result<LanguageModelV4GenerateResult> {
            anyhow::bail!("not called")
        }
    }

    fn stub() -> LlmProvider {
        LlmProvider::new(
            Arc::new(|id: &str| Ok(Arc::new(Named(id.to_string())) as Arc<dyn LanguageModel>)),
            Arc::new(|_id: &str, _ttl| NO_CACHE_POINT),
        )
    }

    fn options(value: Value) -> Option<ProviderOptionsFragment> {
        Some(provider_options(value))
    }

    #[test]
    fn resolves_the_classification_model_through_the_provider() {
        let request = gate_request_of(&stub()).unwrap();
        assert_eq!(request.model.model_id(), CONFIG.classification_model_id);
    }

    #[test]
    fn passes_the_providers_classification_options_through() {
        let mut provider = stub();
        provider.classification_provider_options =
            options(json!({ "openai": { "reasoningEffort": "none" } }));
        provider.structured_output_options =
            options(json!({ "anthropic": { "structuredOutputMode": "jsonTool" } }));
        let request = gate_request_of(&provider).unwrap();
        // The gates are plain text calls: no structured-output options.
        assert_eq!(
            provider_options_json(&request.provider_options),
            json!({ "openai": { "reasoningEffort": "none" } })
        );
    }

    #[test]
    fn yields_empty_options_and_the_defaults_when_the_provider_declares_none() {
        let request = gate_request_of(&stub()).unwrap();
        assert_eq!(provider_options_json(&request.provider_options), json!({}));
        assert_eq!(request.min_output_tokens, 0);
        assert_eq!(request.sampling_params, DEFAULT_GATE_SAMPLING);
        assert_eq!(request.sampling_params.temperature, Some(0.0));
    }

    #[test]
    fn carries_the_output_floor_and_the_declared_sampling() {
        let mut provider = stub();
        provider.classification_min_output_tokens = Some(16);
        provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
        let request = gate_request_of(&provider).unwrap();
        assert_eq!(request.min_output_tokens, 16);
        assert_eq!(request.sampling_params.temperature, None);
    }

    #[test]
    fn merges_classification_and_structured_output_options() {
        let mut provider = stub();
        provider.classification_provider_options =
            options(json!({ "openai": { "reasoningEffort": "none" } }));
        provider.structured_output_options =
            options(json!({ "anthropic": { "structuredOutputMode": "jsonTool" } }));
        let request = classification_request_of(&provider).unwrap();
        assert_eq!(
            provider_options_json(&request.provider_options),
            json!({
                "openai": { "reasoningEffort": "none" },
                "anthropic": { "structuredOutputMode": "jsonTool" },
            })
        );
    }

    #[test]
    fn merges_one_namespace_deep() {
        let mut provider = stub();
        provider.classification_provider_options = options(json!({ "acme": { "effort": "none" } }));
        provider.structured_output_options = options(json!({ "acme": { "mode": "widget" } }));
        let request = classification_request_of(&provider).unwrap();
        assert_eq!(
            provider_options_json(&request.provider_options),
            json!({ "acme": { "effort": "none", "mode": "widget" } })
        );
    }

    #[test]
    fn gives_structured_output_the_same_sampling_contract() {
        assert_eq!(
            classification_request_of(&stub()).unwrap().sampling_params,
            DEFAULT_GATE_SAMPLING
        );
        let mut provider = stub();
        provider.classification_sampling_params = Some(ClassificationSamplingParams::default());
        assert_eq!(
            classification_request_of(&provider)
                .unwrap()
                .sampling_params
                .temperature,
            None
        );
        assert_eq!(
            provider_options_json(&classification_request_of(&stub()).unwrap().provider_options),
            json!({})
        );
    }
}
