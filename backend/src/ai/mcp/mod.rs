//! MCP clients (`@ai-sdk/mcp`): stdio over a caller's transport, Streamable HTTP
//! and legacy SSE, and the server's tools as AI SDK tools.
//!
//! One client talks to one server. `create_mcp_client` starts the transport and
//! initializes the session; `tools()` lists every page of the server's tools and
//! wraps each one so `execute` calls it on the server under the name the server
//! gave it, and `to_model_output` turns its result into tool-result content.
//!
//! Not supported, as in the SDK: in-band notifications from the server (each one
//! is reported to `on_uncaught_error`), resumable streams, and the elicitation,
//! resource and prompt APIs, which the runtime does not use.

mod error;
mod event_source;
mod headers;
mod http_transport;
mod sse_transport;
mod transport;
mod types;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub use error::{FetchFailedError, MCPClientError, SharedCauseError, ensure_log_fields_registered};
pub use event_source::{EventSourceMessage, EventSourceParser};
pub use headers::{MCPToolHeaderBinding, encode_mcp_header_value};
pub use http_transport::HttpMCPTransport;
pub use sse_transport::SseMCPTransport;
pub use transport::{
    MCPTransport, MCPTransportCloseOptions, MCPTransportConfig, MCPTransportSendOptions, OnClose,
    OnError, OnMessage, TransportHandlers, create_mcp_transport,
};
pub use types::{
    LATEST_LEGACY_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION, ListToolsResult, McpToolDefinition,
    SUPPORTED_PROTOCOL_VERSIONS, json_parse, parse_call_tool_result, validate_jsonrpc_message,
};

use self::headers::{create_mcp_tool_headers, get_mcp_tool_header_bindings};
use self::transport::abort_error;
use self::types::{
    JsonObject, SchemaError, parse_discover_result, parse_initialize_result,
    parse_list_tools_result,
};
use crate::ai::fetch_timeouts::READ_TIMEOUT;
use crate::ai::json::js_stringify;
use crate::ai::{
    DataContent, FileData, Tool, ToolResultContentPart, ToolResultOutput, ToolSet, dynamic_tool,
    execute_fn, json_schema, to_model_output_fn,
};

const CLIENT_VERSION: &str = "1.0.0";
const DEFAULT_CLIENT_NAME: &str = "ai-sdk-mcp-client";
const DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT_MS: u64 = 1000;
/// The deadline of a request that sets none: undici's read timeout, so a server that
/// accepts a request and never answers it gives the turn back. A tool call that runs
/// longer, even with progress on its stream, is cut there; the turn going on is the
/// trade.
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = READ_TIMEOUT.as_millis() as u64;
const MODERN_PROTOCOL_ERROR_CODES: [i64; 3] = [-32020, -32021, -32022];

/// MIME type of an HTML resource rendered as an MCP App.
pub const MCP_APP_MIME_TYPE: &str = "text/html;profile=mcp-app";
/// The flat `_meta` key older MCP Apps servers name their resource under.
const MCP_APP_LEGACY_RESOURCE_URI_META_KEY: &str = "ui/resourceUri";

/// `RequestOptions`: what bounds or cancels one request.
#[derive(Clone, Default)]
pub struct RequestOptions {
    pub signal: Option<CancellationToken>,
    /// Milliseconds.
    pub timeout: Option<u64>,
    /// Milliseconds.
    pub max_total_timeout: Option<u64>,
}

fn effective_timeout(options: &RequestOptions) -> Option<u64> {
    match (options.timeout, options.max_total_timeout) {
        (None, max) => max,
        (timeout, None) => timeout,
        (Some(timeout), Some(max)) => Some(timeout.min(max)),
    }
}

/// Called with an error no caller awaits: a transport failure in the background,
/// a server notification, a protocol error.
pub type UncaughtErrorHandler = Arc<dyn Fn(&anyhow::Error) + Send + Sync>;

/// `MCPClientConfig`.
#[derive(Clone)]
pub struct MCPClientConfig {
    pub transport: MCPTransportConfig,
    /// Whether a transport that supports it probes with `server/discover` before
    /// the legacy `initialize`. On by default.
    pub protocol_version_discovery: bool,
    /// Bounds or cancels starting the transport and the `initialize` request.
    pub initialization_options: Option<RequestOptions>,
    pub on_uncaught_error: Option<UncaughtErrorHandler>,
    /// `ai-sdk-mcp-client` when unset.
    pub client_name: Option<String>,
    /// `1.0.0` when unset.
    pub version: Option<String>,
    /// The client capabilities advertised at initialization; `{}` when unset.
    pub capabilities: Option<Value>,
}

