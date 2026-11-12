//! Teams Adapter Service
//!
//! Microsoft Teams channel adapter — the Teams mirror of
//! `slack_adapter_service.rs`, speaking the Bot Framework protocol directly.
//!
//! Architecture notes:
//! - Inbound: Azure Bot Service POSTs activities to `/agents/teams/messages`
//!   on a listener of its own (`TEAMS_PORT`) that serves nothing else, so that
//!   port alone is what a deployment publishes. The Bot Framework JWT in the
//!   `Authorization` header is validated before the handler runs, and a request
//!   without a valid one is refused. The handler acknowledges fast — it fires the
//!   real work without awaiting it, and sends one typing activity once it knows it
//!   answers — because Bot Framework expects a response within seconds while a
//!   Prism turn runs for minutes.
//! - Outbound: every reply is a proactive send addressed by a stored
//!   conversation id. Only the conversation id is persisted — never the
//!   activity's serviceUrl, which an attacker could forge; proactive sends use
//!   the app's own service URL.
//! - Fail-soft: unset env leaves the adapter idle; an init failure is logged and
//!   leaves the adapter idle, mirroring the Slack adapter.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Once};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use base64::Engine;
use chrono::Utc;
use diesel::prelude::*;
use http::HeaderMap;
use indexmap::IndexMap;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use parking_lot::{Mutex, RwLock};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::constants::MAX_FILE_SIZE_BYTES;
use crate::db::models::{
    ConversationMessage, MessageRole, MessageTrigger, NewTeamsMapping, TeamsMapping,
    TeamsVerificationCode, TeamsVerificationType,
};
use crate::db::schema::{
    conversation_threads as ct, teams_mappings as tm, teams_verification_codes as tvc,
};
use crate::lib::log_redaction::err_json;
use crate::lib::proxy_dispatcher::get_proxy_dispatcher;
use crate::lib::teams_config::{TeamsConnectionRecord, get_teams_config};
use crate::lib::telemetry::track_event;
use crate::services::attachment_service::AttachmentMeta;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, ChatPlatform,
    DefaultDestination, DeliverableMessage, LinkedTarget, LinkedTargetKind, MENTION_TOKEN,
    PostedHistory, PostedMessage, SendRefusedError, describe_target,
};
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata,
};
use crate::services::conversation_service::{CONVERSATION_SERVICE, MessageInput};
use crate::services::teams::teams_attachments::{
    TeamsFileFetchers, TeamsFileTooLargeError, TeamsInboundAttachment, TeamsInboundFiles,
    build_file_failure_notice, describe_shared_files, read_inbound_files,
};
use crate::services::teams::teams_mapping_service::TEAMS_MAPPING_SERVICE;
use crate::services::thread_reply_classifier_service::{
    ClassifyInput, THREAD_REPLY_CLASSIFIER_SERVICE, THREAD_TRANSCRIPT_LINES, ThreadAction,
    ThreadAuthor, ThreadAuthorKind, ThreadLine, ThreadPlatform, load_gate_agent,
};
use crate::support::http::{
    DEFAULT_JSON_LIMIT_BYTES, JsonBody, JsonOptions, empty, finish, json, with_json_body,
};
use crate::utils::teams_formatter::{
    FormatTeamsMessageOptions, format_teams_message, teams_channel_label,
};
use crate::{log_debug, log_error, log_info, log_warn};

/// The public messaging endpoint registered on the Azure Bot resource.
pub const TEAMS_MESSAGING_PATH: &str = "/agents/teams/messages";

/// How long one inbound file download may take.
const FILE_DOWNLOAD_TIMEOUT_MS: u64 = 30_000;

/// Proactive-send retries on 429 (Retry-After honored when present).
const SEND_RETRIES: u32 = 2;

/// Where proactive sends go when `SERVICE_URL` is unset, trailing slashes removed.
const DEFAULT_SERVICE_URL: &str = "https://smba.trafficmanager.net/teams";

/// How far an inbound token's `exp` and `nbf` may be off, in seconds.
const CLOCK_TOLERANCE_SECS: u64 = 300;

/// How long a read of the signing keys is used before it is read again.
const SIGNING_KEYS_MAX_AGE: Duration = Duration::from_secs(600);

/// How long a signing-key read may take.
const SIGNING_KEYS_TIMEOUT: Duration = Duration::from_secs(30);

/// A token is acquired again this long before it expires.
const TOKEN_RENEWAL_OFFSET_SECS: u64 = 300;

/// The issuer prefix of an Entra v1 token.
const ENTRA_V1_ISSUER_PREFIX: &str = "https://sts.windows.net/";

/// The Graph tenant when the app names none.
const DEFAULT_TENANT_FOR_GRAPH_TOKEN: &str = "common";

/// An AAD object id, the id a Teams mention token names.
static AAD_OBJECT_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid regex")
});

/// A Teams channel message id, which is also a reply-chain root.
static TEAMS_MESSAGE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+$").expect("valid regex"));

static VERIFICATION_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Fa-f0-9]{6}$").expect("valid regex"));

static SENDER_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<@[^>]*>: ").expect("valid regex"));

static SENDER_NAME_UNSAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[<>:\x00-\x1f]").expect("valid regex"));

/// An `<at>` tag in inbound text.
static AT_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?at[^>]*>").expect("valid regex"));

/// An `<at>` tag the agent wrote.
static AGENT_AT_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</?at\b[^>]*>").expect("valid regex"));

static HTML_BR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").expect("valid regex"));
static HTML_BLOCK_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</(?:p|div|li|tr|h[1-6]|pre|blockquote)\s*>").expect("valid regex")
});
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").expect("valid regex"));
static HTML_NBSP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&nbsp;").expect("valid regex"));
static HTML_LT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&lt;").expect("valid regex"));
static HTML_GT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&gt;").expect("valid regex"));
static HTML_QUOT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&quot;").expect("valid regex"));
static HTML_DEC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("valid regex"));
static HTML_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").expect("valid regex"));
static HTML_AMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&amp;").expect("valid regex"));
static SPACES_AND_TABS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t]+").expect("valid regex"));

/// The characters `encodeURIComponent` leaves as they are.
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

/// Sign-in and the signing keys go direct, as the SDK's token and key clients do.
static DIRECT_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("http client")
});

// ============================================================================
// Bot Framework wire types
// ============================================================================

/// A Bot Framework channel account: a person or a bot in a conversation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelAccount {
    #[serde(default)]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aad_object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// The conversation an activity belongs to. A channel activity's `id` carries the
/// reply chain's root as a `;messageid=<root>` suffix.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsConversationAccount {
    #[serde(default)]
    pub id: String,
    /// `personal`, `channel` or `groupChat`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_group: Option<bool>,
}

/// A team or a channel as `channelData` names it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Teams' `channelData` on an inbound activity.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<TeamsChannelInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<TeamsChannelInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<TeamsChannelInfo>,
}

/// One entity of an activity. A `mention` names the person or bot in `mentioned`
/// and the `<at>…</at>` text it stands for; other kinds keep their own fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsEntity {
    #[serde(rename = "type", default)]
    pub entity_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentioned: Option<TeamsChannelAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

/// An inbound Bot Framework activity, the fields the adapter reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsActivity {
    #[serde(rename = "type", default)]
    pub activity_type: String,
    #[serde(default)]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub from: TeamsChannelAccount,
    #[serde(default)]
    pub recipient: TeamsChannelAccount,
    #[serde(default)]
    pub conversation: TeamsConversationAccount,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_data: Option<TeamsChannelData>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entities: Option<Vec<TeamsEntity>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<TeamsInboundAttachment>>,
    /// Where a reply in the request's own context goes. Never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
}

/// An activity the bot sends: a `message` with its mention entities, or `typing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsOutboundActivity {
    #[serde(rename = "type")]
    pub activity_type: String,
    /// Each `{ type: 'mention', mentioned: { id, name, role: 'user' }, text: '<at>name</at>' }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<TeamsEntity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl TeamsOutboundActivity {
    /// A message activity with this text and no mentions.
    pub fn message(text: impl Into<String>) -> Self {
        TeamsOutboundActivity {
            activity_type: "message".to_string(),
            entities: Vec::new(),
            text: Some(text.into()),
        }
    }

    /// A typing activity, the brief working cue Teams expires after a few seconds.
    pub fn typing() -> Self {
        TeamsOutboundActivity {
            activity_type: "typing".to_string(),
            entities: Vec::new(),
            text: None,
        }
    }

    /// A mention entity for `account`, its text the `<at>` tag of `text`.
    fn add_mention(&mut self, account: TeamsChannelAccount, text: &str) {
        self.entities.push(TeamsEntity {
            entity_type: "mention".to_string(),
            mentioned: Some(account),
            text: Some(format!("<at>{text}</at>")),
            other: Map::new(),
        });
    }
}

/// What the connector answers a send with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsSentActivity {
    /// The posted activity's id; `None` when the connector named none.
    #[serde(default)]
    pub id: Option<String>,
}

/// A failed Bot Framework, Graph or download request: its HTTP status, and the
/// `Retry-After` delay when the response named one. A 429 is retried on it; a
/// 401/403 on a file read becomes a permission failure; a 404 on a member lookup
/// means the person is not in the conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamsHttpError {
    pub status: u16,
    pub retry_after_ms: Option<u64>,
    /// The request went through the Bot Framework or Graph client rather than a
    /// plain download, which names the error as the SDK's HTTP client did.
    pub sdk: bool,
}

static REGISTER_LOG_FIELDS: Once = Once::new();

fn ensure_log_fields_registered() {
    REGISTER_LOG_FIELDS.call_once(|| crate::lib::log_redaction::register_error_fields(log_fields));
}

impl TeamsHttpError {
    /// A Bot Framework or Graph request answered with `status`.
    pub fn sdk(status: u16, retry_after_ms: Option<u64>) -> Self {
        ensure_log_fields_registered();
        TeamsHttpError {
            status,
            retry_after_ms,
            sdk: true,
        }
    }

    /// A plain download answered with `status`.
    pub fn plain(status: u16) -> Self {
        ensure_log_fields_registered();
        TeamsHttpError {
            status,
            retry_after_ms: None,
            sdk: false,
        }
    }
}

impl std::fmt::Display for TeamsHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.sdk {
            write!(f, "Request failed with status code {}", self.status)
        } else {
            write!(f, "HTTP {}", self.status)
        }
    }
}

impl std::error::Error for TeamsHttpError {}

/// A sign-in that the identity platform refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{error_code}: {description}")]
pub struct TeamsTokenError {
    pub status: u16,
    pub error_code: String,
    pub description: String,
}

fn log_fields(err: &(dyn std::error::Error + 'static)) -> Option<Map<String, Value>> {
    let mut fields = Map::new();
    if let Some(http) = err.downcast_ref::<TeamsHttpError>() {
        if http.sdk {
            fields.insert("name".into(), json!("AxiosError"));
            let code = if http.status >= 500 {
                "ERR_BAD_RESPONSE"
            } else {
                "ERR_BAD_REQUEST"
            };
            fields.insert("code".into(), json!(code));
        }
        return Some(fields);
    }
    if let Some(token) = err.downcast_ref::<TeamsTokenError>() {
        fields.insert("name".into(), json!("ServerError"));
        fields.insert("code".into(), json!(token.error_code));
        return Some(fields);
    }
    None
}

/// `error.name` as the SDK's clients name the error.
fn error_name(error: &anyhow::Error) -> &'static str {
    if let Some(http) = error.downcast_ref::<TeamsHttpError>() {
        return if http.sdk { "AxiosError" } else { "Error" };
    }
    if error.downcast_ref::<TeamsTokenError>().is_some() {
        return "ServerError";
    }
    if error.downcast_ref::<reqwest::Error>().is_some() {
        return "AxiosError";
    }
    if error.downcast_ref::<SendRefusedError>().is_some() {
        return "SendRefusedError";
    }
    "Error"
}

/// `String(error)`: the name and the message.
fn error_text(error: &anyhow::Error) -> String {
    format!("{}: {}", error_name(error), error)
}

// ============================================================================
// The Bot Framework app
// ============================================================================

/// The Microsoft cloud the bot runs in: where it signs in, the scopes it asks
/// for, and who issues the tokens Bot Framework sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TeamsCloud {
    login_endpoint: String,
    login_tenant: String,
    bot_scope: String,
    open_id_metadata_url: String,
    token_issuer: String,
    graph_scope: String,
}

