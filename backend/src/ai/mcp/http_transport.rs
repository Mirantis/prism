//! The Streamable HTTP transport (`HttpMCPTransport`): a POST per message, its
//! response as JSON or as a server-sent event stream, and, on the legacy
//! protocol, an optional GET stream for the server's own messages.

use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::error::{FetchFailedError, MCPClientError};
use super::event_source::{EventSourceParser, is_message_event};
use super::headers::{encode_mcp_header_value, request_headers};
use super::transport::{
    HTTP, MCPTransport, MCPTransportCloseOptions, MCPTransportSendOptions, TransportHandlers,
    abort_error, any_cancelled, parse_url, status_text,
};
use super::types::{
    LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION, json_parse, parse_jsonrpc_message,
    validate_jsonrpc_message,
};

/// Inbound stream reconnection: delays of 1 s growing by 1.5 up to 30 s, at most
/// two attempts.
const INITIAL_RECONNECTION_DELAY_MS: f64 = 1000.0;
const MAX_RECONNECTION_DELAY_MS: f64 = 30000.0;
const RECONNECTION_DELAY_GROW_FACTOR: f64 = 1.5;
const MAX_RETRIES: u32 = 2;

#[derive(Default)]
struct HttpState {
    /// Set by `start`; cancelled by `close`.
    abort: Option<CancellationToken>,
    session_id: Option<String>,
    protocol_version: Option<String>,
    /// Closes the open inbound stream.
    inbound_sse: Option<CancellationToken>,
    last_inbound_event_id: Option<String>,
    inbound_reconnect_attempts: u32,
}

pub struct HttpMCPTransport {
    url: String,
    headers: IndexMap<String, String>,
    state: Mutex<HttpState>,
    handlers: Mutex<Option<TransportHandlers>>,
    weak: Weak<Self>,
}

impl HttpMCPTransport {
    pub fn new(
        url: &str,
        headers: IndexMap<String, String>,
        initial_protocol_version: Option<String>,
    ) -> anyhow::Result<Arc<Self>> {
        let url = parse_url(url)?.to_string();
        Ok(Arc::new_cyclic(|weak| HttpMCPTransport {
            url,
            headers,
            state: Mutex::new(HttpState {
                protocol_version: Some(
                    initial_protocol_version
                        .unwrap_or_else(|| LATEST_LEGACY_PROTOCOL_VERSION.to_string()),
                ),
                ..HttpState::default()
            }),
            handlers: Mutex::new(None),
            weak: weak.clone(),
        }))
    }

    fn handlers(&self) -> Option<TransportHandlers> {
        self.handlers.lock().clone()
    }

    fn emit_error(&self, error: &anyhow::Error) {
        if let Some(handlers) = self.handlers() {
            (handlers.on_error)(error);
        }
    }

    fn deliver(&self, message: Value) -> anyhow::Result<()> {
        match self.handlers() {
            Some(handlers) => (handlers.on_message)(message),
            None => Ok(()),
        }
    }

    fn is_modern_protocol(&self) -> bool {
        self.state
            .lock()
            .protocol_version
            .as_deref()
            .unwrap_or(LATEST_PROTOCOL_VERSION)
            == LATEST_PROTOCOL_VERSION
    }

    fn common_headers(
        &self,
        base: Vec<(String, String)>,
        include_session_id: bool,
    ) -> Vec<(String, String)> {
        let modern = self.is_modern_protocol();
        let state = self.state.lock();
        let mut pairs: Vec<(String, String)> = self
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        pairs.extend(base);
        pairs.push((
            "mcp-protocol-version".into(),
            state
                .protocol_version
                .clone()
                .unwrap_or_else(|| LATEST_LEGACY_PROTOCOL_VERSION.to_string()),
        ));
        if !modern
            && include_session_id
            && let Some(session) = state.session_id.as_ref().filter(|s| !s.is_empty())
        {
            pairs.push(("mcp-session-id".into(), session.clone()));
        }
        request_headers(pairs)
    }

    fn set_session_id(&self, session_id: Option<String>) {
        self.state.lock().session_id = session_id;
    }

    fn apply_session_id_from_response(&self, response: &reqwest::Response) {
        if self.is_modern_protocol() {
            return;
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty());
        if let Some(session) = session {
            self.set_session_id(Some(session.to_string()));
        }
    }

    fn expire_session_id(&self, session_id: &str) {
        let mut state = self.state.lock();
        if state.session_id.as_deref() == Some(session_id) {
            state.session_id = None;
        }
    }

    fn abort_signal(&self) -> Option<CancellationToken> {
        self.state.lock().abort.clone()
    }

