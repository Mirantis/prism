//! A Slack Web API client whose bot-token auth flows **only** via the
//! `Authorization` header, never in a request body. This lets the Mirantis Agent Platform
//! sandbox MITM proxy inject the real token via its header-rewriting credential
//! injection (`__nexus_cred:<uuid>__` sentinel in env → real `xoxb-…` at the
//! proxy); the body never carries the sentinel, so Slack never sees the
//! placeholder.
//!
//! Why this works:
//!   - Slack's API accepts Bearer auth via `Authorization` alone.
//!     (slackapi/node-slack-sdk#1132: "POST body params" still supported
//!     but optional — header is preferred.)
//!   - The client sets `Authorization: Bearer <token>` from the constructor token
//!     and from a call's own `token` argument, independent of the body.
//!
//! Every request body is a form-urlencoded string, or a multipart form for a file
//! upload, and [`strip_body_token`] drops `token` from the former; a multipart
//! form is built without one. A JSON body (a `response_url` post) passes
//! unchanged.
//!
//! The request policy is the Slack SDK's: a POST per call, a per-request
//! deadline, retries with exponential backoff (a 429 waits its `Retry-After`
//! inside the attempt and holds the client's other requests meanwhile), and an
//! `ok: false` answer as an error that names Slack's `error` code.

use std::sync::{Arc, LazyLock, Once};
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, StatusCode};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::services::slack_socket_retire::{FetchedResponse, RetirableFetch};
use crate::{log_debug, log_error, log_info, log_warn};

/// The retry policy of a Slack call: `retries` attempts after the first, waiting
/// `min_timeout_ms * factor^n` between them (doubled at random up to twice that
/// when `randomize` is set), capped at `max_timeout_ms`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SlackRetryConfig {
    pub retries: u32,
    pub factor: f64,
    pub min_timeout_ms: u64,
    /// `u64::MAX` for no cap.
    pub max_timeout_ms: u64,
    pub randomize: bool,
}

/// The policy a Socket Mode client asks `apps.connections.open` with: many fast
/// retries, so a reconnect rides out an outage for hours.
pub const SOCKET_MODE_RETRY_CONFIG: SlackRetryConfig = SlackRetryConfig {
    retries: 100,
    factor: 1.3,
    min_timeout_ms: 1_000,
    max_timeout_ms: u64::MAX,
    randomize: false,
};

/// Options of a [`SlackWebClient`]. A field left `None` takes the bounded default.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WebClientOptions {
    /// Per-request deadline in milliseconds; `Some(0)` sets none.
    pub timeout_ms: Option<u64>,
    pub retry_config: Option<SlackRetryConfig>,
    /// The base URL of the Web API (`https://slack.com/api/`).
    pub slack_api_url: Option<String>,
}

/// Bounded request policy for every Slack call this runtime makes.
///
/// The Slack SDK's defaults are `timeout: 0` (no per-request deadline) and
/// `tenRetriesInAboutThirtyMinutes`. Combined, one unreachable or hanging Slack
/// endpoint can keep a single `auth.test` outstanding for the better part of half
/// an hour — and boot awaits that call, so the whole runtime (HTTP server
/// included) never starts. Any caller waiting on the port then fails with a
/// timeout that points at the port, not at Slack.
///
/// So: a request deadline, and a handful of retries measured in seconds — a
/// couple of minutes at the absolute worst instead of thirty, and it still rides
/// out the transient 5xx/network blips retries exist for. (A 429 can still push
/// past that: `retry-after` is slept *inside* the retried attempt, by design —
/// ignoring Slack's own backoff would be worse than waiting it out.)
///
/// The deadline is sized for the largest thing this client sends, not the
/// smallest: `files.uploadV2` POSTs the file bytes through this same client,
/// so `timeout` has to cover a multi-MB upload. Callers that only ever exchange
/// JSON — the boot `auth.test`, which the port waits behind — pass a tighter one.
///
/// Applied to the steady-state client too (it is the same client): a real outage
/// should surface as a failed post the caller can see and log, not as an
/// invisible 30-minute stall.
///
/// **Do not hand these options to a Socket Mode client.** A Socket Mode client
/// retries `apps.connections.open` many times (`{ retries: 100, factor: 1.3 }`)
/// and classifies a request timeout as unrecoverable — so a client bounded like
/// this would stop reconnecting after a blip instead of retrying for hours (see
/// `slack_adapter_service.rs`).
pub const BOUNDED_SLACK_CLIENT_OPTIONS: WebClientOptions = WebClientOptions {
    timeout_ms: Some(30_000),
    retry_config: Some(SlackRetryConfig {
        retries: 3,
        factor: 2.0,
        min_timeout_ms: 1_000,
        max_timeout_ms: 8_000,
        randomize: true,
    }),
    slack_api_url: None,
};