impl TeamsCloud {
    fn new(
        login_endpoint: &str,
        login_tenant: &str,
        bot_scope: &str,
        open_id_metadata_url: &str,
        token_issuer: &str,
        graph_scope: &str,
    ) -> Self {
        TeamsCloud {
            login_endpoint: login_endpoint.to_string(),
            login_tenant: login_tenant.to_string(),
            bot_scope: bot_scope.to_string(),
            open_id_metadata_url: open_id_metadata_url.to_string(),
            token_issuer: token_issuer.to_string(),
            graph_scope: graph_scope.to_string(),
        }
    }

    fn public() -> Self {
        TeamsCloud::new(
            "https://login.microsoftonline.com",
            "botframework.com",
            "https://api.botframework.com/.default",
            "https://login.botframework.com/v1/.well-known/openidconfiguration",
            "https://api.botframework.com",
            "https://graph.microsoft.com/.default",
        )
    }

    /// The cloud `CLOUD` names: `Public`, `USGov`, `USGovDoD` or `China`, in any case.
    fn from_name(name: &str) -> anyhow::Result<Self> {
        Ok(match name.to_lowercase().as_str() {
            "public" => TeamsCloud::public(),
            "usgov" => TeamsCloud::new(
                "https://login.microsoftonline.us",
                "MicrosoftServices.onmicrosoft.us",
                "https://api.botframework.us/.default",
                "https://login.botframework.azure.us/v1/.well-known/openidconfiguration",
                "https://api.botframework.us",
                "https://graph.microsoft.us/.default",
            ),
            "usgovdod" => TeamsCloud::new(
                "https://login.microsoftonline.us",
                "MicrosoftServices.onmicrosoft.us",
                "https://api.botframework.us/.default",
                "https://login.botframework.azure.us/v1/.well-known/openidconfiguration",
                "https://api.botframework.us",
                "https://dod-graph.microsoft.us/.default",
            ),
            "china" => TeamsCloud::new(
                "https://login.partner.microsoftonline.cn",
                "microsoftservices.partner.onmschina.cn",
                "https://api.botframework.azure.cn/.default",
                "https://login.botframework.azure.cn/v1/.well-known/openidconfiguration",
                "https://api.botframework.azure.cn",
                "https://microsoftchinacloudapi.cn/.default",
            ),
            _ => anyhow::bail!(
                "Unknown cloud environment: '{name}'. Valid values are: Public, USGov, USGovDoD, China."
            ),
        })
    }

    /// The signing keys beside the OpenID metadata.
    fn keys_url(&self) -> String {
        match self
            .open_id_metadata_url
            .strip_suffix("/openidconfiguration")
        {
            Some(base) => format!("{base}/keys"),
            None => self.open_id_metadata_url.clone(),
        }
    }
}

/// A token and when it stops being usable.
#[derive(Debug, Clone)]
struct CachedToken {
    value: String,
    expires_at: Instant,
}

/// The signing keys an inbound JWT is checked against, and when they were read.
#[derive(Debug, Clone)]
struct CachedSigningKeys {
    keys: Value,
    fetched_at: Instant,
}

/// The bot's credentials and its clients: the Bot Framework connector at the
/// app's own service URL (`SERVICE_URL`, else `DEFAULT_SERVICE_URL`), Microsoft
/// Graph, the client-credentials tokens for both, and the signing keys the
/// inbound JWT is validated with. JWT validation is never switched off.
struct TeamsApp {
    client_id: String,
    client_secret: String,
    tenant_id: String,
    cloud: TeamsCloud,
    service_url: String,
    /// The connector, Graph and file downloads: through `HTTPS_PROXY` when set.
    http: reqwest::Client,
    /// Sign-in and signing keys.
    auth_http: reqwest::Client,
    /// Tokens by tenant and scope.
    tokens: tokio::sync::Mutex<HashMap<String, CachedToken>>,
    /// Signing keys by the URL they were read from.
    signing_keys: tokio::sync::Mutex<HashMap<String, CachedSigningKeys>>,
}

/// One trailing slash removed.
fn strip_trailing_slash(url: &str) -> &str {
    url.strip_suffix('/').unwrap_or(url)
}

/// `Number(value)` seconds of a `Retry-After` header, as milliseconds.
fn retry_after_header(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get("retry-after")?.to_str().ok()?;
    let seconds = crate::support::js::number_from(raw)?;
    (seconds.is_finite() && seconds >= 0.0).then_some((seconds * 1000.0) as u64)
}

/// The claims of a token, read without checking its signature.
fn decode_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
}

/// The RSA signing key `kid` names in a key set; with no `kid`, the set's only key.
fn find_signing_key(keys: &Value, kid: Option<&str>) -> anyhow::Result<Option<DecodingKey>> {
    let signing: Vec<&Value> = keys
        .get("keys")
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter(|k| {
                    matches!(k.get("use").and_then(Value::as_str), None | Some("sig"))
                        && k.get("kty").and_then(Value::as_str) == Some("RSA")
                        && k.get("n").and_then(Value::as_str).is_some()
                        && k.get("e").and_then(Value::as_str).is_some()
                })
                .collect()
        })
        .unwrap_or_default();
    let key = match kid {
        Some(kid) => signing
            .into_iter()
            .find(|k| k.get("kid").and_then(Value::as_str) == Some(kid)),
        None if signing.len() > 1 => {
            anyhow::bail!("No KID specified and JWKS endpoint returned more than 1 key")
        }
        None => signing.into_iter().next(),
    };
    let Some(key) = key else {
        return Ok(None);
    };
    let n = key["n"].as_str().unwrap_or_default();
    let e = key["e"].as_str().unwrap_or_default();
    Ok(Some(DecodingKey::from_rsa_components(n, e)?))
}

impl TeamsApp {
    fn new(
        client_id: &str,
        client_secret: &str,
        tenant_id: &str,
        cloud: TeamsCloud,
        service_url: &str,
        http: reqwest::Client,
        auth_http: reqwest::Client,
    ) -> Self {
        TeamsApp {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            tenant_id: tenant_id.to_string(),
            cloud,
            service_url: service_url.trim_end_matches('/').to_string(),
            http,
            auth_http,
            tokens: tokio::sync::Mutex::new(HashMap::new()),
            signing_keys: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// The app for these credentials in the cloud `CLOUD` names (else the public
    /// one), sending to `SERVICE_URL` (else `DEFAULT_SERVICE_URL`).
    async fn from_env(
        client_id: &str,
        client_secret: &str,
        tenant_id: &str,
    ) -> anyhow::Result<Self> {
        let cloud = match std::env::var("CLOUD").ok().filter(|name| !name.is_empty()) {
            Some(name) => TeamsCloud::from_name(&name)?,
            None => TeamsCloud::public(),
        };
        let service_url =
            std::env::var("SERVICE_URL").unwrap_or_else(|_| DEFAULT_SERVICE_URL.to_string());
        let http = match get_proxy_dispatcher().await {
            Some(proxied) => proxied,
            None => DIRECT_HTTP.clone(),
        };
        Ok(TeamsApp::new(
            client_id,
            client_secret,
            tenant_id,
            cloud,
            &service_url,
            http,
            DIRECT_HTTP.clone(),
        ))
    }

    /// A client-credentials token for `scope` in `tenant`, reused until five
    /// minutes before it expires.
    async fn token(&self, scope: &str, tenant: &str) -> anyhow::Result<String> {
        let key = format!("{tenant} {scope}");
        let mut tokens = self.tokens.lock().await;
        if let Some(token) = tokens.get(&key).filter(|t| t.expires_at > Instant::now()) {
            return Ok(token.value.clone());
        }
        let url = format!("{}/{}/oauth2/v2.0/token", self.cloud.login_endpoint, tenant);
        let res = self
            .auth_http
            .post(url)
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("scope", scope),
                ("client_secret", self.client_secret.as_str()),
                ("grant_type", "client_credentials"),
            ])
            .send()
            .await?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(TeamsTokenError {
                status: status.as_u16(),
                error_code: body
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("server_error")
                    .to_string(),
                description: body
                    .get("error_description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            }
            .into());
        }
        let Some(value) = body.get("access_token").and_then(Value::as_str) else {
            anyhow::bail!("Failed to get token");
        };
        let expires_in = match body.get("expires_in") {
            Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
            Some(Value::String(s)) => s.parse().unwrap_or(0),
            _ => 0,
        };
        let lifetime = expires_in.saturating_sub(TOKEN_RENEWAL_OFFSET_SECS);
        tokens.insert(
            key,
            CachedToken {
                value: value.to_string(),
                expires_at: Instant::now() + Duration::from_secs(lifetime),
            },
        );
        Ok(value.to_string())
    }

    /// The token the connector and the attachment service accept.
    async fn bot_token(&self) -> anyhow::Result<String> {
        let tenant = if self.tenant_id.is_empty() {
            self.cloud.login_tenant.clone()
        } else {
            self.tenant_id.clone()
        };
        self.token(&self.cloud.bot_scope, &tenant).await
    }

    /// The app's own Microsoft Graph token.
    async fn graph_token(&self) -> anyhow::Result<String> {
        let tenant = if self.tenant_id.is_empty() {
            DEFAULT_TENANT_FOR_GRAPH_TOKEN.to_string()
        } else {
            self.tenant_id.clone()
        };
        self.token(&self.cloud.graph_scope, &tenant).await
    }

    /// The signing key `kid` names at `url`, from a read at most ten minutes old,
    /// else from a fresh read.
    async fn signing_key(&self, url: &str, kid: Option<&str>) -> anyhow::Result<DecodingKey> {
        let mut cache = self.signing_keys.lock().await;
        if let Some(cached) = cache
            .get(url)
            .filter(|c| c.fetched_at.elapsed() < SIGNING_KEYS_MAX_AGE)
            && let Some(key) = find_signing_key(&cached.keys, kid)?
        {
            return Ok(key);
        }
        let res = self
            .auth_http
            .get(url)
            .timeout(SIGNING_KEYS_TIMEOUT)
            .send()
            .await?;
        if !res.status().is_success() {
            anyhow::bail!(
                "Failed to read the signing keys: HTTP {}",
                res.status().as_u16()
            );
        }
        let keys: Value = res.json().await?;
        let found = find_signing_key(&keys, kid)?;
        cache.insert(
            url.to_string(),
            CachedSigningKeys {
                keys,
                fetched_at: Instant::now(),
            },
        );
        found.ok_or_else(|| {
            anyhow::anyhow!(
                "Unable to find a signing key that matches '{}'",
                kid.unwrap_or("undefined")
            )
        })
    }

    /// The claims of a token whose RS256 signature verifies against the key set at
    /// `keys_url`, whose audience is this app, and whose `exp` and `nbf` hold
    /// within five minutes.
    async fn verify(&self, token: &str, keys_url: &str) -> anyhow::Result<Value> {
        let header = jsonwebtoken::decode_header(token)?;
        let key = self.signing_key(keys_url, header.kid.as_deref()).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[
            self.client_id.clone(),
            format!("api://botid-{}", self.client_id),
            format!("api://{}", self.client_id),
        ]);
        validation.leeway = CLOCK_TOLERANCE_SECS;
        validation.validate_nbf = true;
        validation.required_spec_claims = HashSet::new();
        Ok(jsonwebtoken::decode::<Value>(token, &key, &validation)?.claims)
    }