    fn has_inbound_sse(&self) -> bool {
        self.state.lock().inbound_sse.is_some()
    }

    fn standard_request_headers(message: &Value) -> Vec<(String, String)> {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut headers = vec![("Mcp-Method".to_string(), method.to_string())];
        let params = message.get("params");
        let name = match method {
            "resources/read" => params.and_then(|p| p.get("uri")),
            "tools/call" | "prompts/get" => params.and_then(|p| p.get("name")),
            _ => None,
        };
        if let Some(Value::String(name)) = name {
            headers.push(("Mcp-Name".to_string(), encode_mcp_header_value(name)));
        }
        headers
    }

    /// One POST of `message`. Errors it reports itself go to `on_error` here as
    /// well as being returned; `send` reports every returned error once more.
    async fn attempt(
        &self,
        message: &Value,
        options: &MCPTransportSendOptions,
        request_signals: &[CancellationToken],
    ) -> anyhow::Result<()> {
        let is_initialize = message.get("method").and_then(Value::as_str) == Some("initialize");
        let session_for_request = if is_initialize {
            None
        } else {
            self.state.lock().session_id.clone()
        };
        let modern = self.is_modern_protocol();
        let mut base = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            (
                "Accept".to_string(),
                "application/json, text/event-stream".to_string(),
            ),
        ];
        if modern {
            if let Some(extra) = &options.headers {
                base.extend(extra.iter().cloned());
            }
            if message.get("method").is_some() && message.get("id").is_some() {
                base.extend(Self::standard_request_headers(message));
            }
        }
        let headers = self.common_headers(base, !is_initialize);

        let mut request = HTTP.post(&self.url);
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        let request = request.body(crate::ai::json::js_stringify(message));
        let response = tokio::select! {
            response = request.send() => response.map_err(|e| anyhow::Error::new(FetchFailedError::new(e)))?,
            _ = any_cancelled(request_signals) => return Err(abort_error()),
        };

        self.apply_session_id_from_response(&response);

        let status = response.status();
        if status.as_u16() == 202 {
            if !self.is_modern_protocol() && !self.has_inbound_sse() {
                self.start_inbound_sse(None);
            }
            return Ok(());
        }

        if !status.is_success() {
            let text: Option<String> = tokio::select! {
                text = response.text() => text.ok(),
                _ = any_cancelled(request_signals) => None,
            };

            if let (Some(id), Some(text)) = (message.get("id"), &text)
                && let Ok(parsed) = parse_jsonrpc_message(text)
                && parsed.get("error").is_some()
            {
                let parsed = if parsed.get("id").is_none_or(Value::is_null) {
                    let mut with_id = parsed;
                    with_id["id"] = id.clone();
                    with_id
                } else {
                    parsed
                };
                self.deliver(parsed)?;
                return Ok(());
            }

            let shown = text.clone().unwrap_or_else(|| "null".to_string());
            let mut error_message = format!(
                "MCP HTTP Transport Error: POSTing to endpoint (HTTP {}): {shown}",
                status.as_u16()
            );
            if status.as_u16() == 404 {
                if !self.is_modern_protocol() && session_for_request.is_some() {
                    if let Some(session) = &session_for_request {
                        self.expire_session_id(session);
                    }
                    error_message.push_str(
                        ". The MCP session expired. Create a new client without `initialSessionId` to start a fresh session",
                    );
                } else if !self.is_modern_protocol() {
                    error_message.push_str(
                        ". This server does not support HTTP transport. Try using `sse` transport instead",
                    );
                }
            }
            let error = anyhow::Error::new(MCPClientError::new(error_message).with_http(
                status.as_u16(),
                &self.url,
                text,
            ));
            self.emit_error(&error);
            return Err(error);
        }