impl MCPClientConfig {
    pub fn new(transport: MCPTransportConfig) -> Self {
        Self {
            transport,
            protocol_version_discovery: true,
            initialization_options: None,
            on_uncaught_error: None,
            client_name: None,
            version: None,
            capabilities: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolEra {
    Legacy,
    Modern,
}

type ResponseSender = oneshot::Sender<anyhow::Result<Value>>;

struct ClientState {
    request_message_id: i64,
    response_handlers: HashMap<i64, ResponseSender>,
    server_capabilities: Value,
    server_info: Value,
    initialize_result: Value,
    instructions: Option<String>,
    protocol_era: ProtocolEra,
    protocol_version: String,
    tool_header_bindings: HashMap<String, Vec<MCPToolHeaderBinding>>,
    is_closed: bool,
}

struct ClientInner {
    transport: Arc<dyn MCPTransport>,
    protocol_version_discovery: bool,
    on_uncaught_error: Option<UncaughtErrorHandler>,
    client_info: Value,
    client_capabilities: Value,
    initialization_options: Option<RequestOptions>,
    state: Mutex<ClientState>,
}

/// `MCPClient`: one connection to one MCP server. Cloning shares the connection.
#[derive(Clone)]
pub struct MCPClient {
    inner: Arc<ClientInner>,
}

impl std::fmt::Debug for MCPClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MCPClient")
            .field("client_info", &self.inner.client_info)
            .finish()
    }
}

/// `createMCPClient`: a client whose session is initialized.
pub async fn create_mcp_client(config: MCPClientConfig) -> anyhow::Result<MCPClient> {
    ensure_log_fields_registered();
    let transport = create_mcp_transport(config.transport)?;
    let client_name = config
        .client_name
        .unwrap_or_else(|| DEFAULT_CLIENT_NAME.to_string());
    let version = config.version.unwrap_or_else(|| CLIENT_VERSION.to_string());
    let server_info = json!({ "name": "", "version": "" });
    let inner = Arc::new(ClientInner {
        transport: transport.clone(),
        protocol_version_discovery: config.protocol_version_discovery,
        on_uncaught_error: config.on_uncaught_error,
        client_info: json!({ "name": client_name, "version": version }),
        client_capabilities: config.capabilities.unwrap_or_else(|| json!({})),
        initialization_options: config.initialization_options,
        state: Mutex::new(ClientState {
            request_message_id: 0,
            response_handlers: HashMap::new(),
            server_capabilities: json!({}),
            server_info: server_info.clone(),
            initialize_result: json!({
                "protocolVersion": LATEST_LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "serverInfo": server_info,
            }),
            instructions: None,
            protocol_era: ProtocolEra::Legacy,
            protocol_version: LATEST_LEGACY_PROTOCOL_VERSION.to_string(),
            tool_header_bindings: HashMap::new(),
            is_closed: true,
        }),
    });

    let weak: Weak<ClientInner> = Arc::downgrade(&inner);
    transport.set_handlers(TransportHandlers {
        on_message: Arc::new({
            let weak = weak.clone();
            move |message| match weak.upgrade() {
                Some(inner) => inner.handle_message(message),
                None => Ok(()),
            }
        }),
        on_error: Arc::new({
            let weak = weak.clone();
            move |error| {
                if let Some(inner) = weak.upgrade() {
                    inner.on_error(error);
                }
            }
        }),
        on_close: Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.on_close();
            }
        }),
    });

    inner.init().await?;
    Ok(MCPClient { inner })
}

/// `waitForAbort`: the future's outcome, or the abort when the signal fires first.
async fn wait_for_abort<T>(
    future: impl Future<Output = anyhow::Result<T>>,
    signal: Option<&CancellationToken>,
) -> anyhow::Result<T> {
    let Some(signal) = signal else {
        return future.await;
    };
    if signal.is_cancelled() {
        return Err(abort_error());
    }
    tokio::select! {
        outcome = future => outcome,
        _ = signal.cancelled() => Err(abort_error()),
    }
}

/// `Number(id)` for a response id, when it is an integer.
fn response_id(id: &Value) -> Option<i64> {
    let number = match id {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => crate::support::js::number_from(s),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }?;
    (number.fract() == 0.0 && number.is_finite()).then_some(number as i64)
}

/// `String(value)` for the text of a `TypeError` about a non-object.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        other => js_stringify(other),
    }
}

