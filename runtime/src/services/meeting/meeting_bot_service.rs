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

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::task::AbortHandle;

use crate::services::meeting::audio_stack::AudioStack;
use crate::services::meeting::browser_control::{BrowserCommand, BrowserReading, BrowserResult};
use crate::services::meeting::browser_stack::{BrowserStack, PageHandle};
use crate::services::meeting::meeting_provider_interface::{
    ChatMessageRead, ChatReadStep, ChatSendStep, JoinStep, MeetingProvider, ScreenShareOutcome,
    SpeakerDetails,
};
use crate::services::meeting::providers::google_meet::GOOGLE_MEET_PROVIDER;
use crate::services::meeting::response_policy::{EffectiveMode, ResponseMode};
use crate::services::meeting::voice_conversation::{VoiceConversation, VoiceConversationStats};
use crate::services::voice::realtime_tools::MAX_TOOL_RESULT_CHARS;
use crate::services::voice::voice_instructions::VoiceInstructions;
use crate::support::js::len16;

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

/// `Math.round`: the nearest integer, halves toward positive infinity.
fn js_round(value: f64) -> i64 {
    let floor = value.floor();
    (if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }) as i64
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
    js_round((attributed as f64 / total as f64) * 100.0)
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
        todo!()
    }

    /// Mark this startup as finished building, and free the service if it was waiting.
    ///
    /// Only the startup that is still the current one clears the marker: a newer
    /// `join()` owns it from the moment it sets its own. A service held in `leaving` by
    /// `teardown()` becomes `idle` here and releases the voice lock, since the shared
    /// browser profile was not free until this startup let go of it.
    fn release_startup_slot(&self, epoch: u64) {
        todo!()
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
        todo!()
    }

    /// Start the participant poll, the speaker poll and the duration cap.
    fn start_watchdogs(&'static self) {
        todo!()
    }

    /// Read the participant count a few times right after admission, since Meet admits the
    /// agent before it renders the other tiles and the first read is a reliable 1.
    async fn seed_participant_count(&self, epoch: u64) {
        todo!()
    }

    /// Have the agent greet the room it was just admitted to.
    fn greet_the_room(&self, display_name: &str) {
        todo!()
    }

    /// Read the microphone on the participant poll, report a change, and work at getting
    /// an inaudible call audible.
    async fn check_microphone(&self, epoch: u64) {
        todo!()
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
        todo!()
    }

    /// Click the microphone on, and confirm the capture device opened.
    async fn make_audible(&self, epoch: u64, reading: Option<bool>) {
        todo!()
    }

    /// Ask the platform who is speaking, one read at a time.
    async fn check_speaker(&self) {
        todo!()
    }

    /// Run one participant poll unless one is still running.
    async fn check_participants(&self) {
        todo!()
    }

    /// One participant poll: prepare attribution, read the count and the names, warn on
    /// unreadable counts, and leave a room that has stayed empty.
    async fn poll_once(&self) {
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
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
    async fn drive_screen_share(&self, direction: ShareDirection) -> ScreenShareOutcome {
        todo!()
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
        todo!()
    }

    /// Use the browser's second tab — the one the meeting is not in.
    ///
    /// Same gate as `start_screen_share`. Before the call is up the only page is the lobby,
    /// and browsing there would leave the meeting on the way in.
    pub async fn browse(&self, command: BrowserCommand) -> BrowserResult {
        todo!()
    }

    /// Answer the tab commands here and send the rest to the working tab.
    async fn run_browse_command(
        &self,
        browser: &BrowserStack,
        command: &BrowserCommand,
    ) -> BrowserResult {
        todo!()
    }

    /// Leave on request. Safe when nothing is running.
    pub async fn leave(&self) -> LeaveResult {
        todo!()
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
        todo!()
    }

    /// One send, with every refusal and failure named.
    async fn attempt_chat_send(&self, message: &str) -> ChatSendReport {
        todo!()
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
        todo!()
    }

    /// One read, with every refusal and failure named.
    async fn attempt_chat_read(&self) -> ChatReadReport {
        todo!()
    }

    /// End the call on the room emptying or the duration cap.
    async fn finish(&self, status: TeardownStatus, reason: Option<String>) {
        todo!()
    }

    /// The Realtime session closed on its own: the agent has no voice and no ears, so the
    /// call ends.
    fn on_session_lost(&'static self, epoch: u64, reason: String) {
        todo!()
    }

    /// Capture or playback died: the agent is deaf or mute, so the call ends.
    fn on_audio_lost(&'static self, epoch: u64, reason: String) {
        todo!()
    }

    /// End the call this epoch belongs to after a loss, telling the log why.
    fn end_on_loss(&'static self, epoch: u64, log_line: String) {
        todo!()
    }

    /// Release everything a call holds — the conversation, the browser, the audio stack and
    /// the timers — emit `meeting ended`, and return the service to `idle`, or to `leaving`
    /// while an abandoned startup still holds the shared browser profile.
    async fn teardown(&self, status: TeardownStatus) {
        todo!()
    }

    /// Build the model's session instructions, naming the platform the room is on.
    async fn build_instructions(
        &self,
        input: &JoinMeetingInput,
    ) -> anyhow::Result<VoiceInstructions> {
        todo!()
    }

    /// Called from the process shutdown path so a container exit leaves the call.
    /// Logs `[Meeting] Shutting down — leaving the active call`.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        todo!()
    }
}

pub static MEETING_BOT_SERVICE: LazyLock<MeetingBotService> = LazyLock::new(MeetingBotService::new);
