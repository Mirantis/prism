//! Token usage as the SDK reports it to callers.

use serde::{Deserialize, Serialize};

use super::provider::{JsonObject, LanguageModelV4Usage};

/// Input token counts by cache state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTokenDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_cache_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
}

/// Output token counts by kind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputTokenDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<i64>,
}

/// The tokens a call (or a whole generation) used. A count the provider did not
/// report is `None`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModelUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(default)]
    pub input_token_details: InputTokenDetails,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(default)]
    pub output_token_details: OutputTokenDetails,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<JsonObject>,
}

fn add_token_counts(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    if a.is_none() && b.is_none() {
        None
    } else {
        Some(a.unwrap_or(0) + b.unwrap_or(0))
    }
}

impl LanguageModelUsage {
    /// `asLanguageModelUsage`: a provider's usage as the caller sees it.
    pub fn from_v4(usage: &LanguageModelV4Usage) -> Self {
        Self {
            input_tokens: usage.input_tokens.total,
            input_token_details: InputTokenDetails {
                no_cache_tokens: usage.input_tokens.no_cache,
                cache_read_tokens: usage.input_tokens.cache_read,
                cache_write_tokens: usage.input_tokens.cache_write,
            },
            output_tokens: usage.output_tokens.total,
            output_token_details: OutputTokenDetails {
                text_tokens: usage.output_tokens.text,
                reasoning_tokens: usage.output_tokens.reasoning,
            },
            total_tokens: add_token_counts(usage.input_tokens.total, usage.output_tokens.total),
            raw: usage.raw.clone(),
        }
    }

    fn is_null(&self) -> bool {
        self.input_tokens.is_none()
            && self.input_token_details.no_cache_tokens.is_none()
            && self.input_token_details.cache_read_tokens.is_none()
            && self.input_token_details.cache_write_tokens.is_none()
            && self.output_tokens.is_none()
            && self.output_token_details.text_tokens.is_none()
            && self.output_token_details.reasoning_tokens.is_none()
            && self.total_tokens.is_none()
            && self.raw.is_none()
    }

    /// `addLanguageModelUsage`: the sum of two usages. `raw` survives only when one
    /// side reported nothing.
    pub fn add(&self, other: &LanguageModelUsage) -> LanguageModelUsage {
        let raw = if self.is_null() {
            other.raw.clone()
        } else if other.is_null() {
            self.raw.clone()
        } else {
            None
        };
        LanguageModelUsage {
            input_tokens: add_token_counts(self.input_tokens, other.input_tokens),
            input_token_details: InputTokenDetails {
                no_cache_tokens: add_token_counts(
                    self.input_token_details.no_cache_tokens,
                    other.input_token_details.no_cache_tokens,
                ),
                cache_read_tokens: add_token_counts(
                    self.input_token_details.cache_read_tokens,
                    other.input_token_details.cache_read_tokens,
                ),
                cache_write_tokens: add_token_counts(
                    self.input_token_details.cache_write_tokens,
                    other.input_token_details.cache_write_tokens,
                ),
            },
            output_tokens: add_token_counts(self.output_tokens, other.output_tokens),
            output_token_details: OutputTokenDetails {
                text_tokens: add_token_counts(
                    self.output_token_details.text_tokens,
                    other.output_token_details.text_tokens,
                ),
                reasoning_tokens: add_token_counts(
                    self.output_token_details.reasoning_tokens,
                    other.output_token_details.reasoning_tokens,
                ),
            },
            total_tokens: add_token_counts(self.total_tokens, other.total_tokens),
            raw,
        }
    }
}

/// `asLanguageModelUsage`.
pub fn as_language_model_usage(usage: &LanguageModelV4Usage) -> LanguageModelUsage {
    LanguageModelUsage::from_v4(usage)
}

/// `addLanguageModelUsage`.
pub fn add_language_model_usage(
    a: &LanguageModelUsage,
    b: &LanguageModelUsage,
) -> LanguageModelUsage {
    a.add(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{LanguageModelV4InputTokens, LanguageModelV4OutputTokens};

    #[test]
    fn sums_counts_and_keeps_unreported_ones_empty() {
        let step = LanguageModelUsage::from_v4(&LanguageModelV4Usage {
            input_tokens: LanguageModelV4InputTokens {
                total: Some(10),
                cache_read: Some(4),
                ..Default::default()
            },
            output_tokens: LanguageModelV4OutputTokens {
                total: Some(5),
                ..Default::default()
            },
            raw: None,
        });
        assert_eq!(step.total_tokens, Some(15));
        let total = LanguageModelUsage::default().add(&step).add(&step);
        assert_eq!(total.input_tokens, Some(20));
        assert_eq!(total.input_token_details.cache_read_tokens, Some(8));
        assert_eq!(total.input_token_details.cache_write_tokens, None);
        assert_eq!(total.total_tokens, Some(30));
    }
}
