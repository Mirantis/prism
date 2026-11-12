//! The AI SDK's error types, with the names and messages the SDK gives them.
//!
//! Every type is an ordinary `std::error::Error` carried in an `anyhow::Error`; a
//! caller branches with `err.downcast_ref::<ApiCallError>()`. `name()` is the SDK's
//! `error.name` (`AI_APICallError`, …), which the model reads in a tool error and the
//! log reads under `err.name`.

use std::error::Error as StdError;
use std::fmt;
use std::sync::{Arc, Once};

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use super::json::js_stringify;
use super::usage::LanguageModelUsage;
use crate::ai::generate_text::{FinishReason, LanguageModelResponseMetadata};

/// An error shared between a result and the error list that holds it.
pub type SharedError = Arc<anyhow::Error>;

fn source_of(cause: &Option<SharedError>) -> Option<&(dyn StdError + 'static)> {
    cause.as_ref().map(|e| {
        let inner: &(dyn StdError + Send + Sync + 'static) = e.as_ref().as_ref();
        inner as &(dyn StdError + 'static)
    })
}

macro_rules! display_message {
    ($ty:ty) => {
        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.message)
            }
        }
    };
}

/// A failed HTTP call to a provider.
#[derive(Debug, Clone)]
pub struct ApiCallError {
    pub message: String,
    pub url: String,
    pub request_body_values: Value,
    pub status_code: Option<u16>,
    pub response_headers: Option<IndexMap<String, String>>,
    pub response_body: Option<String>,
    pub is_retryable: bool,
    pub data: Option<Value>,
    pub cause: Option<SharedError>,
}

impl ApiCallError {
    pub const NAME: &'static str = "AI_APICallError";

    /// An error with the SDK's default `isRetryable`: 408, 409, 429 and every 5xx.
    pub fn new(
        message: impl Into<String>,
        url: impl Into<String>,
        request_body_values: Value,
        status_code: Option<u16>,
        response_headers: Option<IndexMap<String, String>>,
        response_body: Option<String>,
    ) -> Self {
        ensure_log_fields_registered();
        Self {
            message: message.into(),
            url: url.into(),
            request_body_values,
            status_code,
            response_headers,
            response_body,
            is_retryable: Self::default_is_retryable(status_code),
            data: None,
            cause: None,
        }
    }

    pub fn default_is_retryable(status_code: Option<u16>) -> bool {
        matches!(status_code, Some(code) if code == 408 || code == 409 || code == 429 || code >= 500)
    }

    pub fn name(&self) -> &'static str {
        Self::NAME
    }
}
display_message!(ApiCallError);
impl StdError for ApiCallError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// Why a retried call gave up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryErrorReason {
    MaxRetriesExceeded,
    ErrorNotRetryable,
    Abort,
}

impl RetryErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MaxRetriesExceeded => "maxRetriesExceeded",
            Self::ErrorNotRetryable => "errorNotRetryable",
            Self::Abort => "abort",
        }
    }
}

/// Every attempt of a retried call failed.
#[derive(Debug, Clone)]
pub struct RetryError {
    pub message: String,
    pub reason: RetryErrorReason,
    pub last_error: Option<SharedError>,
    pub errors: Vec<SharedError>,
}

impl RetryError {
    pub const NAME: &'static str = "AI_RetryError";

    pub fn new(
        message: impl Into<String>,
        reason: RetryErrorReason,
        errors: Vec<SharedError>,
    ) -> Self {
        let last_error = errors.last().cloned();
        Self {
            message: message.into(),
            reason,
            last_error,
            errors,
        }
    }

    pub fn name(&self) -> &'static str {
        Self::NAME
    }
}
display_message!(RetryError);
impl StdError for RetryError {}

/// A tool call whose input failed to parse or to match the tool's schema.
#[derive(Debug, Clone)]
pub struct InvalidToolInputError {
    pub message: String,
    pub tool_name: String,
    pub tool_input: String,
    pub cause: Option<SharedError>,
}

