//! Express 5's observable HTTP behavior on axum, for every route and listener.
//!
//! Clients read more than a handler's own answer: the content type of `res.json`,
//! `req.body` being `undefined` without a JSON content type, the 400 page for a
//! body that is not JSON, the 413 page for one over the limit, the 404 page for an
//! unmatched route, the 500 page for an error that escapes a handler, a repeated
//! query key read as an array, and a trailing slash that matches the route without
//! it. This module gives each of those one implementation:
//!
//! - [`json`]: `res.status(n).json(value)`.
//! - [`with_json_body`]: `app.use(express.json({ limit, verify }))`, read by the
//!   [`JsonBody`] extractor.
//! - [`QueryParams`]: `req.query` under Express 5's `simple` query parser.
//! - [`HandlerError`]: an error escaping a handler.
//! - [`finish`] and [`not_found`]: the 404 page for an unmatched path or method.
//! - [`serve`]: a listener with non-strict routing (a trailing slash is ignored).
//!
//! The error pages are the ones Express sends with `NODE_ENV=production`, which
//! every packaged runtime sets: the status text, not the stack.

use std::convert::Infallible;
use std::io::Read;
use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http::header::{
    CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, HeaderValue, TRANSFER_ENCODING,
};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower::Layer;
use tower_http::normalize_path::NormalizePathLayer;

use crate::lib::raw_body::capture_raw_body;

/// body-parser's limit when a parser names none (`100kb`).
pub const DEFAULT_JSON_LIMIT_BYTES: usize = 100 * 1024;

/// A status code as `res.status` takes it: a number or an `http::StatusCode`.
pub trait IntoStatus {
    fn into_status(self) -> StatusCode;
}

impl IntoStatus for StatusCode {
    fn into_status(self) -> StatusCode {
        self
    }
}