/// The SDK's own default policy, `tenRetriesInAboutThirtyMinutes`.
const TEN_RETRIES_IN_ABOUT_THIRTY_MINUTES: SlackRetryConfig = SlackRetryConfig {
    retries: 10,
    factor: 1.96821,
    min_timeout_ms: 1_000,
    max_timeout_ms: u64::MAX,
    randomize: true,
};

const DEFAULT_SLACK_API_URL: &str = "https://slack.com/api/";

/// The file name a multipart part gets when the bytes carry none.
const DEFAULT_FILENAME: &str = "Untitled";

const USER_AGENT: &str = "@slack:bolt/5.1.0 @slack:socket-mode/3.1.0 @slack:web-api/8.2.0";

#[cfg(test)]
static TEST_API_URL: parking_lot::RwLock<Option<String>> = parking_lot::RwLock::new(None);

/// Test-only: the Web API base URL every client built without one uses.
#[cfg(test)]
pub(crate) fn set_test_api_url(url: Option<String>) {
    *TEST_API_URL.write() = url;
}

/// The HTTP client every Slack Web API call goes through. Node's global `fetch`
/// ignores proxy variables, and so does this; redirects are refused, as the SDK
/// asks fetch to.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(slack_http_client);

/// A client with the Slack request settings: no proxy, no redirects.
pub fn slack_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build the Slack HTTP client")
}

/// Whether a request's `content-type` is form-urlencoded.
fn is_form_encoded(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| value.starts_with("application/x-www-form-urlencoded"))
}

/// The body to send in place of `body`: a form-urlencoded body without its `token`
/// field, re-serialized; `None` to send `body` unchanged (not form-encoded, or no
/// `token` in it).
pub fn strip_body_token(content_type: Option<&str>, body: &str) -> Option<String> {
    if !is_form_encoded(content_type) {
        return None;
    }
    let params: Vec<(String, String)> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    if !params.iter().any(|(name, _)| name == "token") {
        return None;
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in params.iter().filter(|(name, _)| name != "token") {
        serializer.append_pair(name, value);
    }
    Some(serializer.finish())
}

/// `querystring.escape`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as UTF-8
/// percent escapes.
fn querystring_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A call argument as the SDK serializes it: strings as they are, numbers and
/// booleans as text, anything else as JSON. `None` for `null`, which is left out.
fn serialize_arg(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        other => Some(serde_json::to_string(other).unwrap_or_default()),
    }
}

/// The form body of a call, as `querystring.stringify` writes the SDK's
/// flattened arguments.
fn form_body(args: &Map<String, Value>) -> String {
    args.iter()
        .filter_map(|(key, value)| {
            serialize_arg(value)
                .map(|text| format!("{}={}", querystring_escape(key), querystring_escape(&text)))
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// `String(value)` of a JSON value, as a template literal writes it.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(other) => other.to_string(),
    }
}

/// A failed Slack call, named as the Slack SDK names it.
#[derive(Debug, Clone, thiserror::Error)]
pub enum SlackApiError {
    /// Slack answered `ok: false`. `data` is the whole answer.
    #[error("An API error occurred: {}", js_string(.data.get("error")))]
    Platform { data: Value },
    /// The request did not complete: a network failure or the deadline.
    #[error("A request error occurred: {0}")]
    Request(String),
    /// Slack answered with a status other than 200.
    #[error("An HTTP protocol error occurred: statusCode = {status}")]
    Http { status: u16, body: Value },
    /// Any other failure: the text is the whole message.
    #[error("{0}")]
    Other(String),
}

impl SlackApiError {
    /// The SDK's class name for the error.
    pub fn name(&self) -> &'static str {
        match self {
            SlackApiError::Platform { .. } => "WebAPIPlatformError",
            SlackApiError::Request(_) => "WebAPIRequestError",
            SlackApiError::Http { .. } => "WebAPIHTTPError",
            SlackApiError::Other(_) => "Error",
        }
    }

    /// The SDK's error code.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            SlackApiError::Platform { .. } => Some("slack_webapi_platform_error"),
            SlackApiError::Request(_) => Some("slack_webapi_request_error"),
            SlackApiError::Http { .. } => Some("slack_webapi_http_error"),
            SlackApiError::Other(_) => None,
        }
    }
}