/// Removes a request's response handler when the request ends, however it ends.
struct HandlerGuard {
    inner: Arc<ClientInner>,
    id: i64,
}

impl Drop for HandlerGuard {
    fn drop(&mut self) {
        self.inner.state.lock().response_handlers.remove(&self.id);
    }
}

impl ClientInner {
    async fn init(self: &Arc<Self>) -> anyhow::Result<()> {
        let external = self
            .initialization_options
            .as_ref()
            .and_then(|o| o.signal.clone());
        let timeout = self
            .initialization_options
            .as_ref()
            .and_then(effective_timeout);
        let signal = match (&external, timeout) {
            (None, None) => None,
            (Some(external), None) => Some(external.clone()),
            (Some(external), Some(_)) => Some(external.child_token()),
            (None, Some(_)) => Some(CancellationToken::new()),
        };
        let timed_out = Arc::new(AtomicBool::new(false));
        let timer = match (timeout, &signal) {
            (Some(ms), Some(signal)) => {
                let signal = signal.clone();
                let timed_out = timed_out.clone();
                Some(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    timed_out.store(true, Ordering::SeqCst);
                    signal.cancel();
                }))
            }
            _ => None,
        };

        let outcome = self.initialize(signal.as_ref()).await;
        if let Some(timer) = timer {
            timer.abort();
        }
        let Err(error) = outcome else {
            return Ok(());
        };

        let transport = self.transport.clone();
        let close_signal = signal.clone();
        let closing = tokio::spawn(async move {
            let _ = transport
                .close(MCPTransportCloseOptions {
                    signal: close_signal,
                })
                .await;
        });
        let _ = wait_for_abort(
            async {
                let _ = closing.await;
                Ok(())
            },
            signal.as_ref(),
        )
        .await;
        self.on_close();

        if timed_out.load(Ordering::SeqCst) {
            return Err(MCPClientError::new(format!(
                "MCP client initialization timed out after {}ms",
                timeout.unwrap_or_default()
            ))
            .into());
        }
        if external.as_ref().is_some_and(|s| s.is_cancelled()) {
            return Err(MCPClientError::new("MCP client initialization was aborted")
                .with_cause(abort_error())
                .into());
        }
        Err(error)
    }

    async fn initialize(
        self: &Arc<Self>,
        signal: Option<&CancellationToken>,
    ) -> anyhow::Result<()> {
        self.state.lock().is_closed = false;
        if signal.is_some_and(|s| s.is_cancelled()) {
            return Err(abort_error());
        }
        wait_for_abort(self.transport.start(), signal).await?;

        if self.protocol_version_discovery
            && self.transport.supports_protocol_version_discovery()
            && self.try_protocol_discovery(signal).await?
        {
            return Ok(());
        }

        {
            let mut state = self.state.lock();
            state.protocol_era = ProtocolEra::Legacy;
            state.protocol_version = LATEST_LEGACY_PROTOCOL_VERSION.to_string();
        }
        self.transport
            .set_protocol_version(LATEST_LEGACY_PROTOCOL_VERSION);

        let result = self
            .request(
                "initialize",
                Some(json!({
                    "protocolVersion": LATEST_LEGACY_PROTOCOL_VERSION,
                    "capabilities": self.client_capabilities,
                    "clientInfo": self.client_info,
                })),
                RequestOptions {
                    signal: signal.cloned(),
                    ..RequestOptions::default()
                },
                parse_initialize_result,
            )
            .await?;
        self.apply_initialize_result(result)?;

        // Complete the initialization handshake.
        self.notification("notifications/initialized", signal).await
    }

    async fn try_protocol_discovery(
        self: &Arc<Self>,
        signal: Option<&CancellationToken>,
    ) -> anyhow::Result<bool> {
        {
            let mut state = self.state.lock();
            state.protocol_era = ProtocolEra::Modern;
            state.protocol_version = LATEST_PROTOCOL_VERSION.to_string();
        }
        self.transport.set_protocol_version(LATEST_PROTOCOL_VERSION);

        let outcome = self
            .request(
                "server/discover",
                None,
                RequestOptions {
                    signal: signal.cloned(),
                    timeout: Some(DEFAULT_PROTOCOL_DISCOVERY_TIMEOUT_MS),
                    max_total_timeout: None,
                },
                parse_discover_result,
            )
            .await
            .and_then(|result| self.apply_discover_result(result));
        match outcome {
            Ok(()) => Ok(true),
            Err(error) => {
                let modern_code = error
                    .downcast_ref::<MCPClientError>()
                    .and_then(|e| e.code)
                    .is_some_and(|code| MODERN_PROTOCOL_ERROR_CODES.contains(&code));
                if modern_code { Err(error) } else { Ok(false) }
            }
        }
    }

    fn apply_discover_result(&self, result: Value) -> anyhow::Result<()> {
        let mut state = self.state.lock();
        let supported = result["supportedVersions"]
            .as_array()
            .is_some_and(|versions| {
                versions
                    .iter()
                    .any(|v| v.as_str() == Some(state.protocol_version.as_str()))
            });
        if !supported {
            return Err(MCPClientError::new(format!(
                "Server does not support the requested protocol version: {}",
                state.protocol_version
            ))
            .into());
        }
        let server_info = result
            .get("_meta")
            .and_then(|meta| meta.get("io.modelcontextprotocol/serverInfo"));
        if let Some(info) = server_info.filter(|info| {
            info.get("name").is_some_and(Value::is_string)
                && info.get("version").is_some_and(Value::is_string)
        }) {
            state.server_info = info.clone();
        }
        state.server_capabilities = result["capabilities"].clone();
        state.instructions = result
            .get("instructions")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut initialize_result = json!({
            "protocolVersion": state.protocol_version,
            "capabilities": result["capabilities"],
            "serverInfo": state.server_info,
        });
        if let Some(instructions) = &state.instructions {
            initialize_result["instructions"] = json!(instructions);
        }
        state.initialize_result = initialize_result;
        Ok(())
    }

    fn apply_initialize_result(&self, result: Value) -> anyhow::Result<()> {
        let version = result["protocolVersion"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if !SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str()) {
            return Err(MCPClientError::new(format!(
                "Server's protocol version is not supported: {version}"
            ))
            .into());
        }
        {
            let mut state = self.state.lock();
            state.server_capabilities = result["capabilities"].clone();
            state.protocol_era = ProtocolEra::Legacy;
            state.protocol_version = version.clone();
            state.server_info = result["serverInfo"].clone();
            state.instructions = result
                .get("instructions")
                .and_then(Value::as_str)
                .map(str::to_string);
            state.initialize_result = result;
        }
        self.transport.set_protocol_version(&version);
        Ok(())
    }

    fn assert_capability(&self, method: &str) -> anyhow::Result<()> {
        let capabilities = self.state.lock().server_capabilities.clone();
        let has = |name: &str| {
            capabilities
                .get(name)
                .is_some_and(crate::support::js::truthy)
        };
        let missing = match method {
            "initialize" | "server/discover" => None,
            "completion/complete" => {
                (!has("completions")).then_some("Server does not support completions")
            }
            "events/list" | "events/subscribe" | "events/unsubscribe" => {
                (!has("events")).then_some("Server does not support events")
            }
            "tools/list" | "tools/call" => {
                (!has("tools")).then_some("Server does not support tools")
            }
            "resources/list" | "resources/read" | "resources/templates/list" => {
                (!has("resources")).then_some("Server does not support resources")
            }
            "prompts/list" | "prompts/get" => {
                (!has("prompts")).then_some("Server does not support prompts")
            }
            _ => {
                return Err(MCPClientError::new(format!("Unsupported method: {method}")).into());
            }
        };
        match missing {
            Some(message) => Err(MCPClientError::new(message).into()),
            None => Ok(()),
        }
    }

    /// The request as sent: on the stateless protocol, `params._meta` names the
    /// protocol version, the client's capabilities and the client.
    fn prepare_request(&self, method: &str, params: Option<Value>) -> JsonObject {
        let state = self.state.lock();
        let mut request = JsonObject::new();
        request.insert("method".into(), json!(method));
        if state.protocol_era != ProtocolEra::Modern {
            if let Some(params) = params {
                request.insert("params".into(), params);
            }
            return request;
        }
        let mut prepared = match params {
            Some(Value::Object(params)) => params,
            _ => JsonObject::new(),
        };
        let mut meta = match prepared.get("_meta") {
            Some(Value::Object(meta)) => meta.clone(),
            _ => JsonObject::new(),
        };
        meta.insert(
            "io.modelcontextprotocol/protocolVersion".into(),
            json!(state.protocol_version),
        );
        meta.insert(
            "io.modelcontextprotocol/clientCapabilities".into(),
            self.client_capabilities.clone(),
        );
        meta.insert(
            "io.modelcontextprotocol/clientInfo".into(),
            self.client_info.clone(),
        );
        prepared.insert("_meta".into(), Value::Object(meta));
        request.insert("params".into(), Value::Object(prepared));
        request
    }

    fn tool_request_headers(
        &self,
        request: &JsonObject,
    ) -> anyhow::Result<Option<Vec<(String, String)>>> {
        let state = self.state.lock();
        if state.protocol_era != ProtocolEra::Modern
            || request.get("method").and_then(Value::as_str) != Some("tools/call")
        {
            return Ok(None);
        }
        let Some(name) = request
            .get("params")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
        else {
            return Ok(None);
        };
        let Some(bindings) = state
            .tool_header_bindings
            .get(name)
            .filter(|b| !b.is_empty())
        else {
            return Ok(None);
        };
        let Some(args) = request
            .get("params")
            .and_then(|p| p.get("arguments"))
            .and_then(Value::as_object)
        else {
            return Ok(None);
        };
        create_mcp_tool_headers(bindings, args)
            .map(Some)
            .map_err(|cause| {
                MCPClientError::new(format!("Failed to create MCP headers for tool \"{name}\""))
                    .with_cause(cause)
                    .into()
            })
    }

    async fn request<T>(
        self: &Arc<Self>,
        method: &str,
        params: Option<Value>,
        options: RequestOptions,
        parse: impl FnOnce(&Value) -> Result<T, SchemaError>,
    ) -> anyhow::Result<T> {
        if self.state.lock().is_closed {
            return Err(
                MCPClientError::new("Attempted to send a request from a closed client").into(),
            );
        }
        self.assert_capability(method)?;

        let signal = options.signal.clone();
        if signal.as_ref().is_some_and(|s| s.is_cancelled()) {
            return Err(abort_error());
        }
        let timeout = effective_timeout(&options).unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS);
        let transport_signal = match &signal {
            Some(signal) => signal.child_token(),
            None => CancellationToken::new(),
        };

        let message_id = {
            let mut state = self.state.lock();
            let id = state.request_message_id;
            state.request_message_id += 1;
            id
        };
        let prepared = self.prepare_request(method, params);
        let headers = self.tool_request_headers(&prepared)?;
        let mut message = prepared;
        message.insert("jsonrpc".into(), json!("2.0"));
        message.insert("id".into(), json!(message_id));

        let (tx, mut rx) = oneshot::channel();
        self.state.lock().response_handlers.insert(message_id, tx);
        let _guard = HandlerGuard {
            inner: self.clone(),
            id: message_id,
        };

        let send = self.transport.send(
            Value::Object(message),
            MCPTransportSendOptions {
                signal: Some(transport_signal.clone()),
                headers,
            },
        );
        tokio::pin!(send);
        let expiry = tokio::time::sleep(Duration::from_millis(timeout));
        tokio::pin!(expiry);
        let aborted = async {
            match &signal {
                Some(signal) => signal.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(aborted);

        let mut send_done = false;
        let outcome = loop {
            tokio::select! {
                biased;
                outcome = &mut rx => break outcome,
                sent = &mut send, if !send_done => {
                    send_done = true;
                    sent?;
                }
                _ = &mut aborted => {
                    return Err(MCPClientError::new("Request was aborted").with_cause(abort_error()).into());
                }
                _ = &mut expiry => {
                    transport_signal.cancel();
                    return Err(MCPClientError::new(format!(
                        "Request timed out after {timeout}ms"
                    ))
                    .into());
                }
            }
        };

        if signal.as_ref().is_some_and(|s| s.is_cancelled()) {
            return Err(MCPClientError::new("Request was aborted")
                .with_cause(abort_error())
                .into());
        }
        let response = match outcome {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(MCPClientError::new("Connection closed").into()),
        };

        let result = response.get("result").cloned().unwrap_or(Value::Null);
        let modern = self.state.lock().protocol_era == ProtocolEra::Modern;
        let result_type = result.get("resultType").filter(|v| !v.is_null());
        if modern && result_type.is_none() {
            return Err(MCPClientError::new("Modern MCP result is missing resultType").into());
        }
        if result_type.and_then(Value::as_str) == Some("input_required") {
            return Err(MCPClientError::new(
                "Server requested additional input, but multi round-trip requests are not supported yet",
            )
            .into());
        }
        parse(&result).map_err(|cause| {
            MCPClientError::new("Failed to parse server response")
                .with_cause(anyhow::Error::new(cause))
                .into()
        })
    }

    async fn notification(
        self: &Arc<Self>,
        method: &str,
        signal: Option<&CancellationToken>,
    ) -> anyhow::Result<()> {
        let message = json!({ "method": method, "jsonrpc": "2.0" });
        wait_for_abort(
            self.transport.send(
                message,
                MCPTransportSendOptions {
                    signal: signal.cloned(),
                    headers: None,
                },
            ),
            signal,
        )
        .await
    }

    async fn list_tools(
        self: &Arc<Self>,
        cursor: Option<String>,
        options: RequestOptions,
    ) -> anyhow::Result<ListToolsResult> {
        let first_page = cursor.is_none();
        let params = cursor.map(|cursor| json!({ "cursor": cursor }));
        let result = self
            .request("tools/list", params, options, parse_list_tools_result)
            .await?;
        Ok(self.prepare_tool_definitions(result, first_page))
    }

    /// On the stateless protocol over a transport that sends tool parameters as
    /// headers, records each tool's `x-mcp-header` bindings and drops a tool whose
    /// bindings are invalid, reporting it.
    fn prepare_tool_definitions(
        &self,
        definitions: ListToolsResult,
        reset_header_bindings: bool,
    ) -> ListToolsResult {
        let modern = self.state.lock().protocol_era == ProtocolEra::Modern;
        if !modern || !self.transport.supports_mcp_tool_parameter_headers() {
            return definitions;
        }
        if reset_header_bindings {
            self.state.lock().tool_header_bindings.clear();
        }
        let mut tools = Vec::new();
        for definition in definitions.tools {
            match get_mcp_tool_header_bindings(&definition.input_schema) {
                Ok(bindings) => {
                    self.state
                        .lock()
                        .tool_header_bindings
                        .insert(definition.name.clone(), bindings);
                    tools.push(definition);
                }
                Err(error) => self.on_error(
                    &MCPClientError::new(format!(
                        "Ignoring MCP tool \"{}\": {error}",
                        definition.name
                    ))
                    .into(),
                ),
            }
        }
        ListToolsResult {
            tools,
            next_cursor: definitions.next_cursor,
        }
    }

    async fn call_tool(
        self: &Arc<Self>,
        name: &str,
        arguments: Value,
        options: RequestOptions,
    ) -> anyhow::Result<Value> {
        self.request(
            "tools/call",
            Some(json!({ "name": name, "arguments": arguments })),
            options,
            types::parse_call_tool_result,
        )
        .await
    }

    fn handle_message(self: &Arc<Self>, message: Value) -> anyhow::Result<()> {
        if !matches!(message, Value::Object(_) | Value::Array(_)) {
            anyhow::bail!(
                "Cannot use 'in' operator to search for 'method' in {}",
                js_string(&message)
            );
        }
        if message.get("method").is_some() {
            if message.get("id").is_some() {
                self.on_request_message(message);
            } else {
                self.on_error(&MCPClientError::new("Unsupported message type").into());
            }
            return Ok(());
        }
        self.on_response(message)
    }

    /// A request from the server: `ping` is answered, anything else refused.
    fn on_request_message(self: &Arc<Self>, request: Value) {
        let inner = self.clone();
        tokio::spawn(async move {
            let id = request["id"].clone();
            let method = js_string(&request["method"]);
            let reply = if method == "ping" {
                json!({ "jsonrpc": "2.0", "id": id, "result": {} })
            } else if method != "elicitation/create" {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("Unsupported request method: {method}") },
                })
            } else {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "No elicitation handler registered on client" },
                })
            };
            if let Err(error) = inner
                .transport
                .send(reply, MCPTransportSendOptions::default())
                .await
            {
                inner.on_error(&error);
            }
        });
    }

    fn on_close(&self) {
        let handlers = {
            let mut state = self.state.lock();
            if state.is_closed {
                return;
            }
            state.is_closed = true;
            std::mem::take(&mut state.response_handlers)
        };
        for (_, handler) in handlers {
            let _ = handler.send(Err(MCPClientError::new("Connection closed").into()));
        }
    }

    fn on_error(&self, error: &anyhow::Error) {
        if let Some(handler) = &self.on_uncaught_error {
            handler(error);
        }
    }

    fn on_response(&self, response: Value) -> anyhow::Result<()> {
        let Some(id) = response.get("id").filter(|id| !id.is_null()) else {
            self.on_error(
                &MCPClientError::new(format!(
                    "Protocol error: Received a response without a message ID: {}",
                    js_stringify(&response)
                ))
                .into(),
            );
            return Ok(());
        };
        let handler =
            response_id(id).and_then(|id| self.state.lock().response_handlers.remove(&id));
        let Some(handler) = handler else {
            return Err(MCPClientError::new(format!(
                "Protocol error: Received a response for an unknown message ID: {}",
                js_stringify(&response)
            ))
            .into());
        };

        if response.get("result").is_some() {
            let _ = handler.send(Ok(response));
            return Ok(());
        }
        let Some(error) = response.get("error").filter(|e| e.is_object()) else {
            anyhow::bail!("Cannot read properties of undefined (reading 'message')");
        };
        let message = js_string(error.get("message").unwrap_or(&Value::Null));
        let mut failure =
            MCPClientError::new(message.clone()).with_cause(anyhow::Error::msg(message));
        failure.code = error.get("code").and_then(Value::as_i64);
        failure.data = error.get("data").cloned();
        let _ = handler.send(Err(failure.into()));
        Ok(())
    }
}