    /// Validate the Bot Framework JWT of an inbound request: signature against the
    /// published keys, issuer, audience (the app id) and the `serviceUrl` claim
    /// against the activity's. A token an Entra tenant issued (an agentic
    /// identity) is checked against that tenant's keys and issuer instead, with no
    /// service URL claim. Answers the service URL a reply in the request's context
    /// goes to: the activity's, else the token's.
    async fn validate_request(
        &self,
        authorization: &str,
        activity: &Value,
    ) -> anyhow::Result<String> {
        let token = authorization
            .strip_prefix("Bearer ")
            .unwrap_or(authorization);
        if token.is_empty() {
            anyhow::bail!("No token provided");
        }
        let body_service_url = activity
            .get("serviceUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty());
        let unverified = decode_payload(token);
        let unverified_issuer = unverified
            .as_ref()
            .and_then(|p| p.get("iss"))
            .and_then(Value::as_str);
        let is_entra = unverified_issuer.is_some_and(|iss| {
            iss.starts_with(&self.cloud.login_endpoint) || iss.starts_with(ENTRA_V1_ISSUER_PREFIX)
        });

        let payload = if is_entra {
            let Some(tenant_id) = unverified
                .as_ref()
                .and_then(|p| p.get("tid"))
                .and_then(Value::as_str)
                .filter(|tid| !tid.is_empty())
            else {
                anyhow::bail!("Entra inbound token is missing tid");
            };
            let keys_url = format!(
                "{}/{}/discovery/v2.0/keys",
                self.cloud.login_endpoint, tenant_id
            );
            let payload = self.verify(token, &keys_url).await?;
            let Some(iss) = payload.get("iss").and_then(Value::as_str) else {
                anyhow::bail!("Token missing issuer claim");
            };
            let endpoints = [
                self.cloud.login_endpoint.as_str(),
                "https://sts.windows.net",
            ];
            if !endpoints
                .iter()
                .any(|endpoint| iss.starts_with(&format!("{endpoint}/{tenant_id}/")))
            {
                anyhow::bail!("Token issuer '{iss}' not in allowed tenant IDs: {tenant_id}");
            }
            payload
        } else {
            let payload = self.verify(token, &self.cloud.keys_url()).await?;
            let Some(iss) = payload.get("iss").and_then(Value::as_str) else {
                anyhow::bail!("Token missing issuer claim");
            };
            if iss != self.cloud.token_issuer {
                anyhow::bail!(
                    "Token issuer '{iss}' does not match allowed issuer '{}'",
                    self.cloud.token_issuer
                );
            }
            if let Some(expected) = body_service_url {
                let Some(claim) = payload
                    .get("serviceurl")
                    .and_then(Value::as_str)
                    .filter(|url| !url.is_empty())
                else {
                    anyhow::bail!("Token missing serviceurl claim");
                };
                let token_url = strip_trailing_slash(claim).to_lowercase();
                let expected_url = strip_trailing_slash(expected).to_lowercase();
                if token_url != expected_url {
                    anyhow::bail!(
                        "Service URL mismatch. Token: {token_url}, Expected: {expected_url}"
                    );
                }
            }
            payload
        };

        Ok(body_service_url
            .or_else(|| {
                payload
                    .get("serviceurl")
                    .and_then(Value::as_str)
                    .filter(|url| !url.is_empty())
            })
            .unwrap_or("")
            .to_string())
    }

    /// A request to the connector with the bot's token: the JSON answer, `Null`
    /// for an empty one. A non-2xx answer is a [`TeamsHttpError`].
    async fn connector(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<&Value>,
    ) -> anyhow::Result<Value> {
        let token = self.bot_token().await?;
        let mut request = self.http.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let res = request.send().await?;
        let status = res.status();
        if !status.is_success() {
            return Err(
                TeamsHttpError::sdk(status.as_u16(), retry_after_header(res.headers())).into(),
            );
        }
        let bytes = res.bytes().await?;
        Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// POST an activity into `conversation`, from `from`.
    async fn post_activity(
        &self,
        service_url: &str,
        conversation: Value,
        from: Value,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        let conversation_id = conversation
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("undefined")
            .to_string();
        let mut payload = serde_json::to_value(activity)?;
        if let Value::Object(fields) = &mut payload {
            fields.insert("from".to_string(), from);
            fields.insert("conversation".to_string(), conversation);
        }
        let url = format!(
            "{}/v3/conversations/{}/activities",
            strip_trailing_slash(service_url),
            conversation_id
        );
        let res = self
            .connector(reqwest::Method::POST, &url, Some(&payload))
            .await?;
        Ok(TeamsSentActivity {
            id: match res.get("id") {
                Some(Value::String(id)) => Some(id.clone()),
                Some(Value::Number(id)) => Some(id.to_string()),
                _ => None,
            },
        })
    }

    /// Post a top-level activity into a conversation. A non-2xx answer is a
    /// [`TeamsHttpError`].
    async fn send(
        &self,
        conversation_id: &str,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        self.post_activity(
            &self.service_url,
            json!({ "id": conversation_id }),
            json!({ "id": self.client_id, "role": "bot" }),
            activity,
        )
        .await
    }

    /// Post an activity into the reply chain rooted at `root_message_id`.
    async fn reply(
        &self,
        conversation_id: &str,
        root_message_id: &str,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        if conversation_id.is_empty() {
            anyhow::bail!("conversationId must be a non-empty string");
        }
        if !TEAMS_MESSAGE_ID.is_match(root_message_id) || root_message_id == "0" {
            anyhow::bail!(
                "Invalid messageId \"{root_message_id}\": must be a non-zero numeric value"
            );
        }
        // Strip any existing ;messageid= suffix, as the Teams service normalizes it.
        let base_id = conversation_id.split(';').next().unwrap_or(conversation_id);
        self.send(&format!("{base_id};messageid={root_message_id}"), activity)
            .await
    }

    /// Send an activity in the context of an inbound one, at its service URL.
    async fn send_in_context(
        &self,
        cue: &TypingCue,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        self.post_activity(
            &cue.service_url,
            cue.conversation.clone(),
            cue.recipient.clone(),
            activity,
        )
        .await
    }

    /// One member of a conversation. A 404 is a [`TeamsHttpError`] with status 404.
    async fn get_member_by_id(
        &self,
        conversation_id: &str,
        member_id: &str,
    ) -> anyhow::Result<TeamsChannelAccount> {
        let url = format!(
            "{}/v3/conversations/{}/members/{}",
            self.service_url, conversation_id, member_id
        );
        let member = self.connector(reqwest::Method::GET, &url, None).await?;
        Ok(serde_json::from_value(member)?)
    }

    /// The channels of a team.
    async fn get_team_conversations(&self, team_id: &str) -> anyhow::Result<Vec<TeamsChannelInfo>> {
        let url = format!("{}/v3/teams/{}/conversations", self.service_url, team_id);
        let res = self.connector(reqwest::Method::GET, &url, None).await?;
        let Some(conversations) = res.get("conversations") else {
            anyhow::bail!("Cannot read properties of undefined (reading 'find')");
        };
        Ok(serde_json::from_value(conversations.clone())?)
    }

    /// GET with `token`, at most `max_bytes` and `FILE_DOWNLOAD_TIMEOUT_MS`.
    async fn get_bytes(&self, url: &str, token: String, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
        let mut res = self
            .http
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_millis(FILE_DOWNLOAD_TIMEOUT_MS))
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            return Err(
                TeamsHttpError::sdk(status.as_u16(), retry_after_header(res.headers())).into(),
            );
        }
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            body.extend_from_slice(&chunk);
            if body.len() as u64 > max_bytes {
                return Err(TeamsFileTooLargeError.into());
            }
        }
        Ok(body)
    }

    /// GET with the bot's token, at most `max_bytes` and `FILE_DOWNLOAD_TIMEOUT_MS`.
    async fn bot_get(&self, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
        let token = self.bot_token().await?;
        self.get_bytes(url, token, max_bytes).await
    }

    /// GET with the app's Graph token, at most `max_bytes` and `FILE_DOWNLOAD_TIMEOUT_MS`.
    async fn graph_get(&self, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
        let token = self.graph_token().await?;
        self.get_bytes(url, token, max_bytes).await
    }
}

/// The bot's own listener on `TEAMS_PORT`, serving `TEAMS_MESSAGING_PATH` alone.
struct BotServer {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
    addr: SocketAddr,
}

/// Reads a message's files with the app's credentials: `bot` and `graph` through
/// the app (a body past `MAX_FILE_SIZE_BYTES` is a `TeamsFileTooLargeError`),
/// `plain` through `fetch_plain`.
struct AppFileFetchers {
    app: Arc<TeamsApp>,
}

#[async_trait]
impl TeamsFileFetchers for AppFileFetchers {
    async fn bot(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        self.app.bot_get(url, MAX_FILE_SIZE_BYTES as u64).await
    }

    async fn graph(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        self.app.graph_get(url, MAX_FILE_SIZE_BYTES as u64).await
    }

    async fn plain(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        TeamsAdapterService::fetch_plain(url).await
    }
}

/// The brief working cue for one inbound activity: a typing activity in its
/// conversation, sent in the activity's context. A failure is logged at debug as
/// `[TeamsAdapter] typing activity failed: {error}`.
struct TypingCue {
    app: Arc<TeamsApp>,
    /// The activity's service URL, else the token's.
    service_url: String,
    /// The activity's `conversation`, as it came.
    conversation: Value,
    /// The activity's `recipient` (the bot), as it came.
    recipient: Value,
}

impl TypingCue {
    async fn signal(&self) {
        if let Err(error) = self
            .app
            .send_in_context(self, &TeamsOutboundActivity::typing())
            .await
        {
            log_debug!(
                "[TeamsAdapter] typing activity failed: {}",
                error_text(&error)
            );
        }
    }
}

/// The outcome of a link code.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VerificationResult {
    success: bool,
    message: String,
    agent_name: Option<String>,
}

impl VerificationResult {
    fn failed(message: &str) -> Self {
        VerificationResult {
            success: false,
            message: message.to_string(),
            agent_name: None,
        }
    }

    /// The reply the link code gets.
    fn reply(&self) -> String {
        if self.success {
            format!("✅ {}", self.message)
        } else {
            format!("❌ {}", self.message)
        }
    }
}

/// The mapping fields a channel turn needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChannelTurnMapping {
    lens_user_id: String,
    agent_id: String,
    channel_name: Option<String>,
}

/// The sender of an inbound activity: the AAD object id when Teams sends one, else
/// the Bot Framework id.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ActivitySender {
    id: String,
    name: Option<String>,
}

/// The chat fields a message's files add: the stored ids, and a notice for failures.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct FileTurnInput {
    attachment_ids: Option<Vec<String>>,
    runtime_notices: Option<Vec<String>>,
}

/// Telemetry-safe description of an error (name + HTTP status only — never the
/// message, which can quote user content): `error.name`, and `error.status` when
/// the error is a [`TeamsHttpError`]. Mirrors the Slack adapter's helper.
fn error_shape(error: &anyhow::Error) -> IndexMap<String, String> {
    let mut shape = IndexMap::new();
    shape.insert("error.name".to_string(), error_name(error).to_string());
    if let Some(status) = error_status(error) {
        shape.insert("error.status".to_string(), status.to_string());
    }
    shape
}

/// The HTTP status of an error, when it is a [`TeamsHttpError`].
fn error_status(error: &anyhow::Error) -> Option<u16> {
    error.downcast_ref::<TeamsHttpError>().map(|e| e.status)
}

/// The Retry-After delay of an error, when it named one.
fn retry_after_ms(error: &anyhow::Error) -> Option<u64> {
    error
        .downcast_ref::<TeamsHttpError>()
        .and_then(|e| e.retry_after_ms)
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
fn js_trim(text: &str) -> &str {
    crate::support::js::trim(text)
}

/// `{ 'agent.id': config.agentId }` when an agent id is set.
fn agent_props() -> IndexMap<String, String> {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props
}

/// An attacker-controlled activity field as a log line may hold it: control
/// characters removed and at most 64 characters, `unknown` when absent.
fn safe_log_field(value: Option<&Value>) -> String {
    let text = match value {
        None | Some(Value::Null) => "unknown".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(other) => other.to_string(),
    };
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(*c, '\x00'..='\x1f' | '\x7f'))
        .collect();
    crate::support::js::slice16(&cleaned, 0, 64)
}

/// `String.fromCodePoint` of a decimal or hex character reference, else the reference.
fn char_reference(reference: &str, code: Option<u64>) -> String {
    match code
        .filter(|n| *n <= 0x10ffff)
        .and_then(|n| char::from_u32(n as u32))
    {
        Some(ch) => ch.to_string(),
        None => reference.to_string(),
    }
}

