//! Realtime transport for voice chat and meetings. Config resolves the endpoint
//! and credential together: explicit voice settings, managed protocol discovery,
//! or direct OpenAI. The sandbox proxy substitutes managed credential placeholders
//! on the Lens route; they must never be redirected to api.openai.com.
//! Remote sockets require WSS. Plain WS is accepted only on loopback.

use std::sync::atomic::AtomicBool;

use indexmap::IndexMap;

const REALTIME_HOST: &str = "wss://api.openai.com/v1/realtime";

/// The only hosts a plaintext `ws://` override may name.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The override is reported once, on the first session it opens.
static OVERRIDE_REPORTED: AtomicBool = AtomicBool::new(false);

/// The resolved voice URL, or OpenAI's own when no endpoint is configured.
///
/// Keep the same transport constraints for managed and explicit endpoints:
/// remote credentials require TLS, while local test servers may use plaintext.
///
/// Errors with `Realtime endpoint is not a valid URL`, or with
/// `Realtime endpoint must be wss://, or ws:// to localhost, 127.0.0.1 or [::1] — {protocol}//{host} would send the API key unencrypted.`
/// Logs `[Meeting] Realtime endpoint selected` with `host`, `provider` and `source` once.
fn resolve_realtime_base() -> anyhow::Result<String> {
    todo!()
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RealtimeEndpoint {
    pub url: String,
    pub headers: IndexMap<String, String>,
    /// Set when an explicit HTTPS_PROXY must be tunnelled through.
    pub proxy_url: Option<String>,
}

/// Resolve the Realtime endpoint, or fail when no key is configured.
///
/// Failing rather than returning `None`: callers only reach this after the meeting
/// tools have already gated on `is_realtime_configured()`, so a missing key here is
/// a programming error, not an operator misconfiguration to degrade around.
///
/// The error text is `config.realtime_unavailable_reason`, or
/// `No Realtime credential configured — set OPENAI_REALTIME_API_KEY or enable a managed Realtime provider.`
///
/// `model` defaults to `OPENAI_REALTIME_MODEL`. It is appended to the URL's query as
/// `model=<encodeURIComponent(model)>` rather than written through a query builder, which
/// would rewrite a space as `+`, and it keeps a query the override already carries. The
/// only header is `Authorization: Bearer <key>` (Realtime went GA in August 2025; the
/// `OpenAI-Beta: realtime=v1` header the preview models required is no longer sent).
/// `proxy_url` is `HTTPS_PROXY`, else `https_proxy`: outbound calls normally traverse the
/// transparent MITM directly, and only an explicit proxy needs tunnelling.
pub fn resolve_realtime_endpoint(model: Option<&str>) -> anyhow::Result<RealtimeEndpoint> {
    todo!()
}

/// Whether a Realtime session can be opened at all (used to gate the tools).
pub fn is_realtime_configured() -> bool {
    todo!()
}

/// What a Realtime WebSocket client connects with.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RealtimeSocketOptions {
    /// Headers sent with the upgrade request.
    pub headers: IndexMap<String, String>,
    /// The HTTPS proxy to tunnel the connection through with `CONNECT`, when one is set.
    pub proxy_url: Option<String>,
}

/// The socket client options, adding a proxy tunnel when HTTPS_PROXY is set.
///
/// Returns options rather than a socket so `realtime_session.rs` stays testable
/// against a local mock server. A connection whose proxy cannot be used degrades to
/// a direct one and logs
/// `[Meeting] HTTPS_PROXY set but https-proxy-agent unavailable, connecting directly: {message}`
/// at warn, matching `get_proxy_dispatcher()`.
pub fn build_realtime_socket_options(endpoint: &RealtimeEndpoint) -> RealtimeSocketOptions {
    todo!()
}