/// `getMCPAppToolMeta`: the tool's `_meta.ui` with its resource URI, or `None`
/// when it has neither. A resource URI that is not a `ui://` string fails.
fn get_mcp_app_tool_meta(meta: Option<&JsonObject>) -> anyhow::Result<Option<JsonObject>> {
    let ui_meta = meta.and_then(|m| m.get("ui")).and_then(Value::as_object);
    let resource_uri = ui_meta
        .and_then(|ui| ui.get("resourceUri"))
        .filter(|v| !v.is_null())
        .or_else(|| meta.and_then(|m| m.get(MCP_APP_LEGACY_RESOURCE_URI_META_KEY)));
    let visibility = ui_meta.and_then(|ui| ui.get("visibility")).and_then(|v| {
        v.as_array().map(|items| {
            Value::Array(
                items
                    .iter()
                    .filter(|item| matches!(item.as_str(), Some("model") | Some("app")))
                    .cloned()
                    .collect(),
            )
        })
    });

    match resource_uri {
        Some(uri) => {
            if !uri.as_str().is_some_and(|u| u.starts_with("ui://")) {
                anyhow::bail!("Invalid MCP App resource URI: {}", js_stringify(uri));
            }
        }
        None if ui_meta.is_none() => return Ok(None),
        None => {}
    }

    let mut app = ui_meta.cloned().unwrap_or_default();
    if let Some(uri) = resource_uri.filter(|v| !v.is_null()) {
        app.insert("resourceUri".into(), uri.clone());
    }
    if let Some(visibility) = visibility {
        app.insert("visibility".into(), visibility);
    }
    Ok(Some(app))
}