/// The bot's request handler: the SDK's activity endpoint. A request without an
/// `Authorization` header, or whose JWT does not validate, gets 401; a valid one
/// gets 200 at once, and a message activity is handed to the adapter.
async fn handle_bot_request(
    State(app): State<Arc<TeamsApp>>,
    headers: HeaderMap,
    body: JsonBody,
) -> Response {
    let authorization = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty());
    let Some(authorization) = authorization else {
        log_warn!(
            "inbound activity rejected (type={}, id={}): missing Authorization header (responding 401)",
            safe_log_field(body.field("type")),
            safe_log_field(body.field("id"))
        );
        return json(401, json!({ "error": "Missing authorization header" }));
    };
    let raw = body.0.filter(Value::is_object).unwrap_or(Value::Null);
    let validated = if raw.is_object() {
        app.validate_request(authorization, &raw).await
    } else {
        Err(anyhow::anyhow!(
            "Cannot read properties of undefined (reading 'serviceUrl')"
        ))
    };
    let service_url = match validated {
        Ok(service_url) => service_url,
        Err(err) => {
            log_error!(json!({ "err": err_json(&err) }), "JWT validation failed");
            return json(401, json!({ "error": "JWT validation failed" }));
        }
    };

    let activity = match serde_json::from_value::<TeamsActivity>(raw.clone()) {
        Ok(activity) => activity,
        Err(err) => {
            log_debug!("[TeamsAdapter] unreadable activity: {}", err);
            return empty(200);
        }
    };
    if activity.activity_type == "message" {
        let cue = TypingCue {
            app,
            service_url: strip_trailing_slash(&service_url).to_string(),
            conversation: raw.get("conversation").cloned().unwrap_or(Value::Null),
            recipient: raw.get("recipient").cloned().unwrap_or(Value::Null),
        };
        TEAMS_ADAPTER_SERVICE.on_message(activity, cue);
    }
    empty(200)
}

pub struct TeamsAdapterService {
    app: RwLock<Option<Arc<TeamsApp>>>,
    server: Mutex<Option<BotServer>>,
    connection: RwLock<Option<TeamsConnectionRecord>>,
    /// The bot's own account id, captured from the first inbound activity.
    bot_account_id: RwLock<Option<String>>,
    stopped: AtomicBool,
}

impl Default for TeamsAdapterService {
    fn default() -> Self {
        Self::new()
    }
}

impl TeamsAdapterService {
    pub fn new() -> Self {
        TeamsAdapterService {
            app: RwLock::new(None),
            server: Mutex::new(None),
            connection: RwLock::new(None),
            bot_account_id: RwLock::new(None),
            stopped: AtomicBool::new(false),
        }
    }

    /// Test-only: reset the singleton between tests.
    #[doc(hidden)]
    pub fn reset_for_tests(&self) {
        *self.app.write() = None;
        if let Some(server) = self.server.lock().take() {
            server.shutdown.cancel();
        }
        *self.connection.write() = None;
        *self.bot_account_id.write() = None;
        self.stopped.store(false, Ordering::SeqCst);
    }

    fn current_app(&self) -> Option<Arc<TeamsApp>> {
        self.app.read().clone()
    }

    /// The router of the bot's own listener: `POST TEAMS_MESSAGING_PATH` alone,
    /// with Express's JSON body parser (100 kB) and its 404 for everything else.
    fn bot_router(app: Arc<TeamsApp>) -> axum::Router {
        let route: Router = Router::new()
            .route(TEAMS_MESSAGING_PATH, post(handle_bot_request))
            .with_state(app);
        finish(with_json_body(
            route,
            JsonOptions::limit(DEFAULT_JSON_LIMIT_BYTES),
        ))
    }

    /// Bind the bot's listener and serve it until shutdown. Once listening, a
    /// failed serve is logged as `[TeamsAdapter] bot server error`.
    async fn listen(&self, app: Arc<TeamsApp>, host: &str, port: u16) -> anyhow::Result<()> {
        let listener = tokio::net::TcpListener::bind((host, port)).await?;
        let addr = listener.local_addr()?;
        let shutdown = CancellationToken::new();
        let router = Self::bot_router(Arc::clone(&app));
        let token = shutdown.clone();
        let task = tokio::spawn(async move {
            if let Err(err) = crate::support::http::serve(listener, router, token).await {
                log_error!(
                    json!({ "err": err_json(&anyhow::Error::from(err)) }),
                    "[TeamsAdapter] bot server error"
                );
            }
        });
        *self.server.lock() = Some(BotServer {
            shutdown,
            task,
            addr,
        });
        *self.app.write() = Some(app);
        Ok(())
    }

    /// Serve `app` for `connection` on `host:port`. A failure is logged as
    /// `[TeamsAdapter] failed to initialize` and leaves the adapter idle.
    async fn start(
        &self,
        connection: TeamsConnectionRecord,
        app: anyhow::Result<Arc<TeamsApp>>,
        host: &str,
        port: u16,
    ) {
        *self.connection.write() = Some(connection.clone());
        let started = match app {
            Ok(app) => self.listen(app, host, port).await,
            Err(err) => Err(err),
        };
        if let Err(err) = started {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[TeamsAdapter] failed to initialize"
            );
            *self.app.write() = None;
            *self.server.lock() = None;
            *self.connection.write() = None;
            return;
        }

