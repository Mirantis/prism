//! Owns the agent's participation in a live voice meeting, start to finish.
//!
//! One meeting at a time per container, matching the one-agent-per-container shape.
//! That is a real constraint rather than an accident: a second call would need its
//! own display, audio daemon and browser (roughly 4 vCPU worth of media work each),
//! and the agent has one voice to lend.
//!
//! The lifecycle is deliberately asymmetric. Joining is asynchronous from the request
//! onwards — `join()` returns as soon as the request is in, because a guest waits for a
//! host to click "Admit" and that can take minutes; the caller gets a state, the model is
//! told in band once the call starts, and every outcome goes to the log. A join that
//! fails before the request goes in is answered to the caller instead, step and all,
//! since nothing else would tell it. Leaving is immediate and always safe to call.
//!
//! Everything that can leak — an X server, an audio daemon, a browser, a WebSocket —
//! is released through one `teardown()` path, used by the happy ending, every
//! failure, the inactivity timeout and process shutdown alike.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::oneshot;
use tokio::task::AbortHandle;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::services::meeting::audio_stack::{AudioStack, AudioStackOptions};
use crate::services::meeting::browser_control::{
    BrowserAction, BrowserCommand, BrowserReading, BrowserResult, PageCapture, capture,
    normalize_url, read, run_browser_command, summarize_tabs,
};
use crate::services::meeting::browser_stack::{BrowserStack, BrowserStackOptions, PageHandle};
use crate::services::meeting::gate_stats::mean_gate_latency_ms;
use crate::services::meeting::meeting_provider_interface::{
    ChatMessageRead, ChatReadOptions, ChatReadResult, ChatReadStep, ChatSendResult, ChatSendStep,
    JoinOptions, JoinOutcome, JoinStep, MeetingProvider, ScreenShareOutcome, SignInOptions,
    SpeakerDetails,
};
use crate::services::meeting::providers::google_meet::GOOGLE_MEET_PROVIDER;
use crate::services::meeting::realtime_usage::{RealtimePurpose, RealtimeSpend};
use crate::services::meeting::resampler::MEETING_SAMPLE_RATE;
use crate::services::meeting::response_policy::{EffectiveMode, ResponseMode};
use crate::services::meeting::tool_bridge::{MeetingToolBridgeInput, prepare_meeting_tools};
use crate::services::meeting::voice_conversation::{
    VoiceConversation, VoiceConversationOptions, VoiceConversationStats,
};
use crate::services::voice::agent_voice::{AgentVoice, voice_for_agent};
use crate::services::voice::realtime_tools::MAX_TOOL_RESULT_CHARS;
use crate::services::voice::voice_instructions::{
    VoiceCall, VoiceInstructions, VoiceInstructionsInput, build_voice_instructions,
};
use crate::services::voice::voice_session_lock::{VOICE_SESSION_LOCK, VoiceSessionKind};
use crate::support::js::len16;
use crate::support::js::round as js_round;
use crate::support::now_ms;
use crate::utils::with_timeout::with_timeout;
use crate::{log_debug, log_error, log_info, log_warn};

/// How often to read the participant count.
///
/// Two jobs ride on this reading: leaving once the room has emptied, and choosing
/// whether the agent answers everything or waits to be addressed. The second is
/// what sets the interval — until a third person's arrival has been noticed, the
/// agent is still answering everything said in what is now a group call, so the
/// poll wants to be quick relative to how long that stays tolerable.
const PARTICIPANT_POLL_MS: u64 = 10_000;

/// The label the screenshot carries into the session.
///
/// A user message is the only item shape that takes an image. So the note says that
/// nobody in the room said it, and the model does not answer it as a remark.
const SCREEN_LOOK_NOTE: &str = concat!(
    "This is a picture of your own screen as it looks right now, in answer to your ",
    "see_screen call. Nobody in the room said this."
);

/// How often to ask the platform who is speaking.
///
/// Its own timer, an order of magnitude faster than the participant poll, because it is
/// answering a different kind of question. Ten seconds is right for "has the room
/// emptied"; for "who has the floor" it is useless — a caption label already lags speech
/// by one to two seconds, and a whole exchange can start and finish inside one tick, so a
/// slow poll would attribute most utterances to whoever spoke before them.
///
/// The cost is one small page evaluation per second for the length of the call, which is
/// what a live call ran for hours while this was being developed.
const SPEAKER_POLL_MS: u64 = 1_000;

/// Unreadable counts in a row before saying so.
///
/// The count comes from scraping Meet's UI, which changes without notice. A failure
/// is quiet by design — the last known mode simply stands — so without a log line
/// a broken selector would look exactly like a stable meeting.
const UNREADABLE_COUNTS_BEFORE_WARNING: u32 = 3;

/// How hard to try for a participant count at the moment of admission.
///
/// Meet admits the agent before it renders the other tiles, so the first read is
/// a reliable 1 — see `seed_participant_count`. Together these span a few seconds,
/// which is well inside the poll interval the reading would otherwise wait for.
const SEED_READ_ATTEMPTS: u32 = 5;
const SEED_READ_INTERVAL_MS: u64 = 700;

/// How long to wait for the browser to open the virtual microphone after the unmute.
///
/// Chromium opens the capture device a moment after the toggle flips, not with it, and
/// on a cold container the first open is the slowest thing in the join.
///
/// Generous, and it stayed generous when this stopped being a veto, because being
/// impatient is still expensive: a false "never opened" puts the agent in listen-only
/// mode for the whole meeting over a microphone that was seconds from working. The cost
/// of waiting is a few more seconds on a join that has already spent minutes in a lobby.
const MIC_CAPTURE_TIMEOUT_MS: u64 = 15_000;

/// How long the agent must read as the only one left before it leaves.
///
/// More than a single reading because a count of 1 is also what a brief UI
/// reshuffle looks like, and leaving a live meeting by mistake is much worse than
/// lingering. Expressed as a duration rather than a number of polls so that
/// shortening the poll interval doesn't quietly make the agent quicker to hang up.
const EMPTY_DURATION_BEFORE_LEAVING_MS: u64 = 60_000;

const EMPTY_READINGS_BEFORE_LEAVING: u64 =
    EMPTY_DURATION_BEFORE_LEAVING_MS.div_ceil(PARTICIPANT_POLL_MS);

/// Longest message the agent may post into a call's chat.
///
/// Ours, not the platform's. A chat message here exists to hand over the one thing
/// speech is bad at — a link, an id, a command — so a cap this size takes those and
/// refuses an essay, which the agent should be saying out loud instead. Refusing before
/// the page sees it also means one clear answer the model can act on: Meet's own composer
/// carries `maxlength="4000"` and cuts a longer message there silently — no counter, no
/// error, and the send button stays enabled — so a truncated message posts and is
/// acknowledged, and nobody in the room can tell it from one that arrived whole.
pub const MEETING_CHAT_MAX_CHARS: usize = 500;

/// Wall clock for one whole send, panel and confirmation included.
///
/// The provider bounds every read it takes, but a dozen of them timing out in series adds
/// up, and this is a tool call inside a live call: what the room hears while it runs is
/// silence. Whatever a page this slow is doing, the agent is better off saying the line out
/// loud, which is what a failed send tells it to do.
///
/// Ten seconds is measured from both ends. A live two-participant call sent in 1277ms and
/// 1288ms, and the slowest send in that session took 5745ms with a dialog stuck over the
/// call controls behind it — so this clears the observed worst case with room to spare. The
/// ceiling is `EMPTY_DURATION_BEFORE_LEAVING_MS`: the panel is open while a send runs, an
/// open panel can read the participant count down, and a send that outlasted that would take
/// the agent out of the call it was posting into.
const CHAT_SEND_TIMEOUT_MS: u64 = 10_000;

/// How many of the newest chat messages one read brings back.
///
/// Enough to cover what a room typed while the agent was talking, and short enough to be
/// read out or acted on. The agent is told when there was more than this.
pub const MEETING_CHAT_READ_LIMIT: usize = 20;

/// How much of one message a read keeps.
///
/// Long enough for the pasted stack trace or log line a person puts in the chat instead of
/// reading out. A message longer than this is marked as cut, so the model can say that the
/// end is missing and ask for it.
///
/// The whole reading is bounded by `MAX_TOOL_RESULT_CHARS`, the cap on one tool result handed
/// to a Realtime model: enough to be read out or acted on, and past it the adapter cuts the
/// result anyway.
const CHAT_READ_MAX_CHARS_PER_MESSAGE: usize = 4_000;

/// Wall clock for one whole read, panel and restore included.
///
/// The same figure as a send, for the same reason: what the room hears while it runs is
/// silence, and the agent is better off saying it cannot see the chat.
const CHAT_READ_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingState {
    Idle,
    Launching,
    WaitingAdmission,
    InCall,
    Leaving,
}

impl MeetingState {
    pub fn as_str(self) -> &'static str {
        match self {
            MeetingState::Idle => "idle",
            MeetingState::Launching => "launching",
            MeetingState::WaitingAdmission => "waiting_admission",
            MeetingState::InCall => "in_call",
            MeetingState::Leaving => "leaving",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStatus {
    pub state: MeetingState,
    pub provider: Option<String>,
    /// What was asked for.
    pub response_mode: ResponseMode,
    /// What that resolved to right now — `auto` follows the room, so this is the
    /// answer to "is it going to speak up?" and the requested mode is not.
    pub effective_response_mode: Option<EffectiveMode>,
    pub joined_at: Option<String>,
    /// Whether the room can hear the agent right now.
    ///
    /// `true` audible. `false` not audible — the platform's toggle is muted, or the browser
    /// never opened the capture device, which are two failures with one consequence. `null`
    /// when nothing could be read, and it stays `null`: an agent told its microphone is live
    /// on the strength of a reading nobody took spends the call talking to a room that hears
    /// nothing, which is the failure this field exists to report.
    ///
    /// Read on the participant poll and kept, so this answers from memory.
    pub is_mic_live: Option<bool>,
    /// Whether a screen share was started on this call.
    pub sharing_screen: bool,
    /// Present once the call is under way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<VoiceConversationStats>,
}

/// Whether attribution is working at all on a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attribution {
    Available,
    Unavailable,
}

/// What the runtime can tell the agent about who is in the room and who spoke.
///
/// The audio a meeting bot receives is one mixed channel, so the model itself hears no
/// speaker at all. This is the answer to the question it cannot answer for itself, and
/// every field is allowed to be null: attribution is read off the platform's UI and saying
/// "I cannot tell" is the whole point of having it, because a name spoken aloud to the
/// wrong person is worse than an admission.
///
/// `SpeakerDetails` is the provider's own shape, passed through rather than copied into a
/// second one. What the platform can say about a voice is one fact, and two structures
/// describing it would only ever drift apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerReport {
    pub in_meeting: bool,
    /// Who last made a sound, or null when nobody has or it cannot be told.
    ///
    /// The platform's last reading rather than an instant: readings are polled once a second
    /// and held for a few seconds afterwards, because still meters are how a pause looks as
    /// well as how a stop looks. So this names whoever last had the floor, and goes null when
    /// that reading is too old to believe.
    pub speaking_now: Option<SpeakerDetails>,
    /// Who said the utterance the agent is answering.
    ///
    /// The field worth having. It is pinned when the response is requested and held for the
    /// turn, so it still answers "who asked me this?" once the agent has been talking for
    /// ten seconds and the meters have long since gone still.
    pub spoke_to_you: Option<SpeakerDetails>,
    /// Everyone else the platform lists, the agent excluded.
    pub roster: Vec<String>,
    /// Whether attribution is working at all on this call.
    pub attribution: Attribution,
    /// One line the agent can act on, since a bare null does not say why.
    pub note: String,
}

/// How a chat send ended, in one word.
///
/// This is the telemetry property, so it is an enum: `rejected` is the agent asking for
/// something this runtime will not send (empty, or over the cap), `busy` is a second send
/// arriving while the first is still typing, and `failed` is a page that would not take a
/// message it should have taken. The step a `failed` send got to rides alongside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatSendStatus {
    Sent,
    NotInCall,
    Unsupported,
    Rejected,
    Busy,
    Failed,
}

impl ChatSendStatus {
    fn as_str(self) -> &'static str {
        match self {
            ChatSendStatus::Sent => "sent",
            ChatSendStatus::NotInCall => "not_in_call",
            ChatSendStatus::Unsupported => "unsupported",
            ChatSendStatus::Rejected => "rejected",
            ChatSendStatus::Busy => "busy",
            ChatSendStatus::Failed => "failed",
        }
    }
}

/// What a join attempt has to say to whoever asked for it.
///
/// Every ending names itself: requested, cancelled, or failed with a reason.
#[derive(Debug, Clone, PartialEq, Eq)]
enum JoinAnswer {
    /// The request is in — or the whole join finished, which the caller is told the same way.
    Requested,
    /// A `leave()` or a shutdown ended the call before the request went in.
    Cancelled,
    /// It stopped short of the request, at `step` when the provider named one.
    Failed {
        step: Option<JoinStep>,
        reason: String,
    },
}

