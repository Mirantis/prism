//! The legacy HTTP+SSE transport (`SseMCPTransport`): one GET stream that names
//! the endpoint to POST messages to and carries every server message.

use std::sync::{Arc, Weak};

use async_trait::async_trait;
use futures::StreamExt;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::error::{FetchFailedError, MCPClientError};
use super::event_source::{EventSourceParser, is_message_event};
use super::headers::request_headers;
use super::transport::{
    HTTP, MCPTransport, MCPTransportCloseOptions, MCPTransportSendOptions, TransportHandlers,
    abort_error, any_cancelled, parse_url, status_text,
};
use super::types::{LATEST_LEGACY_PROTOCOL_VERSION, parse_jsonrpc_message};

#[derive(Default)]
struct SseState {
    endpoint: Option<url::Url>,
    abort: Option<CancellationToken>,
    connected: bool,
    /// Closes the event stream.
    sse_connection: Option<CancellationToken>,
    protocol_version: Option<String>,
}

type StartSender = Arc<Mutex<Option<oneshot::Sender<anyhow::Result<()>>>>>;

pub struct SseMCPTransport {
    url: url::Url,
    headers: IndexMap<String, String>,
    state: Mutex<SseState>,
    handlers: Mutex<Option<TransportHandlers>>,
    weak: Weak<Self>,
}