        log_info!(
            json!({
                "tenantId": connection.tenant_id,
                "endpoint": format!("http://{host}:{port}{TEAMS_MESSAGING_PATH}"),
            }),
            "[TeamsAdapter] initialized"
        );
        let mut props = agent_props();
        props.insert("teams.tenant".to_string(), connection.tenant_id.clone());
        track_event("teams adapter initialized", None, Some(props));
    }

    /// The handler of an inbound message activity, which answers at once:
    ///
    /// - dropped while stopped or with no working app (a failed initialize can
    ///   leave a valid Bot Service POST arriving with no app able to reply);
    /// - echoes of the bot's own posts (`from.id == recipient.id`) are ignored, so a
    ///   delivered reply never re-enters chat;
    /// - `recipient.id` is captured as the bot's account id;
    /// - a conversation that is neither `personal` nor `channel` is ignored (logged
    ///   at debug as `[TeamsAdapter] ignoring {type} conversation activity`); group
    ///   chats are out of scope in v1;
    /// - otherwise `process_message` runs in a task of its own, and its error is
    ///   logged as `[TeamsAdapter] failed to process activity` with `activityId`.
    fn on_message(&self, activity: TeamsActivity, cue: TypingCue) {
        if self.stopped.load(Ordering::SeqCst) || self.current_app().is_none() {
            return;
        }
        // Ignore echoes of the bot's own posts — a delivered reply must never
        // re-enter chat().
        if !activity.from.id.is_empty()
            && !activity.recipient.id.is_empty()
            && activity.from.id == activity.recipient.id
        {
            return;
        }
        if !activity.recipient.id.is_empty() {
            *self.bot_account_id.write() = Some(activity.recipient.id.clone());
        }

        // Group chats are out of scope in v1.
        let conversation_type = activity.conversation.conversation_type.as_deref();
        if conversation_type != Some("personal") && conversation_type != Some("channel") {
            log_debug!(
                "[TeamsAdapter] ignoring {} conversation activity",
                conversation_type.unwrap_or("undefined")
            );
            return;
        }

        // Ack the webhook fast: the turn runs for minutes, every reply goes
        // out proactively via deliver().
        let activity_id = activity.id.clone();
        tokio::spawn(async move {
            if let Err(err) = TEAMS_ADAPTER_SERVICE.process_message(activity, cue).await {
                log_error!(
                    json!({ "err": err_json(&err), "activityId": activity_id }),
                    "[TeamsAdapter] failed to process activity"
                );
            }
        });
    }

    /// The real work behind an inbound activity — runs after the webhook turn has
    /// already been acknowledged. A personal conversation goes to
    /// `handle_dm_message`, every other (a channel) to `handle_channel_message`.
    async fn process_message(&self, activity: TeamsActivity, cue: TypingCue) -> anyhow::Result<()> {
        if activity.conversation.conversation_type.as_deref() == Some("personal") {
            return self.handle_dm_message(&activity, &cue).await;
        }
        // The message handler already returns for any conversation type other than
        // personal or channel, so there is no other case to handle here.
        self.handle_channel_message(&activity, &cue).await
    }

    /// A personal-chat message: the link-code fast path, the "don't recognize this
    /// account" answer for an unlinked sender, the self-healing of the DM
    /// conversation id, then one chat turn on the thread keyed by the conversation id
    /// with `metadata: { channel: 'teams' }`.
    async fn handle_dm_message(
        &self,
        activity: &TeamsActivity,
        cue: &TypingCue,
    ) -> anyhow::Result<()> {
        let Some(connection) = self.connection.read().clone() else {
            return Ok(());
        };

        let conversation_id = activity.conversation.id.clone();
        let teams_user_id = activity
            .from
            .aad_object_id
            .clone()
            .unwrap_or_else(|| activity.from.id.clone());
        let text = self.extract_text(activity);
        if text.is_empty() && !has_attachments(activity) {
            return Ok(());
        }
        cue.signal().await;

        // Verification-code fast path (same 6-hex flow as Slack).
        if self.is_verification_code(&text) {
            let result = self
                .verify_dm_link_code(&text, &teams_user_id, &conversation_id)
                .await?;
            self.send_chunks(&conversation_id, None, &[result.reply()])
                .await;
            return Ok(());
        }

        let mapping = TEAMS_MAPPING_SERVICE
            .find_user_mapping(&connection.id, &teams_user_id)
            .await?;
        let Some((mapping, lens_user_id)) = mapping.and_then(|m| {
            let lens_user_id = m.mapping.lens_user_id.clone().filter(|id| !id.is_empty())?;
            Some((m.mapping, lens_user_id))
        }) else {
            self.send_chunks(
                &conversation_id,
                None,
                &["Hi! I don't recognize this Microsoft Teams account yet. Open the Lens Agents web app → \
                   Channels → Microsoft Teams, generate a link code, and send the 6-character code to me here."
                    .to_string()],
            )
            .await;
            return Ok(());
        };

        // Self-heal the proactive-send target if the conversation id drifted (and
        // capture it for rows linked before their first DM).
        if mapping.dm_conversation_id.as_deref() != Some(conversation_id.as_str()) {
            TEAMS_MAPPING_SERVICE
                .update_dm_conversation_id(&mapping.id, &conversation_id)
                .await?;
        }

        // Personal chats are keyed by their conversation id, DATABASE-sourced —
        // Teams pushes every activity, so no live thread provider is needed.
        let thread = CONVERSATION_SERVICE
            .get_or_create_thread_by_external_id(
                &lens_user_id,
                &mapping.agent_id,
                &conversation_id,
                None,
            )
            .await?;

        let files = self.read_files(activity, &thread.id).await;
        let message = if !text.is_empty() {
            text
        } else if !files.names.is_empty() {
            describe_shared_files(&files.names)
        } else {
            String::new()
        };
        if message.is_empty() {
            return Ok(());
        }

        let file_input = self.file_turn_input(&files);
        CONVERSATION_ENGINE_SERVICE
            .chat(ChatInput {
                user_id: lens_user_id,
                agent_id: mapping.agent_id.clone(),
                thread_id: Some(thread.id.clone()),
                message,
                metadata: Some(ChatMetadata {
                    channel: Some(ChannelName::Teams),
                    ..Default::default()
                }),
                attachment_ids: file_input.attachment_ids,
                runtime_notices: file_input.runtime_notices,
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    /// A channel message. The conversation id's `;messageid=` suffix is stripped for
    /// mapping storage and lookup and kept as the reply root (a top-level post, or a
    /// malformed empty suffix, is its own root). A message that does not mention the
    /// bot goes to `handle_unmentioned_reply`; a mention runs the link-code fast path,
    /// the "isn't linked" answer, or `run_channel_turn`.
    async fn handle_channel_message(
        &self,
        activity: &TeamsActivity,
        cue: &TypingCue,
    ) -> anyhow::Result<()> {
        if self.connection.read().is_none() {
            return Ok(());
        }

        // A channel activity's conversation id carries the thread root as a
        // ";messageid=" suffix. Strip it for mapping storage/lookup; keep the root
        // id for threaded replies. A top-level post is its own root, and so is a
        // malformed trailing suffix, which splits to an empty root.
        let mut parts = activity.conversation.id.split(";messageid=");
        let channel_conversation_id = parts.next().unwrap_or("").to_string();
        let root_message_id = parts
            .next()
            .filter(|root| !root.is_empty())
            .unwrap_or(&activity.id)
            .to_string();

        let text = self.extract_text(activity);
        if text.is_empty() && !has_attachments(activity) {
            return Ok(());
        }

        // With the channel-message permission Teams delivers every message in the
        // team, not only the ones that mention the bot.
        if !self.mentions_bot(activity) {
            if text.is_empty() {
                return Ok(());
            }
            return self
                .handle_unmentioned_reply(
                    activity,
                    &channel_conversation_id,
                    &root_message_id,
                    &text,
                    cue,
                )
                .await;
        }
        cue.signal().await;

        // Verification-code fast path — link this channel.
        if self.is_verification_code(&text) {
            let channel_name = self
                .resolve_channel_name(activity, &channel_conversation_id)
                .await;
            let result = self
                .verify_channel_link_code(&text, &channel_conversation_id, channel_name.as_deref())
                .await?;
            self.send_chunks(
                &channel_conversation_id,
                Some(&root_message_id),
                &[result.reply()],
            )
            .await;
            return Ok(());
        }

        let mapping = TEAMS_MAPPING_SERVICE
            .find_by_conversation_id(&channel_conversation_id)
            .await?;
        let Some((mapping, lens_user_id)) = mapping.and_then(|m| {
            let lens_user_id = m.mapping.lens_user_id.clone().filter(|id| !id.is_empty())?;
            Some((m.mapping, lens_user_id))
        }) else {
            self.send_chunks(
                &channel_conversation_id,
                Some(&root_message_id),
                &["This channel isn't linked to an agent yet. Open the Lens Agents web app → Channels → \
                   Microsoft Teams, generate a channel link code, and @mention me with the 6-character code."
                    .to_string()],
            )
            .await;
            return Ok(());
        };

        self.run_channel_turn(
            ChannelTurnMapping {
                lens_user_id,
                agent_id: mapping.agent_id,
                channel_name: mapping.channel_name,
            },
            activity,
            &channel_conversation_id,
            &root_message_id,
            &text,
        )
        .await
    }

    /// A message that does not mention the bot gets an answer only when it is a
    /// reply in a linked channel's reply chain the bot has answered in, and the
    /// thread classifier finds it asks the bot for something. A reply in such a
    /// chain that gets no answer is stored in the thread, so the next turn and
    /// the next classification read it. A message the agent sent to the channel
    /// has a thread, so a reply under it is classified too. Replies under
    /// heartbeat and scheduled-task output have no thread to find, so they need a
    /// mention. A reply that mentions somebody is addressed to them and ignored.
    ///
    /// An ignored reply is stored directly rather than through chat/claim-or-offer:
    /// it is history for the next turn and the next classification to read, not a
    /// turn of its own. If a turn claims this thread at this moment the running turn
    /// does not see the reply, and the stored order can be USER, USER, AGENT — which
    /// the provider accepts, since it merges consecutive user turns.
    async fn handle_unmentioned_reply(
        &self,
        activity: &TeamsActivity,
        channel_conversation_id: &str,
        root_message_id: &str,
        text: &str,
        cue: &TypingCue,
    ) -> anyhow::Result<()> {
        if root_message_id == activity.id {
            return Ok(());
        }

        let mapping = TEAMS_MAPPING_SERVICE
            .find_by_conversation_id(channel_conversation_id)
            .await?;
        let Some((mapping, lens_user_id)) = mapping.and_then(|m| {
            let lens_user_id = m.mapping.lens_user_id.clone().filter(|id| !id.is_empty())?;
            Some((m.mapping, lens_user_id))
        }) else {
            return Ok(());
        };
        let Some(thread) = CONVERSATION_SERVICE
            .find_thread_by_external_id(
                &lens_user_id,
                &mapping.agent_id,
                &format!("{channel_conversation_id};messageid={root_message_id}"),
            )
            .await?
        else {
            return Ok(());
        };

        let sender = self.sender(activity);
        // A reply that mentions somebody is addressed to them.
        let action = if self.mentions_anyone(activity) {
            ThreadAction::Ignore
        } else {
            self.classify_reply(&thread.id, &mapping.agent_id, &sender, text)
                .await?
        };

        if action == ThreadAction::Respond {
            cue.signal().await;
            return self
                .run_channel_turn(
                    ChannelTurnMapping {
                        lens_user_id,
                        agent_id: mapping.agent_id,
                        channel_name: mapping.channel_name,
                    },
                    activity,
                    channel_conversation_id,
                    root_message_id,
                    text,
                )
                .await;
        }

        let mut input = MessageInput::new(
            self.build_sender_tagged_content(&sender.id, sender.name.as_deref(), text),
            MessageRole::User,
            MessageTrigger::UserInput,
        );
        input.sender_external_id = Some(sender.id.clone());
        input.sender_name = sender.name.clone();
        CONVERSATION_SERVICE.add_message(&thread.id, input).await?;
        Ok(())
    }

    /// The reply chain's root, its recent history (`THREAD_TRANSCRIPT_LINES`, user
    /// and agent rows) and the arriving reply, for the classifier.
    async fn classify_reply(
        &self,
        thread_id: &str,
        agent_id: &str,
        sender: &ActivitySender,
        text: &str,
    ) -> anyhow::Result<ThreadAction> {
        let (root, recent) = tokio::try_join!(
            CONVERSATION_SERVICE.get_first_message(thread_id),
            CONVERSATION_SERVICE.get_recent_messages(
                thread_id,
                THREAD_TRANSCRIPT_LINES as i64,
                None
            ),
        )?;
        let history: Vec<&ConversationMessage> = recent
            .iter()
            .map(|m| &m.inner)
            .filter(|m| matches!(m.role, MessageRole::User | MessageRole::Agent))
            .collect();
        let agent = load_gate_agent().await?;
        let rows: Vec<&ConversationMessage> = match &root {
            Some(root) if !history.iter().any(|m| m.id == root.id) => {
                std::iter::once(root).chain(history).collect()
            }
            _ => history,
        };
        let mut lines: Vec<ThreadLine> = rows
            .into_iter()
            .map(|m| ThreadLine {
                author: if m.role == MessageRole::Agent {
                    ThreadAuthor {
                        kind: ThreadAuthorKind::Agent,
                        name: agent.name.clone(),
                    }
                } else {
                    self.author_of(
                        m.sender_external_id.as_deref().unwrap_or("unknown"),
                        m.sender_name.as_deref(),
                    )
                },
                text: if m.role == MessageRole::User {
                    self.strip_sender_tag(&m.content)
                } else {
                    m.content.clone()
                },
            })
            .collect();
        lines.push(ThreadLine {
            author: self.author_of(&sender.id, sender.name.as_deref()),
            text: text.to_string(),
        });
        Ok(THREAD_REPLY_CLASSIFIER_SERVICE
            .classify(&ClassifyInput {
                platform: ThreadPlatform {
                    channel: ChatPlatform::Teams,
                    name: "Microsoft Teams".to_string(),
                },
                agent_id: agent_id.to_string(),
                agent,
                lines,
            })
            .await)
    }

    /// A Bot Framework bot's account id is `28:<app id>`; a person's is their Entra object id.
    fn author_of(&self, id: &str, name: Option<&str>) -> ThreadAuthor {
        ThreadAuthor {
            kind: if id.starts_with("28:") {
                ThreadAuthorKind::Bot
            } else {
                ThreadAuthorKind::Person
            },
            name: name.unwrap_or(id).to_string(),
        }
    }

    /// One turn in the reply chain rooted at `root_message_id`: one conversation
    /// thread per reply chain, keyed `{channel};messageid={root}`, database-sourced.
    /// The message is sender-tagged, and the metadata names the channel, the reply
    /// root, the channel label and the sender.
    async fn run_channel_turn(
        &self,
        mapping: ChannelTurnMapping,
        activity: &TeamsActivity,
        channel_conversation_id: &str,
        root_message_id: &str,
        text: &str,
    ) -> anyhow::Result<()> {
        let sender = self.sender(activity);

        // One conversation thread per Teams reply chain, keyed by the threaded
        // conversation id. DATABASE-sourced (no live provider in v1).
        let thread = CONVERSATION_SERVICE
            .get_or_create_thread_by_external_id(
                &mapping.lens_user_id,
                &mapping.agent_id,
                &format!("{channel_conversation_id};messageid={root_message_id}"),
                None,
            )
            .await?;

        let files = self.read_files(activity, &thread.id).await;
        let message = if !text.is_empty() {
            text.to_string()
        } else if !files.names.is_empty() {
            describe_shared_files(&files.names)
        } else {
            String::new()
        };
        if message.is_empty() {
            return Ok(());
        }

        let file_input = self.file_turn_input(&files);
        CONVERSATION_ENGINE_SERVICE
            .chat(ChatInput {
                user_id: mapping.lens_user_id.clone(),
                agent_id: mapping.agent_id.clone(),
                thread_id: Some(thread.id.clone()),
                message: self.build_sender_tagged_content(
                    &sender.id,
                    sender.name.as_deref(),
                    &message,
                ),
                attachment_ids: file_input.attachment_ids,
                runtime_notices: file_input.runtime_notices,
                metadata: Some(ChatMetadata {
                    channel: Some(ChannelName::Teams),
                    channel_id: Some(channel_conversation_id.to_string()),
                    channel_thread_id: Some(root_message_id.to_string()),
                    channel_label: Some(teams_channel_label(
                        mapping
                            .channel_name
                            .as_deref()
                            .unwrap_or(channel_conversation_id),
                    )),
                    sender_external_id: Some(sender.id.clone()),
                    sender_name: sender.name.clone(),
                }),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    /// A channel message names the channel only sometimes, so the team's channel
    /// list is the source. That list shows the General channel, whose id is the
    /// team's id, without a name. A failed lookup links the channel unnamed (logged
    /// as `[TeamsAdapter] channel name lookup failed; linking the channel unnamed`).
    async fn resolve_channel_name(
        &self,
        activity: &TeamsActivity,
        channel_conversation_id: &str,
    ) -> Option<String> {
        let channel_data = activity.channel_data.as_ref();
        if let Some(named) = channel_data
            .and_then(|d| d.channel.as_ref())
            .and_then(|c| c.name.clone())
            .filter(|name| !name.is_empty())
        {
            return Some(named);
        }
        let team_id = channel_data
            .and_then(|d| d.team.as_ref())
            .map(|t| t.id.clone())
            .filter(|id| !id.is_empty())?;
        let app = self.current_app()?;
        match app.get_team_conversations(&team_id).await {
            Ok(channels) => channels
                .into_iter()
                .find(|c| c.id == channel_conversation_id)
                .and_then(|c| c.name)
                .or_else(|| (channel_conversation_id == team_id).then(|| "General".to_string())),
            Err(error) => {
                log_warn!(
                    json!({ "err": err_json(&error) }),
                    "[TeamsAdapter] channel name lookup failed; linking the channel unnamed"
                );
                None
            }
        }
    }

    // ========================================================================
    // Verification codes
    // ========================================================================

    fn is_verification_code(&self, text: &str) -> bool {
        VERIFICATION_CODE.is_match(js_trim(text))
    }

    /// Link a personal chat with a 6-hex `DM` code: the mapping is created and the
    /// code consumed in one transaction, with the conversation id that makes
    /// proactive DM sends possible. Personal and Team mode are mutually exclusive
    /// per agent. Emits `teams dm linked`.
    async fn verify_dm_link_code(
        &self,
        code: &str,
        teams_user_id: &str,
        dm_conversation_id: &str,
    ) -> anyhow::Result<VerificationResult> {
        let upper_code = code.to_uppercase();
        let Some(verification) = find_code(&upper_code, TeamsVerificationType::Dm).await? else {
            return Ok(VerificationResult::failed(
                "Invalid code. Please generate a new code from the Lens Agents web app.",
            ));
        };

        if Utc::now() > verification.expires_at {
            let _ = delete_code(&upper_code, TeamsVerificationType::Dm).await;
            return Ok(VerificationResult::failed(
                "Code expired. Please generate a new code from the Lens Agents web app.",
            ));
        }

        let (connection_id, user) = (
            verification.connection_id.clone(),
            teams_user_id.to_string(),
        );
        let existing_link: Option<TeamsMapping> = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::connection_id.eq(&connection_id))
                .filter(tm::teams_user_id.eq(&user))
                .select(TeamsMapping::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        if let Some(existing_link) = existing_link {
            if existing_link.lens_user_id.as_deref() == Some(verification.lens_user_id.as_str()) {
                return Ok(VerificationResult::failed(
                    "Your Teams account is already linked to another agent. Unlink it first from that agent's settings.",
                ));
            }
            return Ok(VerificationResult::failed(
                "This Teams account is already linked to another Lens Platform user.",
            ));
        }

        // Personal and Team mode are mutually exclusive per agent (docs/teams.md):
        // a channel-linked agent cannot also take a personal link.
        let agent_id = verification.agent_id.clone();
        let channel_link: Option<String> = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::agent_id.eq(&agent_id))
                .filter(tm::channel_conversation_id.is_not_null())
                .select(tm::id)
                .first(conn)
                .optional()?)
        })
        .await?;
        if channel_link.is_some() {
            return Ok(VerificationResult::failed(
                "This agent is linked to one or more channels. Unlink those channels before linking a personal chat.",
            ));
        }

        // Atomic: create mapping + consume code. The conversation id is captured
        // in the same transaction — it is what makes proactive DM sends possible.
        let mut row = NewTeamsMapping::new(
            verification.connection_id.clone(),
            verification.agent_id.clone(),
        );
        row.teams_user_id = Some(teams_user_id.to_string());
        row.lens_user_id = Some(verification.lens_user_id.clone());
        row.dm_conversation_id = Some(dm_conversation_id.to_string());
        row.tenant_id = self.connection.read().as_ref().map(|c| c.tenant_id.clone());
        link_and_consume(row, upper_code, TeamsVerificationType::Dm).await?;

        log_info!(
            "Teams account linked via code: {} -> {}",
            teams_user_id,
            verification.lens_user_id
        );
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), verification.agent_id.clone());
        track_event(
            "teams dm linked",
            Some(&verification.lens_user_id),
            Some(props),
        );

        Ok(VerificationResult {
            success: true,
            message: "Your Teams account is now linked to Lens Platform! You can now chat with your agent here."
                .to_string(),
            agent_name: None,
        })
    }

    /// Link a channel with a 6-hex `CHANNEL` code, in one transaction with the
    /// code's consumption. Personal and Team mode are mutually exclusive per agent.
    /// Emits `teams channel linked`.
    async fn verify_channel_link_code(
        &self,
        code: &str,
        channel_conversation_id: &str,
        channel_name: Option<&str>,
    ) -> anyhow::Result<VerificationResult> {
        let upper_code = code.to_uppercase();
        let Some(verification) = find_code(&upper_code, TeamsVerificationType::Channel).await?
        else {
            return Ok(VerificationResult::failed(
                "Invalid code. Please generate a new code from the Lens Agents web app.",
            ));
        };

        if Utc::now() > verification.expires_at {
            let _ = delete_code(&upper_code, TeamsVerificationType::Channel).await;
            return Ok(VerificationResult::failed(
                "Code expired. Please generate a new code from the Lens Agents web app.",
            ));
        }

        let conversation = channel_conversation_id.to_string();
        let existing: Option<String> = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::channel_conversation_id.eq(&conversation))
                .select(tm::id)
                .first(conn)
                .optional()?)
        })
        .await?;
        if existing.is_some() {
            return Ok(VerificationResult::failed(
                "This channel is already linked to an agent.",
            ));
        }

        // Personal and Team mode are mutually exclusive per agent (docs/teams.md):
        // a personally-linked agent cannot also take a channel link.
        let agent_id = verification.agent_id.clone();
        let dm_link: Option<String> = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::agent_id.eq(&agent_id))
                .filter(tm::dm_conversation_id.is_not_null())
                .select(tm::id)
                .first(conn)
                .optional()?)
        })
        .await?;
        if dm_link.is_some() {
            return Ok(VerificationResult::failed(
                "This agent is linked to a personal chat. Unlink that personal chat before linking a channel.",
            ));
        }

        let mut row = NewTeamsMapping::new(
            verification.connection_id.clone(),
            verification.agent_id.clone(),
        );
        row.channel_conversation_id = Some(channel_conversation_id.to_string());
        row.channel_name = channel_name.map(str::to_string);
        row.lens_user_id = Some(verification.lens_user_id.clone());
        row.teams_user_id = None;
        row.dm_conversation_id = None;
        row.tenant_id = self.connection.read().as_ref().map(|c| c.tenant_id.clone());
        link_and_consume(row, upper_code, TeamsVerificationType::Channel).await?;

        log_info!(
            "Teams channel linked via code: {} -> {}'s agent",
            channel_conversation_id,
            verification.lens_user_id
        );
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), verification.agent_id.clone());
        track_event(
            "teams channel linked",
            Some(&verification.lens_user_id),
            Some(props),
        );

        Ok(VerificationResult {
            success: true,
            message: format!(
                "Channel linked to {}! Mention me anytime you need help.",
                verification.agent_name.as_deref().unwrap_or("your agent")
            ),
            agent_name: verification.agent_name.clone(),
        })
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /// Inbound text. From `text` when present: the bot's own `<at>…</at>` mention
    /// removed entirely, other participants' names kept as plain text. When `text`
    /// is empty — a pasted or formatted message, whose body Teams puts only in a
    /// `text/html` attachment — from that attachment instead, so a pasted
    /// verification code is read like a typed one.
    fn extract_text(&self, activity: &TeamsActivity) -> String {
        let bot_account_id = self.bot_account_id.read().clone();
        let without_bot_mention = match bot_account_id {
            Some(account_id) => strip_mentions_text(activity, &account_id),
            None => activity.text.clone(),
        };
        let text = AT_TAG
            .replace_all(without_bot_mention.as_deref().unwrap_or(""), "")
            .into_owned();
        let text = js_trim(&text);
        if !text.is_empty() {
            return text.to_string();
        }
        // A pasted or formatted message can arrive with an empty `text` and its body
        // only in a text/html attachment (`<p>…</p>`). Read it so a pasted
        // verification code is recognised the same as a typed one.
        self.html_attachment_text(activity)
    }

    /// The text of a message's `text/html` attachment; empty when there is none.
    /// A pasted message carries its body here with `text` empty. The bot's own
    /// mention is removed whole (found through the mention entities that name it),
    /// so it does not prepend the bot's name and break a pasted code; other
    /// participants' mention tags are stripped but their names kept, as the `text`
    /// path does. Inline formatting is removed with no separator, so a code split
    /// across it (`a1<strong>b2</strong>c3`) rejoins; `<br>` and closing block tags
    /// become newlines, and only spaces and tabs are collapsed, so a multi-line
    /// paste keeps its lines.
    fn html_attachment_text(&self, activity: &TeamsActivity) -> String {
        let html = activity
            .attachments
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find_map(|a| match (&a.content_type, &a.content) {
                (Some(content_type), Some(Value::String(content)))
                    if content_type == "text/html" =>
                {
                    Some(content.clone())
                }
                _ => None,
            });
        let Some(html) = html.filter(|h| !h.is_empty()) else {
            return String::new();
        };
        let text = self.drop_bot_mentions(&html, activity);
        let text = HTML_BR.replace_all(&text, "\n");
        let text = HTML_BLOCK_END.replace_all(&text, "\n");
        let text = HTML_TAG.replace_all(&text, "");
        let text = HTML_NBSP.replace_all(&text, " ");
        let text = HTML_LT.replace_all(&text, "<");
        let text = HTML_GT.replace_all(&text, ">");
        let text = HTML_QUOT.replace_all(&text, "\"");
        let text = HTML_DEC.replace_all(&text, |caps: &regex::Captures| {
            char_reference(&caps[0], caps[1].parse::<u64>().ok())
        });
        let text = HTML_HEX.replace_all(&text, |caps: &regex::Captures| {
            char_reference(&caps[0], u64::from_str_radix(&caps[1], 16).ok())
        });
        let text = HTML_AMP.replace_all(&text, "&");
        let text = SPACES_AND_TABS.replace_all(&text, " ");
        js_trim(&text).to_string()
    }

    /// Remove the bot's own `<at>…</at>` mention elements from HTML, found through
    /// the mention entities whose account is the bot. Other mentions are left for
    /// the general tag strip, which keeps their names.
    fn drop_bot_mentions(&self, html: &str, activity: &TeamsActivity) -> String {
        let Some(bot_account_id) = self.bot_account_id.read().clone() else {
            return html.to_string();
        };
        let mut out = html.to_string();
        for entity in activity.entities.as_deref().unwrap_or_default() {
            let Some(mentioned) = entity.mentioned.as_ref() else {
                continue;
            };
            if entity.entity_type != "mention" || mentioned.id != bot_account_id {
                continue;
            }
            let Some(name) = mentioned.name.as_deref().filter(|n| !n.is_empty()) else {
                continue;
            };
            let pattern = format!(r"(?i)<at\b[^>]*>\s*{}\s*</at>", regex::escape(name));
            if let Ok(mention) = Regex::new(&pattern) {
                out = mention.replace_all(&out, "").into_owned();
            }
        }
        out
    }

    /// Read the message's files; a read that fails becomes a failure, never an error.
    async fn read_files(&self, activity: &TeamsActivity, thread_id: &str) -> TeamsInboundFiles {
        let Some(app) = self.current_app() else {
            return TeamsInboundFiles::default();
        };
        let Some(attachments) = activity.attachments.as_deref().filter(|a| !a.is_empty()) else {
            return TeamsInboundFiles::default();
        };
        read_inbound_files(Some(attachments), &AppFileFetchers { app }, Some(thread_id)).await
    }

    /// GET a pre-authenticated URL: no credential, through the runtime's proxy when
    /// one is set, within `FILE_DOWNLOAD_TIMEOUT_MS`. A non-2xx answer is a
    /// [`TeamsHttpError`]; a `content-length` past `MAX_FILE_SIZE_BYTES` is a
    /// `TeamsFileTooLargeError`.
    async fn fetch_plain(url: &str) -> anyhow::Result<Vec<u8>> {
        let client = match get_proxy_dispatcher().await {
            Some(proxied) => proxied,
            None => DIRECT_HTTP.clone(),
        };
        let res = client
            .get(url)
            .timeout(Duration::from_millis(FILE_DOWNLOAD_TIMEOUT_MS))
            .send()
            .await?;
        if !res.status().is_success() {
            return Err(TeamsHttpError::plain(res.status().as_u16()).into());
        }
        let declared = res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(crate::support::js::number_from)
            .unwrap_or(0.0);
        if declared > MAX_FILE_SIZE_BYTES as f64 {
            return Err(TeamsFileTooLargeError.into());
        }
        Ok(res.bytes().await?.to_vec())
    }

    /// The chat fields a message's files add: the stored ids and a notice for failures.
    fn file_turn_input(&self, files: &TeamsInboundFiles) -> FileTurnInput {
        FileTurnInput {
            attachment_ids: (!files.attachment_ids.is_empty())
                .then(|| files.attachment_ids.clone()),
            runtime_notices: (!files.failures.is_empty())
                .then(|| vec![build_file_failure_notice(&files.failures)]),
        }
    }

    /// Whether a mention entity names this bot (the activity's recipient).
    fn mentions_bot(&self, activity: &TeamsActivity) -> bool {
        activity
            .entities
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|entity| {
                entity.entity_type == "mention"
                    && entity
                        .mentioned
                        .as_ref()
                        .is_some_and(|m| m.id == activity.recipient.id)
            })
    }

    fn mentions_anyone(&self, activity: &TeamsActivity) -> bool {
        activity
            .entities
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|entity| entity.entity_type == "mention")
    }

    /// The AAD object id when Teams sends one, else the Bot Framework id.
    fn sender(&self, activity: &TeamsActivity) -> ActivitySender {
        ActivitySender {
            id: activity
                .from
                .aad_object_id
                .clone()
                .unwrap_or_else(|| activity.from.id.clone()),
            name: activity.from.name.clone(),
        }
    }

    /// The text of a stored channel message without its `build_sender_tagged_content` prefix.
    fn strip_sender_tag(&self, content: &str) -> String {
        SENDER_TAG.replace(content, "").into_owned()
    }

    /// Prefix channel messages with the sender so a multi-user history stays
    /// attributable — same `<@ID:Name>: text` shape the Slack adapter uses.
    fn build_sender_tagged_content(
        &self,
        teams_user_id: &str,
        sender_name: Option<&str>,
        text: &str,
    ) -> String {
        let Some(sender_name) = sender_name.filter(|n| !n.is_empty()) else {
            return text.to_string();
        };
        let cleaned = SENDER_NAME_UNSAFE.replace_all(sender_name, "");
        let sanitized = js_trim(&cleaned);
        let tag = if sanitized.is_empty() {
            format!("<@{teams_user_id}>")
        } else {
            format!("<@{teams_user_id}:{sanitized}>")
        };
        format!("{tag}: {text}")
    }

    /// A bot has no upload into a Teams channel, so each shared file is a link to
    /// the runtime's download route: at the public address when the runtime has
    /// one, else at this machine's own port, where a local install's browser runs.
    /// A container published on another host port needs `PRISM_PUBLIC_URL`.
    fn with_attachment_notice(
        &self,
        content: &str,
        attachments: Option<&[AttachmentMeta]>,
    ) -> String {
        let Some(attachments) = attachments.filter(|a| !a.is_empty()) else {
            return content.to_string();
        };
        let origin = CONFIG
            .public_url
            .clone()
            .unwrap_or_else(|| format!("http://localhost:{}", CONFIG.port));
        let links = attachments
            .iter()
            .map(|a| {
                format!(
                    "[{}]({}/agents/attachments/{})",
                    a.filename.replace(['[', ']'], ""),
                    origin,
                    utf8_percent_encode(&a.id, URI_COMPONENT)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{content}\n\n📎 Shared file{}: {links}",
            if attachments.len() > 1 { "s" } else { "" }
        )
    }

    /// Refuse a mention token that is not an AAD object id, or that names a person
    /// the conversation does not have as a member. The member lookup also gives
    /// the display name the `<at>` tag needs. An `<at>` tag the agent wrote has no
    /// entity behind it, so it is removed.
    async fn with_checked_mentions(
        &self,
        app: &TeamsApp,
        target: &LinkedTarget,
        text: &str,
    ) -> anyhow::Result<TeamsOutboundActivity> {
        let tokens: Vec<(String, String, Option<String>)> = MENTION_TOKEN
            .captures_iter(text)
            .map(|caps| {
                (
                    caps[0].to_string(),
                    caps[1].to_string(),
                    caps.get(2).map(|m| m.as_str().to_string()),
                )
            })
            .collect();
        for (token, id, _) in &tokens {
            if !AAD_OBJECT_ID.is_match(id) {
                return Err(SendRefusedError::new(
                    format!(
                        "{token} is not a Teams user mention. Mention a person as <@AAD-OBJECT-ID>, with the id from a message you have seen."
                    ),
                    "bad_mention",
                )
                .into());
            }
        }

        let mut members: IndexMap<String, TeamsChannelAccount> = IndexMap::new();
        for (_, id, embedded_name) in &tokens {
            if members.contains_key(id) {
                continue;
            }
            match app.get_member_by_id(&target.conversation_id, id).await {
                Ok(member) => {
                    let name = member.name.as_deref().unwrap_or("").replace(['<', '>'], "");
                    members.insert(
                        id.clone(),
                        TeamsChannelAccount {
                            id: member.id,
                            name: Some(name),
                            aad_object_id: None,
                            role: Some("user".to_string()),
                        },
                    );
                }
                Err(error) => {
                    if error_status(&error) != Some(404) {
                        return Err(error);
                    }
                    let shown = embedded_name
                        .as_deref()
                        .filter(|n| !n.is_empty())
                        .unwrap_or(id);
                    return Err(SendRefusedError::new(
                        format!(
                            "{shown} (<@{id}>) is not a member of {}, so the message was not sent. Mention only people in that conversation.",
                            describe_target(target)
                        ),
                        "not_member",
                    )
                    .into());
                }
            }
        }

        // An `<at>` tag the agent wrote has no entity behind it, so it is removed.
        let body = AGENT_AT_TAG.replace_all(text, "");
        let body = MENTION_TOKEN.replace_all(&body, |caps: &regex::Captures| {
            let name = members
                .get(&caps[1])
                .and_then(|m| m.name.as_deref())
                .unwrap_or("undefined");
            format!("<at>{name}</at>")
        });
        let mut activity = TeamsOutboundActivity::message(body.into_owned());
        for member in members.into_values() {
            let name = member.name.clone().unwrap_or_default();
            activity.add_mention(member, &name);
        }
        Ok(activity)
    }

    /// Runs after the post, so a failed lookup is logged
    /// (`[TeamsAdapter] posted, but the channel mapping could not be read for its history`):
    /// the message is sent either way.
    async fn history_of(
        &self,
        target: &LinkedTarget,
        root_message_id: &str,
    ) -> Option<PostedHistory> {
        if target.kind == LinkedTargetKind::Dm {
            return target
                .dm_user_id
                .as_ref()
                .filter(|id| !id.is_empty())
                .map(|user_id| PostedHistory {
                    user_id: user_id.clone(),
                    thread_key: target.conversation_id.clone(),
                });
        }
        let mapping = match TEAMS_MAPPING_SERVICE
            .find_by_conversation_id(&target.conversation_id)
            .await
        {
            Ok(mapping) => mapping,
            Err(err) => {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[TeamsAdapter] posted, but the channel mapping could not be read for its history"
                );
                None
            }
        };
        let user_id = mapping?.mapping.lens_user_id.filter(|id| !id.is_empty())?;
        Some(PostedHistory {
            user_id,
            thread_key: format!("{};messageid={root_message_id}", target.conversation_id),
        })
    }

    /// Send chunks sequentially to one conversation — threaded when a root
    /// message id is given. Retries 429s honoring Retry-After. Logs, never
    /// fails: the message is already persisted. A failed chunk stops the rest
    /// (they would arrive out of order), is logged as `[TeamsAdapter] send failed`
    /// and emits `teams message send failed`.
    async fn send_chunks(
        &self,
        conversation_id: &str,
        root_message_id: Option<&str>,
        chunks: &[String],
    ) -> bool {
        let Some(app) = self.current_app() else {
            return false;
        };
        let root = root_message_id.filter(|r| !r.is_empty());
        for chunk in chunks {
            let activity = TeamsOutboundActivity::message(chunk.clone());
            let result = self
                .send_with_retry(|| async {
                    match root {
                        Some(root) => app.reply(conversation_id, root, &activity).await,
                        None => app.send(conversation_id, &activity).await,
                    }
                })
                .await;
            if let Err(error) = result {
                log_error!(
                    json!({ "err": err_json(&error), "conversationId": conversation_id }),
                    "[TeamsAdapter] send failed"
                );
                let mut props = agent_props();
                props.extend(error_shape(&error));
                track_event("teams message send failed", None, Some(props));
                return false; // remaining chunks of a failed message would arrive out of order
            }
        }
        true
    }

    /// Retry a send on a 429 up to `SEND_RETRIES` times, after the Retry-After delay
    /// or `1000 * (attempt + 1)` ms.
    async fn send_with_retry<F, Fut>(&self, send: F) -> anyhow::Result<TeamsSentActivity>
    where
        F: Fn() -> Fut + Send + Sync,
        Fut: std::future::Future<Output = anyhow::Result<TeamsSentActivity>> + Send,
    {
        let mut attempt: u32 = 0;
        loop {
            match send().await {
                Ok(sent) => return Ok(sent),
                Err(error) => {
                    if error_status(&error) != Some(429) || attempt >= SEND_RETRIES {
                        return Err(error);
                    }
                    let delay = retry_after_ms(&error).unwrap_or(1000 * (u64::from(attempt) + 1));
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    attempt += 1;
                }
            }
        }
    }

    /// The address the bot's listener is bound to, while it runs.
    #[cfg(test)]
    fn bound_addr(&self) -> Option<SocketAddr> {
        self.server.lock().as_ref().map(|s| s.addr)
    }
}