impl InvalidToolInputError {
    pub const NAME: &'static str = "AI_InvalidToolInputError";

    pub fn new(
        tool_name: impl Into<String>,
        tool_input: impl Into<String>,
        cause: anyhow::Error,
    ) -> Self {
        let tool_name = tool_name.into();
        let message = format!(
            "Invalid input for tool {}: {}",
            tool_name,
            get_error_message(&cause)
        );
        Self {
            message,
            tool_name,
            tool_input: tool_input.into(),
            cause: Some(Arc::new(cause)),
        }
    }
}
display_message!(InvalidToolInputError);
impl StdError for InvalidToolInputError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// The model called a tool that is not in the tool set.
#[derive(Debug, Clone)]
pub struct NoSuchToolError {
    pub message: String,
    pub tool_name: String,
    pub available_tools: Option<Vec<String>>,
}

impl NoSuchToolError {
    pub const NAME: &'static str = "AI_NoSuchToolError";

    pub fn new(tool_name: impl Into<String>, available_tools: Option<Vec<String>>) -> Self {
        let tool_name = tool_name.into();
        let message = format!(
            "Model tried to call unavailable tool '{}'. {}",
            tool_name,
            match &available_tools {
                None => "No tools are available.".to_string(),
                Some(tools) => format!("Available tools: {}.", tools.join(", ")),
            }
        );
        Self {
            message,
            tool_name,
            available_tools,
        }
    }
}
display_message!(NoSuchToolError);
impl StdError for NoSuchToolError {}

/// `generate_object` produced no object that parses and matches the schema. The
/// tokens the model spent are on `usage`.
#[derive(Debug, Clone)]
pub struct NoObjectGeneratedError {
    pub message: String,
    pub cause: Option<SharedError>,
    pub text: Option<String>,
    pub response: Option<LanguageModelResponseMetadata>,
    pub usage: Option<LanguageModelUsage>,
    pub finish_reason: Option<FinishReason>,
}

impl NoObjectGeneratedError {
    pub const NAME: &'static str = "AI_NoObjectGeneratedError";
}
display_message!(NoObjectGeneratedError);
impl StdError for NoObjectGeneratedError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// Where a validated value came from, named in the message.
#[derive(Debug, Clone, Default)]
pub struct TypeValidationContext {
    pub field: Option<String>,
    pub entity_name: Option<String>,
    pub entity_id: Option<String>,
}

/// A value that does not match its schema.
#[derive(Debug, Clone)]
pub struct TypeValidationError {
    pub message: String,
    pub value: Value,
    pub cause: Option<SharedError>,
    pub context: Option<TypeValidationContext>,
}

impl TypeValidationError {
    pub const NAME: &'static str = "AI_TypeValidationError";

    pub fn new(value: Value, cause: anyhow::Error, context: Option<TypeValidationContext>) -> Self {
        let mut prefix = String::from("Type validation failed");
        if let Some(ctx) = &context {
            if let Some(field) = ctx.field.as_deref().filter(|f| !f.is_empty()) {
                prefix.push_str(&format!(" for {field}"));
            }
            let name = ctx.entity_name.as_deref().filter(|f| !f.is_empty());
            let id = ctx.entity_id.as_deref().filter(|f| !f.is_empty());
            if name.is_some() || id.is_some() {
                let mut parts = Vec::new();
                if let Some(name) = name {
                    parts.push(name.to_string());
                }
                if let Some(id) = id {
                    parts.push(format!("id: \"{id}\""));
                }
                prefix.push_str(&format!(" ({})", parts.join(", ")));
            }
        }
        let message = format!(
            "{}: Value: {}.\nError message: {}",
            prefix,
            js_stringify(&value),
            get_error_message(&cause)
        );
        Self {
            message,
            value,
            cause: Some(Arc::new(cause)),
            context,
        }
    }
}
display_message!(TypeValidationError);
impl StdError for TypeValidationError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// Text that is not JSON.
#[derive(Debug, Clone)]
pub struct JsonParseError {
    pub message: String,
    pub text: String,
    pub cause: Option<SharedError>,
}