/// What the caller is told: whether the room has it, and one sentence saying so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSendOutcome {
    pub sent: bool,
    pub message: String,
}

/// The outcome plus what telemetry and the log line need. Never the body.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChatSendReport {
    sent: bool,
    message: String,
    status: ChatSendStatus,
    step: Option<ChatSendStep>,
    /// Characters offered to the page, after the whitespace was collapsed.
    length: usize,
}

/// How a chat read ended, in one word.
///
/// The telemetry property, so it is an enum. `empty` is a panel that opened and holds
/// nothing, which is a real answer and not a failure. `busy` is a read arriving while
/// something else has the panel, and `failed` covers both a provider that could not read
/// and a page that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatReadStatus {
    Read,
    Empty,
    NotInCall,
    Unsupported,
    Busy,
    Failed,
}

impl ChatReadStatus {
    fn as_str(self) -> &'static str {
        match self {
            ChatReadStatus::Read => "read",
            ChatReadStatus::Empty => "empty",
            ChatReadStatus::NotInCall => "not_in_call",
            ChatReadStatus::Unsupported => "unsupported",
            ChatReadStatus::Busy => "busy",
            ChatReadStatus::Failed => "failed",
        }
    }
}

/// What the caller is told: the messages as one fenced block, and whether it is all of them.
///
/// `success` is false for every outcome that read nothing, so the model never reads a
/// refusal as an empty chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatReadOutcome {
    pub success: bool,
    pub message: String,
    /// True when the panel held more than the reading carries.
    pub incomplete: bool,
}

/// The outcome plus what telemetry and the log line need. Never a message body.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChatReadReport {
    success: bool,
    message: String,
    incomplete: bool,
    status: ChatReadStatus,
    step: Option<ChatReadStep>,
    /// How many messages the reading carries.
    count: usize,
    /// How many characters of message text it carries.
    chars: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct JoinMeetingInput {
    pub url: String,
    pub user_id: String,
    pub agent_id: String,
    /// The thread the call was asked for from, passed on to the meeting tool set.
    pub thread_id: Option<String>,
    /// How much the agent speaks up; `None` is `auto`, which follows the participant count.
    pub response_mode: Option<ResponseMode>,
}

/// What `join` answers: the state the call is in, the step a failed join stopped at, and a
/// sentence for the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinMeetingResult {
    pub state: MeetingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<JoinStep>,
    pub message: String,
}

/// Whether a request was met, and a sentence for the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeetingActionResult {
    pub success: bool,
    pub message: String,
}

/// What `look_at_screen` answers: the outcome and, when there is one, the page's reading
/// beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenLookResult {
    pub success: bool,
    pub message: String,
    /// Its fields sit beside `success` and `message`; `None` writes none of them.
    #[serde(flatten)]
    pub reading: Option<BrowserReading>,
}

/// What `leave` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaveResult {
    pub message: String,
}

/// How a call ended, for `teardown` and the `meeting ended` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TeardownStatus {
    Completed,
    Denied,
    Timeout,
    Error,
}

/// Which way a screen share is driven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShareDirection {
    Start,
    Stop,
}

/// Share of the room's utterances that came with a speaker, as a whole percentage.
///
/// Zero rather than absent when nothing was judged, for the reason `mean_gate_latency_ms`
/// gives: a missing property cannot be told apart from a build that never emitted one.
fn attribution_rate(stats: Option<&VoiceConversationStats>) -> i64 {
    let attributed = stats.map(|s| s.attributed_utterances).unwrap_or(0);
    let total = attributed + stats.map(|s| s.unattributed_utterances).unwrap_or(0);
    if total == 0 {
        return 0;
    }
    js_round((attributed as f64 / total as f64) * 100.0) as i64
}

/// The fence the chat text sits inside, so the model can see where other people's words end.
const CHAT_FENCE_OPEN: &str = "<chat>";
const CHAT_FENCE_CLOSE: &str = "</chat>";

/// What marks a message the read cut, so no line ends short without saying so.
///
/// Public because the tool's own description names it, so the model is told what the
/// marker means before it reads one.
pub const MEETING_CHAT_CUT_MARK: &str = " [message cut]";

/// A control character, which escapes to six characters in JSON.
///
/// Half of a surrogate pair is the other character that does; a Rust string cannot hold
/// one, except where `cut16` leaves one, and that cut writes a space in its place.
fn is_expensive_to_escape(c: char) -> bool {
    ('\u{0000}'..='\u{001F}').contains(&c)
}

/// Replace every character that is expensive to JSON-escape with a space.
fn replace_expensive(text: &str) -> String {
    text.chars()
        .map(|c| if is_expensive_to_escape(c) { ' ' } else { c })
        .collect()
}

/// Text that cannot end the fence early and holds nothing expensive to JSON-escape.
fn fence_safe(text: &str) -> String {
    replace_expensive(text)
        .split(CHAT_FENCE_CLOSE)
        .collect::<Vec<_>>()
        .join(" ")
}

/// The first `units` UTF-16 code units of `text`. A cut inside a surrogate pair leaves
/// its first half, which the fence replaces with a space, so that is written here.
fn cut16(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut taken = 0usize;
    for c in text.chars() {
        let width = c.len_utf16();
        if taken + width > units {
            if taken < units {
                out.push(' ');
            }
            break;
        }
        out.push(c);
        taken += width;
    }
    out
}

/// One message on one line: who sent it, what they typed, and whether the read cut it.
///
/// A name loses the characters a channel's sender tag drops as well, since a name holding a
/// colon or a bracket would read as a second sender. A name the panel did not show leaves
/// the line with the text alone.
fn chat_line(message: &ChatMessageRead) -> String {
    let name = match &message.sender {
        Some(sender) if !sender.is_empty() => fence_safe(sender)
            .chars()
            .filter(|c| !matches!(c, '<' | '>' | ':'))
            .collect::<String>()
            .trim()
            .to_string(),
        _ => String::new(),
    };
    format!(
        "{}{}{}",
        if name.is_empty() {
            String::new()
        } else {
            format!("{name}: ")
        },
        fence_safe(&message.text),
        if message.truncated {
            MEETING_CHAT_CUT_MARK
        } else {
            ""
        }
    )
}

/// Turn the messages into the one block the model reads.
///
/// It strips the closing marker out of every message, so a person cannot end the fence early
/// and have the rest of their line read as the runtime talking.
///
/// It drops the oldest messages until the block fits the budget, which is the most a meeting
/// tool result hands to the model. Dropping oldest first keeps what the room just typed, which
/// is what was asked for. The newest message is cut to fit rather than dropped, since a
/// reading with nothing in it is spoken as an empty chat, and it is marked as cut like any
/// other message the read shortened.
///
/// Both cuts count characters while the adapter measures the JSON-escaped result, so a
/// character that escapes to six is replaced with a space: a control character does, and so
/// does half a surrogate pair, which either cut can leave behind — so a message cut to fit is
/// cleaned again. Everything that survives escapes to at most two.
fn fence_chat_messages(messages: &[ChatMessageRead], truncated: bool) -> ChatReadReport {
    let safe: Vec<String> = messages.iter().map(chat_line).collect();

    let mut kept: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for line in safe.iter().rev() {
        let length = len16(line);
        if chars + length > MAX_TOOL_RESULT_CHARS {
            break;
        }
        kept.insert(0, line.clone());
        chars += length;
    }

    let mut cut_to_fit = false;
    if kept.is_empty() && !safe.is_empty() {
        let room = MAX_TOOL_RESULT_CHARS - len16(MEETING_CHAT_CUT_MARK);
        // A message the reader already cut ends with the mark, so that copy comes off before
        // this cut. Slicing over it would leave half a mark and then append a whole one.
        let newest = &safe[safe.len() - 1];
        let body = newest.strip_suffix(MEETING_CHAT_CUT_MARK).unwrap_or(newest);
        let fitted = replace_expensive(&cut16(body, room));
        kept.push(format!("{fitted}{MEETING_CHAT_CUT_MARK}"));
        chars = len16(&kept[0]);
        cut_to_fit = true;
    }

    let incomplete = truncated
        || cut_to_fit
        || kept.len() < safe.len()
        || messages.iter().any(|one| one.truncated);

    let numbered = kept
        .iter()
        .enumerate()
        .map(|(index, text)| format!("{}. {}", index + 1, text))
        .collect::<Vec<_>>()
        .join("\n");
    let mut lines = vec![
        format!(
            "The last {} message{} in the call's chat, oldest first, each with the name the call shows for whoever sent it.",
            kept.len(),
            if kept.len() == 1 { "" } else { "s" }
        ),
        CHAT_FENCE_OPEN.to_string(),
        numbered,
        CHAT_FENCE_CLOSE.to_string(),
    ];
    if incomplete {
        lines.push(format!(
            "This is not the whole chat — older messages, or the rest of a message marked {}, are not here.",
            MEETING_CHAT_CUT_MARK.trim()
        ));
    }

    ChatReadReport {
        success: true,
        status: ChatReadStatus::Read,
        message: lines.join("\n"),
        incomplete,
        step: None,
        count: kept.len(),
        chars,
    }
}

/// The call's state, behind one lock.
struct MeetingBotState {
    state: MeetingState,
    provider: Option<&'static dyn MeetingProvider>,
    audio: Option<Arc<AudioStack>>,
    browser: Option<Arc<BrowserStack>>,
    conversation: Option<Arc<VoiceConversation>>,
    /// The voice the current call speaks with, for `meeting joined`.
    agent_voice: Option<AgentVoice>,
    page: Option<PageHandle>,
    poll_timer: Option<AbortHandle>,
    speaker_timer: Option<AbortHandle>,
    max_duration_timer: Option<AbortHandle>,
    empty_readings: u64,
    /// Epoch ms.
    joined_at: Option<i64>,
    /// Epoch ms.
    started_at: Option<i64>,
    current: Option<JoinMeetingInput>,
    response_mode: ResponseMode,
    unreadable_counts: u32,
    /// Whether the room has ever been proved able to hear the agent on this call.
    ///
    /// `false` is a degraded call, not a failed one — the agent still hears the meeting
    /// and still acts on it. It decides whether the poll keeps working at getting the call
    /// audible, and whether the agent bothers speaking at all. A mute the agent chooses
    /// leaves it `true`: the audio device below the toggle is proved once and stays proved.
    /// `is_mic_live` is the current answer to "can the room hear you".
    mic_confirmed: bool,
    /// Whether the room can hear the agent, reported as `MeetingStatus::is_mic_live`.
    ///
    /// `Some(true)` means it can, `Some(false)` that it cannot, and `None` that nobody could
    /// read the control. The last two differ in their evidence: a mute somebody made, against
    /// a reading that is missing.
    is_mic_live: Option<bool>,
    /// Whether the agent wants to be heard.
    ///
    /// The poll needs to tell a mute the agent chose from one the call imposed, and only this
    /// says which: the reading is the same either way. A request that does not take is rolled
    /// back, so this holds what the agent last actually got.
    mic_desired: bool,
    /// Whether the platform's microphone toggle has ever read on during this call.
    ///
    /// A muted toggle means two different things, and this tells them apart. Before the first
    /// reading of `on`, the join never got the microphone open, so the poll clicks it. After
    /// one, somebody in the call did the mute, so the poll reports it and leaves it alone.
    has_mic_been_on: bool,
    /// Whether the current mute has already been reported.
    ///
    /// One notice per transition, not one per poll. A mute the agent asked for counts as
    /// reported, since the party that asked for it needs no telling. Held separately from
    /// `is_mic_live` because an unreadable reading between two muted ones must not count as
    /// the mute ending.
    mic_mute_reported: bool,
    /// Whether a share was started on this call.
    ///
    /// Held here so the agent can be told without a CDP round trip, and cleared with the
    /// rest of the call state. It records what this runtime started, not what Meet shows
    /// now: a share that somebody stopped from the room still reads true until the call
    /// ends.
    sharing_screen: bool,
    /// Whether the agent presented at any point in this call.
    ///
    /// Separate from `sharing_screen`, which a stop clears: the telemetry question is
    /// whether the room was ever shown anything, and a call that shared and then stopped
    /// would answer that with `false`.
    shared_screen: bool,
    /// Browser commands run on this call, reported once at the end.
    browser_commands: u64,
    /// Whether a participant poll is still running; see `check_participants`.
    poll_in_flight: bool,
    speaker_poll_in_flight: bool,
    /// Whether any speaker has ever been read on this call.
    ///
    /// Reported to the agent as whether attribution works at all, and it is the honest
    /// answer to that: a quiet room reads no speaker either, so it can stay false for a while
    /// on a perfectly healthy call — and "nothing has been attributed yet" is exactly what
    /// the agent should hear then, rather than a confident silence.
    ///
    /// It does *not* gate the retry, unlike `mic_confirmed`. The provider is asked to prepare
    /// itself on every poll, because the panel is UI state a re-render or a reconnect can
    /// take away, and a first successful read is no evidence it is still there.
    speaker_seen: bool,
    /// Whether a send or a read has the chat panel right now.
    ///
    /// Two jobs. It refuses a second one, which would otherwise fill the same draft box
    /// from two places and post one message made of both, or have one flow close the panel
    /// the other is reading. And it holds off the unmute retry, which drives the same page:
    /// that one sweeps dialogs and clicks a toggle, so it is the half that can move the
    /// control bar out from under a send in progress.
    ///
    /// One flag for both directions, since both drive the one panel.
    chat_panel_busy: bool,
    /// Step a failed join reached, carried to the `meeting ended` event.
    fail_step: Option<JoinStep>,
    /// Which call the asynchronous join flow belongs to.
    ///
    /// Joining is fire-and-forget — `join()` returns while the waiting room is still
    /// being waited on — so a `leave()` (or a timeout, or shutdown) can tear
    /// everything down while `run_join()` is still parked inside the provider. When
    /// that admission then resolves, it must not write state belonging to a call that
    /// no longer exists; without this guard a late "admitted" resurrects the service
    /// into `in_call` with no browser or session behind it. Bumped on every teardown,
    /// and checked after every await in the join flow.
    epoch: u64,
    /// The epoch of a startup that is still building, or `None` when none is.
    ///
    /// The one thing a cancelled call cannot do is stop instantly: it may be parked
    /// inside a sign-in for the better part of a minute, and there is no way to
    /// interrupt that from outside. So `teardown()` returns the service to `leaving`
    /// rather than `idle` while this is set, and `join()` refuses until the abandoned
    /// startup has let go.
    ///
    /// That wait is not caution about resource accounting. Both startups drive the
    /// *same* persistent browser profile, and `BrowserStack::start()` clears the
    /// profile's `SingletonLock`/`SingletonCookie`/`SingletonSocket` before launching —
    /// which is correct for the stale locks a killed container leaves behind, and
    /// catastrophic against a live one: the second Chromium would delete the first's
    /// lock and open the same profile directory alongside it. Two writers to one
    /// profile is how a working Google session gets invalidated, and the session is
    /// the thing every join depends on.
    startup_epoch: Option<u64>,
}