/// `mcpToModelOutput`: a result's content parts as tool-result content (text as
/// text, an image as a file, any other part as its JSON), or the whole result as
/// JSON when it has no `content` array.
pub fn mcp_to_model_output(output: &Value) -> ToolResultOutput {
    let Some(Value::Array(parts)) = output.get("content") else {
        return ToolResultOutput::json(output.clone());
    };
    let value = parts
        .iter()
        .map(|part| {
            let kind = part.get("type").and_then(Value::as_str);
            if kind == Some("text")
                && let Some(text) = part.get("text")
            {
                return ToolResultContentPart::Text {
                    text: js_string(text),
                    provider_options: None,
                };
            }
            if kind == Some("image")
                && let (Some(data), Some(media_type)) = (part.get("data"), part.get("mimeType"))
            {
                return ToolResultContentPart::File {
                    filename: None,
                    data: FileData::Data {
                        data: DataContent::Base64(js_string(data)),
                    },
                    media_type: js_string(media_type),
                    provider_options: None,
                };
            }
            ToolResultContentPart::Text {
                text: js_stringify(part),
                provider_options: None,
            }
        })
        .collect();
    ToolResultOutput::Content { value }
}

impl MCPClient {
    /// `client.tools()`: every tool the server lists, across every page, as AI
    /// SDK tools.
    pub async fn tools(&self) -> anyhow::Result<ToolSet> {
        let mut definitions = self
            .inner
            .list_tools(None, RequestOptions::default())
            .await?;
        let mut tools = definitions.tools.clone();
        while let Some(cursor) = definitions.next_cursor.clone() {
            definitions = self
                .inner
                .list_tools(Some(cursor), RequestOptions::default())
                .await?;
            tools.extend(definitions.tools.clone());
        }
        self.tools_from_definitions(ListToolsResult {
            tools,
            next_cursor: definitions.next_cursor,
        })
    }