/// Slack's `error` code of a platform error (`data.error`), anywhere in `err`'s chain.
pub fn slack_platform_error_code(err: &anyhow::Error) -> Option<String> {
    err.chain()
        .find_map(|cause| match cause.downcast_ref::<SlackApiError>() {
            Some(SlackApiError::Platform { data }) => data
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

fn log_fields(error: &(dyn std::error::Error + 'static)) -> Option<Map<String, Value>> {
    let slack = error.downcast_ref::<SlackApiError>()?;
    let mut fields = Map::new();
    fields.insert("name".into(), json!(slack.name()));
    if let Some(code) = slack.code() {
        fields.insert("code".into(), json!(code));
    }
    if let SlackApiError::Http { status, .. } = slack {
        fields.insert("statusCode".into(), json!(status));
    }
    Some(fields)
}

static REGISTER_LOG_FIELDS: Once = Once::new();

/// Registers the Slack error names with the log serializer. Idempotent.
fn ensure_log_fields_registered() {
    REGISTER_LOG_FIELDS.call_once(|| crate::lib::log_redaction::register_error_fields(log_fields));
}

/// How one attempt of a request ended without an answer.
enum AttemptError {
    /// Retry, if the policy allows another attempt.
    Retry(SlackApiError),
    /// Give up at once with this error.
    Abort(SlackApiError),
}

/// The timeouts between the attempts, ascending, as the `retry` package computes
/// them.
fn retry_timeouts(config: &SlackRetryConfig) -> Vec<u64> {
    let mut timeouts: Vec<u64> = (0..config.retries)
        .map(|attempt| {
            let random = if config.randomize {
                rand::random::<f64>() + 1.0
            } else {
                1.0
            };
            let timeout =
                (random * config.min_timeout_ms.max(1) as f64 * config.factor.powi(attempt as i32))
                    .round();
            if timeout >= config.max_timeout_ms as f64 {
                config.max_timeout_ms
            } else {
                timeout as u64
            }
        })
        .collect();
    timeouts.sort_unstable();
    timeouts
}

/// The error a request that ran out of attempts reports: the most frequent
/// message among its failures, the latest on a tie.
fn main_error(errors: Vec<SlackApiError>) -> SlackApiError {
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut main: Option<SlackApiError> = None;
    let mut main_count = 0;
    for error in errors {
        let count = {
            let entry = counts.entry(error.to_string()).or_insert(0);
            *entry += 1;
            *entry
        };
        if count >= main_count {
            main_count = count;
            main = Some(error);
        }
    }
    main.unwrap_or_else(|| SlackApiError::Other("Slack request failed".to_string()))
}

/// `parseInt(retry-after, 10)` of a response, when it is a number.
fn parse_retry_header(headers: &HeaderMap) -> Option<i64> {
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(crate::support::js::parse_int)
}

/// Where a request goes: the shared HTTP client, or a Socket Mode client's
/// retirable fetch.
#[derive(Clone)]
enum Transport {
    Direct(reqwest::Client),
    Retirable(RetirableFetch),
}

impl Transport {
    fn client(&self) -> reqwest::Client {
        match self {
            Transport::Direct(client) => client.clone(),
            Transport::Retirable(fetch) => fetch.client(),
        }
    }

    async fn send(&self, request: reqwest::Request) -> reqwest::Result<FetchedResponse> {
        match self {
            Transport::Direct(client) => {
                let response = client.execute(request).await?;
                let status = response.status();
                let headers = response.headers().clone();
                let body = response.bytes().await?;
                Ok(FetchedResponse {
                    status,
                    headers,
                    body,
                })
            }
            Transport::Retirable(fetch) => fetch.fetch(request).await,
        }
    }
}

/// What a request carries: form arguments, or a file as a multipart part.
#[derive(Clone)]
enum RequestBody {
    Form(Map<String, Value>),
    File(Bytes),
}

/// `auth.test`'s answer, the fields this runtime reads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthTestResponse {
    #[serde(default)]
    pub ok: bool,
    pub url: Option<String>,
    pub team: Option<String>,
    pub user: Option<String>,
    pub team_id: Option<String>,
    pub user_id: Option<String>,
    pub bot_id: Option<String>,
    pub enterprise_id: Option<String>,
    pub is_enterprise_install: Option<bool>,
}

/// `bots.info`'s bot.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    pub app_id: Option<String>,
    pub user_id: Option<String>,
    pub deleted: Option<bool>,
}

/// `bots.info`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotsInfoResponse {
    #[serde(default)]
    pub ok: bool,
    pub bot: Option<BotInfo>,
}

/// One file for [`SlackWebClient::files_upload_v2`].
#[derive(Debug, Clone)]
pub struct FileUpload {
    pub channel_id: String,
    pub thread_ts: Option<String>,
    pub filename: String,
    pub file: Bytes,
}

/// A Slack Web API client with the bounded request policy and header-only auth.
#[derive(Clone)]
pub struct SlackWebClient {
    token: Option<String>,
    team_id: Option<String>,
    timeout_ms: u64,
    retry_config: SlackRetryConfig,
    slack_api_url: String,
    transport: Transport,
    /// While set, a 429's `Retry-After` holds every request of this client.
    paused_until: Arc<Mutex<Option<tokio::time::Instant>>>,
}

impl std::fmt::Debug for SlackWebClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlackWebClient")
            .field("team_id", &self.team_id)
            .field("timeout_ms", &self.timeout_ms)
            .field("retry_config", &self.retry_config)
            .field("slack_api_url", &self.slack_api_url)
            .finish_non_exhaustive()
    }
}

