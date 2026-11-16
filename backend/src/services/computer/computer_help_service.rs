//! Help requests: the agent asks the user to do something on a computer, and a run waits
//! for the answer or another turn continues the work.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use diesel::prelude::*;
use diesel::sql_types::{Nullable, Text};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::computer::CredentialFields;
use super::computer_access::{ComputerCaller, ComputerUse};
use super::computer_service::{COMPUTER_SERVICE, LOCAL_COMPUTER_ID};
use super::computer_session::ComputerSession;
use crate::ai::AbortError;
use crate::config::CONFIG;
use crate::db::models::{ConversationMessage, MessageTrigger};
use crate::db::sql_types::PrismaJson;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata,
};
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::goal_service::GOAL_SERVICE;
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::voice::voice_chat_service::VOICE_CHAT_SERVICE;
use crate::support::now_ms;
use crate::{log_error, log_info};

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
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    if let Some(help_id) = help_id.filter(|id| !id.is_empty()) {
        params.append_pair("help", help_id);
    }
    if let Some(computer_id) = computer_id.filter(|id| !id.is_empty() && *id != LOCAL_COMPUTER_ID) {
        params.append_pair("computer", computer_id);
    }
    let params = params.finish();
    let suffix = if params.is_empty() {
        "computer".to_string()
    } else {
        format!("computer?{params}")
    };
    match CONFIG.public_url.as_deref().filter(|url| !url.is_empty()) {
        Some(public_url) => format!(
            "{}/{suffix}",
            public_url.strip_suffix('/').unwrap_or(public_url)
        ),
        None => format!("/{suffix}"),
    }
}

diesel::define_sql_function! {
    /// SQLite's `json_extract`, which the JSON path filters on a message's blocks read.
    fn json_extract(json: Nullable<PrismaJson>, path: Text) -> Nullable<Text>;
}

/// The help cards in the blocks of stored messages, in order.
fn cards(rows: Vec<Option<Value>>) -> Vec<ComputerHelp> {
    rows.into_iter()
        .flatten()
        .filter_map(|blocks| match blocks {
            Value::Array(items) => Some(items),
            _ => None,
        })
        .flatten()
        .filter_map(|block| serde_json::from_value::<ComputerHelp>(block).ok())
        .collect()
}

/// A run waiting for the answer to request `help_id`.
struct HelpWait {
    use_: Arc<ComputerUse>,
    help_id: String,
    /// When the wait began, in epoch milliseconds.
    started: i64,
    /// Where the answer goes.
    answer: oneshot::Sender<anyhow::Result<HelpAnswer>>,
    /// Ends the wait's timer once it is settled.
    done: CancellationToken,
}

/// Emits `computer help wait ended` with how the wait ended.
fn wait_ended(wait: &HelpWait, outcome: &str) {
    track_event(
        "computer help wait ended",
        Some(&wait.use_.user_id),
        Some(IndexMap::from([
            ("agent.id".to_string(), wait.use_.agent_id.clone()),
            ("computer.help_id".to_string(), wait.help_id.clone()),
            ("mode".to_string(), wait.use_.mode.clone()),
            ("outcome".to_string(), outcome.to_string()),
            (
                "elapsed_ms".to_string(),
                (now_ms() - wait.started).to_string(),
            ),
        ])),
    );
    COMPUTER_SERVICE.emit_change();
}

/// Help cards are conversation content; voice-only cards last for their call.
pub struct ComputerHelpService {
    /// A voice call's cards, by `<use id>/<help id>`.
    voice: Mutex<IndexMap<String, ComputerHelp>>,
    /// The runs waiting for an answer, each with the request it waits on, by wait number.
    waits: Arc<Mutex<IndexMap<u64, HelpWait>>>,
    next_wait: AtomicU64,
}

pub static COMPUTER_HELP_SERVICE: LazyLock<ComputerHelpService> =
    LazyLock::new(ComputerHelpService::new);

