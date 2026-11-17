//! Which requests a browser may make to the runtime.
//!
//! Two rules, applied to the HTTP routes and to the `/api/ws` handshake alike —
//! a WebSocket handshake is exempt from the same-origin policy, so the check has
//! to be made here rather than left to the browser:
//!
//! 1. **The `Host` must name this machine while the bind is loopback**, unless
//!    the request states `X-Forwarded-Host` — a proxy in front, which is the one
//!    way network traffic legitimately arrives at a loopback bind. Without that
//!    header, a request naming another host arrived under a hostname that
//!    resolves here — the shape of a DNS rebinding attack, where the attacker's
//!    page and the request agree on a name so the browser treats the runtime as
//!    same-origin. A widened bind (`PRISM_HOST`) accepts any `Host`, since the
//!    exposed address is the operator's to choose.
//! 2. **A stated `Origin` must be one `PRISM_ALLOWED_ORIGINS` lists, the host the
//!    browser addressed, or loopback.** The addressed host is the request's
//!    own `Host`, or the first `X-Forwarded-Host` value when a proxy rewrote
//!    `Host` on the way in; that is what serves the Web UI of a deliberately
//!    widened runtime, hosted deployments included. The list admits a web app on
//!    another site, and only a runtime behind an authenticating proxy may set it
//!    (`config.rs` refuses it on a loopback bind). Rule 1 runs first, whatever
//!    the list holds.
//!
//! A request stating no `Origin` passes rule 2. That is every non-browser client
//! — the terminal UI, `curl`, a webhook sender — and a browser states the header
//! on the cross-origin requests these rules are about.
//!
//! An HTTP request from a listed origin gets `Access-Control-Allow-Origin` naming
//! that origin, so the page can read the response, and with a list configured
//! every response varies on `Origin`. The guard runs ahead of every route and
//! body parser, so error responses have the header too. It also answers that
//! origin's CORS preflight, which a proxy in front may answer first.
//!
//! Trusting `X-Forwarded-Host` keeps the browser rules intact: a browser cannot
//! state that header itself — the WebSocket API sends no custom headers, and a
//! fetch that adds one fails its CORS preflight — and a non-browser client
//! already passes by stating no `Origin`.

use axum::Json;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_METHOD, HOST, ORIGIN, VARY,
};
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use serde_json::json;
use url::Url;

use crate::config::CONFIG;
use crate::lib::loopback_host::is_loopback_hostname;
use crate::lib::origin_patterns::matches_origin;
use crate::log_warn;

// Every method a route here serves, and the request headers a cross-origin client
// sends. The sandbox ingress answers the same preflight with the same values
// (`PREFLIGHT_ALLOW_*` in nexus-monorepo
// `packages/nexus/src/api/sandbox-ingress/handler.ts`), so the two change together.
const PREFLIGHT_ALLOW_METHODS: &str = "GET, HEAD, POST, PUT, PATCH, DELETE";
const PREFLIGHT_ALLOW_HEADERS: &str = "Authorization, Content-Type";
const PREFLIGHT_MAX_AGE_SECONDS: &str = "600";

/// The `Host` header is `hostname:port` with no scheme, and may hold `[::1]`.
fn hostname_of(host_header: &str) -> Option<String> {
    let url = Url::parse(&format!("http://{host_header}")).ok()?;
    Some(url.host_str().unwrap_or("").to_string())
}

fn is_allowed_host(host: Option<&str>, forwarded_host: Option<&str>) -> bool {
    if !CONFIG.listens_on_loopback {
        return true;
    }
    // A proxy in front — the one way network traffic legitimately arrives at a
    // loopback bind. A browser cannot state the header, so rebinding stays closed.
    if forwarded_host.is_some() {
        return true;
    }
    let Some(host) = host.filter(|h| !h.is_empty()) else {
        return true;
    };
    match hostname_of(host) {
        Some(hostname) => is_loopback_hostname(&hostname),
        None => false,
    }
}

/// First host in `X-Forwarded-Host`, which chained proxies join with commas.
fn first_forwarded_host(header: Option<&str>) -> Option<String> {
    let first = header?.split(',').next().unwrap_or("").trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// A refused request, or an admitted one. `cors_origin` is set when the list
/// admitted it, and holds the origin in the form the browser compares against.
enum Verdict {
    Refused,
    Admitted { cors_origin: Option<String> },
}

impl Verdict {
    fn admitted(&self) -> bool {
        matches!(self, Verdict::Admitted { .. })
    }
}

const ADMITTED: Verdict = Verdict::Admitted { cors_origin: None };

/// `URL.host`: the hostname, and the port when it is not the scheme's default.
fn url_host(url: &Url) -> String {
    let hostname = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{hostname}:{port}"),
        None => hostname.to_string(),
    }
}