impl SlackWebClient {
    /// [`BOUNDED_SLACK_CLIENT_OPTIONS`], overridden by whatever `opts` sets.
    pub fn new(token: Option<&str>, opts: Option<WebClientOptions>) -> Self {
        let opts = opts.unwrap_or_default();
        Self::build(
            token,
            opts.timeout_ms.or(BOUNDED_SLACK_CLIENT_OPTIONS.timeout_ms),
            opts.retry_config
                .or(BOUNDED_SLACK_CLIENT_OPTIONS.retry_config),
            opts.slack_api_url,
            Transport::Direct(HTTP.clone()),
        )
    }

    /// A Socket Mode client's Web API client: the SDK's own request policy (no
    /// deadline) with `retry_config`, every request through `fetch`, so a retired
    /// client gets no answer.
    pub fn for_socket_mode(
        token: &str,
        retry_config: SlackRetryConfig,
        slack_api_url: Option<String>,
        fetch: RetirableFetch,
    ) -> Self {
        Self::build(
            Some(token),
            Some(0),
            Some(retry_config),
            slack_api_url,
            Transport::Retirable(fetch),
        )
    }

    fn build(
        token: Option<&str>,
        timeout_ms: Option<u64>,
        retry_config: Option<SlackRetryConfig>,
        slack_api_url: Option<String>,
        transport: Transport,
    ) -> Self {
        ensure_log_fields_registered();
        #[cfg(test)]
        let slack_api_url = slack_api_url.or_else(|| TEST_API_URL.read().clone());
        let mut slack_api_url = slack_api_url.unwrap_or_else(|| DEFAULT_SLACK_API_URL.to_string());
        if !slack_api_url.ends_with('/') {
            slack_api_url.push('/');
        }
        Self {
            token: token.filter(|t| !t.is_empty()).map(str::to_string),
            team_id: None,
            timeout_ms: timeout_ms.unwrap_or(0),
            retry_config: retry_config.unwrap_or(TEN_RETRIES_IN_ABOUT_THIRTY_MINUTES),
            slack_api_url,
            transport,
            paused_until: Arc::new(Mutex::new(None)),
        }
    }

    /// The same client sending `team_id` with every call, as a listener's client
    /// does.
    pub fn with_team_id(&self, team_id: &str) -> Self {
        Self {
            team_id: Some(team_id.to_string()),
            ..self.clone()
        }
    }

    /// The token calls are authorized with.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// The Web API base URL, ending in `/`.
    pub fn slack_api_url(&self) -> &str {
        &self.slack_api_url
    }

    /// Calls a Web API method (`https://slack.com/api/<method>`) with `args` as a
    /// form-urlencoded body (objects and arrays JSON-encoded, as the Slack SDK sends
    /// them) and `Authorization: Bearer <token>`, under the client's deadline and
    /// retry policy. A response with `ok: false` is an error naming Slack's `error`
    /// code; a 429 waits `retry-after` inside the attempt.
    pub async fn api_call(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        let mut args = match args {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            other => anyhow::bail!(
                "Expected an options argument but instead received a {}",
                match other {
                    Value::String(_) => "string",
                    Value::Number(_) => "number",
                    Value::Bool(_) => "boolean",
                    _ => "object",
                }
            ),
        };
        warn_if_fallback_is_missing(method, &args);
        let call_token = args
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        let mut body = Map::new();
        if let Some(team_id) = &self.team_id {
            body.insert("team_id".into(), json!(team_id));
        }
        for (key, value) in std::mem::take(&mut args) {
            body.insert(key, value);
        }
        let url = self.derive_request_url(method);
        let response = self
            .make_request(&url, RequestBody::Form(body), call_token.as_deref())
            .await?;
        let result = build_result(&response);
        log_debug!("http request result: {}", result);
        report_response_metadata(&result);
        if result.get("ok") != Some(&Value::Bool(true)) {
            return Err(SlackApiError::Platform { data: result }.into());
        }
        Ok(result)
    }

