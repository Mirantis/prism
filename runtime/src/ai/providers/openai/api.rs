//! The HTTP plumbing the OpenAI models share (`@ai-sdk/provider-utils`'s
//! `postJsonToApi`, its response handlers and settings loaders, and OpenAI's error
//! handler): one JSON POST through a `FetchFunction`, and the errors it turns into.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use rand::Rng;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::ai::errors::{AbortError, ApiCallError, InvalidArgumentError, LoadApiKeyError};
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::json::{js_stringify, secure_json_parse};
use crate::ai::provider::Headers;

/// One request as the SDK's `fetch` receives it: always a POST with a JSON body.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    pub headers: Headers,
    pub body: String,
}

/// A whole response: status, headers (lowercase names, sorted, as `Headers`
/// iterates them) and body.
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

    /// The body as text, as `TextDecoder` decodes it.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// The `fetch` a provider sends its requests through.
pub type FetchFunction =
    Arc<dyn Fn(FetchRequest) -> BoxFuture<'static, anyhow::Result<FetchResponse>> + Send + Sync>;

/// A request that never got a response, as undici reports it (`fetch failed` with
/// the socket error as its cause).
#[derive(Debug)]
pub struct FetchFailedError {
    pub message: String,
}

impl std::fmt::Display for FetchFailedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("fetch failed")
    }
}

impl std::error::Error for FetchFailedError {}

/// Node's global `fetch` ignores proxy settings, so this client does too. The
/// timeouts are undici's defaults: ten seconds to connect, and five minutes for the
/// response headers and between body reads.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(300))
        .build()
        .expect("HTTP client builds")
});

