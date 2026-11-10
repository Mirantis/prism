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
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{CONFIG, ThreadMode};
use crate::db::models::{MessageTrigger, ThreadSource};
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::prompts::voice_chat_prompt::{NO_CALL_SUMMARY, VOICE_CALL_SUMMARY_INSTRUCTIONS};
use crate::services::channel_adapter_interface::{ChannelContext, ChannelName};
use crate::services::computer::agent_computer::{AgentComputer, ModelChannel};
use crate::services::computer::computer_access::{ComputerCaller, ComputerUse};
use crate::services::computer::computer_help_service::COMPUTER_HELP_SERVICE;
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::computer::computer_tools::ComputerDesktop;
use crate::services::computer::picture_stream::ScreenFrame;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::meeting::audio_playback::clock_ms;
use crate::services::meeting::gate_stats::mean_gate_latency_ms;
use crate::services::meeting::response_policy::ResponseMode;
use crate::services::meeting::tool_bridge::{MeetingToolBridgeInput, prepare_meeting_tools};
use crate::services::meeting::voice_conversation::{
    StopWithTextRequest, VoiceConversation, VoiceConversationOptions,
};
use crate::services::message_delivery_service::{MESSAGE_DELIVERY_SERVICE, PublishOptions};
use crate::services::voice::realtime_tools::{RealtimeToolsOptions, prepare_realtime_tools};
use crate::services::voice::screen_recording::{
    RecordingEndReason, RecordingResult, ScreenRecording, ScreenRecordingOptions, format_offset,
};
use crate::services::voice::socket_audio::{
    SocketAudio, SocketAudioChannel, SocketAudioEvents, VOICE_AUDIO_FORMAT, is_audio_frame_usable,
    max_frame_bytes,
};
use crate::services::voice::voice_chat_tools::{
    VOICE_CHAT_TRUNCATION_GUIDANCE, prepare_voice_chat_tools,
};
use crate::services::voice::voice_instructions::{
    DesktopSize, VoiceCall, VoiceCallComputer, VoiceInstructionsInput, build_voice_instructions,
};
use crate::services::voice::voice_session_lock::{VOICE_SESSION_LOCK, VoiceSessionKind};
use crate::tools::computer::{VoiceChannel, get_computer_tools};
use crate::{log_error, log_info, log_warn};

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
        if !VOICE_SESSION_LOCK.try_acquire(VoiceSessionKind::VoiceChat) {
            let ending = self.state.lock().state == ServiceState::Ending;
            input.signal.error(
                if VOICE_SESSION_LOCK.holder() == Some(VoiceSessionKind::Meeting) {
                    "I'm in a meeting call right now. That has to end before I can talk here."
                } else if ending {
                    "I'm still writing up the last voice chat. Try again in a few seconds."
                } else {
                    "There is already a voice chat running. End that one first."
                },
            );
            return false;
        }

        // Resolved once and passed to both halves: the prompt tells the model it is being
        // filtered and the policy does the filtering. A call where those two disagree either
        // explains gaps in a conversation that has none, or waits to be named in a room that
        // will not name it.
        let mode = input.mode.unwrap_or_default();
        let surface = input.surface.unwrap_or(VoiceChatSurface::Chat);
        let sample_rate = input.sample_rate.unwrap_or(VOICE_AUDIO_FORMAT.sample_rate);
        let epoch = {
            let mut state = self.state.lock();
            state.state = ServiceState::Starting;
            state.epoch += 1;
            state.rate = sample_rate;
            state.epoch
        };

        // Built into locals and published only once the epoch check says the session is
        // still wanted: a `stop()` during startup has nothing else to release, and a
        // conversation left running would hold a metered Realtime socket open.
        let mut locals = StartLocals::default();
        // Where a failure happened, for the event below. An operator reads this to tell an
        // image that cannot carry a computer from a Realtime session that would not open.
        let mut stage = "session";

        let result = self
            .start_session(
                &input,
                epoch,
                mode,
                surface,
                sample_rate,
                &mut locals,
                &mut stage,
            )
            .await;
        match result {
            Ok(started) => started,
            Err(err) => {
                let message = err.to_string();
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Failed to start the session"
                );
                // Locals unconditionally: they are the same objects the fields hold once
                // published, so this releases the session either way.
                self.release_locals(&locals).await;
                // The voice goes back only if this failure belongs to the session the
                // service still describes — a cancelled start's does not. The fields go with
                // it, or this call's audio keeps arriving at an idle service.
                {
                    let mut state = self.state.lock();
                    if state.epoch == epoch {
                        Self::clear_published(&mut state);
                        Self::mark_idle(&mut state);
                    }
                }
                // A start that failed emits neither `voice chat started` nor `voice chat
                // ended`, so without this a runtime that can never open a computer looks like
                // a runtime nobody called. The stage is the whole of what is reported.
                let mut props = IndexMap::new();
                props.insert("inference_provider".to_string(), inference_provider());
                props.insert(
                    "inference_source".to_string(),
                    CONFIG.realtime_source.as_str().to_string(),
                );
                props.insert("surface".to_string(), surface.as_str().to_string());
                props.insert("computer".to_string(), input.computer.to_string());
                props.insert("stage".to_string(), stage.to_string());
                track_event("voice chat start failed", Some(&input.user_id), Some(props));
                // No `ended` frame: this session never reported `live`, so it has no ending
                // to report. The error below is the whole answer.
                input
                    .signal
                    .error(&format!("Could not start the voice chat: {message}"));
                false
            }
        }
    }

    /// Everything `start` does that can fail: the computer, the instructions, the tools,
    /// the transport and the conversation, then publishing them. Answers whether this
    /// request opened the session.
    #[allow(clippy::too_many_arguments)]
    async fn start_session(
        &'static self,
        input: &StartVoiceChatInput,
        epoch: u64,
        mode: VoiceListeningMode,
        surface: VoiceChatSurface,
        sample_rate: u32,
        locals: &mut StartLocals,
        stage: &mut &'static str,
    ) -> anyhow::Result<bool> {
        // The computer first, where one was asked for. It is the slow part and the one that
        // can fail on the host it runs on, so a client that cannot have it hears why before
        // a Realtime session is opened and billed.
        if input.computer {
            *stage = "computer";
            locals.computer = Some(COMPUTER_SERVICE.open_local().await?);
            locals.computer_use = Some(COMPUTER_SERVICE.create_use(
                ComputerCaller {
                    user_id: input.user_id.clone(),
                    agent_id: input.agent_id.clone(),
                    thread_id: None,
                    mode: "voice".to_string(),
                    origin_channel: None,
                    origin_channel_id: None,
                },
                None,
            ));
            let current = self.state.lock().epoch;
            if current != epoch {
                self.release_locals(locals).await;
                return Ok(false);
            }
            *stage = "session";
        }

        let thread_id = conversation_for(input).await?;
        let summary_thread_id = match &thread_id {
            Some(thread_id)
                if CONVERSATION_SERVICE.get_thread_source(thread_id).await?
                    == Some(ThreadSource::Database) =>
            {
                Some(thread_id.clone())
            }
            _ => None,
        };
        let computer = locals.computer.clone();
        let voice = build_voice_instructions(VoiceInstructionsInput {
            user_id: input.user_id.clone(),
            agent_id: input.agent_id.clone(),
            response_mode: mode.response_mode(),
            call: VoiceCall::VoiceChat {
                thread_id: thread_id.clone(),
                summarized: summary_thread_id.is_some(),
                computer: computer.as_ref().map(|computer| VoiceCallComputer {
                    desktop: computer.has_desktop().then(|| DesktopSize {
                        width: computer.width(),
                        height: computer.height(),
                    }),
                }),
                // Only a client that sends pictures of the user's screen can be asked to
                // share one, and that is the same client that shows the computer.
                user_screen: computer.is_some(),
            },
        })
        .await?;
        // Bind computer tools to this voice session's ownership and image delivery.
        let agent_tools = prepare_meeting_tools(MeetingToolBridgeInput {
            user_id: input.user_id.clone(),
            agent_id: input.agent_id.clone(),
            thread_id: thread_id.clone(),
            locked_in: voice.locked_in,
        })
        .await?;
        let conversation_cell = locals.conversation_cell.clone();
        let voice_channel: VoiceChannel = Arc::new(move || {
            conversation_cell
                .lock()
                .clone()
                .map(|conversation| conversation as Arc<dyn ModelChannel>)
        });
        let computer_tools = computer.as_ref().map(|_| {
            prepare_realtime_tools(
                &get_computer_tools(locals.computer_use.clone(), Some(voice_channel), None),
                RealtimeToolsOptions {
                    label: "Computer".to_string(),
                    truncation_guidance: VOICE_CHAT_TRUNCATION_GUIDANCE.to_string(),
                    ..Default::default()
                },
            )
        });
        let tools = prepare_voice_chat_tools(agent_tools, computer_tools);

        let channel: Arc<dyn SocketAudioChannel> = input.signal.clone();
        let transport = Arc::new(SocketAudio::new(
            channel,
            Arc::new(TransportEvents {
                service: self,
                epoch,
            }),
            Some(sample_rate),
        ));
        locals.transport = Some(transport.clone());

        let computer_use = locals.computer_use.clone();
        let conversation = VoiceConversation::new(VoiceConversationOptions {
            instructions: voice.instructions.clone(),
            opening_context: voice.opening_context.clone(),
            tools: tools.clone(),
            sink: transport.sink.clone(),
            sample_rate,
            response_mode: mode.response_mode(),
            agent_name: voice.agent_name.clone(),
            model: None,
            voice: Some(CONFIG.openai_realtime_voice.clone()),
            endpoint_override: None,
            on_session_lost: Some(Arc::new(move |reason: String| {
                tokio::spawn(async move {
                    self.end(epoch, VoiceChatEndStatus::Error, &reason, None)
                        .await;
                });
            })),
            on_response_finished: Some(Arc::new(move || {
                if let Some(computer_use) = &computer_use {
                    COMPUTER_SERVICE.yield_use(computer_use);
                }
            })),
        })?;
        *locals.conversation_cell.lock() = Some(conversation.clone());
        locals.conversation = Some(conversation.clone());

        conversation.start().await?;

        // Startup is several awaits long, and a `stop()` in any of them ended this session
        // before it began. Release what was built rather than publishing a session nobody is
        // waiting for. The service's own state is not touched here: the `stop()` that
        // cancelled this start has already freed the voice, and a session may be running on
        // it by now.
        let stale = {
            let mut state = self.state.lock();
            let stale = state.epoch != epoch;
            if !stale {
                state.transport = Some(transport.clone());
                state.conversation = Some(conversation.clone());
                state.computer = computer.clone();
                state.computer_use = locals.computer_use.clone();
                // Only a client that shows the computer has a screen to record, and it is the
                // same client that sends the pictures.
                state.recording = computer.as_ref().map(|_| {
                    Arc::new(Mutex::new(ScreenRecording::new(ScreenRecordingOptions {
                        client_sample_rate: sample_rate,
                        user_id: input.user_id.clone(),
                    })))
                });
                state.signal = Some(input.signal.clone());
                state.user_id = Some(input.user_id.clone());
                state.summary_thread_id = summary_thread_id;
                state.started_at = Some(clock_ms());
                state.mode = mode;
                state.started_from = surface;
                state.state = ServiceState::Live;
            }
            stale
        };
        if stale {
            self.release_locals(locals).await;
            return Ok(false);
        }
        if let Some(computer_use) = &locals.computer_use {
            let signal = computer_use.signal.clone();
            tokio::spawn(async move {
                signal.cancelled().await;
                let current = self.state.lock().epoch;
                if current == epoch {
                    self.end(
                        epoch,
                        VoiceChatEndStatus::Completed,
                        "Computer task stopped",
                        None,
                    )
                    .await;
                }
            });
        }

        // Live immediately: the socket that asked is the socket the audio travels on, so
        // there is no media path still to come up and nothing to wait for.
        input.signal.state(
            VoiceChatState::Live,
            Some(VoiceChatLiveInfo {
                desktop: computer.as_ref().is_some_and(|c| c.has_desktop()),
            }),
        );

        if let Some(greeting) = input.greeting.as_deref().filter(|g| !g.is_empty()) {
            conversation.notify(greeting);
            conversation.speak_now();
        }

        log_info!(
            json!({
                "tools": tools.count,
                "mode": mode.as_str(),
                "surface": surface.as_str(),
                "computer": computer.is_some(),
            }),
            "[VoiceChat] Session is live"
        );
        let mut props = IndexMap::new();
        props.insert("inference_provider".to_string(), inference_provider());
        props.insert(
            "inference_source".to_string(),
            CONFIG.realtime_source.as_str().to_string(),
        );
        props.insert("tools".to_string(), tools.count.to_string());
        props.insert("locked_in".to_string(), voice.locked_in.to_string());
        props.insert("response_mode".to_string(), mode.as_str().to_string());
        props.insert("surface".to_string(), surface.as_str().to_string());
        props.insert("computer".to_string(), computer.is_some().to_string());
        track_event("voice chat started", Some(&input.user_id), Some(props));
        Ok(true)
    }

    /// Release what a start built. Each step is guarded: this runs on the way out of a
    /// failure, and a failure here would leave the runtime's voice held with no session on
    /// it for the life of the process.
    async fn release_locals(&self, locals: &StartLocals) {
        if let Some(conversation) = &locals.conversation {
            conversation.stop();
        }
        if let Some(transport) = &locals.transport {
            if let Err(err) = transport.close().await {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] The transport would not close"
                );
            }
        }
        if let Some(computer_use) = &locals.computer_use {
            COMPUTER_HELP_SERVICE.end_voice(computer_use);
            COMPUTER_SERVICE.finish(computer_use);
        }

        // A recording still running has no model left to be handed to, and reporting it as
        // cancelled is what keeps one that never arrived out of the delivered count.
        let recording = self.state.lock().recording.clone();
        if let Some(recording) = recording {
            recording.lock().cancel();
        }
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
        let (rate, recording, transport) = {
            let state = self.state.lock();
            (state.rate, state.recording.clone(), state.transport.clone())
        };
        if !is_audio_frame_usable(&pcm, max_frame_bytes(rate)) {
            return;
        }
        if let Some(recording) = recording {
            if recording.lock().push_audio(&pcm) {
                return;
            }
        }
        if let Some(transport) = transport {
            transport.push(pcm);
        }
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
        let (recording, conversation) = {
            let state = self.state.lock();
            (state.recording.clone(), state.conversation.clone())
        };
        let (Some(recording), Some(conversation)) = (recording, conversation) else {
            return;
        };

        match frame {
            RecordingFrame::RecordingStarted => {
                if !recording.lock().start() {
                    return;
                }
                self.state.lock().recording_client = Some(client_id.to_string());
                acknowledge();
                // An answer already in the air would play over the demonstration, and what
                // this promises is an agent that stays quiet while a recording runs.
                conversation.stop_speaking();
                conversation.notify(RECORDING_STARTED_NOTE);
            }
            RecordingFrame::RecordingFrame { data, at } => {
                if let Some(data) = data.as_str() {
                    recording.lock().add_frame(data, js_number(&at));
                }
            }
            RecordingFrame::RecordingStopped { ms, reason } => {
                self.state.lock().recording_client = None;
                self.deliver_recording(end_reason(&reason), js_number(&ms));
            }
            RecordingFrame::RecordingCancelled => {
                self.state.lock().recording_client = None;
                recording.lock().cancel();
            }
        }
    }

    /// The page a recording was coming from has gone.
    ///
    /// Its pictures and its end were going to arrive on that socket, so there is nothing to
    /// wait for. Left running, the recording would take the microphone for the rest of the
    /// call and the model would hear nothing. Logs
    /// `[VoiceChat] The recording was dropped: its page is gone` and tells the model
    /// `RECORDING_LOST_NOTE`.
    pub fn release_recording_client(&self, client_id: &str) {
        let (recording, conversation) = {
            let mut state = self.state.lock();
            if state.recording_client.as_deref() != Some(client_id) {
                return;
            }
            state.recording_client = None;
            (state.recording.clone(), state.conversation.clone())
        };
        if !recording.is_some_and(|recording| recording.lock().cancel()) {
            return;
        }
        log_info!("[VoiceChat] The recording was dropped: its page is gone");
        if let Some(conversation) = conversation {
            conversation.notify(RECORDING_LOST_NOTE);
        }
    }

    /// Hand a finished recording to the model, or say why there is nothing to hand over.
    ///
    /// An empty one tells the model: `Your user stopped their recording, and there was
    /// nothing in it — no pictures of their screen and nothing said. Tell them so and ask
    /// them to try again.` A recording the model did not take logs
    /// `[VoiceChat] The recording did not reach the model`.
    fn deliver_recording(&self, reason: RecordingEndReason, ms: f64) {
        let (recording, conversation) = {
            let state = self.state.lock();
            (state.recording.clone(), state.conversation.clone())
        };
        let result = recording.and_then(|recording| recording.lock().stop(reason, ms));
        let Some(conversation) = conversation else {
            return;
        };
        let Some(result) = result else {
            conversation.notify(concat!(
                "Your user stopped their recording, and there was nothing in it — no pictures of ",
                "their screen and nothing said. Tell them so and ask them to try again."
            ));
            return;
        };
        if !conversation.show_recording(&result.segments, &recording_note(&result)) {
            log_info!("[VoiceChat] The recording did not reach the model");
        }
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
        let epoch = self.state.lock().epoch;
        self.end(
            epoch,
            status.unwrap_or(VoiceChatEndStatus::Completed),
            reason.unwrap_or("the client ended the session"),
            None,
        )
        .await;
        Ok(())
    }

    /// The user finished helping on the computer: tell the model what the help request was,
    /// as `Your user finished helping. The help request was: {reason as JSON}\n\nInspect the
    /// current screen and continue their request.`, and have it speak.
    pub fn continue_computer(&self, reason: &str) {
        let conversation = {
            let state = self.state.lock();
            if state.computer_use.is_none() {
                return;
            }
            state.conversation.clone()
        };
        let Some(conversation) = conversation else {
            return;
        };
        conversation.notify(&format!(
            "Your user finished helping. The help request was: {}\n\nInspect the current screen and continue their request.",
            serde_json::to_string(reason).unwrap_or_default()
        ));
        conversation.speak_now();
    }

    /// Called from the process shutdown path so a container exit ends the call.
    ///
    /// No summary: it would hold the exit for as long as the model takes to write it. Logs
    /// `[VoiceChat] Shutting down — ending the live session`.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let epoch = {
            let state = self.state.lock();
            if state.state == ServiceState::Idle {
                return Ok(());
            }
            state.epoch
        };
        log_info!("[VoiceChat] Shutting down — ending the live session");
        self.end(
            epoch,
            VoiceChatEndStatus::Completed,
            "the runtime is shutting down",
            Some(false),
        )
        .await;
        Ok(())
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
        let summarize = summarize.unwrap_or(status == VoiceChatEndStatus::Completed);
        // Everything after this belongs to a session that is over: `Ending` and the bumped
        // epoch together stop a teardown-triggered event, and a second `stop()` arriving
        // while the transport closes, from becoming a second ending.
        let ended = {
            let mut state = self.state.lock();
            if epoch != state.epoch
                || state.state == ServiceState::Idle
                || state.state == ServiceState::Ending
            {
                return;
            }
            state.state = ServiceState::Ending;
            state.epoch += 1;
            let ended = EndedSession {
                conversation: state.conversation.clone(),
                transport: state.transport.clone(),
                computer: state.computer.is_some(),
                computer_use: state.computer_use.clone(),
                signal: state.signal.clone(),
                user_id: state.user_id.clone(),
                summary_thread_id: state.summary_thread_id.clone(),
                started_at: state.started_at,
                mode: state.mode,
                started_from: state.started_from,
            };
            Self::clear_published(&mut state);
            ended
        };

        log_info!(
            json!({ "status": status.as_str(), "reason": reason }),
            "[VoiceChat] Session ended"
        );

        self.finish_ending(ended, status, reason, summarize).await;

        // The voice comes back whatever the steps above did. The session is over by the
        // time they run — the state and the epoch say so — and a voice left held would
        // leave no way to start a call until the process restarts.
        Self::mark_idle(&mut self.state.lock());
    }

    /// The steps of an ending after the service has let go of the session: the summary, the
    /// transport, the computer, the client, and the event.
    async fn finish_ending(
        &self,
        ended: EndedSession,
        status: VoiceChatEndStatus,
        reason: &str,
        summarize: bool,
    ) {
        let stats = ended
            .conversation
            .as_ref()
            .map(|conversation| conversation.statistics());
        // Only an ending the user chose leaves a summary: a session that died or a client
        // that dropped has no open session to ask, or no user who decided the call was over.
        let summary = match (
            summarize,
            &ended.conversation,
            &ended.user_id,
            &ended.summary_thread_id,
        ) {
            (true, Some(conversation), Some(user_id), Some(thread_id))
                if stats.map(|s| s.utterances).unwrap_or(0) > 0 =>
            {
                // Started at once: the transport and the computer close before it is awaited.
                let conversation = conversation.clone();
                let text =
                    tokio::spawn(
                        async move { conversation.stop_with_text(summary_request()).await },
                    );
                Some((text, user_id.clone(), thread_id.clone()))
            }
            _ => None,
        };
        if summary.is_none() {
            if let Some(conversation) = &ended.conversation {
                conversation.stop();
            }
        }
        if let Some(transport) = &ended.transport {
            if let Err(err) = transport.close().await {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] The transport would not close"
                );
            }
        }
        // The browser, the desktop and the virtual display go with the call. They are
        // processes, so a session that left them behind would cost the host a whole desktop
        // for every call it ever carried.
        if let Some(computer_use) = &ended.computer_use {
            COMPUTER_HELP_SERVICE.end_voice(computer_use);
            COMPUTER_SERVICE.finish(computer_use);
        }

        // A recording still running has no model left to be handed to, and reporting it as
        // cancelled is what keeps one that never arrived out of the delivered count.
        let recording = self.state.lock().recording.clone();
        if let Some(recording) = recording {
            recording.lock().cancel();
        }

        // The client is told why before it is told it is over, so a failure reads as a
        // failure rather than as an ending it asked for.
        if let Some(signal) = &ended.signal {
            if status != VoiceChatEndStatus::Completed {
                signal.error(reason);
            }
            signal.state(VoiceChatState::Ended, None);
        }

        let summary_outcome = match summary {
            Some((text, user_id, thread_id)) => {
                let text = match text.await {
                    Ok(text) => text,
                    Err(err) => {
                        let err = anyhow::Error::new(err);
                        log_warn!(
                            json!({ "err": err_json(&err) }),
                            "[VoiceChat] The call summary request failed"
                        );
                        None
                    }
                };
                store_summary(text, &user_id, &thread_id).await
            }
            None => SummaryOutcome::Skipped,
        };

        let (Some(user_id), Some(started_at)) = (&ended.user_id, ended.started_at) else {
            return;
        };
        let stats = stats.unwrap_or_default();
        let mut props = IndexMap::new();
        let mut put = |key: &str, value: String| {
            props.insert(key.to_string(), value);
        };
        put("inference_provider", inference_provider());
        put(
            "inference_source",
            CONFIG.realtime_source.as_str().to_string(),
        );
        put("status", status.as_str().to_string());
        put("surface", ended.started_from.as_str().to_string());
        put("computer", ended.computer.to_string());
        put("response_mode", ended.mode.as_str().to_string());
        put("duration_ms", (clock_ms() - started_at).to_string());
        put("responses", stats.responses.to_string());
        put("tool_calls", stats.tool_calls.to_string());
        put("interruptions", stats.interruptions.to_string());
        put("utterances", stats.utterances.to_string());
        // Answers the agent gave that produced no audio — silence the user cannot account
        // for, and the one number that says the call was not what it looked like.
        put("responses_failed", stats.responses_failed.to_string());
        // Zero throughout an `open` call, which is the point of reporting `mode` beside
        // them. In `addressed` they are how a quiet call is read: `suppressed` is the gate
        // doing its job, while `gate_failed` is the agent having been deaf.
        put("suppressed", stats.suppressed.to_string());
        put("gate_calls", stats.gate_calls.to_string());
        put("gate_failed", stats.gate_failed.to_string());
        // The mean, which is what `meeting ended` emits under this key.
        put(
            "gate_latency_ms",
            mean_gate_latency_ms(Some(&stats)).to_string(),
        );
        put("summary", summary_outcome.as_str().to_string());
        track_event("voice chat ended", Some(user_id), Some(props));
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
    if let Some(thread_id) = input.thread_id.as_deref().filter(|t| !t.is_empty()) {
        return Ok(Some(
            CONVERSATION_SERVICE.writable_thread_id(thread_id).await?,
        ));
    }
    if CONFIG.thread_mode != ThreadMode::Single {
        return Ok(None);
    }
    Ok(CONVERSATION_SERVICE
        .find_latest_web_thread(&input.agent_id, &input.user_id)
        .await?
        .map(|thread| thread.id))
}

