//! Realtime transport for voice chat and meetings. Config resolves the endpoint
//! and credential together: explicit voice settings, managed protocol discovery,
//! or direct OpenAI. The sandbox proxy substitutes managed credential placeholders
//! on the Lens route; they must never be redirected to api.openai.com.
//! Remote sockets require WSS. Plain WS is accepted only on loopback.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use indexmap::IndexMap;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::config::CONFIG;
use crate::{log_info, log_warn};

const REALTIME_HOST: &str = "wss://api.openai.com/v1/realtime";

/// The only hosts a plaintext `ws://` override may name.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The override is reported once, on the first session it opens.
static OVERRIDE_REPORTED: AtomicBool = AtomicBool::new(false);

/// What `encodeURIComponent` leaves as it is: letters, digits and `-_.!~*'()`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    utf8_percent_encode(text, URI_COMPONENT).to_string()
}

/// A URL's `host` as WHATWG URL reports it: the hostname, and the port when it is not
/// the scheme's default.
pub(crate) fn url_host(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// The resolved voice URL, or OpenAI's own when no endpoint is configured.
///
/// Keep the same transport constraints for managed and explicit endpoints:
/// remote credentials require TLS, while local test servers may use plaintext.
fn resolve_realtime_base_from(configured: Option<&str>) -> anyhow::Result<String> {
    let override_url = configured
        .filter(|url| !url.is_empty())
        .unwrap_or(REALTIME_HOST)
        .to_string();

    let Ok(parsed) = url::Url::parse(&override_url) else {
        anyhow::bail!("Realtime endpoint is not a valid URL");
    };

    let hostname = parsed.host_str().unwrap_or_default();
    let is_loopback_plaintext = parsed.scheme() == "ws" && LOOPBACK_HOSTS.contains(&hostname);
    if parsed.scheme() != "wss" && !is_loopback_plaintext {
        anyhow::bail!(
            "Realtime endpoint must be wss://, or ws:// to localhost, 127.0.0.1 or [::1] — {}://{} would send the API key unencrypted.",
            parsed.scheme(),
            url_host(&parsed)
        );
    }

    if !OVERRIDE_REPORTED.swap(true, Ordering::SeqCst) {
        // The host, never the URL: a query string an operator added is not ours to log.
        let mut fields = Map::new();
        fields.insert("host".into(), Value::from(url_host(&parsed)));
        if let Some(provider) = &CONFIG.realtime_provider {
            fields.insert("provider".into(), Value::from(provider.clone()));
        }
        fields.insert(
            "source".into(),
            Value::from(CONFIG.realtime_source.as_str()),
        );
        log_info!(
            Value::Object(fields),
            "[Meeting] Realtime endpoint selected"
        );
    }
    Ok(override_url)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RealtimeEndpoint {
    pub url: String,
    pub headers: IndexMap<String, String>,
    /// Set when an explicit HTTPS_PROXY must be tunnelled through.
    pub proxy_url: Option<String>,
}

/// What the endpoint is resolved from: the parts of the configuration it reads.
struct EndpointSettings<'a> {
    api_key: Option<&'a str>,
    unavailable_reason: Option<&'a str>,
    model: &'a str,
    url: Option<&'a str>,
    proxy_url: Option<String>,
}

/// Resolve the Realtime endpoint, or fail when no key is configured.
///
/// Failing rather than returning `None`: callers only reach this after the meeting
/// tools have already gated on `is_realtime_configured()`, so a missing key here is
/// a programming error, not an operator misconfiguration to degrade around.
pub fn resolve_realtime_endpoint(model: Option<&str>) -> anyhow::Result<RealtimeEndpoint> {
    resolve_endpoint_from(
        &EndpointSettings {
            api_key: CONFIG.openai_realtime_api_key.as_deref(),
            unavailable_reason: CONFIG.realtime_unavailable_reason.as_deref(),
            model: &CONFIG.openai_realtime_model,
            url: CONFIG.openai_realtime_url.as_deref(),
            proxy_url: explicit_https_proxy(),
        },
        model,
    )
}

/// `HTTPS_PROXY`, else `https_proxy`; an empty value counts as unset.
fn explicit_https_proxy() -> Option<String> {
    std::env::var("HTTPS_PROXY")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("https_proxy")
                .ok()
                .filter(|value| !value.is_empty())
        })
}

