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

use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use async_trait::async_trait;
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::lib::teams_config::TeamsConnectionRecord;
use crate::services::attachment_service::AttachmentMeta;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, DefaultDestination,
    DeliverableMessage, LinkedTarget, PostedHistory, PostedMessage,
};
use crate::services::teams::teams_attachments::{
    TeamsFileFetchers, TeamsInboundAttachment, TeamsInboundFiles,
};
use crate::services::thread_reply_classifier_service::{
    ThreadAction, ThreadAuthor, ThreadAuthorKind,
};

/// The public messaging endpoint registered on the Azure Bot resource.
pub const TEAMS_MESSAGING_PATH: &str = "/agents/teams/messages";

/// How long one inbound file download may take.
const FILE_DOWNLOAD_TIMEOUT_MS: u64 = 30_000;

/// Proactive-send retries on 429 (Retry-After honored when present).
const SEND_RETRIES: u32 = 2;

/// Where proactive sends go when `SERVICE_URL` is unset, trailing slashes removed.
const DEFAULT_SERVICE_URL: &str = "https://smba.trafficmanager.net/teams";

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Each `{ type: 'mention', mentioned: { id, name, role: 'user' }, text: '<at>name</at>' }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<TeamsEntity>,
}

impl TeamsOutboundActivity {
    /// A message activity with this text and no mentions.
    pub fn message(text: impl Into<String>) -> Self {
        TeamsOutboundActivity {
            activity_type: "message".to_string(),
            text: Some(text.into()),
            entities: Vec::new(),
        }
    }

    /// A typing activity, the brief working cue Teams expires after a few seconds.
    pub fn typing() -> Self {
        TeamsOutboundActivity {
            activity_type: "typing".to_string(),
            text: None,
            entities: Vec::new(),
        }
    }
}

/// What the connector answers a send with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsSentActivity {
    #[serde(default)]
    pub id: String,
}

/// A failed Bot Framework, Graph or download request: its HTTP status, and the
/// `Retry-After` delay when the response named one. A 429 is retried on it; a
/// 401/403 on a file read becomes a permission failure; a 404 on a member lookup
/// means the person is not in the conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("HTTP {status}")]
pub struct TeamsHttpError {
    pub status: u16,
    pub retry_after_ms: Option<u64>,
}

// ============================================================================
// The Bot Framework app
// ============================================================================

/// A token and when it stops being usable.
#[derive(Debug, Clone)]
struct CachedToken {
    value: String,
    expires_at: Instant,
}

/// The Bot Framework signing keys an inbound JWT is checked against, and when
/// they were read from the OpenID metadata.
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
    service_url: String,
    http: reqwest::Client,
    bot_token: tokio::sync::Mutex<Option<CachedToken>>,
    graph_token: tokio::sync::Mutex<Option<CachedToken>>,
    signing_keys: tokio::sync::Mutex<Option<CachedSigningKeys>>,
}

impl TeamsApp {
    fn new(client_id: &str, client_secret: &str, tenant_id: &str) -> anyhow::Result<Self> {
        todo!()
    }

    /// Acquire the bot token once, which validates the credentials.
    async fn initialize(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Validate the Bot Framework JWT of an inbound request: signature against the
    /// published keys, issuer, audience (the app id) and the `serviceUrl` claim
    /// against the activity's.
    async fn validate_request(
        &self,
        headers: &http::HeaderMap,
        activity: &TeamsActivity,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Post a top-level activity into a conversation. A non-2xx answer is a
    /// [`TeamsHttpError`].
    async fn send(
        &self,
        conversation_id: &str,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        todo!()
    }

    /// Post an activity into the reply chain rooted at `root_message_id`.
    async fn reply(
        &self,
        conversation_id: &str,
        root_message_id: &str,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        todo!()
    }

    /// Send an activity in the context of an inbound one, at its service URL.
    async fn send_in_context(
        &self,
        inbound: &TeamsActivity,
        activity: &TeamsOutboundActivity,
    ) -> anyhow::Result<TeamsSentActivity> {
        todo!()
    }

    /// One member of a conversation. A 404 is a [`TeamsHttpError`] with status 404.
    async fn get_member_by_id(
        &self,
        conversation_id: &str,
        member_id: &str,
    ) -> anyhow::Result<TeamsChannelAccount> {
        todo!()
    }

    /// The channels of a team.
    async fn get_team_conversations(&self, team_id: &str) -> anyhow::Result<Vec<TeamsChannelInfo>> {
        todo!()
    }

    /// GET with the bot's token, at most `max_bytes` and `FILE_DOWNLOAD_TIMEOUT_MS`.
    async fn bot_get(&self, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
        todo!()
    }

    /// GET with the app's Graph token, at most `max_bytes` and `FILE_DOWNLOAD_TIMEOUT_MS`.
    async fn graph_get(&self, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
        todo!()
    }
}

/// The bot's own listener on `TEAMS_PORT`, serving `TEAMS_MESSAGING_PATH` alone.
struct BotServer {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
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
        todo!()
    }

    async fn graph(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        todo!()
    }

    async fn plain(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        todo!()
    }
}

/// The brief working cue for one inbound activity: a typing activity in its
/// conversation, sent in the activity's context. A failure is logged at debug as
/// `[TeamsAdapter] typing activity failed: {error}`.
struct TypingCue {
    app: Arc<TeamsApp>,
    activity: TeamsActivity,
}

impl TypingCue {
    async fn signal(&self) {
        todo!()
    }
}

/// The outcome of a link code.
#[derive(Debug, Clone, PartialEq, Eq)]
struct VerificationResult {
    success: bool,
    message: String,
    agent_name: Option<String>,
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
fn error_shape(error: &anyhow::Error) -> Map<String, Value> {
    todo!()
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
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
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
        *self.server.lock() = None;
        *self.connection.write() = None;
        *self.bot_account_id.write() = None;
        self.stopped.store(false, Ordering::SeqCst);
    }

    /// The router of the bot's own listener: `POST TEAMS_MESSAGING_PATH` alone.
    ///
    /// A request whose JWT does not validate is refused before anything else. The
    /// handler acknowledges at once and does the work in a spawned task:
    ///
    /// - dropped while stopped or with no working app (a failed initialize can
    ///   leave a valid Bot Service POST arriving with no app able to reply);
    /// - echoes of the bot's own posts (`from.id == recipient.id`) are ignored, so a
    ///   delivered reply never re-enters chat;
    /// - `recipient.id` is captured as the bot's account id;
    /// - a conversation that is neither `personal` nor `channel` is ignored (logged
    ///   at debug as `[TeamsAdapter] ignoring {type} conversation activity`); group
    ///   chats are out of scope in v1;
    /// - otherwise `process_message` runs, and its error is logged as
    ///   `[TeamsAdapter] failed to process activity` with `activityId`.
    fn bot_router(&'static self, app: Arc<TeamsApp>) -> axum::Router {
        todo!()
    }

    /// The real work behind an inbound activity — runs after the webhook turn has
    /// already been acknowledged. A personal conversation goes to
    /// `handle_dm_message`, every other (a channel) to `handle_channel_message`.
    async fn process_message(&self, activity: TeamsActivity, cue: TypingCue) -> anyhow::Result<()> {
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Remove the bot's own `<at>…</at>` mention elements from HTML, found through
    /// the mention entities whose account is the bot. Other mentions are left for
    /// the general tag strip, which keeps their names.
    fn drop_bot_mentions(&self, html: &str, activity: &TeamsActivity) -> String {
        todo!()
    }

    /// Read the message's files; a read that fails becomes a failure, never an error.
    async fn read_files(&self, activity: &TeamsActivity, thread_id: &str) -> TeamsInboundFiles {
        todo!()
    }

    /// GET a pre-authenticated URL: no credential, through the runtime's proxy when
    /// one is set, within `FILE_DOWNLOAD_TIMEOUT_MS`. A non-2xx answer is a
    /// [`TeamsHttpError`]; a `content-length` past `MAX_FILE_SIZE_BYTES` is a
    /// `TeamsFileTooLargeError`.
    async fn fetch_plain(url: &str) -> anyhow::Result<Vec<u8>> {
        todo!()
    }

    /// The chat fields a message's files add: the stored ids and a notice for failures.
    fn file_turn_input(&self, files: &TeamsInboundFiles) -> FileTurnInput {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Runs after the post, so a failed lookup is logged
    /// (`[TeamsAdapter] posted, but the channel mapping could not be read for its history`):
    /// the message is sent either way.
    async fn history_of(
        &self,
        target: &LinkedTarget,
        root_message_id: &str,
    ) -> Option<PostedHistory> {
        todo!()
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
        todo!()
    }

    /// Retry a send on a 429 up to `SEND_RETRIES` times, after the Retry-After delay
    /// or `1000 * (attempt + 1)` ms.
    async fn send_with_retry<F, Fut>(&self, send: F) -> anyhow::Result<TeamsSentActivity>
    where
        F: Fn() -> Fut + Send + Sync,
        Fut: std::future::Future<Output = anyhow::Result<TeamsSentActivity>> + Send,
    {
        todo!()
    }
}

#[async_trait]
impl ChannelAdapter for TeamsAdapterService {
    fn name(&self) -> ChannelName {
        ChannelName::Teams
    }

    fn display_name(&self) -> Option<&str> {
        Some("Microsoft Teams")
    }

    /// Start the bot: with the Teams env set, build the app, validate its
    /// credentials, and listen on `TEAMS_PORT` at the runtime's own bind address
    /// (`PRISM_HOST`) for `TEAMS_MESSAGING_PATH`. Logs `[TeamsAdapter] initialized`
    /// with `tenantId` and `endpoint`, and emits `teams adapter initialized`.
    ///
    /// Without the env it logs `[TeamsAdapter] Teams not configured; adapter idle`.
    /// Any failure is logged as `[TeamsAdapter] failed to initialize` and releases
    /// whatever was started, so a failed initialize leaks nothing and a retry starts
    /// clean; it is never returned. Once listening, a failed accept is logged as
    /// `[TeamsAdapter] bot server error` and the listener keeps running, since this
    /// port faces the internet.
    async fn initialize(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Stop the bot and its listener. Emits `teams adapter shutdown` when it was active.
    async fn shutdown(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Whether the user has any Teams mapping, while the adapter is active.
    async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        todo!()
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
        todo!()
    }

    /// The user's personal conversation, else the agent's main linked channel. A
    /// channel destination carries its id: a Teams context without one is
    /// DM-scoped and would deliver nothing in Team Mode.
    async fn default_destination(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> Option<anyhow::Result<Option<DefaultDestination>>> {
        todo!()
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
        todo!()
    }

    /// The agent's linked channels (the main one flagged, else the oldest) and DMs.
    async fn list_linked_targets(
        &self,
        agent_id: &str,
    ) -> Option<anyhow::Result<Vec<LinkedTarget>>> {
        todo!()
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
        todo!()
    }
}

pub static TEAMS_ADAPTER_SERVICE: LazyLock<TeamsAdapterService> =
    LazyLock::new(TeamsAdapterService::new);