/// Whether an activity carries any attachment.
fn has_attachments(activity: &TeamsActivity) -> bool {
    activity
        .attachments
        .as_deref()
        .is_some_and(|a| !a.is_empty())
}

/// `stripMentionsText(activity, { accountId })`: the text with the first copy of
/// each mention of `account_id` removed, trimmed; `None` when there is no text.
fn strip_mentions_text(activity: &TeamsActivity, account_id: &str) -> Option<String> {
    let mut text = activity.text.clone().filter(|t| !t.is_empty())?;
    for mention in activity
        .entities
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|e| e.entity_type == "mention")
    {
        let Some(mentioned) = mention.mentioned.as_ref() else {
            continue;
        };
        if mentioned.id != account_id {
            continue;
        }
        if let Some(tag) = mention.text.as_deref().filter(|t| !t.is_empty()) {
            text = text.replacen(tag, "", 1);
        } else if let Some(name) = mentioned.name.as_deref().filter(|n| !n.is_empty()) {
            text = text.replacen(&format!("<at>{name}</at>"), "", 1);
        }
    }
    Some(js_trim(&text).to_string())
}

/// The verification code `(code, type)`.
async fn find_code(
    code: &str,
    kind: TeamsVerificationType,
) -> anyhow::Result<Option<TeamsVerificationCode>> {
    let code = code.to_string();
    crate::db::run(move |conn| {
        Ok(tvc::table
            .filter(tvc::code.eq(&code))
            .filter(tvc::type_.eq(kind))
            .select(TeamsVerificationCode::as_select())
            .first(conn)
            .optional()?)
    })
    .await
}