pub struct MeetingBotService {
    providers: Vec<&'static dyn MeetingProvider>,
    state: Mutex<MeetingBotState>,
    /// Held for each microphone click; see `with_mic_click`.
    ///
    /// Two callers can want the control at once — the poll's retry and the agent's own tool —
    /// and on a toggle two overlapping clicks undo each other.
    mic_click: tokio::sync::Mutex<()>,
    /// The queue for everything that moves the front tab.
    ///
    /// The Realtime model issues tool calls in parallel, and a `browse` that lands inside a
    /// share start leaves the front tab decided by whichever `bring_to_front` resolves last —
    /// which the room watches happen. Each acquisition waits for the previous one, so these
    /// run in arrival order. A command that fails must not stop the next one.
    front_queue: tokio::sync::Mutex<()>,
}

impl Default for MeetingBotService {
    fn default() -> Self {
        Self::new()
    }
}

impl MeetingBotService {
    pub fn new() -> Self {
        Self {
            providers: vec![&*GOOGLE_MEET_PROVIDER as &'static dyn MeetingProvider],
            state: Mutex::new(MeetingBotState {
                state: MeetingState::Idle,
                provider: None,
                audio: None,
                browser: None,
                conversation: None,
                agent_voice: None,
                page: None,
                poll_timer: None,
                speaker_timer: None,
                max_duration_timer: None,
                empty_readings: 0,
                joined_at: None,
                started_at: None,
                current: None,
                response_mode: ResponseMode::Auto,
                unreadable_counts: 0,
                mic_confirmed: false,
                is_mic_live: None,
                mic_desired: true,
                has_mic_been_on: false,
                mic_mute_reported: false,
                sharing_screen: false,
                shared_screen: false,
                browser_commands: 0,
                poll_in_flight: false,
                speaker_poll_in_flight: false,
                speaker_seen: false,
                chat_panel_busy: false,
                fail_step: None,
                epoch: 0,
                startup_epoch: None,
            }),
            mic_click: tokio::sync::Mutex::new(()),
            front_queue: tokio::sync::Mutex::new(()),
        }
    }

    /// The provider that handles this link, if any.
    pub fn find_provider(&self, url: &str) -> Option<&'static dyn MeetingProvider> {
        self.providers.iter().copied().find(|p| p.matches_url(url))
    }

    pub fn is_active(&self) -> bool {
        self.state.lock().state != MeetingState::Idle
    }

    pub fn status(&self) -> MeetingStatus {
        let state = self.state.lock();
        MeetingStatus {
            state: state.state,
            provider: state.provider.map(|p| p.name().to_string()),
            response_mode: state.response_mode,
            effective_response_mode: state.conversation.as_ref().map(|c| c.response_mode()),
            joined_at: state
                .joined_at
                .map(|ms| crate::support::iso(&crate::support::from_ms(ms))),
            is_mic_live: state.is_mic_live,
            sharing_screen: state.sharing_screen,
            stats: state.conversation.as_ref().map(|c| c.statistics()),
        }
    }

    /// Who is speaking, and who the agent is answering.
    ///
    /// Reads state the polls have already gathered and touches the browser not at all. That
    /// is a requirement rather than an optimisation: the agent calls this mid-turn in a live
    /// room, and a fresh page read would put a CDP round trip between a question and its
    /// answer — silence the room hears. So it answers from the last reading, up to a few
    /// seconds old, not from the instant it was asked.
    pub fn speaker_report(&self) -> SpeakerReport {
        let (meeting_state, conversation, speaker_seen) = {
            let state = self.state.lock();
            (state.state, state.conversation.clone(), state.speaker_seen)
        };
        let in_meeting = meeting_state != MeetingState::Idle;
        let Some(conversation) = conversation.filter(|_| in_meeting) else {
            let note = if meeting_state == MeetingState::Idle {
                "You are not in a call.".to_string()
            } else {
                format!(
                    "You are {} the call, so there is nobody to attribute yet.",
                    if meeting_state == MeetingState::Leaving {
                        "leaving"
                    } else {
                        "still joining"
                    }
                )
            };
            return SpeakerReport {
                in_meeting,
                speaking_now: None,
                spoke_to_you: None,
                roster: Vec::new(),
                attribution: Attribution::Unavailable,
                note,
            };
        };

        let speaking_now = conversation.current_speaker().map(|reading| reading.who);
        let spoke_to_you = conversation.answering_speaker().map(|reading| reading.who);
        let note = Self::speaker_note(
            speaker_seen,
            spoke_to_you.as_ref().or(speaking_now.as_ref()),
        );

        SpeakerReport {
            in_meeting,
            speaking_now,
            spoke_to_you,
            roster: conversation.roster(),
            attribution: if speaker_seen {
                Attribution::Available
            } else {
                Attribution::Unavailable
            },
            note,
        }
    }

    fn speaker_note(speaker_seen: bool, who: Option<&SpeakerDetails>) -> String {
        if !speaker_seen {
            return concat!(
                "I cannot tell who is speaking in this call — the platform is not showing it. ",
                "Do not guess at a name; ask if it matters."
            )
            .to_string();
        }
        match who {
            None => concat!(
                "Nobody has been identified recently. That usually means a pause, or two people ",
                "talking at once, which cannot be told apart on one mixed channel."
            )
            .to_string(),
            // Named where the platform could say who, because "one of Jari or Mario" is more
            // use to the room than the label Meet gives its own shared row.
            Some(SpeakerDetails::Group { members }) => {
                let people = if members.is_empty() {
                    "more than one person".to_string()
                } else {
                    members.join(" or ")
                };
                format!(
                    "That came from a microphone shared by {people} in the same room, so I cannot tell which of them spoke."
                )
            }
            Some(SpeakerDetails::Person { name }) => format!("That was {name}."),
        }
    }

    /// Bring up the stack and request to join.
    ///
    /// Returns once the request is submitted, or once the join has failed short of that,
    /// and names the step it failed at. A guest can wait indefinitely for a host, so the
    /// calling chat turn must not block on admission — but it can and must wait for the
    /// request itself, which is seconds on a healthy call and minutes on a pathological one,
    /// since a lobby that refuses the session is loaded and hunted twice over a second
    /// sign-in. Admission, denial and the end of the call are logged as they happen, and
    /// `status()` answers for them on request.
    pub async fn join(&'static self, input: JoinMeetingInput) -> JoinMeetingResult {
        {
            let state = self.state.lock();
            if state.state == MeetingState::Leaving {
                // Not "already in a call" — the last one has ended and its browser is still
                // being let go of. Two different waits share this state, and only one of
                // them is the long one: an abandoned startup parked in a sign-in, or an
                // ordinary teardown a moment from finishing.
                return JoinMeetingResult {
                    state: state.state,
                    step: None,
                    message: if state.startup_epoch.is_none() {
                        "I'm still releasing the previous call's browser. Give me a moment and ask again.".to_string()
                    } else {
                        "I'm still releasing the previous call — a sign-in already in progress has to finish first. Give me a moment and ask again.".to_string()
                    },
                };
            }
            if state.state != MeetingState::Idle {
                return JoinMeetingResult {
                    state: state.state,
                    step: None,
                    message: format!(
                        "Already in a {} call ({}). Leave that one first.",
                        state
                            .provider
                            .map(|p| p.display_name())
                            .unwrap_or("meeting"),
                        state.state.as_str()
                    ),
                };
            }
        }

        let Some(provider) = self.find_provider(&input.url) else {
            return idle_answer("That doesn't look like a supported meeting link.".to_string());
        };

        // Asked before a call's worth of infrastructure is built: a platform that will
        // not take an unauthenticated bot says so here rather than in the lobby.
        if let Some(misconfigured) = provider.configuration_error() {
            return idle_answer(misconfigured);
        }

        // The agent has one voice, and a browser voice chat may be using it. The lock is
        // held for exactly as long as this service is not `idle`.
        if !VOICE_SESSION_LOCK.try_acquire(VoiceSessionKind::Meeting) {
            return idle_answer(
                "I'm in a voice chat right now. End that first and I'll join the call.".to_string(),
            );
        }

        let epoch = {
            let mut state = self.state.lock();
            state.provider = Some(provider);
            state.current = Some(input.clone());
            state.response_mode = input.response_mode.unwrap_or(ResponseMode::Auto);
            state.state = MeetingState::Launching;
            state.started_at = Some(now_ms());
            let epoch = state.epoch;
            state.startup_epoch = Some(epoch);
            epoch
        };

        let answer = self.start_call(provider, input, epoch).await;
        self.release_startup_slot(epoch);
        answer
    }