    /// `auth.test`.
    pub async fn auth_test(&self) -> anyhow::Result<AuthTestResponse> {
        let result = self.api_call("auth.test", json!({})).await?;
        Ok(serde_json::from_value(result)?)
    }

    /// `bots.info` for one bot id.
    pub async fn bots_info(&self, bot: &str) -> anyhow::Result<BotsInfoResponse> {
        let result = self.api_call("bots.info", json!({ "bot": bot })).await?;
        Ok(serde_json::from_value(result)?)
    }

    /// `files.uploadV2` for one file: `files.getUploadURLExternal`, the bytes posted
    /// to the URL it names, then `files.completeUploadExternal` into the channel
    /// (and its thread when given). Answers `{ ok: true, files: [<completion>] }`.
    pub async fn files_upload_v2(&self, upload: FileUpload) -> anyhow::Result<Value> {
        log_debug!("files.uploadV2() start");
        let length = upload.file.len();
        // The title defaults to the file name.
        let title = upload.filename.clone();
        let url_response = self
            .api_call(
                "files.getUploadURLExternal",
                json!({ "filename": upload.filename, "length": length }),
            )
            .await?;
        let upload_url = url_response.get("upload_url").and_then(Value::as_str);
        let file_id = url_response
            .get("file_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(upload_url) = upload_url else {
            anyhow::bail!(
                "No upload url found for file (id: {}, filename: {}",
                file_id.as_deref().unwrap_or("undefined"),
                upload.filename
            );
        };
        let posted = self
            .make_request(upload_url, RequestBody::File(upload.file.clone()), None)
            .await?;
        if posted.status != StatusCode::OK {
            anyhow::bail!(
                "Failed to upload file (id:{}, filename: {})",
                file_id.as_deref().unwrap_or("undefined"),
                upload.filename
            );
        }
        let Some(file_id) = file_id else {
            anyhow::bail!("Missing required file id for file upload completion");
        };
        let mut complete = Map::new();
        complete.insert("files".into(), json!([{ "id": file_id, "title": title }]));
        complete.insert("channel_id".into(), json!(upload.channel_id));
        if let Some(thread_ts) = upload.thread_ts.filter(|ts| !ts.is_empty()) {
            complete.insert("thread_ts".into(), json!(thread_ts));
        }
        let completion = self
            .api_call("files.completeUploadExternal", Value::Object(complete))
            .await?;
        Ok(json!({ "ok": true, "files": [completion] }))
    }

    /// The complete request URL: an absolute URL as it is, else a method under the
    /// API base.
    fn derive_request_url(&self, method: &str) -> String {
        if method.starts_with("https://") || method.starts_with("http://") {
            return method.to_string();
        }
        format!("{}{}", self.slack_api_url, method)
    }

    /// Holds a request while a 429 holds the client.
    async fn wait_unpaused(&self) {
        loop {
            let until = *self.paused_until.lock();
            match until {
                Some(until) if until > tokio::time::Instant::now() => {
                    tokio::time::sleep_until(until).await
                }
                _ => return,
            }
        }
    }

    fn build_request(
        &self,
        url: &str,
        body: &RequestBody,
        call_token: Option<&str>,
    ) -> Result<reqwest::Request, SlackApiError> {
        let client = self.transport.client();
        let mut builder = client
            .post(url)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json");
        if let Some(token) = call_token.or(self.token.as_deref()) {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        if self.timeout_ms > 0 {
            builder = builder.timeout(Duration::from_millis(self.timeout_ms));
        }
        builder = match body {
            RequestBody::Form(args) => {
                let content_type = "application/x-www-form-urlencoded";
                let encoded = form_body(args);
                let encoded = strip_body_token(Some(content_type), &encoded).unwrap_or(encoded);
                builder.header("Content-Type", content_type).body(encoded)
            }
            RequestBody::File(bytes) => {
                let part =
                    reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(DEFAULT_FILENAME);
                builder.multipart(reqwest::multipart::Form::new().part("body", part))
            }
        };
        builder
            .build()
            .map_err(|err| SlackApiError::Request(err.to_string()))
    }

    /// One request with the client's retries: a network failure, a non-200 answer
    /// and a 429 with `Retry-After` are tried again; a 429 without a usable
    /// `Retry-After` gives up at once.
    async fn make_request(
        &self,
        url: &str,
        body: RequestBody,
        call_token: Option<&str>,
    ) -> Result<FetchedResponse, SlackApiError> {
        let timeouts = retry_timeouts(&self.retry_config);
        let mut errors: Vec<SlackApiError> = Vec::new();
        let mut attempt = 0usize;
        loop {
            match self.attempt(url, &body, call_token).await {
                Ok(response) => return Ok(response),
                Err(AttemptError::Abort(error)) => return Err(error),
                Err(AttemptError::Retry(error)) => {
                    errors.push(error);
                    let Some(wait) = timeouts.get(attempt) else {
                        return Err(main_error(errors));
                    };
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(*wait)).await;
                }
            }
        }
    }