        // A notification wants no JSON-RPC response; some servers answer 200
        // with an acknowledgment instead of 202.
        if message.get("id").is_none() {
            return Ok(());
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        if content_type.contains("application/json") {
            let body = tokio::select! {
                body = response.text() => body.map_err(|e| anyhow::Error::new(FetchFailedError::new(e)))?,
                _ = any_cancelled(request_signals) => return Err(abort_error()),
            };
            let data = json_parse(&body)?;
            let messages = match data {
                Value::Array(items) => items
                    .into_iter()
                    .map(validate_jsonrpc_message)
                    .collect::<anyhow::Result<Vec<_>>>()?,
                other => vec![validate_jsonrpc_message(other)?],
            };
            for message in messages {
                self.deliver(message)?;
            }
            return Ok(());
        }

        if content_type.contains("text/event-stream") {
            let weak = self.weak.clone();
            let request_signals = request_signals.to_vec();
            let request_signal = options.signal.clone();
            tokio::spawn(async move {
                let mut stream = response.bytes_stream();
                let mut parser = EventSourceParser::new();
                loop {
                    let chunk = tokio::select! {
                        chunk = stream.next() => chunk,
                        _ = any_cancelled(&request_signals) => return,
                    };
                    let Some(transport) = weak.upgrade() else {
                        return;
                    };
                    match chunk {
                        None => return,
                        Some(Err(error)) => {
                            if request_signal.as_ref().is_some_and(|s| s.is_cancelled()) {
                                return;
                            }
                            transport.emit_error(&anyhow::Error::new(error));
                            return;
                        }
                        Some(Ok(bytes)) => {
                            for event in parser.feed(&bytes) {
                                if !is_message_event(event.event.as_deref()) {
                                    continue;
                                }
                                let delivered = parse_jsonrpc_message(&event.data)
                                    .and_then(|message| transport.deliver(message));
                                if let Err(cause) = delivered {
                                    transport.emit_error(&anyhow::Error::new(
                                        MCPClientError::new(
                                            "MCP HTTP Transport Error: Failed to parse message",
                                        )
                                        .with_cause(cause),
                                    ));
                                }
                            }
                        }
                    }
                }
            });
            return Ok(());
        }

        let mut error = MCPClientError::new(format!(
            "MCP HTTP Transport Error: Unexpected content type: {content_type}"
        ));
        error.status_code = Some(status.as_u16());
        error.url = Some(self.url.clone());
        let error = anyhow::Error::new(error);
        self.emit_error(&error);
        Err(error)
    }

    fn next_reconnection_delay_ms(attempt: u32) -> u64 {
        let delay =
            INITIAL_RECONNECTION_DELAY_MS * RECONNECTION_DELAY_GROW_FACTOR.powi(attempt as i32);
        delay.min(MAX_RECONNECTION_DELAY_MS) as u64
    }

    fn schedule_inbound_sse_reconnection(&self) {
        let attempts = self.state.lock().inbound_reconnect_attempts;
        if MAX_RETRIES > 0 && attempts >= MAX_RETRIES {
            self.emit_error(&anyhow::Error::new(MCPClientError::new(format!(
                "MCP HTTP Transport Error: Maximum reconnection attempts ({MAX_RETRIES}) exceeded."
            ))));
            return;
        }
        let delay = Self::next_reconnection_delay_ms(attempts);
        self.state.lock().inbound_reconnect_attempts += 1;
        let weak = self.weak.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let Some(transport) = weak.upgrade() else {
                return;
            };
            if transport.abort_signal().is_some_and(|s| s.is_cancelled()) {
                return;
            }
            let resume = transport.state.lock().last_inbound_event_id.clone();
            transport.start_inbound_sse(resume);
        });
    }

    fn start_inbound_sse(&self, resume_token: Option<String>) {
        if self.is_modern_protocol() {
            return;
        }
        let Some(transport) = self.weak.upgrade() else {
            return;
        };
        tokio::spawn(async move { transport.open_inbound_sse(resume_token).await });
    }

    /// The optional inbound stream: best effort and resumable.
    async fn open_inbound_sse(&self, resume_token: Option<String>) {
        if self.is_modern_protocol() {
            return;
        }
        let session_for_request = self.state.lock().session_id.clone();
        let mut headers = self.common_headers(
            vec![("Accept".to_string(), "text/event-stream".to_string())],
            true,
        );
        if let Some(token) = resume_token.filter(|t| !t.is_empty()) {
            headers.push(("last-event-id".to_string(), token));
        }
        let abort = self.abort_signal();
        let signals: Vec<CancellationToken> = abort.iter().cloned().collect();

        let mut request = HTTP.get(&self.url);
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        let response = tokio::select! {
            response = request.send() => response,
            _ = any_cancelled(&signals) => return,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.emit_error(&anyhow::Error::new(FetchFailedError::new(error)));
                if !abort.as_ref().is_some_and(|s| s.is_cancelled()) {
                    self.schedule_inbound_sse_reconnection();
                }
                return;
            }
        };

        self.apply_session_id_from_response(&response);

        let status = response.status();
        if status.as_u16() == 405 {
            return;
        }
        if !status.is_success() {
            if status.as_u16() == 404
                && let Some(session) = &session_for_request
            {
                self.expire_session_id(session);
            }
            let mut error = MCPClientError::new(format!(
                "MCP HTTP Transport Error: GET SSE failed: {} {}",
                status.as_u16(),
                status_text(status)
            ));
            error.status_code = Some(status.as_u16());
            error.url = Some(self.url.clone());
            self.emit_error(&anyhow::Error::new(error));
            return;
        }

        let close = CancellationToken::new();
        {
            let mut state = self.state.lock();
            state.inbound_sse = Some(close.clone());
            state.inbound_reconnect_attempts = 0;
        }
        let mut stream = response.bytes_stream();
        let mut parser = EventSourceParser::new();
        loop {
            let chunk = tokio::select! {
                chunk = stream.next() => chunk,
                _ = close.cancelled() => return,
                _ = any_cancelled(&signals) => return,
            };
            match chunk {
                None => return,
                Some(Err(error)) => {
                    self.emit_error(&anyhow::Error::new(error));
                    if !abort.as_ref().is_some_and(|s| s.is_cancelled()) {
                        self.schedule_inbound_sse_reconnection();
                    }
                    return;
                }
                Some(Ok(bytes)) => {
                    for event in parser.feed(&bytes) {
                        if let Some(id) = event.id.as_ref().filter(|id| !id.is_empty()) {
                            self.state.lock().last_inbound_event_id = Some(id.clone());
                        }
                        if !is_message_event(event.event.as_deref()) {
                            continue;
                        }
                        let delivered = parse_jsonrpc_message(&event.data)
                            .and_then(|message| self.deliver(message));
                        if let Err(cause) = delivered {
                            self.emit_error(&anyhow::Error::new(
                                MCPClientError::new(
                                    "MCP HTTP Transport Error: Failed to parse message",
                                )
                                .with_cause(cause),
                            ));
                        }
                    }
                }
            }
        }
    }
}

