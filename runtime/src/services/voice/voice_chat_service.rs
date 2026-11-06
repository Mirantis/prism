//! Owns the agent's side of a browser voice chat, start to finish.
//!
//! One session per runtime, and never at the same time as a meeting: both owners take
//! `VOICE_SESSION_LOCK`, because the agent has one voice. The lock is held for exactly as
//! long as this service is not `idle`, so the places that word is written are the places
//! the lock is released.
//!
//! Two surfaces reach it and the session is the same either way. A client on the chat
//! socket sends its audio on the socket it already has. The Computer page has a socket of its own,
//! because it also carries a computer's screen, and asks for that computer here.
//!
//! A call continues the text conversation it was started from: the session opens with
//! the end of that conversation, and when the user hangs up, the model writes a short
//! summary of the call into it. Nothing else is persisted: no transcript and no tool-call
//! row.
//!
//! Signalling is somebody else's job. This service is handed a `VoiceChatSignal` to talk
//! back through, so the socket the client is on stays somebody else's to own.
//!
//! The audio travels on that same socket. There is nothing to negotiate and nothing to
//! reach, so a session is live as soon as it is built — which is why a hosted runtime can
//! carry a call at all: it has no inbound path for media, and a peer connection needed
//! one.

use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::computer::agent_computer::AgentComputer;
use crate::services::computer::computer_access::ComputerUse;
use crate::services::computer::picture_stream::ScreenFrame;
use crate::services::meeting::response_policy::ResponseMode;
use crate::services::meeting::voice_conversation::{StopWithTextRequest, VoiceConversation};
use crate::services::voice::screen_recording::{
    RecordingEndReason, RecordingResult, ScreenRecording, format_offset,
};
use crate::services::voice::socket_audio::{SocketAudio, SocketAudioChannel, VOICE_AUDIO_FORMAT};

/// A recording of the user's own screen, as the Computer page sends it: it began, a
/// picture the page kept with the offset it was taken at, and the end. The pictures arrive
/// together, before the end.
///
/// They come in on the screen's socket, because that is the socket the page has, and they
/// are answered here rather than by the computer: a recording is part of the call the page
/// started, and the desktop outlives any one call.
///
/// The fields are what the page sent, unchecked: `at` and `ms` are read as JavaScript's
/// `Number()` reads them, and `reason` through `end_reason`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RecordingFrame {
    RecordingStarted,
    RecordingFrame {
        #[serde(default)]
        data: Value,
        #[serde(default)]
        at: Value,
    },
    RecordingStopped {
        #[serde(default)]
        ms: Value,
        #[serde(default)]
        reason: Value,
    },
    RecordingCancelled,
}

/// Whether a page frame is one of those, so the socket knows where to send it.
pub fn is_recording_frame(kind: &Value) -> bool {
    kind.as_str()
        .map(|kind| kind.starts_with("recording_"))
        .unwrap_or(false)
}

/// The reason a page states for ending a recording, or `user` for anything else it says.
fn end_reason(reason: &Value) -> RecordingEndReason {
    match reason.as_str() {
        Some("limit") => RecordingEndReason::Limit,
        Some("share_ended") => RecordingEndReason::ShareEnded,
        _ => RecordingEndReason::User,
    }
}

/// What the model is told when a recording starts, so it waits rather than talking over it.
const RECORDING_STARTED_NOTE: &str = concat!(
    "Your user is recording their screen and talking through what they are doing. You will ",
    "be given the whole recording when they stop, so say nothing until then — you cannot ",
    "hear them while it runs."
);

/// And when the page carrying one goes away, so it stops waiting for it.
const RECORDING_LOST_NOTE: &str = concat!(
    "Your user was recording their screen, and the page showing it went away before they ",
    "finished. The recording is gone and you will not be given it. You can hear them again ",
    "now, so carry on with them."
);