    /// `client.listTools()`: one page of the server's tools.
    pub async fn list_tools(
        &self,
        cursor: Option<String>,
        options: RequestOptions,
    ) -> anyhow::Result<ListToolsResult> {
        self.inner.list_tools(cursor, options).await
    }

    /// `client.callTool()`: the server's result, checked as a tool result.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        options: RequestOptions,
    ) -> anyhow::Result<Value> {
        self.inner.call_tool(name, arguments, options).await
    }

    /// `client.toolsFromDefinitions()`: AI SDK tools for listed definitions.
    ///
    /// Each is a dynamic tool whose input schema is the server's, with
    /// `properties` defaulted to `{}` and `additionalProperties: false`. Its
    /// `execute` calls the server's tool under the server's name and returns the
    /// result, an error result included; its `to_model_output` is
    /// `mcp_to_model_output`.
    pub fn tools_from_definitions(&self, definitions: ListToolsResult) -> anyhow::Result<ToolSet> {
        let definitions = self.inner.prepare_tool_definitions(definitions, false);
        let client_name = self.inner.client_info["name"].clone();
        let mut tools = ToolSet::new();
        for definition in definitions.tools {
            let annotations = definition.annotations.as_ref();
            let resolved_title = definition.title.clone().or_else(|| {
                annotations
                    .and_then(|a| a.get("title"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let app_meta = get_mcp_app_tool_meta(definition.meta.as_ref())?;

            let mut metadata = JsonObject::new();
            metadata.insert("clientName".into(), client_name.clone());
            metadata.insert("toolName".into(), json!(definition.name));
            if let Some(title) = &resolved_title {
                metadata.insert("title".into(), json!(title));
            }
            if let Some(annotations) = annotations {
                let mut kept = JsonObject::new();
                for key in [
                    "title",
                    "readOnlyHint",
                    "destructiveHint",
                    "idempotentHint",
                    "openWorldHint",
                ] {
                    if let Some(value) = annotations.get(key).filter(|v| !v.is_null()) {
                        kept.insert(key.into(), value.clone());
                    }
                }
                metadata.insert("annotations".into(), Value::Object(kept));
            }
            if let Some(mut app) =
                app_meta.filter(|app| app.get("resourceUri").is_some_and(|v| !v.is_null()))
            {
                app.insert("mimeType".into(), json!(MCP_APP_MIME_TYPE));
                metadata.insert("app".into(), Value::Object(app));
            }

            let mut input_schema = definition.input_schema.clone();
            let properties = input_schema
                .get("properties")
                .filter(|p| !p.is_null())
                .cloned()
                .unwrap_or_else(|| json!({}));
            input_schema.insert("properties".into(), properties);
            input_schema.insert("additionalProperties".into(), json!(false));

            let inner = self.inner.clone();
            let server_name = definition.name.clone();
            let execute = execute_fn(move |args, options| {
                let inner = inner.clone();
                let server_name = server_name.clone();
                async move {
                    if options
                        .abort_signal
                        .as_ref()
                        .is_some_and(|s| s.is_cancelled())
                    {
                        return Err(abort_error());
                    }
                    inner
                        .call_tool(
                            &server_name,
                            args,
                            RequestOptions {
                                signal: options.abort_signal.clone(),
                                ..RequestOptions::default()
                            },
                        )
                        .await
                }
            });

            tools.insert(
                definition.name.clone(),
                dynamic_tool(Tool {
                    description: definition.description.clone(),
                    title: resolved_title,
                    metadata: Some(metadata),
                    input_schema: json_schema(Value::Object(input_schema)),
                    execute: Some(execute),
                    to_model_output: Some(to_model_output_fn(|options| async move {
                        Ok(mcp_to_model_output(&options.output))
                    })),
                    ..Tool::default()
                }),
            );
        }
        Ok(tools)
    }

    /// The server's `serverInfo` from initialization.
    pub fn server_info(&self) -> Value {
        self.inner.state.lock().server_info.clone()
    }

    /// The initialize result this client uses.
    pub fn initialize_result(&self) -> Value {
        self.inner.state.lock().initialize_result.clone()
    }

    /// The server's `instructions` from initialization.
    pub fn instructions(&self) -> Option<String> {
        self.inner.state.lock().instructions.clone()
    }

    /// `client.close()`: closes the transport; every request still waiting fails
    /// with `Connection closed`. Closing a closed client does nothing.
    pub async fn close(&self) -> anyhow::Result<()> {
        if self.inner.state.lock().is_closed {
            return Ok(());
        }
        self.inner
            .transport
            .close(MCPTransportCloseOptions::default())
            .await?;
        self.inner.on_close();
        Ok(())
    }
}