/// What a start has built so far, released together when it fails or is cancelled.
#[derive(Default)]
struct StartLocals {
    transport: Option<Arc<SocketAudio>>,
    conversation: Option<Arc<VoiceConversation>>,
    /// The conversation the computer tools show their pictures to, once it exists.
    conversation_cell: Arc<Mutex<Option<Arc<VoiceConversation>>>>,
    computer: Option<Arc<AgentComputer>>,
    computer_use: Option<Arc<ComputerUse>>,
}

/// What an ending took from the service, to finish without holding its state.
struct EndedSession {
    conversation: Option<Arc<VoiceConversation>>,
    transport: Option<Arc<SocketAudio>>,
    computer: bool,
    computer_use: Option<Arc<ComputerUse>>,
    signal: Option<Arc<dyn VoiceChatSignal>>,
    user_id: Option<String>,
    summary_thread_id: Option<String>,
    started_at: Option<i64>,
    mode: VoiceListeningMode,
    started_from: VoiceChatSurface,
}

/// The client's audio, routed to the conversation of the session it belongs to.
struct TransportEvents {
    service: &'static VoiceChatService,
    epoch: u64,
}

impl SocketAudioEvents for TransportEvents {
    fn on_audio(&self, pcm: Bytes) {
        let conversation = {
            let state = self.service.state.lock();
            if state.epoch != self.epoch {
                return;
            }
            state.conversation.clone()
        };
        if let Some(conversation) = conversation {
            conversation.push_audio(&pcm);
        }
    }
}