#[async_trait]
impl MCPTransport for HttpMCPTransport {
    fn supports_protocol_version_discovery(&self) -> bool {
        true
    }

    fn supports_mcp_tool_parameter_headers(&self) -> bool {
        true
    }

    fn set_handlers(&self, handlers: TransportHandlers) {
        *self.handlers.lock() = Some(handlers);
    }

    fn set_protocol_version(&self, version: &str) {
        self.state.lock().protocol_version = Some(version.to_string());
        if self.abort_signal().is_none() {
            return;
        }
        if self.is_modern_protocol() {
            if let Some(inbound) = self.state.lock().inbound_sse.take() {
                inbound.cancel();
            }
            return;
        }
        if !self.has_inbound_sse() {
            self.start_inbound_sse(None);
        }
    }

    async fn start(&self) -> anyhow::Result<()> {
        {
            let mut state = self.state.lock();
            if state.abort.is_some() {
                return Err(MCPClientError::new(
                    "MCP HTTP Transport Error: Transport already started. Note: client.connect() calls start() automatically.",
                )
                .into());
            }
            state.abort = Some(CancellationToken::new());
        }
        let version = self.state.lock().protocol_version.clone();
        if version.is_some_and(|v| v != LATEST_PROTOCOL_VERSION) {
            self.start_inbound_sse(None);
        }
        Ok(())
    }

    async fn close(&self, options: MCPTransportCloseOptions) -> anyhow::Result<()> {
        let (inbound, abort, session) = {
            let state = self.state.lock();
            (
                state.inbound_sse.clone(),
                state.abort.clone(),
                state.session_id.clone(),
            )
        };
        if let Some(inbound) = inbound {
            inbound.cancel();
        }
        if let Some(abort) = &abort {
            abort.cancel();
        }

        let close_aborted = options.signal.as_ref().is_some_and(|s| s.is_cancelled());
        if !self.is_modern_protocol()
            && session.as_ref().is_some_and(|s| !s.is_empty())
            && abort.is_some()
            && !close_aborted
        {
            let headers = self.common_headers(Vec::new(), true);
            let mut request = HTTP.delete(&self.url);
            for (name, value) in &headers {
                request = request.header(name, value);
            }
            let signals: Vec<CancellationToken> = options.signal.iter().cloned().collect();
            tokio::select! {
                _ = request.send() => {}
                _ = any_cancelled(&signals) => {}
            }
        }

        if let Some(handlers) = self.handlers() {
            (handlers.on_close)();
        }
        Ok(())
    }

    async fn send(&self, message: Value, options: MCPTransportSendOptions) -> anyhow::Result<()> {
        if options.signal.as_ref().is_some_and(|s| s.is_cancelled()) {
            return Err(abort_error());
        }
        let mut request_signals: Vec<CancellationToken> = self.abort_signal().into_iter().collect();
        if let Some(signal) = &options.signal {
            request_signals.push(signal.clone());
        }
        match self.attempt(&message, &options, &request_signals).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if options.signal.as_ref().is_some_and(|s| s.is_cancelled()) {
                    return Err(error);
                }
                self.emit_error(&error);
                Err(error)
            }
        }
    }
}
