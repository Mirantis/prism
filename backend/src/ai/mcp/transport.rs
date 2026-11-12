//! The transport an MCP client speaks through (`MCPTransport`), and the two the
//! SDK builds from a configuration: Streamable HTTP and legacy SSE.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use indexmap::IndexMap;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::http_transport::HttpMCPTransport;
use super::sse_transport::SseMCPTransport;
use super::types::LATEST_PROTOCOL_VERSION;
use crate::ai::AbortError;

/// Called with each message the server sends. An error is what the handler
/// threw; the transport reports it as it reports its own.
pub type OnMessage = Arc<dyn Fn(Value) -> anyhow::Result<()> + Send + Sync>;
/// Called with a transport error that no caller awaits.
pub type OnError = Arc<dyn Fn(&anyhow::Error) + Send + Sync>;
/// Called when the transport closes.
pub type OnClose = Arc<dyn Fn() + Send + Sync>;

/// The client's `onmessage`, `onerror` and `onclose`.
#[derive(Clone)]
pub struct TransportHandlers {
    pub on_message: OnMessage,
    pub on_error: OnError,
    pub on_close: OnClose,
}

/// `MCPTransportSendOptions`.
#[derive(Clone, Default)]
pub struct MCPTransportSendOptions {
    /// Cancels the transport operation for this message.
    pub signal: Option<CancellationToken>,
    /// Request headers produced from MCP tool parameters.
    pub headers: Option<Vec<(String, String)>>,
}

/// `MCPTransportCloseOptions`.
#[derive(Clone, Default)]
pub struct MCPTransportCloseOptions {
    /// Cancels transport cleanup.
    pub signal: Option<CancellationToken>,
}

/// `MCPTransport`: how JSON-RPC messages reach one server.
#[async_trait]
pub trait MCPTransport: Send + Sync {
    /// Whether the client may probe for the stateless protocol (`server/discover`).
    fn supports_protocol_version_discovery(&self) -> bool {
        false
    }

    /// Whether the transport mirrors `x-mcp-header` tool parameters into headers.
    fn supports_mcp_tool_parameter_headers(&self) -> bool {
        false
    }

    /// Installs the client's handlers. Called once, before `start`.
    fn set_handlers(&self, handlers: TransportHandlers);

    /// The protocol version negotiated during initialization.
    fn set_protocol_version(&self, _version: &str) {}

    async fn start(&self) -> anyhow::Result<()>;

    async fn send(&self, message: Value, options: MCPTransportSendOptions) -> anyhow::Result<()>;

    async fn close(&self, options: MCPTransportCloseOptions) -> anyhow::Result<()>;
}

/// `MCPTransportConfig`, or a transport of the caller's own.
#[derive(Clone)]
pub enum MCPTransportConfig {
    /// Streamable HTTP.
    Http {
        url: String,
        headers: Option<IndexMap<String, String>>,
    },
    /// Legacy HTTP+SSE.
    Sse {
        url: String,
        headers: Option<IndexMap<String, String>>,
    },
    Custom(Arc<dyn MCPTransport>),
}

/// `createMcpTransport`. Fails with `Invalid URL` for a URL that does not parse.
pub fn create_mcp_transport(config: MCPTransportConfig) -> anyhow::Result<Arc<dyn MCPTransport>> {
    Ok(match config {
        MCPTransportConfig::Http { url, headers } => HttpMCPTransport::new(
            &url,
            headers.unwrap_or_default(),
            Some(LATEST_PROTOCOL_VERSION.to_string()),
        )?,
        MCPTransportConfig::Sse { url, headers } => {
            SseMCPTransport::new(&url, headers.unwrap_or_default())?
        }
        MCPTransportConfig::Custom(transport) => transport,
    })
}

/// Node's global `fetch`: no proxy, and a redirect fails the request.
pub(crate) static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            attempt.error("unexpected redirect")
        }))
        .build()
        .expect("MCP HTTP client")
});

/// Waits until any of the signals is cancelled; forever when there is none.
pub(crate) async fn any_cancelled(signals: &[CancellationToken]) {
    if signals.is_empty() {
        return std::future::pending().await;
    }
    let waits = signals
        .iter()
        .map(|s| Box::pin(s.cancelled()))
        .collect::<Vec<_>>();
    futures::future::select_all(waits).await;
}

/// The reason an aborted `AbortSignal` carries.
pub(crate) fn abort_error() -> anyhow::Error {
    anyhow::Error::new(AbortError::operation())
}

/// `url.href`, or `Invalid URL`.
pub(crate) fn parse_url(url: &str) -> anyhow::Result<url::Url> {
    url::Url::parse(url).map_err(|_| anyhow::anyhow!("Invalid URL"))
}

/// The reason phrase `fetch` gives as `statusText`.
pub(crate) fn status_text(status: reqwest::StatusCode) -> &'static str {
    status.canonical_reason().unwrap_or("")
}