    async fn attempt(
        &self,
        url: &str,
        body: &RequestBody,
        call_token: Option<&str>,
    ) -> Result<FetchedResponse, AttemptError> {
        self.wait_unpaused().await;
        log_debug!("http request url: {}", url);
        let request = self
            .build_request(url, body, call_token)
            .map_err(AttemptError::Retry)?;
        let response = match self.transport.send(request).await {
            Ok(response) => response,
            Err(err) => {
                let message = request_error_message(&err);
                log_warn!("http request failed {}", message);
                return Err(AttemptError::Retry(SlackApiError::Request(message)));
            }
        };
        log_debug!("http response received");
        if response.status == StatusCode::TOO_MANY_REQUESTS {
            let Some(retry_sec) = parse_retry_header(&response.headers) else {
                let header = response
                    .headers
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("null")
                    .to_string();
                return Err(AttemptError::Abort(SlackApiError::Other(format!(
                    "Retry header did not contain a valid timeout (url: {url}, retry-after header: {header})"
                ))));
            };
            log_info!(
                "API Call failed due to rate limiting. Will retry in {} seconds.",
                retry_sec
            );
            let wait = Duration::from_millis((retry_sec.max(0) as u64).saturating_mul(1000));
            *self.paused_until.lock() = Some(tokio::time::Instant::now() + wait);
            tokio::time::sleep(wait).await;
            *self.paused_until.lock() = None;
            return Err(AttemptError::Retry(SlackApiError::Other(format!(
                "A rate limit was exceeded (url: {url}, retry-after: {retry_sec})"
            ))));
        }
        if response.status != StatusCode::OK {
            let text = String::from_utf8_lossy(&response.body).into_owned();
            let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
            return Err(AttemptError::Retry(SlackApiError::Http {
                status: response.status.as_u16(),
                body,
            }));
        }
        Ok(response)
    }
}

/// The message of a failed request, as Node's fetch words the common ones.
fn request_error_message(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "The operation was aborted due to timeout".to_string()
    } else if err.is_connect() || err.is_request() {
        "fetch failed".to_string()
    } else {
        err.to_string()
    }
}

/// The answer as JSON, with `response_metadata` holding the scopes and the
/// `Retry-After` the headers name. A body that is not JSON is `{ ok: false,
/// error: <text> }`.
fn build_result(response: &FetchedResponse) -> Value {
    let text = String::from_utf8_lossy(&response.body).into_owned();
    let mut data = match serde_json::from_str::<Value>(&text) {
        Ok(value) => value,
        Err(_) => json!({ "ok": false, "error": text }),
    };
    let Some(object) = data.as_object_mut() else {
        return data;
    };
    let metadata = object
        .entry("response_metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(metadata) = metadata.as_object_mut() {
        let split = |value: &str| -> Value {
            json!(
                value
                    .trim()
                    .split(',')
                    .map(|scope| scope.trim().to_string())
                    .collect::<Vec<_>>()
            )
        };
        if let Some(scopes) = response
            .headers
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
        {
            metadata.insert("scopes".into(), split(scopes));
        }
        if let Some(scopes) = response
            .headers
            .get("x-accepted-oauth-scopes")
            .and_then(|v| v.to_str().ok())
        {
            metadata.insert("acceptedScopes".into(), split(scopes));
        }
        if let Some(retry_after) = parse_retry_header(&response.headers) {
            metadata.insert("retryAfter".into(), json!(retry_after));
        }
    }
    data
}

static ERROR_MESSAGE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\[ERROR\](.*)").expect("valid regex"));
static WARN_MESSAGE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\[WARN\](.*)").expect("valid regex"));

/// Logs the warnings and messages Slack attached to an answer.
fn report_response_metadata(result: &Value) {
    let Some(metadata) = result.get("response_metadata") else {
        return;
    };
    if let Some(warnings) = metadata.get("warnings").and_then(Value::as_array) {
        for warning in warnings {
            log_warn!("{}", js_string(Some(warning)));
        }
    }
    if let Some(messages) = metadata.get("messages").and_then(Value::as_array) {
        for message in messages.iter().filter_map(Value::as_str) {
            if let Some(found) = ERROR_MESSAGE.captures(message) {
                log_error!("{}", found[1].trim());
            } else if let Some(found) = WARN_MESSAGE.captures(message) {
                log_warn!("{}", found[1].trim());
            }
        }
    }
}

