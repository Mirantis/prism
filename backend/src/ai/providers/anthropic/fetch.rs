//! The HTTP side of a provider call (`@ai-sdk/provider-utils`): the `fetch` a
//! provider sends through, `postJsonToApi`, and Anthropic's error response handler.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ai::errors::SharedError;
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::json::{js_stringify, secure_json_parse};
use crate::ai::{AbortError, ApiCallError, Headers};

/// The `@ai-sdk/provider-utils` version the request's `user-agent` names.
pub const PROVIDER_UTILS_VERSION: &str = "5.0.58";

/// How long Node's `fetch` waits for response headers, and between two body
/// chunks, before it fails the request.
const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// How long Node's `fetch` (undici) waits for a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// One HTTP request a provider sends: always a `POST` of a JSON text.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    pub headers: Headers,
    pub body: String,
}

/// The response to a `FetchRequest`. Header names are lowercase.
#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Headers,
    pub body: Bytes,
}

impl FetchResponse {
    /// `response.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// A provider's `fetch`: sends the request, or fails with an `ApiCallError` for a
/// network failure and an `AbortError` when the call is cancelled. A wrapper can
/// sign or rewrite the request and pass it on to `default_fetch()`.
pub type FetchFunction = Arc<
    dyn Fn(
            FetchRequest,
            Option<CancellationToken>,
        ) -> BoxFuture<'static, anyhow::Result<FetchResponse>>
        + Send
        + Sync,
>;

/// Node's global `fetch` reads no proxy variables, so this client reads none. Like
/// undici, a connect fails after ten seconds rather than the OS's two minutes.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .expect("the provider HTTP client builds")
});

/// The `fetch` a provider uses when its settings name none.
pub fn default_fetch() -> FetchFunction {
    Arc::new(|request, abort_signal| Box::pin(send(request, abort_signal)))
}

async fn send(
    request: FetchRequest,
    abort_signal: Option<CancellationToken>,
) -> anyhow::Result<FetchResponse> {
    let FetchRequest { url, headers, body } = request;
    let mut builder = CLIENT.post(&url);
    for (name, value) in &headers {
        builder = builder.header(name, value);
    }
    let call = async {
        let response = builder
            .body(body)
            .send()
            .await
            .map_err(|err| network_error(err, &url))?;
        let status = response.status();
        let response_headers = response_headers(response.headers());
        let bytes = response
            .bytes()
            .await
            .map_err(|err| network_error(err, &url))?;
        Ok(FetchResponse {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
            headers: response_headers,
            body: bytes,
        })
    };
    match abort_signal {
        Some(token) => {
            if token.is_cancelled() {
                return Err(AbortError::operation().into());
            }
            tokio::select! {
                result = call => result,
                _ = token.cancelled() => Err(AbortError::operation().into()),
            }
        }
        None => call.await,
    }
}

/// `handleFetchError` for a request that never got an answer: the SDK retries it.
/// `post_json_to_api` fills in the request body values.
fn network_error(err: reqwest::Error, url: &str) -> anyhow::Error {
    let cause_text = if err.is_timeout() {
        "Headers Timeout Error".to_string()
    } else {
        innermost_message(&err)
    };
    let mut error = ApiCallError::new(
        format!("Cannot connect to API: {cause_text}"),
        url,
        Value::Null,
        None,
        None,
        None,
    );
    error.is_retryable = true;
    error.cause = Some(Arc::new(anyhow::Error::new(err)) as SharedError);
    error.into()
}

