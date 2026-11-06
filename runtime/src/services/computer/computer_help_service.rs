//! Help requests: the agent asks the user to do something on a computer, and a run waits
//! for the answer or another turn continues the work.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::computer::CredentialFields;
use super::computer_access::{ComputerCaller, ComputerUse};
use super::computer_session::ComputerSession;
use crate::db::models::MessageTrigger;
use crate::services::channel_adapter_interface::ChannelName;

/// The block type a help card is stored as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum ComputerHelpType {
    #[default]
    #[serde(rename = "computer_help")]
    ComputerHelp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HelpStatus {
    Waiting,
    Continued,
    Dismissed,
}

impl HelpStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            HelpStatus::Waiting => "waiting",
            HelpStatus::Continued => "continued",
            HelpStatus::Dismissed => "dismissed",
        }
    }
}

/// A help card, stored as the only block of its message. The fields are in the order a
/// new request writes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerHelp {
    #[serde(rename = "type")]
    pub kind: ComputerHelpType,
    pub id: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    /// The computer the work is blocked on; a request without one is about the runtime's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_id: Option<String>,
    /// The user answers this one with the credentials below, typed into `site`. Always
    /// `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<bool>,
    /// What the page asks for. A second step of a sign-in asks for the password alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_fields: Option<CredentialFields>,
    /// Where those go: the origin of the tab that asked, as it read when it asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    pub status: HelpStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel: Option<ChannelName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel_id: Option<String>,
    /// Asked by a background run with no conversation, so every channel got it and any turn
    /// answers it. Always `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broadcast: Option<bool>,
    /// Asked by a run that waits for the answer, so that run continues the work itself.
    /// Always `true` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_waits: Option<bool>,
}

/// How long a background run waits for the user's answer before it goes on without one.
pub const HELP_ANSWER_WAIT_MS: u64 = 30 * 60_000;

/// What a run that waited for its help request learns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HelpAnswer {
    Continued,
    Dismissed,
    Unanswered,
}

impl HelpAnswer {
    pub fn as_str(self) -> &'static str {
        match self {
            HelpAnswer::Continued => "continued",
            HelpAnswer::Dismissed => "dismissed",
            HelpAnswer::Unanswered => "unanswered",
        }
    }
}

/// `repeated` when a waiting broadcast request stands for this one and nothing was posted.
/// `answer` settles when the user answers, for a run that waits for that; it fails with
/// the invocation's cancellation when the invocation ends first.
#[derive(Debug)]
pub struct ComputerHelpRequest {
    pub help: ComputerHelp,
    pub repeated: bool,
    pub answer: Option<oneshot::Receiver<anyhow::Result<HelpAnswer>>>,
}

/// A resolved request, and how many waiting runs it answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHelp {
    pub help: ComputerHelp,
    pub answered_runs: usize,
}

/// A run waiting for an answer, as the Computer status lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwaitingRun {
    pub id: String,
    pub help_id: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

/// The user's answer to a help request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HelpAction {
    Continue,
    Dismiss,
}

/// A heartbeat, a scheduled task and a webhook store none of their own steps, so a run
/// keeps them by waiting in memory for the answer. A restart ends the wait.
pub fn waits_for_answer(mode: &str) -> bool {
    mode == "heartbeat" || mode == "cron" || mode == "webhook"
}

fn message_trigger(mode: &str) -> MessageTrigger {
    match mode {
        "goal" => MessageTrigger::Goal,
        "cron" => MessageTrigger::CronTask,
        "heartbeat" => MessageTrigger::Heartbeat,
        "webhook" => MessageTrigger::Webhook,
        _ => MessageTrigger::UserInput,
    }
}

/// A background run with no conversation of its own asks wherever its output goes,
/// which is every channel. A chat turn stays in its own channel, as every reply does.
pub fn asks_every_channel(mode: &str, thread_id: Option<&str>) -> bool {
    message_trigger(mode) != MessageTrigger::UserInput && thread_id.is_none()
}

/// The Computer page, with the help request and, for a remote one, its computer selected.
pub fn computer_link(help_id: Option<&str>, computer_id: Option<&str>) -> String {
    todo!()
}

/// A run waiting for the answer to request `help_id`.
struct HelpWait {
    use_: Arc<ComputerUse>,
    help_id: String,
    /// Settles the wait with the user's answer.
    answer: Box<dyn FnOnce(HelpStatus) + Send>,
}

/// Help cards are conversation content; voice-only cards last for their call.
pub struct ComputerHelpService {
    /// A voice call's cards, by `<use id>/<help id>`.
    voice: Mutex<IndexMap<String, ComputerHelp>>,
    /// The runs waiting for an answer, each with the request it waits on, by wait number.
    waits: Mutex<IndexMap<u64, HelpWait>>,
    next_wait: AtomicU64,
}