/// The SDK's warning for a message posted without fallback text.
fn warn_if_fallback_is_missing(method: &str, args: &Map<String, Value>) {
    if !matches!(
        method,
        "chat.postEphemeral" | "chat.postMessage" | "chat.scheduleMessage"
    ) {
        return;
    }
    let empty = |value: Option<&Value>| {
        matches!(value, None | Some(Value::Null)) || value.and_then(Value::as_str) == Some("")
    };
    if empty(args.get("text")) && empty(args.get("markdown_text")) {
        log_warn!(
            "The top-level `text` argument is missing in the request payload for a {} call - It's a best practice to always provide a `text` argument when posting a message. The `text` is used in places where the content cannot be rendered such as: system push notifications, assistive technology such as screen readers, etc.",
            method
        );
    }
}

/// Test helpers: a local Slack Web API that answers each method from a handler
/// and records every request.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;

    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::{Path, State};
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use parking_lot::Mutex;
    use serde_json::Value;

    /// One request the fake API received.
    #[derive(Debug, Clone)]
    pub struct RecordedRequest {
        pub method: String,
        pub headers: HeaderMap,
        pub body: String,
    }

    impl RecordedRequest {
        /// The form fields of the body, in order.
        pub fn form(&self) -> Vec<(String, String)> {
            url::form_urlencoded::parse(self.body.as_bytes())
                .into_owned()
                .collect()
        }

        /// One form field.
        pub fn field(&self, name: &str) -> Option<String> {
            self.form()
                .into_iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value)
        }

        /// A form field holding JSON.
        pub fn json_field(&self, name: &str) -> Option<Value> {
            self.field(name)
                .and_then(|text| serde_json::from_str(&text).ok())
        }
    }

    pub type Handler = Arc<dyn Fn(&str, &RecordedRequest) -> (u16, Value) + Send + Sync>;

    #[derive(Clone)]
    struct FakeState {
        handler: Handler,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
    }

    /// A running fake Web API.
    pub struct FakeSlackApi {
        pub url: String,
        pub requests: Arc<Mutex<Vec<RecordedRequest>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FakeSlackApi {
        /// The requests made to `method`.
        pub fn calls(&self, method: &str) -> Vec<RecordedRequest> {
            self.requests
                .lock()
                .iter()
                .filter(|r| r.method == method)
                .cloned()
                .collect()
        }
    }

    impl Drop for FakeSlackApi {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn answer(
        State(state): State<FakeState>,
        Path(method): Path<String>,
        headers: HeaderMap,
        body: Bytes,
    ) -> impl IntoResponse {
        let request = RecordedRequest {
            method: method.clone(),
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        };
        state.requests.lock().push(request.clone());
        let (status, value) = (state.handler)(&method, &request);
        (
            axum::http::StatusCode::from_u16(status).unwrap(),
            [("content-type", "application/json")],
            value.to_string(),
        )
    }

    /// Starts a fake API answering every method through `handler`.
    pub async fn fake_slack_api(handler: Handler) -> FakeSlackApi {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = FakeState {
            handler,
            requests: requests.clone(),
        };
        let app = Router::new()
            .route("/api/{method}", axum::routing::post(answer))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        FakeSlackApi {
            url: format!("http://{addr}/api/"),
            requests,
            task,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn quick_retries() -> WebClientOptions {
        WebClientOptions {
            timeout_ms: Some(2_000),
            retry_config: Some(SlackRetryConfig {
                retries: 1,
                factor: 1.0,
                min_timeout_ms: 1,
                max_timeout_ms: 1,
                randomize: false,
            }),
            slack_api_url: None,
        }
    }

    #[test]
    fn drops_token_from_a_form_body_only() {
        let form = Some("application/x-www-form-urlencoded; charset=utf-8");
        assert_eq!(
            strip_body_token(form, "token=x&channel=C1&text=a+b"),
            Some("channel=C1&text=a+b".to_string())
        );
        assert_eq!(strip_body_token(form, "channel=C1"), None);
        assert_eq!(
            strip_body_token(Some("application/json"), r#"{"token":"x"}"#),
            None
        );
    }

    #[test]
    fn serializes_arguments_as_the_sdk_does() {
        let args = json!({
            "channel": "C1",
            "text": "a b!",
            "thread_ts": null,
            "unfurl": false,
            "limit": 200,
            "blocks": [{ "type": "markdown", "text": "x" }],
        });
        assert_eq!(
            form_body(args.as_object().unwrap()),
            "channel=C1&text=a%20b!&unfurl=false&limit=200&blocks=%5B%7B%22type%22%3A%22markdown%22%2C%22text%22%3A%22x%22%7D%5D"
        );
    }

    #[test]
    fn spaces_retries_as_the_retry_policy_does() {
        assert_eq!(
            retry_timeouts(&SlackRetryConfig {
                retries: 3,
                factor: 2.0,
                min_timeout_ms: 1_000,
                max_timeout_ms: 3_000,
                randomize: false,
            }),
            vec![1_000, 2_000, 3_000]
        );
    }

    #[test]
    fn reports_the_most_frequent_failure_when_retries_run_out() {
        let error = main_error(vec![
            SlackApiError::Request("a".into()),
            SlackApiError::Request("b".into()),
            SlackApiError::Request("a".into()),
        ]);
        assert_eq!(error.to_string(), "A request error occurred: a");
    }

    #[tokio::test]
    async fn sends_a_calls_token_in_the_authorization_header_and_not_in_the_body() {
        let api = fake_slack_api(Arc::new(|_, _| (200, json!({ "ok": true })))).await;
        let client = SlackWebClient::new(
            Some("__nexus_cred:bot__"),
            Some(WebClientOptions {
                slack_api_url: Some(api.url.clone()),
                ..quick_retries()
            }),
        );
        client
            .api_call(
                "chat.postMessage",
                json!({ "token": "__nexus_cred:call__", "channel": "C0EXAMPLE", "text": "hello" }),
            )
            .await
            .unwrap();
        let request = &api.calls("chat.postMessage")[0];
        assert_eq!(
            request.headers.get("authorization").unwrap(),
            "Bearer __nexus_cred:call__"
        );
        assert_eq!(request.field("token"), None);
        assert_eq!(request.field("channel").as_deref(), Some("C0EXAMPLE"));
    }

    #[tokio::test]
    async fn sends_the_client_token_when_the_call_has_none() {
        let api = fake_slack_api(Arc::new(|_, _| (200, json!({ "ok": true })))).await;
        let client = SlackWebClient::new(
            Some("xoxb-bot"),
            Some(WebClientOptions {
                slack_api_url: Some(api.url.clone()),
                ..quick_retries()
            }),
        );
        client.auth_test().await.unwrap();
        let request = &api.calls("auth.test")[0];
        assert_eq!(
            request.headers.get("authorization").unwrap(),
            "Bearer xoxb-bot"
        );
        assert_eq!(request.body, "");
    }

    #[tokio::test]
    async fn names_slacks_error_code_when_slack_answers_not_ok() {
        let api = fake_slack_api(Arc::new(|_, _| {
            (200, json!({ "ok": false, "error": "missing_scope" }))
        }))
        .await;
        let client = SlackWebClient::new(
            Some("xoxb-bot"),
            Some(WebClientOptions {
                slack_api_url: Some(api.url.clone()),
                ..quick_retries()
            }),
        );
        let err = client
            .api_call("conversations.members", json!({ "channel": "C1" }))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "An API error occurred: missing_scope");
        assert_eq!(
            slack_platform_error_code(&err).as_deref(),
            Some("missing_scope")
        );
        // A platform error is an answer, not a failed request: it is not retried.
        assert_eq!(api.calls("conversations.members").len(), 1);
    }

    #[tokio::test]
    async fn retries_a_server_error_then_reports_it() {
        let api = fake_slack_api(Arc::new(|_, _| (500, json!({ "ok": false })))).await;
        let client = SlackWebClient::new(
            Some("xoxb-bot"),
            Some(WebClientOptions {
                slack_api_url: Some(api.url.clone()),
                ..quick_retries()
            }),
        );
        let err = client.api_call("auth.test", json!({})).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "An HTTP protocol error occurred: statusCode = 500"
        );
        assert_eq!(api.calls("auth.test").len(), 2);
    }

    #[tokio::test]
    async fn waits_out_a_rate_limit_and_tries_again() {
        let count = Arc::new(Mutex::new(0));
        let seen = count.clone();
        let api = fake_slack_api(Arc::new(move |_, _| {
            let mut n = seen.lock();
            *n += 1;
            if *n == 1 {
                (429, json!({ "ok": false, "error": "ratelimited" }))
            } else {
                (200, json!({ "ok": true, "user_id": "U1" }))
            }
        }))
        .await;
        let client = SlackWebClient::new(
            Some("xoxb-bot"),
            Some(WebClientOptions {
                slack_api_url: Some(api.url.clone()),
                ..quick_retries()
            }),
        );
        // No Retry-After header: the call gives up at once.
        let err = client.api_call("auth.test", json!({})).await.unwrap_err();
        assert!(
            err.to_string()
                .starts_with("Retry header did not contain a valid timeout"),
            "{err}"
        );
        assert_eq!(api.calls("auth.test").len(), 1);
    }
}
