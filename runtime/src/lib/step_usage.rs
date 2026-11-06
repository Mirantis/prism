//! Reading a model call's token usage, and adding several together.
//!
//! `to_step_usage` normalizes what a provider reported into the shape the runtime
//! stores and sums; `services/llm_call_service.rs` writes one row per call from it,
//! and `fold_step_usage` adds a turn's steps up for the invocation total the goal
//! loop meters its budget against.
//!
//! Summing across steps counts the prompt once per step, which is what the provider
//! bills: each agentic step resends the conversation. Context occupancy is
//! `services/context_usage_service.rs`, from the latest step alone.

use crate::ai::LanguageModelUsage;
use crate::types::StepUsage;

/// Convert one model call's SDK usage into the shape that gets stored.
///
/// Returns nothing only when the provider reported neither a prompt size nor a
/// total. Either figure alone is enough to keep: the goal loop meters its budget
/// against `total_tokens`, so discarding a partial report would leave it counting
/// zero for ever.
///
/// The three cache details fall back to 0 where the provider omits them, which a
/// reader distinguishes from a real zero by their sum (see
/// `services/llm_usage_service.rs`).
pub fn to_step_usage(model: &str, usage: Option<&LanguageModelUsage>) -> Option<StepUsage> {
    let usage = usage?;
    if usage.input_tokens.is_none() && usage.total_tokens.is_none() {
        return None;
    }

    let details = &usage.input_token_details;

    let input_tokens = usage.input_tokens.unwrap_or(0);
    let output_tokens = usage.output_tokens.unwrap_or(0);

    Some(StepUsage {
        model: model.to_string(),
        // The provider's own total where it gives one, so a vendor that counts
        // something the split leaves out still adds up here.
        total_tokens: usage.total_tokens.unwrap_or(input_tokens + output_tokens),
        input_tokens,
        output_tokens,
        cache_read_tokens: details.cache_read_tokens.unwrap_or(0),
        cache_write_tokens: details.cache_write_tokens.unwrap_or(0),
        no_cache_tokens: details.no_cache_tokens.unwrap_or(0),
    })
}

/// Add up several steps' usage. Returns `None` for an empty list.
///
/// The model is taken from the first entry: an invocation runs one model, and a
/// per-agent override changes between invocations, not within one.
pub fn fold_step_usage(steps: &[StepUsage]) -> Option<StepUsage> {
    let first = steps.first()?;
    let mut acc = StepUsage {
        model: first.model.clone(),
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        no_cache_tokens: 0,
    };
    for s in steps {
        acc.total_tokens += s.total_tokens;
        acc.input_tokens += s.input_tokens;
        acc.output_tokens += s.output_tokens;
        acc.cache_read_tokens += s.cache_read_tokens;
        acc.cache_write_tokens += s.cache_write_tokens;
        acc.no_cache_tokens += s.no_cache_tokens;
    }
    Some(acc)
}