impl IntoStatus for u16 {
    fn into_status(self) -> StatusCode {
        StatusCode::from_u16(self).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

/// `res.status(status).json(value)`: the value as `JSON.stringify` writes it, with
/// `Content-Type: application/json; charset=utf-8`. A value that cannot be
/// serialized answers the 500 page, as a throwing `JSON.stringify` does.
pub fn json(status: impl IntoStatus, value: impl Serialize) -> Response {
    match serde_json::to_vec(&value) {
        Ok(text) => {
            let mut response = (status.into_status(), text).into_response();
            response.headers_mut().insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
        }
        Err(err) => HandlerError::from(err).into_response(),
    }
}

/// `res.status(status).json({ error: message })`, the body every route here
/// refuses or fails with.
pub fn error_json(status: impl IntoStatus, message: impl Into<String>) -> Response {
    json(status, serde_json::json!({ "error": message.into() }))
}

/// `res.status(status).end()`: no body.
pub fn empty(status: impl IntoStatus) -> Response {
    (status.into_status(), Body::empty()).into_response()
}

/// The status text Express's error pages show (`statuses.message[status]`).
pub fn status_message(status: StatusCode) -> &'static str {
    match status.as_u16() {
        418 => "I'm a Teapot",
        _ => status.canonical_reason().unwrap_or(""),
    }
}

/// `escape-html`.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("&quot;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&#39;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// `encodeurl`: percent-encodes what a URL cannot hold, keeping valid `%XX`
/// sequences as they are.
fn encode_url(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let is_hex = |b: Option<&u8>| b.is_some_and(u8::is_ascii_hexdigit);
    for (i, &b) in bytes.iter().enumerate() {
        let allowed =
            matches!(b, 0x21 | 0x23..=0x3B | 0x3D | 0x3F..=0x5F | 0x61..=0x7A | 0x7C | 0x7E);
        if b == b'%' && !(is_hex(bytes.get(i + 1)) && is_hex(bytes.get(i + 2))) {
            out.push_str("%25");
        } else if allowed {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// finalhandler's page: `message` in a minimal HTML document, with its security
/// headers.
pub fn error_page(status: StatusCode, message: &str) -> Response {
    let body = escape_html(message)
        .replace('\n', "<br>")
        .replace("  ", " &nbsp;");
    let document = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{body}</pre>\n</body>\n</html>\n"
    );
    let mut response = (status, document).into_response();
    let headers = response.headers_mut();
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
}

/// The page Express sends for an error with `status`: the status text.
pub fn status_page(status: impl IntoStatus) -> Response {
    let status = status.into_status();
    error_page(status, status_message(status))
}

/// The 404 Express sends when no route matched: `Cannot GET /path`.
pub async fn not_found(req: Request) -> Response {
    let message = format!("Cannot {} {}", req.method(), encode_url(req.uri().path()));
    error_page(StatusCode::NOT_FOUND, &message)
}

/// The app-level behavior every Express app has around its routes: an unmatched
/// path, and a matched path with no handler for the method, answer
/// [`not_found`]. Call it once, on the merged router, before the layers.
pub fn finish(router: Router) -> Router {
    router
        .method_not_allowed_fallback(not_found)
        .fallback(not_found)
}

/// An error that escaped a handler: Express's 500 page, and the error on
/// stderr, as Express logs it.
#[derive(Debug)]
pub struct HandlerError(pub anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for HandlerError {
    fn from(err: E) -> Self {
        HandlerError(err.into())
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        eprintln!("Error: {:#}", self.0);
        status_page(StatusCode::INTERNAL_SERVER_ERROR)
    }
}

/// What a handler that can fail answers.
pub type HandlerResult<T = Response> = Result<T, HandlerError>;

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

/// One `req.query` value: a string, or an array when the key repeats.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryValue {
    One(String),
    Many(Vec<String>),
}

impl QueryValue {
    /// `String(value)`: an array joins its items with commas.
    pub fn text(&self) -> String {
        match self {
            QueryValue::One(value) => value.clone(),
            QueryValue::Many(values) => values.join(","),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            QueryValue::One(value) => Value::String(value.clone()),
            QueryValue::Many(values) => {
                Value::Array(values.iter().cloned().map(Value::String).collect())
            }
        }
    }
}

/// `req.query` under Express 5's `simple` parser (`node:querystring`): a repeated
/// key is an array. Extract it in a handler as `query: QueryParams`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryParams(pub IndexMap<String, QueryValue>);

/// `querystring.parse`'s default `maxKeys`.
const MAX_QUERY_KEYS: usize = 1000;

/// `querystring.unescape`: `+` was already made a space; valid `%XX` pairs become
/// bytes, anything else stays, and the bytes are read as UTF-8.
fn unescape_query(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let pair = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = pair.and_then(|p| u8::from_str_radix(p, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl QueryParams {
    /// `querystring.parse(query)`.
    pub fn parse(query: &str) -> Self {
        let mut params: IndexMap<String, QueryValue> = IndexMap::new();
        if query.is_empty() {
            return QueryParams(params);
        }
        for segment in query.split('&').take(MAX_QUERY_KEYS) {
            let (key, value) = match segment.split_once('=') {
                Some((key, value)) => (key, Some(value)),
                None => (segment, None),
            };
            // An empty segment between separators, or a trailing one, adds nothing.
            if segment.is_empty() && value.is_none() {
                continue;
            }
            let key = unescape_query(&key.replace('+', " "));
            let value = unescape_query(&value.unwrap_or("").replace('+', " "));
            match params.get_mut(&key) {
                None => {
                    params.insert(key, QueryValue::One(value));
                }
                Some(QueryValue::One(first)) => {
                    let first = std::mem::take(first);
                    params.insert(key, QueryValue::Many(vec![first, value]));
                }
                Some(QueryValue::Many(values)) => values.push(value),
            }
        }
        QueryParams(params)
    }

    /// `req.query[key]`.
    pub fn get(&self, key: &str) -> Option<&QueryValue> {
        self.0.get(key)
    }

    /// `req.query[key]` when it is a string (`typeof x === 'string'`).
    pub fn str(&self, key: &str) -> Option<&str> {
        match self.0.get(key) {
            Some(QueryValue::One(value)) => Some(value.as_str()),
            _ => None,
        }
    }

    /// `String(req.query[key])` for a key that is present.
    pub fn text(&self, key: &str) -> Option<String> {
        self.0.get(key).map(QueryValue::text)
    }

    /// `req.query` as a JSON object.
    pub fn to_json(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .map(|(key, value)| (key.clone(), value.to_json()))
                .collect(),
        )
    }
}

impl<S: Send + Sync> FromRequestParts<S> for QueryParams {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Infallible> {
        Ok(QueryParams::parse(parts.uri.query().unwrap_or("")))
    }
}

// ---------------------------------------------------------------------------
// JSON bodies
// ---------------------------------------------------------------------------

/// `express.json` options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonOptions {
    /// The largest body read, in bytes; a larger one answers 413.
    pub limit: usize,
    /// Keep the raw bytes as `lib::raw_body::RawBodyRequest` (the `verify` hook
    /// `captureRawBody` installs).
    pub keep_raw_body: bool,
}

impl JsonOptions {
    pub fn limit(limit: usize) -> Self {
        JsonOptions {
            limit,
            keep_raw_body: false,
        }
    }

    pub fn keeping_raw_body(self) -> Self {
        JsonOptions {
            keep_raw_body: true,
            ..self
        }
    }
}

/// The parsed body, set by the parser for [`JsonBody`].
#[derive(Debug, Clone)]
struct ParsedJson(Value);

/// `req.body` after `express.json()`: `None` (`undefined`) when the request has
/// no body or no JSON content type, else the parsed object or array (`{}` for an
/// empty body). Needs [`with_json_body`] on the router.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JsonBody(pub Option<Value>);

impl JsonBody {
    /// `req.body?.[key]`: a field of an object body.
    pub fn field(&self, key: &str) -> Option<&Value> {
        self.0.as_ref().and_then(|body| body.get(key))
    }

    /// `req.body ?? {}`.
    pub fn or_empty(&self) -> Value {
        self.0
            .clone()
            .unwrap_or_else(|| Value::Object(Default::default()))
    }
}

impl<S: Send + Sync> FromRequestParts<S> for JsonBody {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Infallible> {
        Ok(JsonBody(
            parts.extensions.get::<ParsedJson>().map(|p| p.0.clone()),
        ))
    }
}

/// `app.use(express.json(options))` on every route of `router`, its fallback
/// included.
pub fn with_json_body(router: Router, options: JsonOptions) -> Router {
    router.layer(axum::middleware::from_fn_with_state(
        options,
        parse_json_body,
    ))
}

/// The media type and parameters of a `Content-Type` header, as the `content-type`
/// package parses them; `None` for a header it refuses.
fn parse_content_type(header: &str) -> Option<(String, Vec<(String, String)>)> {
    fn is_token(text: &str) -> bool {
        !text.is_empty()
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
    }
    let (media, rest) = match header.find(';') {
        Some(index) => (&header[..index], Some(&header[index + 1..])),
        None => (header, None),
    };
    let media = media.trim().to_lowercase();
    let (kind, subtype) = media.split_once('/')?;
    if !is_token(kind) || !is_token(subtype) {
        return None;
    }
    let mut parameters = Vec::new();
    if let Some(rest) = rest {
        for part in rest.split(';') {
            let (key, value) = part.split_once('=')?;
            let key = key.trim_matches(' ').to_lowercase();
            let value = value.trim_matches(' ');
            if !is_token(&key) {
                return None;
            }
            let value = if let Some(quoted) = value.strip_prefix('"') {
                quoted.strip_suffix('"')?.replace("\\\"", "\"")
            } else if is_token(value) {
                value.to_string()
            } else {
                return None;
            };
            parameters.push((key, value));
        }
    }
    Some((media, parameters))
}

/// `type-is`'s `hasBody`: a `Transfer-Encoding`, or a numeric `Content-Length`.
fn has_body(headers: &HeaderMap) -> bool {
    headers.contains_key(TRANSFER_ENCODING)
        || headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| crate::support::js::number_from(v).is_some_and(|n| !n.is_nan()))
}

/// Decompress a body as body-parser does for `Content-Encoding`; `Err` is the
/// status to answer.
fn inflate(encoding: &str, bytes: Bytes, limit: usize) -> Result<Bytes, StatusCode> {
    let mut out = Vec::new();
    let read = match encoding {
        "identity" => return Ok(bytes),
        "gzip" => flate2::read::GzDecoder::new(&bytes[..])
            .take(limit as u64 + 1)
            .read_to_end(&mut out),
        "deflate" => flate2::read::ZlibDecoder::new(&bytes[..])
            .take(limit as u64 + 1)
            .read_to_end(&mut out),
        _ => return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE),
    };
    if read.is_err() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if out.len() > limit {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    Ok(Bytes::from(out))
}

/// body-parser's strict JSON parse: an empty body is `{}`, and the first
/// character that is not whitespace has to open an object or an array.
pub fn parse_strict_json(text: &str) -> Option<Value> {
    if text.is_empty() {
        return Some(Value::Object(Default::default()));
    }
    let first = text
        .chars()
        .find(|c| !matches!(c, ' ' | '\t' | '\n' | '\r'));
    if !matches!(first, Some('{' | '[')) {
        return None;
    }
    serde_json::from_str(text).ok()
}

async fn parse_json_body(State(options): State<JsonOptions>, req: Request, next: Next) -> Response {
    if !has_body(req.headers()) {
        return next.run(req).await;
    }
    let content_type = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_type);
    let Some((media, parameters)) = content_type else {
        return next.run(req).await;
    };
    if media != "application/json" {
        return next.run(req).await;
    }
    let charset = parameters
        .iter()
        .find(|(key, _)| key == "charset")
        .map(|(_, value)| value.to_lowercase())
        .unwrap_or_else(|| "utf-8".to_string());
    // body-parser takes any `utf-` charset; this parser decodes UTF-8 alone.
    if charset != "utf-8" {
        return status_page(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let encoding = req
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity")
        .to_lowercase();
    if encoding == "identity" {
        let declared = req
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        if declared.is_some_and(|length| length > options.limit as u64) {
            return status_page(StatusCode::PAYLOAD_TOO_LARGE);
        }
    } else if !matches!(encoding.as_str(), "gzip" | "deflate") {
        return status_page(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    let (mut parts, body) = req.into_parts();
    let raw = match axum::body::to_bytes(body, options.limit).await {
        Ok(raw) => raw,
        Err(err) => {
            let too_large = std::error::Error::source(&err)
                .is_some_and(|source| source.is::<http_body_util::LengthLimitError>());
            return status_page(if too_large {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            });
        }
    };
    let raw = match inflate(&encoding, raw, options.limit) {
        Ok(raw) => raw,
        Err(status) => return status_page(status),
    };
    if options.keep_raw_body {
        capture_raw_body(&mut parts.extensions, raw.clone());
    }
    let text = String::from_utf8_lossy(&raw);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let Some(value) = parse_strict_json(text) else {
        return status_page(StatusCode::BAD_REQUEST);
    };
    parts.extensions.insert(ParsedJson(value));
    next.run(Request::from_parts(parts, Body::from(raw))).await
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/// Serve `router` on `listener` until `shutdown` is cancelled, then stop
/// accepting and let the open requests finish. Express's routing is not strict,
/// so a path with a trailing slash is routed as the path without it. Handlers can
/// extract `ConnectInfo<SocketAddr>`.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: CancellationToken,
) -> std::io::Result<()> {
    let app = NormalizePathLayer::trim_trailing_slash().layer(router);
    let service =
        axum::ServiceExt::<Request>::into_make_service_with_connect_info::<SocketAddr>(app);
    axum::serve(listener, service)
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await
}

/// Helpers for route tests: send a request through a router the way [`serve`]
/// does and read the answer.
#[cfg(test)]
pub mod testing {
    use super::*;
    use http::Method;
    use tower::ServiceExt;

    /// A router as a running listener serves it: Express's app behavior
    /// ([`finish`]) and JSON bodies up to 5 MB.
    pub fn app(router: Router) -> Router {
        with_json_body(finish(router), JsonOptions::limit(5 * 1024 * 1024))
    }

    /// An answer, read whole.
    #[derive(Debug)]
    pub struct TestResponse {
        pub status: u16,
        pub headers: HeaderMap,
        pub body: Bytes,
    }

    impl TestResponse {
        pub fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap_or(Value::Null)
        }

        pub fn text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }

        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers.get(name).and_then(|v| v.to_str().ok())
        }
    }

    /// A request with a JSON body when `body` is set.
    pub fn request(method: &str, uri: &str, body: Option<Value>) -> Request {
        let builder = http::Request::builder()
            .method(Method::from_bytes(method.as_bytes()).expect("method"))
            .uri(uri);
        match body {
            Some(body) => {
                let bytes = serde_json::to_vec(&body).expect("json");
                builder
                    .header(CONTENT_TYPE, "application/json")
                    .header(CONTENT_LENGTH, bytes.len().to_string())
                    .body(Body::from(bytes))
                    .expect("request")
            }
            None => builder.body(Body::empty()).expect("request"),
        }
    }

    /// Send `req` through `router` with non-strict routing.
    pub async fn send(router: Router, req: Request) -> TestResponse {
        let app = NormalizePathLayer::trim_trailing_slash().layer(router);
        let response = app.oneshot(req).await.expect("infallible");
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        TestResponse {
            status,
            headers,
            body,
        }
    }

    /// `send(app(router), request(method, uri, body))`.
    pub async fn call(
        router: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> TestResponse {
        send(app(router), request(method, uri, body)).await
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use axum::routing::{get, post};
    use serde_json::json;

    fn echo_router() -> Router {
        Router::new()
            .route(
                "/echo",
                post(|body: JsonBody| async move {
                    json(200, json!({ "defined": body.0.is_some(), "body": body.0 }))
                }),
            )
            .route(
                "/query",
                get(|query: QueryParams| async move { json(200, query.to_json()) }),
            )
            .route(
                "/fails",
                get(|| async { Err::<Response, HandlerError>(anyhow::anyhow!("boom").into()) }),
            )
            .route(
                "/raw",
                post(|req: Request| async move {
                    let raw = crate::lib::raw_body::get_raw_body(req.extensions());
                    json(
                        200,
                        json!({ "raw": raw.map(|b| String::from_utf8_lossy(&b).into_owned()) }),
                    )
                }),
            )
    }

    fn raw_request(method: &str, uri: &str, content_type: Option<&str>, body: &str) -> Request {
        let mut builder = http::Request::builder().method(method).uri(uri);
        if let Some(content_type) = content_type {
            builder = builder.header(CONTENT_TYPE, content_type);
        }
        builder = builder.header(CONTENT_LENGTH, body.len().to_string());
        builder.body(Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn answers_json_with_the_express_content_type() {
        let response = call(echo_router(), "POST", "/echo", Some(json!({ "a": 1 }))).await;
        assert_eq!(response.status, 200);
        assert_eq!(
            response.header("content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(response.text(), r#"{"defined":true,"body":{"a":1}}"#);
    }

    #[tokio::test]
    async fn leaves_the_body_undefined_without_a_json_content_type() {
        let req = raw_request("POST", "/echo", Some("text/plain"), "{\"a\":1}");
        let response = send(app(echo_router()), req).await;
        assert_eq!(response.json(), json!({ "defined": false, "body": null }));

        let req = http::Request::builder()
            .method("POST")
            .uri("/echo")
            .header(CONTENT_TYPE, "application/json")
            .body(Body::empty())
            .unwrap();
        let response = send(app(echo_router()), req).await;
        assert_eq!(response.json()["defined"], json!(false));
    }

    #[tokio::test]
    async fn reads_an_empty_json_body_as_an_empty_object() {
        let req = raw_request("POST", "/echo", Some("application/json; charset=utf-8"), "");
        let response = send(app(echo_router()), req).await;
        assert_eq!(response.json(), json!({ "defined": true, "body": {} }));
    }

    #[tokio::test]
    async fn answers_the_bad_request_page_for_a_body_that_is_not_json() {
        for body in ["{not json", "\"text\"", "12"] {
            let req = raw_request("POST", "/echo", Some("application/json"), body);
            let response = send(app(echo_router()), req).await;
            assert_eq!(response.status, 400, "{body}");
            assert_eq!(
                response.header("content-type"),
                Some("text/html; charset=utf-8")
            );
            assert!(response.text().contains("<pre>Bad Request</pre>"));
        }
    }

    #[tokio::test]
    async fn answers_the_payload_too_large_page_over_the_limit() {
        let router = with_json_body(finish(echo_router()), JsonOptions::limit(10));
        let req = raw_request(
            "POST",
            "/echo",
            Some("application/json"),
            "{\"a\":\"0123456789\"}",
        );
        let response = send(router, req).await;
        assert_eq!(response.status, 413);
        assert!(response.text().contains("<pre>Payload Too Large</pre>"));
    }

    #[tokio::test]
    async fn refuses_a_charset_other_than_utf8() {
        let req = raw_request(
            "POST",
            "/echo",
            Some("application/json; charset=latin1"),
            "{}",
        );
        let response = send(app(echo_router()), req).await;
        assert_eq!(response.status, 415);
    }

    #[tokio::test]
    async fn keeps_the_raw_body_when_asked() {
        let router = with_json_body(
            finish(echo_router()),
            JsonOptions::limit(1024).keeping_raw_body(),
        );
        let req = raw_request("POST", "/raw", Some("application/json"), "{ \"a\" :1 }");
        let response = send(router, req).await;
        assert_eq!(response.json(), json!({ "raw": "{ \"a\" :1 }" }));

        let req = raw_request("POST", "/raw", Some("application/json"), "{}");
        let response = send(app(echo_router()), req).await;
        assert_eq!(response.json(), json!({ "raw": null }));
    }

    #[tokio::test]
    async fn answers_the_express_404_page_for_an_unmatched_route_or_method() {
        let response = call(echo_router(), "GET", "/nowhere", None).await;
        assert_eq!(response.status, 404);
        assert_eq!(
            response.text(),
            "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /nowhere</pre>\n</body>\n</html>\n"
        );
        assert_eq!(
            response.header("content-security-policy"),
            Some("default-src 'none'")
        );
        assert_eq!(response.header("x-content-type-options"), Some("nosniff"));

        let response = call(echo_router(), "DELETE", "/echo", None).await;
        assert_eq!(response.status, 404);
        assert!(response.text().contains("<pre>Cannot DELETE /echo</pre>"));
    }

    #[tokio::test]
    async fn answers_the_500_page_for_an_error_that_escapes_a_handler() {
        let response = call(echo_router(), "GET", "/fails", None).await;
        assert_eq!(response.status, 500);
        assert!(response.text().contains("<pre>Internal Server Error</pre>"));
    }

    #[tokio::test]
    async fn routes_a_trailing_slash_as_the_path_without_it() {
        let response = call(echo_router(), "GET", "/query/?a=1", None).await;
        assert_eq!(response.status, 200);
        assert_eq!(response.json(), json!({ "a": "1" }));
    }

    #[test]
    fn parses_a_query_as_node_querystring_does() {
        let query = QueryParams::parse("a=1&b=x+y&a=2&c&&d=%41%zz&e=%E2%82%AC&f=a=b&a=3");
        assert_eq!(
            query.to_json(),
            json!({ "a": ["1", "2", "3"], "b": "x y", "c": "", "d": "A%zz", "e": "€", "f": "a=b" })
        );
        assert_eq!(query.str("a"), None);
        assert_eq!(query.text("a").as_deref(), Some("1,2,3"));
        assert_eq!(query.str("b"), Some("x y"));
        assert_eq!(QueryParams::parse("").0.len(), 0);
        assert_eq!(QueryParams::parse("=x").str(""), Some("x"));
        assert_eq!(QueryParams::parse("bad=%FF").str("bad"), Some("\u{fffd}"));
    }

    #[test]
    fn encodes_and_escapes_the_path_of_a_404() {
        assert_eq!(encode_url("/a b/%41/%zz"), "/a%20b/%41/%25zz");
        assert_eq!(
            escape_html("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
    }
}
