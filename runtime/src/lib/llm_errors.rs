//! LLM error classification.
//!
//! Detects gateway budget-exceeded errors (RFC 7807) from LLM call failures. The
//! AI SDK retries transient 429s internally — this module identifies permanent
//! budget errors that should not be retried.
//!
//! The classifiers read an error the way the TypeScript runtime read a JavaScript
//! error object: by its fields (`status`, `statusCode`, `responseBody`, `body`,
//! `response`, `data`, `message`, `lastError`). `error_fields` turns an
//! `anyhow::Error` into that JSON view; every rule below reads the view.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::types::InvokeStep;
use crate::{log_error, log_warn};

/// The fields a JavaScript error object for `error` would have: an AI SDK
/// `APICallError` gives `message`, `statusCode`, `responseBody` and `url`; a
/// `RetryError` gives `message` and `lastError` (itself such a view); any other
/// error gives `message` alone.
pub fn error_fields(error: &anyhow::Error) -> Value {
    todo!()
}

/// Check if an error is a gateway budget-exceeded 429.
///
/// The Lens Agents gateway returns RFC 7807 problem details with
/// `type: "budget-exceeded"`. Unlike throttling 429s, these won't resolve by
/// waiting.
pub fn is_spending_limit_error(error: &anyhow::Error) -> bool {
    is_spending_limit_value(&error_fields(error))
}

/// `is_spending_limit_error` over an error's field view.
pub fn is_spending_limit_value(error: &Value) -> bool {
    let Value::Object(err) = error else {
        return false;
    };
    if get_status_code(err) != Some(429) {
        return false;
    }
    let Value::Object(body) = get_response_body(err) else {
        return false;
    };
    matches!(body.get("type"), Some(Value::String(problem_type)) if problem_type.contains("budget-exceeded"))
}

/// Extract user-friendly detail from a budget-exceeded error.
///
/// Returns the RFC 7807 `detail` field (e.g. "Weekly budget: $4.96 of $4.00
/// used"), or `None` if not available.
pub fn get_spending_limit_detail(error: &anyhow::Error) -> Option<String> {
    detail_of(&error_fields(error))
}

/// Log a warning when a budget-exceeded error is detected.
pub fn log_spending_limit_warning(error: &anyhow::Error) {
    log_spending_limit_warning_value(&error_fields(error));
}

fn log_spending_limit_warning_value(error: &Value) {
    let detail = detail_of(error);
    log_warn!(
        "[LLM] Budget exceeded: {}. Requests will fail until the limit resets or is increased.",
        detail.as_deref().unwrap_or("budget exhausted")
    );
}

/// The integer value of a JSON number, as `typeof x === 'number'` reads one.
fn number_of(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        _ => None,
    }
}

/// Extract HTTP status code from various error shapes.
fn get_status_code(err: &Map<String, Value>) -> Option<i64> {
    if let Some(status) = number_of(err.get("status")) {
        return Some(status);
    }
    if let Some(status) = number_of(err.get("statusCode")) {
        return Some(status);
    }
    if let Some(Value::Object(response)) = err.get("response") {
        if let Some(status) = number_of(response.get("status")) {
            return Some(status);
        }
        if let Some(status) = number_of(response.get("statusCode")) {
            return Some(status);
        }
    }
    if let Some(Value::Object(data)) = err.get("data") {
        if let Some(status) = number_of(data.get("status")) {
            return Some(status);
        }
    }
    None
}

/// Extract response body from various error shapes. `Value::Null` stands for
/// JavaScript's `null` and for a missing body.
fn get_response_body(err: &Map<String, Value>) -> Value {
    if let Some(body) = err.get("responseBody") {
        return try_parse_json(body);
    }
    if let Some(body) = err.get("body") {
        return try_parse_json(body);
    }
    if let Some(Value::Object(response)) = err.get("response") {
        if let Some(body) = response.get("body") {
            return try_parse_json(body);
        }
        if let Some(data) = response.get("data") {
            return data.clone();
        }
    }
    if let Some(data) = err.get("data") {
        return try_parse_json(data);
    }
    Value::Null
}

fn detail_of(error: &Value) -> Option<String> {
    let Value::Object(err) = error else {
        return None;
    };
    match get_response_body(err) {
        Value::Object(body) => match body.get("detail") {
            Some(Value::String(detail)) => Some(detail.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Extract the RFC 7807 `detail` field from an HTTP error response.
///
/// Works for any error that has a problem-details body, not just budget-exceeded
/// 429s. Returns the detail string or `None`.
pub fn get_error_detail(error: &anyhow::Error) -> Option<String> {
    detail_of(&error_fields(error))
}

/// Message patterns the providers use for "the request does not fit the model's
/// context window". Anthropic direct says "prompt is too long: 213456 tokens >
/// 200000 maximum"; Bedrock's ValidationException says "Input is too long for
/// requested model"; OpenAI-compatible gateways use the `context_length_exceeded`
/// code. Deliberately narrow — a generic "too long"/"context" match would misfire
/// on unrelated validation text.
static CONTEXT_OVERFLOW_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)prompt is too long",
        r"(?i)input is too long",
        r"(?i)context[_ ]length[_ ]exceeded",
        r"(?i)exceeds? (the )?(maximum )?context",
        r"(?i)too many (input )?tokens",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).unwrap())
    .collect()
});

