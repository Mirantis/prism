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

use async_trait::async_trait;
use dashmap::DashMap;
use futures::future::{BoxFuture, FutureExt, Shared};
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::lib::slack_web_client::SlackWebClient;
use crate::services::attachment_service::AttachmentMeta;
use crate::services::channel_adapter_interface::{
    ChannelAdapter, ChannelContext, ChannelDestination, ChannelName, DefaultDestination,
    DeliverableMessage, LinkedTarget, PostedMessage,
};
use crate::services::providers::slack_thread_provider::SlackThreadProvider;
use crate::services::slack_socket_retire::StoppableApp;
use crate::services::slack_working_indicator::{SlackIndicatorOps, SlackWorkingIndicator};
use crate::services::thread_reply_classifier_service::ThreadAction;
use crate::utils::slack_formatter::{FeedbackRating, FormatSlackMessageOptions, SlackBlock};

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
    stop: Box<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>,
}

/// One connected workspace: its Web API client and the bot's identity there.
pub struct SlackApp {
    /// The Web API client for the workspace.
    pub client: Arc<SlackWebClient>,
    /// The workspace's Socket Mode app, stopped at shutdown or disconnect. `None`
    /// without an app token.
    pub socket: Option<Arc<dyn StoppableApp>>,
    pub team_id: String,
    pub team_name: String,
    pub is_socket_mode: bool,
    pub bot_user_id: String,
}

/// A connected workspace as the Channels page lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedWorkspace {
    pub team_id: String,
    pub team_name: String,
    pub bot_user_id: String,
}

/// Subset of a Slack file object on a message event.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SlackFileMeta {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mimetype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url_private: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url_private_download: Option<String>,
}

/// A file we couldn't ingest, surfaced to the agent so it can tell the user.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SlackFileFailure {
    filename: String,
    reason: String,
}

#[derive(Debug, Clone, Default)]
struct SlackFileDownloadResult {
    attachment_ids: Vec<String>,
    failures: Vec<SlackFileFailure>,
}

/// Where a downloaded file came from: the carrying message's ts and the thread
/// that scopes a later lookup.
#[derive(Debug, Clone, Default)]
struct SlackFileContext {
    external_ts: Option<String>,
    thread_id: Option<String>,
}

/// The outcome of a link code check, as the reply to the user words it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LinkResult {
    success: bool,
    message: String,
    agent_name: Option<String>,
}

/// The part of a Web API client that a feedback click updates the message with.
#[async_trait]
pub trait FeedbackChatClient: Send + Sync {
    /// `chat.update` with the given arguments.
    async fn chat_update(&self, args: serde_json::Value) -> anyhow::Result<serde_json::Value>;
}