fn resolve_endpoint_from(
    settings: &EndpointSettings<'_>,
    model: Option<&str>,
) -> anyhow::Result<RealtimeEndpoint> {
    let Some(api_key) = settings.api_key.filter(|key| !key.is_empty()) else {
        anyhow::bail!(
            "{}",
            settings
                .unavailable_reason
                .filter(|reason| !reason.is_empty())
                .unwrap_or(
                    "No Realtime credential configured — set OPENAI_REALTIME_API_KEY or enable a managed Realtime provider."
                )
        );
    };

    let model_id = model.filter(|m| !m.is_empty()).unwrap_or(settings.model);
    // The same transport serves managed, direct, and explicitly configured voice.
    let mut target = url::Url::parse(&resolve_realtime_base_from(settings.url)?)?;
    // Appended rather than written through a query builder, which would keep the model
    // name but rewrite a space as `+`, and it holds a query the override already carries.
    let model_param = format!("model={}", encode_uri_component(model_id));
    let query = match target.query().filter(|q| !q.is_empty()) {
        Some(existing) => format!("{existing}&{model_param}"),
        None => model_param,
    };
    target.set_query(Some(&query));
    let url = target.to_string();

    // Realtime went GA in August 2025; the `OpenAI-Beta: realtime=v1` header the
    // preview models required is no longer sent.
    let mut headers = IndexMap::new();
    headers.insert("Authorization".to_string(), format!("Bearer {api_key}"));

    // Mirrors lib/proxy_dispatcher.rs: outbound calls normally traverse the
    // transparent MITM directly, and only an EXPLICIT HTTPS_PROXY needs tunnelling.
    Ok(RealtimeEndpoint {
        url,
        headers,
        proxy_url: settings.proxy_url.clone(),
    })
}