/// The error the SDK's retry wrapper holds in `lastError`, else the error itself.
fn unwrap_last_error(error: &Value) -> &Value {
    match error {
        Value::Object(map) if map.contains_key("lastError") => &map["lastError"],
        other => other,
    }
}

/// Check if an error means the request outgrew the model's context window.
///
/// Consumed by the compaction overflow-recovery path: a turn that fails this way
/// will fail identically on every retry until the thread is compacted, so it is the
/// one error class where acting on the failure is correct. Unwraps the SDK's
/// `lastError` retry wrapper like `build_error_step` does.
pub fn is_context_overflow_error(error: &anyhow::Error) -> bool {
    is_context_overflow_value(&error_fields(error))
}

/// `is_context_overflow_error` over an error's field view.
pub fn is_context_overflow_value(error: &Value) -> bool {
    let Value::Object(err) = unwrap_last_error(error) else {
        return false;
    };
    if get_status_code(err) == Some(413) {
        return true;
    }

    let mut texts: Vec<String> = Vec::new();
    // `instanceof Error`: the view of an error always has its message.
    if let Some(Value::String(message)) = err.get("message") {
        texts.push(message.clone());
    }
    if let Some(detail) = detail_of(&Value::Object(err.clone())) {
        if !detail.is_empty() {
            texts.push(detail);
        }
    }
    match get_response_body(err) {
        Value::String(body) => texts.push(body),
        Value::Object(body) => {
            if let Some(Value::String(message)) = body.get("message") {
                texts.push(message.clone());
            }
            if let Some(Value::Object(err_obj)) = body.get("error") {
                if let Some(Value::String(message)) = err_obj.get("message") {
                    texts.push(message.clone());
                }
                if let Some(Value::String(code)) = err_obj.get("code") {
                    texts.push(code.clone());
                }
            }
        }
        _ => {}
    }

    texts.iter().any(|text| {
        CONTEXT_OVERFLOW_PATTERNS
            .iter()
            .any(|pattern| pattern.is_match(text))
    })
}

/// Check if the API refused the request itself (400) for a reason other than its
/// size. Unwraps the SDK's `lastError` retry wrapper.
pub fn is_rejected_request_error(error: &anyhow::Error) -> bool {
    is_rejected_request_value(&error_fields(error))
}

/// `is_rejected_request_error` over an error's field view.
pub fn is_rejected_request_value(error: &Value) -> bool {
    let unwrapped = unwrap_last_error(error);
    let Value::Object(err) = unwrapped else {
        return false;
    };
    get_status_code(err) == Some(400) && !is_context_overflow_value(unwrapped)
}

/// The budget-exceeded text, before the optional `: ${detail}`.
pub const SPENDING_LIMIT_TEXT: &str = "Your organization's AI spending limit has been reached";

/// The budget-exceeded text after the optional detail.
pub const SPENDING_LIMIT_ADVICE: &str =
    ". Please contact your administrator to increase the budget or wait for the limit to reset.";

/// The generic failure text, before `${errorDetail || message}`.
pub const GENERIC_ERROR_PREFIX: &str = "I encountered an error while processing your request: ";

/// Build a friendly `InvokeStep` from a runtime error.
///
/// The single place that turns an LLM/runtime error into user-facing text.
/// `invoke_stream`'s catch paths use this; `invoke()` and the conversation engine
/// just see the resulting step like any other yielded step.
///
/// Logs `{ err }` `Invocation failed` at error level first. Unwraps SDK-wrapped
/// errors (the AI SDK retries internally and wraps the final failure with a
/// `lastError` field), then classifies budget vs. generic:
///
/// - budget: logs the spending-limit warning and returns
///   `${SPENDING_LIMIT_TEXT}${detail ? ': ' + detail : ''}${SPENDING_LIMIT_ADVICE}`
///   with no tool calls and `error: { type: 'budget_exceeded', detail }`;
/// - generic: `${GENERIC_ERROR_PREFIX}${errorDetail || message}` with
///   `error: { type: 'generic', detail: errorDetail }`, where `message` is the
///   error's message (`Unknown error` for a non-error value).
pub fn build_error_step(error: &anyhow::Error) -> InvokeStep {
    todo!()
}

/// The text of a refusal step.
pub const REFUSAL_TEXT: &str = "I can't help with that request. If that seems wrong, tell me more about what you are trying to do and I will take another look.";

/// The model declined the request outright.
///
/// A refusal is not a failure: it arrives as a 200 with `finishReason:
/// 'content-filter'`, with the refusal written out or with no text at all. In the
/// silent shape the engine has nothing to publish; this is the one place that turns
/// that outcome into something a user can read.
///
/// Untagged on purpose. `InvokeError` marks a turn that went wrong so callers can
/// react — route around the cron gate, detect an exhausted budget — and a refusal
/// is an ordinary final answer that happens to be no. The step is `REFUSAL_TEXT`
/// with no tool calls and no error.
pub fn build_refusal_step() -> InvokeStep {
    todo!()
}

fn try_parse_json(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| value.clone()),
        other => other.clone(),
    }
}
