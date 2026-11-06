//! `logWarnings`: call warnings written to stderr as Node's `process.emitWarning`
//! writes them. A deprecation is written once per process.

use std::collections::HashSet;
use std::sync::LazyLock;

use parking_lot::Mutex;

use super::provider::Warning;

pub const FIRST_WARNING_INFO_MESSAGE: &str = "AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.";

struct State {
    logged_before: bool,
    emitted_codes: HashSet<String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State {
        logged_before: false,
        emitted_codes: HashSet::new(),
    })
});

const DEPRECATION_CODES: &[(&str, &str)] = &[
    ("generateObject", "AISDK_DEP_GENERATE_OBJECT"),
    ("streamObject", "AISDK_DEP_STREAM_OBJECT"),
    (
        "experimental_generateSpeech",
        "AISDK_DEP_EXPERIMENTAL_GENERATE_SPEECH",
    ),
    (
        "experimental_transcribe",
        "AISDK_DEP_EXPERIMENTAL_TRANSCRIBE",
    ),
    ("\"image\" content part", "AISDK_DEP_IMAGE_CONTENT_PART"),
    (
        "\"tool-result\" content of type \"file-data\"",
        "AISDK_DEP_TOOL_RESULT_FILE_DATA",
    ),
    (
        "\"tool-result\" content of type \"file-url\"",
        "AISDK_DEP_TOOL_RESULT_FILE_URL",
    ),
    (
        "\"tool-result\" content of type \"file-id\"",
        "AISDK_DEP_TOOL_RESULT_FILE_ID",
    ),
    (
        "\"tool-result\" content of type \"file-reference\"",
        "AISDK_DEP_TOOL_RESULT_FILE_REFERENCE",
    ),
    (
        "\"tool-result\" content of type \"image-data\"",
        "AISDK_DEP_TOOL_RESULT_IMAGE_DATA",
    ),
    (
        "\"tool-result\" content of type \"image-url\"",
        "AISDK_DEP_TOOL_RESULT_IMAGE_URL",
    ),
    (
        "\"tool-result\" content of type \"image-file-id\"",
        "AISDK_DEP_TOOL_RESULT_IMAGE_FILE_ID",
    ),
    (
        "\"tool-result\" content of type \"image-file-reference\"",
        "AISDK_DEP_TOOL_RESULT_IMAGE_FILE_REFERENCE",
    ),
    (
        "rawInput in output-error UI message parts",
        "AISDK_DEP_UI_MESSAGE_RAW_INPUT",
    ),
];

fn encode_code_part(value: &str) -> String {
    value
        .encode_utf16()
        .map(|unit| {
            let c = char::from_u32(unit as u32).filter(|c| c.is_ascii_alphanumeric());
            match c {
                Some(c) => c.to_string(),
                None => format!("_{unit:04X}"),
            }
        })
        .collect()
}

/// `getDeprecationCode`.
pub fn deprecation_code(setting: &str, provider: Option<&str>) -> String {
    match provider {
        None => DEPRECATION_CODES
            .iter()
            .find(|(s, _)| *s == setting)
            .map(|(_, code)| code.to_string())
            .unwrap_or_else(|| format!("AISDK_DEP_SETTING_{}", encode_code_part(setting))),
        Some(provider) => {
            format!(
                "AISDK_DEP_PROVIDER_{}__{}",
                encode_code_part(provider),
                encode_code_part(setting)
            )
        }
    }
}

fn format_warning(warning: &Warning, provider: Option<&str>, model: Option<&str>) -> String {
    let scope = match (provider, model) {
        (Some(p), Some(m)) => format!(" ({p} / {m})"),
        _ => String::new(),
    };
    let prefix = format!("AI SDK Warning{scope}:");
    match warning {
        Warning::Unsupported { feature, details } => {
            let mut message = format!("{prefix} The feature \"{feature}\" is not supported.");
            if let Some(details) = details.as_deref().filter(|d| !d.is_empty()) {
                message.push_str(&format!(" {details}"));
            }
            message
        }
        Warning::Compatibility { feature, details } => {
            let mut message =
                format!("{prefix} The feature \"{feature}\" is used in a compatibility mode.");
            if let Some(details) = details.as_deref().filter(|d| !d.is_empty()) {
                message.push_str(&format!(" {details}"));
            }
            message
        }
        Warning::Deprecated { setting, message } => {
            format!("{prefix} Deprecated: \"{setting}\". {message}")
        }
        Warning::Other { message } => format!("{prefix} {message}"),
    }
}

fn emit(message: &str, deprecation: bool, code: Option<&str>) {
    let kind = if deprecation {
        "DeprecationWarning"
    } else {
        "Warning"
    };
    let pid = std::process::id();
    match code {
        Some(code) => eprintln!("(node:{pid}) [{code}] {kind}: {message}"),
        None => eprintln!("(node:{pid}) {kind}: {message}"),
    }
}

/// `logWarnings`.
pub fn log_warnings(warnings: &[Warning], provider: Option<&str>, model: Option<&str>) {
    if warnings.is_empty() {
        return;
    }
    let mut state = STATE.lock();
    if !state.logged_before {
        state.logged_before = true;
        emit(FIRST_WARNING_INFO_MESSAGE, false, None);
    }
    for warning in warnings {
        let code = match warning {
            Warning::Deprecated { setting, .. } => Some(deprecation_code(setting, provider)),
            _ => None,
        };
        if let Some(code) = &code {
            if !state.emitted_codes.insert(code.clone()) {
                continue;
            }
        }
        emit(
            &format_warning(warning, provider, model),
            matches!(warning, Warning::Deprecated { .. }),
            code.as_deref(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_unknown_settings_into_a_code() {
        assert_eq!(
            deprecation_code("generateObject", None),
            "AISDK_DEP_GENERATE_OBJECT"
        );
        assert_eq!(deprecation_code("a b", None), "AISDK_DEP_SETTING_a_0020b");
        assert_eq!(
            deprecation_code("x", Some("p.q")),
            "AISDK_DEP_PROVIDER_p_002Eq__x"
        );
    }
}