/// What the model is told a recording is, before the segments of it arrive.
fn recording_note(result: &RecordingResult) -> String {
    let pictures = if result.frames == 1 {
        "1 picture".to_string()
    } else {
        format!("{} pictures", result.frames)
    };
    format!(
        "Your user recorded their own screen for {} and has just handed it to you. What follows is that recording in order: the pictures are their screen as it changed ({}), and the voice is theirs, recorded while they worked rather than said to you now. Watch it through, then answer them about it in a sentence or two.{}",
        format_offset(result.ms),
        pictures,
        if result.reason == RecordingEndReason::Limit {
            " The recording stopped at its length limit, so it may end in the middle of something."
        } else {
            ""
        }
    )
}

/// What the client is told about the session it asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceChatState {
    Live,
    Ended,
}

impl VoiceChatState {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceChatState::Live => "live",
            VoiceChatState::Ended => "ended",
        }
    }
}

/// Which client asked for the session.
///
/// The two are the same call. This says which one holds the voice, so a second request
/// from the same surface can take it over — a reloaded page is the ordinary case — while
/// a request from the other one is refused and told why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceChatSurface {
    Chat,
    Computer,
}

impl VoiceChatSurface {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceChatSurface::Chat => "chat",
            VoiceChatSurface::Computer => "computer",
        }
    }
}

/// What a live session has, told to the client alongside `live`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceChatLiveInfo {
    /// Whether the runtime owns the screen it is streaming, so the client may take the
    /// pointer and keyboard on it. False on a host with a display of its own, where the
    /// agent's browser is a window among the operator's.
    pub desktop: bool,
}

/// How the service answers the client, and how the agent's audio reaches it.
///
/// `send_audio` and `send_clear` are the audio half; the rest is the session's state.
pub trait VoiceChatSignal: SocketAudioChannel {
    /// The session is up, or it is over.
    fn state(&self, state: VoiceChatState, info: Option<VoiceChatLiveInfo>);
    /// Why the session could not start, or could not continue.
    fn error(&self, message: &str);
}

/// Where the agent's screen and the sound of its desktop go.
///
/// A second transport rather than the voice signal, because the screen is video several
/// times a second and the conversation is not: behind a burst of it a control frame would
/// wait. A client attaches one after its call is live, and detaching stops the capture.
pub trait ComputerClient: Send + Sync {
    /// The agent's screen: how it is encoded, then each picture of it.
    fn screen(&self, frame: ScreenFrame);
    /// What the agent's desktop is playing, pcm16 at the session's rate.
    fn audio(&self, pcm: Bytes);
}

/// This mode determines if the agent will always respond or only if addressed.
///
/// `Open` is a conversation: one person is talking to the agent, so everything the
/// microphone hears is meant for it and every utterance is answered at its turn
/// boundary. `Addressed` is a room: a phone on a table with several people around it,
/// where most of what is said is said to somebody else, so each utterance is put to
/// the addressed gate and only the ones aimed at the agent are answered.
///
/// `auto` is not offered: it resolves from a participant count, and one mixed microphone
/// yields none. The client states which of the two it wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceListeningMode {
    #[default]
    Open,
    Addressed,
}

impl VoiceListeningMode {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceListeningMode::Open => "open",
            VoiceListeningMode::Addressed => "addressed",
        }
    }

    /// The response policy's mode for this listening mode.
    pub fn response_mode(self) -> ResponseMode {
        match self {
            VoiceListeningMode::Open => ResponseMode::Open,
            VoiceListeningMode::Addressed => ResponseMode::Addressed,
        }
    }
}

/// The size of the rectangle a client shows the computer's screen in, in device pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenRect {
    pub width: i64,
    pub height: i64,
}

