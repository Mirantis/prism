//! The HTTP plumbing the Bedrock models share (`@ai-sdk/provider-utils`'s
//! `postJsonToApi`, its response handlers and settings loaders, and the Bedrock base
//! URL): one JSON POST through a `FetchFunction`, and the errors it turns into.

use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use regex::Regex;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ai::errors::{AbortError, ApiCallError, InvalidArgumentError, LoadSettingError};
use crate::ai::generate_text::with_user_agent_suffix;
use crate::ai::json::{js_stringify, secure_json_parse};
use crate::ai::provider::Headers;

/// The `@ai-sdk/provider-utils` version `postJsonToApi` names in the user agent.
pub const PROVIDER_UTILS_VERSION: &str = "5.0.58";

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

/// A request that never reached the server, as undici reports it (`fetch failed`
/// with the socket error as its cause).
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

/// Node's global `fetch` ignores proxy settings, so this client does too.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
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

/// The global `fetch`: a POST over HTTPS, the whole body read.
pub fn default_fetch() -> FetchFunction {
    Arc::new(|request: FetchRequest| {
        Box::pin(async move {
            let mut builder = HTTP.post(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            let response =
                builder
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

/// `loadSetting`: the setting, else the environment variable, else an error.
pub fn load_setting(
    setting_value: Option<&str>,
    environment_variable_name: &str,
    setting_name: &str,
    description: &str,
    env: &EnvLookup,
) -> Result<String, LoadSettingError> {
    if let Some(value) = setting_value {
        return Ok(value.to_string());
    }
    env(environment_variable_name).ok_or_else(|| LoadSettingError {
        message: format!(
            "{description} setting is missing. Pass it using the '{setting_name}' parameter or the {environment_variable_name} environment variable."
        ),
    })
}

/// `isValidHostnamePart`: 1–63 letters, digits or hyphens, no hyphen at either end.
fn is_valid_hostname_part(value: &str) -> bool {
    static PART: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").expect("valid regex")
    });
    PART.is_match(value)
}

/// `withoutTrailingSlash`.
pub fn without_trailing_slash(url: &str) -> String {
    url.strip_suffix('/').unwrap_or(url).to_string()
}

const AWS_PARTITION_DNS_SUFFIXES: &[(&str, &str)] = &[
    ("cn-", "amazonaws.com.cn"),
    ("us-iso-", "c2s.ic.gov"),
    ("us-isob-", "sc2s.sgov.gov"),
    ("eu-isoe-", "cloud.adc-e.uk"),
    ("us-isof-", "csp.hci.ic.gov"),
    ("eusc-", "amazonaws.eu"),
];

/// `resolveAmazonBedrockBaseURL` for `bedrock-runtime`: the setting, else
/// `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, else `AWS_ENDPOINT_URL`, else the region's
/// host in its partition.
pub fn resolve_bedrock_runtime_base_url(
    base_url: Option<&str>,
    region: Option<&str>,
    env: &EnvLookup,
) -> anyhow::Result<String> {
    let resolved = base_url
        .map(str::to_string)
        .or_else(|| env("AWS_ENDPOINT_URL_BEDROCK_RUNTIME"))
        .or_else(|| env("AWS_ENDPOINT_URL"));
    if let Some(url) = resolved {
        return Ok(without_trailing_slash(&url));
    }
    let region = load_setting(region, "AWS_REGION", "region", "AWS region", env)?;
    if !is_valid_hostname_part(&region) {
        return Err(InvalidArgumentError {
            message: "Invalid AWS region. Expected a single DNS label (letters, digits, and hyphens). Use `baseURL` for custom endpoints.".to_string(),
            parameter: "region".to_string(),
            value: Value::Null,
        }
        .into());
    }
    let dns_suffix = AWS_PARTITION_DNS_SUFFIXES
        .iter()
        .find(|(prefix, _)| region.starts_with(prefix))
        .map(|(_, suffix)| *suffix)
        .unwrap_or("amazonaws.com");
    Ok(without_trailing_slash(&format!(
        "https://bedrock-runtime.{region}.{dns_suffix}"
    )))
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

/// `encodeURIComponent`.
pub fn encode_uri_component(text: &str) -> String {
    const COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(text, COMPONENT).to_string()
}

/// `postJsonToApi` up to the response: the body as `JSON.stringify` writes it,
/// `Content-Type: application/json`, the user agent, and the call's cancellation.
/// A request that never got a response is the `ApiCallError` `handleFetchError`
/// makes of it; any other error from `fetch` passes through.
pub async fn post_json(
    url: &str,
    headers: &Headers,
    body: &Value,
    abort_signal: Option<&CancellationToken>,
    fetch: &FetchFunction,
) -> anyhow::Result<FetchResponse> {
    let mut request_headers = Headers::new();
    request_headers.insert("Content-Type".to_string(), "application/json".to_string());
    for (name, value) in headers {
        request_headers.insert(name.clone(), value.clone());
    }
    let request_headers = with_user_agent_suffix(
        Some(&request_headers),
        &format!("ai-sdk-provider-utils/{PROVIDER_UTILS_VERSION}"),
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

/// `handleFetchError`: a request that never reached the server is a retryable
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

/// The `{ message, type? }` body Bedrock answers an error with.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BedrockErrorBody {
    pub message: String,
    #[serde(default, rename = "type")]
    pub error_type: Option<String>,
}

/// `createJsonErrorResponseHandler` with Bedrock's error schema: an empty body
/// gives the status text, a body that is not the schema gives the status text,
/// else `error_to_message` of the parsed error.
pub fn failed_response_error(
    response: &FetchResponse,
    url: &str,
    request_body: &Value,
    error_to_message: fn(&BedrockErrorBody) -> String,
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
    if let Ok(value) = secure_json_parse(&response_body)
        && let Ok(parsed) = serde_json::from_value::<BedrockErrorBody>(value.clone())
    {
        error.message = error_to_message(&parsed);
        error.data = Some(error_data(&value));
    }
    error.into()
}

/// The parsed error as zod returns it: `message`, then `type` when present.
fn error_data(value: &Value) -> Value {
    let mut data = serde_json::Map::new();
    if let Some(message) = value.get("message") {
        data.insert("message".to_string(), message.clone());
    }
    if let Some(error_type) = value.get("type") {
        data.insert("type".to_string(), error_type.clone());
    }
    Value::Object(data)
}

/// `createJsonResponseHandler`: the body parsed into `T`, else `Invalid JSON
/// response`. Returns the value and the raw JSON.
pub fn parse_json_response<T: DeserializeOwned>(
    response: &FetchResponse,
    url: &str,
    request_body: &Value,
) -> anyhow::Result<(T, Value)> {
    let response_body = response.text();
    let parsed = secure_json_parse(&response_body)
        .map_err(anyhow::Error::new)
        .and_then(|raw| {
            serde_json::from_value::<T>(raw.clone())
                .map(|value| (value, raw))
                .map_err(anyhow::Error::new)
        });
    parsed.map_err(|cause| {
        let mut error = ApiCallError::new(
            "Invalid JSON response",
            url,
            request_body.clone(),
            Some(response.status),
            Some(response.headers.clone()),
            Some(response_body),
        );
        error.cause = Some(Arc::new(cause));
        error.into()
    })
}

/// Headers with every name lowercased (`normalizeHeaders`).
pub fn normalize_headers(headers: &Headers) -> Headers {
    let mut out = IndexMap::new();
    for (name, value) in headers {
        out.insert(name.to_lowercase(), value.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> EnvLookup {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Arc::new(move |name: &str| map.get(name).cloned())
    }

    #[test]
    fn derives_the_runtime_host_from_the_region() {
        let none = env(&[]);
        assert_eq!(
            resolve_bedrock_runtime_base_url(None, Some("us-west-2"), &none).unwrap(),
            "https://bedrock-runtime.us-west-2.amazonaws.com"
        );
        assert_eq!(
            resolve_bedrock_runtime_base_url(None, Some("cn-north-1"), &none).unwrap(),
            "https://bedrock-runtime.cn-north-1.amazonaws.com.cn"
        );
    }

    #[test]
    fn prefers_the_setting_then_the_endpoint_variables() {
        let vars = env(&[
            ("AWS_ENDPOINT_URL", "https://generic.example/"),
            (
                "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
                "https://runtime.example/",
            ),
        ]);
        assert_eq!(
            resolve_bedrock_runtime_base_url(
                Some("https://gw.example/llm/bedrock/us-east-1/"),
                None,
                &vars
            )
            .unwrap(),
            "https://gw.example/llm/bedrock/us-east-1"
        );
        assert_eq!(
            resolve_bedrock_runtime_base_url(None, None, &vars).unwrap(),
            "https://runtime.example"
        );
        let generic = env(&[("AWS_ENDPOINT_URL", "https://generic.example/")]);
        assert_eq!(
            resolve_bedrock_runtime_base_url(None, None, &generic).unwrap(),
            "https://generic.example"
        );
    }

    #[test]
    fn refuses_a_region_that_is_not_a_hostname_part() {
        let err = resolve_bedrock_runtime_base_url(None, Some("evil.example.com/#"), &env(&[]))
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Invalid AWS region. Expected a single DNS label (letters, digits, and hyphens). Use `baseURL` for custom endpoints."
        );
    }

    #[test]
    fn reports_a_missing_region() {
        let err = resolve_bedrock_runtime_base_url(None, None, &env(&[])).unwrap_err();
        assert_eq!(
            err.to_string(),
            "AWS region setting is missing. Pass it using the 'region' parameter or the AWS_REGION environment variable."
        );
    }

    #[test]
    fn encodes_a_uri_component_as_javascript_does() {
        assert_eq!(
            encode_uri_component("arn:aws:bedrock:us-east-1:1:inference-profile/us.x-y_z!~*'()"),
            "arn%3Aaws%3Abedrock%3Aus-east-1%3A1%3Ainference-profile%2Fus.x-y_z!~*'()"
        );
    }
}
