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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::InputTokenDetails;

    fn usage() -> StepUsage {
        StepUsage {
            model: "claude-opus-5".into(),
            total_tokens: 1100,
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_tokens: 700,
            cache_write_tokens: 100,
            no_cache_tokens: 200,
        }
    }

    fn sdk(
        input: Option<i64>,
        output: Option<i64>,
        total: Option<i64>,
        details: (Option<i64>, Option<i64>, Option<i64>),
    ) -> LanguageModelUsage {
        LanguageModelUsage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: total,
            input_token_details: InputTokenDetails {
                cache_read_tokens: details.0,
                cache_write_tokens: details.1,
                no_cache_tokens: details.2,
            },
            ..Default::default()
        }
    }

    #[test]
    fn keeps_the_cache_split() {
        let result = to_step_usage(
            "claude-opus-5",
            Some(&sdk(
                Some(1000),
                Some(100),
                Some(1100),
                (Some(700), Some(100), Some(200)),
            )),
        );
        assert_eq!(result, Some(usage()));
    }

    #[test]
    fn keeps_the_providers_own_total_when_it_exceeds_input_plus_output() {
        // A model billing reasoning tokens reports a total above the split.
        let result = to_step_usage(
            "claude-opus-5",
            Some(&sdk(
                Some(1000),
                Some(100),
                Some(1400),
                (Some(700), Some(100), Some(200)),
            )),
        );
        assert_eq!(result.unwrap().total_tokens, 1400);
    }

    #[test]
    fn falls_back_to_input_plus_output_without_a_total() {
        let result = to_step_usage(
            "claude-opus-5",
            Some(&sdk(
                Some(1000),
                Some(100),
                None,
                (Some(700), Some(100), Some(200)),
            )),
        );
        assert_eq!(result.unwrap().total_tokens, 1100);
    }

    #[test]
    fn returns_nothing_when_the_provider_reported_neither_figure() {
        assert_eq!(to_step_usage("m", None), None);
        assert_eq!(
            to_step_usage("m", Some(&sdk(None, Some(5), None, (None, None, None)))),
            None
        );
    }

    #[test]
    fn keeps_a_total_given_without_a_prompt_size() {
        // The goal loop meters its budget against total_tokens, so discarding a
        // partial report would leave it counting zero for ever.
        let result = to_step_usage(
            "m",
            Some(&sdk(None, Some(5), Some(900), (None, None, None))),
        );
        assert_eq!(
            result,
            Some(StepUsage {
                model: "m".into(),
                total_tokens: 900,
                input_tokens: 0,
                output_tokens: 5,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                no_cache_tokens: 0,
            })
        );
    }

    #[test]
    fn keeps_a_converse_model_whole_cache_free_but_measured() {
        // Converse reports its uncached prompt as `noCacheTokens` and no cache
        // tokens at all, so the three details still sum to the prompt.
        let result = to_step_usage(
            "us.meta.llama3-3-70b-instruct-v1:0",
            Some(&sdk(
                Some(42),
                Some(2),
                Some(44),
                (Some(0), Some(0), Some(42)),
            )),
        )
        .unwrap();
        assert_eq!(result.no_cache_tokens, 42);
        assert_eq!(
            result.cache_read_tokens + result.cache_write_tokens + result.no_cache_tokens,
            result.input_tokens
        );
    }

    #[test]
    fn zeroes_a_cache_split_the_provider_omits() {
        let result = to_step_usage(
            "gpt-5.6-sol",
            Some(&sdk(Some(900), Some(50), Some(950), (None, None, None))),
        );
        assert_eq!(
            result,
            Some(StepUsage {
                model: "gpt-5.6-sol".into(),
                total_tokens: 950,
                input_tokens: 900,
                output_tokens: 50,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                no_cache_tokens: 0,
            })
        );
    }

    #[test]
    fn adds_every_count_and_keeps_the_model() {
        assert_eq!(
            fold_step_usage(&[usage(), usage(), usage()]),
            Some(StepUsage {
                model: "claude-opus-5".into(),
                total_tokens: 3300,
                input_tokens: 3000,
                output_tokens: 300,
                cache_read_tokens: 2100,
                cache_write_tokens: 300,
                no_cache_tokens: 600,
            })
        );
    }

    #[test]
    fn sums_the_prompt_once_per_step() {
        let mut second = usage();
        second.input_tokens = 1400;
        assert_eq!(
            fold_step_usage(&[usage(), second]).unwrap().input_tokens,
            2400
        );
    }

    #[test]
    fn returns_nothing_for_no_steps() {
        assert_eq!(fold_step_usage(&[]), None);
    }

    #[test]
    fn leaves_a_single_step_untouched() {
        assert_eq!(fold_step_usage(&[usage()]), Some(usage()));
    }
}