#[derive(Clone)]
pub struct StartVoiceChatInput {
    pub user_id: String,
    pub agent_id: String,
    /// The thread the call was started from. In single-thread mode the call continues the
    /// one conversation whatever this says.
    pub thread_id: Option<String>,
    /// Defaults to `Open` — a client that says nothing is holding a phone to its ear.
    pub mode: Option<VoiceListeningMode>,
    pub signal: Arc<dyn VoiceChatSignal>,
    /// Which client asked. Defaults to the chat socket, the one that came first.
    pub surface: Option<VoiceChatSurface>,
    /// Open a computer for the agent to work on, and give it the tools that act on it.
    ///
    /// The computer comes up before anything else is built: it is the slow part, and a
    /// client that asked for one and cannot have it should be told before the session costs
    /// anything. Its screen starts streaming as soon as it opens, so the client has a
    /// picture while the model is still connecting.
    pub computer: bool,
    /// What the client speaks, in and out. Defaults to the model's own rate.
    pub sample_rate: Option<u32>,
    /// The size of the rectangle the client shows the computer's screen in, in its own
    /// device pixels, so the screen comes up at the size it will be drawn at.
    ///
    /// A client that says nothing gets a default and may resize later; a client with no
    /// computer has nothing to size.
    pub screen: Option<ScreenRect>,
    /// Said as soon as the session is live. Left out, the agent waits to be spoken to.
    pub greeting: Option<String>,
}

/// How a session ended, as reported in telemetry.
///
/// `Completed` is the client asking, or the runtime shutting down under it. `Disconnected`
/// is the client's socket going away, which its owner tells this service — from here the
/// two are the same act. `Error` is the session dying on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceChatEndStatus {
    #[default]
    Completed,
    Disconnected,
    Error,
}

impl VoiceChatEndStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceChatEndStatus::Completed => "completed",
            VoiceChatEndStatus::Disconnected => "disconnected",
            VoiceChatEndStatus::Error => "error",
        }
    }
}

/// The first line of the message a call's summary is stored as.
pub const VOICE_CALL_SUMMARY_HEADING: &str = "Voice call summary:";

/// How long the session may take to write the summary. The client is told the call ended
/// before this starts, and the voice stays taken until it is over.
const SUMMARY_DEADLINE_MS: u64 = 15_000;

/// Whether a call's summary reached its conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SummaryOutcome {
    Stored,
    Skipped,
    Failed,
}

impl SummaryOutcome {
    fn as_str(self) -> &'static str {
        match self {
            SummaryOutcome::Stored => "stored",
            SummaryOutcome::Skipped => "skipped",
            SummaryOutcome::Failed => "failed",
        }
    }
}

/// The question the session answers with the call's summary.
fn summary_request() -> StopWithTextRequest {
    StopWithTextRequest {
        instructions: crate::prompts::voice_chat_prompt::VOICE_CALL_SUMMARY_INSTRUCTIONS
            .to_string(),
        deadline_ms: SUMMARY_DEADLINE_MS,
        // A few sentences, with room for the reasoning before them.
        max_output_tokens: Some(1_000),
        reasoning_effort: Some("low".to_string()),
    }
}

/// The service's lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceState {
    Idle,
    Starting,
    Live,
    Ending,
}

struct VoiceChatServiceState {
    state: ServiceState,
    /// Bumped by every ending, so a late event belonging to a session that is over cannot
    /// act — and so `stop()` can cancel a start that is still several awaits from done.
    epoch: u64,
    transport: Option<Arc<SocketAudio>>,
    conversation: Option<Arc<VoiceConversation>>,
    computer: Option<Arc<AgentComputer>>,
    computer_use: Option<Arc<ComputerUse>>,
    /// The user's recording of their own screen. Built for a session that has a page.
    recording: Option<Arc<Mutex<ScreenRecording>>>,
    /// Which client's socket the running recording came in on, so its loss is noticed.
    recording_client: Option<String>,
    signal: Option<Arc<dyn VoiceChatSignal>>,
    user_id: Option<String>,
    /// The stored conversation the call continues, which its summary is written to.
    summary_thread_id: Option<String>,
    /// Epoch ms.
    started_at: Option<i64>,
    /// Held for the ending event: the gate numbers below mean nothing without it.
    mode: VoiceListeningMode,
    /// Held for the same reason, and read by a second client deciding whether to take over.
    started_from: VoiceChatSurface,
    /// The rate this session speaks, which the client opens its own audio at.
    rate: u32,
}

