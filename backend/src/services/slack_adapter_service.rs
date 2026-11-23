//! Slack Adapter Service
//!
//! Implements `ChannelAdapter` for Slack message delivery over Socket Mode.
//! Handles incoming Slack messages and routes them through the local conversation engine.
//!
//! Key features:
//! - Socket Mode for real-time bidirectional communication
//! - One app (Socket Mode client plus Web API client) per connected workspace
//! - Message delivery via DM channel (personal mode) or Slack channel (team mode)
//! - Incoming message handling via local `CONVERSATION_ENGINE_SERVICE.chat()`
//! - Channel support for team agent participation

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use dashmap::DashMap;
use diesel::prelude::*;
use futures::future::{BoxFuture, FutureExt, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::constants::{MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB};
use crate::db::models::{
    ConversationMessage, ConversationThread, MessageRole, MessageTrigger,
    NewConversationParticipant, NewSlackMapping, SlackMapping, SlackVerificationCode,
    SlackVerificationType, ThreadSource,
};
use crate::db::schema::conversation_messages::dsl as cm;
use crate::db::schema::conversation_participants::dsl as cp;
use crate::db::schema::conversation_threads::dsl as ct;
use crate::db::schema::slack_mappings::dsl as m;
use crate::db::schema::slack_verification_codes::dsl as vc;
use crate::lib::log_redaction::err_json;
use crate::lib::proxy_dispatcher::get_proxy_dispatcher;
use crate::lib::slack_config::{SlackMode, clear_slack_config, reload_slack_config, slack_mode};
use crate::lib::slack_source::{get_active_slack_connections, get_slack_connection};
use crate::lib::slack_web_client::{
    FileUpload, SlackWebClient, may_receive_slack_token, slack_platform_error_code,
};
use crate::lib::telemetry::track_event;
use crate::queues::slack_heartbeat_throttle_queue::get_slack_heartbeat_throttle_queue;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::attachment_service::{
    ATTACHMENT_SERVICE, AttachmentMeta, AttachmentSource, CreateAttachmentInput,
    classify_media_type, detect_media_type, thread_scoped_file_id,
};
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, ChatPlatform,
    DefaultDestination, DeliverableMessage, LinkedTarget, LinkedTargetKind, MENTION_TOKEN,
    PostedHistory, PostedMessage, SendRefusedError, describe_target,
};
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata,
};
use crate::services::conversation_service::MessageInput;
use crate::services::conversation_service::{CONVERSATION_SERVICE, LiveThread};
use crate::services::heartbeat_service::HEARTBEAT_SERVICE;
use crate::services::providers::slack_thread_provider::SlackThreadProvider;
use crate::services::slack_heartbeat_trigger_service::SLACK_HEARTBEAT_TRIGGER_SERVICE;
use crate::services::slack_mapping_service::SLACK_MAPPING_SERVICE;
use crate::services::slack_message_queue_service::{
    SLACK_MESSAGE_QUEUE_SERVICE, slack_trigger_source,
};
use crate::services::slack_router_envelope::{LinkOp, RoutedLink, SlackEnvelope, SlackRoute};
use crate::services::slack_router_service::{HandOff, SLACK_ROUTER_SERVICE, SlackRouterHandlers};
use crate::services::slack_socket_mode::{
    EnvelopeHandler, SocketEnvelope, SocketModeApp, SocketModeClient,
};
use crate::services::slack_socket_retire::{StoppableApp, retire_socket_app};
use crate::services::slack_socket_watchdog::{SOCKET_STALL_MS, SocketWatch, watch_socket};
use crate::services::slack_working_indicator::{
    SlackIndicatorOps, SlackWorkingIndicator, WorkingIndicatorHandle, WorkingIndicatorTarget,
    create_tool_status_listener,
};
use crate::services::thread_reply_classifier_service::{
    ClassifyInput, THREAD_REPLY_CLASSIFIER_SERVICE, THREAD_TRANSCRIPT_LINES, ThreadAction,
    ThreadAuthor, ThreadAuthorKind, ThreadLine, ThreadPlatform, load_gate_agent,
};
use crate::support::js::{slice16, trim as js_trim};
use crate::types::ChannelTriggerMessage;
use crate::utils::poll_until::PollUntilOptions;
use crate::utils::slack_formatter::{
    FEEDBACK_ACK_BLOCK_ID, FEEDBACK_ACTION_DOWN, FEEDBACK_ACTION_UP, FEEDBACK_BLOCK_ID,
    FeedbackRating, FormatSlackMessageOptions, FormattedSlackMessage, SlackBlock,
    build_feedback_ack_block, format_slack_message, slack_channel_label,
};
use crate::{log_debug, log_error, log_info, log_warn};

// ============================================================================
// Tunables
// ============================================================================

/// Duration (ms) to keep the inline "Thanks for the feedback!" ack visible
/// before auto-removing it via a second chat.update. Short enough to feel
/// transient, long enough that the clicker registers the confirmation.
pub const FEEDBACK_ACK_LINGER_MS: u64 = 3000;

/// A Slack user id: `U…`, or `W…` on an Enterprise Grid org.
static SLACK_USER_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[UW][A-Z0-9]{2,}$").unwrap());

/// Slack's special-mention syntax. Each such token notifies a channel or a group.
static SLACK_SPECIAL_MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<!").unwrap());

/// A Slack message ts, which is also a thread id.
static SLACK_TS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+$").unwrap());

/// How long a send waits for the boot's Socket Mode start, which has no time limit of its own.
const SEND_CONNECT_WAIT_MS: u64 = 30_000;

/// How long a `users.info` answer is reused.
const USER_INFO_TTL_MS: i64 = 5 * 60 * 1000;

/// The link code a message is, after Slack formatting is stripped.
static LINK_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Fa-f0-9]{6}$").unwrap());