pub static COMPUTER_HELP_SERVICE: LazyLock<ComputerHelpService> =
    LazyLock::new(ComputerHelpService::new);

impl ComputerHelpService {
    pub fn new() -> Self {
        ComputerHelpService {
            voice: Mutex::new(IndexMap::new()),
            waits: Mutex::new(IndexMap::new()),
            next_wait: AtomicU64::new(1),
        }
    }

    /// Ask the user for help with the computer the invocation uses.
    ///
    /// `credentials` asks for a sign-in the user answers with what the page asks for.
    /// Recorded only when the tab really holds such a form, so the box for it is never
    /// offered where the runtime could not type it; a request that loses the flag says so
    /// in the log, and `computer_help` tells the agent which answer the user was offered.
    ///
    /// A heartbeat asks again on every run, and each ask posts to every channel. So while
    /// one broadcast request waits, it stands for them all, including an unrelated block
    /// another background run meets at the same time. That run waits for the same answer
    /// and is told what the waiting request asks, so it can name or ask for its own block.
    /// A run in a conversation that waits for its answer joins the first waiting request
    /// its turn was told of: its conversation's own, or a broadcast one. Either way only a
    /// request on the computer the run uses, since help on another one clears no block here.
    pub async fn request(
        &self,
        use_: &Arc<ComputerUse>,
        reason: &str,
        tab: Option<i64>,
        credentials: bool,
    ) -> anyhow::Result<ComputerHelpRequest> {
        todo!()
    }

    /// The answer a background run waits for, for at most `HELP_ANSWER_WAIT_MS`. Taken
    /// before the request is posted, or as it is found, so no answer can arrive before the
    /// wait exists. The end of the invocation cancels a wait its tool never reached. Emits
    /// `computer help wait ended` with the outcome.
    fn expect_answer(
        &self,
        use_: &Arc<ComputerUse>,
        help: &ComputerHelp,
    ) -> Option<oneshot::Receiver<anyhow::Result<HelpAnswer>>> {
        todo!()
    }

    /// The runs waiting for an answer, as the Computer status lists them.
    pub fn awaiting(&self) -> Vec<AwaitingRun> {
        todo!()
    }

    /// The help cards of the agent's conversations, oldest first, then a voice call's when
    /// no thread is named.
    pub async fn list(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: Option<&str>,
    ) -> anyhow::Result<Vec<ComputerHelp>> {
        todo!()
    }

    /// A turn's help: its own conversation's, and every broadcast request still waiting. A
    /// run that asks every channel gets none, since its `computer_help` call joins a waiting
    /// request and waits for the answer.
    pub async fn for_turn(&self, caller: &ComputerCaller) -> anyhow::Result<Vec<ComputerHelp>> {
        todo!()
    }

    /// The requests still waiting for the user's answer: the stored ones oldest first, then
    /// a call's.
    pub async fn waiting(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Vec<ComputerHelp>> {
        todo!()
    }

    async fn waiting_broadcasts(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Vec<ComputerHelp>> {
        todo!()
    }

    /// Mark request `id` answered. `None` when it was answered already. Fails with `Help
    /// request not found.`
    pub async fn resolve(
        &self,
        agent_id: &str,
        user_id: &str,
        id: &str,
        status: HelpStatus,
    ) -> anyhow::Result<Option<ResolvedHelp>> {
        todo!()
    }

    /// Hands the user's answer to every run waiting on request `id`.
    fn answer(&self, id: &str, status: HelpStatus) -> usize {
        todo!()
    }

    /// The user's answer to request `id`. Fails with `Hand control back in Computer first.`
    /// when the computer is paused and no viewer is named, and as the hand-back fails.
    pub async fn continue_request(
        &self,
        agent_id: &str,
        user_id: &str,
        id: &str,
        action: HelpAction,
        client_id: Option<&str>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Resume the goal paused for this help, once its conversation has no request waiting.
    pub async fn resume_goal(
        &self,
        agent_id: &str,
        user_id: &str,
        help: &ComputerHelp,
    ) -> anyhow::Result<bool> {
        todo!()
    }

    /// Emits `computer help resolved`.
    fn resolved(&self, agent_id: &str, user_id: &str, help: &ComputerHelp) {
        todo!()
    }

    /// The computer a request is about; a removed one's requests fall back to the runtime's
    /// own.
    pub fn session_of(&self, computer_id: Option<&str>) -> Arc<ComputerSession> {
        todo!()
    }

    pub fn end_voice(&self, use_: &ComputerUse) {
        todo!()
    }
}

impl Default for ComputerHelpService {
    fn default() -> Self {
        ComputerHelpService::new()
    }
}