impl JsonParseError {
    pub const NAME: &'static str = "AI_JSONParseError";

    pub fn new(text: impl Into<String>, cause: anyhow::Error) -> Self {
        let text = text.into();
        let message = format!(
            "JSON parsing failed: Text: {}.\nError message: {}",
            text,
            get_error_message(&cause)
        );
        Self {
            message,
            text,
            cause: Some(Arc::new(cause)),
        }
    }
}
display_message!(JsonParseError);
impl StdError for JsonParseError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// `JSON.parse` failed, worded as V8 words its `SyntaxError`.
#[derive(Debug, Clone)]
pub struct SyntaxError {
    pub message: String,
}
display_message!(SyntaxError);
impl StdError for SyntaxError {}

/// A prompt the SDK refuses before any call.
#[derive(Debug, Clone)]
pub struct InvalidPromptError {
    pub message: String,
    pub cause: Option<SharedError>,
}

impl InvalidPromptError {
    pub const NAME: &'static str = "AI_InvalidPromptError";

    pub fn new(message: &str) -> Self {
        Self {
            message: format!("Invalid prompt: {message}"),
            cause: None,
        }
    }
}
display_message!(InvalidPromptError);
impl StdError for InvalidPromptError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// An option outside its allowed range.
#[derive(Debug, Clone)]
pub struct InvalidArgumentError {
    pub message: String,
    pub parameter: String,
    pub value: Value,
}

impl InvalidArgumentError {
    pub const NAME: &'static str = "AI_InvalidArgumentError";

    pub fn new(parameter: &str, value: Value, message: &str) -> Self {
        Self {
            message: format!("Invalid argument for parameter {parameter}: {message}"),
            parameter: parameter.to_string(),
            value,
        }
    }
}
display_message!(InvalidArgumentError);
impl StdError for InvalidArgumentError {}

/// A tool call in the prompt has no result before the next user or system message.
#[derive(Debug, Clone)]
pub struct MissingToolResultsError {
    pub message: String,
    pub tool_call_ids: Vec<String>,
}

impl MissingToolResultsError {
    pub const NAME: &'static str = "AI_MissingToolResultsError";

    pub fn new(tool_call_ids: Vec<String>) -> Self {
        let many = tool_call_ids.len() > 1;
        let message = format!(
            "Tool result{} missing for tool call{} {}.",
            if many { "s are" } else { " is" },
            if many { "s" } else { "" },
            tool_call_ids.join(", ")
        );
        Self {
            message,
            tool_call_ids,
        }
    }
}
display_message!(MissingToolResultsError);
impl StdError for MissingToolResultsError {}

/// The model answered without the tool call `tool_choice` required.
#[derive(Debug, Clone)]
pub struct ToolChoiceViolationError {
    pub message: String,
    pub tool_choice: crate::ai::provider::LanguageModelV4ToolChoice,
    pub finish_reason: FinishReason,
    pub provider: String,
    pub model_id: String,
}

impl ToolChoiceViolationError {
    pub const NAME: &'static str = "AI_ToolChoiceViolationError";
}
display_message!(ToolChoiceViolationError);
impl StdError for ToolChoiceViolationError {}

/// File data that is neither base64 text, bytes nor a URL.
#[derive(Debug, Clone)]
pub struct InvalidDataContentError {
    pub message: String,
    pub content: Value,
    pub cause: Option<SharedError>,
}

impl InvalidDataContentError {
    pub const NAME: &'static str = "AI_InvalidDataContentError";
}
display_message!(InvalidDataContentError);
impl StdError for InvalidDataContentError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// A provider answered with data the SDK cannot use.
#[derive(Debug, Clone)]
pub struct InvalidResponseDataError {
    pub message: String,
    pub data: Value,
}

impl InvalidResponseDataError {
    pub const NAME: &'static str = "AI_InvalidResponseDataError";