impl ComputerHelpService {
    pub fn new() -> Self {
        ComputerHelpService {
            voice: Mutex::new(IndexMap::new()),
            waits: Arc::new(Mutex::new(IndexMap::new())),
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
        let trigger = message_trigger(&use_.mode);
        let broadcast = asks_every_channel(&use_.mode, use_.thread_id.as_deref());
        let session = COMPUTER_SERVICE.current(use_);
        let candidates = if broadcast {
            self.waiting_broadcasts(&use_.agent_id, &use_.user_id)
                .await?
        } else if waits_for_answer(&use_.mode) {
            self.for_turn(&use_.caller)
                .await?
                .into_iter()
                .filter(|item| item.status == HelpStatus::Waiting)
                .collect()
        } else {
            Vec::new()
        };
        let waiting = candidates
            .into_iter()
            .find(|item| item.computer_id.as_deref().unwrap_or(LOCAL_COMPUTER_ID) == session.id);
        if let Some(waiting) = waiting {
            let answer = self.expect_answer(use_, &waiting);
            COMPUTER_SERVICE.yield_use(use_);
            track_event(
                "computer help repeated",
                Some(&use_.user_id),
                Some(IndexMap::from([
                    ("agent.id".to_string(), use_.agent_id.clone()),
                    ("computer.help_id".to_string(), waiting.id.clone()),
                    ("mode".to_string(), use_.mode.clone()),
                ])),
            );
            COMPUTER_SERVICE.emit_change();
            return Ok(ComputerHelpRequest {
                help: waiting,
                repeated: true,
                answer,
            });
        }
        let form = if credentials {
            session.sign_in_form(tab).await?
        } else {
            None
        };
        if credentials && form.is_none() {
            log_info!(
                "[Computer] No sign-in form on the tab a help request named; asking for the desktop instead"
            );
        }
        // The tab the sign-in is really on when there is one, since that is where the
        // credentials are typed and what the user is shown.
        let target_id = match form.as_ref().and_then(|form| form.target_id.clone()) {
            Some(target_id) => Some(target_id),
            None => session.help_target(tab).await?,
        };
        let mut help = ComputerHelp {
            kind: ComputerHelpType::ComputerHelp,
            id: uuid::Uuid::new_v4().to_string(),
            reason: reason.to_string(),
            tab,
            target_id,
            computer_id: Some(session.id.clone()),
            credentials: form.as_ref().map(|_| true),
            credential_fields: form.as_ref().map(|form| form.fields),
            site: form.as_ref().map(|form| form.origin.clone()),
            status: HelpStatus::Waiting,
            thread_id: use_.thread_id.clone(),
            origin_channel: use_.origin_channel,
            origin_channel_id: use_.origin_channel_id.clone(),
            broadcast: broadcast.then_some(true),
            requester_waits: waits_for_answer(&use_.mode).then_some(true),
        };
        let answer = self.expect_answer(use_, &help);
        if use_.mode == "voice" {
            self.voice
                .lock()
                .insert(format!("{}/{}", use_.id, help.id), help.clone());
        } else {
            let thread_id = match &help.thread_id {
                Some(thread_id) => thread_id.clone(),
                None => {
                    CONVERSATION_SERVICE
                        .get_or_create_latest_thread(&use_.agent_id, &use_.user_id)
                        .await?
                        .id
                }
            };
            help.thread_id = Some(thread_id.clone());
            // No context is a broadcast: every channel the user is reachable on.
            let channel_context = if broadcast {
                None
            } else {
                Some(
                    MESSAGE_DELIVERY_SERVICE
                        .thread_context(
                            &thread_id,
                            use_.origin_channel.map(|channel| channel.as_str()),
                            use_.origin_channel_id.as_deref(),
                        )
                        .await?
                        .context,
                )
            };
            let opens_links = MESSAGE_DELIVERY_SERVICE.opens_web_ui_links(
                channel_context
                    .as_ref()
                    .map(|context| context.channel.as_str()),
            );
            let link = if opens_links {
                format!(
                    "[Open Computer]({})",
                    computer_link(Some(&help.id), help.computer_id.as_deref())
                )
            } else {
                "Open Computer in the Prism Web UI.".to_string()
            };
            MESSAGE_DELIVERY_SERVICE
                .publish(
                    &use_.user_id,
                    &thread_id,
                    &format!("{reason}\n\n{link}\n\nTell me when you are ready to continue."),
                    trigger,
                    PublishOptions {
                        blocks: Some(vec![serde_json::to_value(&help)?]),
                        channel_context,
                        ..PublishOptions::default()
                    },
                )
                .await?;
        }
        COMPUTER_SERVICE.yield_use(use_);
        track_event(
            "computer help requested",
            Some(&use_.user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), use_.agent_id.clone()),
                ("computer.help_id".to_string(), help.id.clone()),
                (
                    "computer.delivery".to_string(),
                    if broadcast { "all" } else { "origin" }.to_string(),
                ),
                (
                    "credentials".to_string(),
                    if help.credentials == Some(true) {
                        "true"
                    } else {
                        "false"
                    }
                    .to_string(),
                ),
            ])),
        );
        COMPUTER_SERVICE.emit_change();
        Ok(ComputerHelpRequest {
            help,
            repeated: false,
            answer,
        })
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
        if !waits_for_answer(&use_.mode) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        let number = self.next_wait.fetch_add(1, Ordering::Relaxed);
        let done = CancellationToken::new();
        self.waits.lock().insert(
            number,
            HelpWait {
                use_: use_.clone(),
                help_id: help.id.clone(),
                started: now_ms(),
                answer: tx,
                done: done.clone(),
            },
        );
        let waits = Arc::downgrade(&self.waits);
        let signal = use_.signal.clone();
        tokio::spawn(async move {
            let outcome = tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(HELP_ANSWER_WAIT_MS)) => {
                    Ok(HelpAnswer::Unanswered)
                }
                _ = signal.cancelled() => Err(AbortError::operation()),
                _ = done.cancelled() => return,
            };
            let Some(waits) = waits.upgrade() else {
                return;
            };
            let Some(wait) = waits.lock().shift_remove(&number) else {
                return;
            };
            match outcome {
                Ok(answer) => {
                    wait_ended(&wait, answer.as_str());
                    let _ = wait.answer.send(Ok(answer));
                }
                Err(abort) => {
                    wait_ended(&wait, "canceled");
                    let _ = wait.answer.send(Err(abort.into()));
                }
            }
        });
        Some(rx)
    }

    /// The runs waiting for an answer, as the Computer status lists them.
    pub fn awaiting(&self) -> Vec<AwaitingRun> {
        self.waits
            .lock()
            .values()
            .map(|wait| AwaitingRun {
                id: wait.use_.id.clone(),
                help_id: wait.help_id.clone(),
                mode: wait.use_.mode.clone(),
                thread_id: wait.use_.thread_id.clone(),
            })
            .collect()
    }

    /// The help cards of the agent's conversations, oldest first, then a voice call's when
    /// no thread is named.
    pub async fn list(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: Option<&str>,
    ) -> anyhow::Result<Vec<ComputerHelp>> {
        let (agent, user, thread) = (
            agent_id.to_string(),
            user_id.to_string(),
            thread_id.map(str::to_string),
        );
        let rows = crate::db::run(move |conn| {
            use crate::db::schema::{conversation_messages as m, conversation_threads as t};
            let mut query = m::table
                .inner_join(t::table)
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(json_extract(m::blocks, "$[0].type").eq("computer_help"))
                .select(m::blocks)
                .order(m::created_at.asc())
                .into_boxed();
            if let Some(thread) = thread {
                query = query.filter(m::thread_id.eq(thread));
            }
            Ok(query.load::<Option<Value>>(conn)?)
        })
        .await?;
        let mut help = cards(rows);
        if thread_id.is_none() {
            help.extend(self.voice.lock().values().cloned());
        }
        Ok(help)
    }

    /// A turn's help: its own conversation's, and every broadcast request still waiting. A
    /// run that asks every channel gets none, since its `computer_help` call joins a waiting
    /// request and waits for the answer.
    pub async fn for_turn(&self, caller: &ComputerCaller) -> anyhow::Result<Vec<ComputerHelp>> {
        if asks_every_channel(&caller.mode, caller.thread_id.as_deref()) {
            return Ok(Vec::new());
        }
        let own = match caller.thread_id.as_deref() {
            Some(thread_id) => {
                self.list(&caller.agent_id, &caller.user_id, Some(thread_id))
                    .await?
            }
            None => Vec::new(),
        };
        let broadcast: Vec<ComputerHelp> = self
            .waiting_broadcasts(&caller.agent_id, &caller.user_id)
            .await?
            .into_iter()
            .filter(|help| !own.iter().any(|item| item.id == help.id))
            .collect();
        Ok(own.into_iter().chain(broadcast).collect())
    }

    /// The requests still waiting for the user's answer: the stored ones oldest first, then
    /// a call's.
    pub async fn waiting(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Vec<ComputerHelp>> {
        let (agent, user) = (agent_id.to_string(), user_id.to_string());
        let rows = crate::db::run(move |conn| {
            use crate::db::schema::{conversation_messages as m, conversation_threads as t};
            Ok(m::table
                .inner_join(t::table)
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(json_extract(m::blocks, "$[0].type").eq("computer_help"))
                .filter(json_extract(m::blocks, "$[0].status").eq("waiting"))
                .select(m::blocks)
                .order(m::created_at.asc())
                .load::<Option<Value>>(conn)?)
        })
        .await?;
        let mut help = cards(rows);
        help.extend(
            self.voice
                .lock()
                .values()
                .filter(|help| help.status == HelpStatus::Waiting)
                .cloned(),
        );
        Ok(help)
    }

    async fn waiting_broadcasts(
        &self,
        agent_id: &str,
        user_id: &str,
    ) -> anyhow::Result<Vec<ComputerHelp>> {
        Ok(self
            .waiting(agent_id, user_id)
            .await?
            .into_iter()
            .filter(|help| help.broadcast == Some(true))
            .collect())
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
        let voice = {
            let mut voice = self.voice.lock();
            match voice.values_mut().find(|help| help.id == id) {
                Some(help) if help.status != HelpStatus::Waiting => return Ok(None),
                Some(help) => {
                    help.status = status;
                    Some(help.clone())
                }
                None => None,
            }
        };
        if let Some(help) = voice {
            self.resolved(agent_id, user_id, &help);
            return Ok(Some(ResolvedHelp {
                help,
                answered_runs: 0,
            }));
        }
        let (agent, user, help_id) = (agent_id.to_string(), user_id.to_string(), id.to_string());
        let row = crate::db::run(move |conn| {
            use crate::db::schema::{conversation_messages as m, conversation_threads as t};
            Ok(m::table
                .inner_join(t::table)
                .filter(t::agent_id.eq(agent))
                .filter(t::user_id.eq(user))
                .filter(json_extract(m::blocks, "$[0].id").eq(help_id))
                .select(ConversationMessage::as_select())
                .first::<ConversationMessage>(conn)
                .optional()?)
        })
        .await?;
        let Some(row) = row else {
            anyhow::bail!("Help request not found.");
        };
        let Some(help) = cards(vec![row.blocks.clone()]).into_iter().next() else {
            anyhow::bail!("Help request not found.");
        };
        if help.status != HelpStatus::Waiting {
            return Ok(None);
        }
        let updated = ComputerHelp { status, ..help };
        let blocks = Value::Array(vec![serde_json::to_value(&updated)?]);
        let (message_id, stored) = (row.id.clone(), blocks.clone());
        let count = crate::db::run(move |conn| {
            use crate::db::schema::conversation_messages as m;
            Ok(diesel::update(
                m::table
                    .filter(m::id.eq(message_id))
                    .filter(json_extract(m::blocks, "$[0].status").eq("waiting")),
            )
            .set(m::blocks.eq(Some(stored)))
            .execute(conn)?)
        })
        .await?;
        if count == 0 {
            return Ok(None);
        }
        self.resolved(agent_id, user_id, &updated);
        let answered_runs = self.answer(id, status);
        // The card is part of the transcript, so every open client shows it answered.
        MESSAGE_DELIVERY_SERVICE
            .show_in_conversation(
                user_id,
                &ConversationMessage {
                    blocks: Some(blocks),
                    ..row
                },
            )
            .await?;
        Ok(Some(ResolvedHelp {
            help: updated,
            answered_runs,
        }))
    }

    /// Hands the user's answer to every run waiting on request `id`.
    fn answer(&self, id: &str, status: HelpStatus) -> usize {
        let answered: Vec<HelpWait> = {
            let mut waits = self.waits.lock();
            let numbers: Vec<u64> = waits
                .iter()
                .filter(|(_, wait)| wait.help_id == id)
                .map(|(number, _)| *number)
                .collect();
            numbers
                .into_iter()
                .filter_map(|number| waits.shift_remove(&number))
                .collect()
        };
        let answer = match status {
            HelpStatus::Dismissed => HelpAnswer::Dismissed,
            _ => HelpAnswer::Continued,
        };
        let count = answered.len();
        for wait in answered {
            wait.done.cancel();
            wait_ended(&wait, answer.as_str());
            let _ = wait.answer.send(Ok(answer));
        }
        count
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
        let asked = self
            .list(agent_id, user_id, None)
            .await?
            .into_iter()
            .find(|item| item.id == id);
        let session = self.session_of(asked.as_ref().and_then(|help| help.computer_id.as_deref()));
        if action == HelpAction::Continue && session.access.paused() {
            let Some(client_id) = client_id else {
                anyhow::bail!("Hand control back in Computer first.");
            };
            session.assert_can_hand_back(client_id)?;
        }
        let status = match action {
            HelpAction::Continue => HelpStatus::Continued,
            HelpAction::Dismiss => HelpStatus::Dismissed,
        };
        let Some(resolved) = self.resolve(agent_id, user_id, id, status).await? else {
            return Ok(());
        };
        if action == HelpAction::Dismiss {
            return Ok(());
        }
        if session.access.paused() {
            let Some(client_id) = client_id else {
                anyhow::bail!("Hand control back in Computer first.");
            };
            session.hand_back(client_id).await?;
        }
        // The run that asked waits for this answer and continues the work itself. A run
        // that only joined the request does not continue the requester's work.
        if resolved.answered_runs > 0 && resolved.help.requester_waits == Some(true) {
            return Ok(());
        }
        let help = resolved.help;
        let Some(thread_id) = help.thread_id.clone() else {
            VOICE_CHAT_SERVICE.continue_computer(&help.reason);
            return Ok(());
        };
        if self.resume_goal(agent_id, user_id, &help).await? {
            return Ok(());
        }
        let context = MESSAGE_DELIVERY_SERVICE
            .thread_context(
                &thread_id,
                help.origin_channel.map(|channel| channel.as_str()),
                help.origin_channel_id.as_deref(),
            )
            .await?;
        let reason = serde_json::to_string(&help.reason)?;
        let input = ChatInput {
            user_id: user_id.to_string(),
            agent_id: agent_id.to_string(),
            thread_id: Some(thread_id),
            message: format!(
                "I finished helping with the computer. The help request was: {reason}\n\nInspect the current screen, then continue the original request."
            ),
            runtime_written: true,
            metadata: Some(ChatMetadata {
                channel: Some(context.context.channel),
                channel_id: context.context.channel_id.clone(),
                channel_thread_id: context.context.channel_thread_id.clone(),
                channel_label: context.channel_label.clone(),
                ..ChatMetadata::default()
            }),
            ..ChatInput::default()
        };
        tokio::spawn(async move {
            if let Err(err) = CONVERSATION_ENGINE_SERVICE.chat(input).await {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Computer] Continuation failed"
                );
            }
        });
        Ok(())
    }

    /// Resume the goal paused for this help, once its conversation has no request waiting.
    pub async fn resume_goal(
        &self,
        agent_id: &str,
        user_id: &str,
        help: &ComputerHelp,
    ) -> anyhow::Result<bool> {
        let Some(thread_id) = help.thread_id.as_deref() else {
            return Ok(false);
        };
        if self
            .list(agent_id, user_id, Some(thread_id))
            .await?
            .iter()
            .any(|item| item.status == HelpStatus::Waiting)
        {
            return Ok(false);
        }
        let goal = GOAL_SERVICE.get_goal_for_thread(thread_id).await?;
        let Some(goal) = goal.filter(|goal| {
            goal.status == "paused"
                && goal.last_reason.as_deref() == Some("Waiting for computer help.")
        }) else {
            return Ok(false);
        };
        GOAL_SERVICE.resume_goal(&goal.id).await?;
        Ok(true)
    }

    /// Emits `computer help resolved`.
    fn resolved(&self, agent_id: &str, user_id: &str, help: &ComputerHelp) {
        track_event(
            "computer help resolved",
            Some(user_id),
            Some(IndexMap::from([
                ("agent.id".to_string(), agent_id.to_string()),
                ("computer.help_id".to_string(), help.id.clone()),
                ("status".to_string(), help.status.as_str().to_string()),
            ])),
        );
        COMPUTER_SERVICE.emit_change();
    }

    /// The computer a request is about; a removed one's requests fall back to the runtime's
    /// own.
    pub fn session_of(&self, computer_id: Option<&str>) -> Arc<ComputerSession> {
        COMPUTER_SERVICE
            .session(computer_id.unwrap_or(LOCAL_COMPUTER_ID))
            .unwrap_or_else(|| COMPUTER_SERVICE.local.clone())
    }

    pub fn end_voice(&self, use_: &ComputerUse) {
        let prefix = format!("{}/", use_.id);
        self.voice.lock().retain(|key, _| !key.starts_with(&prefix));
        COMPUTER_SERVICE.emit_change();
    }
}

impl Default for ComputerHelpService {
    fn default() -> Self {
        ComputerHelpService::new()
    }
}

#[cfg(test)]
#[path = "computer_help_service_tests.rs"]
mod tests;