impl SseMCPTransport {
    pub fn new(url: &str, headers: IndexMap<String, String>) -> anyhow::Result<Arc<Self>> {
        let url = parse_url(url)?;
        Ok(Arc::new_cyclic(|weak| SseMCPTransport {
            url,
            headers,
            state: Mutex::new(SseState::default()),
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

    fn common_headers(&self, base: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = self
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        pairs.extend(base);
        pairs.push((
            "mcp-protocol-version".into(),
            self.state
                .lock()
                .protocol_version
                .clone()
                .unwrap_or_else(|| LATEST_LEGACY_PROTOCOL_VERSION.to_string()),
        ));
        request_headers(pairs)
    }

    /// Settles `start` once; later outcomes are ignored.
    fn settle(sender: &StartSender, outcome: anyhow::Result<()>) {
        if let Some(tx) = sender.lock().take() {
            let _ = tx.send(outcome);
        }
    }

    /// Report an error and fail `start` with it, when `start` is still waiting.
    fn fail(&self, sender: &StartSender, error: anyhow::Error) {
        self.emit_error(&error);
        Self::settle(sender, Err(error));
    }

    async fn establish_connection(self: Arc<Self>, abort: CancellationToken, sender: StartSender) {
        let headers = self.common_headers(vec![(
            "Accept".to_string(),
            "text/event-stream".to_string(),
        )]);
        let mut request = HTTP.get(self.url.as_str());
        for (name, value) in &headers {
            request = request.header(name, value);
        }
        let response = tokio::select! {
            response = request.send() => response,
            _ = abort.cancelled() => return,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.fail(&sender, anyhow::Error::new(FetchFailedError::new(error)));
                return;
            }
        };

        let status = response.status();
        if !status.is_success() {
            let mut message = format!(
                "MCP SSE Transport Error: {} {}",
                status.as_u16(),
                status_text(status)
            );
            if status.as_u16() == 405 {
                message.push_str(
                    ". This server does not support SSE transport. Try using `http` transport instead",
                );
            }
            self.fail(&sender, MCPClientError::new(message).into());
            return;
        }

        let connection = CancellationToken::new();
        self.state.lock().sse_connection = Some(connection.clone());

        let mut stream = response.bytes_stream();
        let mut parser = EventSourceParser::new();
        loop {
            let chunk = tokio::select! {
                chunk = stream.next() => chunk,
                _ = connection.cancelled() => return,
                _ = abort.cancelled() => return,
            };
            let bytes = match chunk {
                None => {
                    if abort.is_cancelled() {
                        return;
                    }
                    let was_connected = {
                        let mut state = self.state.lock();
                        let was = state.connected;
                        state.connected = false;
                        was
                    };
                    let message = if was_connected {
                        "MCP SSE Transport Error: Connection closed unexpectedly"
                    } else {
                        "MCP SSE Transport Error: Connection closed before endpoint event was received"
                    };
                    self.fail(&sender, MCPClientError::new(message).into());
                    return;
                }
                Some(Err(error)) => {
                    self.fail(&sender, anyhow::Error::new(error));
                    return;
                }
                Some(Ok(bytes)) => bytes,
            };

            for event in parser.feed(&bytes) {
                if event.event.as_deref() == Some("endpoint") {
                    if self.state.lock().endpoint.is_some() {
                        continue;
                    }
                    let endpoint = match self.url.join(&event.data) {
                        Ok(endpoint) => endpoint,
                        Err(_) => {
                            self.fail(&sender, anyhow::anyhow!("Invalid URL"));
                            return;
                        }
                    };
                    let origin = endpoint.origin().ascii_serialization();
                    if origin != self.url.origin().ascii_serialization() {
                        let connection = {
                            let mut state = self.state.lock();
                            state.connected = false;
                            state.endpoint = None;
                            state.sse_connection.clone()
                        };
                        if let Some(connection) = connection {
                            connection.cancel();
                        }
                        abort.cancel();
                        self.fail(
                            &sender,
                            MCPClientError::new(format!(
                                "MCP SSE Transport Error: Endpoint origin does not match connection origin: {origin}"
                            ))
                            .into(),
                        );
                        return;
                    }
                    {
                        let mut state = self.state.lock();
                        state.endpoint = Some(endpoint);
                        state.connected = true;
                    }
                    Self::settle(&sender, Ok(()));
                } else if is_message_event(event.event.as_deref()) {
                    let delivered =
                        parse_jsonrpc_message(&event.data).and_then(|message| {
                            match self.handlers() {
                                Some(handlers) => (handlers.on_message)(message),
                                None => Ok(()),
                            }
                        });
                    if let Err(cause) = delivered {
                        self.emit_error(&anyhow::Error::new(
                            MCPClientError::new("MCP SSE Transport Error: Failed to parse message")
                                .with_cause(cause),
                        ));
                    }
                }
            }
        }
    }
}

#[async_trait]
impl MCPTransport for SseMCPTransport {
    fn set_handlers(&self, handlers: TransportHandlers) {
        *self.handlers.lock() = Some(handlers);
    }

    fn set_protocol_version(&self, version: &str) {
        self.state.lock().protocol_version = Some(version.to_string());
    }

    async fn start(&self) -> anyhow::Result<()> {
        let abort = {
            let mut state = self.state.lock();
            if state.connected {
                return Ok(());
            }
            let abort = CancellationToken::new();
            state.abort = Some(abort.clone());
            abort
        };
        let Some(transport) = self.weak.upgrade() else {
            return Ok(());
        };
        let (tx, rx) = oneshot::channel();
        let sender: StartSender = Arc::new(Mutex::new(Some(tx)));
        tokio::spawn(transport.establish_connection(abort, sender));
        match rx.await {
            Ok(outcome) => outcome,
            // Aborted before the stream settled: the start never settles.
            Err(_) => std::future::pending().await,
        }
    }

    async fn close(&self, _options: MCPTransportCloseOptions) -> anyhow::Result<()> {
        let (connection, abort) = {
            let mut state = self.state.lock();
            state.connected = false;
            state.endpoint = None;
            (state.sse_connection.clone(), state.abort.clone())
        };
        if let Some(connection) = connection {
            connection.cancel();
        }
        if let Some(abort) = abort {
            abort.cancel();
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
        let (endpoint, abort) = {
            let state = self.state.lock();
            (
                state.endpoint.clone().filter(|_| state.connected),
                state.abort.clone(),
            )
        };
        let Some(endpoint) = endpoint else {
            return Err(MCPClientError::new("MCP SSE Transport Error: Not connected").into());
        };
        let mut signals: Vec<CancellationToken> = abort.into_iter().collect();
        if let Some(signal) = &options.signal {
            signals.push(signal.clone());
        }

        let attempt = async {
            let headers = self.common_headers(vec![(
                "Content-Type".to_string(),
                "application/json".to_string(),
            )]);
            let mut request = HTTP.post(endpoint.as_str());
            for (name, value) in &headers {
                request = request.header(name, value);
            }
            let request = request.body(crate::ai::json::js_stringify(&message));
            let response = tokio::select! {
                response = request.send() => response.map_err(|e| anyhow::Error::new(FetchFailedError::new(e)))?,
                _ = any_cancelled(&signals) => return Err(abort_error()),
            };
            let status = response.status();
            if !status.is_success() {
                let text: Option<String> = tokio::select! {
                    text = response.text() => text.ok(),
                    _ = any_cancelled(&signals) => None,
                };
                let shown = text.clone().unwrap_or_else(|| "null".to_string());
                return Err(anyhow::Error::new(
                    MCPClientError::new(format!(
                        "MCP SSE Transport Error: POSTing to endpoint (HTTP {}): {shown}",
                        status.as_u16()
                    ))
                    .with_http(status.as_u16(), endpoint.as_str(), text),
                ));
            }
            Ok(())
        };
        match attempt.await {
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