/// The innermost message of an error chain: undici's `cause.message`.
fn innermost_message(err: &(dyn std::error::Error + 'static)) -> String {
    let mut current = err;
    while let Some(source) = current.source() {
        current = source;
    }
    current.to_string()
}

/// The global `fetch`: a POST, the whole body read.
pub fn default_fetch() -> FetchFunction {
    Arc::new(|request: FetchRequest| {
        Box::pin(async move {
            let mut builder = HTTP.post(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            let response = builder
                .body(request.body)
                .send()
                .await
                .map_err(|e| FetchFailedError {
                    message: innermost_message(&e),
                })?;
            let status = response.status();
            let mut headers: Vec<(String, String)> = Vec::new();
            for (name, value) in response.headers() {
                let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
                let name = name.as_str().to_lowercase();
                match headers.iter_mut().find(|(n, _)| *n == name) {
                    Some((_, existing)) if name != "set-cookie" => {
                        existing.push_str(", ");
                        existing.push_str(&value);
                    }
                    _ => headers.push((name, value)),
                }
            }
            headers.sort_by(|a, b| a.0.cmp(&b.0));
            let body = response.bytes().await.map_err(|e| FetchFailedError {
                message: innermost_message(&e),
            })?;
            Ok(FetchResponse {
                status: status.as_u16(),
                status_text: status.canonical_reason().unwrap_or("").to_string(),
                headers: headers.into_iter().collect(),
                body,
            })
        })
    })
}

/// Reads an environment variable, as `process.env[name]`.
pub type EnvLookup = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The process environment.
pub fn process_env() -> EnvLookup {
    Arc::new(|name: &str| std::env::var(name).ok())
}

/// `loadApiKey`: the key, else the environment variable, else an error.
pub fn load_api_key(
    api_key: Option<&str>,
    environment_variable_name: &str,
    description: &str,
    env: &EnvLookup,
) -> Result<String, LoadApiKeyError> {
    if let Some(key) = api_key {
        return Ok(key.to_string());
    }
    env(environment_variable_name).ok_or_else(|| LoadApiKeyError {
        message: format!(
            "{description} API key is missing. Pass it using the 'apiKey' parameter or the {environment_variable_name} environment variable."
        ),
    })
}

/// `loadOptionalSetting`: the setting, else the environment variable.
pub fn load_optional_setting(
    setting_value: Option<&str>,
    environment_variable_name: &str,
    env: &EnvLookup,
) -> Option<String> {
    match setting_value {
        Some(value) => Some(value.to_string()),
        None => env(environment_variable_name),
    }
}

/// `validateBaseURL`: a base URL of only whitespace is refused.
pub fn validate_base_url(base_url: Option<String>) -> Result<Option<String>, InvalidArgumentError> {
    match base_url {
        Some(url) if url.trim().is_empty() => Err(InvalidArgumentError {
            message: "baseURL must be a non-empty string.".to_string(),
            parameter: "baseURL".to_string(),
            value: Value::Null,
        }),
        other => Ok(other),
    }
}

/// `withoutTrailingSlash`.
pub fn without_trailing_slash(url: &str) -> String {
    url.strip_suffix('/').unwrap_or(url).to_string()
}

/// `combineHeaders`: later headers replace earlier ones of the same name.
pub fn combine_headers(parts: &[Option<&Headers>]) -> Headers {
    let mut combined = Headers::new();
    for headers in parts.iter().flatten() {
        for (name, value) in headers.iter() {
            combined.insert(name.clone(), value.clone());
        }
    }
    combined
}

const ID_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// `generateId()`: 16 random alphanumeric characters.
pub fn generate_id() -> String {
    let mut rng = rand::rng();
    (0..16)
        .map(|_| ID_ALPHABET[rng.random_range(0..ID_ALPHABET.len())] as char)
        .collect()
}

/// `postJsonToApi` up to the response: the body as `JSON.stringify` writes it,
/// `Content-Type: application/json`, the user agent with the provider-utils
/// version, and the call's cancellation. A request that never got a response is
/// the `ApiCallError` `handleFetchError` makes of it; any other error from `fetch`
/// passes through.
pub async fn post_json(
    url: &str,
    headers: &Headers,
    body: &Value,
    abort_signal: Option<&CancellationToken>,
    fetch: &FetchFunction,
    provider_utils_version: &str,
) -> anyhow::Result<FetchResponse> {
    let mut request_headers = Headers::new();
    request_headers.insert("Content-Type".to_string(), "application/json".to_string());
    for (name, value) in headers {
        request_headers.insert(name.clone(), value.clone());
    }
    let request_headers = with_user_agent_suffix(
        Some(&request_headers),
        &format!("ai-sdk-provider-utils/{provider_utils_version}"),
    );
    let request = FetchRequest {
        url: url.to_string(),
        headers: request_headers,
        body: js_stringify(body),
    };
    if abort_signal.is_some_and(|s| s.is_cancelled()) {
        return Err(AbortError::operation().into());
    }
    let call = fetch(request);
    let result = match abort_signal {
        Some(signal) => tokio::select! {
            result = call => result,
            _ = signal.cancelled() => return Err(AbortError::operation().into()),
        },
        None => call.await,
    };
    result.map_err(|err| handle_fetch_error(err, url, body))
}

/// `handleFetchError`: a request that never got a response is a retryable
/// `ApiCallError`.
fn handle_fetch_error(err: anyhow::Error, url: &str, body: &Value) -> anyhow::Error {
    let Some(failed) = err.downcast_ref::<FetchFailedError>() else {
        return err;
    };
    let mut error = ApiCallError::new(
        format!("Cannot connect to API: {}", failed.message),
        url,
        body.clone(),
        None,
        None,
        None,
    );
    error.is_retryable = true;
    error.cause = Some(Arc::new(err));
    error.into()
}

/// The parsed OpenAI error (`openaiErrorDataSchema`) as zod returns it: `error`
/// with `message`, then `type`, `param` and `code` where the body has them. `None`
/// when the body does not match the schema.
fn openai_error_data(value: &Value) -> Option<Value> {
    let error = value.get("error")?.as_object()?;
    let message = error.get("message")?.as_str()?;
    let mut parsed = Map::new();
    parsed.insert("message".to_string(), Value::String(message.to_string()));
    match error.get("type") {
        None => {}
        Some(value @ (Value::Null | Value::String(_))) => {
            parsed.insert("type".to_string(), value.clone());
        }
        Some(_) => return None,
    }
    if let Some(param) = error.get("param") {
        parsed.insert("param".to_string(), param.clone());
    }
    match error.get("code") {
        None => {}
        Some(value @ (Value::Null | Value::String(_) | Value::Number(_))) => {
            parsed.insert("code".to_string(), value.clone());
        }
        Some(_) => return None,
    }
    let mut data = Map::new();
    data.insert("error".to_string(), Value::Object(parsed));
    Some(Value::Object(data))
}

/// `openaiFailedResponseHandler`: an empty body gives the status text, a body that
/// is not OpenAI's error schema gives the status text, else the error's message.
pub fn openai_failed_response_error(
    response: &FetchResponse,
    url: &str,
    request_body: &Value,
) -> anyhow::Error {
    let response_body = response.text();
    let mut error = ApiCallError::new(
        response.status_text.clone(),
        url,
        request_body.clone(),
        Some(response.status),
        Some(response.headers.clone()),
        Some(response_body.clone()),
    );
    if crate::support::js::trim(&response_body).is_empty() {
        return error.into();
    }
    if let Some(data) = secure_json_parse(&response_body)
        .ok()
        .and_then(|value| openai_error_data(&value))
    {
        if let Some(message) = data["error"]["message"].as_str() {
            error.message = message.to_string();
        }
        error.data = Some(data);
    }
    error.into()
}

/// `createJsonResponseHandler` up to the schema: the parsed body, else `Invalid
/// JSON response`.
pub fn parse_json_body(
    response: &FetchResponse,
    url: &str,
    request_body: &Value,
) -> anyhow::Result<Value> {
    let response_body = response.text();
    secure_json_parse(&response_body).map_err(|cause| {
        invalid_json_response(response, url, request_body, anyhow::Error::new(cause))
    })
}

/// The `ApiCallError` a response that does not match its schema gives.
pub fn invalid_json_response(
    response: &FetchResponse,
    url: &str,
    request_body: &Value,
    cause: anyhow::Error,
) -> anyhow::Error {
    let mut error = ApiCallError::new(
        "Invalid JSON response",
        url,
        request_body.clone(),
        Some(response.status),
        Some(response.headers.clone()),
        Some(response.text()),
    );
    error.cause = Some(Arc::new(cause));
    error.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(status: u16, status_text: &str, body: &str) -> FetchResponse {
        FetchResponse {
            status,
            status_text: status_text.to_string(),
            headers: [("content-type".to_string(), "application/json".to_string())]
                .into_iter()
                .collect(),
            body: Bytes::from(body.to_string()),
        }
    }

    #[test]
    fn an_error_body_of_openai_shape_gives_its_message_and_data() {
        let body = r#"{"error":{"code":"x","message":"Bad.","extra":1}}"#;
        let err = openai_failed_response_error(&response(400, "Bad Request", body), "u", &json!({}));
        let err = err.downcast_ref::<ApiCallError>().unwrap();
        assert_eq!(err.message, "Bad.");
        assert_eq!(
            js_stringify(err.data.as_ref().unwrap()),
            r#"{"error":{"message":"Bad.","code":"x"}}"#
        );
        assert!(!err.is_retryable);
    }

    #[test]
    fn an_error_body_of_another_shape_gives_the_status_text() {
        let err = openai_failed_response_error(
            &response(503, "Service Unavailable", r#"{"error":{"message":1}}"#),
            "u",
            &json!({}),
        );
        let err = err.downcast_ref::<ApiCallError>().unwrap();
        assert_eq!(err.message, "Service Unavailable");
        assert!(err.data.is_none());
        assert!(err.is_retryable);
    }

    #[test]
    fn a_missing_key_names_the_environment_variable() {
        let env: EnvLookup = Arc::new(|_| None);
        let err = load_api_key(None, "OPENAI_API_KEY", "OpenAI", &env).unwrap_err();
        assert_eq!(
            err.message,
            "OpenAI API key is missing. Pass it using the 'apiKey' parameter or the OPENAI_API_KEY environment variable."
        );
    }

    #[test]
    fn a_blank_base_url_is_refused() {
        let err = validate_base_url(Some(" ".to_string())).unwrap_err();
        assert_eq!(err.message, "baseURL must be a non-empty string.");
        assert_eq!(
            validate_base_url(None).unwrap(),
            None,
            "an unset base URL passes"
        );
    }

    #[tokio::test]
    async fn a_request_that_never_got_a_response_is_retryable() {
        let fetch: FetchFunction = Arc::new(|_| {
            Box::pin(async {
                Err(FetchFailedError {
                    message: "connect ECONNREFUSED 127.0.0.1:1".to_string(),
                }
                .into())
            })
        });
        let err = post_json("http://x/v1", &Headers::new(), &json!({}), None, &fetch, "5.0.65")
            .await
            .unwrap_err();
        let err = err.downcast_ref::<ApiCallError>().unwrap();
        assert_eq!(err.message, "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:1");
        assert!(err.is_retryable);
    }

    #[tokio::test]
    async fn a_cancelled_call_is_an_abort() {
        let token = CancellationToken::new();
        token.cancel();
        let fetch = default_fetch();
        let err = post_json("http://x/v1", &Headers::new(), &json!({}), Some(&token), &fetch, "5.0.65")
            .await
            .unwrap_err();
        assert!(crate::ai::is_abort_error(&err));
    }
}