/// Delete the verification code `(code, type)`.
async fn delete_code(code: &str, kind: TeamsVerificationType) -> anyhow::Result<()> {
    let code = code.to_string();
    crate::db::run(move |conn| {
        diesel::delete(
            tvc::table
                .filter(tvc::code.eq(&code))
                .filter(tvc::type_.eq(kind)),
        )
        .execute(conn)?;
        Ok(())
    })
    .await
}

/// Create the mapping and consume its code, in one transaction. A code another
/// request consumed first fails the whole link.
async fn link_and_consume(
    row: NewTeamsMapping,
    code: String,
    kind: TeamsVerificationType,
) -> anyhow::Result<()> {
    crate::db::run(move |conn| {
        conn.transaction(|conn| {
            diesel::insert_into(tm::table).values(&row).execute(conn)?;
            let deleted = diesel::delete(
                tvc::table
                    .filter(tvc::code.eq(&code))
                    .filter(tvc::type_.eq(kind)),
            )
            .execute(conn)?;
            if deleted == 0 {
                anyhow::bail!(
                    "An operation failed because it depends on one or more records that were required but not found. No record was found for a delete."
                );
            }
            Ok(())
        })
    })
    .await
}

/// The first DM conversation of `user_id` with `agent_id`.
async fn find_dm_conversation(user_id: &str, agent_id: &str) -> anyhow::Result<Option<String>> {
    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    let dm: Option<Option<String>> = crate::db::run(move |conn| {
        Ok(tm::table
            .filter(tm::lens_user_id.eq(&user))
            .filter(tm::agent_id.eq(&agent))
            .filter(tm::dm_conversation_id.is_not_null())
            .select(tm::dm_conversation_id)
            .first(conn)
            .optional()?)
    })
    .await?;
    Ok(dm.flatten())
}

#[async_trait]
impl ChannelAdapter for TeamsAdapterService {
    fn name(&self) -> ChannelName {
        ChannelName::Teams
    }

    fn display_name(&self) -> Option<&str> {
        Some("Microsoft Teams")
    }

    /// Start the bot: with the Teams env set, build the app and listen on
    /// `TEAMS_PORT` at the runtime's own bind address (`PRISM_HOST`) for
    /// `TEAMS_MESSAGING_PATH`. Logs `[TeamsAdapter] initialized` with `tenantId`
    /// and `endpoint`, and emits `teams adapter initialized`.
    ///
    /// Without the env it logs `[TeamsAdapter] Teams not configured; adapter idle`.
    /// Any failure is logged as `[TeamsAdapter] failed to initialize` and releases
    /// whatever was started, so a failed initialize leaks nothing and a retry starts
    /// clean; it is never returned. Once listening, a failed serve is logged as
    /// `[TeamsAdapter] bot server error`.
    async fn initialize(&self) -> anyhow::Result<()> {
        if self.current_app().is_some() {
            return Ok(()); // already initialized
        }
        self.stopped.store(false, Ordering::SeqCst);
        let Some(connection) = get_teams_config().await else {
            log_info!("[TeamsAdapter] Teams not configured; adapter idle");
            return Ok(());
        };
        let app = TeamsApp::from_env(
            CONFIG.teams_app_id.as_deref().unwrap_or_default(),
            CONFIG.teams_app_password.as_deref().unwrap_or_default(),
            CONFIG.teams_app_tenant_id.as_deref().unwrap_or_default(),
        )
        .await
        .map(Arc::new);
        self.start(connection, app, &CONFIG.host, CONFIG.teams_port)
            .await;
        Ok(())
    }

    /// Stop the bot and its listener. Emits `teams adapter shutdown` when it was active.
    async fn shutdown(&self) -> anyhow::Result<()> {
        self.stopped.store(true, Ordering::SeqCst);
        let was_active = self.current_app().is_some();
        let server = self.server.lock().take();
        if let Some(server) = server {
            server.shutdown.cancel();
            if let Err(error) = server.task.await {
                log_debug!("[TeamsAdapter] stop failed: Error: {}", error);
            }
        }
        *self.app.write() = None;
        *self.connection.write() = None;
        *self.bot_account_id.write() = None;
        if was_active {
            track_event("teams adapter shutdown", None, Some(agent_props()));
        }
        Ok(())
    }

