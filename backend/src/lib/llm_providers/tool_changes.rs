//! Mid-conversation tool changes on the Anthropic Messages API.
//!
//! A declared tool that is not loaded yet has `deferLoading`, and a system message
//! in the history names each tool that became available or stopped being
//! available. The provider adds the betas itself whenever a request has such a
//! message.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;

use super::llm_provider::{ToolChange, ToolChangeProtocol, provider_options};
use crate::ai::SystemModelMessage;

/// Claude models measured to accept a tool change and keep the prompt cache across
/// it, on Bedrock's Anthropic Messages path. Matched on the bare id, so one entry
/// covers every inference-profile prefix. A model off the list sends the request it
/// sent before: some reject the change outright, and Opus 5 declines to answer a
/// turn that has one.
const TOOL_CHANGE_MODELS: [&str; 3] = ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-5-5"];

static PROFILE_OR_VENDOR_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:us-gov|us|eu|apac|jp|au|ca|global)\.)?(?:anthropic\.)?").unwrap()
});

/// The bare first-party id inside a Bedrock model id: no inference-profile or
/// vendor prefix. An inference-profile ARN names the profile in its last path
/// segment.
pub fn bare_model_id(model_id: &str) -> String {
    let last = match model_id.rfind('/') {
        Some(index) => &model_id[index + 1..],
        None => model_id,
    };
    PROFILE_OR_VENDOR_PREFIX.replace(last, "").into_owned()
}

pub fn supports_tool_changes(model_id: &str) -> bool {
    let bare = bare_model_id(model_id);
    TOOL_CHANGE_MODELS.contains(&bare.as_str())
}

fn announce(changes: &[ToolChange]) -> SystemModelMessage {
    serde_json::from_value(json!({
        "role": "system",
        "content": "",
        "providerOptions": { "anthropic": { "toolChanges": changes } },
    }))
    .expect("a system message")
}

pub static ANTHROPIC_TOOL_CHANGES: LazyLock<ToolChangeProtocol> =
    LazyLock::new(|| ToolChangeProtocol {
        deferred_tool: provider_options(json!({ "anthropic": { "deferLoading": true } })),
        announce,
    });