fn judge(origin: Option<&str>, host: Option<&str>, forwarded_host: Option<&str>) -> Verdict {
    let forwarded = first_forwarded_host(forwarded_host);
    if !is_allowed_host(host, forwarded.as_deref()) {
        return Verdict::Refused;
    }
    let Some(origin) = origin.filter(|o| !o.is_empty()) else {
        return ADMITTED;
    };
    // Ahead of the host comparisons: `http://h` calling `https://h` has the same
    // host and another origin, and its page needs the CORS headers to read.
    if matches_origin(&CONFIG.allowed_origins, Some(origin)) {
        let cors_origin = Url::parse(origin)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_else(|_| origin.to_string());
        return Verdict::Admitted {
            cors_origin: Some(cors_origin),
        };
    }

    // A parse failure includes the literal `null` a sandboxed page sends.
    let Ok(parsed) = Url::parse(origin) else {
        return Verdict::Refused;
    };

    let stated = url_host(&parsed).to_lowercase();
    if let Some(host) = host.filter(|h| !h.is_empty())
        && stated == host.to_lowercase()
    {
        return ADMITTED;
    }
    if let Some(forwarded) = &forwarded
        && stated == forwarded.to_lowercase()
    {
        return ADMITTED;
    }
    if is_loopback_hostname(parsed.host_str().unwrap_or("")) {
        ADMITTED
    } else {
        Verdict::Refused
    }
}

/// `origin` is the request's `Origin` header, `host` its `Host` header, and
/// `forwarded_host` its `X-Forwarded-Host` header.
pub fn is_allowed_origin(
    origin: Option<&str>,
    host: Option<&str>,
    forwarded_host: Option<&str>,
) -> bool {
    judge(origin, host, forwarded_host).admitted()
}

