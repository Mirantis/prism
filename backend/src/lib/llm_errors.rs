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

use crate::ai::{ApiCallError, RetryError};
use crate::lib::log_redaction::err_json;
use crate::types::{InvokeError, InvokeErrorType, InvokeStep};
use crate::{log_error, log_warn};

/// The fields a JavaScript error object for `error` would have: an AI SDK
/// `APICallError` gives `message`, `statusCode`, `responseBody` and `url`; a
/// `RetryError` gives `message` and `lastError` (itself such a view); any other
/// error gives `message` alone.
pub fn error_fields(error: &anyhow::Error) -> Value {
    if let Some(api) = error.downcast_ref::<ApiCallError>() {
        return api_call_error_fields(api);
    }
    if let Some(retry) = error.downcast_ref::<RetryError>() {
        let mut map = Map::new();
        map.insert("message".into(), json!(retry.message));
        if let Some(last) = &retry.last_error {
            map.insert("lastError".into(), error_fields(last));
        }
        return Value::Object(map);
    }
    for cause in error.chain() {
        if let Some(api) = cause.downcast_ref::<ApiCallError>() {
            return api_call_error_fields(api);
        }
    }
    json!({ "message": error.to_string() })
}

fn api_call_error_fields(error: &ApiCallError) -> Value {
    let mut map = Map::new();
    map.insert("message".into(), json!(error.message));
    map.insert("url".into(), json!(error.url));
    if let Some(status) = error.status_code {
        map.insert("statusCode".into(), json!(status));
    }
    if let Some(body) = &error.response_body {
        map.insert("responseBody".into(), json!(body));
    }
    map.insert("isRetryable".into(), json!(error.is_retryable));
    if let Some(data) = &error.data {
        map.insert("data".into(), data.clone());
    }
    Value::Object(map)
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
    if let Some(Value::Object(data)) = err.get("data")
        && let Some(status) = number_of(data.get("status"))
    {
        return Some(status);
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
    if let Some(detail) = detail_of(&Value::Object(err.clone()))
        && !detail.is_empty()
    {
        texts.push(detail);
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
    // Handed over as `err` so the redacting serializer sees it. A `responseBody`
    // logged verbatim quotes back whatever was sent, including a meeting's
    // transcript on a failed gate call.
    log_error!(json!({ "err": err_json(error) }), "Invocation failed");
    error_step_from_fields(&error_fields(error))
}

/// `build_error_step` after the log line, over an error's field view.
fn error_step_from_fields(fields: &Value) -> InvokeStep {
    let message = match fields.get("message") {
        Some(Value::String(message)) => message.clone(),
        _ => "Unknown error".to_string(),
    };

    // The SDK wraps retried errors: unwrap lastError to check the original.
    let original = unwrap_last_error(fields);

    if is_spending_limit_value(original) {
        log_spending_limit_warning_value(original);
        let detail = detail_of(original);
        let detail_clause = match &detail {
            Some(detail) if !detail.is_empty() => format!(": {detail}"),
            _ => String::new(),
        };
        return InvokeStep {
            text: format!("{SPENDING_LIMIT_TEXT}{detail_clause}{SPENDING_LIMIT_ADVICE}"),
            tool_calls: Vec::new(),
            error: Some(InvokeError {
                kind: InvokeErrorType::BudgetExceeded,
                detail,
            }),
            ..Default::default()
        };
    }

    let error_detail = detail_of(original);
    let shown = match &error_detail {
        Some(detail) if !detail.is_empty() => detail.clone(),
        _ => message,
    };
    InvokeStep {
        text: format!("{GENERIC_ERROR_PREFIX}{shown}"),
        tool_calls: Vec::new(),
        error: Some(InvokeError {
            kind: InvokeErrorType::Generic,
            detail: error_detail,
        }),
        ..Default::default()
    }
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
    InvokeStep {
        text: REFUSAL_TEXT.to_string(),
        tool_calls: Vec::new(),
        ..Default::default()
    }
}

fn try_parse_json(value: &Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or_else(|_| value.clone()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::RetryErrorReason;
    use std::sync::Arc;

    fn api_error(status: Option<u16>, body: Option<&str>, message: &str) -> anyhow::Error {
        anyhow::Error::new(ApiCallError::new(
            message,
            "https://llm.example/v1/messages",
            json!({}),
            status,
            None,
            body.map(str::to_string),
        ))
    }

    fn retried(last: anyhow::Error) -> anyhow::Error {
        anyhow::Error::new(RetryError::new(
            "Failed after 3 attempts",
            RetryErrorReason::MaxRetriesExceeded,
            vec![Arc::new(last)],
        ))
    }

    #[test]
    fn detects_a_budget_429_in_each_body_shape() {
        let body = json!({ "type": "budget-exceeded", "title": "Budget Exceeded" }).to_string();
        assert!(is_spending_limit_value(
            &json!({ "status": 429, "responseBody": body })
        ));
        assert!(is_spending_limit_value(
            &json!({ "status": 429, "body": { "type": "budget-exceeded" } })
        ));
        assert!(is_spending_limit_value(
            &json!({ "status": 429, "response": { "data": { "type": "budget-exceeded" } } })
        ));
        assert!(is_spending_limit_value(
            &json!({ "statusCode": 429, "responseBody": "{\"type\":\"budget-exceeded\"}" })
        ));
    }

    #[test]
    fn leaves_out_other_statuses_and_types() {
        assert!(!is_spending_limit_value(
            &json!({ "status": 500, "responseBody": "{\"type\":\"budget-exceeded\"}" })
        ));
        assert!(!is_spending_limit_value(
            &json!({ "status": 429, "message": "throttled" })
        ));
        assert!(!is_spending_limit_value(
            &json!({ "status": 429, "responseBody": "{\"type\":\"rate-limit\"}" })
        ));
        assert!(!is_spending_limit_value(&Value::Null));
        assert!(!is_spending_limit_value(&json!("error")));
    }

    #[test]
    fn reads_the_problem_detail() {
        assert_eq!(
            detail_of(
                &json!({ "status": 502, "responseBody": "{\"detail\":\"upstream timeout\"}" })
            ),
            Some("upstream timeout".into())
        );
        assert_eq!(
            detail_of(&json!({ "status": 400, "body": { "detail": "malformed request" } })),
            Some("malformed request".into())
        );
        assert_eq!(
            detail_of(&json!({ "response": { "data": { "detail": "nested detail" } } })),
            Some("nested detail".into())
        );
        assert_eq!(
            detail_of(&json!({ "responseBody": "{\"message\":\"no detail key\"}" })),
            None
        );
        assert_eq!(detail_of(&json!({ "responseBody": "not-json" })), None);
        assert_eq!(detail_of(&Value::Null), None);
    }

    #[test]
    fn builds_a_budget_step_with_its_detail() {
        let error = api_error(
            Some(429),
            Some("{\"type\":\"budget-exceeded\",\"detail\":\"Monthly budget: $5 of $5 used\"}"),
            "Too Many Requests",
        );
        let step = build_error_step(&error);
        assert_eq!(
            step.text,
            "Your organization's AI spending limit has been reached: Monthly budget: $5 of $5 used. Please contact your administrator to increase the budget or wait for the limit to reset."
        );
        assert!(step.tool_calls.is_empty());
        assert_eq!(
            serde_json::to_value(step.error).unwrap(),
            json!({ "type": "budget_exceeded", "detail": "Monthly budget: $5 of $5 used" })
        );
    }

    #[test]
    fn omits_the_detail_clause_when_the_budget_error_has_none() {
        let error = api_error(
            Some(429),
            Some("{\"type\":\"budget-exceeded\"}"),
            "Too Many Requests",
        );
        let step = build_error_step(&error);
        assert!(step.text.contains("AI spending limit has been reached."));
        assert_eq!(
            serde_json::to_value(step.error).unwrap(),
            json!({ "type": "budget_exceeded", "detail": null })
        );
    }

    #[test]
    fn unwraps_the_retry_wrapper_to_detect_a_budget() {
        let error = retried(api_error(
            Some(429),
            Some("{\"type\":\"budget-exceeded\",\"detail\":\"wrapped detail\"}"),
            "Too Many Requests",
        ));
        let step = build_error_step(&error);
        assert_eq!(
            step.error.as_ref().unwrap().kind,
            InvokeErrorType::BudgetExceeded
        );
        assert!(step.text.contains("wrapped detail"));
    }

    #[test]
    fn builds_a_generic_step_from_the_message() {
        let step = build_error_step(&anyhow::anyhow!("Model timeout"));
        assert_eq!(
            step.text,
            "I encountered an error while processing your request: Model timeout"
        );
        assert_eq!(
            serde_json::to_value(step.error).unwrap(),
            json!({ "type": "generic", "detail": null })
        );
    }

    #[test]
    fn prefers_the_problem_detail_over_the_message() {
        let step = build_error_step(&api_error(
            Some(400),
            Some("{\"detail\":\"invalid prompt\"}"),
            "400",
        ));
        assert_eq!(
            step.text,
            "I encountered an error while processing your request: invalid prompt"
        );
    }

    #[test]
    fn detects_a_context_overflow() {
        assert!(is_context_overflow_error(&anyhow::anyhow!(
            "prompt is too long: 213456 tokens > 200000 maximum"
        )));
        assert!(is_context_overflow_error(&anyhow::anyhow!(
            "Input is too long for requested model."
        )));
        assert!(is_context_overflow_error(&api_error(
            Some(400),
            Some("{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"too big\"}}"),
            "Bad Request",
        )));
        assert!(is_context_overflow_error(&api_error(
            Some(413),
            None,
            "Payload Too Large"
        )));
        assert!(is_context_overflow_error(&retried(anyhow::anyhow!(
            "prompt is too long: 9 tokens > 1 maximum"
        ))));
    }

    #[test]
    fn leaves_unrelated_errors_out_of_overflow() {
        assert!(!is_context_overflow_error(&anyhow::anyhow!("rate limited")));
        assert!(!is_context_overflow_error(&anyhow::anyhow!(
            "The security token is invalid"
        )));
        assert!(!is_context_overflow_value(&json!({
            "status": 429,
            "responseBody": "{\"type\":\"budget-exceeded\",\"detail\":\"x\"}",
        })));
        assert!(!is_context_overflow_value(&Value::Null));
        assert!(!is_context_overflow_value(&json!("prompt is too long")));
    }

    #[test]
    fn detects_a_rejected_request_behind_the_retry_wrapper() {
        assert!(is_rejected_request_error(&api_error(
            Some(400),
            None,
            "Bad Request"
        )));
        assert!(is_rejected_request_error(&retried(api_error(
            Some(400),
            None,
            "Bad Request"
        ))));
    }

    #[test]
    fn leaves_out_an_oversized_400_and_other_statuses() {
        assert!(!is_rejected_request_error(&api_error(
            Some(400),
            None,
            "Input is too long for requested model."
        )));
        assert!(!is_rejected_request_error(&api_error(
            Some(429),
            None,
            "Too Many Requests"
        )));
        assert!(!is_rejected_request_error(&anyhow::anyhow!(
            "Model timeout"
        )));
    }

    #[test]
    fn writes_the_refusal_without_an_error() {
        let step = build_refusal_step();
        assert_eq!(step.text, REFUSAL_TEXT);
        assert!(step.error.is_none());
    }
}
