//! Whether a model ID names Claude on Bedrock.
//!
//! Kept free of other modules so `config` can use it: `bedrock_shared` reads the
//! config.

use std::sync::LazyLock;

use regex::Regex;

static ANTHROPIC_MODEL_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^anthropic\.|\.anthropic\.").expect("valid regex"));

/// Returns true when `model_id` is an Anthropic Claude model on Bedrock: bare
/// (`anthropic.claude-…`), regional inference profile (`us.anthropic.…`,
/// `eu.anthropic.…`, …), or an ARN whose resource is a region-prefixed one
/// (`…/eu.anthropic.…`).
pub fn is_anthropic_model_id(model_id: &str) -> bool {
    ANTHROPIC_MODEL_ID.is_match(model_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_bare_and_region_prefixed_anthropic_ids() {
        assert!(is_anthropic_model_id("anthropic.claude-3-sonnet"));
        assert!(is_anthropic_model_id("us.anthropic.claude-opus-4-7"));
        assert!(is_anthropic_model_id("eu.anthropic.claude-3-haiku"));
        assert!(is_anthropic_model_id(
            "apac.anthropic.claude-sonnet-4-6-20250929-v1:0"
        ));
    }

    #[test]
    fn matches_anthropic_ids_embedded_in_an_arn() {
        assert!(is_anthropic_model_id(
            "arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-4-7"
        ));
    }

    #[test]
    fn does_not_match_other_vendors() {
        assert!(!is_anthropic_model_id("moonshotai.kimi-k2.5"));
        assert!(!is_anthropic_model_id("moonshot.kimi-k2-thinking"));
        assert!(!is_anthropic_model_id("meta.llama3-70b-instruct-v1:0"));
        assert!(!is_anthropic_model_id("mistral.mistral-large-2402-v1:0"));
    }
}
