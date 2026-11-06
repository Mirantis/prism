//! A Slack Web API client whose bot-token auth flows **only** via the
//! `Authorization` header, never in a request body. This lets the Lens Agents
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

use crate::log_warn;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The retry policy of a Slack call: `retries` attempts after the first, waiting
/// `min_timeout_ms * factor^n` between them, capped at `max_timeout_ms`, with
/// random jitter when `randomize` is set.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SlackRetryConfig {
    pub retries: u32,
    pub factor: f64,
    pub min_timeout_ms: u64,
    pub max_timeout_ms: u64,
    pub randomize: bool,
}

/// Options of a [`SlackWebClient`]. A field left `None` takes the bounded default.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WebClientOptions {
    /// Per-request deadline in milliseconds.
    pub timeout_ms: Option<u64>,
    pub retry_config: Option<SlackRetryConfig>,
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
};

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

/// A Slack Web API client with the bounded request policy and header-only auth.
#[derive(Debug, Clone)]
pub struct SlackWebClient {
    token: Option<String>,
    options: WebClientOptions,
    http: reqwest::Client,
}

impl SlackWebClient {
    /// [`BOUNDED_SLACK_CLIENT_OPTIONS`], overridden by whatever `opts` sets.
    pub fn new(token: Option<&str>, opts: Option<WebClientOptions>) -> Self {
        let opts = opts.unwrap_or_default();
        let options = WebClientOptions {
            timeout_ms: opts.timeout_ms.or(BOUNDED_SLACK_CLIENT_OPTIONS.timeout_ms),
            retry_config: opts
                .retry_config
                .or(BOUNDED_SLACK_CLIENT_OPTIONS.retry_config),
        };
        Self {
            token: token.map(str::to_string),
            options,
            http: reqwest::Client::new(),
        }
    }

    /// The token calls are authorized with.
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// Calls a Web API method (`https://slack.com/api/<method>`) with `args` as a
    /// form-urlencoded body (objects and arrays JSON-encoded, as the Slack SDK sends
    /// them) and `Authorization: Bearer <token>`, under the client's deadline and
    /// retry policy. A response with `ok: false` is an error naming Slack's `error`
    /// code; a 429 waits `retry-after` inside the attempt.
    pub async fn api_call(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        todo!()
    }

    /// `auth.test`.
    pub async fn auth_test(&self) -> anyhow::Result<AuthTestResponse> {
        todo!()
    }

    /// `bots.info` for one bot id.
    pub async fn bots_info(&self, bot: &str) -> anyhow::Result<BotsInfoResponse> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