/// Placeholder body for a Slack message whose only content is its file(s).
/// Used for the stored chat message AND the heartbeat-trigger queue, so a file
/// event never becomes an empty-text entry that silently drops the fact that a
/// file was shared.
fn describe_shared_files(files: &[SlackFileMeta]) -> String {
    let names = files
        .iter()
        .map(|f| {
            f.name
                .as_deref()
                .filter(|n| !n.is_empty())
                .unwrap_or("file")
        })
        .collect::<Vec<_>>()
        .join(", ");
    if files.len() > 1 {
        format!("(shared files: {names})")
    } else {
        format!("(shared a file: {names})")
    }
}

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

    /// Get the Slack app for a team, once the boot's Socket Mode starts have
    /// settled. Work the boot continues reads and delivers before the socket is up,
    /// and waits here.
    pub async fn get_app_for_team(&self, team_id: &str) -> Option<Arc<SlackApp>> {
        todo!()
    }

    /// The team's app once the boot's Socket Mode start settles, or none after `SEND_CONNECT_WAIT_MS`.
    async fn app_for_send(&self, team_id: &str) -> Option<Arc<SlackApp>> {
        todo!()
    }

    /// List metadata for every connected Slack workspace. Used by the
    /// Web UI to display workspace name + bot user on the Channels page.
    pub fn list_connected_workspaces(&self) -> Vec<ConnectedWorkspace> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// The agent's linked channels (the main one flagged) and DMs, oldest first.
    pub async fn list_linked_targets(&self, agent_id: &str) -> anyhow::Result<Vec<LinkedTarget>> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Every member of the target conversation (`conversations.members`, 1000 per
    /// page). A `missing_scope` error is refused with the scope the app needs.
    async fn conversation_members(
        &self,
        slack_app: &SlackApp,
        target: &LinkedTarget,
    ) -> anyhow::Result<HashSet<String>> {
        todo!()
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
        todo!()
    }

    /// Check if user has an active Slack connection: a cached team, else any DM or
    /// channel mapping.
    pub async fn is_user_connected(&self, user_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// A Slack thread continues where it started. A DM-originated thread carries
    /// no channel id (the DM path does not capture one, and DM threads have no
    /// externalChannelId). Without one, `deliver` falls back to its mapping
    /// broadcast, which can also post into the user's linked channels, so the
    /// user's DM channel is resolved to keep the continuation in the DM.
    ///
    /// Only SLACK-sourced threads keep a real thread_ts in externalThreadId, so
    /// only they get a `channel_thread_id`. With no channel id there is nowhere to
    /// post: a warning is logged and the destination is empty.
    pub async fn thread_destination(
        &self,
        thread_id: &str,
        origin_channel_id: Option<&str>,
    ) -> anyhow::Result<ChannelDestination> {
        todo!()
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
        todo!()
    }

    pub async fn linked_channel_ids(&self, agent_id: &str) -> anyhow::Result<Vec<String>> {
        todo!()
    }

    /// Initialize Slack adapter
    ///
    /// Loads the active Slack connection and starts a Socket Mode app for each
    /// workspace. Boot does not wait for the sockets: a start can wait on
    /// `apps.connections.open` with no time limit, and the HTTP port opens after
    /// this returns. A workspace is listed once its socket is up. Failures are
    /// logged, not returned.
    pub async fn initialize(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Shutdown Slack adapter
    ///
    /// Stops the Socket Mode apps first (a stopped client reports `disconnected`,
    /// which re-arms a watch and fails a reconnect that waits for hello), then
    /// clears the working indicators while the clients are still up, then stops
    /// every app. Emits `slack adapter shutdown`.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        todo!()
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
        todo!()
    }

    /// Replace a Socket Mode app whose client has not connected for
    /// `SOCKET_STALL_MS`. The rebuild stops when `handle` is no longer the team's
    /// current app, because a shutdown, a disconnect or a newer connection
    /// replaced it. The old app stays in `apps` until the new one connects, so
    /// posts keep working.
    async fn rebuild_socket(&self, connection_id: &str, team_id: &str, handle: Arc<SocketHandle>) {
        todo!()
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
        team_id: &str,
        event_ts: Option<&str>,
        thread_ts: Option<&str>,
        files: Vec<SlackFileMeta>,
    ) {
        todo!()
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
        bot_user_id: &str,
        team_id: &str,
        files: Vec<SlackFileMeta>,
    ) {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// The link code in a message, uppercased, or `None`. Slack formatting
    /// (*bold*, _italic_, ~strike~, `code`) around the code is ignored.
    fn parse_link_code(&self, text: &str) -> Option<String> {
        let stripped = SLACK_FORMATTING.replace_all(text, "");
        let stripped = stripped.trim();
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
        todo!()
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
        todo!()
    }

    /// Verify a channel link code: create the channel mapping and consume the code
    /// in one transaction.
    async fn verify_channel_link_code_local(
        &self,
        code: &str,
        channel_id: &str,
        channel_name: Option<&str>,
    ) -> anyhow::Result<LinkResult> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Add a reaction emoji to a Slack message (best-effort, awaited).
    ///
    /// Errors are logged; failures do not reach the caller.
    async fn add_reaction(&self, channel_id: &str, message_ts: &str, team_id: &str, emoji: &str) {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Get user info from Slack, cached for `USER_INFO_TTL_MS`. `None` when the
    /// team has no app or the call fails.
    async fn get_user_info(&self, slack_user_id: &str, team_id: &str) -> Option<SlackUserInfo> {
        todo!()
    }

    /// Download user-uploaded Slack files into our DB and return the new
    /// attachment ids (to link to the user message via `chat` `attachment_ids`).
    ///
    /// Enforces the 10 MB cap (from Slack's reported size, then again after
    /// download), dedups on Slack file id (events are at-least-once), and skips
    /// anything that fails to download. `external_ts` records the carrying
    /// message's ts so the live-read Slack channel provider can re-associate the
    /// file on later turns; `thread_id` scopes that lookup.
    async fn download_slack_files(
        &self,
        files: &[SlackFileMeta],
        ctx: SlackFileContext,
    ) -> SlackFileDownloadResult {
        todo!()
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
        todo!()
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
        let sanitized = stripped.trim();
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
        todo!()
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
    ) -> (String, Vec<SlackBlock>) {
        todo!()
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
        todo!()
    }

    /// Notify with throttle awareness.
    ///
    /// Attempts an atomic claim on the trigger. If claimed, triggers the
    /// heartbeat from the Slack queue at once. If throttled, schedules a
    /// deferred notification on the throttle queue.
    async fn throttled_notify(&self, agent_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Add a participant to a conversation thread (upsert on thread, user and
    /// channel `slack`). A failure is logged, not returned.
    async fn add_participant(&self, thread_id: &str, external_user_id: &str, display_name: &str) {
        todo!()
    }

    /// Rebuild user connection cache from database
    async fn rebuild_user_cache(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Disconnect and stop the app for a connection, and delete all rows
    /// that reference this connectionId (SlackMapping, SlackVerificationCode,
    /// SlackHeartbeatTrigger) in one transaction. The connection itself is
    /// env-sourced — there's no separate connection row to deactivate. Fails
    /// with `Connection not found` when no Slack connection is configured.
    /// Emits `slack connection removed`.
    pub async fn disconnect_and_deactivate(&self, connection_id: &str) -> anyhow::Result<()> {
        todo!()
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
        todo!()
    }

    /// Get channel name from Slack API; `None` when the team has no app or the
    /// call fails.
    pub async fn get_channel_name(&self, channel_id: &str, team_id: &str) -> Option<String> {
        todo!()
    }
}

impl Default for SlackAdapterService {
    fn default() -> Self {
        Self::new()
    }
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

pub static SLACK_ADAPTER_SERVICE: LazyLock<SlackAdapterService> =
    LazyLock::new(SlackAdapterService::new);