    pub fn new(data: Value, message: Option<String>) -> Self {
        let message =
            message.unwrap_or_else(|| format!("Invalid response data: {}.", js_stringify(&data)));
        Self { message, data }
    }
}
display_message!(InvalidResponseDataError);
impl StdError for InvalidResponseDataError {}

/// A file the model cannot read by URL could not be downloaded.
#[derive(Debug, Clone)]
pub struct DownloadError {
    pub message: String,
    pub url: String,
    pub status_code: Option<u16>,
    pub status_text: Option<String>,
    pub cause: Option<SharedError>,
}

impl DownloadError {
    pub const NAME: &'static str = "AI_DownloadError";

    pub fn from_status(url: &str, status_code: u16, status_text: &str) -> Self {
        Self {
            message: format!("Failed to download {url}: {status_code} {status_text}"),
            url: url.to_string(),
            status_code: Some(status_code),
            status_text: Some(status_text.to_string()),
            cause: None,
        }
    }

    pub fn from_cause(url: &str, cause: anyhow::Error) -> Self {
        Self {
            message: format!("Failed to download {url}: {}", get_error_message(&cause)),
            url: url.to_string(),
            status_code: None,
            status_text: None,
            cause: Some(Arc::new(cause)),
        }
    }
}
display_message!(DownloadError);
impl StdError for DownloadError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        source_of(&self.cause)
    }
}

/// A provider does not support what the call asked for.
#[derive(Debug, Clone)]
pub struct UnsupportedFunctionalityError {
    pub message: String,
    pub functionality: String,
}

impl UnsupportedFunctionalityError {
    pub const NAME: &'static str = "AI_UnsupportedFunctionalityError";

    pub fn new(functionality: &str) -> Self {
        Self {
            message: format!("'{functionality}' functionality not supported."),
            functionality: functionality.to_string(),
        }
    }
}
display_message!(UnsupportedFunctionalityError);
impl StdError for UnsupportedFunctionalityError {}

/// A model asked for more embeddings in one call than it serves.
#[derive(Debug, Clone)]
pub struct TooManyEmbeddingValuesForCallError {
    pub message: String,
    pub provider: String,
    pub model_id: String,
    pub max_embeddings_per_call: usize,
    pub values_count: usize,
}

impl TooManyEmbeddingValuesForCallError {
    pub const NAME: &'static str = "AI_TooManyEmbeddingValuesForCallError";

    pub fn new(
        provider: &str,
        model_id: &str,
        max_embeddings_per_call: usize,
        values_count: usize,
    ) -> Self {
        Self {
            message: format!(
                "Too many values for a single embedding call. The {provider} model \"{model_id}\" can only embed up to {max_embeddings_per_call} values per call, but {values_count} values were provided."
            ),
            provider: provider.to_string(),
            model_id: model_id.to_string(),
            max_embeddings_per_call,
            values_count,
        }
    }
}
display_message!(TooManyEmbeddingValuesForCallError);
impl StdError for TooManyEmbeddingValuesForCallError {}

/// A missing API key.
#[derive(Debug, Clone)]
pub struct LoadApiKeyError {
    pub message: String,
}

impl LoadApiKeyError {
    pub const NAME: &'static str = "AI_LoadAPIKeyError";
}
display_message!(LoadApiKeyError);
impl StdError for LoadApiKeyError {}

/// A missing provider setting.
#[derive(Debug, Clone)]
pub struct LoadSettingError {
    pub message: String,
}

impl LoadSettingError {
    pub const NAME: &'static str = "AI_LoadSettingError";
}
display_message!(LoadSettingError);
impl StdError for LoadSettingError {}

/// A provider answered with no body.
#[derive(Debug, Clone)]
pub struct EmptyResponseBodyError {
    pub message: String,
}

impl Default for EmptyResponseBodyError {
    fn default() -> Self {
        Self {
            message: "Empty response body".to_string(),
        }
    }
}

