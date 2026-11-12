//! The errors an MCP client reports.

use std::error::Error as StdError;
use std::fmt;
use std::sync::Once;

use serde_json::{Map, Value, json};

/// `MCPClientError`: an error of the MCP client, its transport or the server.
#[derive(Debug)]
pub struct MCPClientError {
    pub message: String,
    pub cause: Option<anyhow::Error>,
    /// `error.data` of the server's JSON-RPC error.
    pub data: Option<Value>,
    /// The server's JSON-RPC error code (`-32601`, `-32602`, …).
    pub code: Option<i64>,
    /// The HTTP status of the failed response, for an HTTP transport.
    pub status_code: Option<u16>,
    /// The endpoint the failed HTTP request went to.
    pub url: Option<String>,
    /// The failed HTTP response's body.
    pub response_body: Option<String>,
}

impl MCPClientError {
    pub const NAME: &'static str = "MCPClientError";

    pub fn new(message: impl Into<String>) -> Self {
        ensure_log_fields_registered();
        Self {
            message: message.into(),
            cause: None,
            data: None,
            code: None,
            status_code: None,
            url: None,
            response_body: None,
        }
    }

    pub fn with_cause(mut self, cause: anyhow::Error) -> Self {
        self.cause = Some(cause);
        self
    }

    pub fn with_http(mut self, status_code: u16, url: &str, response_body: Option<String>) -> Self {
        self.status_code = Some(status_code);
        self.url = Some(url.to_string());
        self.response_body = response_body;
        self
    }
}

impl fmt::Display for MCPClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl StdError for MCPClientError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.cause
            .as_ref()
            .map(|cause| cause.as_ref() as &(dyn StdError + 'static))
    }
}

/// A request that never got a response: what `fetch` rejects with when the
/// connection fails (`TypeError: fetch failed`).
#[derive(Debug)]
pub struct FetchFailedError {
    pub source: reqwest::Error,
}

impl FetchFailedError {
    pub fn new(source: reqwest::Error) -> Self {
        ensure_log_fields_registered();
        Self { source }
    }
}

impl fmt::Display for FetchFailedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("fetch failed")
    }
}

impl StdError for FetchFailedError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(&self.source)
    }
}

/// The error a process end reports, shared by every waiter on it.
#[derive(Debug)]
pub struct SharedCauseError(pub std::sync::Arc<anyhow::Error>);

impl fmt::Display for SharedCauseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl StdError for SharedCauseError {}

fn log_fields(err: &(dyn StdError + 'static)) -> Option<Map<String, Value>> {
    if let Some(e) = err.downcast_ref::<MCPClientError>() {
        let mut map = Map::new();
        map.insert("name".into(), json!(MCPClientError::NAME));
        if let Some(code) = e.code {
            map.insert("code".into(), json!(code));
        }
        if let Some(status) = e.status_code {
            map.insert("statusCode".into(), json!(status));
        }
        if let Some(url) = &e.url {
            map.insert("url".into(), json!(url));
        }
        if let Some(data) = &e.data {
            map.insert("data".into(), data.clone());
        }
        if let Some(body) = &e.response_body {
            map.insert("responseBody".into(), json!(body));
        }
        return Some(map);
    }
    if err.downcast_ref::<FetchFailedError>().is_some() {
        let mut map = Map::new();
        map.insert("name".into(), json!("TypeError"));
        return Some(map);
    }
    None
}

static REGISTER: Once = Once::new();

/// Registers the log fields and the `name` of the MCP errors, so a logged or
/// model-facing error reads `MCPClientError: …` as the SDK's does.
pub fn ensure_log_fields_registered() {
    REGISTER.call_once(|| crate::lib::log_redaction::register_error_fields(log_fields));
}