/// A header's value as Node gives it: each byte read as Latin-1, so a value that is
/// not UTF-8 is still present, and repeated headers joined with `, `. The one header
/// reader for this module and `forwarded_sender`.
pub fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|v| v.as_bytes().iter().map(|&b| char::from(b)).collect())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// `res.vary('Origin')`: add `Origin` to the response's `Vary` unless it is there.
fn vary_origin(headers: &mut HeaderMap) {
    let existing: Vec<String> = headers
        .get_all(VARY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .collect::<Vec<_>>()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if existing
        .iter()
        .any(|v| v == "*" || v.eq_ignore_ascii_case("Origin"))
    {
        return;
    }
    let mut values = existing;
    values.push("Origin".to_string());
    if let Ok(value) = HeaderValue::from_str(&values.join(", ")) {
        headers.insert(VARY, value);
    }
}

/// Middleware form: answers 403 to a request the rules refuse, and gives a
/// listed origin its CORS headers.
pub async fn origin_guard(req: Request, next: Next) -> Response {
    // With a list configured, every response depends on `Origin`, refusals included.
    let vary = !CONFIG.allowed_origins.is_empty();

    let headers = req.headers();
    let origin = header_text(headers, ORIGIN.as_str());
    let host = header_text(headers, HOST.as_str());
    let forwarded_host = header_text(headers, "x-forwarded-host");
    let verdict = judge(
        origin.as_deref(),
        host.as_deref(),
        forwarded_host.as_deref(),
    );

    let mut cors_origin_header: Option<HeaderValue> = None;
    if let Verdict::Admitted {
        cors_origin: Some(cors_origin),
    } = &verdict
    {
        cors_origin_header = HeaderValue::from_str(cors_origin).ok();
        if req.method() == Method::OPTIONS && headers.contains_key(ACCESS_CONTROL_REQUEST_METHOD) {
            let mut response = StatusCode::NO_CONTENT.into_response();
            let out = response.headers_mut();
            if vary {
                vary_origin(out);
            }
            if let Some(value) = cors_origin_header {
                out.insert(ACCESS_CONTROL_ALLOW_ORIGIN, value);
            }
            out.insert(
                ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static(PREFLIGHT_ALLOW_METHODS),
            );
            out.insert(
                ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static(PREFLIGHT_ALLOW_HEADERS),
            );
            out.insert(
                ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static(PREFLIGHT_MAX_AGE_SECONDS),
            );
            return response;
        }
    }

    if verdict.admitted() {
        let mut response = next.run(req).await;
        let out = response.headers_mut();
        if vary {
            vary_origin(out);
        }
        if let Some(value) = cors_origin_header {
            out.insert(ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        return response;
    }

    let shown = |value: &Option<String>| value.clone().unwrap_or_else(|| "undefined".to_string());
    log_warn!(
        "[OriginGuard] refused {} {} (origin {}, host {}, x-forwarded-host {})",
        req.method(),
        req.uri().path(),
        shown(&origin),
        shown(&host),
        shown(&forwarded_host)
    );
    let mut response = crate::support::http::error_json(403, "Forbidden origin");
    if vary {
        vary_origin(response.headers_mut());
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::http::testing::{request, send};

    #[test]
    fn allows_a_request_that_states_no_origin_or_no_host() {
        assert!(is_allowed_origin(None, Some("localhost:3003"), None));
        assert!(is_allowed_origin(None, None, None));
        assert!(is_allowed_origin(Some("http://localhost:3003"), None, None));
    }

    #[test]
    fn allows_loopback_origins_whatever_the_port() {
        for origin in [
            "http://localhost:5173",
            "http://127.0.0.1:3003",
            "http://[::1]:8080",
        ] {
            assert!(
                is_allowed_origin(Some(origin), Some("localhost:3003"), None),
                "{origin}"
            );
        }
        assert!(is_allowed_origin(
            Some("http://[::1]:3003"),
            Some("[::1]:3003"),
            None
        ));
    }

    #[test]
    fn refuses_a_foreign_host_while_the_bind_is_loopback() {
        assert!(!is_allowed_origin(
            Some("http://evil.example:3003"),
            Some("evil.example:3003"),
            None
        ));
        assert!(!is_allowed_origin(None, Some("evil.example:3003"), None));
        assert!(!is_allowed_origin(
            None,
            Some("evil.example:3003"),
            Some("")
        ));
        assert!(!is_allowed_origin(None, Some("not a host"), None));
    }

    #[test]
    fn reads_a_host_that_is_not_utf8_as_latin1_and_refuses_it() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "host",
            HeaderValue::from_bytes(b"localhost\xff:3003").unwrap(),
        );
        let host = header_text(&headers, "host");
        assert_eq!(host.as_deref(), Some("localhost\u{ff}:3003"));
        assert!(!is_allowed_origin(None, host.as_deref(), None));
    }

    #[test]
    fn refuses_a_foreign_or_joined_origin() {
        for origin in [
            "https://evil.example",
            "null",
            "http://localhost:3003, https://evil.example",
        ] {
            assert!(
                !is_allowed_origin(Some(origin), Some("localhost:3003"), None),
                "{origin}"
            );
        }
    }

    #[test]
    fn trusts_the_first_x_forwarded_host_of_a_proxy_in_front() {
        assert!(is_allowed_origin(
            Some("https://Web.Platform.Example"),
            Some("runtime:3003"),
            Some("web.platform.example, other.example")
        ));
        assert!(!is_allowed_origin(
            Some("https://evil.example"),
            Some("runtime:3003"),
            Some("web.platform.example")
        ));
        assert!(!is_allowed_origin(
            Some("https://web.platform.example"),
            Some("runtime:3003"),
            None
        ));
        assert!(is_allowed_origin(
            None,
            Some("agent.example.com"),
            Some("agent.example.com")
        ));
    }

    #[tokio::test]
    async fn answers_403_for_a_foreign_origin_with_no_vary_while_no_list_is_set() {
        let app = || {
            axum::Router::new()
                .route("/x", axum::routing::get(|| async { "ok" }))
                .layer(axum::middleware::from_fn(origin_guard))
        };
        let mut req = request("GET", "/x", None);
        req.headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());
        req.headers_mut()
            .insert("host", "localhost:3003".parse().unwrap());
        let res = send(app(), req).await;
        assert_eq!(res.status, 403);
        assert_eq!(res.json(), json!({ "error": "Forbidden origin" }));
        assert!(res.header("vary").is_none());

        let mut req = request("GET", "/x", None);
        req.headers_mut()
            .insert("host", "localhost:3003".parse().unwrap());
        assert_eq!(send(app(), req).await.status, 200);
    }
}
