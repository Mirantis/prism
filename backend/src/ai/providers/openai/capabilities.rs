//! What an OpenAI model id says about the model (`getOpenAILanguageModelCapabilities`).

use std::sync::LazyLock;

use regex::Regex;

/// The role system messages are sent as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemMessageMode {
    System,
    Developer,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAILanguageModelCapabilities {
    pub is_reasoning_model: bool,
    pub system_message_mode: SystemMessageMode,
    pub supports_flex_processing: bool,
    pub supports_priority_processing: bool,
    pub supports_configuration_update: bool,
    pub supports_async_tool_calling: bool,
    pub supported_reasoning_efforts: Option<&'static [&'static str]>,
    /// Allow temperature, topP, logProbs when reasoningEffort is none.
    pub supports_non_reasoning_parameters: bool,
}

const GPT6_SOL_LUNA_EFFORTS: &[&str] = &["none", "low", "medium", "high", "xhigh", "max"];
const GPT6_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

static O_SERIES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^o(\d+)(?:-|$)").unwrap());
static GPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$").unwrap());

struct GptVersion {
    major: f64,
    minor: Option<f64>,
    variant: Option<String>,
}

fn o_series_version(model_id: &str) -> Option<f64> {
    O_SERIES
        .captures(model_id)
        .and_then(|c| c[1].parse::<f64>().ok())
}

fn gpt_version(model_id: &str) -> Option<GptVersion> {
    let captures = GPT.captures(model_id)?;
    Some(GptVersion {
        major: captures[1].parse::<f64>().ok()?,
        minor: captures.get(2).and_then(|m| m.as_str().parse::<f64>().ok()),
        variant: captures.get(3).map(|m| m.as_str().to_string()),
    })
}

pub fn get_openai_language_model_capabilities(model_id: &str) -> OpenAILanguageModelCapabilities {
    let o_series = o_series_version(model_id);
    let gpt = gpt_version(model_id);
    let is_gpt_chat_model = gpt.as_ref().is_some_and(|v| {
        v.minor.is_none() && v.variant.as_deref().is_some_and(|s| s.starts_with("chat"))
    });
    let is_gpt_nano_model = gpt
        .as_ref()
        .and_then(|v| v.variant.as_deref())
        .is_some_and(|s| s.starts_with("nano"));
    let is_gpt6_or_later = gpt.as_ref().is_some_and(|v| v.major >= 6.0);

    let is_gpt6_sol_or_luna = model_id == "gpt-6-sol" || model_id == "gpt-6-luna";

    let supports_flex_processing = o_series.is_some_and(|v| v >= 3.0)
        || gpt
            .as_ref()
            .is_some_and(|v| v.major >= 5.0 && !is_gpt_chat_model);

    let supports_priority_processing = model_id.starts_with("gpt-4")
        || gpt
            .as_ref()
            .is_some_and(|v| v.major >= 5.0 && !is_gpt_nano_model && !is_gpt_chat_model)
        || o_series.is_some_and(|v| v >= 3.0);

    // Only recognizable OpenAI model families use the developer role. Fine-tuned,
    // third-party and custom model ids keep conservative defaults.
    let is_reasoning_model = o_series.is_some()
        || gpt
            .as_ref()
            .is_some_and(|v| v.major >= 5.0 && !is_gpt_chat_model);

    // GPT-5.1 through GPT-5.x and GPT-6 Sol/Luna support temperature, topP and
    // logProbs when reasoningEffort is none.
    let supports_non_reasoning_parameters = is_gpt6_sol_or_luna
        || (!is_gpt6_or_later
            && gpt.as_ref().is_some_and(|v| {
                v.major > 5.0 || (v.major == 5.0 && v.minor.unwrap_or(0.0) >= 1.0)
            }));

    OpenAILanguageModelCapabilities {
        supports_flex_processing,
        supports_priority_processing,
        supports_configuration_update: is_gpt6_or_later,
        supports_async_tool_calling: is_gpt6_or_later,
        supported_reasoning_efforts: if is_gpt6_sol_or_luna {
            Some(GPT6_SOL_LUNA_EFFORTS)
        } else if is_gpt6_or_later {
            Some(GPT6_EFFORTS)
        } else {
            None
        },
        is_reasoning_model,
        system_message_mode: if is_reasoning_model {
            SystemMessageMode::Developer
        } else {
            SystemMessageMode::System
        },
        supports_non_reasoning_parameters,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpt_5_and_later_and_the_o_series_are_reasoning_models() {
        for id in ["gpt-5", "gpt-5.6-sol", "gpt-6-luna", "o3", "o4-mini"] {
            assert!(
                get_openai_language_model_capabilities(id).is_reasoning_model,
                "{id}"
            );
        }
        for id in [
            "gpt-4.1",
            "gpt-5-chat-latest",
            "openai/gpt-5.6-sol",
            "gpt-oss-120b",
        ] {
            assert!(
                !get_openai_language_model_capabilities(id).is_reasoning_model,
                "{id}"
            );
        }
    }

    #[test]
    fn gpt_5_1_and_later_take_sampling_params_with_reasoning_off() {
        assert!(
            get_openai_language_model_capabilities("gpt-5.6-luna")
                .supports_non_reasoning_parameters
        );
        assert!(!get_openai_language_model_capabilities("gpt-5").supports_non_reasoning_parameters);
        assert!(
            !get_openai_language_model_capabilities("gpt-6-astra")
                .supports_non_reasoning_parameters
        );
        assert!(
            get_openai_language_model_capabilities("gpt-6-sol").supports_non_reasoning_parameters
        );
    }

    #[test]
    fn gpt_6_names_its_efforts() {
        assert_eq!(
            get_openai_language_model_capabilities("gpt-6-astra").supported_reasoning_efforts,
            Some(GPT6_EFFORTS)
        );
        assert_eq!(
            get_openai_language_model_capabilities("gpt-5.6-sol").supported_reasoning_efforts,
            None
        );
    }
}
