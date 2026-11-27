//! What a model call cost, estimated from its token counts and the model's prices
//! in the catalog (`lib/model_catalog.rs`).
//!
//! A price is US dollars per million tokens, so a token count times a price is a
//! cost in millionths of a dollar, the unit `llm_calls.costMicroUsd` stores.

use crate::lib::model_catalog::{ModelPrice, find_catalog_entry};
use crate::support::js::round as js_round;

/// One call's tokens, as `llm_calls` stores them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PricedTokens {
    /// The whole prompt, cache reads and writes included.
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// The part of `cache_write_tokens` written with the one-hour lifetime, whose price the registry does not list.
    pub long_cache_write_tokens: i64,
    /// The audio part of the uncached prompt.
    pub audio_input_tokens: i64,
    /// The audio part of the output.
    pub audio_output_tokens: i64,
}

/// The price of a cache write with the one-hour lifetime, as a multiple of the input price.
const LONG_CACHE_WRITE_FACTOR: f64 = 2.0;

/// The catalog's price for `model_id`, or `None` when it lists none.
pub fn price_for(model_id: &str) -> Option<ModelPrice> {
    find_catalog_entry(model_id)?.cost
}

/// The cost of one call at `price`, in millionths of a dollar.
pub fn cost_micro_usd(price: &ModelPrice, tokens: &PricedTokens) -> i64 {
    // The highest tier whose threshold the prompt is above.
    let tier = price
        .tiers
        .iter()
        .flatten()
        .rfind(|t| tokens.input_tokens as f64 > t.above);
    let input = tier.map_or(price.input, |t| t.input);
    let output = tier.map_or(price.output, |t| t.output);
    let cache_read = tier
        .and_then(|t| t.cache_read)
        .or(price.cache_read)
        .unwrap_or(input);
    let cache_write = tier
        .and_then(|t| t.cache_write)
        .or(price.cache_write)
        .unwrap_or(input);
    let long_cache_writes = tokens
        .long_cache_write_tokens
        .min(tokens.cache_write_tokens);

    let uncached =
        (tokens.input_tokens - tokens.cache_read_tokens - tokens.cache_write_tokens).max(0);
    let text_input = (uncached - tokens.audio_input_tokens).max(0);
    let text_output = (tokens.output_tokens - tokens.audio_output_tokens).max(0);

    let cost = text_input as f64 * input
        + tokens.audio_input_tokens as f64 * price.input_audio.unwrap_or(input)
        + tokens.cache_read_tokens as f64 * cache_read
        + (tokens.cache_write_tokens - long_cache_writes) as f64 * cache_write
        + long_cache_writes as f64 * input * LONG_CACHE_WRITE_FACTOR
        + text_output as f64 * output
        + tokens.audio_output_tokens as f64 * price.output_audio.unwrap_or(output);
    js_round(cost) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::model_catalog::{PriceTier, reset_model_catalog};

    fn price(input: f64, output: f64) -> ModelPrice {
        ModelPrice {
            input,
            output,
            cache_read: None,
            cache_write: None,
            input_audio: None,
            output_audio: None,
            tiers: None,
        }
    }

    fn tier(above: f64, input: f64, output: f64) -> PriceTier {
        PriceTier {
            above,
            input,
            output,
            cache_read: None,
            cache_write: None,
        }
    }

    #[test]
    fn matches_the_cost_claude_code_reported_for_a_run_that_wrote_its_cache_for_an_hour() {
        // models.dev's price for claude-haiku-5-5, and the `modelUsage` of a captured
        // result line: 2 + 143,355 prompt tokens put the call above the 100k tier, and
        // the CLI reported costUSD 0.14336600000000002.
        let haiku = ModelPrice {
            cache_read: Some(0.01),
            cache_write: Some(0.125),
            tiers: Some(vec![PriceTier {
                cache_read: Some(0.05),
                cache_write: Some(0.625),
                ..tier(100_000.0, 0.5, 2.5)
            }]),
            ..price(0.1, 0.5)
        };
        let tokens = PricedTokens {
            input_tokens: 143_357,
            cache_write_tokens: 143_355,
            long_cache_write_tokens: 143_355,
            output_tokens: 4,
            ..Default::default()
        };
        assert_eq!(cost_micro_usd(&haiku, &tokens), 143_366);
    }

    #[test]
    fn uses_the_base_price_at_and_below_a_tier_threshold() {
        let tiered = ModelPrice {
            tiers: Some(vec![tier(1000.0, 10.0, 20.0)]),
            ..price(1.0, 2.0)
        };
        let at = |input_tokens| PricedTokens {
            input_tokens,
            output_tokens: 10,
            ..Default::default()
        };
        assert_eq!(cost_micro_usd(&tiered, &at(1000)), 1000 + 20);
        assert_eq!(cost_micro_usd(&tiered, &at(1001)), 10_010 + 200);
    }

    #[test]
    fn charges_the_input_price_for_cache_reads_and_writes_a_model_lists_no_price_for() {
        let tokens = PricedTokens {
            input_tokens: 300,
            cache_read_tokens: 100,
            cache_write_tokens: 100,
            ..Default::default()
        };
        assert_eq!(cost_micro_usd(&price(2.0, 8.0), &tokens), 600);
    }

    #[test]
    #[serial_test::serial]
    fn finds_a_model_under_the_spellings_the_providers_and_coding_agents_use() {
        reset_model_catalog();
        assert!(price_for("claude-haiku-5-5").is_some());
        assert_eq!(
            price_for("claude-haiku-5-5[1m]"),
            price_for("claude-haiku-5-5")
        );
        assert_eq!(
            price_for("anthropic/claude-haiku-5-5"),
            price_for("claude-haiku-5-5")
        );
        assert_eq!(
            price_for("openai.gpt-5.6-terra"),
            price_for("gpt-5.6-terra")
        );
        let realtime = price_for("gpt-realtime-2.1").unwrap();
        assert!(realtime.input_audio.is_some() && realtime.output_audio.is_some());
    }

    #[test]
    #[serial_test::serial]
    fn answers_none_for_a_model_the_catalog_does_not_price() {
        reset_model_catalog();
        assert_eq!(price_for("my-litellm-alias"), None);
        assert_eq!(price_for("gpt-live-transcribe"), None);
    }
}