/// Slack formatting characters around a link code.
static SLACK_FORMATTING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_~`]").unwrap());

/// Characters a display name loses inside a `<@ID:Name>` token.
static MENTION_NAME_STRIP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[<>:\x00-\x1f]").unwrap());

/// A bare `<@USERID>` mention.
static BARE_MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<@([A-Z0-9]+)>").unwrap());

/// An id the outbound rewrite treats as a Slack user id.
static SLACK_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z0-9]+$").unwrap());

/// The message a code that matches no stored code answers.
fn code_not_valid(agent_name: &str) -> String {
    format!(
        "That code is not valid. Generate a new code for {agent_name} under Settings → Channels."
    )
}

/// The message an expired code answers.
fn code_expired(agent_name: &str) -> String {
    format!(
        "That code has expired. Generate a new code for {agent_name} under Settings → Channels."
    )
}

/// A user-group handle at the start of a message, which addresses an agent in
/// routed mode.
static LEADING_USER_GROUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>").unwrap());

/// A user-group handle anywhere in a message, with its `@handle` label when
/// Slack gives one.
static USER_GROUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>").unwrap());

/// The sender tag a stored channel message starts with (`build_sender_tagged_content`).
static SENDER_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<@[^>]+>: ").unwrap());

/// The most messages read from a Slack thread the agent joins in routed mode.
const JOINED_THREAD_READ_LIMIT: u32 = 200;

/// A Slack event the router delivered, as the listeners see it. `route` says
/// how the router addressed it to this agent. `hand_off` ends the event's
/// record just before its message is stored, by `chat()` or as an unanswered
/// thread reply, so a restart during the turn resumes the turn from the stored
/// message and does not handle the event again. A crash between those two
/// writes loses the event.
pub(crate) struct RoutedEvent {
    route: SlackRoute,
    hand_off: HandOff,
}

/// A message of a Slack thread the agent joins in routed mode.
#[derive(Debug, Clone, Default, Deserialize)]
struct JoinedThreadMessage {
    #[serde(default)]
    ts: String,
    user: Option<String>,
    bot_id: Option<String>,
    username: Option<String>,
    text: Option<String>,
}

/// A routed message's text without the app's mentions. On a `mention` or `dm`
/// the user-group handle at its start addressed it to this agent, so it goes
/// too. Any other handle names an agent, so it stays as its plain `@handle`: a
/// `thread_reply` reaches this agent because it takes part in the thread, and
/// a handle at its start addresses the reply to another agent.
fn without_address(text: &str, bot_user_id: &str, route: SlackRoute) -> String {
    let without_mentions = js_trim(&text.replace(&format!("<@{bot_user_id}>"), "")).to_string();
    let addressed = matches!(route, SlackRoute::Mention | SlackRoute::Dm);
    let text = if addressed {
        js_trim(&LEADING_USER_GROUP.replace(&without_mentions, "")).to_string()
    } else {
        without_mentions
    };
    USER_GROUP
        .replace_all(&text, |captures: &regex::Captures<'_>| {
            captures
                .get(1)
                .map_or(String::new(), |label| label.as_str().to_string())
        })
        .into_owned()
}

/// A read of a joined Slack thread that concurrent messages of the thread share.
type JoinedThreadRead = Shared<BoxFuture<'static, Result<(), Arc<anyhow::Error>>>>;

/// Whether a message tags somebody other than the bot, which addresses it to them.
fn tags_somebody_else(text: &str, bot_user_id: &str) -> bool {
    BARE_MENTION
        .captures_iter(text)
        .any(|captures| &captures[1] != bot_user_id)
}

// ============================================================================
// Types
// ============================================================================

/// The fields of a thread message the gate reads. A bot's message has `bot_id`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GateMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot_profile: Option<GateBotProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    files: Vec<SlackFileMeta>,
}

/// A thread message as the reply gate reads it: its text, then the files it has.
fn gate_text(message: &GateMessage) -> String {
    let files = if message.files.is_empty() {
        String::new()
    } else {
        describe_shared_files(&message.files)
    };
    [message.text.clone().unwrap_or_default(), files]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct GateBotProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

/// The fields of `users.info` the adapter reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SlackUserInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    real_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    is_bot: Option<bool>,
}

impl SlackUserInfo {
    /// `real_name || name`.
    fn display_name(&self) -> Option<&str> {
        self.real_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .or(self.name.as_deref().filter(|n| !n.is_empty()))
    }
}

/// The participation rule's verdict. `Respond` passes the message on to the
/// thread classifier; `React` puts 👀 on a message addressed to another person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThreadParticipation {
    Respond,
    Ignore,
    React,
}

/// A Socket Mode app the adapter started. `stop` ends its watch and retires its client.
struct SocketHandle {
    client: Arc<SocketModeClient>,
    watch: Mutex<Option<SocketWatch>>,
    /// Cancelled by `stop`, which ends a start that is still waiting.
    stopped: CancellationToken,
    team_id: String,
}

impl SocketHandle {
    async fn stop(&self) {
        if let Some(watch) = self.watch.lock().take() {
            watch.stop();
        }
        self.stopped.cancel();
        let app = SocketModeApp(self.client.clone());
        let client = self.client.clone();
        if let Err(error) =
            retire_socket_app(&app, client.as_ref(), || client.retire_requests()).await
        {
            log_warn!(
                json!({ "err": err_json(&error), "teamId": self.team_id }),
                "Failed to stop a Slack Socket Mode app"
            );
        }
    }
}

/// One connected workspace: its Web API client and the bot's identity there.
pub struct SlackApp {
    /// The Web API client for the workspace.
    pub client: Arc<SlackWebClient>,
    /// The workspace's Socket Mode client, stopped at shutdown or disconnect.
    /// `None` without an app token.
    pub socket: Option<Arc<SocketModeClient>>,
    pub team_id: String,
    pub team_name: String,
    pub is_socket_mode: bool,
    pub bot_user_id: String,
    /// The listeners' context the router's events are handed to, in routed mode.
    routed: Option<Arc<ConnectionContext>>,
}

/// A connected workspace as the Channels page lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedWorkspace {
    pub team_id: String,
    pub team_name: String,
    pub bot_user_id: String,
}

/// The fields of a Slack file object, on a message event or in a thread read, that
/// the runtime reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct SlackFileMeta {
    pub(crate) id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mimetype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url_private: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url_private_download: Option<String>,
}

/// Where to download a Slack file from (`Ok`), or why it cannot be downloaded
/// (`Err`), decided from the file's metadata alone, so a file that can never be
/// stored takes no download.
pub(crate) fn slack_file_source(file: &SlackFileMeta) -> Result<&str, String> {
    if let Some(size) = file.size
        && size > MAX_FILE_SIZE_BYTES
    {
        return Err(format!("it exceeds the {MAX_FILE_SIZE_MB} MB limit"));
    }
    file.url_private_download
        .as_deref()
        .filter(|u| !u.is_empty())
        .or(file.url_private.as_deref().filter(|u| !u.is_empty()))
        .ok_or_else(|| "Slack returned no download URL for it".to_string())
}

impl SlackFileMeta {
    /// `name || 'file'`.
    fn filename(&self) -> String {
        self.name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "file".to_string())
    }
}

/// A file we couldn't ingest, surfaced to the agent so it can tell the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SlackFileFailure {
    pub(crate) filename: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SlackFileDownloadResult {
    pub(crate) attachment_ids: Vec<String>,
    pub(crate) failures: Vec<SlackFileFailure>,
}

/// Where a downloaded file came from: the carrying message's ts and the thread
/// that scopes a later lookup.
#[derive(Debug, Clone, Default)]
pub(crate) struct SlackFileContext {
    pub(crate) external_ts: Option<String>,
    pub(crate) thread_id: Option<String>,
    /// A thread read's download: the file is keyed to `thread_id`, so a file already
    /// stored for another thread is stored again for this one.
    pub(crate) thread_scoped: bool,
    /// Ends a download in flight; the file then fails with `DOWNLOAD_STOPPED`.
    pub(crate) signal: Option<CancellationToken>,
}

/// Why a file failed when its read's deadline stopped the download.
const DOWNLOAD_STOPPED: &str = "the thread read ran out of time to download it";

/// The outcome of a link code check, as the reply to the user words it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkResult {
    success: bool,
    message: String,
    agent_name: Option<String>,
}

impl LinkResult {
    fn refused(message: &str) -> Self {
        LinkResult {
            success: false,
            message: message.to_string(),
            agent_name: None,
        }
    }
}

/// What redeeming a DM link code did.
#[derive(Debug, Clone)]
pub(crate) enum DmCodeOutcome {
    /// No `DM` code with that text.
    Invalid,
    /// The code had expired, and was deleted.
    Expired,
    /// The Slack user is already mapped on the code's connection, to the code's own user.
    LinkedToSameUser,
    /// The Slack user is already mapped on the code's connection, to someone else.
    LinkedToOtherUser,
    /// The mapping was created and the code consumed.
    Linked(SlackVerificationCode),
}

/// What redeeming a channel link code did.
#[derive(Debug, Clone)]
pub(crate) enum ChannelCodeOutcome {
    Invalid,
    Expired,
    /// The channel is already mapped.
    AlreadyLinked,
    Linked(SlackVerificationCode),
}

/// The stored code with this text and type.
fn find_code(
    conn: &mut SqliteConnection,
    code: &str,
    kind: SlackVerificationType,
) -> anyhow::Result<Option<SlackVerificationCode>> {
    Ok(vc::slack_verification_codes
        .filter(vc::code.eq(code))
        .filter(vc::type_.eq(kind))
        .select(SlackVerificationCode::as_select())
        .first(conn)
        .optional()?)
}

/// Deletes the stored code with this text and type; fails when there is none.
fn delete_code(
    conn: &mut SqliteConnection,
    code: &str,
    kind: SlackVerificationType,
) -> anyhow::Result<()> {
    let deleted = diesel::delete(
        vc::slack_verification_codes
            .filter(vc::code.eq(code))
            .filter(vc::type_.eq(kind)),
    )
    .execute(conn)?;
    if deleted == 0 {
        anyhow::bail!(
            "An operation failed because it depends on one or more records that were required but not found. No record was found for a delete."
        );
    }
    Ok(())
}

use diesel::SqliteConnection;

/// Redeems a DM link code for `slack_user_id` in `dm_channel_id`: the user
/// mapping is created and the code consumed in one transaction. The code is
/// matched in upper case.
pub(crate) async fn redeem_dm_code(
    code: &str,
    slack_user_id: &str,
    dm_channel_id: &str,
) -> anyhow::Result<DmCodeOutcome> {
    let upper_code = code.to_uppercase();
    let lookup = upper_code.clone();
    let verification =
        crate::db::read(move |conn| find_code(conn, &lookup, SlackVerificationType::Dm)).await?;

    let Some(verification) = verification else {
        return Ok(DmCodeOutcome::Invalid);
    };

    if chrono::Utc::now() > verification.expires_at {
        let expired = upper_code.clone();
        let _ = crate::db::run(move |conn| delete_code(conn, &expired, SlackVerificationType::Dm))
            .await;
        return Ok(DmCodeOutcome::Expired);
    }

    // Check if this Slack user is already linked to someone
    let (connection, user) = (
        verification.connection_id.clone(),
        slack_user_id.to_string(),
    );
    let existing: Option<SlackMapping> = crate::db::read(move |conn| {
        Ok(m::slack_mappings
            .filter(m::connection_id.eq(&connection))
            .filter(m::slack_user_id.eq(&user))
            .select(SlackMapping::as_select())
            .first(conn)
            .optional()?)
    })
    .await?;

    if let Some(existing) = existing {
        if existing.lens_user_id.as_deref() == Some(verification.lens_user_id.as_str()) {
            return Ok(DmCodeOutcome::LinkedToSameUser);
        }
        return Ok(DmCodeOutcome::LinkedToOtherUser);
    }

    // Atomic: create mapping + consume code
    let mut row = NewSlackMapping::new(
        verification.connection_id.clone(),
        verification.agent_id.clone(),
    );
    row.slack_user_id = Some(slack_user_id.to_string());
    row.lens_user_id = Some(verification.lens_user_id.clone());
    row.dm_channel_id = Some(dm_channel_id.to_string());
    crate::db::run(move |conn| {
        conn.transaction(|conn| {
            diesel::insert_into(m::slack_mappings)
                .values(&row)
                .execute(conn)?;
            delete_code(conn, &upper_code, SlackVerificationType::Dm)
        })
    })
    .await?;

    Ok(DmCodeOutcome::Linked(verification))
}

/// Redeems a channel link code for `channel_id`: the channel mapping (named
/// `channel_name`) is created and the code consumed in one transaction.
pub(crate) async fn redeem_channel_code(
    code: &str,
    channel_id: &str,
    channel_name: Option<String>,
) -> anyhow::Result<ChannelCodeOutcome> {
    let upper_code = code.to_uppercase();
    let lookup = upper_code.clone();
    let verification =
        crate::db::read(move |conn| find_code(conn, &lookup, SlackVerificationType::Channel))
            .await?;

    let Some(verification) = verification else {
        return Ok(ChannelCodeOutcome::Invalid);
    };

    if chrono::Utc::now() > verification.expires_at {
        let expired = upper_code.clone();
        let _ =
            crate::db::run(move |conn| delete_code(conn, &expired, SlackVerificationType::Channel))
                .await;
        return Ok(ChannelCodeOutcome::Expired);
    }

    // Check if this channel is already linked
    let channel = channel_id.to_string();
    let existing: Option<String> = crate::db::read(move |conn| {
        Ok(m::slack_mappings
            .filter(m::slack_channel_id.eq(&channel))
            .select(m::id)
            .first(conn)
            .optional()?)
    })
    .await?;
    if existing.is_some() {
        return Ok(ChannelCodeOutcome::AlreadyLinked);
    }

    // Atomic: create channel mapping + consume code
    let mut row = NewSlackMapping::new(
        verification.connection_id.clone(),
        verification.agent_id.clone(),
    );
    row.slack_channel_id = Some(channel_id.to_string());
    row.slack_channel_name = channel_name;
    row.lens_user_id = Some(verification.lens_user_id.clone());
    row.slack_user_id = None;
    row.dm_channel_id = None;
    crate::db::run(move |conn| {
        conn.transaction(|conn| {
            diesel::insert_into(m::slack_mappings)
                .values(&row)
                .execute(conn)?;
            delete_code(conn, &upper_code, SlackVerificationType::Channel)
        })
    })
    .await?;

    Ok(ChannelCodeOutcome::Linked(verification))
}

/// The part of a Web API client that a feedback click updates the message with.
#[async_trait]
pub trait FeedbackChatClient: Send + Sync {
    /// `chat.update` with the given arguments.
    async fn chat_update(&self, args: serde_json::Value) -> anyhow::Result<serde_json::Value>;
}

#[async_trait]
impl FeedbackChatClient for SlackWebClient {
    async fn chat_update(&self, args: Value) -> anyhow::Result<Value> {
        self.api_call("chat.update", args).await
    }
}

/// Placeholder body for a Slack message whose only content is its file(s).
/// Used for the stored chat message AND the heartbeat-trigger queue, so a file
/// event never becomes an empty-text entry that silently drops the fact that a
/// file was shared.
fn describe_shared_files(files: &[SlackFileMeta]) -> String {
    let names = files
        .iter()
        .map(SlackFileMeta::filename)
        .collect::<Vec<_>>()
        .join(", ");
    if files.len() > 1 {
        format!("(shared files: {names})")
    } else {
        format!("(shared a file: {names})")
    }
}

/// `{ 'agent.id': config.agentId }` when an agent id is set.
fn agent_props() -> IndexMap<String, String> {
    let mut props = IndexMap::new();
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        props.insert("agent.id".to_string(), agent_id);
    }
    props
}

/// A string field of a JSON object, when it is a non-empty string.
fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// A stored message's tool calls as the formatter reads them.
fn tool_call_list(tool_calls: Option<&Value>) -> Option<&[Value]> {
    match tool_calls {
        Some(Value::Array(calls)) => Some(calls.as_slice()),
        _ => None,
    }
}

/// `String(response.ts)`.
fn ts_of(response: &Value) -> Option<String> {
    response
        .get("ts")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The workspace a socket's events belong to.
struct ConnectionContext {
    connection_id: String,
    team_id: String,
    team_name: String,
    bot_id: String,
    bot_user_id: String,
    client: Arc<SlackWebClient>,
}

/// Posts into the conversation an event came from, as Bolt's `say` does.
struct Say {
    client: SlackWebClient,
    channel: String,
}

impl Say {
    /// `say(text)`.
    async fn text(&self, text: &str) -> anyhow::Result<()> {
        self.client
            .api_call(
                "chat.postMessage",
                json!({ "text": text, "channel": self.channel }),
            )
            .await?;
        Ok(())
    }

    /// `say({ text, thread_ts })`.
    async fn in_thread(&self, text: &str, thread_ts: &str) -> anyhow::Result<()> {
        self.client
            .api_call(
                "chat.postMessage",
                json!({ "text": text, "thread_ts": thread_ts, "channel": self.channel }),
            )
            .await?;
        Ok(())
    }
}

/// The client that reached Slack for a file download: through `HTTPS_PROXY` when
/// one is set, else directly, following redirects as `fetch` does.
static FILE_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("build the Slack file client")
});

// ============================================================================
// Slack Adapter Service
// ============================================================================

pub struct SlackAdapterService {
    /// Active Slack apps by teamId
    apps: DashMap<String, Arc<SlackApp>>,
    /// The boot's Socket Mode starts, settled whether or not they connected.
    started: Mutex<Shared<BoxFuture<'static, ()>>>,
    /// Each team's current Socket Mode app. A rebuild or a late start whose handle
    /// is not here belongs to an app that was replaced or shut down.
    sockets: DashMap<String, Arc<SocketHandle>>,
    /// Reads the live Slack thread; used here to await read-consistency.
    slack_thread_provider: SlackThreadProvider,
    /// Working indicator (thread status, with an eyes-reaction fallback) shown
    /// while a user-initiated turn runs. Created on first use; dropped at
    /// shutdown, since a stopped indicator refuses new turns for good.
    working_indicator: Mutex<Option<Arc<SlackWorkingIndicator>>>,
    /// Cache of user connections for quick lookup: lensUserId -> teamIds
    user_connection_cache: DashMap<String, HashSet<String>>,
    /// `users.info` answers by `<teamId>:<userId>`, with their expiry (epoch ms),
    /// so the thread gate names a thread's members without a call each time.
    user_info_cache: DashMap<String, (SlackUserInfo, i64)>,
    /// A routed reconnect in progress, which concurrent callers share.
    connecting: Mutex<Option<Shared<BoxFuture<'static, Result<(), Arc<anyhow::Error>>>>>>,
    /// The reads of joined Slack threads in progress, by stored thread id
    /// (routed mode).
    joined_thread_reads: Mutex<HashMap<String, JoinedThreadRead>>,
}

impl SlackAdapterService {
    pub const NAME: ChannelName = ChannelName::Slack;
    pub const DISPLAY_NAME: &'static str = "Slack";

    pub fn new() -> Self {
        SlackAdapterService {
            apps: DashMap::new(),
            started: Mutex::new(futures::future::ready(()).boxed().shared()),
            sockets: DashMap::new(),
            slack_thread_provider: SlackThreadProvider::new(),
            working_indicator: Mutex::new(None),
            user_connection_cache: DashMap::new(),
            user_info_cache: DashMap::new(),
            connecting: Mutex::new(None),
            joined_thread_reads: Mutex::new(HashMap::new()),
        }
    }

    /// The working indicator, created on first use.
    fn working_indicator(&self) -> Arc<SlackWorkingIndicator> {
        self.working_indicator
            .lock()
            .get_or_insert_with(|| {
                Arc::new(SlackWorkingIndicator::new(Arc::new(AdapterIndicatorOps)))
            })
            .clone()
    }

    /// The app of a team as it is now, without waiting for the boot's starts.
    fn app(&self, team_id: &str) -> Option<Arc<SlackApp>> {
        self.apps.get(team_id).map(|app| app.value().clone())
    }

    /// Get the Slack app for a team, once the boot's Socket Mode starts have
    /// settled. Work the boot continues reads and delivers before the socket is up,
    /// and waits here.
    pub async fn get_app_for_team(&self, team_id: &str) -> Option<Arc<SlackApp>> {
        let started = self.started.lock().clone();
        started.await;
        self.app(team_id)
    }

    /// The team's app once the boot's Socket Mode start settles, or none after `SEND_CONNECT_WAIT_MS`.
    async fn app_for_send(&self, team_id: &str) -> Option<Arc<SlackApp>> {
        tokio::time::timeout(
            Duration::from_millis(SEND_CONNECT_WAIT_MS),
            self.get_app_for_team(team_id),
        )
        .await
        .ok()
        .flatten()
    }

    /// List metadata for every connected Slack workspace. Used by the
    /// Web UI to display workspace name + bot user on the Channels page.
    pub fn list_connected_workspaces(&self) -> Vec<ConnectedWorkspace> {
        self.apps
            .iter()
            .map(|app| ConnectedWorkspace {
                team_id: app.team_id.clone(),
                team_name: app.team_name.clone(),
                bot_user_id: app.bot_user_id.clone(),
            })
            .collect()
    }

    /// Deliver a message to the user via Slack DM or channel.
    ///
    /// If `channel_context` is for Slack and names a channel, delivers to that
    /// channel. Otherwise, sends to the user's DM mappings and the agent's main
    /// linked channel (the flagged channel, else the oldest), so autonomous
    /// output lands in exactly one channel.
    pub async fn deliver(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) -> anyhow::Result<()> {
        let include_feedback = channel_context.and_then(|c| c.include_feedback) == Some(true);
        let attachments: &[AttachmentMeta] = message.attachments.as_deref().unwrap_or(&[]);
        let row = &message.inner;
        let tool_calls = tool_call_list(row.tool_calls.as_ref());

        // If channelContext is provided and it's for Slack, deliver to that channel
        if let Some(context) = channel_context.filter(|c| c.channel == ChannelName::Slack)
            && let Some(channel_id) = context.channel_id.as_deref().filter(|id| !id.is_empty())
        {
            self.deliver_to_channel(
                channel_id,
                &row.content,
                &context.thread_id,
                context.channel_thread_id.as_deref(),
                row.tool_calls.as_ref(),
                Some(&row.id),
                include_feedback,
                attachments,
                Some(row.triggered_by.as_str()),
            )
            .await?;
            let mut props = agent_props();
            props.insert("slack.delivery".to_string(), "channel".to_string());
            track_event("slack message delivered", Some(user_id), Some(props));
            return Ok(());
        }

        // Look up agentId from the message's thread to scope delivery
        let thread_id = row.thread_id.clone();
        let thread_agent_id: Option<String> = crate::db::read(move |conn| {
            Ok(ct::conversation_threads
                .filter(ct::id.eq(&thread_id))
                .select(ct::agent_id)
                .first(conn)
                .optional()?)
        })
        .await?
        .filter(|id: &String| !id.is_empty());

        // Deliver to active Slack mappings, filtered by agent when possible.
        // Ordered oldest-first so the main-channel fallback below is deterministic.
        let (lens_user, agent_filter) = (user_id.to_string(), thread_agent_id.clone());
        let mappings: Vec<SlackMapping> = crate::db::read(move |conn| {
            let mut query = m::slack_mappings
                .filter(m::lens_user_id.eq(lens_user))
                .order(m::created_at.asc())
                .select(SlackMapping::as_select())
                .into_boxed();
            if let Some(agent_id) = agent_filter {
                query = query.filter(m::agent_id.eq(agent_id));
            }
            Ok(query.load(conn)?)
        })
        .await?;

        // Autonomous output (heartbeat, unbound cron) must land in exactly ONE
        // channel — the agent's main channel — never every linked channel, or a
        // heartbeat would spam all of them. Resolve it the same way as everywhere
        // else: the flagged channel, else the oldest linked one as the default.
        let channel_mappings: Vec<&SlackMapping> = mappings
            .iter()
            .filter(|m| {
                m.slack_channel_id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty())
            })
            .collect();
        let main_channel_id = channel_mappings
            .iter()
            .find(|m| m.is_main_channel)
            .or(channel_mappings.first())
            .and_then(|m| m.slack_channel_id.clone());

        // One Slack connection (env-backed singleton) — resolve it once up front
        // rather than per mapping. If it's missing or inactive there's nowhere to
        // deliver, so bail before the loop.
        let Some(connection) = get_slack_connection().await?.filter(|c| c.is_active) else {
            if !mappings.is_empty() {
                log_warn!(
                    "No active Slack connection — skipping autonomous delivery for user {}",
                    user_id
                );
            }
            return Ok(());
        };
        let slack_app = self.get_app_for_team(&connection.team_id).await;

        for mapping in &mappings {
            // Deliver to DM channel (personal mode)
            if let Some(dm_channel_id) =
                mapping.dm_channel_id.as_deref().filter(|id| !id.is_empty())
            {
                let Some(slack_app) = &slack_app else {
                    log_warn!("Slack app not found for team {}", connection.team_id);
                    continue;
                };

                let delivered: anyhow::Result<()> = async {
                    let (dm_response, files) = self
                        .post_showing_images(
                            &slack_app.client,
                            attachments,
                            Outbound {
                                content: &row.content,
                                team_id: &connection.team_id,
                                triggered_by: Some(row.triggered_by.as_str()),
                                tool_calls: row.tool_calls.as_ref(),
                                feedback_message_id: include_feedback.then(|| row.id.clone()),
                            },
                            json!({
                                "channel": dm_channel_id,
                                // Reply into the DM thread if the incoming message was in one;
                                // absent posts the reply top-level.
                                "thread_ts": channel_context.and_then(|c| c.channel_thread_id.clone()),
                                "metadata": {
                                    "event_type": "lens_platform_message",
                                    "event_payload": {
                                        "messageId": row.id,
                                        "threadId": row.thread_id,
                                        "triggeredBy": row.triggered_by.as_str(),
                                    },
                                },
                            }),
                        )
                        .await?;

                    let ts = ts_of(&dm_response);
                    if let Some(ts) = ts.as_deref().filter(|ts| !ts.is_empty()) {
                        CONVERSATION_SERVICE
                            .set_external_message_id(&row.id, ts)
                            .await?;
                    }

                    // Upload any shared files, threaded under the message just posted.
                    self.upload_attachments_to_slack(
                        &slack_app.client,
                        dm_channel_id,
                        ts.as_deref(),
                        &files,
                    )
                    .await;

                    // Slack clears the assistant status on any bot post — set it again.
                    // The indicator itself no-ops unless a turn is live on this DM
                    // thread; the guard here only ensures there is a thread to target.
                    if let Some(thread_ts) = channel_context
                        .and_then(|c| c.channel_thread_id.as_deref())
                        .filter(|ts| !ts.is_empty())
                    {
                        self.working_indicator().set_status(
                            &connection.team_id,
                            dm_channel_id,
                            thread_ts,
                        );
                    }

                    log_info!(
                        "Delivered message to Slack DM {} for user {}",
                        connection.team_name,
                        user_id
                    );
                    Ok(())
                }
                .await;
                if let Err(error) = delivered {
                    log_error!(
                        "Slack DM delivery failed for {}: {}",
                        connection.team_name,
                        error
                    );
                }
            }

            // Deliver to Slack channel (team mode) — only the main channel, so an
            // autonomous broadcast doesn't fan out to every linked channel.
            if let Some(channel_id) = mapping
                .slack_channel_id
                .as_deref()
                .filter(|id| !id.is_empty())
                && Some(channel_id) == main_channel_id.as_deref()
            {
                self.deliver_to_channel(
                    channel_id,
                    &row.content,
                    &row.thread_id,
                    None,
                    row.tool_calls.as_ref(),
                    Some(&row.id),
                    include_feedback,
                    attachments,
                    None,
                )
                .await?;
            }
        }

        if !mappings.is_empty() {
            let mut props = IndexMap::new();
            if let Some(agent_id) = &thread_agent_id {
                props.insert("agent.id".to_string(), agent_id.clone());
            }
            props.insert("slack.delivery".to_string(), "mapping".to_string());
            props.insert("slack.mappings".to_string(), mappings.len().to_string());
            track_event("slack message delivered", Some(user_id), Some(props));
        }
        Ok(())
    }

    /// Deliver a message to a Slack channel (team mode)
    ///
    /// Used when the agent is participating in a channel conversation. DM
    /// channels are keyed by dmChannelId (not slackChannelId), so a channel
    /// without a mapping falls back to the single Slack connection, so
    /// thread-bound continuations to a DM still post. A post failure is logged,
    /// not returned. `tool_calls` is the stored message's tool-call list.
    #[allow(clippy::too_many_arguments)]
    pub async fn deliver_to_channel(
        &self,
        channel_id: &str,
        content: &str,
        thread_id: &str,
        thread_ts: Option<&str>,
        tool_calls: Option<&serde_json::Value>,
        message_id: Option<&str>,
        include_feedback: bool,
        attachments: &[AttachmentMeta],
        triggered_by: Option<&str>,
    ) -> anyhow::Result<()> {
        let thread_ts = thread_ts.filter(|ts| !ts.is_empty());
        let message_id = message_id.filter(|id| !id.is_empty());
        let triggered_by = triggered_by.filter(|t| !t.is_empty());

        // Find the mapping for this channel. DM channels are keyed by dmChannelId
        // (not slackChannelId), so find_by_channel_id misses them — fall back to the
        // single Slack connection so thread-bound continuations to a DM still post.
        let mapping = SLACK_MAPPING_SERVICE.find_by_channel_id(channel_id).await?;
        let team_id = match &mapping {
            Some(mapping) => Some(mapping.connection.team_id.clone()),
            None => get_slack_connection().await?.map(|c| c.team_id),
        };

        let Some(team_id) = team_id else {
            log_warn!(
                "No Slack connection or channel mapping for channel {} — cannot deliver",
                channel_id
            );
            return Ok(());
        };

        let Some(slack_app) = self.get_app_for_team(&team_id).await else {
            log_warn!("Slack app not found for team {}", team_id);
            return Ok(());
        };

        let delivered: anyhow::Result<()> = async {
            let mut payload = serde_json::Map::new();
            payload.insert("threadId".into(), json!(thread_id));
            if let Some(id) = message_id {
                payload.insert("messageId".into(), json!(id));
            }
            if let Some(trigger) = triggered_by {
                payload.insert("triggeredBy".into(), json!(trigger));
            }
            let (response, files) = self
                .post_showing_images(
                    &slack_app.client,
                    attachments,
                    Outbound {
                        content,
                        team_id: &team_id,
                        triggered_by,
                        tool_calls,
                        feedback_message_id: match (include_feedback, message_id) {
                            (true, Some(id)) => Some(id.to_string()),
                            _ => None,
                        },
                    },
                    json!({
                        "channel": channel_id,
                        "thread_ts": thread_ts, // Reply in thread if specified
                        "metadata": {
                            "event_type": "lens_platform_message",
                            "event_payload": payload,
                        },
                    }),
                )
                .await?;

            // Only set external ID when responding in an existing Slack thread.
            // When posting a new top-level message (e.g. heartbeat/cron broadcast),
            // skip set_external_id to avoid corrupting the webchat active thread.
            if let Some(thread_ts) = thread_ts {
                log_info!(
                    "Setting external thread ID for channel {} ts {} to threadId {}",
                    channel_id,
                    thread_ts,
                    thread_id
                );
                CONVERSATION_SERVICE
                    .set_external_id(thread_id, thread_ts)
                    .await?;
            }

            // Link DB record to Slack message for tool call enrichment
            let ts = ts_of(&response);
            if let (Some(id), Some(ts)) = (message_id, ts.as_deref().filter(|ts| !ts.is_empty())) {
                CONVERSATION_SERVICE.set_external_message_id(id, ts).await?;
            }

            // Upload any shared files. Thread them under the message we just posted
            // (its ts) when present, else under the reply thread (thread_ts).
            self.upload_attachments_to_slack(
                &slack_app.client,
                channel_id,
                ts.as_deref().or(thread_ts),
                &files,
            )
            .await;

            // Slack clears the assistant status on any bot post — set it again.
            // The indicator itself no-ops unless a turn is live on this thread;
            // the guard here only ensures there is a thread to target.
            if let Some(thread_ts) = thread_ts {
                self.working_indicator()
                    .set_status(&team_id, channel_id, thread_ts);
            }

            log_info!(
                "Delivered message to Slack channel {}",
                mapping
                    .as_ref()
                    .and_then(|m| m.mapping.slack_channel_name.clone())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| channel_id.to_string())
            );
            Ok(())
        }
        .await;
        if let Err(error) = delivered {
            log_error!(
                "Slack channel delivery failed for {}: {}",
                channel_id,
                error
            );
        }
        Ok(())
    }

    /// The agent's linked channels (the main one flagged) and DMs, oldest first.
    pub async fn list_linked_targets(&self, agent_id: &str) -> anyhow::Result<Vec<LinkedTarget>> {
        let agent = agent_id.to_string();
        let mappings: Vec<SlackMapping> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::agent_id.eq(&agent))
                .order(m::created_at.asc())
                .select(SlackMapping::as_select())
                .load(conn)?)
        })
        .await?;
        let channels: Vec<&SlackMapping> = mappings
            .iter()
            .filter(|m| {
                m.slack_channel_id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty())
            })
            .collect();
        let main_channel_id = channels
            .iter()
            .find(|m| m.is_main_channel)
            .or(channels.first())
            .and_then(|m| m.slack_channel_id.clone());

        let mut targets = Vec::new();
        for mapping in &mappings {
            if let Some(channel_id) = mapping
                .slack_channel_id
                .as_deref()
                .filter(|id| !id.is_empty())
            {
                targets.push(LinkedTarget {
                    key: format!("slack:{channel_id}"),
                    platform: ChatPlatform::Slack,
                    kind: LinkedTargetKind::Channel,
                    conversation_id: channel_id.to_string(),
                    name: mapping.slack_channel_name.clone(),
                    is_main: Some(channel_id) == main_channel_id.as_deref(),
                    dm_user_id: None,
                });
            }
            if let Some(dm_channel_id) =
                mapping.dm_channel_id.as_deref().filter(|id| !id.is_empty())
            {
                targets.push(LinkedTarget {
                    key: format!("slack:{dm_channel_id}"),
                    platform: ChatPlatform::Slack,
                    kind: LinkedTargetKind::Dm,
                    conversation_id: dm_channel_id.to_string(),
                    name: mapping
                        .slack_user_id
                        .as_deref()
                        .filter(|id| !id.is_empty())
                        .map(|id| format!("<@{id}>")),
                    is_main: false,
                    dm_user_id: mapping.lens_user_id.clone(),
                });
            }
        }
        Ok(targets)
    }

    /// Posts one message with `chat.postMessage`, threaded under `thread` when
    /// given, and returns its ts. A Slack error reaches the caller, a tool that
    /// reports the outcome to the agent. A top-level DM is the one conversation
    /// whose history is stored rather than read from Slack, keyed by the DM
    /// channel as the inbound DM path keys it.
    ///
    /// Refuses (`SendRefusedError`) with code `not_connected`, `bad_thread`,
    /// `broadcast`, `bad_mention`, `not_member` or `missing_scope`.
    pub async fn post_to_target(
        &self,
        target: &LinkedTarget,
        text: &str,
        thread: Option<&str>,
    ) -> anyhow::Result<PostedMessage> {
        let connection = get_slack_connection().await?;
        let slack_app = match &connection {
            Some(connection) if connection.is_active => {
                self.app_for_send(&connection.team_id).await
            }
            _ => None,
        };
        let (Some(_), Some(slack_app)) = (connection, slack_app) else {
            return Err(SendRefusedError::new(
                "Slack is not connected, so nothing can be sent there.",
                "not_connected",
            )
            .into());
        };
        if let Some(thread) = thread
            && !SLACK_TS.is_match(thread)
        {
            return Err(SendRefusedError::new(
                    format!(
                        "\"{thread}\" is not a Slack thread id. A thread id is the ts of the thread's first message, for example 1712345678.123456."
                    ),
                    "bad_thread",
                )
                .into());
        }
        if SLACK_SPECIAL_MENTION.is_match(text) {
            return Err(SendRefusedError::new(
                "The message has a <!…> token, which notifies a whole channel or a user group, so nothing was sent. Mention people one at a time as <@ID>.",
                "broadcast",
            )
            .into());
        }

        let outbound = self.check_mentions(&slack_app, target, text).await?;
        let formatted = format_slack_message(&outbound, None, None, None);
        let response = slack_app
            .client
            .api_call(
                "chat.postMessage",
                json!({
                    "channel": target.conversation_id,
                    "thread_ts": thread,
                    "text": formatted.text,
                    "blocks": formatted.blocks,
                }),
            )
            .await?;
        let ts = ts_of(&response).unwrap_or_else(|| "undefined".to_string());
        let history = match (&target.kind, thread, &target.dm_user_id) {
            (LinkedTargetKind::Dm, None, Some(user_id)) if !user_id.is_empty() => {
                Some(PostedHistory {
                    user_id: user_id.clone(),
                    thread_key: target.conversation_id.clone(),
                    ..PostedHistory::default()
                })
            }
            _ if slack_mode() == SlackMode::Routed => {
                self.routed_post_history(target, thread.unwrap_or(&ts), &ts)
                    .await
            }
            _ => None,
        };
        Ok(PostedMessage {
            message_id: ts,
            history,
        })
    }

    /// The stored thread a routed post belongs to: the one the inbound path
    /// opens for its root. The message is already posted, so a failed owner
    /// lookup is logged and leaves the post unstored: an error would make the
    /// agent send it again.
    async fn routed_post_history(
        &self,
        target: &LinkedTarget,
        thread_key: &str,
        ts: &str,
    ) -> Option<PostedHistory> {
        let owner = if target.kind == LinkedTargetKind::Dm {
            Ok(target.dm_user_id.clone())
        } else {
            let channel = target.conversation_id.clone();
            crate::db::read(move |conn| {
                Ok(m::slack_mappings
                    .filter(m::slack_channel_id.eq(&channel))
                    .select(m::lens_user_id)
                    .first::<Option<String>>(conn)
                    .optional()?
                    .flatten())
            })
            .await
        };
        let user_id = match owner {
            Ok(user_id) => user_id.filter(|id| !id.is_empty())?,
            Err(error) => {
                log_error!(
                    json!({ "err": err_json(&error) }),
                    "[Slack] posted, but the owner of the routed thread could not be read"
                );
                return None;
            }
        };
        Some(PostedHistory {
            user_id,
            thread_key: thread_key.to_string(),
            channel_id: Some(target.conversation_id.clone()),
            external_message_id: Some(ts.to_string()),
        })
    }

    /// Refuse a mention token that is not a Slack user id, or that names a person
    /// outside the target conversation, then rewrite each token to the bare
    /// `<@ID>` form that Slack turns into a notifying mention.
    async fn check_mentions(
        &self,
        slack_app: &SlackApp,
        target: &LinkedTarget,
        text: &str,
    ) -> anyhow::Result<String> {
        let tokens: Vec<(String, String, Option<String>)> = MENTION_TOKEN
            .captures_iter(text)
            .map(|found| {
                (
                    found[0].to_string(),
                    found[1].to_string(),
                    found.get(2).map(|name| name.as_str().to_string()),
                )
            })
            .collect();
        if tokens.is_empty() {
            return Ok(text.to_string());
        }

        for (token, id, _) in &tokens {
            if !SLACK_USER_ID.is_match(id) {
                return Err(SendRefusedError::new(
                    format!(
                        "{token} is not a Slack user mention. Mention a person as <@USERID>, with the id from a message you have seen."
                    ),
                    "bad_mention",
                )
                .into());
            }
        }

        let members = self.conversation_members(slack_app, target).await?;
        for (_, id, embedded_name) in &tokens {
            if members.contains(id) {
                continue;
            }
            let info = self.get_user_info(id, &slack_app.team_id).await;
            let name = info
                .as_ref()
                .and_then(|info| info.display_name())
                .map(str::to_string)
                .or_else(|| embedded_name.clone().filter(|n| !n.is_empty()))
                .unwrap_or_else(|| id.clone());
            return Err(SendRefusedError::new(
                format!(
                    "{name} (<@{id}>) is not a member of {}, so the message was not sent. Mention only people in that conversation.",
                    describe_target(target)
                ),
                "not_member",
            )
            .into());
        }

        Ok(MENTION_TOKEN
            .replace_all(text, |found: &regex::Captures<'_>| {
                format!("<@{}>", &found[1])
            })
            .into_owned())
    }

    /// Every member of the target conversation (`conversations.members`, 1000 per
    /// page). A `missing_scope` error is refused with the scope the app needs.
    async fn conversation_members(
        &self,
        slack_app: &SlackApp,
        target: &LinkedTarget,
    ) -> anyhow::Result<HashSet<String>> {
        // A DM's members are the bot and the person it is with. A routed proxy
        // lists members of linked channels only.
        if target.kind == LinkedTargetKind::Dm {
            let channel = target.conversation_id.clone();
            let person: Option<Option<String>> = crate::db::read(move |conn| {
                Ok(m::slack_mappings
                    .filter(m::dm_channel_id.eq(&channel))
                    .select(m::slack_user_id)
                    .first(conn)
                    .optional()?)
            })
            .await?;
            let mut members = HashSet::from([slack_app.bot_user_id.clone()]);
            members.extend(person.flatten());
            return Ok(members);
        }
        let mut members = HashSet::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = slack_app
                .client
                .api_call(
                    "conversations.members",
                    json!({
                        "channel": target.conversation_id,
                        "limit": 1000,
                        "cursor": cursor,
                    }),
                )
                .await;
            let page = match page {
                Ok(page) => page,
                Err(error) => {
                    if slack_platform_error_code(&error).as_deref() == Some("missing_scope") {
                        return Err(SendRefusedError::new(
                            format!(
                                "The Slack app cannot read who is in {}: it needs the channels:read scope, and groups:read for a private channel. Ask the operator to add the scope.",
                                describe_target(target)
                            ),
                            "missing_scope",
                        )
                        .into());
                    }
                    return Err(error);
                }
            };
            if let Some(ids) = page.get("members").and_then(Value::as_array) {
                members.extend(ids.iter().filter_map(Value::as_str).map(str::to_string));
            }
            cursor = page
                .pointer("/response_metadata/next_cursor")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(members)
    }

    /// Post a reply with the images its text places as image blocks at their place.
    /// Each image is uploaded to no channel first, so a block can name it. When
    /// Slack refuses the message with them, the text is posted with each image's
    /// description, and the images go with the files uploaded after it. Answers
    /// the posted message and the files it does not show.
    async fn post_showing_images(
        &self,
        client: &SlackWebClient,
        attachments: &[AttachmentMeta],
        outbound: Outbound<'_>,
        message: serde_json::Value,
    ) -> anyhow::Result<(serde_json::Value, Vec<AttachmentMeta>)> {
        let format = |images: HashMap<String, String>| {
            self.prepare_outbound_message(
                outbound.content,
                outbound.team_id,
                outbound.triggered_by,
                outbound.tool_calls,
                Some(FormatSlackMessageOptions {
                    feedback_message_id: outbound.feedback_message_id.clone(),
                    images,
                }),
            )
        };
        let post = |formatted: FormattedSlackMessage| {
            let mut args = message.clone();
            args["text"] = json!(formatted.text);
            args["blocks"] = json!(formatted.blocks);
            client.api_call("chat.postMessage", args)
        };
        let images = self.upload_inline_images(client, attachments).await;
        if images.is_empty() {
            let response = post(format(images).await).await?;
            return Ok((response, attachments.to_vec()));
        }
        let formatted = format(images.clone()).await;
        // The formatter can cut blocks past Slack's limit, so an image counts as
        // shown only when its block is still in the message.
        let shown: HashSet<String> = formatted
            .blocks
            .iter()
            .filter_map(|block| match block {
                SlackBlock::Image { slack_file, .. } => Some(slack_file.id.clone()),
                _ => None,
            })
            .collect();
        match post(formatted).await {
            Ok(response) => {
                let files = attachments
                    .iter()
                    .filter(|a| !images.get(&a.id).is_some_and(|id| shown.contains(id)))
                    .cloned()
                    .collect();
                Ok((response, files))
            }
            // Only a refused block is worth a second post. Any other failure
            // (not_in_channel, channel_not_found, …) would fail the same way again.
            Err(error)
                if slack_platform_error_code(&error).as_deref() == Some("invalid_blocks") =>
            {
                log_warn!(
                    "[Slack] message with {} image block(s) refused (invalid_blocks); posting the images after it",
                    shown.len()
                );
                let response = post(format(HashMap::new()).await).await?;
                Ok((response, attachments.to_vec()))
            }
            Err(error) => Err(error),
        }
    }

    /// Attachment id → Slack file id of each inline image Slack took.
    async fn upload_inline_images(
        &self,
        client: &SlackWebClient,
        attachments: &[AttachmentMeta],
    ) -> HashMap<String, String> {
        let mut images = HashMap::new();
        for meta in attachments.iter().filter(|a| a.inline == Some(true)) {
            let uploaded: anyhow::Result<Option<String>> = async {
                let Some(file) = attachment_bytes(meta).await? else {
                    return Ok(None);
                };
                let upload = client
                    .files_upload_v2(FileUpload {
                        channel_id: String::new(),
                        thread_ts: None,
                        filename: meta.filename.clone(),
                        file: Bytes::from(file),
                    })
                    .await?;
                Ok(upload
                    .pointer("/files/0/files/0/id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string))
            }
            .await;
            match uploaded {
                Ok(Some(file_id)) => {
                    images.insert(meta.id.clone(), file_id);
                }
                Ok(None) => {}
                Err(error) => log_warn!(
                    "[Slack] inline image {} not uploaded: {}",
                    meta.filename,
                    error
                ),
            }
        }
        images
    }

    /// Upload agent-shared files to Slack via `files.uploadV2`, threaded under
    /// `thread_ts` when provided so they sit with the message that referenced them.
    ///
    /// Best-effort: per-file failures are logged, never returned — the text reply is
    /// already delivered and the file stays downloadable on web/CLI. Requires the
    /// bot `files:write` scope.
    async fn upload_attachments_to_slack(
        &self,
        client: &SlackWebClient,
        channel_id: &str,
        thread_ts: Option<&str>,
        attachments: &[AttachmentMeta],
    ) {
        if attachments.is_empty() {
            return;
        }
        for meta in attachments {
            let uploaded: anyhow::Result<()> = async {
                let Some(file_bytes) = attachment_bytes(meta).await? else {
                    return Ok(());
                };
                client
                    .files_upload_v2(FileUpload {
                        channel_id: channel_id.to_string(),
                        thread_ts: thread_ts.filter(|ts| !ts.is_empty()).map(str::to_string),
                        filename: meta.filename.clone(),
                        file: Bytes::from(file_bytes),
                    })
                    .await?;
                log_info!(
                    "[Slack] uploaded shared file {} to {}",
                    meta.filename,
                    channel_id
                );
                Ok(())
            }
            .await;
            if let Err(error) = uploaded {
                log_error!(
                    "[Slack] failed to upload shared file {} to {}: {}",
                    meta.filename,
                    channel_id,
                    error
                );
            }
        }
    }

    /// Check if user has an active Slack connection: a cached team, else any DM or
    /// channel mapping.
    pub async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        // Check cache first
        if self
            .user_connection_cache
            .get(user_id)
            .is_some_and(|teams| !teams.is_empty())
        {
            return Ok(true);
        }

        // Query the database (includes both DM and channel mappings)
        let count = SLACK_MAPPING_SERVICE.count_all_mappings(user_id).await?;
        Ok(count > 0)
    }

    /// A Slack thread continues where it started. A DM-originated thread carries
    /// no channel id (the DM path does not capture one, and DM threads have no
    /// externalChannelId). Without one, `deliver` falls back to its mapping
    /// broadcast, which can also post into the user's linked channels, so the
    /// user's DM channel is resolved to keep the continuation in the DM.
    ///
    /// Only a Slack thread's conversation keeps a thread_ts in externalThreadId,
    /// so only it gets a `channel_thread_id`. With no channel id there is nowhere to
    /// post: a warning is logged and the destination is empty.
    pub async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> anyhow::Result<ChannelDestination> {
        let id = thread_id.to_string();
        type ThreadRow = (Option<String>, Option<String>, String, String);
        let thread: Option<ThreadRow> = crate::db::read(move |conn| {
            Ok(ct::conversation_threads
                .filter(ct::id.eq(&id))
                .select((
                    ct::external_thread_id,
                    ct::external_channel_id,
                    ct::user_id,
                    ct::agent_id,
                ))
                .first(conn)
                .optional()?)
        })
        .await?;

        let mut channel_id = origin_channel_id
            .map(str::to_string)
            .or_else(|| thread.as_ref().and_then(|t| t.1.clone()))
            .filter(|id| !id.is_empty());
        if channel_id.is_none()
            && let Some((_, _, user_id, agent_id)) = &thread
        {
            let (user, agent) = (user_id.clone(), agent_id.clone());
            let dm: Option<Option<String>> = crate::db::read(move |conn| {
                Ok(m::slack_mappings
                    .filter(m::lens_user_id.eq(&user))
                    .filter(m::agent_id.eq(&agent))
                    .filter(m::dm_channel_id.is_not_null())
                    .select(m::dm_channel_id)
                    .first(conn)
                    .optional()?)
            })
            .await?;
            channel_id = dm.flatten().filter(|id| !id.is_empty());
        }
        // With no channel id there is nowhere to post, and the resume is dropped. A
        // thread-bound task resumes in its own thread or not at all: the main
        // channel would put its output in an unrelated conversation.
        if channel_id.is_none() {
            log_warn!(
                "No Slack channel resolved for thread {} (no origin/external channel id and no DM mapping) — a \"continue in thread\" resume will not be delivered",
                thread_id
            );
        }
        Ok(ChannelDestination {
            channel_label: channel_id.as_deref().map(slack_channel_label),
            channel_id,
            // A Slack thread's conversation keeps its thread_ts in externalThreadId.
            // A top-level DM's conversation stores its `D…` channel id there, which
            // is no thread_ts, so it resumes top-level in the DM.
            channel_thread_id: thread
                .and_then(|t| t.0)
                .filter(|external| SLACK_TS.is_match(external)),
        })
    }

    /// The user's DM channel, else the agent's main linked channel. The channel id
    /// routes the message to that one conversation through `deliver_to_channel`;
    /// without it, `deliver`'s mapping fallback posts to the DM and the main
    /// channel both. The thread key is the same conversation id.
    pub async fn default_destination(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Option<DefaultDestination>> {
        let (user, agent) = (user_id.to_string(), agent_id.to_string());
        let dm: Option<Option<String>> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::lens_user_id.eq(&user))
                .filter(m::agent_id.eq(&agent))
                .filter(m::dm_channel_id.is_not_null())
                .select(m::dm_channel_id)
                .first(conn)
                .optional()?)
        })
        .await?;
        let conversation = match dm.flatten() {
            Some(dm) => Some(dm),
            None => SLACK_MAPPING_SERVICE.get_main_channel(agent_id).await?,
        };
        Ok(conversation
            .filter(|c| !c.is_empty())
            .map(|conversation| DefaultDestination {
                destination: ChannelDestination {
                    channel_id: Some(conversation.clone()),
                    channel_thread_id: None,
                    channel_label: None,
                },
                thread_key: conversation,
            }))
    }

    pub async fn linked_channel_ids(&self, agent_id: &str) -> anyhow::Result<Vec<String>> {
        SLACK_MAPPING_SERVICE.list_channel_ids(agent_id).await
    }

    /// Initialize Slack adapter
    ///
    /// Loads the active Slack connection and starts a Socket Mode app for each
    /// workspace. Boot does not wait for the sockets: a start can wait on
    /// `apps.connections.open` with no time limit, and the HTTP port opens after
    /// this returns. A workspace is listed once its socket is up. Failures are
    /// logged, not returned.
    pub async fn initialize(&self) -> anyhow::Result<()> {
        log_info!("Initializing Slack adapter...");

        let initialized: anyhow::Result<()> = async {
            // In routed mode the router's listener opens first, so a `connected`
            // envelope reaches an agent that is in no workspace.
            if CONFIG
                .slack_bot_token
                .as_deref()
                .is_some_and(|t| !t.is_empty())
                && slack_mode() == SlackMode::Routed
                && let Err(error) = SLACK_ROUTER_SERVICE
                    .start(Arc::new(AdapterRouterHandlers))
                    .await
            {
                log_error!(
                    json!({ "err": err_json(&error), "port": CONFIG.slack_port }),
                    "Could not open the Slack router listener"
                );
            }

            // Source of truth: env `SLACK_BOT_TOKEN` (validated by slack-config).
            // An empty list is the not-configured case.
            let connections = get_active_slack_connections().await?;
            if connections.is_empty() {
                log_info!("No active Slack connections; adapter idle");
                return Ok(());
            }

            // Boot does not wait for the sockets: a start can wait on
            // `apps.connections.open` with no time limit, and the HTTP port opens after
            // this returns. A workspace is listed once its socket is up.
            let started: Vec<_> = connections
                .into_iter()
                .map(|connection| {
                    tokio::spawn(async move {
                        if let Err(error) = SLACK_ADAPTER_SERVICE
                            .initialize_connection(&connection.id)
                            .await
                        {
                            log_error!(
                                "Failed to initialize Slack connection for {}: {}",
                                connection.team_name,
                                error
                            );
                        }
                    })
                })
                .collect();

            // Build user connection cache
            self.rebuild_user_cache().await?;

            let all_started = futures::future::join_all(started)
                .map(|_| ())
                .boxed()
                .shared();
            *self.started.lock() = all_started.clone();
            tokio::spawn(async move {
                all_started.await;
                let workspaces = SLACK_ADAPTER_SERVICE.apps.len();
                log_info!("Slack adapter initialized: {} workspace(s)", workspaces);
                let mut props = agent_props();
                props.insert("slack.workspaces".to_string(), workspaces.to_string());
                track_event("slack adapter initialized", None, Some(props));
            });
            Ok(())
        }
        .await;
        if let Err(error) = initialized {
            log_error!("Failed to initialize Slack adapter: {}", error);
        }
        Ok(())
    }

    /// Shutdown Slack adapter
    ///
    /// Stops the Socket Mode apps first (a stopped client reports `disconnected`,
    /// which re-arms a watch and fails a reconnect that waits for hello), then
    /// clears the working indicators while the clients are still up, then stops
    /// every app. Emits `slack adapter shutdown`.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        log_info!("Shutting down Slack adapter...");

        SLACK_ROUTER_SERVICE.stop().await;

        // Stop the Socket Mode apps first: a stopped client reports `disconnected`,
        // which re-arms a watch and fails a reconnect that waits for hello.
        let sockets: Vec<Arc<SocketHandle>> = self
            .sockets
            .iter()
            .map(|socket| socket.value().clone())
            .collect();
        self.sockets.clear();
        futures::future::join_all(sockets.iter().map(|socket| socket.stop())).await;

        // Clear working indicators while the clients are still up, so the
        // best-effort reaction removals / status clears can reach Slack.
        let indicator = self.working_indicator.lock().clone();
        if let Some(indicator) = indicator {
            indicator.stop_all().await;
        }
        // A stopped indicator refuses new turns for good — drop the instance so
        // a later initialize()/add-connection in the same process gets a fresh one.
        *self.working_indicator.lock() = None;

        let apps: Vec<Arc<SlackApp>> = self.apps.iter().map(|app| app.value().clone()).collect();
        for slack_app in &apps {
            if let (true, Some(socket)) = (slack_app.is_socket_mode, &slack_app.socket)
                && let Err(error) = SocketModeApp(socket.clone()).stop().await
            {
                log_error!(
                    "Failed to stop Slack app for {}: {}",
                    slack_app.team_id,
                    error
                );
                continue;
            }
            log_info!("Stopped Slack app for {}", slack_app.team_name);
        }

        let workspaces = self.apps.len();
        self.apps.clear();
        self.user_connection_cache.clear();

        let mut props = agent_props();
        props.insert("slack.workspaces".to_string(), workspaces.to_string());
        track_event("slack adapter shutdown", None, Some(props));
        Ok(())
    }

    /// Initialize a single Slack connection
    ///
    /// Creates the workspace's app with the configured tokens and sets up message
    /// handlers. The bot token comes from env via slack-config (plaintext, or a
    /// `__nexus_cred:…__` sentinel that the proxy swaps on the wire), so every Web
    /// API request sends it only in the `Authorization` header. The app token
    /// (`SLACK_APP_TOKEN`) enables Socket Mode.
    ///
    /// The socket watch stays armed when the start fails, so the connection is
    /// built again after `SOCKET_STALL_MS`. A stop leaves the start pending for
    /// good, so the stop also ends this call. When the stop comes from the watch's
    /// rebuild, the call ends with the rebuild, so the boot's `started` waits for
    /// the first app that connects or fails. Emits `slack connection added`.
    pub async fn initialize_connection(&self, connection_id: &str) -> anyhow::Result<()> {
        let Some(connection) = get_slack_connection().await?.filter(|c| c.is_active) else {
            return Ok(());
        };

        // Bot token comes from env via slack-config (plaintext, or a
        // `__nexus_cred:…__` sentinel that the proxy swaps on the wire).
        let bot_token = connection.bot_token.clone();

        // App token is global (from environment), not per-workspace
        let app_token = std::env::var("SLACK_APP_TOKEN")
            .ok()
            .filter(|token| !token.is_empty());

        let mode = slack_mode();
        let is_socket_mode = mode == SlackMode::Socket;

        // The Web API client sends the token only in the `Authorization` header,
        // under the bounded request policy: a request deadline and a few
        // seconds-scale retries, for every post. The Socket Mode client keeps the
        // Slack SDK's own policy for `apps.connections.open` instead: it retries for
        // hours, and treats a request timeout as unrecoverable, so a bounded client
        // would stop reconnecting after any blip.
        let client = Arc::new(SlackWebClient::new(Some(&bot_token), None));
        let context = Arc::new(ConnectionContext {
            connection_id: connection_id.to_string(),
            team_id: connection.team_id.clone(),
            team_name: connection.team_name.clone(),
            bot_id: connection.bot_id.clone(),
            bot_user_id: connection.bot_user_id.clone(),
            client: client.clone(),
        });
        log_info!(
            "Setting up message handler for team {}, bot {}",
            connection.team_id,
            connection.bot_user_id
        );
        let socket = app_token
            .as_deref()
            .map(|token| SocketModeClient::new(token, None, envelope_handler(context.clone())));

        // Start Socket Mode if available. The watch stays armed when the start
        // fails, so the connection is built again after SOCKET_STALL_MS. A stop
        // leaves the start pending for good, so the stop also ends this call. When
        // the stop comes from the watch's rebuild, the call ends with the rebuild,
        // so the boot's `started` waits for the first app that connects or fails.
        if let Some(socket_client) = &socket {
            let team_id = connection.team_id.clone();
            let previous = self.sockets.get(&team_id).map(|s| s.value().clone());
            if let Some(previous) = previous {
                previous.stop().await;
            }
            let rebuild: Arc<Mutex<Option<Shared<BoxFuture<'static, ()>>>>> =
                Arc::new(Mutex::new(None));
            let handle = Arc::new(SocketHandle {
                client: socket_client.clone(),
                watch: Mutex::new(None),
                stopped: CancellationToken::new(),
                team_id: team_id.clone(),
            });
            {
                let rebuild = rebuild.clone();
                let watched = handle.clone();
                let connection_id = connection_id.to_string();
                let team = team_id.clone();
                let watch = watch_socket(socket_client.subscribe(), move || {
                    let future = SLACK_ADAPTER_SERVICE
                        .rebuild_socket(connection_id, team, watched)
                        .shared();
                    *rebuild.lock() = Some(future.clone());
                    tokio::spawn(future);
                });
                *handle.watch.lock() = Some(watch);
            }
            self.sockets.insert(team_id.clone(), handle.clone());

            let started = tokio::select! {
                result = socket_client.start() => Some(result),
                _ = handle.stopped.cancelled() => None,
            };
            let rebuild_done = || async {
                let pending = rebuild.lock().clone();
                if let Some(pending) = pending {
                    pending.await;
                }
            };
            let is_current = || {
                self.sockets
                    .get(&team_id)
                    .is_some_and(|current| Arc::ptr_eq(current.value(), &handle))
            };
            match started {
                None => {
                    rebuild_done().await;
                    return Ok(());
                }
                Some(Err(error)) => {
                    // A rebuild, a shutdown or a disconnect replaced this app while it
                    // started. The call ends with the rebuild, when one runs.
                    if !is_current() {
                        rebuild_done().await;
                        return Ok(());
                    }
                    log_error!(
                        "Slack Socket Mode failed for {}; trying again in {} minutes: {}",
                        connection.team_name,
                        SOCKET_STALL_MS / 60_000,
                        error
                    );
                    return Ok(());
                }
                Some(Ok(())) => {}
            }
            if !is_current() {
                // Replaced while it started, as above.
                handle.stop().await;
                rebuild_done().await;
                return Ok(());
            }
            log_info!("Slack Socket Mode connected: {}", connection.team_name);
        } else if mode == SlackMode::Routed {
            log_info!(
                "Slack connection {} receives its events from the router",
                connection.team_name
            );
        } else {
            log_warn!(
                "Slack connection {} - Socket Mode not available (no app token)",
                connection.team_name
            );
        }

        self.apps.insert(
            connection.team_id.clone(),
            Arc::new(SlackApp {
                client,
                socket,
                team_id: connection.team_id.clone(),
                team_name: connection.team_name.clone(),
                is_socket_mode,
                bot_user_id: connection.bot_user_id.clone(),
                routed: (mode == SlackMode::Routed).then(|| context.clone()),
            }),
        );

        let mut props = agent_props();
        props.insert("slack.connection.id".to_string(), connection_id.to_string());
        props.insert("slack.mode".to_string(), mode.as_str().to_string());
        track_event("slack connection added", None, Some(props));
        Ok(())
    }

    /// Replace a Socket Mode app whose client has not connected for
    /// `SOCKET_STALL_MS`. The rebuild stops when `handle` is no longer the team's
    /// current app, because a shutdown, a disconnect or a newer connection
    /// replaced it. The old app stays in `apps` until the new one connects, so
    /// posts keep working.
    fn rebuild_socket(
        &'static self,
        connection_id: String,
        team_id: String,
        handle: Arc<SocketHandle>,
    ) -> BoxFuture<'static, ()> {
        async move {
            log_warn!(
                "Slack socket for team {} has not connected for {} minutes; rebuilding it",
                team_id,
                SOCKET_STALL_MS / 60_000
            );
            handle.stop().await;
            let current = self
                .sockets
                .get(&team_id)
                .is_some_and(|current| Arc::ptr_eq(current.value(), &handle));
            if !current {
                return;
            }
            if let Err(error) = self.initialize_connection(&connection_id).await {
                log_error!(
                    json!({ "err": err_json(&error), "teamId": team_id }),
                    "Failed to rebuild the Slack connection"
                );
            }
        }
        .boxed()
    }

    /// One envelope from the socket, routed as Bolt routes it: an event is
    /// acknowledged first and goes to its handler unless the bot itself caused
    /// it; a click on a feedback button goes to the feedback handler, which
    /// acknowledges it. A handler's error is logged as the app's error.
    async fn dispatch(
        &self,
        context: Arc<ConnectionContext>,
        socket: Arc<SocketModeClient>,
        envelope: SocketEnvelope,
    ) {
        let envelope_id = envelope.envelope_id.clone();
        let ack = move || socket.ack(envelope_id.as_deref());
        self.process_body(context, &envelope.body, &ack, None).await;
    }

    /// Route one body to its listener, as Bolt does: `ack` acknowledges it to
    /// whoever delivered it. A routed body names no team, so its listeners use
    /// the app's own client, whose calls carry no `team_id`.
    async fn process_body(
        &self,
        context: Arc<ConnectionContext>,
        body: &Value,
        ack: &(dyn Fn() -> anyhow::Result<()> + Send + Sync),
        routed: Option<&RoutedEvent>,
    ) {
        let listener_client = if routed.is_some() {
            context.client.as_ref().clone()
        } else {
            context.client.with_team_id(
                str_field(body, "team_id")
                    .or_else(|| body.pointer("/team/id").and_then(Value::as_str))
                    .unwrap_or(&context.team_id),
            )
        };

        if let Some(event) = body.get("event") {
            if let Err(error) = ack() {
                log_error!(
                    "An unhandled error occurred while Bolt processed (type: {}, error: {})",
                    body.get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("undefined"),
                    error
                );
                return;
            }
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            // Bolt's `ignoreSelf`: the bot's own messages and events.
            if event_type == "message"
                && event.get("subtype").and_then(Value::as_str) == Some("bot_message")
                && event.get("bot_id").and_then(Value::as_str) == Some(context.bot_id.as_str())
            {
                return;
            }
            if event.get("user").and_then(Value::as_str) == Some(context.bot_user_id.as_str())
                && !matches!(event_type, "member_joined_channel" | "member_left_channel")
            {
                return;
            }
            let handled = match event_type {
                "message" => {
                    let say = Say {
                        client: listener_client,
                        channel: event
                            .get("channel")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    };
                    self.on_message(&context, event, &say, routed).await;
                    Ok(())
                }
                "member_joined_channel" => {
                    self.on_member_joined_channel(
                        &context,
                        event,
                        &listener_client,
                        routed.is_some(),
                    )
                    .await
                }
                "member_left_channel" => self.on_member_left_channel(&context, event).await,
                _ => Ok(()),
            };
            if let Err(error) = handled {
                log_error!("Slack app error for {}: {}", context.team_name, error);
            }
            return;
        }

        if body.get("type").and_then(Value::as_str) == Some("block_actions") {
            let action_id = body
                .pointer("/actions/0/action_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let rating = match action_id {
                FEEDBACK_ACTION_UP => FeedbackRating::Up,
                FEEDBACK_ACTION_DOWN => FeedbackRating::Down,
                _ => return,
            };
            if let Err(error) = ack() {
                log_error!("Slack app error for {}: {}", context.team_name, error);
                return;
            }
            if let Err(error) = self
                .handle_feedback_action(body, Arc::new(listener_client), rating)
                .await
            {
                log_error!("[SlackAdapter] Feedback action handler failed: {}", error);
            }
        }
    }

    /// The message handler: skips edits, bot messages and empty messages, then
    /// routes a DM to the DM handler and anything else to the channel handler.
    async fn on_message(
        &self,
        context: &ConnectionContext,
        message: &Value,
        say: &Say,
        routed: Option<&RoutedEvent>,
    ) {
        let handled: anyhow::Result<()> = async {
            log_info!("RAW Slack message received");

            let subtype = str_field(message, "subtype");
            let user = str_field(message, "user");
            let text = str_field(message, "text");
            let channel = message.get("channel").and_then(Value::as_str).unwrap_or("");
            let channel_type = message.get("channel_type").and_then(Value::as_str);
            let bot_id = str_field(message, "bot_id");
            let thread_ts = str_field(message, "thread_ts");
            let ts = message.get("ts").and_then(Value::as_str).unwrap_or("");
            let files: Vec<SlackFileMeta> = message
                .get("files")
                .and_then(Value::as_array)
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|f| serde_json::from_value(f.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();
            let has_files = message
                .get("files")
                .and_then(Value::as_array)
                .is_some_and(|files| !files.is_empty());

            // Skip message subtypes (edits, deletes, etc.) — except `file_share`,
            // which is how a user-uploaded attachment arrives (often with empty text).
            if let Some(subtype) = subtype.filter(|s| *s != "file_share") {
                log_info!("Skipping message with subtype: {}", subtype);
                return Ok(());
            }
            // Require a user; allow empty text when the message carries files.
            let Some(slack_user_id) = user.filter(|_| text.is_some() || has_files) else {
                log_info!("Skipping message without user or content");
                return Ok(());
            };
            // In e2e tests, user tokens from Slack apps attach bot_id to every message.
            // SLACK_SKIP_BOT_ID_CHECK=true relaxes this to only skip the bot's own messages.
            if bot_id.is_some() {
                if std::env::var("SLACK_SKIP_BOT_ID_CHECK").as_deref() == Ok("true") {
                    if slack_user_id == context.bot_user_id {
                        log_info!("Skipping own bot message");
                        return Ok(());
                    }
                } else {
                    log_info!("Skipping bot message");
                    return Ok(());
                }
            }

            let raw_text = js_trim(text.unwrap_or("")).to_string();
            let message_text = match routed {
                Some(routed) => without_address(&raw_text, &context.bot_user_id, routed.route),
                None => raw_text,
            };
            let files = if has_files { files } else { Vec::new() };

            log_info!(
                "Processing message: channel={}, channel_type={}, files={}",
                channel,
                channel_type.unwrap_or("undefined"),
                files.len()
            );

            if message_text.is_empty() && files.is_empty() {
                log_info!("Skipping empty message");
                return Ok(());
            }

            // Route based on channel type, or on the router's route
            let is_dm = match routed {
                Some(routed) => routed.route == SlackRoute::Dm,
                None => channel_type == Some("im"),
            };
            if is_dm {
                log_info!("Routing to DM handler");
                self.handle_dm_message(
                    &context.connection_id,
                    slack_user_id,
                    &message_text,
                    channel,
                    say,
                    &context.team_id,
                    Some(ts).filter(|ts| !ts.is_empty()),
                    thread_ts,
                    files,
                    routed,
                )
                .await
            } else {
                log_info!("Routing to channel handler");
                self.handle_channel_message(
                    &context.connection_id,
                    channel,
                    slack_user_id,
                    &message_text,
                    thread_ts,
                    ts,
                    say,
                    &context.bot_user_id,
                    &context.team_id,
                    files,
                    routed,
                )
                .await
            }
        }
        .await;
        if let Err(error) = handled {
            log_error!(
                json!({
                    "err": err_json(&error),
                    "connectionId": context.connection_id,
                    "teamId": context.team_id,
                    "channel": message.get("channel"),
                    "channelType": message.get("channel_type"),
                    "slackUserId": message.get("user"),
                    "eventTs": message.get("ts"),
                }),
                "Error in message handler"
            );
        }
    }

    /// Handle a DM message (personal agent mode). An unlinked user's message is
    /// checked for a link code; a linked user's message runs a turn in the DM's
    /// thread, keyed by `thread_ts` (SLACK-sourced) or the DM channel id.
    /// Link results, the link prompt and errors are posted back into the DM.
    #[allow(clippy::too_many_arguments)]
    async fn handle_dm_message(
        &self,
        connection_id: &str,
        slack_user_id: &str,
        message_text: &str,
        dm_channel_id: &str,
        say: &Say,
        team_id: &str,
        event_ts: Option<&str>,
        thread_ts: Option<&str>,
        files: Vec<SlackFileMeta>,
        routed: Option<&RoutedEvent>,
    ) -> anyhow::Result<()> {
        log_info!("Slack DM from {}", slack_user_id);

        let indicator: Mutex<Option<Arc<dyn WorkingIndicatorHandle>>> = Mutex::new(None);
        let turn: anyhow::Result<()> = async {
            // Find the user mapping for this Slack user. A linked user's message is
            // never a link code, so the code check below runs for unlinked users only.
            let mapping = SLACK_MAPPING_SERVICE
                .find_user_mapping(connection_id, slack_user_id)
                .await?;

            let Some(mapping) = mapping else {
                // In routed mode the router links accounts, so no message is a code.
                let code = routed
                    .is_none()
                    .then(|| self.parse_link_code(message_text))
                    .flatten();
                if let Some(code) = code {
                    // Verify directly (the runtime owns verification)
                    let result = self
                        .verify_dm_link_code(&code, slack_user_id, dm_channel_id)
                        .await?;

                    if result.success {
                        say.text(&format!("✅ {}", result.message)).await?;
                        // Rebuild user cache after linking
                        self.rebuild_user_cache().await?;
                    } else {
                        say.text(&format!("❌ {}", result.message)).await?;
                    }
                    return Ok(());
                }

                log_info!(
                    "Slack DM from unlinked user {} (connection {}) — message not handled; prompting them to link their account",
                    slack_user_id,
                    connection_id
                );
                let agent_name = self.agent_name().await?;
                let prompt = if routed.is_some() {
                    format!(
                        "👋 Hi! I don't recognize you yet. Link your Slack account to {agent_name}, then send your message again."
                    )
                } else {
                    format!(
                        "👋 Hi! I don't recognize you yet.\n\nTo link your Slack account to {agent_name}:\n1. Go to *Settings → Channels* in the web app\n2. Click *Link Account* under Slack\n3. Send me the 6-character code you receive"
                    )
                };
                say.text(&prompt).await?;
                return Ok(());
            };
            let mapping = mapping.mapping;

            // Working cue for the whole turn. No status_thread_ts for a top-level DM
            // (never synthesized from event_ts — that could activate a Slack
            // assistant thread prematurely); the eyes reaction covers it.
            let handle = self
                .working_indicator()
                .begin(WorkingIndicatorTarget {
                    team_id: team_id.to_string(),
                    channel_id: dm_channel_id.to_string(),
                    message_ts: event_ts.map(str::to_string),
                    status_thread_ts: thread_ts.map(str::to_string),
                })
                .await;
            *indicator.lock() = Some(handle.clone());

            // Store DM channel ID if not already stored
            if mapping.dm_channel_id.as_deref().is_none_or(str::is_empty) {
                SLACK_MAPPING_SERVICE
                    .update_dm_channel_id(&mapping.id, dm_channel_id)
                    .await?;
            }

            // Resolve user mentions to display names
            let resolved_text = self.resolve_mentions(message_text, team_id).await;

            // Download any uploaded attachments into our DB (linked to the user
            // message inside chat()). A message with only files gets a placeholder
            // body. Failed downloads are surfaced to the agent via runtime_notices
            // (system prompt) so it reliably tells the user instead of the file
            // silently vanishing.
            let downloaded = self
                .download_slack_files(
                    &files,
                    SlackFileContext {
                        external_ts: event_ts.map(str::to_string),
                        thread_id: None,
                        ..SlackFileContext::default()
                    },
                )
                .await?;
            let shared_something =
                !downloaded.attachment_ids.is_empty() || !downloaded.failures.is_empty();
            let effective_text = if resolved_text.is_empty() && shared_something {
                describe_shared_files(&files)
            } else {
                resolved_text
            };

            // Look up the sender's Slack identity and tag the message with the
            // sender's <@USERID:Name> marker so the agent can emit a real
            // mention back to them on reply.
            let sender_info = self.get_user_info(slack_user_id, team_id).await;
            let tagged_text = self.build_sender_tagged_content(
                slack_user_id,
                sender_info.as_ref().and_then(SlackUserInfo::display_name),
                &effective_text,
            );

            // Resolve a dedicated DM thread so Slack DM history stays out of the
            // webchat ACTIVE thread (which is keyed by externalThreadId: null).
            //   - Top-level DM turn (no thread_ts) → key by dm_channel_id, threadSource
            //     stays DATABASE. All top-level turns share one ongoing
            //     ConversationThread; the database provider serves its history.
            //   - Threaded DM turn (thread_ts present) → key by thread_ts AND pass
            //     the channel so threadSource flips to SLACK. Reads then flow
            //     through the Slack thread provider, returning the parent message +
            //     all replies straight from Slack. Without this the parent lives on
            //     the top-level ConversationThread row and is invisible to the
            //     threaded turn's context builder.
            //   In routed mode the thread's history is stored instead
            //   (`stored_thread`).
            let thread_key = thread_ts.unwrap_or(dm_channel_id);
            let lens_user_id = mapping.lens_user_id.clone().unwrap_or_default();
            let dm_thread = match (thread_ts, routed) {
                (Some(thread_ts), Some(_)) => {
                    self.stored_thread(
                        &lens_user_id,
                        &mapping.agent_id,
                        dm_channel_id,
                        thread_ts,
                        event_ts.unwrap_or(thread_ts),
                        team_id,
                    )
                    .await?
                }
                _ => {
                    CONVERSATION_SERVICE
                        .get_or_create_thread_by_external_id(
                            &lens_user_id,
                            &mapping.agent_id,
                            thread_key,
                            thread_ts.map(|_| LiveThread {
                                source: ThreadSource::Slack,
                                channel_id: dm_channel_id.to_string(),
                            }),
                        )
                        .await?
                }
            };

            // chat() stores the message next (see `RoutedEvent`).
            if let Some(routed) = routed {
                routed.hand_off.hand_off();
            }

            // Route through the local conversation engine (direct call).
            // metadata.channel = slack scopes delivery to Slack only; channel_thread_id
            // makes the reply land in the same DM thread (absent → top-level).
            CONVERSATION_ENGINE_SERVICE
                .chat(ChatInput {
                    user_id: lens_user_id,
                    agent_id: mapping.agent_id.clone(),
                    thread_id: Some(dm_thread.id),
                    message: tagged_text,
                    attachment_ids: Some(downloaded.attachment_ids),
                    runtime_notices: (!downloaded.failures.is_empty())
                        .then(|| vec![self.build_attachment_failure_note(&downloaded.failures)]),
                    on_tool_event: Some(create_tool_status_listener(handle)),
                    metadata: Some(ChatMetadata {
                        channel: Some(ChannelName::Slack),
                        channel_thread_id: thread_ts.map(str::to_string),
                        ..ChatMetadata::default()
                    }),
                    ..ChatInput::default()
                })
                .await?;
            Ok(())
        }
        .await;

        let mut outcome = Ok(());
        if let Err(error) = turn {
            log_error!(
                json!({
                    "err": err_json(&error),
                    "slackUserId": slack_user_id,
                    "channel": dm_channel_id,
                    "connectionId": connection_id,
                    "teamId": team_id,
                    "eventTs": event_ts,
                }),
                "Slack DM processing error"
            );
            outcome = say
                .text(&format!(
                    "Sorry, I encountered an error processing your message: {error}"
                ))
                .await;
        }
        let handle = indicator.lock().take();
        if let Some(handle) = handle {
            handle.end().await;
        }
        outcome
    }

    /// Handle channel messages (team agent mode)
    ///
    /// Only respond in threads the bot takes part in or when mentioned. A message
    /// in a heartbeat trigger channel is queued for the heartbeat instead.
    #[allow(clippy::too_many_arguments)]
    async fn handle_channel_message(
        &self,
        connection_id: &str,
        channel_id: &str,
        slack_user_id: &str,
        message_text: &str,
        thread_ts: Option<&str>,
        message_ts: &str,
        say: &Say,
        bot_user_id: &str,
        team_id: &str,
        files: Vec<SlackFileMeta>,
        routed: Option<&RoutedEvent>,
    ) -> anyhow::Result<()> {
        let bot_mention = format!("<@{bot_user_id}>");
        // A router says whether it addressed the message to this agent, by a
        // mention, a user group or the agent's name.
        let is_mentioned = match routed {
            Some(routed) => routed.route == SlackRoute::Mention,
            None => message_text.contains(&bot_mention),
        };

        // File-only messages reach the queue paths below with empty text — those
        // paths never download files, so describe them instead of enqueueing ''
        // (which would render as an empty heartbeat entry while the file
        // silently vanishes).
        let queue_text = if message_text.is_empty() && !files.is_empty() {
            describe_shared_files(&files)
        } else {
            message_text.to_string()
        };

        // Check if this channel is a heartbeat trigger channel (direct local call)
        let trigger_check = SLACK_HEARTBEAT_TRIGGER_SERVICE
            .is_heartbeat_trigger_channel(channel_id)
            .await?;

        if trigger_check.is_trigger {
            let agent_id = trigger_check.agent_id.clone().unwrap_or_default();
            log_info!(
                "[SlackAdapter] Heartbeat trigger received in channel {} for agent {}",
                channel_id,
                agent_id
            );
            let user_info = self.get_user_info(slack_user_id, team_id).await;
            let sender_name = user_info
                .as_ref()
                .and_then(SlackUserInfo::display_name)
                .unwrap_or(slack_user_id)
                .to_string();

            SLACK_MESSAGE_QUEUE_SERVICE
                .enqueue(
                    &agent_id,
                    &ChannelTriggerMessage {
                        sender: sender_name,
                        text: queue_text,
                        timestamp: crate::support::now_iso(),
                    },
                )
                .await?;
            // In the background: throttle errors shouldn't surface to the user
            // since the message was already enqueued successfully
            tokio::spawn(async move {
                if let Err(error) = SLACK_ADAPTER_SERVICE.throttled_notify(&agent_id).await {
                    log_error!(
                        "[SlackAdapter] throttledNotify failed for agent {}: {}",
                        agent_id,
                        error
                    );
                }
            });
            return Ok(());
        }

        // Check if channel is linked to an agent
        let Some(mapping) = SLACK_MAPPING_SERVICE.find_by_channel_id(channel_id).await? else {
            // Only an unlinked channel takes a link code. Strip the bot mention first
            // so "@Bot ABC123" is detected as a code. In routed mode the router
            // links channels, so no message is a code.
            let code = routed
                .is_none()
                .then(|| self.parse_link_code(&message_text.replace(&bot_mention, "")))
                .flatten();
            if let Some(code) = code {
                log_info!(
                    "Received potential verification code in channel {}",
                    channel_id
                );
                let result = self
                    .verify_and_link_channel(&code, channel_id, slack_user_id, Some(team_id))
                    .await;
                // A six-hex message without a mention is often not a code at all, such as a short commit SHA.
                if !result.success && !is_mentioned {
                    log_info!(
                        "Verification code rejected in channel {} without a bot mention — no reply: {}",
                        channel_id,
                        result.message
                    );
                    return Ok(());
                }
                let reply = if result.success {
                    format!("✅ {}", result.message)
                } else {
                    format!("❌ {}", result.message)
                };
                if let Err(error) = say.text(&reply).await {
                    log_warn!(
                        "Failed to post verification result in channel {}: {}",
                        channel_id,
                        error
                    );
                }
                return Ok(());
            }

            log_info!(
                "Slack channel {} is not linked to an agent — message not handled",
                channel_id
            );
            // Channel not linked — if the bot was @mentioned, prompt the user to link.
            // A routed agent may post only in its linked channels.
            if is_mentioned && routed.is_none() {
                say.text("I'm not activated in this channel yet.\n\nPlease enter a verification code from your agent settings to link me.").await?;
            }
            return Ok(());
        };

        let channel_label = mapping
            .mapping
            .slack_channel_name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| channel_id.to_string());

        // For channel mappings, lensUserId is the agent owner who linked the channel.
        // It must be set — there is no other user to fall back to.
        let Some(user_id) = mapping
            .mapping
            .lens_user_id
            .clone()
            .filter(|id| !id.is_empty())
        else {
            log_warn!(
                "Channel mapping for {} has no lensUserId - skipping (legacy mapping?)",
                channel_id
            );
            if is_mentioned {
                say.text("This channel has an incomplete configuration. Please unlink and re-link the channel.").await?;
            }
            return Ok(());
        };
        let agent_id = mapping.mapping.agent_id.clone();
        let mapping_team_id = mapping.connection.team_id.clone();

        log_info!(
            "Slack channel message from {} in {} (threadTs={}, isMentioned={}, botUserId={}, text={})",
            slack_user_id,
            channel_label,
            thread_ts.unwrap_or("none"),
            is_mentioned,
            bot_user_id,
            slice16(message_text, 0, 80)
        );

        // For top-level messages (not in a thread), only respond if mentioned
        if thread_ts.is_none() && !is_mentioned {
            log_info!(
                "Channel message not answered: top-level message without bot mention (agent={}, channel={})",
                agent_id,
                channel_label
            );
            return Ok(());
        }

        // For thread messages, check if bot is participating in the thread
        if let (Some(thread_ts), false) = (thread_ts, is_mentioned) {
            // `conversations.replies` is eventually consistent, so the gate is given
            // the message it must judge rather than relying on the read to hold it.
            // In routed mode the gate reads the stored thread instead.
            let arriving = GateMessage {
                user: Some(slack_user_id.to_string()),
                text: Some(message_text.to_string()),
                ts: Some(message_ts.to_string()),
                files: files.clone(),
                ..GateMessage::default()
            };
            let stored = match routed {
                Some(_) => Some(
                    self.stored_thread(
                        &user_id,
                        &agent_id,
                        channel_id,
                        thread_ts,
                        message_ts,
                        &mapping_team_id,
                    )
                    .await?,
                ),
                None => None,
            };
            let (result, messages) = match &stored {
                Some(stored) => {
                    self.stored_thread_gate(&stored.id, arriving, bot_user_id)
                        .await?
                }
                None => {
                    self.is_bot_in_thread(channel_id, thread_ts, &mapping_team_id, arriving)
                        .await
                }
            };
            // A stored thread keeps a reply the agent does not answer, so the next
            // turn and the next classification read it.
            let keep_unanswered = || async {
                match &stored {
                    Some(stored) => {
                        self.store_unanswered(
                            &stored.id,
                            slack_user_id,
                            &queue_text,
                            &mapping_team_id,
                            routed,
                        )
                        .await
                    }
                    None => Ok(()),
                }
            };

            match result {
                ThreadParticipation::Ignore => {
                    log_info!(
                        "Channel message not answered: thread message where bot is not participating (agent={}, channel={})",
                        agent_id,
                        channel_label
                    );
                    return Ok(());
                }
                ThreadParticipation::React => {
                    self.add_reaction(channel_id, message_ts, &mapping_team_id, "eyes")
                        .await;
                    keep_unanswered().await?;
                    log_info!(
                        "Channel message not answered: thread message addressed to another person, reacted (agent={}, channel={})",
                        agent_id,
                        channel_label
                    );
                    return Ok(());
                }
                ThreadParticipation::Respond => {}
            }

            // Respond — double-check with the classifier
            let verdict = self
                .classify_thread_message(&messages, bot_user_id, &agent_id, &mapping_team_id)
                .await?;

            if verdict == ThreadAction::Ignore {
                keep_unanswered().await?;
                log_info!(
                    "Channel message not answered: LLM classifier decided to ignore thread message (agent={}, channel={})",
                    agent_id,
                    channel_label
                );
                return Ok(());
            }
        }

        // Bot should respond - process through conversation engine
        let slack_thread_id = thread_ts.unwrap_or(message_ts).to_string();
        let indicator: Mutex<Option<Arc<dyn WorkingIndicatorHandle>>> = Mutex::new(None);
        let turn: anyhow::Result<()> = async {
            // Working cue for the whole turn — started before the (possibly slow)
            // read-consistency wait below so the user sees it immediately. The
            // reply always lands in slack_thread_id's thread, so the status line
            // attaches there; the fallback reaction, when the status cannot be
            // set, trails it by one Slack round trip.
            let handle = self
                .working_indicator()
                .begin(WorkingIndicatorTarget {
                    team_id: mapping_team_id.clone(),
                    channel_id: channel_id.to_string(),
                    message_ts: Some(message_ts.to_string()),
                    status_thread_ts: Some(slack_thread_id.clone()),
                })
                .await;
            *indicator.lock() = Some(handle.clone());

            // Get or create thread bound to this Slack thread
            let thread = match routed {
                Some(_) => {
                    self.stored_thread(
                        &user_id,
                        &agent_id,
                        channel_id,
                        &slack_thread_id,
                        message_ts,
                        &mapping_team_id,
                    )
                    .await?
                }
                None => {
                    CONVERSATION_SERVICE
                        .get_or_create_thread_by_external_id(
                            &user_id,
                            &agent_id,
                            &slack_thread_id,
                            Some(LiveThread {
                                source: ThreadSource::Slack,
                                channel_id: channel_id.to_string(),
                            }),
                        )
                        .await?
                }
            };

            // Add participant tracking
            let user_info = self.get_user_info(slack_user_id, &mapping_team_id).await;
            let sender_name = user_info
                .as_ref()
                .and_then(SlackUserInfo::display_name)
                .map(str::to_string);
            self.add_participant(
                &thread.id,
                slack_user_id,
                sender_name.as_deref().unwrap_or("Unknown"),
            )
            .await;

            // Strip bot mention only, then resolve remaining user mentions to display names
            let without_bot = js_trim(&message_text.replace(&bot_mention, "")).to_string();
            let text = self.resolve_mentions(&without_bot, &mapping_team_id).await;

            // Download any uploaded attachments. `external_ts` is the carrying
            // message's ts so the live-read Slack thread provider can re-associate
            // them on later turns; `thread_id` scopes that lookup.
            let downloaded = self
                .download_slack_files(
                    &files,
                    SlackFileContext {
                        external_ts: Some(message_ts.to_string()),
                        thread_id: Some(thread.id.clone()),
                        ..SlackFileContext::default()
                    },
                )
                .await?;
            let shared_something =
                !downloaded.attachment_ids.is_empty() || !downloaded.failures.is_empty();
            let effective_text = if text.is_empty() && shared_something {
                describe_shared_files(&files)
            } else {
                text
            };
            let tagged_text = self.build_sender_tagged_content(
                slack_user_id,
                sender_name.as_deref(),
                &effective_text,
            );

            // Slack's conversations.replies is eventually consistent: the message we
            // just received may not be returned by the live thread read for a few
            // seconds. Wait (bounded, exponential backoff up to 30s) for it to be
            // visible before the engine builds context, so the assembled history ends
            // on the user's turn rather than the bot's previous reply (which the
            // provider rejects: "the conversation must end with a user message").
            // Fails on timeout — surfaced to the user below — so we never respond
            // to stale context. A routed thread's history is stored, so it waits
            // for nothing.
            if routed.is_none() {
                self.slack_thread_provider
                    .wait_for_external_message(&thread.id, message_ts, PollUntilOptions::default())
                    .await?;
            }

            // chat() stores the message next (see `RoutedEvent`).
            if let Some(routed) = routed {
                routed.hand_off.hand_off();
            }

            // Route through the local conversation engine (direct call)
            CONVERSATION_ENGINE_SERVICE
                .chat(ChatInput {
                    user_id: user_id.clone(),
                    agent_id: agent_id.clone(),
                    thread_id: Some(thread.id.clone()),
                    message: tagged_text,
                    attachment_ids: Some(downloaded.attachment_ids),
                    runtime_notices: (!downloaded.failures.is_empty())
                        .then(|| vec![self.build_attachment_failure_note(&downloaded.failures)]),
                    on_tool_event: Some(create_tool_status_listener(handle)),
                    metadata: Some(ChatMetadata {
                        channel: Some(ChannelName::Slack),
                        channel_id: Some(channel_id.to_string()),
                        channel_thread_id: Some(slack_thread_id.clone()),
                        channel_label: Some(slack_channel_label(
                            &mapping
                                .mapping
                                .slack_channel_name
                                .clone()
                                .unwrap_or_else(|| channel_id.to_string()),
                        )),
                        sender_external_id: Some(slack_user_id.to_string()),
                        sender_name: sender_name.clone(),
                    }),
                    ..ChatInput::default()
                })
                .await?;
            Ok(())
        }
        .await;

        let mut outcome = Ok(());
        if let Err(error) = turn {
            log_error!(
                json!({
                    "err": err_json(&error),
                    "slackUserId": slack_user_id,
                    "channel": channel_id,
                    "connectionId": connection_id,
                    "teamId": team_id,
                    "threadTs": thread_ts,
                    "messageTs": message_ts,
                }),
                "Slack channel message processing error"
            );
            outcome = say
                .in_thread(
                    &format!("Sorry, I encountered an error: {error}"),
                    &slack_thread_id,
                )
                .await;
        }
        let handle = indicator.lock().take();
        if let Some(handle) = handle {
            handle.end().await;
        }
        outcome
    }

    /// Core feedback-click logic for the 👍/👎 buttons (`body` is the
    /// `block_actions` payload).
    ///
    /// Resolves the message by its id and Slack ts, emits `message feedback`
    /// with userId null and the raw Slack user id as `slack.user.id`, then swaps
    /// the actions block for an inline "Thanks for the feedback!" context block
    /// via chat.update and removes that ack after `FEEDBACK_ACK_LINGER_MS`.
    /// A click on an unknown message still gets the ack, so the user is not
    /// left with dangling buttons.
    pub async fn handle_feedback_action(
        &self,
        body: &serde_json::Value,
        client: Arc<dyn FeedbackChatClient>,
        rating: FeedbackRating,
    ) -> anyhow::Result<()> {
        let action = body.pointer("/actions/0");
        let slack_user_id = body.pointer("/user/id").and_then(Value::as_str);
        let channel_id = body.pointer("/channel/id").and_then(Value::as_str);
        let message_ts = body.pointer("/message/ts").and_then(Value::as_str);
        let message_id = action.and_then(|a| a.get("value")).and_then(Value::as_str);

        let (Some(_), Some(slack_user_id), Some(channel_id), Some(message_ts), Some(message_id)) = (
            action.filter(|a| !a.is_null()),
            slack_user_id.filter(|v| !v.is_empty()),
            channel_id.filter(|v| !v.is_empty()),
            message_ts.filter(|v| !v.is_empty()),
            message_id.filter(|v| !v.is_empty()),
        ) else {
            log_warn!("[SlackAdapter] Feedback payload missing required fields");
            return Ok(());
        };
        let original = body.get("message");

        // Resolve the ConversationMessage + thread to capture agent/thread attrs for telemetry.
        let (id, ts) = (message_id.to_string(), message_ts.to_string());
        let found: Option<(ConversationMessage, String)> = crate::db::read(move |conn| {
            Ok(cm::conversation_messages
                .inner_join(ct::conversation_threads)
                .filter(cm::id.eq(&id))
                .filter(cm::external_message_id.eq(&ts))
                .select((ConversationMessage::as_select(), ct::agent_id))
                .first(conn)
                .optional()?)
        })
        .await?;

        let Some((conversation_message, agent_id)) = found else {
            log_warn!(
                "[SlackAdapter] Feedback click for unknown message id={} ts={}",
                message_id,
                message_ts
            );
            // Still acknowledge so the user isn't left with dangling buttons.
            self.replace_feedback_buttons_with_ack(client, channel_id, message_ts, original)
                .await;
            return Ok(());
        };

        let mut props = IndexMap::new();
        props.insert("message.id".to_string(), message_id.to_string());
        props.insert("thread.id".to_string(), conversation_message.thread_id);
        props.insert("agent.id".to_string(), agent_id);
        props.insert("channel.type".to_string(), "slack".to_string());
        props.insert("feedback.rating".to_string(), rating.as_str().to_string());
        props.insert("feedback.source".to_string(), "slack_blockkit".to_string());
        props.insert("slack.user.id".to_string(), slack_user_id.to_string());
        track_event("message feedback", None, Some(props));

        self.replace_feedback_buttons_with_ack(client, channel_id, message_ts, original)
            .await;
        Ok(())
    }

    /// Swap the feedback actions block on the original Slack message for an
    /// inline generic "Thanks for the feedback!" context block via chat.update,
    /// then auto-remove that ack block after `FEEDBACK_ACK_LINGER_MS` so the
    /// message returns to a clean state.
    ///
    /// Visible to everyone in channel/team mode while the ack lingers. Also serves
    /// as idempotency: the buttons are removed on the first update so no further
    /// clicks are possible. `text` is omitted from chat.update, so Slack keeps the
    /// original notification fallback.
    async fn replace_feedback_buttons_with_ack(
        &self,
        client: Arc<dyn FeedbackChatClient>,
        channel_id: &str,
        message_ts: &str,
        original: Option<&serde_json::Value>,
    ) {
        // Strip any prior feedback-related blocks (actions + any lingering ack),
        // so concurrent clicks or re-entries don't stack blocks.
        let cleaned_blocks: Vec<Value> = original
            .and_then(|o| o.get("blocks"))
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| {
                        let id = b.get("block_id").and_then(Value::as_str);
                        id != Some(FEEDBACK_BLOCK_ID) && id != Some(FEEDBACK_ACK_BLOCK_ID)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        // `text` is omitted from chat.update — Slack keeps the original
        // notification fallback. Echoing it back tripped `msg_too_long` for very
        // long agent replies, since the formatter sets text=content.
        let mut with_ack = cleaned_blocks.clone();
        with_ack.push(serde_json::to_value(build_feedback_ack_block()).unwrap_or(Value::Null));

        if let Err(error) = client
            .chat_update(json!({ "channel": channel_id, "ts": message_ts, "blocks": with_ack }))
            .await
        {
            log_warn!(
                "[SlackAdapter] Failed to replace feedback buttons with ack: {}",
                error
            );
            return;
        }

        // Remove the ack block after a while so the message settles back to a
        // clean state. Best-effort: failures are logged and swallowed.
        let (channel_id, message_ts) = (channel_id.to_string(), message_ts.to_string());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(FEEDBACK_ACK_LINGER_MS)).await;
            if let Err(error) = client
                .chat_update(
                    json!({ "channel": channel_id, "ts": message_ts, "blocks": cleaned_blocks }),
                )
                .await
            {
                log_warn!(
                    "[SlackAdapter] Failed to clear feedback ack block: {}",
                    error
                );
            }
        });
    }

    /// The bot joined a channel: a channel with no agent gets the welcome message
    /// asking for a verification code.
    async fn on_member_joined_channel(
        &self,
        context: &ConnectionContext,
        event: &Value,
        client: &SlackWebClient,
        routed: bool,
    ) -> anyhow::Result<()> {
        let user = event.get("user").and_then(Value::as_str);
        let channel = event.get("channel").and_then(Value::as_str).unwrap_or("");

        // Only handle when the bot itself joins. A routed bot is linked by the
        // router, so it asks for no code.
        if user != Some(context.bot_user_id.as_str()) || routed {
            return Ok(());
        }

        log_info!("Bot joined channel {}", channel);

        // Check if channel already has a linked agent
        if SLACK_MAPPING_SERVICE
            .find_by_channel_id(channel)
            .await?
            .is_some()
        {
            // Already linked, no action needed
            log_info!("Channel {} already linked to an agent", channel);
            return Ok(());
        }

        // Post welcome message asking for verification code
        if let Err(error) = client
            .api_call(
                "chat.postMessage",
                json!({
                    "channel": channel,
                    "text": "👋 Hi! I've been added to this channel.\n\nTo activate me, please enter the verification code from your agent settings.\nYou can find this in *Settings → Channels → Link to Channel*.",
                }),
            )
            .await
        {
            log_error!(
                "Failed to post welcome message to channel {}: {}",
                channel,
                error
            );
        }
        Ok(())
    }

    /// The bot left a channel: its mapping goes.
    async fn on_member_left_channel(
        &self,
        context: &ConnectionContext,
        event: &Value,
    ) -> anyhow::Result<()> {
        let user = event.get("user").and_then(Value::as_str);
        let channel = event.get("channel").and_then(Value::as_str).unwrap_or("");

        // Only handle when the bot itself leaves
        if user != Some(context.bot_user_id.as_str()) {
            return Ok(());
        }

        log_info!("Bot left channel {}", channel);

        // Remove channel mapping if exists; one might not exist, that's fine
        if SLACK_MAPPING_SERVICE
            .delete_channel_mapping(channel)
            .await
            .is_ok()
        {
            log_info!("Removed channel mapping for {}", channel);
        }
        Ok(())
    }

    /// The link code in a message, uppercased, or `None`. Slack formatting
    /// (*bold*, _italic_, ~strike~, `code`) around the code is ignored.
    fn parse_link_code(&self, text: &str) -> Option<String> {
        let stripped = SLACK_FORMATTING.replace_all(text, "");
        let stripped = js_trim(&stripped);
        if LINK_CODE.is_match(stripped) {
            Some(stripped.to_uppercase())
        } else {
            None
        }
    }

    /// Verify a DM link code (the same logic as the management route): create
    /// the user mapping and consume the code in one transaction.
    async fn verify_dm_link_code(
        &self,
        code: &str,
        slack_user_id: &str,
        dm_channel_id: &str,
    ) -> anyhow::Result<LinkResult> {
        Ok(
            match redeem_dm_code(code, slack_user_id, dm_channel_id).await? {
                DmCodeOutcome::Invalid => {
                    LinkResult::refused(&code_not_valid(&self.agent_name().await?))
                }
                DmCodeOutcome::Expired => {
                    LinkResult::refused(&code_expired(&self.agent_name().await?))
                }
                DmCodeOutcome::LinkedToSameUser => LinkResult::refused(
                    "Your Slack account is already linked to another agent. Unlink it first from that agent's settings.",
                ),
                DmCodeOutcome::LinkedToOtherUser => LinkResult::refused(&format!(
                    "This Slack account is already linked to another user of {}.",
                    self.agent_name().await?
                )),
                DmCodeOutcome::Linked(verification) => {
                    log_info!(
                        "Slack account linked via code: {} -> {}",
                        slack_user_id,
                        verification.lens_user_id
                    );
                    LinkResult {
                        success: true,
                        message: format!(
                            "Your Slack account is now linked. You can chat with {} here.",
                            verification
                                .agent_name
                                .filter(|name| !name.is_empty())
                                .unwrap_or_else(|| "your agent".to_string())
                        ),
                        agent_name: None,
                    }
                }
            },
        )
    }

    /// Verify and link a channel to an agent. A failure is a result whose message
    /// is `Verification failed: {error}`.
    async fn verify_and_link_channel(
        &self,
        code: &str,
        channel_id: &str,
        slack_user_id: &str,
        team_id: Option<&str>,
    ) -> LinkResult {
        let verified: anyhow::Result<LinkResult> = async {
            // Fetch channel name if we have teamId
            let channel_name = match team_id {
                Some(team_id) => self.get_channel_name(channel_id, team_id).await,
                None => None,
            };

            // Verify directly (same logic as the management route)
            let result = self
                .verify_channel_link_code_local(code, channel_id, channel_name.as_deref())
                .await?;

            if result.success {
                return Ok(result);
            }

            Ok(LinkResult {
                success: false,
                message: if result.message.is_empty() {
                    "Invalid or expired code".to_string()
                } else {
                    result.message
                },
                agent_name: None,
            })
        }
        .await;
        match verified {
            Ok(result) => result,
            Err(error) => {
                log_error!(
                    json!({ "err": err_json(&error), "channelId": channel_id }),
                    "Channel link verification failed"
                );
                LinkResult::refused(&format!("Verification failed: {error}"))
            }
        }
    }

    /// Verify a channel link code: create the channel mapping and consume the code
    /// in one transaction.
    async fn verify_channel_link_code_local(
        &self,
        code: &str,
        channel_id: &str,
        channel_name: Option<&str>,
    ) -> anyhow::Result<LinkResult> {
        let stored_name = channel_name
            .filter(|name| !name.is_empty())
            .unwrap_or(channel_id)
            .to_string();
        Ok(
            match redeem_channel_code(code, channel_id, Some(stored_name)).await? {
                ChannelCodeOutcome::Invalid => {
                    LinkResult::refused(&code_not_valid(&self.agent_name().await?))
                }
                ChannelCodeOutcome::Expired => {
                    LinkResult::refused(&code_expired(&self.agent_name().await?))
                }
                ChannelCodeOutcome::AlreadyLinked => {
                    LinkResult::refused("This channel is already linked to an agent.")
                }
                ChannelCodeOutcome::Linked(verification) => {
                    log_info!(
                        "Slack channel linked via code: {} -> {}'s agent",
                        channel_id,
                        verification.lens_user_id
                    );
                    LinkResult {
                        success: true,
                        message:
                            "Your Slack channel is now linked. Mention me anytime you need help!"
                                .to_string(),
                        agent_name: verification.agent_name,
                    }
                }
            },
        )
    }

    /// Check if bot is participating in a thread (heuristic pass)
    ///
    /// Judges `arriving`, the message this call was triggered by, and returns a
    /// participation verdict plus the thread messages so the caller can forward
    /// them to the LLM classifier without re-fetching. The returned transcript
    /// ends on `arriving`, which is the message the caller reacts to or answers.
    async fn is_bot_in_thread(
        &self,
        channel_id: &str,
        thread_ts: &str,
        team_id: &str,
        arriving: GateMessage,
    ) -> (ThreadParticipation, Vec<GateMessage>) {
        let Some(slack_app) = self.app(team_id) else {
            return (ThreadParticipation::Ignore, Vec::new());
        };

        let read = slack_app
            .client
            .api_call(
                "conversations.replies",
                json!({ "channel": channel_id, "ts": thread_ts, "limit": 100 }),
            )
            .await;
        let reply = match read {
            Ok(reply) => reply,
            Err(error) => {
                log_error!(
                    "isBotInThread failed for channel {}, thread {}: {}",
                    channel_id,
                    thread_ts,
                    error
                );
                return (ThreadParticipation::Ignore, Vec::new());
            }
        };

        // `conversations.replies` is eventually consistent, so the read may lack
        // `arriving` or already hold a message posted after it. Both cut to a
        // transcript ending on `arriving`.
        let fetched: Vec<GateMessage> = reply
            .get("messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages
                    .iter()
                    .map(|m| serde_json::from_value(m.clone()).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default();
        let arriving_ts = arriving.ts.clone();
        let arriving_text = arriving.text.clone().unwrap_or_default();
        let messages = match fetched.iter().position(|m| m.ts == arriving_ts) {
            Some(at) => fetched[..=at].to_vec(),
            None => fetched
                .into_iter()
                .chain(std::iter::once(arriving))
                .collect(),
        };

        // Bot never posted in this thread
        if !messages
            .iter()
            .any(|m| m.user.as_deref() == Some(slack_app.bot_user_id.as_str()))
        {
            return (ThreadParticipation::Ignore, messages);
        }

        // The arriving message tags somebody other than the bot, so it is
        // addressed to that person. Only this message is read: a tag earlier in
        // the thread is addressed to somebody else and leaves a later message
        // aimed at the bot answerable.
        if tags_somebody_else(&arriving_text, &slack_app.bot_user_id) {
            return (ThreadParticipation::React, messages);
        }

        // Bot is participating and the message is not addressed elsewhere — pass to LLM
        (ThreadParticipation::Respond, messages)
    }

    /// Second pass after the heuristic: the shared classifier decides whether the
    /// bot responds to or ignores the last message of `messages`, which starts at
    /// the thread root. Each author and mention is named, and a bot is told from a
    /// person by the message's `bot_id` or the user's `is_bot`.
    async fn classify_thread_message(
        &self,
        messages: &[GateMessage],
        bot_user_id: &str,
        agent_id: &str,
        team_id: &str,
    ) -> anyhow::Result<ThreadAction> {
        let agent = load_gate_agent().await?;
        // The root and the messages the classifier reads, so only those are named.
        let rest = messages.get(1..).unwrap_or(&[]);
        let tail = &rest[rest.len().saturating_sub(THREAD_TRANSCRIPT_LINES + 1)..];
        let read: Vec<&GateMessage> = messages.iter().take(1).chain(tail.iter()).collect();

        // A mention of the bot names the agent, as the agent's own lines do.
        let stripped = MENTION_NAME_STRIP.replace_all(&agent.name, "");
        let agent_mention_name = match js_trim(&stripped) {
            "" => bot_user_id.to_string(),
            name => name.to_string(),
        };
        let agent_mention = format!("<@{bot_user_id}:{agent_mention_name}>");
        let bare_bot = format!("<@{bot_user_id}>");

        let lines = futures::future::join_all(read.iter().map(|m| {
            let agent_name = agent.name.clone();
            let text = gate_text(m).replace(&bare_bot, &agent_mention);
            async move {
                let author = if m.user.as_deref() == Some(bot_user_id) {
                    ThreadAuthor {
                        kind: ThreadAuthorKind::Agent,
                        name: agent_name,
                    }
                } else {
                    let user = m.user.as_deref().filter(|u| !u.is_empty());
                    let info = match user {
                        Some(user) => self.get_user_info(user, team_id).await,
                        None => None,
                    };
                    let name = m
                        .bot_profile
                        .as_ref()
                        .and_then(|p| p.name.clone())
                        .filter(|n| !n.is_empty())
                        .or_else(|| m.username.clone().filter(|n| !n.is_empty()))
                        .or_else(|| {
                            info.as_ref()
                                .and_then(SlackUserInfo::display_name)
                                .map(str::to_string)
                        })
                        .or_else(|| user.map(str::to_string))
                        .unwrap_or_else(|| "unknown".to_string());
                    let is_bot = m.bot_id.as_deref().is_some_and(|id| !id.is_empty())
                        || info.as_ref().and_then(|i| i.is_bot) == Some(true);
                    ThreadAuthor {
                        kind: if is_bot {
                            ThreadAuthorKind::Bot
                        } else {
                            ThreadAuthorKind::Person
                        },
                        name,
                    }
                };
                let text = self.resolve_mentions(&text, team_id).await;
                ThreadLine { author, text }
            }
        }))
        .await;

        Ok(THREAD_REPLY_CLASSIFIER_SERVICE
            .classify(&ClassifyInput {
                platform: ThreadPlatform {
                    channel: ChatPlatform::Slack,
                    name: "Slack".to_string(),
                },
                agent_id: agent_id.to_string(),
                agent,
                lines,
            })
            .await)
    }

    /// Add a reaction emoji to a Slack message (best-effort, awaited).
    ///
    /// Errors are logged; failures do not reach the caller.
    async fn add_reaction(&self, channel_id: &str, message_ts: &str, team_id: &str, emoji: &str) {
        let Some(slack_app) = self.app(team_id) else {
            return;
        };
        if let Err(error) = slack_app
            .client
            .api_call(
                "reactions.add",
                json!({ "channel": channel_id, "timestamp": message_ts, "name": emoji }),
            )
            .await
        {
            log_warn!("Failed to add reaction {}: {}", emoji, error);
        }
    }

    /// Remove a reaction emoji from a Slack message (best-effort, awaited).
    ///
    /// `no_reaction` is the expected error when the earlier add failed —
    /// logged like every other failure here.
    async fn remove_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        team_id: &str,
        emoji: &str,
    ) {
        let Some(slack_app) = self.app(team_id) else {
            return;
        };
        if let Err(error) = slack_app
            .client
            .api_call(
                "reactions.remove",
                json!({ "channel": channel_id, "timestamp": message_ts, "name": emoji }),
            )
            .await
        {
            log_warn!("Failed to remove reaction {}: {}", emoji, error);
        }
    }

    /// Assistant thread status ("is thinking…" next to the bot name).
    ///
    /// Fails when the status cannot be set — routine when the app lacks the
    /// `assistant:write` scope, is not configured as a Slack AI app, or the
    /// target thread does not render statuses. The working indicator catches
    /// the failure and falls back to the eyes reaction. `loading_messages` is
    /// omitted, so Slack rotates its own default phrases.
    async fn set_assistant_status(
        &self,
        team_id: &str,
        channel_id: &str,
        thread_ts: &str,
        status: &str,
    ) -> anyhow::Result<()> {
        let Some(slack_app) = self.app(team_id) else {
            anyhow::bail!("no Slack app for team {team_id}");
        };
        slack_app
            .client
            .api_call(
                "assistant.threads.setStatus",
                json!({ "channel_id": channel_id, "thread_ts": thread_ts, "status": status }),
            )
            .await?;
        Ok(())
    }

    /// Get user info from Slack, cached for `USER_INFO_TTL_MS`. `None` when the
    /// team has no app or the call fails.
    async fn get_user_info(&self, slack_user_id: &str, team_id: &str) -> Option<SlackUserInfo> {
        let slack_app = self.app(team_id)?;

        let key = format!("{team_id}:{slack_user_id}");
        if let Some(cached) = self.user_info_cache.get(&key)
            && cached.1 > crate::support::now_ms()
        {
            return Some(cached.0.clone());
        }

        let result = slack_app
            .client
            .api_call("users.info", json!({ "user": slack_user_id }))
            .await
            .ok()?;
        let user: SlackUserInfo = result
            .get("user")
            .filter(|u| u.is_object())
            .and_then(|u| serde_json::from_value(u.clone()).ok())?;
        self.user_info_cache.insert(
            key,
            (user.clone(), crate::support::now_ms() + USER_INFO_TTL_MS),
        );
        Some(user)
    }

    /// Download user-uploaded Slack files into our DB and return the new
    /// attachment ids (to link to the user message via `chat` `attachment_ids`).
    ///
    /// Enforces the 10 MB cap (from Slack's reported size, then again after
    /// download), dedups on Slack file id (events are at-least-once), and skips
    /// anything that fails to download. `external_ts` records the carrying
    /// message's ts so the live-read Slack channel provider can re-associate the
    /// file on later turns; `thread_id` scopes that lookup.
    pub(crate) async fn download_slack_files(
        &self,
        files: &[SlackFileMeta],
        ctx: SlackFileContext,
    ) -> anyhow::Result<SlackFileDownloadResult> {
        let mut result = SlackFileDownloadResult::default();
        if files.is_empty() {
            return Ok(result);
        }

        // Cap before downloading so we never pull bytes for files that would be
        // dropped at link time (the link enforces the same per-message cap).
        let mut to_process = files;
        if files.len() > MAX_ATTACHMENTS_PER_MESSAGE {
            to_process = &files[..MAX_ATTACHMENTS_PER_MESSAGE];
            result.failures.push(SlackFileFailure {
                filename: format!("{} more file(s)", files.len() - MAX_ATTACHMENTS_PER_MESSAGE),
                reason: format!(
                    "only the first {MAX_ATTACHMENTS_PER_MESSAGE} attachments per message are kept"
                ),
            });
        }

        let connection = get_slack_connection().await?;
        let Some(bot_token) = connection
            .map(|c| c.bot_token)
            .filter(|token| !token.is_empty())
        else {
            log_warn!(
                "[SlackAdapter] no bot token available; cannot download {} file(s)",
                to_process.len()
            );
            for file in to_process {
                result.failures.push(SlackFileFailure {
                    filename: file.filename(),
                    reason: "no Slack bot token is available to download it".to_string(),
                });
            }
            return Ok(result);
        };

        for file in to_process {
            let filename = file.filename();
            let stored: anyhow::Result<()> = async {
                let url = match slack_file_source(file) {
                    Ok(url) => url,
                    Err(reason) => {
                        log_warn!(
                            "[SlackAdapter] cannot download file {}: {}",
                            file.id,
                            reason
                        );
                        result.failures.push(SlackFileFailure {
                            filename: filename.clone(),
                            reason,
                        });
                        return Ok(());
                    }
                };

                let stored_key = match (&ctx.thread_id, ctx.thread_scoped) {
                    (Some(thread_id), true) => thread_scoped_file_id(thread_id, &file.id),
                    _ => file.id.clone(),
                };
                if ATTACHMENT_SERVICE
                    .exists_by_external_file_id(&stored_key)
                    .await?
                {
                    log_info!("[SlackAdapter] file {} already stored; skipping", file.id);
                    return Ok(());
                }

                // The download carries the bot token, so it goes to Slack or the
                // Slack API proxy only.
                if !may_receive_slack_token(url) {
                    log_warn!(
                        json!({ "fileId": file.id }),
                        "[SlackAdapter] file download URL is not on Slack or the Slack API proxy; not fetched"
                    );
                    result.failures.push(SlackFileFailure {
                        filename: filename.clone(),
                        reason: "its download address is not on Slack".to_string(),
                    });
                    return Ok(());
                }

                let fetched = self.fetch_slack_file(url, &bot_token);
                let buffer = match &ctx.signal {
                    Some(signal) => tokio::select! {
                        buffer = fetched => buffer?,
                        _ = signal.cancelled() => anyhow::bail!(DOWNLOAD_STOPPED),
                    },
                    None => fetched.await?,
                };
                if buffer.is_empty() {
                    log_warn!("[SlackAdapter] file {} downloaded empty; skipping", file.id);
                    result.failures.push(SlackFileFailure {
                        filename: filename.clone(),
                        reason: "it downloaded as an empty file".to_string(),
                    });
                    return Ok(());
                }
                if buffer.len() as i64 > MAX_FILE_SIZE_BYTES {
                    log_warn!(
                        "[SlackAdapter] file {} exceeds cap after download; skipping",
                        file.id
                    );
                    result.failures.push(SlackFileFailure {
                        filename: filename.clone(),
                        reason: format!("it exceeds the {MAX_FILE_SIZE_MB} MB limit"),
                    });
                    return Ok(());
                }

                let media_type = detect_media_type(&buffer, &filename, file.mimetype.as_deref());
                let row = ATTACHMENT_SERVICE
                    .create_once(CreateAttachmentInput {
                        filename: filename.clone(),
                        category: classify_media_type(&media_type),
                        media_type,
                        size_bytes: buffer.len() as i64,
                        data: buffer.to_vec(),
                        source: AttachmentSource::Platform(ChatPlatform::Slack),
                        thread_id: ctx.thread_id.clone(),
                        message_id: None,
                        external_file_id: Some(stored_key),
                        external_ts: ctx.external_ts.clone(),
                    })
                    .await?;
                // None = a concurrent redelivery already stored this file id.
                match row {
                    Some(row) => result.attachment_ids.push(row.id),
                    None => log_info!(
                        "[SlackAdapter] file {} already stored (concurrent delivery); skipping",
                        file.id
                    ),
                }
                Ok(())
            }
            .await;
            if let Err(error) = stored {
                log_error!(
                    json!({ "err": err_json(&error), "fileId": file.id }),
                    "[SlackAdapter] failed to download Slack file"
                );
                result.failures.push(SlackFileFailure {
                    filename,
                    reason: error.to_string(),
                });
            }
        }
        Ok(result)
    }

    /// Render download failures as a single runtime notice, delivered via the
    /// system prompt (`InvokeRequest.runtime_notices`). Worded to counter the failure
    /// modes seen in testing — the agent claiming no file was attached, and asking
    /// for a file path / hunting on disk — since user-embedded notes were ignored.
    fn build_attachment_failure_note(&self, failures: &[SlackFileFailure]) -> String {
        let list = failures
            .iter()
            .map(|f| format!("\"{}\": {}", f.filename, f.reason))
            .collect::<Vec<_>>()
            .join("; ");
        let many = failures.len() > 1;
        let their = if many { "their" } else { "its" };
        let theirs = if many {
            "their attached files"
        } else {
            "their attached file"
        };
        let were = if many {
            "they were chat attachments"
        } else {
            "it was a chat attachment"
        };
        format!(
            "The user attached {} to this message that could not be downloaded from \
             Slack, so you do NOT have {their} contents: {list}. In your reply, tell the user you couldn't \
             read {theirs} and give the reason; if it's an access/permission error, mention the Slack app \
             likely needs the `files:read` scope. Do not say no file was attached, and do not ask for a file \
             path or look on disk — {were} that failed to download, not a local file.",
            if many { "files" } else { "a file" },
        )
    }

    /// Fetch a single Slack file's bytes using bot-token Bearer auth. Slack
    /// returns an HTML login page (HTTP 200) — not a 401 — when the token can't
    /// read the file, so a `text/html` content type is treated as an auth failure.
    async fn fetch_slack_file(&self, url: &str, bot_token: &str) -> anyhow::Result<bytes::Bytes> {
        let client = get_proxy_dispatcher()
            .await
            .unwrap_or_else(|| FILE_CLIENT.clone());
        let response = client
            .get(url)
            .header("Authorization", format!("Bearer {bot_token}"))
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!(
                "Slack returned HTTP {} for the file download",
                response.status().as_u16()
            );
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if content_type.contains("text/html") {
            // Slack serves an HTML login/redirect page (HTTP 200) — not a 401 — when
            // the token can't read the file. Almost always a missing scope.
            anyhow::bail!(
                "Slack denied access to the file (the bot likely lacks the files:read scope, or the file is not shared with it)"
            );
        }
        Ok(response.bytes().await?)
    }

    /// Build the sender-tagged form of an inbound message — `<@U:Name>: text`.
    ///
    /// The agent's conversation history then carries the speaker's canonical
    /// Slack mention token, which the agent can copy verbatim into a reply
    /// (where `rewrite_outbound_mentions()` strips the embedded name and Slack
    /// fires a real notification).
    ///
    /// Falls back to the bare message when the sender's display name is unknown.
    fn build_sender_tagged_content(
        &self,
        slack_user_id: &str,
        sender_name: Option<&str>,
        text: &str,
    ) -> String {
        let Some(sender_name) = sender_name.filter(|name| !name.is_empty()) else {
            return text.to_string();
        };
        let stripped = MENTION_NAME_STRIP.replace_all(sender_name, "");
        let sanitized = js_trim(&stripped);
        let tag = if sanitized.is_empty() {
            format!("<@{slack_user_id}>")
        } else {
            format!("<@{slack_user_id}:{sanitized}>")
        };
        format!("{tag}: {text}")
    }

    /// Resolve user mentions on inbound Slack text.
    ///
    /// Rewrites each bare `<@USERID>` token to the combined form
    /// `<@USERID:displayName>` so downstream consumers (the agent, the stored
    /// message history) see both the canonical ID and a human-readable name.
    /// `rewrite_outbound_mentions()` is the inverse and is applied before
    /// delivering agent output back to Slack.
    ///
    /// Idempotent over already-resolved `<@USERID:Name>` tokens — the pattern
    /// only matches the bare form (no colon).
    ///
    /// Also converts broadcast mentions (`<!channel>`, `<!here>`, `<!everyone>`)
    /// to readable plain-text form.
    async fn resolve_mentions(&self, text: &str, team_id: &str) -> String {
        // Convert broadcast mentions first
        let mut resolved = text
            .replace("<!channel>", "@channel")
            .replace("<!here>", "@here")
            .replace("<!everyone>", "@everyone");

        // Match only the bare <@ID> form so this function is idempotent over
        // already-resolved <@ID:Name> tokens.
        let matches: Vec<(String, String)> = BARE_MENTION
            .captures_iter(&resolved)
            .map(|found| (found[0].to_string(), found[1].to_string()))
            .collect();
        if matches.is_empty() {
            return resolved;
        }

        let mut unique_user_ids: Vec<&str> = Vec::new();
        for (_, uid) in &matches {
            if !unique_user_ids.contains(&uid.as_str()) {
                unique_user_ids.push(uid);
            }
        }
        let names = futures::future::join_all(unique_user_ids.iter().map(|uid| async move {
            let info = self.get_user_info(uid, team_id).await;
            let name = info
                .as_ref()
                .and_then(SlackUserInfo::display_name)
                .unwrap_or(uid)
                .to_string();
            (uid.to_string(), name)
        }))
        .await;
        let user_info_map: HashMap<String, String> = names.into_iter().collect();

        for (token, uid) in &matches {
            let raw_name = user_info_map
                .get(uid)
                .filter(|n| !n.is_empty())
                .cloned()
                .unwrap_or_else(|| uid.clone());
            // Sanitize: strip `>`, `:`, and control chars so the combined marker
            // stays unambiguous for the inverse pattern.
            let stripped = MENTION_NAME_STRIP.replace_all(&raw_name, "");
            let sanitized_name = match js_trim(&stripped) {
                "" => uid.clone(),
                name => name.to_string(),
            };
            resolved = resolved.replacen(token.as_str(), &format!("<@{uid}:{sanitized_name}>"), 1);
        }
        resolved
    }

    /// Prepare agent output for a Slack `chat.postMessage`: the outbound mention
    /// rewrite, then Block Kit formatting, so a `<@USERID:Name>` token is in
    /// Slack's native mention syntax before rendering. Returns the fallback text
    /// and the blocks.
    async fn prepare_outbound_message(
        &self,
        content: &str,
        team_id: &str,
        triggered_by: Option<&str>,
        tool_calls: Option<&serde_json::Value>,
        options: Option<FormatSlackMessageOptions>,
    ) -> FormattedSlackMessage {
        let outbound_text = self.rewrite_outbound_mentions(content, team_id).await;
        format_slack_message(
            &outbound_text,
            triggered_by,
            tool_call_list(tool_calls),
            options.as_ref(),
        )
    }

    /// Inverse of `resolve_mentions` for outbound delivery.
    ///
    /// Converts each `<@USERID:displayName>` (or bare `<@USERID>`) the agent
    /// emitted back into Slack's native `<@USERID>` mention syntax, which Slack
    /// renders as a clickable user pill and uses to fire a real notification.
    /// A token whose id is not a Slack user id is left as written.
    ///
    /// Best-effort validation: any USERID that does not resolve via
    /// `get_user_info` is treated as hallucinated or stale. With an
    /// embedded display name it is downgraded to plain `@displayName`; without
    /// one, the unknown bare token is dropped.
    async fn rewrite_outbound_mentions(&self, text: &str, team_id: &str) -> String {
        // A token whose id is not a Slack user id is left as written.
        let matches: Vec<(String, String, Option<String>)> = MENTION_TOKEN
            .captures_iter(text)
            .filter(|found| SLACK_ID.is_match(&found[1]))
            .map(|found| {
                (
                    found[0].to_string(),
                    found[1].to_string(),
                    found.get(2).map(|n| n.as_str().to_string()),
                )
            })
            .collect();
        if matches.is_empty() {
            return text.to_string();
        }

        let mut unique_user_ids: Vec<&str> = Vec::new();
        for (_, uid, _) in &matches {
            if !unique_user_ids.contains(&uid.as_str()) {
                unique_user_ids.push(uid);
            }
        }
        let validity: HashMap<String, bool> =
            futures::future::join_all(unique_user_ids.iter().map(|uid| async move {
                (
                    uid.to_string(),
                    self.get_user_info(uid, team_id).await.is_some(),
                )
            }))
            .await
            .into_iter()
            .collect();

        let mut resolved = text.to_string();
        for (token, uid, embedded_name) in &matches {
            if validity.get(uid).copied().unwrap_or(false) {
                resolved = resolved.replacen(token.as_str(), &format!("<@{uid}>"), 1);
            } else if let Some(name) = embedded_name.as_deref().filter(|n| !n.is_empty()) {
                log_info!("Downgrading unknown Slack mention {} to plain text", uid);
                resolved = resolved.replacen(token.as_str(), &format!("@{name}"), 1);
            } else {
                log_info!("Dropping unknown bare Slack mention {}", uid);
                resolved = resolved.replacen(token.as_str(), "", 1);
            }
        }
        resolved
    }

    /// Notify with throttle awareness.
    ///
    /// Attempts an atomic claim on the trigger. If claimed, triggers the
    /// heartbeat from the Slack queue at once. If throttled, schedules a
    /// deferred notification on the throttle queue.
    async fn throttled_notify(&self, agent_id: &str) -> anyhow::Result<()> {
        // Direct local call to the trigger service (no HTTP)
        let result = SLACK_HEARTBEAT_TRIGGER_SERVICE.try_claim_trigger().await?;

        if result.claimed {
            // Direct local call to the heartbeat service
            HEARTBEAT_SERVICE.trigger_from(&slack_trigger_source());
        } else if let Some(remaining) = result.remaining_seconds.filter(|r| *r > 0) {
            get_slack_heartbeat_throttle_queue()
                .schedule_deferred(agent_id, remaining)
                .await;
        }
        Ok(())
    }

    /// Add a participant to a conversation thread (upsert on thread, user and
    /// channel `slack`). A failure is logged, not returned.
    async fn add_participant(&self, thread_id: &str, external_user_id: &str, display_name: &str) {
        let (thread, user, name) = (
            thread_id.to_string(),
            external_user_id.to_string(),
            display_name.to_string(),
        );
        let upserted = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let existing: Option<String> = cp::conversation_participants
                    .filter(cp::thread_id.eq(&thread))
                    .filter(cp::external_user_id.eq(&user))
                    .filter(cp::channel.eq("slack"))
                    .select(cp::id)
                    .first(conn)
                    .optional()?;
                match existing {
                    Some(id) => {
                        diesel::update(cp::conversation_participants.filter(cp::id.eq(&id)))
                            .set(cp::display_name.eq(Some(&name)))
                            .execute(conn)?;
                    }
                    None => {
                        let mut row = NewConversationParticipant::new(&thread, &user, "slack");
                        row.display_name = Some(name.clone());
                        diesel::insert_into(cp::conversation_participants)
                            .values(&row)
                            .execute(conn)?;
                    }
                }
                Ok::<_, anyhow::Error>(())
            })
        })
        .await;
        if let Err(error) = upserted {
            // Log but don't fail if participant tracking fails
            log_warn!("Failed to add participant {}: {}", external_user_id, error);
        }
    }

    /// Rebuild user connection cache from database
    async fn rebuild_user_cache(&self) -> anyhow::Result<()> {
        self.user_connection_cache.clear();

        let mappings = SLACK_MAPPING_SERVICE
            .get_active_user_mappings_with_dm_channel()
            .await?;

        for mapping in mappings {
            let Some(lens_user_id) = mapping.mapping.lens_user_id.filter(|id| !id.is_empty())
            else {
                continue;
            };
            self.user_connection_cache
                .entry(lens_user_id)
                .or_default()
                .insert(mapping.connection.team_id);
        }

        log_info!(
            "Slack user cache built: {} user(s)",
            self.user_connection_cache.len()
        );
        Ok(())
    }

    /// Disconnect and stop the app for a connection, and delete all rows
    /// that reference this connectionId (SlackMapping, SlackVerificationCode,
    /// SlackHeartbeatTrigger) in one transaction. The connection itself is
    /// env-sourced — there's no separate connection row to deactivate. Fails
    /// with `Connection not found` when no Slack connection is configured.
    /// Emits `slack connection removed`.
    pub async fn disconnect_and_deactivate(&self, connection_id: &str) -> anyhow::Result<()> {
        let Some(connection) = get_slack_connection().await? else {
            anyhow::bail!("Connection not found");
        };

        // Stop the Socket Mode app first so no new messages arrive during cleanup
        // and no rebuild starts.
        let socket = self.sockets.remove(&connection.team_id).map(|(_, s)| s);
        if let Some(socket) = socket {
            socket.stop().await;
        }
        let slack_app = self.app(&connection.team_id);
        if let Some(slack_app) = &slack_app
            && let (true, Some(socket)) = (slack_app.is_socket_mode, &slack_app.socket)
            && let Err(error) = SocketModeApp(socket.clone()).stop().await
        {
            log_warn!(
                json!({
                    "err": err_json(&error),
                    "teamId": connection.team_id,
                    "teamName": connection.team_name,
                    "connectionId": connection_id,
                }),
                "Failed to stop Slack app during disconnect; continuing with cleanup"
            );
        }
        self.apps.remove(&connection.team_id);

        // Remove all rows that reference this connectionId in a single
        // transaction so a failure in any one delete rolls back the others —
        // otherwise a partial cleanup would leave the caller with no clean way
        // to retry.
        let connection_key = connection_id.to_string();
        let (mappings, codes, triggers) = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let mappings = SLACK_MAPPING_SERVICE.delete_by_connection_id_in(conn, &connection_key)?;
                let codes = diesel::delete(
                    vc::slack_verification_codes.filter(vc::connection_id.eq(&connection_key)),
                )
                .execute(conn)? as i64;
                let triggers = crate::services::slack_heartbeat_trigger_service::SLACK_HEARTBEAT_TRIGGER_SERVICE
                    .delete_by_connection_id_in(conn, &connection_key)?;
                Ok::<_, anyhow::Error>((mappings, codes, triggers))
            })
        })
        .await?;

        // Rebuild cache after mappings are deleted so stale entries are not
        // re-populated.
        self.rebuild_user_cache().await?;

        log_info!(
            json!({
                "teamName": connection.team_name,
                "mappings": mappings,
                "codes": codes,
                "triggers": triggers,
            }),
            "Disconnected Slack connection and removed mappings"
        );

        let mut props = agent_props();
        props.insert("slack.connection.id".to_string(), connection_id.to_string());
        props.insert("slack.mappings_removed".to_string(), mappings.to_string());
        track_event("slack connection removed", None, Some(props));
        Ok(())
    }

    /// Create or update a user mapping
    ///
    /// Called when a Slack user links their account. Emits `slack user linked`.
    pub async fn link_slack_user(
        &self,
        connection_id: &str,
        slack_user_id: &str,
        lens_user_id: &str,
        agent_id: &str,
        dm_channel_id: Option<&str>,
    ) -> anyhow::Result<()> {
        SLACK_MAPPING_SERVICE
            .upsert_user_mapping(
                connection_id,
                slack_user_id,
                lens_user_id,
                agent_id,
                dm_channel_id,
            )
            .await?;

        // Rebuild cache
        self.rebuild_user_cache().await?;

        log_info!(
            "Linked Slack user {} to Lens user {}",
            slack_user_id,
            lens_user_id
        );
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent_id.to_string());
        props.insert("slack.user.id".to_string(), slack_user_id.to_string());
        track_event("slack user linked", Some(lens_user_id), Some(props));
        Ok(())
    }

    /// Get channel name from Slack API; `None` when the team has no app or the
    /// call fails.
    pub async fn get_channel_name(&self, channel_id: &str, team_id: &str) -> Option<String> {
        let slack_app = self.app(team_id)?;
        let result = slack_app
            .client
            .api_call("conversations.info", json!({ "channel": channel_id }))
            .await
            .ok()?;
        result
            .pointer("/channel/name")
            .and_then(Value::as_str)
            .map(str::to_string)
    }
}

// ==========================================================================
// Routed mode
// ==========================================================================

impl SlackAdapterService {
    /// Validate the token through the proxy again, and start the app of the
    /// workspace it is bound to in place of the app running. An app that
    /// already runs for that workspace stays. Concurrent calls share one attempt.
    async fn reconnect(&'static self) -> anyhow::Result<()> {
        let attempt = self
            .connecting
            .lock()
            .get_or_insert_with(|| {
                async move {
                    let result: anyhow::Result<()> = async {
                        let connection = reload_slack_config().await?;
                        let keep = connection.as_ref().map(|c| c.team_id.clone());
                        self.apps
                            .retain(|team_id, _| Some(team_id) == keep.as_ref());
                        if let Some(connection) = connection
                            && !self.apps.contains_key(&connection.team_id)
                        {
                            self.initialize_connection(&connection.id).await?;
                        }
                        Ok(())
                    }
                    .await;
                    *self.connecting.lock() = None;
                    result.map_err(Arc::new)
                }
                .boxed()
                .shared()
            })
            .clone();
        attempt.await.map_err(|err| anyhow::anyhow!("{:#}", err))
    }

    /// The router reported the agent removed from its workspace. Its links stay.
    async fn disconnect_routed(&self) {
        let connecting = self.connecting.lock().clone();
        if let Some(connecting) = connecting {
            let _ = connecting.await;
        }
        clear_slack_config();
        let workspaces = self.apps.len();
        self.apps.clear();
        log_info!("Slack disconnected by the router; waiting for the agent to be added again");
        let mut props = agent_props();
        props.insert("slack.workspaces".to_string(), workspaces.to_string());
        track_event("slack connection disconnected", None, Some(props));
    }

    /// A person's DM or a channel, linked to the agent or unlinked, as the
    /// router reports it.
    async fn apply_link(&self, team_id: &str, link: &RoutedLink) -> anyhow::Result<()> {
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        match link {
            RoutedLink::Dm {
                op: LinkOp::Add,
                slack_user_id,
                dm_channel_id,
                person_id,
            } => {
                SLACK_MAPPING_SERVICE
                    .upsert_user_mapping(
                        team_id,
                        &slack_user_id.0,
                        &person_id.0,
                        &agent.id,
                        Some(&dm_channel_id.0),
                    )
                    .await?;
            }
            RoutedLink::Dm { slack_user_id, .. } => {
                SLACK_MAPPING_SERVICE
                    .remove_user_mapping(team_id, &slack_user_id.0)
                    .await?;
            }
            RoutedLink::Channel {
                op: LinkOp::Add,
                channel_id,
                person_id,
            } => {
                let channel_name = self
                    .get_channel_name(&channel_id.0, team_id)
                    .await
                    .unwrap_or_else(|| channel_id.0.clone());
                SLACK_MAPPING_SERVICE
                    .upsert_channel_mapping(
                        team_id,
                        &channel_id.0,
                        &agent.id,
                        &channel_name,
                        &person_id.0,
                    )
                    .await?;
            }
            RoutedLink::Channel { channel_id, .. } => {
                SLACK_MAPPING_SERVICE
                    .remove_channel_mapping(&channel_id.0)
                    .await?;
            }
        }
        self.rebuild_user_cache().await?;
        let mut props = IndexMap::new();
        props.insert("agent.id".to_string(), agent.id.clone());
        props.insert("slack.link.type".to_string(), link.type_str().to_string());
        props.insert("slack.link.op".to_string(), link.op().as_str().to_string());
        track_event("slack link changed", Some(link.person_id()), Some(props));
        Ok(())
    }

    /// Run a routed Slack event through the workspace app's listeners.
    async fn handle_routed(&self, envelope: SlackEnvelope, hand_off: HandOff) {
        let context = self
            .app(&envelope.team_id)
            .and_then(|app| app.routed.clone());
        let Some(context) = context else {
            log_warn!(
                json!({ "eventId": envelope.event_id }),
                "A routed Slack event arrived after its workspace was disconnected"
            );
            return;
        };
        let routed = RoutedEvent {
            route: envelope.route,
            hand_off,
        };
        let body = envelope.to_listener_body();
        self.process_body(context, &body, &|| Ok(()), Some(&routed))
            .await;
    }

    /// The stored thread of a routed message. The first time the agent is in a
    /// Slack thread that already has messages, one `conversations.replies` call
    /// stores them, so the agent reads what was said before it joined.
    async fn stored_thread(
        &self,
        user_id: &str,
        agent_id: &str,
        channel_id: &str,
        thread_ts: &str,
        message_ts: &str,
        team_id: &str,
    ) -> anyhow::Result<ConversationThread> {
        let thread = CONVERSATION_SERVICE
            .get_or_create_thread_by_external_id(
                user_id,
                agent_id,
                thread_ts,
                Some(LiveThread {
                    source: ThreadSource::Database,
                    channel_id: channel_id.to_string(),
                }),
            )
            .await?;
        if thread_ts == message_ts {
            return Ok(thread);
        }
        // Two messages of a new thread can arrive together; the second waits
        // for the first one's read.
        let read = {
            let mut reads = self.joined_thread_reads.lock();
            reads
                .entry(thread.id.clone())
                .or_insert_with(|| {
                    let (thread_id, channel_id, thread_ts, message_ts, team_id) = (
                        thread.id.clone(),
                        channel_id.to_string(),
                        thread_ts.to_string(),
                        message_ts.to_string(),
                        team_id.to_string(),
                    );
                    async move {
                        let read = SLACK_ADAPTER_SERVICE
                            .read_joined_thread(
                                &thread_id,
                                &channel_id,
                                &thread_ts,
                                &message_ts,
                                &team_id,
                            )
                            .await
                            .map_err(Arc::new);
                        SLACK_ADAPTER_SERVICE
                            .joined_thread_reads
                            .lock()
                            .remove(&thread_id);
                        read
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        read.await.map_err(|err| anyhow::anyhow!("{:#}", err))?;
        Ok(thread)
    }

    /// Store the messages of a Slack thread from before `message_ts`, once,
    /// when the stored thread has nothing but the agent's own `send_message`
    /// posts. The agent's own posts keep their stored text; another agent's post
    /// is stored as a message from its sender. Posts already in the thread are
    /// written again in their place among the others.
    async fn read_joined_thread(
        &self,
        thread_id: &str,
        channel_id: &str,
        thread_ts: &str,
        message_ts: &str,
        team_id: &str,
    ) -> anyhow::Result<()> {
        // A `send_message` post is the only row stored with its ts before the
        // thread is joined; anything else means the thread was read already.
        let id = thread_id.to_string();
        let joined: Option<String> = crate::db::read(move |conn| {
            Ok(cm::conversation_messages
                .filter(cm::thread_id.eq(&id))
                .filter(
                    cm::role
                        .ne(MessageRole::Agent)
                        .or(cm::external_message_id.is_null()),
                )
                .select(cm::id)
                .first(conn)
                .optional()?)
        })
        .await?;
        if joined.is_some() {
            return Ok(());
        }
        let Some(slack_app) = self.app(team_id) else {
            return Ok(());
        };

        let reply = slack_app
            .client
            .api_call(
                "conversations.replies",
                json!({
                    "channel": channel_id,
                    "ts": thread_ts,
                    "limit": JOINED_THREAD_READ_LIMIT,
                }),
            )
            .await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                log_warn!(
                    json!({ "err": err_json(&error), "channel": channel_id, "threadTs": thread_ts }),
                    "Could not read the Slack thread the agent joined; it starts without the earlier messages"
                );
                return Ok(());
            }
        };
        let before: f64 = message_ts.parse().unwrap_or(f64::MAX);
        let earlier: Vec<JoinedThreadMessage> = reply
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| serde_json::from_value::<JoinedThreadMessage>(m.clone()).ok())
            .filter(|m| m.ts.parse::<f64>().is_ok_and(|ts| ts < before))
            .collect();

        let timestamps: Vec<String> = earlier.iter().map(|m| m.ts.clone()).collect();
        let own: Vec<ConversationMessage> = crate::db::read(move |conn| {
            Ok(cm::conversation_messages
                .filter(cm::role.eq(MessageRole::Agent))
                .filter(cm::external_message_id.eq_any(&timestamps))
                .select(ConversationMessage::as_select())
                .load(conn)?)
        })
        .await?;
        let replacing: Vec<String> = own
            .iter()
            .filter(|m| m.thread_id == thread_id)
            .map(|m| m.id.clone())
            .collect();
        // Every sender is looked up before anything is stored, and the messages
        // are stored together, so a restart in between leaves none of them and
        // the replayed event reads the thread again.
        let mut messages = Vec::new();
        for message in &earlier {
            let mine = own
                .iter()
                .find(|m| m.external_message_id.as_deref() == Some(message.ts.as_str()));
            if let Some(mine) = mine {
                let mut input =
                    MessageInput::new(mine.content.clone(), MessageRole::Agent, mine.triggered_by);
                input.trigger_name = mine.trigger_name.clone().filter(|n| !n.is_empty());
                if mine.thread_id == thread_id {
                    input.external_message_id = Some(message.ts.clone());
                }
                messages.push(input);
                continue;
            }
            let text = self
                .resolve_mentions(message.text.as_deref().unwrap_or(""), team_id)
                .await;
            let sender = message.bot_id.clone().or_else(|| message.user.clone());
            let Some(sender) = sender.filter(|_| !text.is_empty()) else {
                continue;
            };
            let sender_name = if message.bot_id.is_some() {
                message.username.clone()
            } else {
                self.get_user_info(&sender, team_id)
                    .await
                    .and_then(|info| info.display_name().map(str::to_string))
            };
            let mut input = MessageInput::new(
                self.build_sender_tagged_content(&sender, sender_name.as_deref(), &text),
                MessageRole::User,
                MessageTrigger::UserInput,
            );
            input.sender_external_id = Some(sender);
            input.sender_name = sender_name;
            messages.push(input);
        }
        CONVERSATION_SERVICE
            .add_messages(thread_id, messages, replacing)
            .await
    }

    /// The participation verdict for a thread reply the router did not address
    /// to the agent. The router sends such a reply only from a thread the agent
    /// takes part in, so the verdict is `React` when the reply tags somebody
    /// else, else `Respond`. The transcript is the stored thread.
    async fn stored_thread_gate(
        &self,
        thread_id: &str,
        arriving: GateMessage,
        bot_user_id: &str,
    ) -> anyhow::Result<(ThreadParticipation, Vec<GateMessage>)> {
        let history = CONVERSATION_SERVICE
            .get_recent_messages(thread_id, THREAD_TRANSCRIPT_LINES as i64 - 1, None)
            .await?;
        let mut messages: Vec<GateMessage> = history
            .iter()
            .map(|m| {
                if m.role == MessageRole::Agent {
                    GateMessage {
                        user: Some(bot_user_id.to_string()),
                        text: Some(m.content.clone()),
                        ..GateMessage::default()
                    }
                } else {
                    GateMessage {
                        user: m.sender_external_id.clone(),
                        username: m.sender_name.clone(),
                        text: Some(SENDER_TAG.replace(&m.content, "").into_owned()),
                        ..GateMessage::default()
                    }
                }
            })
            .collect();
        let tags_other = tags_somebody_else(arriving.text.as_deref().unwrap_or(""), bot_user_id);
        messages.push(arriving);
        let action = if tags_other {
            ThreadParticipation::React
        } else {
            ThreadParticipation::Respond
        };
        Ok((action, messages))
    }

    /// Store a routed thread reply the agent does not answer.
    async fn store_unanswered(
        &self,
        thread_id: &str,
        slack_user_id: &str,
        text: &str,
        team_id: &str,
        routed: Option<&RoutedEvent>,
    ) -> anyhow::Result<()> {
        let sender = self.get_user_info(slack_user_id, team_id).await;
        let sender_name = sender
            .as_ref()
            .and_then(SlackUserInfo::display_name)
            .map(str::to_string);
        let resolved = self.resolve_mentions(text, team_id).await;
        let content =
            self.build_sender_tagged_content(slack_user_id, sender_name.as_deref(), &resolved);
        if let Some(routed) = routed {
            routed.hand_off.hand_off();
        }
        let mut input = MessageInput::new(content, MessageRole::User, MessageTrigger::UserInput);
        input.sender_external_id = Some(slack_user_id.to_string());
        input.sender_name = sender_name;
        CONVERSATION_SERVICE.add_message(thread_id, input).await?;
        Ok(())
    }

    /// The agent's name, which Slack-facing text uses for the product.
    async fn agent_name(&self) -> anyhow::Result<String> {
        Ok(AGENT_WORKSPACE_SERVICE.get_agent().await?.name)
    }
}

/// What the router service does with each kind of envelope, on the adapter.
struct AdapterRouterHandlers;

#[async_trait]
impl SlackRouterHandlers for AdapterRouterHandlers {
    async fn connect(&self, team_id: &str) -> anyhow::Result<bool> {
        SLACK_ADAPTER_SERVICE.reconnect().await?;
        Ok(SLACK_ADAPTER_SERVICE.apps.contains_key(team_id))
    }

    async fn disconnect(&self) -> anyhow::Result<()> {
        SLACK_ADAPTER_SERVICE.disconnect_routed().await;
        Ok(())
    }

    async fn link(&self, team_id: &str, link: &RoutedLink) -> anyhow::Result<()> {
        SLACK_ADAPTER_SERVICE.apply_link(team_id, link).await
    }

    async fn ready(&self, team_id: &str) -> anyhow::Result<bool> {
        if !SLACK_ADAPTER_SERVICE.apps.contains_key(team_id) {
            SLACK_ADAPTER_SERVICE.reconnect().await?;
        }
        Ok(SLACK_ADAPTER_SERVICE.apps.contains_key(team_id))
    }

    async fn handle(&self, envelope: SlackEnvelope, hand_off: HandOff) -> anyhow::Result<()> {
        SLACK_ADAPTER_SERVICE
            .handle_routed(envelope, hand_off)
            .await;
        Ok(())
    }
}

impl Default for SlackAdapterService {
    fn default() -> Self {
        Self::new()
    }
}

/// The envelope handler of one workspace's socket.
fn envelope_handler(context: Arc<ConnectionContext>) -> EnvelopeHandler {
    Arc::new(move |socket, envelope| {
        let context = context.clone();
        Box::pin(async move {
            SLACK_ADAPTER_SERVICE
                .dispatch(context, socket, envelope)
                .await
        })
    })
}

/// The working indicator's Slack calls, made through the adapter.
struct AdapterIndicatorOps;

#[async_trait]
impl SlackIndicatorOps for AdapterIndicatorOps {
    async fn add_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        team_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()> {
        SLACK_ADAPTER_SERVICE
            .add_reaction(channel_id, message_ts, team_id, emoji)
            .await;
        Ok(())
    }

    async fn remove_reaction(
        &self,
        channel_id: &str,
        message_ts: &str,
        team_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()> {
        SLACK_ADAPTER_SERVICE
            .remove_reaction(channel_id, message_ts, team_id, emoji)
            .await;
        Ok(())
    }

    async fn set_status(
        &self,
        team_id: &str,
        channel_id: &str,
        thread_ts: &str,
        status: &str,
    ) -> anyhow::Result<()> {
        SLACK_ADAPTER_SERVICE
            .set_assistant_status(team_id, channel_id, thread_ts, status)
            .await
    }
}

#[async_trait]
impl ChannelAdapter for SlackAdapterService {
    fn name(&self) -> ChannelName {
        Self::NAME
    }

    fn display_name(&self) -> Option<&str> {
        Some(Self::DISPLAY_NAME)
    }

    async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> Option<anyhow::Result<ChannelDestination>> {
        Some(SlackAdapterService::thread_destination(self, thread_id, origin_channel_id).await)
    }

    async fn default_destination(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> Option<anyhow::Result<Option<DefaultDestination>>> {
        Some(SlackAdapterService::default_destination(self, agent_id, user_id).await)
    }

    async fn linked_channel_ids(&self, agent_id: &str) -> Option<anyhow::Result<Vec<String>>> {
        Some(SlackAdapterService::linked_channel_ids(self, agent_id).await)
    }

    async fn deliver(
        &self,
        user_id: &str,
        message: &DeliverableMessage,
        channel_context: Option<&ChannelContext>,
    ) -> anyhow::Result<()> {
        SlackAdapterService::deliver(self, user_id, message, channel_context).await
    }

    async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        SlackAdapterService::is_user_connected(self, user_id).await
    }

    async fn list_linked_targets(
        &self,
        agent_id: &str,
    ) -> Option<anyhow::Result<Vec<LinkedTarget>>> {
        Some(SlackAdapterService::list_linked_targets(self, agent_id).await)
    }

    async fn post_to_target(
        &self,
        target: &LinkedTarget,
        text: &str,
        thread: Option<&str>,
    ) -> Option<anyhow::Result<PostedMessage>> {
        Some(SlackAdapterService::post_to_target(self, target, text, thread).await)
    }

    async fn initialize(&self) -> anyhow::Result<()> {
        SlackAdapterService::initialize(self).await
    }

    async fn shutdown(&self) -> anyhow::Result<()> {
        SlackAdapterService::shutdown(self).await
    }
}

/// What a reply's Slack message is formatted from.
struct Outbound<'a> {
    content: &'a str,
    team_id: &'a str,
    triggered_by: Option<&'a str>,
    tool_calls: Option<&'a serde_json::Value>,
    feedback_message_id: Option<String>,
}

/// A shared attachment's bytes, or `None` (logged) when it is gone or expired.
async fn attachment_bytes(meta: &AttachmentMeta) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(row) = ATTACHMENT_SERVICE.get_by_id(&meta.id).await? else {
        log_warn!(
            "[Slack] shared attachment {} not found; skipping upload",
            meta.id
        );
        return Ok(None);
    };
    let bytes = ATTACHMENT_SERVICE.load_bytes(&row).await?;
    if bytes.is_none() {
        log_warn!(
            "[Slack] shared attachment {} has no content (expired); skipping upload",
            meta.id
        );
    }
    Ok(bytes)
}

pub static SLACK_ADAPTER_SERVICE: LazyLock<SlackAdapterService> =
    LazyLock::new(SlackAdapterService::new);

/// Test helpers: a workspace app whose Web API is a local fake.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::lib::slack_web_client::WebClientOptions;

    /// Removes the installed app when dropped.
    pub struct AppGuard(String);

    impl Drop for AppGuard {
        fn drop(&mut self) {
            SLACK_ADAPTER_SERVICE.apps.remove(&self.0);
        }
    }

    /// Installs an app for `team_id` on the adapter, its client calling `api_url`.
    pub fn install_app(team_id: &str, api_url: &str) -> AppGuard {
        SLACK_ADAPTER_SERVICE.apps.insert(
            team_id.to_string(),
            Arc::new(SlackApp {
                client: Arc::new(SlackWebClient::new(
                    Some("xoxb-test"),
                    Some(WebClientOptions {
                        timeout_ms: Some(5_000),
                        retry_config: None,
                        slack_api_url: Some(api_url.to_string()),
                    }),
                )),
                socket: None,
                team_id: team_id.to_string(),
                team_name: "Team".to_string(),
                is_socket_mode: false,
                bot_user_id: "UBOT".to_string(),
                routed: None,
            }),
        );
        AppGuard(team_id.to_string())
    }
}

#[cfg(test)]
mod tests;