    /// Whether the user has any Teams mapping, while the adapter is active.
    async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        if self.current_app().is_none() {
            return Ok(false);
        }
        Ok(TEAMS_MAPPING_SERVICE.count_all_mappings(user_id).await? > 0)
    }

    /// A Teams thread continues where it started. A channel thread stores
    /// `{channelConversationId};messageid={rootMessageId}`, so a continuation
    /// posts into the original reply chain. A DM thread stores no reply chain and
    /// carries no channel id, so the user's personal conversation is resolved:
    /// the continuation stays in the DM instead of the mapping broadcast. When
    /// nothing resolves it logs a warning that a "continue in thread" resume will
    /// not be delivered.
    async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> Option<anyhow::Result<ChannelDestination>> {
        let thread_id = thread_id.to_string();
        let origin_channel_id = origin_channel_id.map(str::to_string);
        let resolve = async move {
            let id = thread_id.clone();
            let thread: Option<(String, String, Option<String>)> = crate::db::run(move |conn| {
                Ok(ct::table
                    .filter(ct::id.eq(&id))
                    .select((ct::user_id, ct::agent_id, ct::external_thread_id))
                    .first(conn)
                    .optional()?)
            })
            .await?;
            let external = thread
                .as_ref()
                .and_then(|(_, _, external)| external.clone())
                .unwrap_or_default();
            let mut parts = external.split(";messageid=");
            let channel_conversation_id = parts.next().unwrap_or("");
            let root_message_id = parts.next().unwrap_or("");
            if !channel_conversation_id.is_empty() && !root_message_id.is_empty() {
                return Ok(ChannelDestination {
                    channel_id: Some(channel_conversation_id.to_string()),
                    channel_thread_id: Some(root_message_id.to_string()),
                    channel_label: Some(teams_channel_label(channel_conversation_id)),
                });
            }
            let mut channel_id = origin_channel_id.filter(|id| !id.is_empty());
            if channel_id.is_none()
                && let Some((user_id, agent_id, _)) = &thread
            {
                channel_id = find_dm_conversation(user_id, agent_id).await?;
            }
            if channel_id.is_none() {
                log_warn!(
                    "No Teams conversation resolved for thread {} (no origin channel id and no DM mapping) — a \"continue in thread\" resume will not be delivered",
                    thread_id
                );
            }
            // Personal chats have no reply chains, so the continuation posts top-level.
            Ok(ChannelDestination {
                channel_label: channel_id.as_deref().map(teams_channel_label),
                channel_id,
                channel_thread_id: None,
            })
        };
        Some(resolve.await)
    }

    /// The user's personal conversation, else the agent's main linked channel. A
    /// channel destination carries its id: a Teams context without one is
    /// DM-scoped and would deliver nothing in Team Mode.
    async fn default_destination(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> Option<anyhow::Result<Option<DefaultDestination>>> {
        let resolve = async {
            if let Some(dm) = find_dm_conversation(user_id, agent_id)
                .await?
                .filter(|dm| !dm.is_empty())
            {
                return Ok(Some(DefaultDestination {
                    destination: ChannelDestination::default(),
                    thread_key: dm,
                }));
            }
            let main_channel = TEAMS_MAPPING_SERVICE.get_main_channel(agent_id).await?;
            Ok(main_channel
                .filter(|main| !main.is_empty())
                .map(|main| DefaultDestination {
                    destination: ChannelDestination {
                        channel_id: Some(main.clone()),
                        ..Default::default()
                    },
                    thread_key: main,
                }))
        };
        Some(resolve.await)
    }

    /// Deliver a message to Teams — always a proactive send.
    ///
    /// - Channel-scoped (a Teams context with a channel id): threaded reply under the
    ///   originating root activity.
    /// - DM-scoped (a Teams context without a channel id): the user's personal
    ///   conversations only.
    /// - Broadcast (no context — heartbeat/cron/goal): every DM mapping plus exactly
    ///   ONE channel, the agent's main channel (flagged, else the oldest linked).
    ///
    /// `include_feedback` is ignored on Teams in v1 — feedback buttons need Adaptive
    /// Card actions, which are deferred. Emits `teams message delivered`. Logs, never
    /// fails: the message is already persisted.
    async fn deliver(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) -> anyhow::Result<()> {
        if self.current_app().is_none() {
            return Ok(());
        }

        let tool_calls = match &message.inner.tool_calls {
            Some(Value::Array(calls)) => Some(calls.clone()),
            _ => None,
        };
        let chunks = format_teams_message(
            &self.with_attachment_notice(&message.inner.content, message.attachments.as_deref()),
            Some(&FormatTeamsMessageOptions {
                triggered_by: Some(message.inner.triggered_by.as_str().to_string()),
                tool_calls,
            }),
        );

        let teams_context = channel_context.filter(|c| c.channel == ChannelName::Teams);

        // Channel-scoped delivery: reply into the originating thread.
        if let Some(channel_id) = teams_context
            .and_then(|c| c.channel_id.as_deref())
            .filter(|id| !id.is_empty())
        {
            let thread = teams_context.and_then(|c| c.channel_thread_id.as_deref());
            if self.send_chunks(channel_id, thread, &chunks).await {
                let mut props = agent_props();
                props.insert("teams.delivery".to_string(), "channel".to_string());
                track_event("teams message delivered", Some(user_id), Some(props));
            }
            return Ok(());
        }

        // Scope by agent when the thread is known (mirrors the Slack adapter).
        let thread_id = message.inner.thread_id.clone();
        let thread_agent_id: Option<String> = crate::db::run(move |conn| {
            Ok(ct::table
                .filter(ct::id.eq(&thread_id))
                .select(ct::agent_id)
                .first(conn)
                .optional()?)
        })
        .await?;
        let (user, agent) = (user_id.to_string(), thread_agent_id.clone());
        let mappings: Vec<TeamsMapping> = crate::db::run(move |conn| {
            let mut query = tm::table
                .filter(tm::lens_user_id.eq(&user))
                .order(tm::created_at.asc())
                .select(TeamsMapping::as_select())
                .into_boxed();
            if let Some(agent_id) = agent.filter(|id| !id.is_empty()) {
                query = query.filter(tm::agent_id.eq(agent_id));
            }
            Ok(query.load(conn)?)
        })
        .await?;
        if mappings.is_empty() {
            return Ok(());
        }

        // DM-scoped: a Teams DM turn carries a context without a channel id.
        // Post only to the user's personal conversations — never a channel.
        let dm_scoped = teams_context.is_some();

        // Autonomous output lands in exactly ONE channel — the main channel
        // (flagged, else oldest) — never every linked channel.
        let main_channel_id = if dm_scoped {
            None
        } else {
            let channels: Vec<&TeamsMapping> = mappings
                .iter()
                .filter(|m| {
                    m.channel_conversation_id
                        .as_deref()
                        .is_some_and(|c| !c.is_empty())
                })
                .collect();
            channels
                .iter()
                .find(|m| m.is_main_channel)
                .or_else(|| channels.first())
                .and_then(|m| m.channel_conversation_id.clone())
        };

        let mut delivered = 0;
        for mapping in &mappings {
            if let Some(dm) = mapping
                .dm_conversation_id
                .as_deref()
                .filter(|d| !d.is_empty())
            {
                // Personal chats have no threads — always post top-level.
                if self.send_chunks(dm, None, &chunks).await {
                    delivered += 1;
                }
            }
            if let Some(channel) = mapping
                .channel_conversation_id
                .as_deref()
                .filter(|c| !c.is_empty())
                && main_channel_id.as_deref() == Some(channel)
                && self.send_chunks(channel, None, &chunks).await
            {
                delivered += 1;
            }
        }

        if delivered > 0 {
            let mut props = IndexMap::new();
            if let Some(agent_id) = thread_agent_id.filter(|id| !id.is_empty()) {
                props.insert("agent.id".to_string(), agent_id);
            }
            props.insert("teams.delivery".to_string(), "mapping".to_string());
            props.insert("teams.mappings".to_string(), delivered.to_string());
            track_event("teams message delivered", Some(user_id), Some(props));
        }
        Ok(())
    }

    /// The agent's linked channels (the main one flagged, else the oldest) and DMs.
    async fn list_linked_targets(
        &self,
        agent_id: &str,
    ) -> Option<anyhow::Result<Vec<LinkedTarget>>> {
        let agent = agent_id.to_string();
        let mappings = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::agent_id.eq(&agent))
                .order(tm::created_at.asc())
                .select(TeamsMapping::as_select())
                .load::<TeamsMapping>(conn)?)
        })
        .await;
        let mappings = match mappings {
            Ok(mappings) => mappings,
            Err(err) => return Some(Err(err)),
        };
        let channels: Vec<&TeamsMapping> = mappings
            .iter()
            .filter(|m| {
                m.channel_conversation_id
                    .as_deref()
                    .is_some_and(|c| !c.is_empty())
            })
            .collect();
        let main_channel_id = channels
            .iter()
            .find(|m| m.is_main_channel)
            .or_else(|| channels.first())
            .and_then(|m| m.channel_conversation_id.clone());

        let mut targets = Vec::new();
        for mapping in &mappings {
            if let Some(channel) = mapping
                .channel_conversation_id
                .as_deref()
                .filter(|c| !c.is_empty())
            {
                targets.push(LinkedTarget {
                    key: format!("teams:{channel}"),
                    platform: ChatPlatform::Teams,
                    kind: LinkedTargetKind::Channel,
                    conversation_id: channel.to_string(),
                    name: mapping.channel_name.clone(),
                    is_main: main_channel_id.as_deref() == Some(channel),
                    dm_user_id: None,
                });
            }
            if let Some(dm) = mapping
                .dm_conversation_id
                .as_deref()
                .filter(|d| !d.is_empty())
            {
                targets.push(LinkedTarget {
                    key: format!("teams:{dm}"),
                    platform: ChatPlatform::Teams,
                    kind: LinkedTargetKind::Dm,
                    conversation_id: dm.to_string(),
                    name: mapping
                        .teams_user_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .map(|id| format!("<@{id}>")),
                    is_main: false,
                    dm_user_id: mapping.lens_user_id.clone(),
                });
            }
        }
        Some(Ok(targets))
    }

    /// One proactive send, threaded under `thread` when given. Each mention token
    /// becomes an `<at>` tag with a matching mention entity, which is what makes
    /// Teams notify the person. Errors reach the caller, a tool that reports the
    /// outcome to the agent. Teams history is stored, so the result names the
    /// thread the inbound path keys a reply into: the personal chat, or the
    /// channel's reply chain under the thread root or the new message.
    ///
    /// Refuses (`SendRefusedError`) with `not_connected` when the adapter is idle,
    /// `bad_thread` for a thread that is not a message id or a thread in a personal
    /// chat, and `bad_mention` / `not_member` for a mention it cannot honor.
    async fn post_to_target(
        &self,
        target: &LinkedTarget,
        text: &str,
        thread: Option<&str>,
    ) -> Option<anyhow::Result<PostedMessage>> {
        let post = async {
            let Some(app) = self.current_app() else {
                return Err(SendRefusedError::new(
                    "Microsoft Teams is not connected, so nothing can be sent there.",
                    "not_connected",
                )
                .into());
            };
            if let Some(thread) = thread {
                if !TEAMS_MESSAGE_ID.is_match(thread) {
                    return Err(SendRefusedError::new(
                        format!(
                            "\"{thread}\" is not a Teams thread id. A thread id is the id of the thread's first message, a number."
                        ),
                        "bad_thread",
                    )
                    .into());
                }
                if target.kind == LinkedTargetKind::Dm {
                    return Err(SendRefusedError::new(
                        "A Teams personal chat has no threads. Send without a thread id.",
                        "bad_thread",
                    )
                    .into());
                }
            }

            let activity = self.with_checked_mentions(&app, target, text).await?;
            let sent = self
                .send_with_retry(|| async {
                    match thread {
                        Some(thread) => app.reply(&target.conversation_id, thread, &activity).await,
                        None => app.send(&target.conversation_id, &activity).await,
                    }
                })
                .await?;
            let message_id = sent.id.unwrap_or_else(|| "undefined".to_string());
            let history = self.history_of(target, thread.unwrap_or(&message_id)).await;
            Ok(PostedMessage {
                message_id,
                history,
            })
        };
        Some(post.await)
    }
}

pub static TEAMS_ADAPTER_SERVICE: LazyLock<TeamsAdapterService> =
    LazyLock::new(TeamsAdapterService::new);

#[cfg(test)]
#[path = "teams_adapter_service_tests.rs"]
mod tests;
