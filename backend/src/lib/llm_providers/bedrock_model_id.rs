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

static OPENAI_BEDROCK_MODEL_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^openai\.|\.openai\.").expect("valid regex"));

/// Returns true when `model_id` is an OpenAI model on Bedrock, in the same forms
/// as [`is_anthropic_model_id`] (`openai.…`, `us.openai.…`, `…/us.openai.…`).
pub fn is_openai_bedrock_model_id(model_id: &str) -> bool {
    OPENAI_BEDROCK_MODEL_ID.is_match(model_id)
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

    #[test]
    fn matches_bare_region_prefixed_and_arn_openai_ids_on_bedrock() {
        assert!(is_openai_bedrock_model_id("openai.gpt-5.6-luna"));
        assert!(is_openai_bedrock_model_id("us.openai.gpt-5.6-terra"));
        assert!(is_openai_bedrock_model_id(
            "arn:aws:bedrock:us-east-1:123:inference-profile/us.openai.gpt-5.6-sol"
        ));
    }

    #[test]
    fn does_not_match_openai_api_ids_or_other_vendors() {
        assert!(!is_openai_bedrock_model_id("gpt-5.6-luna"));
        assert!(!is_openai_bedrock_model_id("o4-mini"));
        assert!(!is_openai_bedrock_model_id("eu.anthropic.claude-haiku-5-5"));
    }
}