impl EmptyResponseBodyError {
    pub const NAME: &'static str = "AI_EmptyResponseBodyError";
}
display_message!(EmptyResponseBodyError);
impl StdError for EmptyResponseBodyError {}

/// The call was cancelled through its `CancellationToken`.
#[derive(Debug, Clone)]
pub struct AbortError {
    pub message: String,
}

impl AbortError {
    pub const NAME: &'static str = "AbortError";

    /// The reason an aborted `AbortSignal` carries.
    pub fn operation() -> Self {
        Self {
            message: "This operation was aborted".to_string(),
        }
    }

    /// A retry delay cut short.
    pub fn delay() -> Self {
        Self {
            message: "Delay was aborted".to_string(),
        }
    }
}
display_message!(AbortError);
impl StdError for AbortError {}

/// The issues a schema check found, as the schema library reports them. Its text is
/// the issue list alone, without a name in front.
#[derive(Debug, Clone)]
pub struct SchemaIssuesError {
    pub message: String,
    pub issues: Vec<Value>,
}

impl SchemaIssuesError {
    pub fn new(issues: Vec<Value>) -> Self {
        let message = super::json::js_stringify_pretty(&Value::Array(issues.clone()));
        Self { message, issues }
    }
}
display_message!(SchemaIssuesError);
impl StdError for SchemaIssuesError {}

/// Whether the error is an abort (`AbortError`, `ResponseAborted`, `TimeoutError`).
pub fn is_abort_error(err: &anyhow::Error) -> bool {
    err.downcast_ref::<AbortError>().is_some()
}