/// Whether a Realtime session can be opened at all (used to gate the tools).
pub fn is_realtime_configured() -> bool {
    CONFIG
        .openai_realtime_api_key
        .as_deref()
        .is_some_and(|key| !key.is_empty())
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
/// against a local mock server. Degrades to a direct connection — never fails —
/// when the proxy cannot be used, matching `get_proxy_dispatcher()`. The tunnel is a
/// plain `CONNECT` to an `http://` proxy, with the URL's credentials as
/// `Proxy-Authorization: Basic`.
pub fn build_realtime_socket_options(endpoint: &RealtimeEndpoint) -> RealtimeSocketOptions {
    let Some(proxy_url) = endpoint.proxy_url.as_deref() else {
        return RealtimeSocketOptions {
            headers: endpoint.headers.clone(),
            proxy_url: None,
        };
    };

    match usable_proxy(proxy_url) {
        Ok(()) => RealtimeSocketOptions {
            headers: endpoint.headers.clone(),
            proxy_url: Some(proxy_url.to_string()),
        },
        Err(message) => {
            log_warn!(
                "[Meeting] HTTPS_PROXY set but https-proxy-agent unavailable, connecting directly: {}",
                message
            );
            RealtimeSocketOptions {
                headers: endpoint.headers.clone(),
                proxy_url: None,
            }
        }
    }
}

/// Whether a proxy URL is one the tunnel can use, or why not.
fn usable_proxy(proxy_url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(proxy_url).map_err(|_| format!("Invalid URL: {proxy_url}"))?;
    if parsed.scheme() != "http" {
        return Err(format!("unsupported proxy protocol {}:", parsed.scheme()));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(format!("Invalid URL: {proxy_url}"));
    }
    Ok(())
}

/// An open Realtime socket.
pub type RealtimeSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

static UNEXPECTED_RESPONSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Unexpected server response: (\d{3})").expect("valid regex"));

/// The HTTP status a failed handshake's message names, if it names one.
pub(crate) fn handshake_status(message: &str) -> Option<i64> {
    UNEXPECTED_RESPONSE
        .captures(message)
        .and_then(|captures| captures.get(1))
        .and_then(|status| status.as_str().parse().ok())
}

/// Open a Realtime socket to `url` with `options`.
///
/// The error's message is the reason the way a WebSocket client words it: a refused
/// upgrade reads `Unexpected server response: {status}`.
pub async fn connect_realtime_socket(
    url: &str,
    options: &RealtimeSocketOptions,
) -> anyhow::Result<RealtimeSocket> {
    let mut request = url
        .into_client_request()
        .map_err(|err| anyhow::anyhow!("{}", describe_ws_error(&err)))?;
    for (name, value) in &options.headers {
        let name = HeaderName::from_bytes(name.as_bytes())?;
        let value = HeaderValue::from_str(value)?;
        request.headers_mut().insert(name, value);
    }

    let result = match options.proxy_url.as_deref() {
        None => tokio_tungstenite::connect_async(request)
            .await
            .map(|(socket, _)| socket),
        Some(proxy_url) => {
            let target = url::Url::parse(url)?;
            let host = target.host_str().unwrap_or_default().to_string();
            let port = target.port_or_known_default().unwrap_or(443);
            let stream = tunnel(proxy_url, &host, port).await?;
            tokio_tungstenite::client_async_tls_with_config(request, stream, None, None)
                .await
                .map(|(socket, _)| socket)
        }
    };
    result.map_err(|err| anyhow::anyhow!("{}", describe_ws_error(&err)))
}

/// A handshake failure in the words a WebSocket client uses for it.
fn describe_ws_error(err: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match err {
        Error::Http(response) => {
            format!("Unexpected server response: {}", response.status().as_u16())
        }
        Error::Io(io) => io.to_string(),
        other => other.to_string(),
    }
}

/// A TCP connection to `host:port` through the proxy's `CONNECT`.
async fn tunnel(proxy_url: &str, host: &str, port: u16) -> anyhow::Result<TcpStream> {
    let proxy = url::Url::parse(proxy_url)?;
    let proxy_host = proxy.host_str().unwrap_or_default();
    let proxy_port = proxy.port_or_known_default().unwrap_or(80);
    let mut stream = TcpStream::connect((proxy_host, proxy_port)).await?;

    let authority = format!("{host}:{port}");
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if !proxy.username().is_empty() {
        let user = percent_encoding::percent_decode_str(proxy.username()).decode_utf8_lossy();
        let password = percent_encoding::percent_decode_str(proxy.password().unwrap_or(""))
            .decode_utf8_lossy();
        let credentials =
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    // The proxy's answer ends at the blank line; the tunnel starts right after it.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 {
            anyhow::bail!("Proxy response too long");
        }
        let read = stream.read(&mut byte).await?;
        if read == 0 {
            anyhow::bail!("Proxy closed the connection");
        }
        head.push(byte[0]);
    }
    let status_line = String::from_utf8_lossy(&head);
    let status = status_line
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    if status != 200 {
        anyhow::bail!("Unexpected server response: {status}");
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings<'a>(url: Option<&'a str>, api_key: Option<&'a str>) -> EndpointSettings<'a> {
        EndpointSettings {
            api_key,
            unavailable_reason: None,
            model: "gpt-realtime",
            url,
            proxy_url: None,
        }
    }

    fn resolve(url: Option<&str>) -> anyhow::Result<RealtimeEndpoint> {
        resolve_endpoint_from(&settings(url, Some("sk-test-key")), None)
    }

    #[test]
    fn connects_directly_to_openai_when_no_voice_endpoint_is_configured() {
        assert_eq!(
            resolve(None).unwrap().url,
            "wss://api.openai.com/v1/realtime?model=gpt-realtime"
        );
    }

    #[test]
    fn uses_a_managed_endpoint_with_its_scoped_placeholder_for_routing_and_auth() {
        let endpoint = resolve_endpoint_from(
            &settings(
                Some("wss://lens.example/prefix/v1/projects/p/llm/openai/v1/realtime"),
                Some("__lens_cred:nexus-llm-openai__"),
            ),
            None,
        )
        .unwrap();
        assert_eq!(
            endpoint.url,
            "wss://lens.example/prefix/v1/projects/p/llm/openai/v1/realtime?model=gpt-realtime"
        );
        assert_eq!(
            endpoint.headers.get("Authorization").map(String::as_str),
            Some("Bearer __lens_cred:nexus-llm-openai__")
        );
    }

    #[test]
    fn takes_the_host_from_the_override_when_it_is_set() {
        assert_eq!(
            resolve(Some("ws://127.0.0.1:3103/v1/realtime"))
                .unwrap()
                .url,
            "ws://127.0.0.1:3103/v1/realtime?model=gpt-realtime"
        );
    }

    #[test]
    fn accepts_an_encrypted_override_to_any_host() {
        assert_eq!(
            resolve(Some("wss://voice.internal/v1/realtime"))
                .unwrap()
                .url,
            "wss://voice.internal/v1/realtime?model=gpt-realtime"
        );
    }

    #[test]
    fn accepts_a_plaintext_override_to_each_loopback_spelling() {
        for host in ["localhost:3103", "127.0.0.1:3103", "[::1]:3103"] {
            let url = format!("ws://{host}/v1/realtime");
            assert_eq!(
                resolve(Some(&url)).unwrap().url,
                format!("ws://{host}/v1/realtime?model=gpt-realtime")
            );
        }
    }

    #[test]
    fn refuses_a_plaintext_override_to_any_other_host() {
        let err = resolve(Some("ws://voice.internal/v1/realtime")).unwrap_err();
        assert!(
            err.to_string()
                .contains("must be wss://, or ws:// to localhost"),
            "{err}"
        );
        assert!(err.to_string().contains("ws://voice.internal would send"));
    }

    #[test]
    fn refuses_an_override_that_is_not_a_url() {
        let err = resolve(Some("127.0.0.1:3103/v1/realtime")).unwrap_err();
        assert_eq!(err.to_string(), "Realtime endpoint is not a valid URL");
    }

    #[test]
    fn keeps_a_query_string_the_override_already_carries() {
        assert_eq!(
            resolve(Some("wss://voice.internal/v1/realtime?tenant=alpha"))
                .unwrap()
                .url,
            "wss://voice.internal/v1/realtime?tenant=alpha&model=gpt-realtime"
        );
    }

    #[test]
    fn still_requires_a_key_against_an_overridden_host() {
        let err = resolve_endpoint_from(
            &settings(Some("ws://127.0.0.1:3103/v1/realtime"), None),
            None,
        )
        .unwrap_err();
        assert!(
            err.to_string()
                .contains("No Realtime credential configured")
        );
    }

    #[test]
    fn names_the_unavailable_reason_when_config_gave_one() {
        let mut s = settings(None, None);
        s.unavailable_reason = Some("No managed provider serves Realtime.");
        let err = resolve_endpoint_from(&s, None).unwrap_err();
        assert_eq!(err.to_string(), "No managed provider serves Realtime.");
    }

    #[test]
    fn sends_the_key_as_a_header_so_a_credential_sentinel_stays_rewritable() {
        let endpoint =
            resolve_endpoint_from(&settings(None, Some("__nexus_cred:0d1a-uuid__")), None).unwrap();
        assert_eq!(
            endpoint.headers.get("Authorization").map(String::as_str),
            Some("Bearer __nexus_cred:0d1a-uuid__")
        );
        assert!(!endpoint.url.contains("nexus_cred"));
    }

    #[test]
    fn does_not_send_the_retired_preview_beta_header() {
        let endpoint = resolve(None).unwrap();
        assert_eq!(
            endpoint.headers.keys().cloned().collect::<Vec<_>>(),
            vec!["Authorization".to_string()]
        );
    }

    #[test]
    fn honours_the_configured_model_and_an_explicit_override() {
        let mut s = settings(None, Some("k"));
        s.model = "gpt-realtime-mini";
        assert!(
            resolve_endpoint_from(&s, None)
                .unwrap()
                .url
                .contains("model=gpt-realtime-mini")
        );
        assert!(
            resolve_endpoint_from(&s, Some("gpt-realtime-2.1"))
                .unwrap()
                .url
                .contains("model=gpt-realtime-2.1")
        );
    }

    #[test]
    fn url_encodes_the_model_name() {
        let endpoint =
            resolve_endpoint_from(&settings(None, Some("k")), Some("weird/model name")).unwrap();
        assert!(endpoint.url.contains("model=weird%2Fmodel%20name"));
    }

    #[test]
    fn reports_a_proxy_only_when_one_is_explicitly_configured() {
        assert_eq!(resolve(None).unwrap().proxy_url, None);
        let mut s = settings(None, Some("k"));
        s.proxy_url = Some("http://proxy.internal:3128".into());
        assert_eq!(
            resolve_endpoint_from(&s, None)
                .unwrap()
                .proxy_url
                .as_deref(),
            Some("http://proxy.internal:3128")
        );
    }

    #[test]
    fn passes_headers_through_with_no_proxy_when_there_is_none() {
        let options = build_realtime_socket_options(&resolve(None).unwrap());
        assert_eq!(
            options.headers.get("Authorization").map(String::as_str),
            Some("Bearer sk-test-key")
        );
        assert_eq!(options.proxy_url, None);
    }

    #[test]
    fn tunnels_through_the_proxy_when_https_proxy_is_set() {
        let mut endpoint = resolve(None).unwrap();
        endpoint.proxy_url = Some("http://proxy.internal:3128".into());
        let options = build_realtime_socket_options(&endpoint);
        assert_eq!(
            options.proxy_url.as_deref(),
            Some("http://proxy.internal:3128")
        );
        assert_eq!(
            options.headers.get("Authorization").map(String::as_str),
            Some("Bearer sk-test-key")
        );
    }

    #[test]
    fn reads_the_status_a_refused_handshake_names() {
        assert_eq!(
            handshake_status("Realtime connection failed: Unexpected server response: 403"),
            Some(403)
        );
        assert_eq!(handshake_status("connection refused"), None);
    }

    #[tokio::test]
    async fn tunnels_a_socket_through_an_http_connect_proxy() {
        use futures::{SinkExt, StreamExt};
        use tokio::net::TcpListener;
        use tokio_tungstenite::tungstenite::Message;

        // The upstream: a WebSocket server that echoes one text frame.
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = upstream.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            if let Some(Ok(message)) = ws.next().await {
                ws.send(message).await.unwrap();
            }
        });

        // The proxy: answers one CONNECT, then copies bytes both ways.
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let (mut client, _) = proxy.accept().await.unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                client.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let _ = seen_tx.send(String::from_utf8_lossy(&head).into_owned());
            let mut server = TcpStream::connect(("127.0.0.1", upstream_port))
                .await
                .unwrap();
            client
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
        });

        let options = RealtimeSocketOptions {
            headers: IndexMap::new(),
            proxy_url: Some(format!("http://user:pa%20ss@127.0.0.1:{proxy_port}")),
        };
        let mut socket =
            connect_realtime_socket(&format!("ws://127.0.0.1:{upstream_port}/v1"), &options)
                .await
                .unwrap();
        socket.send(Message::text("hello")).await.unwrap();
        let echoed = socket.next().await.unwrap().unwrap();
        assert_eq!(echoed.into_text().unwrap().as_str(), "hello");

        let head = seen_rx.await.unwrap();
        assert!(head.starts_with(&format!("CONNECT 127.0.0.1:{upstream_port} HTTP/1.1\r\n")));
        let expected = base64::engine::general_purpose::STANDARD.encode("user:pa ss");
        assert!(head.contains(&format!("Proxy-Authorization: Basic {expected}\r\n")));
    }
}