    /// The body of `join` from the moment the service is `launching`.
    ///
    /// The stack is built into locals and published onto the state only once the epoch
    /// check says the call is still wanted: startup is many awaits long, and a `leave()` in
    /// that window lets a *second* `join()` get well under way before this one resumes.
    async fn start_call(
        &'static self,
        provider: &'static dyn MeetingProvider,
        input: JoinMeetingInput,
        epoch: u64,
    ) -> JoinMeetingResult {
        let mut locals = Locals::default();
        match self
            .build_and_request(provider, &input, epoch, &mut locals)
            .await
        {
            Ok(answer) => answer,
            Err(err) => {
                let message = err.to_string();
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Meeting] Failed to start the meeting stack"
                );
                // Locals first, and unconditionally: the stack reaches the state only once
                // the join is under way, so a failure before that leaves `teardown` with
                // nothing to release.
                self.release_locals(&mut locals).await;
                if self.state.lock().epoch == epoch {
                    self.teardown(TeardownStatus::Error).await;
                }
                idle_answer(format!("Could not join the meeting: {message}"))
            }
        }
    }

    /// Release a stack that was built for a call nobody is waiting for any more.
    async fn release_locals(&self, locals: &mut Locals) {
        if let Some(conversation) = locals.conversation.take() {
            conversation.stop();
        }
        if let Some(browser) = locals.browser.take() {
            browser.stop().await;
        }
        if let Some(audio) = locals.audio.take() {
            audio.stop().await;
        }
    }

    async fn build_and_request(
        &'static self,
        provider: &'static dyn MeetingProvider,
        input: &JoinMeetingInput,
        epoch: u64,
        locals: &mut Locals,
    ) -> anyhow::Result<JoinMeetingResult> {
        // Instructions and tools first: they need the database and the model catalog,
        // and failing here should cost nothing but a message.
        let instructions = self.build_instructions(input).await?;
        let tools = prepare_meeting_tools(MeetingToolBridgeInput {
            user_id: input.user_id.clone(),
            agent_id: input.agent_id.clone(),
            thread_id: input.thread_id.clone(),
            locked_in: instructions.locked_in,
        })
        .await?;

        let audio = Arc::new(AudioStack::new());
        locals.audio = Some(audio.clone());
        let handles = audio.start(AudioStackOptions::default()).await?;
        // Deaf or mute is not a state to sit in: a dead capture or playback process
        // leaves the bot in the room unable to hear or speak. Same ending as a lost
        // Realtime session.
        (handles.on_lost)(Arc::new(move |reason| self.on_audio_lost(epoch, reason)));

        let response_mode = self.state.lock().response_mode;
        let agent_voice = voice_for_agent(&instructions.agent_name).await;
        let conversation = VoiceConversation::new(VoiceConversationOptions {
            on_response_finished: None,
            instructions: instructions.instructions.clone(),
            opening_context: instructions.opening_context.clone(),
            tools,
            sink: handles.playback_sink.clone(),
            // The virtual audio devices run at the meeting rate, so both resamplers are in
            // the path.
            sample_rate: MEETING_SAMPLE_RATE,
            response_mode,
            // The name the prompt introduces it by: an agent that says one name and
            // answers to another would stay silent when addressed by the one it gave.
            agent_name: instructions.agent_name.clone(),
            model: None,
            voice: Some(agent_voice.voice.clone()),
            endpoint_override: None,
            spend: RealtimeSpend::new(RealtimePurpose::Meeting, None),
            on_session_lost: Some(Arc::new(move |reason| self.on_session_lost(epoch, reason))),
        })?;
        locals.conversation = Some(conversation.clone());
        conversation.start().await?;
        // Bound to this call's session rather than to the state's, which may belong to
        // whatever runs next.
        let live = conversation.clone();
        (handles.on_capture)(Arc::new(move |pcm| live.push_audio(&pcm)));

        let browser = Arc::new(BrowserStack::new());
        locals.browser = Some(browser.clone());
        let page = browser
            .start(BrowserStackOptions {
                env: handles.browser_env.clone(),
                profile_dir: None,
            })
            .await?;

        // Before the epoch check below, deliberately: a login can take 20-45s, and a
        // leave() during it must still find the browser and audio released. Never fails.
        provider.sign_in(&page, SignInOptions::default()).await;

        // A leave() or shutdown during setup already tore this call down. Release the
        // stack here without publishing any of it onto a state that may describe a
        // newer call.
        if self.state.lock().epoch != epoch {
            self.release_locals(locals).await;
            return Ok(idle_answer(
                "The meeting was cancelled before I could join.".to_string(),
            ));
        }

        {
            let mut state = self.state.lock();
            state.audio = locals.audio.take();
            state.conversation = locals.conversation.take();
            state.agent_voice = Some(agent_voice);
            state.browser = locals.browser.take();
            state.page = Some(page.clone());
        }
        // The stack is on the state, so `teardown()` can release it — which is the whole
        // job of the startup marker. Let go of it here: from this line on a teardown does
        // real, awaited work.
        self.release_startup_slot(epoch);

        self.state.lock().state = MeetingState::WaitingAdmission;
        // Two answers race: the request going in, and a failure before it went in.
        let (submitted_tx, submitted_rx) = oneshot::channel::<()>();
        let submitted_tx = Arc::new(Mutex::new(Some(submitted_tx)));
        let request_submitted: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(tx) = submitted_tx.lock().take() {
                let _ = tx.send(());
            }
        });
        // Not awaited beyond the race: the waiting room can outlast any chat turn, and
        // `run_join` reports everything after the request itself.
        let mut attempt =
            tokio::spawn(self.run_join(provider, page, input.clone(), epoch, request_submitted));

        let answer = tokio::select! {
            Ok(()) = submitted_rx => JoinAnswer::Requested,
            finished = &mut attempt => finished.unwrap_or_else(|err| JoinAnswer::Failed {
                step: None,
                reason: err.to_string(),
            }),
        };
        Ok(match answer {
            // The state the request left behind, rather than a fresh reading.
            JoinAnswer::Requested => JoinMeetingResult {
                state: MeetingState::WaitingAdmission,
                step: None,
                message: format!(
                    "Requested to join the {} call. A host needs to admit me — ask me for my meeting status to find out whether I'm in.",
                    provider.display_name()
                ),
            },
            JoinAnswer::Cancelled => {
                idle_answer("The meeting was cancelled before I could join.".to_string())
            }
            JoinAnswer::Failed { step, reason } => JoinMeetingResult {
                state: MeetingState::Idle,
                step,
                message: format!("Could not join the meeting: {reason}"),
            },
        })
    }

    /// Mark this startup as finished building, and free the service if it was waiting.
    ///
    /// Only the startup that is still the current one clears the marker: a newer
    /// `join()` owns it from the moment it sets its own. A service held in `leaving` by
    /// `teardown()` becomes `idle` here and releases the voice lock, since the shared
    /// browser profile was not free until this startup let go of it.
    fn release_startup_slot(&self, epoch: u64) {
        let release = {
            let mut state = self.state.lock();
            if state.startup_epoch != Some(epoch) {
                return;
            }
            state.startup_epoch = None;
            if state.state == MeetingState::Leaving {
                state.state = MeetingState::Idle;
                true
            } else {
                false
            }
        };
        if release {
            VOICE_SESSION_LOCK.release(VoiceSessionKind::Meeting);
        }
    }

    fn epoch_is(&self, epoch: u64) -> bool {
        self.state.lock().epoch == epoch
    }

    /// Await the join outcome, then either settle into the call or clean up.
    ///
    /// Answers the failures that happen before the request goes in, so `join()` can report
    /// them to whoever asked. Everything after the request — admission, denial, the end of
    /// the call — is logged and left to `status()`, because no chat turn can wait for a
    /// host, so those endings answer `Requested` here.
    async fn run_join(
        &'static self,
        provider: &'static dyn MeetingProvider,
        page: PageHandle,
        input: JoinMeetingInput,
        epoch: u64,
        request_submitted: Arc<dyn Fn() + Send + Sync>,
    ) -> JoinAnswer {
        match self
            .settle_into_call(provider, &page, &input, epoch, request_submitted)
            .await
        {
            Ok(answer) => answer,
            Err(err) => {
                // A teardown mid-wait closes the page underneath the provider, so the
                // failure is expected there and belongs to a call that is already gone.
                if !self.epoch_is(epoch) {
                    return JoinAnswer::Cancelled;
                }
                let reason = err.to_string();
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Meeting] Join flow threw for the {} call",
                    provider.display_name()
                );
                let step = self.state.lock().fail_step;
                self.teardown(TeardownStatus::Error).await;
                JoinAnswer::Failed { step, reason }
            }
        }
    }

    async fn settle_into_call(
        &'static self,
        provider: &'static dyn MeetingProvider,
        page: &PageHandle,
        input: &JoinMeetingInput,
        epoch: u64,
        request_submitted: Arc<dyn Fn() + Send + Sync>,
    ) -> anyhow::Result<JoinAnswer> {
        let join_options = JoinOptions {
            url: input.url.clone(),
            admission_timeout_ms: CONFIG.meeting_admission_timeout_ms.max(0) as u64,
            on_request_submitted: request_submitted,
        };

        let mut outcome = provider.join(page, join_options.clone()).await?;
        // The call was ended while we waited (leave, timeout, shutdown).
        if !self.epoch_is(epoch) {
            return Ok(JoinAnswer::Cancelled);
        }

        // The platform says the profile's session is stale. Sign in again and try the
        // link once more — once, deliberately: a second failure is a real problem, and
        // retrying in a loop would hammer Google's login with credentials that failed.
        if outcome == JoinOutcome::ReauthRequired {
            // `force`: the provider asks for this only once the session it was handed has
            // failed to work, so checking again spends the settle budget for nothing.
            provider.sign_in(page, SignInOptions { force: true }).await;
            if !self.epoch_is(epoch) {
                return Ok(JoinAnswer::Cancelled);
            }

            outcome = provider.join(page, join_options).await?;
            if !self.epoch_is(epoch) {
                return Ok(JoinAnswer::Cancelled);
            }

            // Twice in a row is not a stale cookie any more.
            if outcome == JoinOutcome::ReauthRequired {
                self.state.lock().fail_step = Some(JoinStep::Lobby);
                let reason = "signing in again did not help, and the meeting still treats this browser as a guest, which it refuses automatically".to_string();
                log_warn!(
                    "[Meeting] Could not join the {} call: {}",
                    provider.display_name(),
                    reason
                );
                self.teardown(TeardownStatus::Denied).await;
                return Ok(JoinAnswer::Failed {
                    step: Some(JoinStep::Lobby),
                    reason,
                });
            }
        }

        let denied = matches!(outcome, JoinOutcome::Denied { .. });
        let (muted_on_entry, mic_confirmed) = match outcome {
            JoinOutcome::Admitted {
                muted_on_entry,
                mic_confirmed,
            } => (muted_on_entry, mic_confirmed),
            JoinOutcome::Denied { reason, step } | JoinOutcome::Failed { reason, step } => {
                // Handed to the one owning emitter in `teardown`, so the failing step rides
                // the existing `meeting ended` event.
                self.state.lock().fail_step = Some(step);
                if denied {
                    log_warn!(
                        "[Meeting] Denied entry to the {} call at the \"{}\" step: {}",
                        provider.display_name(),
                        step.as_str(),
                        reason
                    );
                } else {
                    log_error!(
                        "[Meeting] Joining the {} call failed at the \"{}\" step: {}",
                        provider.display_name(),
                        step.as_str(),
                        reason
                    );
                }
                self.teardown(if denied {
                    TeardownStatus::Denied
                } else {
                    TeardownStatus::Error
                })
                .await;
                return Ok(JoinAnswer::Failed {
                    step: Some(step),
                    reason,
                });
            }
            JoinOutcome::ReauthRequired => unreachable!("a second refusal returned above"),
        };

        // The provider has the platform's word for the microphone. This is the layer under
        // it: whether the browser ever opened a capture device at all. Reaching admission
        // without an audio stack is a bug in this service, not a condition to tolerate.
        let Some(audio) = self.state.lock().audio.clone() else {
            anyhow::bail!("admitted to a call with no audio stack");
        };

        let capturing = audio.wait_for_mic_capture(MIC_CAPTURE_TIMEOUT_MS).await;
        // The wait can outlive the call.
        if !self.epoch_is(epoch) {
            return Ok(JoinAnswer::Cancelled);
        }

        // Audible only if both halves agree. Either one failing is a call the agent can
        // hear but not speak in — degraded, not over.
        let audible = mic_confirmed && capturing;
        let conversation = {
            let mut state = self.state.lock();
            state.mic_confirmed = audible;
            // The first `is_mic_live` reading, taken from the join. `None` only where
            // nothing was read at all.
            state.is_mic_live = if audible {
                Some(true)
            } else if mic_confirmed || muted_on_entry {
                Some(false)
            } else {
                None
            };
            // The join read the toggle open, so a muted reading later in the call came from
            // somebody in it.
            state.has_mic_been_on = mic_confirmed;
            state.state = MeetingState::InCall;
            state.joined_at = Some(now_ms());
            state.conversation.clone()
        };
        if let Some(conversation) = &conversation {
            conversation.set_audible(audible);
        }

        // Speaker attribution, before the agent has said a word, so the very first thing
        // said in the call can already be attributed. Never fails.
        if provider.capabilities().enable_speaker_attribution {
            let page = self.state.lock().page.clone();
            if let Some(page) = page {
                provider.enable_speaker_attribution(&page).await;
                if !self.epoch_is(epoch) {
                    return Ok(JoinAnswer::Cancelled);
                }
            }
        }

        let response_mode = self.state.lock().response_mode;
        let mut properties = IndexMap::new();
        properties.insert(
            "inference_provider".to_string(),
            CONFIG
                .realtime_provider
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
        );
        properties.insert(
            "inference_source".to_string(),
            CONFIG.realtime_source.as_str().to_string(),
        );
        properties.insert("provider".to_string(), provider.name().to_string());
        properties.insert(
            "response_mode".to_string(),
            response_mode.as_str().to_string(),
        );
        // How often the platform auto-mutes a new joiner, and whether the unmute worked.
        properties.insert("muted_on_entry".to_string(), muted_on_entry.to_string());
        properties.insert("mic_confirmed".to_string(), audible.to_string());
        let agent_voice = self.state.lock().agent_voice.clone();
        properties.insert(
            "voice".to_string(),
            agent_voice
                .as_ref()
                .map_or("unknown", |voice| voice.voice.as_str())
                .to_string(),
        );
        properties.insert(
            "voice_source".to_string(),
            agent_voice
                .as_ref()
                .map_or("unknown", |voice| voice.source.as_str())
                .to_string(),
        );
        track_event("meeting joined", Some(&input.user_id), Some(properties));

        if audible {
            log_info!(
                "[Meeting] Admitted to the {} call, and audible to the room",
                provider.display_name()
            );
            self.greet_the_room(provider.display_name());
        } else {
            // No greeting, and the model is told why. The warning names both readings,
            // because they send an engineer to different places.
            log_warn!(
                "[Meeting] Admitted to the {} call but not audibly (mic control confirmed: {}, capture device open: {}) — listening, and retrying the unmute",
                provider.display_name(),
                mic_confirmed,
                capturing
            );
            if let Some(conversation) = &conversation {
                conversation.notify(&format!(
                    "You are in the {} call, but I could not confirm your microphone is on, so the participants may not hear you. Don't greet anyone. I am retrying the unmute for you, and set_microphone with on: true is yours to try as well. Go no further than that control — the audio devices under the call are not something to repair from in here. Keep listening, and act on what you hear. If somebody responds to something you said, you are audible after all and can carry on normally.",
                    provider.display_name()
                ));
            }
        }

        // Failing to read the room is not a reason to abandon a call already joined.
        self.seed_participant_count(epoch).await;

        // The await above can outlive the call; arming timers now would leave ones nobody
        // clears.
        if !self.epoch_is(epoch) {
            return Ok(JoinAnswer::Cancelled);
        }
        self.start_watchdogs();
        Ok(JoinAnswer::Requested)
    }

    /// Start the participant poll, the speaker poll and the duration cap.
    ///
    /// Each tick runs as its own task, so a teardown that stops the timers never stops the
    /// work a tick already started.
    fn start_watchdogs(&'static self) {
        let poll = tokio::spawn(async move {
            let period = Duration::from_millis(PARTICIPANT_POLL_MS);
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                ticks.tick().await;
                tokio::spawn(self.check_participants());
            }
        });
        let speaker = self
            .state
            .lock()
            .provider
            .filter(|provider| provider.capabilities().current_speaker)
            .map(|_| {
                tokio::spawn(async move {
                    let period = Duration::from_millis(SPEAKER_POLL_MS);
                    let mut ticks =
                        tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                    loop {
                        ticks.tick().await;
                        tokio::spawn(self.check_speaker());
                    }
                })
            });
        let minutes = CONFIG.meeting_timeout_minutes;
        let cap = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis((minutes.max(0) as u64) * 60 * 1000)).await;
            tokio::spawn(self.finish(
                TeardownStatus::Timeout,
                Some(format!("Left the call: it hit the {minutes}-minute limit")),
            ));
        });

        let mut state = self.state.lock();
        state.poll_timer = Some(poll.abort_handle());
        state.speaker_timer = speaker.map(|task| task.abort_handle());
        state.max_duration_timer = Some(cap.abort_handle());
    }

    /// Read the participant count a few times right after admission, since Meet admits the
    /// agent before it renders the other tiles and the first read is a reliable 1.
    ///
    /// Gives up quietly rather than seeding a 1. The policy's cautious default — wait to be
    /// addressed — is the right place to stay when the room is unknown, and the poll will
    /// correct it within one interval.
    async fn seed_participant_count(&self, epoch: u64) {
        for _ in 0..SEED_READ_ATTEMPTS {
            let (page, provider, conversation) = {
                let state = self.state.lock();
                if state.epoch != epoch || state.state != MeetingState::InCall {
                    return;
                }
                let (Some(page), Some(provider)) = (state.page.clone(), state.provider) else {
                    return;
                };
                (page, provider, state.conversation.clone())
            };

            // A failed read keeps trying: the page is still settling.
            let count = provider.participant_count(&page).await.ok().flatten();

            // Anything above the agent itself means the room has rendered.
            if let Some(count) = count.filter(|count| *count > 1) {
                if let Some(conversation) = conversation {
                    conversation.set_participant_count(Some(count));
                }
                return;
            }

            tokio::time::sleep(Duration::from_millis(SEED_READ_INTERVAL_MS)).await;
        }

        log_info!("[Meeting] Room not readable yet on admission — waiting for the poll");
    }

    /// Have the agent greet the room it was just admitted to.
    ///
    /// Held in one place because it happens at either of two moments: on admission when
    /// the microphone came up with the call, or later, the first time a mid-call retry
    /// gets it live. A room that could not hear the greeting was never greeted.
    fn greet_the_room(&self, display_name: &str) {
        let conversation = self.state.lock().conversation.clone();
        if let Some(conversation) = conversation {
            conversation.notify(&format!(
                "You have just been admitted to the {display_name} call. Greet the participants in one short sentence and say what you can help with."
            ));
            conversation.speak_now();
        }
    }

    /// Read the microphone on the participant poll, report a change, and work at getting
    /// an inaudible call audible.
    async fn check_microphone(&self, epoch: u64) {
        let (page, provider) = {
            let state = self.state.lock();
            (state.page.clone(), state.provider)
        };
        let (Some(page), Some(provider)) = (page, provider) else {
            return;
        };
        if !provider.capabilities().microphone_live {
            return;
        }

        // Under the click lock as well, and for the write rather than the read: a read that
        // starts before a click and lands after it would put the replaced state back.
        let live = match self.with_mic_click(provider.microphone_live(&page)).await {
            Ok(live) => live,
            Err(err) => {
                // A teardown can close the page mid-read. The next poll asks again.
                log_debug!("[Meeting] Could not read the microphone: Error: {}", err);
                return;
            }
        };
        {
            let state = self.state.lock();
            if state.epoch != epoch || state.state != MeetingState::InCall {
                return;
            }
        }

        self.record_mic_reading(live);
        let (confirmed, desired, chat_busy) = {
            let state = self.state.lock();
            (
                state.mic_confirmed,
                state.mic_desired,
                state.chat_panel_busy,
            )
        };
        if confirmed || !desired {
            return;
        }
        // The clicking half waits while the chat panel is busy: it sweeps dialogs and
        // clicks the control bar on the same page.
        if chat_busy {
            return;
        }
        self.make_audible(epoch, live).await;
    }

    /// Record a microphone reading, and tell the agent when it stops matching what it asked
    /// for.
    ///
    /// Both directions, once each. The model is told in band because it is the party that
    /// cannot tell: it hears the room while the room hears nothing back. Each transition also
    /// writes one log line, which is where an engineer reads why the agent went quiet.
    ///
    /// An unreadable control changes the reading and says nothing, since the evidence for a
    /// mute is missing rather than present. It reaches the agent as `isMicLive: null`.
    fn record_mic_reading(&self, next: Option<bool>) {
        enum Notice {
            Muted,
            Back,
        }
        let (notice, conversation) = {
            let mut state = self.state.lock();
            if next == Some(true) {
                state.has_mic_been_on = true;
            }
            state.is_mic_live = if next == Some(true) {
                Some(state.mic_confirmed)
            } else {
                next
            };

            let notice = if next == Some(false)
                && state.has_mic_been_on
                && state.mic_desired
                && !state.mic_mute_reported
            {
                state.mic_mute_reported = true;
                Some(Notice::Muted)
            } else if state.is_mic_live == Some(true) && state.mic_mute_reported {
                state.mic_mute_reported = false;
                Some(Notice::Back)
            } else {
                None
            };
            (notice, state.conversation.clone())
        };

        match notice {
            Some(Notice::Muted) => {
                log_warn!(
                    "[Meeting] The microphone was muted mid-call and nobody here asked for it"
                );
                if let Some(conversation) = conversation {
                    conversation.notify(
                        "Your microphone has just been muted — something in the call did that, not you, so the participants cannot hear you now. Say nothing until it is back. If somebody asked you to be quiet, stay muted. Otherwise call set_microphone with on: true, and carry on if that works.",
                    );
                }
            }
            Some(Notice::Back) => {
                log_info!("[Meeting] The microphone is live again");
                if let Some(conversation) = conversation {
                    conversation
                        .notify("Your microphone is on again — the participants can hear you.");
                }
            }
            None => {}
        }
    }

    /// Click the microphone on, and confirm the capture device opened.
    ///
    /// Two halves have to hold: the platform's toggle open, and the browser capturing from the
    /// virtual device. The toggle gets one click per poll while the join never got it open,
    /// and the capture device is re-read every poll. The greeting waits for both.
    async fn make_audible(&self, epoch: u64, reading: Option<bool>) {
        let (page, provider, audio, has_been_on) = {
            let state = self.state.lock();
            (
                state.page.clone(),
                state.provider,
                state.audio.clone(),
                state.has_mic_been_on,
            )
        };
        let (Some(page), Some(provider)) = (page, provider) else {
            return;
        };
        if !provider.capabilities().set_microphone {
            return;
        }

        let still_wanted = || {
            let state = self.state.lock();
            state.epoch == epoch && state.state == MeetingState::InCall && state.mic_desired
        };

        if reading != Some(true) {
            // Somebody in the call made this mute, so the poll has already reported it.
            // Undoing it is the agent's own call, through `set_microphone`.
            if has_been_on {
                return;
            }
            let live = match self
                .with_mic_click(provider.set_microphone(&page, true))
                .await
            {
                Ok(live) => live,
                Err(err) => {
                    log_debug!("[Meeting] Unmute retry failed: Error: {}", err);
                    return;
                }
            };
            // The agent asked to be muted while this click was queued behind the lock.
            if !still_wanted() {
                return;
            }
            self.record_mic_reading(live);
            if live != Some(true) {
                return;
            }
        }

        // Both halves, every time.
        let capturing = match &audio {
            Some(audio) => audio.is_mic_captured().await,
            None => false,
        };
        if !capturing {
            return;
        }

        // Re-checked after the capture reading above: that is a real await.
        if !still_wanted() {
            return;
        }

        log_info!(
            "[Meeting] Microphone is live after a mid-call retry — audible in the {} call now",
            provider.display_name()
        );
        let conversation = {
            let mut state = self.state.lock();
            state.mic_confirmed = true;
            state.is_mic_live = Some(true);
            state.conversation.clone()
        };
        if let Some(conversation) = conversation {
            conversation.set_audible(true);
        }
        self.greet_the_room(provider.display_name());
    }

    /// Ask the platform who is speaking, one read at a time.
    ///
    /// An overlap guard for the same reason the participant poll has one — the interval
    /// fires on a wall clock — though here a skipped tick costs nothing.
    async fn check_speaker(&self) {
        let (page, provider, epoch) = {
            let mut state = self.state.lock();
            if state.state != MeetingState::InCall {
                return;
            }
            let (Some(page), Some(provider)) = (state.page.clone(), state.provider) else {
                return;
            };
            if !provider.capabilities().current_speaker || state.speaker_poll_in_flight {
                return;
            }
            state.speaker_poll_in_flight = true;
            (page, provider, state.epoch)
        };

        // A failure is a page that closed under the read; `current_speaker` answers `None`
        // rather than failing otherwise.
        if let Ok(reading) = provider.current_speaker(&page).await {
            let conversation = {
                let mut state = self.state.lock();
                if state.epoch == epoch {
                    if reading.is_some() {
                        state.speaker_seen = true;
                    }
                    state.conversation.clone()
                } else {
                    None
                }
            };
            if let Some(conversation) = conversation {
                conversation.set_current_speaker(reading);
            }
        }
        self.state.lock().speaker_poll_in_flight = false;
    }

    /// Run one participant poll unless one is still running.
    ///
    /// The interval re-fires on a wall clock, not on the previous poll finishing, so two
    /// ticks could be in here at once — harmless for the count, and not harmless at all for
    /// the unmute retry, which clicks a *toggle*. A tick is skipped outright rather than
    /// queued: a delayed reading has no value the next one lacks.
    async fn check_participants(&self) {
        {
            let mut state = self.state.lock();
            if state.state != MeetingState::InCall
                || state.page.is_none()
                || state.provider.is_none()
            {
                return;
            }
            if state.poll_in_flight {
                return;
            }
            state.poll_in_flight = true;
        }
        self.poll_once().await;
        self.state.lock().poll_in_flight = false;
    }

    /// One participant poll: prepare attribution, read the count and the names, warn on
    /// unreadable counts, and leave a room that has stayed empty.
    async fn poll_once(&self) {
        // The microphone first, because it is the more urgent of the two.
        let epoch = self.state.lock().epoch;
        self.check_microphone(epoch).await;

        let current = || {
            let state = self.state.lock();
            if state.state != MeetingState::InCall {
                return None;
            }
            Some((
                state.page.clone()?,
                state.provider?,
                state.chat_panel_busy,
                state.conversation.clone(),
            ))
        };
        let Some((page, provider, chat_busy, _)) = current() else {
            return;
        };

        // Then the participants panel, asked on every poll: a panel is UI state that a
        // re-render or a reconnect can take away. Skipped while the chat panel is busy, since
        // Meet's side rail shows one panel at a time.
        if provider.capabilities().enable_speaker_attribution && !chat_busy {
            provider.enable_speaker_attribution(&page).await;
            if current().is_none() {
                return;
            }
        }
        let Some((page, provider, _, conversation)) = current() else {
            return;
        };

        let count = provider.participant_count(&page).await.ok().flatten();
        if let Some(conversation) = &conversation {
            conversation.set_participant_count(count);
        }

        // Same poll, because the roster changes for the same reason the count does. A
        // failure here must not disturb the count.
        if provider.capabilities().participant_names
            && let Ok(names) = provider.participant_names(&page).await
            && !names.is_empty()
            && let Some(conversation) = &conversation
        {
            conversation.set_participant_names(&names);
        }

        // `None` means "couldn't read it" — never a reason to leave a live call, nor to
        // change how the agent behaves. A persistent `None` is a broken selector, so say so.
        let Some(count) = count else {
            let unreadable = {
                let mut state = self.state.lock();
                state.unreadable_counts += 1;
                state.unreadable_counts
            };
            if unreadable == UNREADABLE_COUNTS_BEFORE_WARNING {
                let mode = conversation
                    .as_ref()
                    .map(|c| c.response_mode().as_str())
                    .unwrap_or("addressed");
                log_warn!(
                    "[Meeting] Can't read the participant count ({} tries) — staying in \"{}\" mode and not checking for an empty room",
                    unreadable,
                    mode
                );
            }
            return;
        };
        self.state.lock().unreadable_counts = 0;

        if count <= 1 {
            let empty = {
                let mut state = self.state.lock();
                state.empty_readings += 1;
                state.empty_readings
            };
            if empty >= EMPTY_READINGS_BEFORE_LEAVING {
                self.finish(
                    TeardownStatus::Completed,
                    Some("Everyone else left the call, so left it too".to_string()),
                )
                .await;
            }
            return;
        }
        self.state.lock().empty_readings = 0;
    }

    /// Mute or unmute on request. Doesn't fail if nothing is running.
    ///
    /// The agent's own control over whether it can be heard. Every outcome is reported, never
    /// an error. Not in a call, no such control on this platform, and a control nobody could
    /// read are all answers the model can act on mid-turn in a live room.
    ///
    /// `mic_desired` is set before the first await, so the poll can tell a mute the agent chose
    /// from one the call imposed even while the click is still going out. A request that does
    /// not take puts it back.
    pub async fn set_microphone(&self, on: bool) -> MeetingActionResult {
        let answer = |success: bool, message: &str| MeetingActionResult {
            success,
            message: message.to_string(),
        };
        let (page, provider, wanted, epoch) = {
            let mut state = self.state.lock();
            match state.state {
                MeetingState::InCall => {}
                MeetingState::Idle => {
                    return answer(
                        false,
                        "You are not in a call, so there is no microphone to turn on or off.",
                    );
                }
                other => {
                    return answer(
                        false,
                        &format!(
                            "You are {} the call, so the microphone is not yours to set yet.",
                            if other == MeetingState::Leaving {
                                "leaving"
                            } else {
                                "still joining"
                            }
                        ),
                    );
                }
            }
            let provider = state.provider;
            let (Some(page), Some(provider)) = (
                state.page.clone(),
                provider.filter(|p| p.capabilities().set_microphone),
            ) else {
                return answer(
                    false,
                    &format!(
                        "I cannot control the microphone on {}.",
                        provider
                            .map(|p| p.display_name())
                            .unwrap_or("this platform")
                    ),
                );
            };
            // Before the await, so a poll that fires during the click already knows this
            // mute was asked for.
            let wanted = state.mic_desired;
            state.mic_desired = on;
            (page, provider, wanted, state.epoch)
        };

        let live = match self
            .with_mic_click(provider.set_microphone(&page, on))
            .await
        {
            Ok(live) => live,
            Err(err) => {
                self.state.lock().mic_desired = wanted;
                log_debug!("[Meeting] Could not set the microphone: Error: {}", err);
                return answer(false, "I could not reach the microphone control.");
            }
        };

        let mut state = self.state.lock();
        if state.epoch != epoch || state.state != MeetingState::InCall {
            state.mic_desired = wanted;
            return answer(false, "The call ended before that took effect.");
        }

        let Some(live) = live else {
            state.mic_desired = wanted;
            state.is_mic_live = None;
            return answer(
                false,
                "I could not read the microphone control back, so I cannot say what state it is in. Check meeting_status before you speak.",
            );
        };

        // A muted toggle settles audibility on its own. An open toggle is half the answer.
        if live {
            state.has_mic_been_on = true;
        }
        state.is_mic_live = Some(live && state.mic_confirmed);
        // Accounted for on the outcome rather than on the request.
        if live == on {
            state.mic_mute_reported = !on;
        }
        if live != on {
            state.mic_desired = wanted;
            return answer(
                false,
                if on {
                    "I clicked unmute and the microphone still reads muted."
                } else {
                    "I clicked mute and the microphone still reads live."
                },
            );
        }

        if on && !state.mic_confirmed {
            // The toggle is open over an audio device nothing has read on this call.
            return answer(
                true,
                "Your microphone is uncovered at the platform, but nothing has yet carried your voice on this call. I keep checking, and I tell you when the room can hear you.",
            );
        }

        answer(
            true,
            if on {
                "Your microphone is on — the participants can hear you."
            } else {
                "Your microphone is off — the participants cannot hear you until you turn it on."
            },
        )
    }

    /// Show the room the agent's screen.
    ///
    /// Only from `in_call`. During a join the page is the lobby, not the meeting. Every
    /// other state answers with what the agent should say instead.
    ///
    /// This touches the browser and takes several seconds, because it clicks through
    /// Meet's controls. The room hears a pause, which the prompt's speak-before-a-tool
    /// rule covers.
    pub async fn start_screen_share(&self) -> MeetingActionResult {
        let outcome = self.drive_screen_share(ShareDirection::Start).await;
        if let ScreenShareOutcome::Failed { reason } = outcome {
            return MeetingActionResult {
                success: false,
                message: reason,
            };
        }

        {
            let mut state = self.state.lock();
            state.sharing_screen = true;
            state.shared_screen = true;
        }
        MeetingActionResult {
            success: true,
            message: if outcome == ScreenShareOutcome::AlreadySharing {
                "I am already sharing my screen.".to_string()
            } else {
                "I am sharing my screen — the room can see it now.".to_string()
            },
        }
    }

    /// Run `work` while holding the microphone click lock, so two clicks never overlap.
    async fn with_mic_click<T, F>(&self, work: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        let _guard = self.mic_click.lock().await;
        work.await
    }

    /// Stop presenting. The call keeps running.
    ///
    /// `not_sharing` is a success: the room sees nothing, which is what was asked for.
    /// Somebody may have stopped the share from the meeting's own controls.
    pub async fn stop_screen_share(&self) -> MeetingActionResult {
        let outcome = self.drive_screen_share(ShareDirection::Stop).await;
        if let ScreenShareOutcome::Failed { reason } = outcome {
            return MeetingActionResult {
                success: false,
                message: reason,
            };
        }

        self.state.lock().sharing_screen = false;
        MeetingActionResult {
            success: true,
            message: if outcome == ScreenShareOutcome::NotSharing {
                "I was not sharing my screen.".to_string()
            } else {
                "I have stopped sharing my screen.".to_string()
            },
        }
    }

    /// Run `work` in its turn on the front-tab queue.
    async fn on_front_queue<T, F>(&self, work: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        let _guard = self.front_queue.lock().await;
        work.await
    }

    /// Start or stop presenting through the provider, on the front-tab queue.
    ///
    /// The part both share tools have in common: the state gate, the provider call and the
    /// telemetry event. One place, so the two directions cannot drift apart.
    async fn drive_screen_share(&self, direction: ShareDirection) -> ScreenShareOutcome {
        let failed = |reason: &str| ScreenShareOutcome::Failed {
            reason: reason.to_string(),
        };
        let (page, provider, browser, user_id) = {
            let state = self.state.lock();
            if state.state == MeetingState::Idle {
                return failed("I am not in a meeting right now.");
            }
            let (true, Some(page), Some(provider)) = (
                state.state == MeetingState::InCall,
                state.page.clone(),
                state.provider,
            ) else {
                return failed(if state.state == MeetingState::Leaving {
                    "I am leaving the call, so there is nothing to share into."
                } else {
                    "I am still getting into the call — ask me again once I am in."
                });
            };
            // Read before the awaits below: a teardown that lands during them clears
            // `current`.
            let user_id = state
                .current
                .as_ref()
                .map(|current| current.user_id.clone())
                .unwrap_or_else(|| "unknown".to_string());
            (page, provider, state.browser.clone(), user_id)
        };

        let capabilities = provider.capabilities();
        let supported = match direction {
            ShareDirection::Start => capabilities.start_screen_share,
            ShareDirection::Stop => capabilities.stop_screen_share,
        };
        if !supported {
            return failed(&format!(
                "I cannot share my screen in a {} call.",
                provider.display_name()
            ));
        }

        let outcome = self
            .on_front_queue(async {
                // The share controls belong to the meeting page, so that page goes in front
                // for the clicks; a capture a background tab asks for is not reliably granted.
                let _ = page.bring_to_front().await;
                let driven = match direction {
                    ShareDirection::Start => provider.start_screen_share(&page).await,
                    ShareDirection::Stop => provider.stop_screen_share(&page).await,
                };
                let outcome = match driven {
                    Ok(outcome) => outcome,
                    Err(err) => {
                        log_error!(
                            json!({ "err": err_json(&err) }),
                            "[Meeting] Screen share {} failed",
                            match direction {
                                ShareDirection::Start => "start",
                                ShareDirection::Stop => "stop",
                            }
                        );
                        failed("Something went wrong using the meeting controls.")
                    }
                };
                // Back to the tab the room is meant to watch. Nothing is opened for this.
                if let Some(browser) = &browser {
                    let _ = browser.raise_active_tab().await;
                }
                outcome
            })
            .await;

        let status = match &outcome {
            ScreenShareOutcome::Sharing => "sharing",
            ScreenShareOutcome::AlreadySharing => "already_sharing",
            ScreenShareOutcome::Stopped => "stopped",
            ScreenShareOutcome::NotSharing => "not_sharing",
            ScreenShareOutcome::Failed { .. } => "failed",
        };
        let mut properties = IndexMap::new();
        properties.insert("provider".to_string(), provider.name().to_string());
        properties.insert("status".to_string(), status.to_string());
        track_event("meeting screen share", Some(&user_id), Some(properties));
        outcome
    }

    /// Show the model what is on the screen right now.
    ///
    /// A picture, not a description. A page reading cannot say that a chart is empty or
    /// that a dialog covers the button.
    ///
    /// A tool result is a string, so the picture cannot travel in it. The picture goes in
    /// as its own conversation item, and the tool answers with the reading.
    ///
    /// That item reaches the meeting's own model and nothing else, so `to_session` says who
    /// is asking. A chat turn during a live call can call this tool too, and it gets the
    /// page in words: sending the picture into the meeting session would show it to the
    /// model that did not ask, while telling the one that did that it is looking at
    /// something it cannot see. The picture's note is `SCREEN_LOOK_NOTE`.
    pub async fn look_at_screen(&self, to_session: bool) -> ScreenLookResult {
        let refuse = |message: &str| ScreenLookResult {
            success: false,
            message: message.to_string(),
            reading: None,
        };
        let (browser, conversation) = {
            let state = self.state.lock();
            if state.state == MeetingState::Idle {
                return refuse("I am not in a meeting right now.");
            }
            let (true, Some(browser)) =
                (state.state == MeetingState::InCall, state.browser.clone())
            else {
                return refuse("I am still getting into the call — ask me again once I am in.");
            };
            (browser, state.conversation.clone())
        };

        let Some(page) = browser.front() else {
            return refuse("There is no browser window open.");
        };

        match capture(&page).await {
            Ok(PageCapture { image_url, reading }) => {
                let shown = to_session
                    && conversation
                        .map(|conversation| conversation.show_image(&image_url, SCREEN_LOOK_NOTE))
                        .unwrap_or(false);
                ScreenLookResult {
                    success: true,
                    message: if shown {
                        "This is what my screen is showing.".to_string()
                    } else {
                        "Here is what the screen says. I cannot show you the picture of it from here."
                            .to_string()
                    },
                    reading: Some(reading),
                }
            }
            Err(err) => {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Meeting] Screen capture failed"
                );
                refuse("I could not get a picture of the screen.")
            }
        }
    }

    /// Use the browser's second tab — the one the meeting is not in.
    ///
    /// Same gate as `start_screen_share`. Before the call is up the only page is the lobby,
    /// and browsing there would leave the meeting on the way in.
    pub async fn browse(&self, command: BrowserCommand) -> BrowserResult {
        let browser = {
            let mut state = self.state.lock();
            if state.state == MeetingState::Idle {
                return BrowserResult::message(false, "I am not in a meeting right now.");
            }
            let (true, Some(browser)) =
                (state.state == MeetingState::InCall, state.browser.clone())
            else {
                return BrowserResult::message(
                    false,
                    if state.state == MeetingState::Leaving {
                        "I am leaving the call, so the browser is being closed."
                    } else {
                        "I am still getting into the call — ask me again once I am in."
                    },
                );
            };
            state.browser_commands += 1;
            browser
        };

        // Queued with the share flow: both move which tab is in front, and the model can
        // call them at the same time.
        self.on_front_queue(async {
            match self.run_browse_command(&browser, &command).await {
                Ok(mut result) => {
                    // Every answer lists the tabs, so the model always knows what it can
                    // switch to and which tab the room is seeing.
                    result.tabs =
                        Some(summarize_tabs(&browser.list_tabs(), browser.front().as_ref()).await);
                    result
                }
                Err(err) => {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "[Meeting] Browser command failed"
                    );
                    BrowserResult::message(false, "I could not reach the browser.")
                }
            }
        })
        .await
    }

    /// Answer the tab commands here and send the rest to the working tab.
    ///
    /// The three tab commands are answered here rather than in `browser_control.rs`,
    /// because the set of tabs belongs to the browser and not to any one page.
    async fn run_browse_command(
        &self,
        browser: &BrowserStack,
        command: &BrowserCommand,
    ) -> anyhow::Result<BrowserResult> {
        match command.action {
            BrowserAction::NewTab => {
                // The address is checked before the tab exists, so a refusal never leaves a
                // blank tab in front of the room.
                if let Some(url) = command.url.as_deref().filter(|url| !url.is_empty())
                    && normalize_url(url).is_none()
                {
                    return Ok(BrowserResult::message(
                        false,
                        format!("\"{url}\" is not a web address I can open."),
                    ));
                }

                let page = browser.open_tab().await?;
                if let Some(url) = command.url.as_deref().filter(|url| !url.is_empty()) {
                    let navigate = BrowserCommand {
                        action: BrowserAction::Navigate,
                        url: Some(url.to_string()),
                        tab: None,
                        target: None,
                        text: None,
                        key: None,
                        amount: None,
                    };
                    return Ok(run_browser_command(&page, &navigate).await);
                }
                Ok(BrowserResult::with_reading(
                    true,
                    "Opened a new tab.",
                    read(&page).await,
                ))
            }

            BrowserAction::SwitchTab => {
                // A tab number that names no tab — 0 included — is refused as the wrong
                // number instead of acting on the tab the agent is already in.
                let page = match command.tab.and_then(tab_index) {
                    Some(index) => browser.select_tab(index).await?,
                    None => None,
                };
                let Some(page) = page else {
                    return Ok(BrowserResult::message(
                        false,
                        format!(
                            "There is no tab {}.",
                            command
                                .tab
                                .map(crate::support::js::number_text)
                                .unwrap_or_else(|| "of that number".to_string())
                        ),
                    ));
                };
                Ok(BrowserResult::with_reading(
                    true,
                    format!(
                        "Switched to tab {}.",
                        command
                            .tab
                            .map(crate::support::js::number_text)
                            .unwrap_or_default()
                    ),
                    read(&page).await,
                ))
            }

            BrowserAction::CloseTab => {
                let tabs = browser.list_tabs();
                let index = match command.tab {
                    None => browser
                        .front()
                        .and_then(|front| tabs.iter().position(|tab| *tab == front)),
                    Some(tab) => tab_index(tab),
                };
                let closed = match index {
                    Some(index) => browser.close_tab(index).await?,
                    None => false,
                };
                if !closed {
                    return Ok(BrowserResult::message(
                        false,
                        "There is no such tab to close.",
                    ));
                }

                let meeting_page = self.state.lock().page.clone();
                match browser.front() {
                    Some(page) if Some(&page) != meeting_page.as_ref() => Ok(
                        BrowserResult::with_reading(true, "Closed the tab.", read(&page).await),
                    ),
                    _ => Ok(BrowserResult::message(
                        true,
                        "Closed the last tab. Nothing is open now.",
                    )),
                }
            }

            _ => Ok(run_browser_command(&browser.workbench().await?, command).await),
        }
    }

    /// Leave on request. Safe when nothing is running.
    pub async fn leave(&self) -> LeaveResult {
        let platform = {
            let state = self.state.lock();
            if state.state == MeetingState::Leaving {
                return LeaveResult {
                    message: "I have left, but I am still releasing the previous call.".to_string(),
                };
            }
            if state.state == MeetingState::Idle {
                return LeaveResult {
                    message: "I am not in a meeting right now.".to_string(),
                };
            }
            state
                .provider
                .map(|p| p.display_name())
                .unwrap_or("meeting")
        };
        self.finish(TeardownStatus::Completed, None).await;
        LeaveResult {
            message: format!("Left the {platform} call."),
        }
    }

    /// Post one short message into the call's own chat.
    ///
    /// One channel out of a call beside speech: it hands over what a spoken sentence mangles
    /// — a link, an id, a command to paste — and nothing else. Reading the chat back is a
    /// separate act, done only when somebody asks; see `read_chat_messages`.
    ///
    /// **In-call only, and nothing is kept.** The message is not a conversation message:
    /// it is never stored, never delivered to a thread, and never reaches a channel
    /// adapter. It exists in the room and in this process, and when the call ends the only
    /// trace is a count and a duration in telemetry. That is why the tool behind it runs in
    /// meeting mode alone — a chat turn would persist its arguments as history.
    ///
    /// The one emitter for `meeting chat sent`, at every outcome including the refusals, so
    /// a send that never reached the page is still visible as something the agent tried.
    pub async fn send_chat_message(&self, text: &str, user_id: &str) -> ChatSendOutcome {
        static WHITESPACE: LazyLock<regex::Regex> =
            LazyLock::new(|| regex::Regex::new(r"\s+").expect("valid regex"));
        let started_at = now_ms();
        // Collapsed before anything measures or sends it: the composer submits on Enter, so
        // a newline in the draft is half a message in the room.
        let message = WHITESPACE
            .replace_all(crate::support::js::trim(text), " ")
            .into_owned();
        let report = self.attempt_chat_send(&message).await;
        let elapsed = now_ms() - started_at;

        // Built by hand rather than from the report: the body must not be one field name
        // away from a telemetry property.
        let mut properties = IndexMap::new();
        properties.insert(
            "provider".to_string(),
            self.state
                .lock()
                .provider
                .map(|p| p.name())
                .unwrap_or("none")
                .to_string(),
        );
        properties.insert("status".to_string(), report.status.as_str().to_string());
        properties.insert("length".to_string(), report.length.to_string());
        properties.insert("duration_ms".to_string(), elapsed.to_string());
        if let Some(step) = report.step {
            properties.insert("fail_step".to_string(), step.as_str().to_string());
        }
        track_event("meeting chat sent", Some(user_id), Some(properties));

        // Every send writes one line, and the message itself is in none of them.
        let step = report
            .step
            .map(|step| format!(" step={}", step.as_str()))
            .unwrap_or_default();
        if report.sent {
            log_debug!(
                "[Meeting:Chat] {} chars={} {}ms{}",
                report.status.as_str(),
                report.length,
                elapsed,
                step
            );
        } else {
            log_warn!(
                "[Meeting:Chat] {} chars={} {}ms{}",
                report.status.as_str(),
                report.length,
                elapsed,
                step
            );
        }

        ChatSendOutcome {
            sent: report.sent,
            message: report.message,
        }
    }

    /// One send, with every refusal and failure named.
    async fn attempt_chat_send(&self, message: &str) -> ChatSendReport {
        let length = len16(message);
        let report =
            |sent: bool, status: ChatSendStatus, step: Option<ChatSendStep>, text: String| {
                ChatSendReport {
                    sent,
                    message: text,
                    status,
                    step,
                    length,
                }
            };

        let (page, provider, epoch) = {
            let mut state = self.state.lock();
            let (true, Some(page), Some(provider)) = (
                state.state == MeetingState::InCall,
                state.page.clone(),
                state.provider,
            ) else {
                // Reachable from an ordinary chat turn and from a scheduled run, so it says
                // what is missing and what fixes it.
                return report(
                    false,
                    ChatSendStatus::NotInCall,
                    None,
                    "I'm not in a call, so there's no meeting chat to post into. Nothing was posted — join a call first.".to_string(),
                );
            };
            if !provider.capabilities().send_chat_message {
                return report(
                    false,
                    ChatSendStatus::Unsupported,
                    None,
                    format!(
                        "I can't post into the chat of a {} call. Say it instead.",
                        provider.display_name()
                    ),
                );
            }
            if length == 0 {
                return report(
                    false,
                    ChatSendStatus::Rejected,
                    None,
                    "There was no message to post.".to_string(),
                );
            }
            if length > MEETING_CHAT_MAX_CHARS {
                return report(
                    false,
                    ChatSendStatus::Rejected,
                    None,
                    format!(
                        "That's {length} characters and I post at most {MEETING_CHAT_MAX_CHARS}. Send the link or the id on its own and say the rest out loud."
                    ),
                );
            }
            if state.chat_panel_busy {
                return report(
                    false,
                    ChatSendStatus::Busy,
                    None,
                    "I'm still posting the previous message. Ask me again in a moment.".to_string(),
                );
            }
            // The epoch is re-checked when the flag comes down: the send can outlive the
            // call it belongs to, and must not clear the next call's flag.
            state.chat_panel_busy = true;
            (page, provider, state.epoch)
        };

        let sent = with_timeout(
            provider.send_chat_message(&page, message),
            CHAT_SEND_TIMEOUT_MS as i64,
        )
        .await;
        {
            let mut state = self.state.lock();
            if state.epoch == epoch {
                state.chat_panel_busy = false;
            }
        }

        match sent {
            Ok(ChatSendResult::Sent) => report(
                true,
                ChatSendStatus::Sent,
                None,
                "Posted it in the call's chat.".to_string(),
            ),
            // The reason is page prose, so it goes to the model and to the log line's
            // `step=`, never to telemetry.
            Ok(ChatSendResult::NotSent { step, reason }) => report(
                false,
                ChatSendStatus::Failed,
                Some(step),
                format!(
                    "I couldn't post that in the call's chat ({reason}). Say it out loud instead — don't try again."
                ),
            ),
            // A page that closed under the send, or the deadline above. No `step`: a failure
            // can land at any of them.
            Err(err) => report(
                false,
                ChatSendStatus::Failed,
                None,
                format!("I couldn't post that in the call's chat: {err}. Say it out loud instead."),
            ),
        }
    }

    /// Read the messages already in the call's own chat, once.
    ///
    /// Nothing polls the panel, nothing remembers what a previous read saw, and the agent
    /// never speaks about a message nobody asked about.
    ///
    /// **In-call only.** The text never reaches a thread, a channel adapter or the
    /// conversation database — it goes to the model that asked and nowhere else. A reading over
    /// the adapter's cap is saved whole to the tool-output store, as any long tool result is,
    /// and the hourly sweep deletes it there; that is the one copy a call leaves behind. Apart
    /// from it the only trace after the call is a count and a duration in telemetry. The tool
    /// runs in meeting mode alone for the same reason: a chat turn persists its tool results as
    /// history, which would file a third party's words into the database for good.
    ///
    /// **Each message is named and fenced.** A line says who the call shows as the sender and
    /// what they typed, and the closing marker is stripped from every message, so nobody can
    /// end the fence early.
    ///
    /// The one emitter for `meeting chat read`, at every outcome including the refusals.
    pub async fn read_chat_messages(&self, user_id: &str) -> ChatReadOutcome {
        let started_at = now_ms();
        let report = self.attempt_chat_read().await;
        let elapsed = now_ms() - started_at;

        let mut properties = IndexMap::new();
        properties.insert(
            "provider".to_string(),
            self.state
                .lock()
                .provider
                .map(|p| p.name())
                .unwrap_or("none")
                .to_string(),
        );
        properties.insert("status".to_string(), report.status.as_str().to_string());
        properties.insert("count".to_string(), report.count.to_string());
        properties.insert("chars".to_string(), report.chars.to_string());
        properties.insert("duration_ms".to_string(), elapsed.to_string());
        if let Some(step) = report.step {
            properties.insert("fail_step".to_string(), step.as_str().to_string());
        }
        track_event("meeting chat read", Some(user_id), Some(properties));

        // One line per read, and no message text in it at any level.
        let step = report
            .step
            .map(|step| format!(" step={}", step.as_str()))
            .unwrap_or_default();
        if report.success {
            log_debug!(
                "[Meeting:ChatRead] {} count={} chars={} {}ms{}",
                report.status.as_str(),
                report.count,
                report.chars,
                elapsed,
                step
            );
        } else {
            log_warn!(
                "[Meeting:ChatRead] {} count={} chars={} {}ms{}",
                report.status.as_str(),
                report.count,
                report.chars,
                elapsed,
                step
            );
        }

        ChatReadOutcome {
            success: report.success,
            message: report.message,
            incomplete: report.incomplete,
        }
    }

    /// One read, with every refusal and failure named.
    async fn attempt_chat_read(&self) -> ChatReadReport {
        let blank =
            |success: bool, status: ChatReadStatus, step: Option<ChatReadStep>, message: String| {
                ChatReadReport {
                    success,
                    message,
                    incomplete: false,
                    status,
                    step,
                    count: 0,
                    chars: 0,
                }
            };

        let (page, provider, epoch) = {
            let mut state = self.state.lock();
            let (true, Some(page), Some(provider)) = (
                state.state == MeetingState::InCall,
                state.page.clone(),
                state.provider,
            ) else {
                return blank(
                    false,
                    ChatReadStatus::NotInCall,
                    None,
                    "I'm not in a call, so there's no meeting chat to read.".to_string(),
                );
            };
            if !provider.capabilities().read_chat_messages {
                return blank(
                    false,
                    ChatReadStatus::Unsupported,
                    None,
                    format!(
                        "I can't read the chat of a {} call. Ask me out loud.",
                        provider.display_name()
                    ),
                );
            }
            if state.chat_panel_busy {
                return blank(
                    false,
                    ChatReadStatus::Busy,
                    None,
                    "I'm still working in the chat panel. Ask me again in a moment.".to_string(),
                );
            }
            state.chat_panel_busy = true;
            (page, provider, state.epoch)
        };

        let read = with_timeout(
            provider.read_chat_messages(
                &page,
                ChatReadOptions {
                    limit: MEETING_CHAT_READ_LIMIT,
                    max_chars_per_message: CHAT_READ_MAX_CHARS_PER_MESSAGE,
                },
            ),
            CHAT_READ_TIMEOUT_MS as i64,
        )
        .await;
        {
            let mut state = self.state.lock();
            if state.epoch == epoch {
                state.chat_panel_busy = false;
            }
        }

        match read {
            // The reason is page prose, so it goes to the model and to the log line's
            // `step=`, never to telemetry. It never says the chat was empty.
            Ok(ChatReadResult::NotRead { step, reason }) => blank(
                false,
                ChatReadStatus::Failed,
                Some(step),
                format!(
                    "I couldn't read the call's chat ({reason}). I don't know whether anyone typed anything — ask me out loud."
                ),
            ),
            Ok(ChatReadResult::Read { messages, .. }) if messages.is_empty() => blank(
                true,
                ChatReadStatus::Empty,
                None,
                "Nobody has typed anything in the call's chat.".to_string(),
            ),
            Ok(ChatReadResult::Read {
                messages,
                truncated,
            }) => fence_chat_messages(&messages, truncated),
            // A page that closed under the read, or the deadline. The error is not quoted:
            // an error from a page carries page text.
            Err(_) => blank(
                false,
                ChatReadStatus::Failed,
                None,
                "I couldn't read the call's chat — the page didn't answer. Ask me out loud."
                    .to_string(),
            ),
        }
    }

    /// End the call on the room emptying or the duration cap.
    ///
    /// `reason` is `None` for a user's own `leave()`, which needs no explanation. The polls
    /// and the duration cap pass one, since an ending nobody asked for is the kind an
    /// engineer reads the log to understand.
    async fn finish(&self, status: TeardownStatus, reason: Option<String>) {
        if !self.is_active() {
            return;
        }
        if let Some(reason) = reason {
            log_info!("[Meeting] {}", reason);
        }
        // Claim the ending before teardown reaches its own await. Closing the session is
        // part of teardown, and the close fires `on_session_lost`.
        self.state.lock().epoch += 1;
        self.teardown(status).await;
    }

    /// The Realtime session closed on its own: the agent has no voice and no ears, so the
    /// call ends.
    ///
    /// Deliberately no reconnect: a fresh session would come back with none of the call's
    /// context. Epoch-guarded like the join flow.
    fn on_session_lost(&'static self, epoch: u64, reason: String) {
        let platform = self
            .state
            .lock()
            .provider
            .map(|p| p.display_name())
            .unwrap_or("meeting");
        self.end_on_loss(
            epoch,
            format!("Lost the Realtime session mid-call, so left the {platform} call: {reason}"),
        );
    }

    /// Capture or playback died: the agent is deaf or mute, so the call ends.
    fn on_audio_lost(&'static self, epoch: u64, reason: String) {
        let (platform, in_call) = {
            let state = self.state.lock();
            (
                state
                    .provider
                    .map(|p| p.display_name())
                    .unwrap_or("meeting"),
                state.state == MeetingState::InCall,
            )
        };
        // A process can die while the call is still in the lobby, where "left the call"
        // would describe a room the agent was never in.
        self.end_on_loss(
            epoch,
            if in_call {
                format!(
                    "Lost the audio pipeline in the {platform} call, so left it rather than sit there unable to hear or speak: {reason}"
                )
            } else {
                format!(
                    "Lost the audio pipeline on the way into the {platform} call, so gave up on joining rather than arrive unable to hear or speak: {reason}"
                )
            },
        );
    }

    /// End the call this epoch belongs to after a loss, telling the log why.
    fn end_on_loss(&'static self, epoch: u64, log_line: String) {
        {
            let state = self.state.lock();
            if state.epoch != epoch || state.state == MeetingState::Idle {
                return;
            }
        }
        log_warn!("[Meeting] {}", log_line);
        tokio::spawn(self.teardown(TeardownStatus::Error));
    }

    /// Release everything a call holds — the conversation, the browser, the audio stack and
    /// the timers — emit `meeting ended`, and return the service to `idle`, or to `leaving`
    /// while an abandoned startup still holds the shared browser profile.
    ///
    /// The single exit path for every ending, so there is one place to be sure nothing is
    /// left running. Never fails: a teardown failure would otherwise mask the reason for
    /// the teardown.
    async fn teardown(&self, status: TeardownStatus) {
        // Re-entrancy guard. Two endings can race, and both would otherwise emit
        // `meeting ended`. First one in owns the ending.
        let (was_active, page, provider, conversation, browser, audio) = {
            let mut state = self.state.lock();
            if state.state == MeetingState::Leaving {
                return;
            }
            let was_active = state.state != MeetingState::Idle;
            state.state = MeetingState::Leaving;
            // Invalidate the in-flight join, if any: from here on its result is stale.
            state.epoch += 1;
            for timer in [
                state.poll_timer.take(),
                state.speaker_timer.take(),
                state.max_duration_timer.take(),
            ]
            .into_iter()
            .flatten()
            {
                timer.abort();
            }
            (
                was_active,
                state.page.clone(),
                state.provider,
                state.conversation.clone(),
                state.browser.clone(),
                state.audio.clone(),
            )
        };

        if let (Some(page), Some(provider)) = (&page, provider)
            && let Err(err) = provider.leave(page).await
        {
            log_debug!("[Meeting] leave() failed: Error: {}", err);
        }

        if let Some(conversation) = &conversation {
            conversation.stop();
        }
        if let Some(browser) = &browser {
            browser.stop().await;
        }
        if let Some(audio) = &audio {
            audio.stop().await;
        }

        let ended = {
            let state = self.state.lock();
            match (was_active, state.started_at, &state.current, state.provider) {
                (true, Some(started_at), Some(current), Some(provider)) => Some((
                    started_at,
                    current.user_id.clone(),
                    provider,
                    state.response_mode,
                    state.fail_step,
                    state.shared_screen,
                    state.browser_commands,
                )),
                _ => None,
            }
        };
        if let Some((started_at, user_id, provider, response_mode, fail_step, shared, commands)) =
            ended
        {
            let stats = conversation.as_ref().map(|c| c.statistics());
            let stat = |pick: fn(&VoiceConversationStats) -> i64| {
                stats.as_ref().map(pick).unwrap_or(0).to_string()
            };
            let mut properties = IndexMap::new();
            properties.insert(
                "inference_provider".to_string(),
                CONFIG
                    .realtime_provider
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
            );
            properties.insert(
                "inference_source".to_string(),
                CONFIG.realtime_source.as_str().to_string(),
            );
            properties.insert("provider".to_string(), provider.name().to_string());
            properties.insert("status".to_string(), status.as_str().to_string());
            properties.insert(
                "response_mode".to_string(),
                response_mode.as_str().to_string(),
            );
            // Which step a failed join got to. A bounded enum, never the prose reason.
            if let Some(step) = fail_step {
                properties.insert("fail_step".to_string(), step.as_str().to_string());
            }
            properties.insert(
                "duration_ms".to_string(),
                (now_ms() - started_at).to_string(),
            );
            properties.insert("screen_shared".to_string(), shared.to_string());
            properties.insert("browser_commands".to_string(), commands.to_string());
            properties.insert("responses".to_string(), stat(|s| s.responses));
            properties.insert("tool_calls".to_string(), stat(|s| s.tool_calls));
            properties.insert("interruptions".to_string(), stat(|s| s.interruptions));
            properties.insert("utterances".to_string(), stat(|s| s.utterances));
            properties.insert("suppressed".to_string(), stat(|s| s.suppressed));
            properties.insert(
                "addressed_matches".to_string(),
                stat(|s| s.addressed_matches),
            );
            properties.insert("mode_switches".to_string(), stat(|s| s.mode_switches));
            properties.insert("gate_calls".to_string(), stat(|s| s.gate_calls));
            properties.insert("gate_failed".to_string(), stat(|s| s.gate_failed));
            properties.insert(
                "gate_latency_ms".to_string(),
                mean_gate_latency_ms(stats.as_ref()).to_string(),
            );
            properties.insert("gate_superseded".to_string(), stat(|s| s.gate_superseded));
            properties.insert("responses_failed".to_string(), stat(|s| s.responses_failed));
            properties.insert(
                "attribution_rate".to_string(),
                attribution_rate(stats.as_ref()).to_string(),
            );
            track_event("meeting ended", Some(&user_id), Some(properties));
        }

        let release = {
            let mut state = self.state.lock();
            state.conversation = None;
            state.agent_voice = None;
            state.browser = None;
            state.audio = None;
            state.page = None;
            state.provider = None;
            state.current = None;
            state.joined_at = None;
            state.started_at = None;
            state.empty_readings = 0;
            state.unreadable_counts = 0;
            state.response_mode = ResponseMode::Auto;
            // Reset to the pessimistic value: the next call has to earn "the room can hear
            // me" the same way this one did.
            state.mic_confirmed = false;
            state.is_mic_live = None;
            state.mic_desired = true;
            state.has_mic_been_on = false;
            state.mic_mute_reported = false;
            state.sharing_screen = false;
            state.shared_screen = false;
            state.browser_commands = 0;
            // A poll still in flight belongs to the call being torn down; its own epoch
            // check stops it acting, but leaving this set would stall the next call's polls.
            state.poll_in_flight = false;
            state.speaker_poll_in_flight = false;
            state.speaker_seen = false;
            state.chat_panel_busy = false;
            state.fail_step = None;
            // Free only when nothing is still being built: an abandoned startup still holds
            // the shared browser profile. It flips this to `idle` itself once it lets go.
            state.state = if state.startup_epoch.is_none() {
                MeetingState::Idle
            } else {
                MeetingState::Leaving
            };
            state.state == MeetingState::Idle
        };
        if release {
            VOICE_SESSION_LOCK.release(VoiceSessionKind::Meeting);
        }
    }

    /// Build the model's session instructions, naming the platform the room is on.
    async fn build_instructions(
        &self,
        input: &JoinMeetingInput,
    ) -> anyhow::Result<VoiceInstructions> {
        let (platform, response_mode) = {
            let state = self.state.lock();
            (
                state
                    .provider
                    .map(|p| p.display_name())
                    .unwrap_or("video call")
                    .to_string(),
                state.response_mode,
            )
        };
        build_voice_instructions(VoiceInstructionsInput {
            user_id: input.user_id.clone(),
            agent_id: input.agent_id.clone(),
            call: VoiceCall::Meeting { platform },
            response_mode,
        })
        .await
    }

    /// Called from the process shutdown path so a container exit leaves the call.
    /// Logs `[Meeting] Shutting down — leaving the active call`.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        if !self.is_active() {
            return Ok(());
        }
        log_info!("[Meeting] Shutting down — leaving the active call");
        self.teardown(TeardownStatus::Completed).await;
        Ok(())
    }
}

/// The stack a startup builds before the call is published onto the state.
#[derive(Default)]
struct Locals {
    audio: Option<Arc<AudioStack>>,
    browser: Option<Arc<BrowserStack>>,
    conversation: Option<Arc<VoiceConversation>>,
}

/// A join answered without a call: `idle` and a sentence.
fn idle_answer(message: String) -> JoinMeetingResult {
    JoinMeetingResult {
        state: MeetingState::Idle,
        step: None,
        message,
    }
}

/// The zero-based index of tab `number` as the model numbers tabs, when it names one.
fn tab_index(number: f64) -> Option<usize> {
    let index = number - 1.0;
    (index >= 0.0 && index.fract() == 0.0).then_some(index as usize)
}

impl TeardownStatus {
    fn as_str(self) -> &'static str {
        match self {
            TeardownStatus::Completed => "completed",
            TeardownStatus::Denied => "denied",
            TeardownStatus::Timeout => "timeout",
            TeardownStatus::Error => "error",
        }
    }
}

pub static MEETING_BOT_SERVICE: LazyLock<MeetingBotService> = LazyLock::new(MeetingBotService::new);