/// The SDK name of a known error type.
fn sdk_name(err: &(dyn StdError + 'static)) -> Option<&'static str> {
    macro_rules! try_name {
        ($($ty:ty),*) => {
            $(if err.downcast_ref::<$ty>().is_some() { return Some(<$ty>::NAME); })*
        };
    }
    try_name!(
        ApiCallError,
        RetryError,
        InvalidToolInputError,
        NoSuchToolError,
        NoObjectGeneratedError,
        TypeValidationError,
        JsonParseError,
        InvalidPromptError,
        InvalidArgumentError,
        MissingToolResultsError,
        ToolChoiceViolationError,
        InvalidDataContentError,
        InvalidResponseDataError,
        DownloadError,
        UnsupportedFunctionalityError,
        TooManyEmbeddingValuesForCallError,
        LoadApiKeyError,
        LoadSettingError,
        EmptyResponseBodyError,
        AbortError
    );
    if err.downcast_ref::<SyntaxError>().is_some() {
        return Some("SyntaxError");
    }
    None
}

/// `error.name` as JavaScript reports it: the SDK's name for its own errors, the
/// `name` a runtime error type registers for its log fields, else `Error`.
pub fn error_name(err: &anyhow::Error) -> String {
    let root: &(dyn StdError + 'static) = err.as_ref();
    if let Some(name) = sdk_name(root) {
        return name.to_string();
    }
    if root.downcast_ref::<SchemaIssuesError>().is_some() {
        return String::new();
    }
    match crate::lib::log_redaction::serialize_error(err).get("name") {
        Some(Value::String(name)) => name.clone(),
        _ => "Error".to_string(),
    }
}

/// `getErrorMessage(error)` for a thrown error: `error.toString()`, which is
/// `name: message`, or either alone when the other is empty.
pub fn get_error_message(err: &anyhow::Error) -> String {
    let name = error_name(err);
    let message = err.to_string();
    if name.is_empty() {
        message
    } else if message.is_empty() {
        name
    } else {
        format!("{name}: {message}")
    }
}

/// `getErrorMessage(value)` for a thrown value that is not an error: a string is
/// itself, anything else its JSON, nothing is `unknown error`.
pub fn get_value_error_message(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "unknown error".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => js_stringify(other),
    }
}

fn summary(err: &anyhow::Error) -> Value {
    json!({ "name": error_name(err), "message": err.to_string() })
}

fn log_fields(err: &(dyn StdError + 'static)) -> Option<Map<String, Value>> {
    let name = sdk_name(err)?;
    let mut map = Map::new();
    map.insert("name".into(), json!(name));
    if let Some(e) = err.downcast_ref::<ApiCallError>() {
        if let Some(code) = e.status_code {
            map.insert("statusCode".into(), json!(code));
        }
        map.insert("url".into(), json!(e.url));
        map.insert("isRetryable".into(), json!(e.is_retryable));
    } else if let Some(e) = err.downcast_ref::<RetryError>() {
        map.insert("reason".into(), json!(e.reason.as_str()));
        if let Some(last) = &e.last_error {
            map.insert("lastError".into(), summary(last));
        }
        map.insert(
            "errors".into(),
            Value::Array(e.errors.iter().map(|e| summary(e)).collect()),
        );
    } else if let Some(e) = err.downcast_ref::<DownloadError>() {
        if let Some(code) = e.status_code {
            map.insert("statusCode".into(), json!(code));
        }
        map.insert("url".into(), json!(e.url));
    }
    Some(map)
}

static REGISTER: Once = Once::new();

/// Registers the log fields of every SDK error with the logger's error serializer,
/// so a logged SDK error keeps `name`, `statusCode`, `url`, `isRetryable` and
/// `reason`. Idempotent; every entry point of this module calls it.
pub fn ensure_log_fields_registered() {
    REGISTER.call_once(|| crate::lib::log_redaction::register_error_fields(log_fields));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lib::log_redaction::err_json;

    #[test]
    fn logs_an_api_call_error_without_its_bodies() {
        let mut error = ApiCallError::new(
            "Bad Request",
            "https://bedrock.example/model/x/converse",
            json!({ "messages": ["secret"] }),
            Some(400),
            Some(
                [("x-request-id".to_string(), "1".to_string())]
                    .into_iter()
                    .collect(),
            ),
            Some("{\"message\":\"secret\"}".to_string()),
        );
        error.data = Some(json!({ "secret": true }));
        let logged = err_json(&anyhow::Error::new(error));
        assert_eq!(logged["name"], "AI_APICallError");
        assert_eq!(logged["statusCode"], 400);
        assert_eq!(logged["url"], "https://bedrock.example/model/x/converse");
        assert_eq!(logged["isRetryable"], false);
        assert_eq!(logged["message"], "Bad Request");
        assert!(!logged.to_string().contains("secret"));
    }

    #[test]
    fn logs_a_retry_error_with_its_reason_and_last_error() {
        let attempt = || -> SharedError {
            Arc::new(
                ApiCallError::new(
                    "Overloaded",
                    "u",
                    json!({}),
                    Some(529),
                    None,
                    Some("body".into()),
                )
                .into(),
            )
        };
        let error = RetryError::new(
            "Failed after 3 attempts.",
            RetryErrorReason::MaxRetriesExceeded,
            vec![attempt(), attempt()],
        );
        ensure_log_fields_registered();
        let logged = err_json(&anyhow::Error::new(error));
        assert_eq!(logged["name"], "AI_RetryError");
        assert_eq!(logged["reason"], "maxRetriesExceeded");
        assert_eq!(
            logged["lastError"],
            json!({ "name": "AI_APICallError", "message": "Overloaded" })
        );
        assert_eq!(logged["errors"].as_array().unwrap().len(), 2);
        assert!(!logged.to_string().contains("body"));
    }

    #[test]
    fn writes_error_messages_as_to_string_does() {
        assert_eq!(
            get_error_message(&anyhow::anyhow!("kaboom")),
            "Error: kaboom"
        );
        let no_tool = NoSuchToolError::new("nope", None);
        assert_eq!(
            get_error_message(&anyhow::Error::new(no_tool)),
            "AI_NoSuchToolError: Model tried to call unavailable tool 'nope'. No tools are available."
        );
        assert_eq!(get_value_error_message(None), "unknown error");
        assert_eq!(
            get_value_error_message(Some(&json!({ "a": 1 }))),
            "{\"a\":1}"
        );
    }
}