fn innermost_message(err: &(dyn std::error::Error + 'static)) -> String {
    let mut current = err;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

/// `Object.fromEntries(response.headers)`: lowercase names in sorted order, and
/// the values of a repeated header joined with `, `.
fn response_headers(headers: &reqwest::header::HeaderMap) -> Headers {
    let mut sorted: std::collections::BTreeMap<String, String> = Default::default();
    for (name, value) in headers {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        sorted
            .entry(name.as_str().to_string())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }
    sorted.into_iter().collect()
}

/// A successful JSON response: its headers and the parsed body.
#[derive(Debug, Clone)]
pub(super) struct JsonResponse {
    pub headers: Headers,
    pub value: Value,
    pub status: u16,
    pub text: String,
}

/// `postJsonToApi` with `createJsonResponseHandler`'s JSON parse: the body is sent
/// as `JSON.stringify` writes it, a non-2xx answer becomes the `ApiCallError`
/// Anthropic's error handler builds, and a body that is not JSON fails with
/// `Invalid JSON response`. Validating the parsed value is the caller's step.
pub(super) async fn post_json_to_api(
    url: &str,
    headers: Headers,
    body: &Value,
    fetch: Option<&FetchFunction>,
    abort_signal: Option<CancellationToken>,
) -> anyhow::Result<JsonResponse> {
    let mut combined: Headers = IndexMap::new();
    combined.insert("Content-Type".to_string(), "application/json".to_string());
    combined.extend(headers);
    let headers = with_user_agent_suffix(
        Some(&combined),
        &format!("ai-sdk-provider-utils/{PROVIDER_UTILS_VERSION}"),
    );
    let request = FetchRequest {
        url: url.to_string(),
        headers,
        body: js_stringify(body),
    };
    let sent = match fetch {
        Some(fetch) => fetch(request, abort_signal).await,
        None => send(request, abort_signal).await,
    };
    let response = match sent {
        Ok(response) => response,
        Err(mut err) => {
            if let Some(error) = err.downcast_mut::<ApiCallError>()
                && error.request_body_values.is_null()
            {
                error.request_body_values = body.clone();
            }
            return Err(err);
        }
    };
    let text = String::from_utf8_lossy(&response.body).into_owned();
    if !response.ok() {
        return Err(anthropic_failed_response(&response, &text, url, body).into());
    }
    match secure_json_parse(&text) {
        Ok(value) => Ok(JsonResponse {
            headers: response.headers,
            value,
            status: response.status,
            text,
        }),
        Err(cause) => {
            let mut error = ApiCallError::new(
                "Invalid JSON response",
                url,
                body.clone(),
                Some(response.status),
                Some(response.headers),
                Some(text.clone()),
            );
            let cause = crate::ai::JsonParseError::new(text, anyhow::Error::new(cause));
            error.cause = Some(Arc::new(anyhow::Error::new(cause)));
            Err(error.into())
        }
    }
}

/// `Invalid JSON response` for a body that parsed as JSON but is not the shape the
/// provider reads.
pub(super) fn invalid_response(
    response: &JsonResponse,
    url: &str,
    body: &Value,
    cause: anyhow::Error,
) -> anyhow::Error {
    let mut error = ApiCallError::new(
        "Invalid JSON response",
        url,
        body.clone(),
        Some(response.status),
        Some(response.headers.clone()),
        Some(response.text.clone()),
    );
    error.cause = Some(Arc::new(cause));
    error.into()
}

/// `anthropicFailedResponseHandler`: the error's message is the body's
/// `error.message` when the body is Anthropic's error shape, else the status text.
/// Retryability is the SDK default: 408, 409, 429 and every 5xx.
fn anthropic_failed_response(
    response: &FetchResponse,
    text: &str,
    url: &str,
    body: &Value,
) -> ApiCallError {
    let mut error = ApiCallError::new(
        response.status_text.clone(),
        url,
        body.clone(),
        Some(response.status),
        Some(response.headers.clone()),
        Some(text.to_string()),
    );
    if crate::support::js::trim(text).is_empty() {
        return error;
    }
    if let Some(data) = secure_json_parse(text).ok().and_then(anthropic_error_data) {
        error.message = data["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        error.data = Some(data);
    }
    error
}

/// `anthropicErrorDataSchema`: `{ type: 'error', error: { type, message } }`, with
/// other keys dropped.
fn anthropic_error_data(value: Value) -> Option<Value> {
    if value.get("type")?.as_str()? != "error" {
        return None;
    }
    let error = value.get("error")?;
    let kind = error.get("type")?.as_str()?;
    let message = error.get("message")?.as_str()?;
    Some(serde_json::json!({
        "type": "error",
        "error": { "type": kind, "message": message },
    }))
}