/// The provider that serves the Realtime session, as telemetry names it.
fn inference_provider() -> String {
    CONFIG
        .realtime_provider
        .clone()
        .unwrap_or_else(|| "unknown".to_string())
}

/// `Number(value)` for a field a page sent. A missing field is `undefined`, which is NaN.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => crate::support::js::number_from(text).unwrap_or(f64::NAN),
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        _ => f64::NAN,
    }
}

/// Store the call's summary in the conversation it continues, and show it to web clients.
///
/// Published as `{VOICE_CALL_SUMMARY_HEADING}\n\n{summary}` with trigger `USER_INPUT` on the
/// WebSocket channel of that thread. A summary that did not arrive logs
/// `[VoiceChat] The call summary did not arrive`, `NO_CALL_SUMMARY` stores nothing, and a
/// failure to store logs `[VoiceChat] Could not store the call summary`.
async fn store_summary(text: Option<String>, user_id: &str, thread_id: &str) -> SummaryOutcome {
    let summary = text
        .as_deref()
        .map(crate::support::js::trim)
        .filter(|summary| !summary.is_empty());
    let Some(summary) = summary else {
        log_warn!("[VoiceChat] The call summary did not arrive");
        return SummaryOutcome::Failed;
    };
    if summary == NO_CALL_SUMMARY {
        return SummaryOutcome::Skipped;
    }
    let published = MESSAGE_DELIVERY_SERVICE
        .publish(
            user_id,
            thread_id,
            &format!("{VOICE_CALL_SUMMARY_HEADING}\n\n{summary}"),
            MessageTrigger::UserInput,
            PublishOptions {
                channel_context: Some(ChannelContext {
                    channel: ChannelName::Websocket,
                    channel_id: None,
                    channel_thread_id: None,
                    thread_id: thread_id.to_string(),
                    include_feedback: None,
                }),
                ..Default::default()
            },
        )
        .await;
    match published {
        Ok(_) => SummaryOutcome::Stored,
        Err(err) => {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[VoiceChat] Could not store the call summary"
            );
            SummaryOutcome::Failed
        }
    }
}

pub static VOICE_CHAT_SERVICE: LazyLock<VoiceChatService> = LazyLock::new(VoiceChatService::new);