pub struct VoiceChatService {
    state: Mutex<VoiceChatServiceState>,
}

impl Default for VoiceChatService {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceChatService {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(VoiceChatServiceState {
                state: ServiceState::Idle,
                epoch: 0,
                transport: None,
                conversation: None,
                computer: None,
                computer_use: None,
                recording: None,
                recording_client: None,
                signal: None,
                user_id: None,
                summary_thread_id: None,
                started_at: None,
                mode: VoiceListeningMode::Open,
                started_from: VoiceChatSurface::Chat,
                rate: VOICE_AUDIO_FORMAT.sample_rate,
            }),
        }
    }

    /// What the client should capture and play at. The default until a session sets it.
    pub fn sample_rate(&self) -> u32 {
        self.state.lock().rate
    }

    /// Whether a session is running, for a caller that wants to know before it offers.
    pub fn is_live(&self) -> bool {
        self.state.lock().state == ServiceState::Live
    }

    /// Open a session for the client that asked for one.
    ///
    /// A refusal is an `error` frame, never an error result — every reason this cannot run is
    /// something the user needs told in words — so the answer comes back as `true` when
    /// this request opened the session, which is what lets signalling tell its own session
    /// from one it was refused.
    ///
    /// The refusals: `I'm in a meeting call right now. That has to end before I can talk
    /// here.`, `I'm still writing up the last voice chat. Try again in a few seconds.` and
    /// `There is already a voice chat running. End that one first.` A failure to start logs
    /// `[VoiceChat] Failed to start the session`, emits `voice chat start failed` with the
    /// stage (`computer` or `session`), and answers
    /// `Could not start the voice chat: {message}`. A live session logs
    /// `[VoiceChat] Session is live` with `tools`, `mode`, `surface` and `computer`, and emits
    /// `voice chat started`.
    pub async fn start(&'static self, input: StartVoiceChatInput) -> bool {
        todo!()
    }

    /// A frame of the client's audio. Dropped when no session is running.
    ///
    /// Dropped rather than refused: a frame in flight when a call ends is ordinary, and
    /// answering it would tell the client something it already knows.
    ///
    /// Judged before the frame is routed, since a recording takes it before the transport
    /// sees it and would resample whatever arrived. A recording of the user's screen takes
    /// the microphone while it runs, so the model hears the narration once — at the end, with
    /// the pictures — rather than answering over the demonstration and then being handed the
    /// same words again.
    pub fn push_audio(&self, pcm: Bytes) {
        todo!()
    }

    /// A recording frame from the page showing the computer.
    ///
    /// `acknowledge` answers on the socket the frame arrived on, and the page opens its
    /// microphone only when that answer lands: the microphone travels on the other socket,
    /// and two sockets have no order between them.
    ///
    /// A start cuts off an answer already in the air — it would play over the
    /// demonstration, and notifying alone would not stop it, since that adds context rather
    /// than ending the turn — then tells the model `RECORDING_STARTED_NOTE`.
    pub fn handle_recording_frame(
        &self,
        client_id: &str,
        frame: RecordingFrame,
        acknowledge: impl FnOnce(),
    ) {
        todo!()
    }

    /// The page a recording was coming from has gone.
    ///
    /// Its pictures and its end were going to arrive on that socket, so there is nothing to
    /// wait for. Left running, the recording would take the microphone for the rest of the
    /// call and the model would hear nothing. Logs
    /// `[VoiceChat] The recording was dropped: its page is gone` and tells the model
    /// `RECORDING_LOST_NOTE`.
    pub fn release_recording_client(&self, client_id: &str) {
        todo!()
    }

    /// Hand a finished recording to the model, or say why there is nothing to hand over.
    ///
    /// An empty one tells the model: `Your user stopped their recording, and there was
    /// nothing in it — no pictures of their screen and nothing said. Tell them so and ask
    /// them to try again.` A recording the model did not take logs
    /// `[VoiceChat] The recording did not reach the model`.
    fn deliver_recording(&self, reason: RecordingEndReason, ms: f64) {
        todo!()
    }

    /// End the session, from the client asking or from its socket closing.
    ///
    /// The status is the caller's to state, since only the caller knows which of the two it
    /// is, and a call the user ended and a call whose connection dropped are read differently
    /// afterwards. `None` is `the client ended the session` and `Completed`.
    pub async fn stop(
        &self,
        reason: Option<&str>,
        status: Option<VoiceChatEndStatus>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// The user finished helping on the computer: tell the model what the help request was,
    /// as `Your user finished helping. The help request was: {reason as JSON}\n\nInspect the
    /// current screen and continue their request.`, and have it speak.
    pub fn continue_computer(&self, reason: &str) {
        todo!()
    }

    /// Called from the process shutdown path so a container exit ends the call.
    ///
    /// No summary: it would hold the exit for as long as the model takes to write it. Logs
    /// `[VoiceChat] Shutting down — ending the live session`.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// The one ending, used by the client's stop, a client that went away, a Realtime session
    /// that died and process shutdown alike.
    ///
    /// Only an ending the user chose leaves a summary: a session that died or a client that
    /// dropped has no open session to ask, or no user who decided the call was over. The
    /// client is told why before it is told it is over, so a failure reads as a failure
    /// rather than as an ending it asked for. Logs `[VoiceChat] Session ended` with `status`
    /// and `reason`, and emits `voice chat ended`. The voice comes back whatever happens on
    /// the way out.
    async fn end(
        &self,
        epoch: u64,
        status: VoiceChatEndStatus,
        reason: &str,
        summarize: Option<bool>,
    ) {
        todo!()
    }

    /// Drop the session's fields. The session itself is released by whoever holds its locals.
    fn clear_published(state: &mut VoiceChatServiceState) {
        state.conversation = None;
        state.transport = None;
        state.computer = None;
        state.computer_use = None;
        state.recording = None;
        state.recording_client = None;
        state.signal = None;
        state.user_id = None;
        state.summary_thread_id = None;
        state.started_at = None;
    }

    /// Free the runtime's voice. The two words are one act — see the file comment.
    fn mark_idle(state: &mut VoiceChatServiceState) {
        state.state = ServiceState::Idle;
        crate::services::voice::voice_session_lock::VOICE_SESSION_LOCK
            .release(crate::services::voice::voice_session_lock::VoiceSessionKind::VoiceChat);
    }
}

/// The conversation a call continues. Single-thread mode has one, whatever the client
/// sent; otherwise it is the thread the client started the call from, or none.
async fn conversation_for(input: &StartVoiceChatInput) -> anyhow::Result<Option<String>> {
    todo!()
}

/// Store the call's summary in the conversation it continues, and show it to web clients.
///
/// Published as `{VOICE_CALL_SUMMARY_HEADING}\n\n{summary}` with trigger `USER_INPUT` on the
/// WebSocket channel of that thread. A summary that did not arrive logs
/// `[VoiceChat] The call summary did not arrive`, `NO_CALL_SUMMARY` stores nothing, and a
/// failure to store logs `[VoiceChat] Could not store the call summary`.
async fn store_summary(text: Option<String>, user_id: &str, thread_id: &str) -> SummaryOutcome {
    todo!()
}

pub static VOICE_CHAT_SERVICE: LazyLock<VoiceChatService> = LazyLock::new(VoiceChatService::new);
