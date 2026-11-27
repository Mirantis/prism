//! The conversation itself: meeting audio in, agent speech out.
//!
//! Wires the five collaborators into one loop and owns nothing else — the browser,
//! the audio devices and the meeting's lifecycle all belong to the service above:
//!
//! ```text
//!     capture → Downsampler → RealtimeSession → Upsampler → AudioPlayback
//!                                        │
//!                                   ResponsePolicy (open room, or gate it?)
//!                                        │
//!                                   AddressedAudioGate (was that said to me?)
//!                                        │
//!                                   BargeInPolicy (yields the floor to humans)
//!                                        │
//!                                   ToolBridge (runs the agent's real tools)
//! ```
//!
//! The two resamplers are there for a transport that speaks 48 kHz, which a browser on a
//! virtual audio device does. A transport that already speaks the model's 24 kHz says so
//! in `sample_rate`, and both become identity.
//!
//! Every response on this session is one asked for here: the server is configured
//! never to answer on its own, so an utterance becomes speech only if this decides
//! it was aimed at the agent.
//!
//! That decision happens in exactly one place — when the turn detector closes an
//! utterance. It is both the earliest moment the audio can be pointed at and the
//! earliest the agent should speak, so there is no verdict to hold back for a later
//! boundary and no second path that could answer the same sentence twice. An earlier
//! design judged a partial transcript as well, to hide a text classifier's latency
//! behind the rest of the sentence, and most of the machinery here existed to
//! reconcile the two verdicts that produced.
//!
//! The one subtlety left is the ordering between a new utterance and a pending pause.
//! When the model starts speaking again while a barge-in pause is still undecided,
//! the stale audio has to be dropped *before* the new audio queues, or the two get
//! spliced into one garbled utterance. Hence `commit_if_pending()` ahead of the
//! enqueue rather than after.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Arc, Weak};

use bytes::Bytes;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::config::CONFIG;
use crate::lib::spend_context::with_spend_context;
use crate::services::computer::agent_computer::ModelChannel;
use crate::services::meeting::addressed_audio_gate::{
    ADDRESSED_DEADLINE_MS, JudgeAddressedInput, judge_addressed,
};
use crate::services::meeting::audio_playback::{AudioPlayback, PlaybackSink, clock_ms};
use crate::services::meeting::barge_in::{BargeInHandlers, BargeInPolicy};
use crate::services::meeting::meeting_provider_interface::SpeakerReading;
use crate::services::meeting::openai_endpoint::RealtimeEndpoint;
use crate::services::meeting::realtime_session::{
    OutOfBandRequest, RealtimeFunctionCall, RealtimeFunctionTool, RealtimeSession,
    RealtimeSessionEvent, RealtimeSessionOptions, RecordingSegment,
};
use crate::services::meeting::realtime_usage::RealtimeSpend;
use crate::services::meeting::resampler::{
    Downsampler, MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE, Upsampler,
};
use crate::services::meeting::response_policy::{
    EffectiveMode, ResponseMode, ResponsePolicy, ResponsePolicyOptions, TurnDecision,
};
use crate::services::meeting::transcript_log::format_transcript;
use crate::services::voice::realtime_tools::PreparedTools;
use crate::support::js::round as js_round;
use crate::{log_debug, log_info, log_warn};

/// How long a speaker reading stays worth believing.
///
/// The poll adds up to a second and a gate verdict about 1.3 more, so a reading is already
/// a couple of seconds old when an utterance's words arrive — that part is expected and
/// fine. What this bounds is the other end: the meters go still when nobody has spoken for
/// a while, and a read then names nobody at all. Holding the last name indefinitely would
/// keep naming somebody who stopped talking a minute ago.
///
/// Six seconds is comfortably past the lag and well short of a conversational pause.
const SPEAKER_FRESHNESS_MS: i64 = 6_000;

/// Most names handed to the transcriber at once.
///
/// These are decoding hints, and a long list is not free: every name biases the
/// recognizer toward hearing it, so a thirty-person roster would make near-misses on
/// *all* of them likelier — including the agent's own name, where a false hit is the
/// failure this feature exists to prevent.
const KEYWORD_LIMIT: usize = 12;

#[derive(Clone)]
pub struct VoiceConversationOptions {
    pub on_response_finished: Option<Arc<dyn Fn() + Send + Sync>>,
    pub instructions: String,
    /// What the session opens knowing, sent once as a user item after the configuration.
    /// An item and not the instructions, because it holds text the agent stored from
    /// whatever it read.
    pub opening_context: Option<String>,
    pub tools: PreparedTools,
    /// Written with pcm16 at `sample_rate` — `pacat`'s stdin in production.
    pub sink: Arc<dyn PlaybackSink>,
    /// The rate the transport speaks, in and out.
    ///
    /// `REALTIME_SAMPLE_RATE` means the transport already speaks the model's own
    /// rate, so both resamplers are skipped and the audio reaches the model as the
    /// client captured it. Only those two values exist: the resampler is a fixed
    /// 2:1 decimation, so anything else would need a converter that is not here,
    /// and silently accepting it would change pitch rather than fail.
    ///
    /// Stated rather than defaulted, for the same reason `AudioPlayback` requires it: a
    /// default is right for one of the two transports and wrong for the other, and getting
    /// it wrong is audible rather than a failure.
    pub sample_rate: u32,
    /// `Auto` follows the participant count; see response_policy.rs.
    pub response_mode: ResponseMode,
    /// The name the agent answers to — the same one the room hears it introduce.
    pub agent_name: String,
    pub model: Option<String>,
    pub voice: Option<String>,
    pub endpoint_override: Option<RealtimeEndpoint>,
    /// Where the session's tokens are spent.
    pub spend: RealtimeSpend,
    /// The session died on its own — the agent has no voice and no ears any more.
    ///
    /// Only fired for a close we did not ask for: `stop()` sets `stopped` before it
    /// closes the socket, so a teardown-initiated close is already distinguishable.
    /// The owner is expected to end the call, because everything that makes the bot a
    /// participant is gone while the browser is still sitting in the room.
    pub on_session_lost: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

/// Counters the service reports as telemetry when the meeting ends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConversationStats {
    pub responses: i64,
    pub tool_calls: i64,
    pub interruptions: i64,
    /// Utterances the room produced, and how they were handled.
    pub utterances: i64,
    pub suppressed: i64,
    pub addressed_matches: i64,
    pub mode_switches: i64,
    /// How the "was I addressed" question went.
    ///
    /// `gate_calls` is how many utterances were put to the model, `gate_failed` how many
    /// of those came back with no verdict at all. The second number is the one that
    /// matters most in production: the gate fails closed, so a failing gate and a
    /// quiet room look identical from outside, and only this distinguishes an agent
    /// that was deaf from one that was simply not spoken to. `gate_latency_ms` is the
    /// total across all calls, so a mean can be taken without this holding a list.
    pub gate_calls: i64,
    pub gate_failed: i64,
    pub gate_latency_ms: i64,
    /// Verdicts thrown away because a newer utterance had closed first.
    ///
    /// The conservative half of a deliberate trade: the agent never answers a turn
    /// nothing judged, at the price of occasionally missing one it was asked. A high
    /// count means the room is busy enough that the price is being paid often.
    pub gate_superseded: i64,
    /// Answers the agent decided to give that the room never heard.
    ///
    /// A response can end without producing audio — a rate limit, a server error. The
    /// gate said yes, the request went out, and the room got silence, which is
    /// indistinguishable from never having been addressed unless it is counted here.
    pub responses_failed: i64,
    /// How many closed utterances had a speaker attached, and how many did not.
    ///
    /// The reason this is measured at all: attribution is read off Meet's participants
    /// panel, so it stops working when Google moves the UI, and it stops working
    /// *silently* — the call carries on, just anonymously. A rate that falls off a cliff
    /// between releases is the only signal that has happened.
    pub attributed_utterances: i64,
    pub unattributed_utterances: i64,
}

/// What `stop_with_text` asks the model: the parts of an out-of-band request a caller sets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StopWithTextRequest {
    pub instructions: String,
    pub deadline_ms: u64,
    pub max_output_tokens: Option<u32>,
    pub reasoning_effort: Option<String>,
}

/// The conversation's own counters and readings, behind one lock.
#[derive(Default)]
struct ConversationState {
    responses: i64,
    tool_calls: i64,
    interruptions: i64,
    gate_calls: i64,
    gate_failed: i64,
    gate_latency_ms: i64,
    gate_superseded: i64,
    responses_failed: i64,
    /// The newest utterance the turn detector has closed.
    ///
    /// A verdict names the utterance it judged, but the response that follows does
    /// not: `request_response()` asks the model to answer the conversation as it now
    /// stands. So a yes for one utterance, arriving after a later one has closed,
    /// would make the agent answer the later one — which nothing judged. Compared
    /// before speaking so that cannot happen.
    newest_item_id: Option<String>,
    attributed_utterances: i64,
    unattributed_utterances: i64,
    /// The last speaker Meet showed, and when it was read (ms).
    ///
    /// Kept rather than replaced on a failed or empty read, and aged out by
    /// `SPEAKER_FRESHNESS_MS` instead — see `set_current_speaker`.
    speaker: Option<(SpeakerReading, i64)>,
    /// Who the answer being spoken is for — see `answering_speaker`.
    answering: Option<SpeakerReading>,
    current_item_id: Option<String>,
    /// When the room last fell silent, and why the agent is about to break it.
    ///
    /// Latency is the whole experience of talking to something in a meeting, and until
    /// now nothing measured the part people actually feel: the gap between finishing a
    /// sentence and hearing a reply start. The gate's own elapsed time is not that
    /// number — a verdict reached while the speaker was still talking costs the room
    /// nothing, and one reached after they stopped costs all of it.
    silence_since: Option<i64>,
    /// When a response was asked for, and what decided it.
    pending_answer: Option<(i64, String)>,
    /// Last keyword list sent, so the poll doesn't resend an unchanged roster.
    keyword_signature: Option<String>,
    /// Everyone else the room currently holds, agent excluded.
    ///
    /// Handed to the gate on every judgement, because "Prism, ask Emma about the
    /// cluster" and "Emma, ask Prism about the cluster" are the same words in a
    /// different order and only one of them is the agent's to answer. Empty until the
    /// first successful roster read, which the gate is told about rather than left to
    /// infer from an empty list.
    ///
    /// Read by `meeting_speaker` too, through `roster`, so the model can answer "who is
    /// in this call?" from the same list the gate is judged against.
    roster_names: Vec<String>,
    stopped: bool,
    /// The declarations the session has; a `load_tools` call replaces them.
    declared_tools: Arc<Vec<RealtimeFunctionTool>>,
    /// Tool calls still running, by a counter, so a finished response can wait for them.
    tool_runs: HashMap<u64, Shared<BoxFuture<'static, ()>>>,
    next_tool_run: u64,
}

pub struct VoiceConversation {
    options: VoiceConversationOptions,
    session: Arc<RealtimeSession>,
    playback: AudioPlayback,
    barge_in: BargeInPolicy,
    response_policy: Mutex<ResponsePolicy>,
    downsampler: Mutex<Downsampler>,
    upsampler: Mutex<Upsampler>,
    /// Identity in both directions when the transport already speaks the model's rate.
    passthrough: bool,
    state: Mutex<ConversationState>,
    this: Weak<VoiceConversation>,
}

impl VoiceConversation {
    /// Build the session, the policy, playback and barge-in, and wire them together.
    ///
    /// Fails with `A voice conversation speaks 48000 or 24000 Hz, not {rate}` for any
    /// other rate. A tool catalog is appended to the instructions after a blank line.
    pub fn new(options: VoiceConversationOptions) -> anyhow::Result<Arc<Self>> {
        let rate = options.sample_rate;
        if rate != MEETING_SAMPLE_RATE && rate != REALTIME_SAMPLE_RATE {
            anyhow::bail!(
                "A voice conversation speaks {} or {} Hz, not {}",
                MEETING_SAMPLE_RATE,
                REALTIME_SAMPLE_RATE,
                rate
            );
        }
        let declared_tools = options.tools.declarations();
        let instructions = match &options.tools.catalog {
            Some(catalog) if !catalog.is_empty() => {
                format!("{}\n\n{}", options.instructions, catalog)
            }
            _ => options.instructions.clone(),
        };
        let session = RealtimeSession::new(RealtimeSessionOptions {
            instructions,
            tools: declared_tools.as_ref().clone(),
            model: options.model.clone(),
            voice: options.voice.clone(),
            agent_name: Some(options.agent_name.clone()),
            endpoint_override: options.endpoint_override.clone(),
            spend: options.spend.clone(),
        });
        let response_policy = ResponsePolicy::new(ResponsePolicyOptions {
            mode: options.response_mode,
        });
        let playback = AudioPlayback::new(options.sink.clone(), rate);

        let conversation = Arc::new_cyclic(|this: &Weak<VoiceConversation>| {
            let barge_in = BargeInPolicy::new(BargeInHandlers {
                pause_playback: {
                    let playback = playback.clone();
                    Arc::new(move || playback.pause())
                },
                resume_playback: {
                    let playback = playback.clone();
                    Arc::new(move || playback.resume())
                },
                is_speaking: {
                    let playback = playback.clone();
                    Arc::new(move || playback.is_speaking())
                },
                commit_interrupt: {
                    let this = this.clone();
                    Arc::new(move || {
                        if let Some(conversation) = this.upgrade() {
                            conversation.commit_interrupt();
                        }
                    })
                },
            });
            VoiceConversation {
                passthrough: rate == REALTIME_SAMPLE_RATE,
                session,
                playback,
                barge_in,
                response_policy: Mutex::new(response_policy),
                downsampler: Mutex::new(Downsampler::new()),
                upsampler: Mutex::new(Upsampler::new()),
                state: Mutex::new(ConversationState {
                    declared_tools,
                    ..ConversationState::default()
                }),
                this: this.clone(),
                options,
            }
        });
        conversation.wire_session();
        Ok(conversation)
    }

    /// Drop what hasn't been heard, then tell the model exactly how far each item
    /// actually got — otherwise its context claims words the room never heard. A turn can
    /// hold several audio items (a native preamble, then the answer), so every one of them
    /// is reported.
    fn commit_interrupt(&self) {
        let items = self.playback.flush();
        self.session.interrupt(&items);
        self.state.lock().interruptions += 1;
        let heard: f64 = items.iter().map(|i| i.played_ms).sum();
        log_info!(
            "[Meeting] Yielded the floor after {}ms of speech across {} item(s)",
            js_round(heard),
            items.len()
        );
    }

    /// Listen to the session: audio into playback, speech events into barge-in, closed
    /// utterances into the policy and the gate, tool calls into the tools, and the
    /// latency and outcome lines into the log.
    fn wire_session(&self) {
        let weak = self.this.clone();
        self.session.on(Arc::new(move |event| {
            if let Some(conversation) = weak.upgrade() {
                conversation.on_session_event(event);
            }
        }));
    }

    fn on_session_event(&self, event: &RealtimeSessionEvent) {
        match event {
            RealtimeSessionEvent::Audio { pcm, item_id } => self.on_audio(pcm, item_id),
            RealtimeSessionEvent::SpeechStarted => self.barge_in.on_speech_started(),
            RealtimeSessionEvent::SpeechStopped => {
                // The room's clock starts here, not at the turn boundary: the detector takes
                // its own time to close an utterance, and the silence is already running.
                self.state.lock().silence_since = Some(clock_ms());
                self.barge_in.on_speech_stopped();
            }
            RealtimeSessionEvent::ResponseDone => {
                let runs: Vec<Shared<BoxFuture<'static, ()>>> = {
                    let mut state = self.state.lock();
                    state.responses += 1;
                    // The measurement belongs to one response. Left set, a response that
                    // ends without ever producing audio — cancelled by a barge-in, killed by
                    // an API error — would hand its marker to whatever spoke next, including
                    // the greeting, which deliberately measures nothing.
                    state.pending_answer = None;
                    state.tool_runs.values().cloned().collect()
                };
                if let Some(finished) = self.options.on_response_finished.clone() {
                    tokio::spawn(async move {
                        futures::future::join_all(runs).await;
                        finished();
                    });
                }
            }
            RealtimeSessionEvent::ResponseFailed { .. } => {
                self.state.lock().responses_failed += 1;
            }
            RealtimeSessionEvent::FunctionCall(call) => self.on_function_call(call),
            // The model never answers on its own, so every utterance passes the policy —
            // and there is exactly one place that happens. The turn detector closing an
            // utterance is both the earliest moment the audio can be pointed at and the
            // earliest the agent should speak, so deciding here needs no transcript, holds
            // nothing back for a later boundary, and cannot produce two verdicts for one
            // sentence.
            RealtimeSessionEvent::UtteranceCommitted { item_id } => {
                self.on_utterance_committed(item_id)
            }
            // Nothing decides anything from these words — the gate hears the audio. What a
            // transcript is still worth is being able to read back what a call actually
            // said next to how it was judged. It lags the decision by however long
            // transcription takes, so it is written as its own line and paired with the
            // verdict by `item=` rather than folded into one.
            RealtimeSessionEvent::Transcript { item_id, text } => {
                let sentence = format_transcript(text);
                if sentence.is_empty() {
                    return;
                }
                log_info!(
                    "[Meeting:Heard] item={} {}",
                    if item_id.is_empty() { "none" } else { item_id },
                    sentence
                );
            }
            RealtimeSessionEvent::ApiError { message } => {
                log_warn!("[Meeting] Realtime API reported: {}", message);
            }
            RealtimeSessionEvent::Closed { reason } => {
                log_info!("[Meeting] Realtime session closed: {}", reason);
                // A close we didn't ask for is the end of the agent's participation: no
                // audio reaches the room and none of the room's audio reaches a model. The
                // browser is still in the call, so without this the bot lingers as a silent
                // tile until the empty-room poll or the duration cap notices.
                if !self.state.lock().stopped
                    && let Some(lost) = &self.options.on_session_lost
                {
                    lost(reason.clone());
                }
            }
        }
    }

    fn on_audio(&self, pcm24k: &Bytes, item_id: &str) {
        // The first audio of a response is the moment the silence actually ends — asking
        // for a response is not the same as the room hearing one, and the model takes its
        // own time to start. Reported separately so the part we control (the decision)
        // stays distinguishable from the part we don't (the model).
        //
        // The reasoning effort is on this line because it is the number effort moves:
        // thinking harder shows up here and nowhere else, so two calls at different levels
        // are only comparable if the level is written down beside the figure.
        let (pending, silence_since, is_new_item) = {
            let mut state = self.state.lock();
            (
                state.pending_answer.take(),
                state.silence_since,
                !item_id.is_empty() && state.current_item_id.as_deref() != Some(item_id),
            )
        };
        if let Some((at, via)) = pending {
            let now = clock_ms();
            let effort = CONFIG
                .openai_realtime_reasoning_effort
                .map(|effort| effort.as_str())
                .unwrap_or("api default");
            log_info!(
                "[Meeting:Latency] voice started {}ms after asking (via {}, effort {}){}",
                now - at,
                via,
                effort,
                silence_since
                    .map(|since| format!(", {}ms of silence in the room", now - since))
                    .unwrap_or_default()
            );
        }

        if is_new_item {
            // A new utterance begins: settle any undecided pause first so stale audio can't
            // be spliced onto the front of the new one.
            self.barge_in.commit_if_pending();
            self.barge_in.on_utterance_started();
            self.state.lock().current_item_id = Some(item_id.to_string());
        }
        self.playback
            .enqueue(Bytes::from(self.from_model(pcm24k)), item_id);
    }

    fn on_function_call(&self, call: &RealtimeFunctionCall) {
        // A response still finishing after the call ended must not act for a user who left.
        let Some(this) = self.this.upgrade() else {
            return;
        };
        let mut state = self.state.lock();
        if state.stopped {
            return;
        }
        state.tool_calls += 1;
        let call = call.clone();
        let run: Shared<BoxFuture<'static, ()>> = async move {
            this.run_tool(call.call_id, call.name, call.arguments_json)
                .await
        }
        .boxed()
        .shared();
        state.next_tool_run += 1;
        let id = state.next_tool_run;
        state.tool_runs.insert(id, run.clone());
        let weak = self.this.clone();
        tokio::spawn(async move {
            run.await;
            if let Some(conversation) = weak.upgrade() {
                conversation.state.lock().tool_runs.remove(&id);
            }
        });
    }

    fn on_utterance_committed(&self, item_id: &str) {
        if self.state.lock().stopped {
            return;
        }
        let decision = self.response_policy.lock().on_utterance_committed(item_id);
        // Only a turn the policy actually accepted moves this. A duplicated commit for an
        // earlier utterance is answered `Ignore`, and letting it set the marker anyway
        // would rewind the guard below — that earlier utterance's late yes would then
        // pass, and the bare response would answer whatever came after it.
        if decision != TurnDecision::Ignore {
            // Against `current_speaker`, so the agent's own voice does not score as a
            // success. A rate that sags while the agent is being talked over is the honest
            // reading: in those moments attribution is not available.
            let attributed = self.current_speaker().is_some();
            let mut state = self.state.lock();
            state.newest_item_id = Some(item_id.to_string());
            if attributed {
                state.attributed_utterances += 1;
            } else {
                state.unattributed_utterances += 1;
            }
        }
        match decision {
            TurnDecision::Respond => self.answer("open-mode"),
            TurnDecision::Gate => {
                if let Some(this) = self.this.upgrade() {
                    let item_id = item_id.to_string();
                    tokio::spawn(async move { this.judge_then_maybe_answer(item_id).await });
                }
            }
            TurnDecision::Ignore => {}
        }
    }

    /// Ask the model whether an utterance was aimed at the agent, then act on it.
    ///
    /// Not awaited by the caller: the room keeps talking while this is in flight, and
    /// a later utterance must be free to be judged before an earlier verdict lands.
    /// Each probe ends its context on the utterance it is judging, so verdicts arriving
    /// out of order still land on the right sentence.
    async fn judge_then_maybe_answer(&self, item_id: String) {
        let asked = clock_ms();
        let roster = {
            let mut state = self.state.lock();
            state.gate_calls += 1;
            state.roster_names.clone()
        };

        let verdict = judge_addressed(
            &*self.session,
            &JudgeAddressedInput {
                agent_name: self.options.agent_name.clone(),
                roster,
                item_id: item_id.clone(),
            },
        )
        .await;

        let newest = {
            let mut state = self.state.lock();
            state.gate_latency_ms += verdict.elapsed_ms;

            // A failure is counted here and nowhere else. It must not reach the policy: a
            // verdict that never happened is not a suppression, and counting it as one
            // would put failures into `suppressed` as well as `gate_failed`.
            if verdict.failed {
                state.gate_failed += 1;
                return;
            }

            // The call ended under the probe. Nothing to answer into.
            if state.stopped {
                return;
            }
            state.newest_item_id.clone()
        };

        // A verdict this late is worse than a missed one: the room has moved on, and
        // answering a question everybody has stopped caring about breaks whatever is
        // being said now. The gate's own deadline should make this unreachable; it is
        // kept because the cost of being wrong here is paid in the room.
        if clock_ms() - asked > ADDRESSED_DEADLINE_MS as i64 {
            log_info!(
                "[Meeting] Dropped a late verdict for item={} — the room has moved on",
                item_id
            );
            return;
        }

        // Somebody else has spoken since. Answering now would answer *their* utterance,
        // because the response carries the conversation as it stands rather than the turn
        // that was judged. Dropped instead, on the same principle as the deadline above:
        // speaking out of turn is the failure this gate exists to prevent, and someone
        // repeating themselves recovers a lost answer.
        if let Some(newest) = newest.filter(|newest| *newest != item_id) {
            self.state.lock().gate_superseded += 1;
            log_info!(
                "[Meeting] Dropped a verdict for item={} — item={} has closed since, and the answer would land on that",
                if item_id.is_empty() { "none" } else { &item_id },
                if newest.is_empty() { "none" } else { &newest }
            );
            return;
        }

        if !self
            .response_policy
            .lock()
            .resolve_verdict(&item_id, verdict.addressed)
        {
            return;
        }
        self.answer("gate");
    }

    /// Ask for a response, and record how long the room waited to get one.
    ///
    /// `via` names what decided it — `open-mode` when a one-to-one call answers at the
    /// turn boundary without asking anything, `gate` when a verdict was fetched. The
    /// two cost the room very differently, and the point of measuring is to tell them
    /// apart: the first is free, the second is a model round trip the room sits through
    /// in silence.
    fn answer(&self, via: &str) {
        let now = clock_ms();
        {
            let mut state = self.state.lock();
            match state.silence_since {
                Some(since) => log_info!(
                    "[Meeting:Latency] answering via {} — room waited {}ms since the speaker stopped",
                    via,
                    now - since
                ),
                None => log_info!("[Meeting:Latency] answering via {}", via),
            }
            state.pending_answer = Some((now, via.to_string()));
        }
        // Pinned for the turn before the request goes out. Asked later, the meters would
        // answer about whoever is talking now — which during a long answer is nobody, and
        // during an interruption is somebody else.
        let answering = self.current_speaker();
        self.state.lock().answering = answering;
        self.session.request_response();
    }

    /// Run one tool call, then hand its output back. Declarations a `load_tools` call
    /// changed are sent first, so the response the output asks for can call what loaded.
    async fn run_tool(&self, call_id: String, name: String, arguments_json: String) {
        // The session's spend context, so the model calls a tool makes (a coding-agent
        // task, a subagent) are spent on this call rather than on no request.
        let output = with_spend_context(
            self.options.spend.context(),
            self.options.tools.execute(&name, &arguments_json),
        )
        .await;
        let changed = {
            let mut state = self.state.lock();
            if state.stopped {
                return;
            }
            // Declared before the result, so the response it asks for can call what loaded.
            let declarations = self.options.tools.declarations();
            if Arc::ptr_eq(&declarations, &state.declared_tools) {
                None
            } else {
                state.declared_tools = declarations.clone();
                Some(declarations)
            }
        };
        if let Some(declarations) = changed {
            self.session.set_tools(declarations.as_ref().clone());
        }
        self.session.send_function_output(&call_id, &output);
    }

    /// Open the Realtime session. Fails if the connection or auth fails. The opening
    /// context, when there is one, is sent as the first item.
    pub async fn start(&self) -> anyhow::Result<()> {
        self.session.connect().await?;
        if let Some(opening) = self.options.opening_context.as_deref()
            && !opening.is_empty()
        {
            self.session.send_context(opening);
        }
        Ok(())
    }

    /// Feed captured audio (pcm16 mono, at the configured rate) to the model.
    pub fn push_audio(&self, pcm: &[u8]) {
        if self.state.lock().stopped || !self.session.is_open() {
            return;
        }
        if self.passthrough {
            self.session.send_audio(pcm);
        } else {
            let converted = self.downsampler.lock().process(pcm);
            self.session.send_audio(&converted);
        }
    }

    /// Model speech on its way to playback: identity, or 24 kHz up to 48 kHz.
    #[allow(clippy::wrong_self_convention)] // TypeScript's `fromModel`.
    fn from_model(&self, pcm24k: &[u8]) -> Vec<u8> {
        if self.passthrough {
            pcm24k.to_vec()
        } else {
            self.upsampler.lock().process(pcm24k)
        }
    }

    /// Tell the model something that happened rather than was said — being admitted
    /// to the call, a participant leaving, the meeting winding down.
    pub fn notify(&self, text: &str) {
        if self.state.lock().stopped {
            return;
        }
        self.session.send_context(text);
    }

    /// Show the model a picture of what the browser is displaying.
    ///
    /// Returns whether it was sent. A closed session takes nothing, and a tool that
    /// reported success would have the agent describe a picture it never saw.
    pub fn show_image(&self, image_url: &str, note: &str) -> bool {
        if self.state.lock().stopped || !self.session.is_open() {
            return false;
        }
        self.session.send_image(image_url, note);
        true
    }

    /// Show the model a recording of the user's own screen, with the narration over it.
    ///
    /// The audio is already at the model's own rate — the recording converts it as it
    /// arrives — so it goes through untouched rather than through the downsampler, whose
    /// filter state belongs to the live microphone.
    ///
    /// Asks for an answer as part of the same act. Nothing else would: the segments are
    /// items rather than speech, so no turn ends and the policy is never consulted, and a
    /// user who has just handed over a recording is waiting to be told about it.
    pub fn show_recording(&self, segments: &[RecordingSegment], note: &str) -> bool {
        if self.state.lock().stopped || !self.session.is_open() {
            return false;
        }
        self.session.send_recording(segments, note);
        self.speak_now();
        true
    }

    /// Cut an answer short because the user took the floor by other means than speaking.
    ///
    /// The same act as a barge-in: drop what has not been heard, tell the client to drop what
    /// it holds, and tell the model how far each item actually got, so its context does not
    /// claim words nobody heard. Asked for here rather than triggered by a voice.
    pub fn stop_speaking(&self) {
        if self.state.lock().stopped || !self.session.is_open() {
            return;
        }
        let items = self.playback.flush();
        self.session.interrupt(&items);
        if items.is_empty() {
            return;
        }
        self.state.lock().interruptions += 1;
        let heard: f64 = items.iter().map(|i| i.played_ms).sum();
        log_info!(
            "[VoiceChat] Cut the answer short after {}ms of speech across {} item(s)",
            js_round(heard),
            items.len()
        );
    }

    /// Ask the model to speak now (used to greet the room on admission).
    pub fn speak_now(&self) {
        if self.state.lock().stopped {
            return;
        }
        self.session.request_response();
    }

    /// Report how many people are in the room, the agent included.
    ///
    /// Drives `auto` mode: one human means everything said is said to the agent,
    /// more than one means it waits to be addressed. `None` (the count couldn't be
    /// read) leaves the current behaviour alone.
    pub fn set_participant_count(&self, count: Option<i64>) {
        if self.state.lock().stopped {
            return;
        }
        self.response_policy.lock().set_participant_count(count);
    }

    /// Report who the meeting platform last showed as speaking.
    ///
    /// `None` means "could not tell", which covers the panel not being open, nobody talking,
    /// two people talking at once, and the read having failed. All of them leave the last
    /// known speaker in place to age out rather than clearing it: a read that failed is not
    /// evidence that the person who was talking has stopped, and a moment of quiet is usually
    /// a pause.
    pub fn set_current_speaker(&self, reading: Option<SpeakerReading>) {
        let mut state = self.state.lock();
        if state.stopped {
            return;
        }
        let Some(reading) = reading else { return };
        state.speaker = Some((reading, clock_ms()));
    }

    /// The human who currently has the floor, or `None`.
    ///
    /// `None` for all three of "nobody has been identified", "the reading is too old to
    /// believe" and "that was the agent's own voice". A caller wanting the agent's own turns
    /// wants `AudioPlayback`, which knows for certain rather than by scrape.
    ///
    /// The whole reading rather than the name, because a name cannot say whether it belongs
    /// to a person or to a room full of them sharing one microphone.
    pub fn current_speaker(&self) -> Option<SpeakerReading> {
        let state = self.state.lock();
        if !Self::has_speaker_reading(&state) {
            return None;
        }
        let reading = state.speaker.as_ref().map(|(reading, _)| reading.clone())?;
        if reading.is_self { None } else { Some(reading) }
    }

    /// Who said the utterance the agent is answering, or `None` when it could not be told.
    ///
    /// Captured when the response is requested and held for the whole turn, which is what
    /// makes it the right answer to "who asked me this?" — the meters have moved on by the
    /// time the agent finishes speaking, and the model may ask at any point in between.
    pub fn answering_speaker(&self) -> Option<SpeakerReading> {
        self.state.lock().answering.clone()
    }

    /// The other people the platform last listed, agent excluded. Empty until the first read.
    pub fn roster(&self) -> Vec<String> {
        self.state.lock().roster_names.clone()
    }

    /// Whether the last reading is recent enough to act on, whoever it named.
    ///
    /// Separate from `current_speaker` because staleness and identity are different
    /// questions, and only this one is about the clock.
    fn has_speaker_reading(state: &ConversationState) -> bool {
        match &state.speaker {
            None => false,
            Some((_, at)) => clock_ms() - at <= SPEAKER_FRESHNESS_MS,
        }
    }

    /// Report whether the room can hear the agent.
    ///
    /// Only the response policy cares: answering everything said in the room is a
    /// reasonable default for a one-to-one call and an expensive way to say nothing when
    /// the microphone is not live. The audio path itself is unaffected — playback still
    /// runs, so the moment the mic does come up the agent is ready to be heard.
    pub fn set_audible(&self, audible: bool) {
        if self.state.lock().stopped {
            return;
        }
        self.response_policy.lock().set_audible(audible);
    }

    /// Tell the transcriber how the room's names are spelled.
    ///
    /// Names are the words a meeting transcript gets wrong most often and the ones this
    /// feature leans on hardest: one call produced "Mees" for Miska, "Mark" for Max, and
    /// a third participant rendered in Japanese characters. The gate's clearest refusals
    /// read "the speaker addresses Isaac" — reasoning that only holds while Isaac
    /// survives transcription.
    ///
    /// The agent's own name always leads and is never displaced by the cap: it is the
    /// one word the gate cannot do without, while a participant's name only sharpens a
    /// judgement that already works without it.
    ///
    /// The other names are those not equal to the agent's name case-insensitively, sorted
    /// by their lowercase forms with `localeCompare`. Meet reorders participant tiles by
    /// who is speaking and virtualizes the grid, so the *same* people arrive from the
    /// scrape in a different order poll after poll; keyed on arrival order, that read as a
    /// roster change every ten seconds. None left is a failed read, not an empty room
    /// (`[Meeting] Participant names came back empty — leaving the roster as it was` at
    /// debug). The keywords are the agent's name then the others, cut to `KEYWORD_LIMIT`,
    /// and nothing happens unless their `\u{0}`-joined signature changed. The roster the
    /// gate reads is the others uncapped. Logs
    /// `[Meeting] Transcriber now expects {n} name(s) in the room` and notifies the model:
    /// `The people in the call with you are now: {names joined by ", "}. The audio is still
    /// one mixed channel, so you cannot hear which of them is speaking — call
    /// \`meeting_speaker\` when you need to know who you are answering or who just spoke.
    /// Never guess at a name.`
    pub fn set_participant_names(&self, names: &[String]) {
        if self.state.lock().stopped {
            return;
        }

        // Sorted before anything else is derived from it. Meet reorders participant tiles
        // by who is speaking and virtualizes the grid, so the *same* people arrive from the
        // scrape in a different order poll after poll.
        let agent = self.options.agent_name.to_lowercase();
        let mut others: Vec<String> = names
            .iter()
            .filter(|name| name.to_lowercase() != agent)
            .cloned()
            .collect();
        others.sort_by(|a, b| locale_compare(&a.to_lowercase(), &b.to_lowercase()));

        // A scrape that found nobody but the agent is a failed read, not an empty room:
        // tiles render late, and the grid drops off-screen participants. Saying "you appear
        // to be alone" on that evidence is a false statement the model may act on.
        if others.is_empty() {
            log_debug!(
                "[Meeting] Participant names came back empty — leaving the roster as it was"
            );
            return;
        }

        let keywords: Vec<String> = std::iter::once(self.options.agent_name.clone())
            .chain(others.iter().cloned())
            .take(KEYWORD_LIMIT)
            .collect();

        // Only on a change. This runs on the participant poll, and re-sending the same list
        // every ten seconds would mutate a live session for no reason.
        let signature = keywords.join("\u{0}");
        {
            let mut state = self.state.lock();
            if state.keyword_signature.as_deref() == Some(signature.as_str()) {
                return;
            }
            state.keyword_signature = Some(signature);
            // The gate is given the names uncapped: the cap exists because every keyword
            // biases the transcriber toward hearing it, and a prompt has no such cost.
            state.roster_names = others.clone();
        }

        self.session.set_transcription_keywords(&keywords);
        log_info!(
            "[Meeting] Transcriber now expects {} name(s) in the room",
            keywords.len()
        );

        // The model is told too, not just the transcriber. It has no other way to know who
        // is present: the room arrives as one mixed audio channel with no speaker labels.
        // Sent as context rather than folded into the system prompt, because the prompt is
        // fixed when the session is created and the roster is not.
        self.notify(&format!(
            "The people in the call with you are now: {}. The audio is still one mixed channel, so you cannot hear which of them is speaking — call `meeting_speaker` when you need to know who you are answering or who just spoke. Never guess at a name.",
            others.join(", ")
        ));
    }

    /// What the policy is doing right now — reported by `meeting_status`.
    pub fn response_mode(&self) -> EffectiveMode {
        self.response_policy.lock().effective_mode()
    }

    pub fn statistics(&self) -> VoiceConversationStats {
        let policy = self.response_policy.lock().statistics();
        let state = self.state.lock();
        VoiceConversationStats {
            responses: state.responses,
            tool_calls: state.tool_calls,
            interruptions: state.interruptions,
            utterances: policy.utterances,
            suppressed: policy.suppressed,
            addressed_matches: policy.addressed_matches,
            mode_switches: policy.mode_switches,
            gate_calls: state.gate_calls,
            gate_failed: state.gate_failed,
            gate_latency_ms: state.gate_latency_ms,
            gate_superseded: state.gate_superseded,
            responses_failed: state.responses_failed,
            attributed_utterances: state.attributed_utterances,
            unattributed_utterances: state.unattributed_utterances,
        }
    }

    /// Tear down the session, playback timer and pending barge-in timer.
    pub fn stop(&self) {
        if self.state.lock().stopped {
            return;
        }
        self.silence();
        self.session.close();
    }

    /// Stop the conversation, ask the model one text question about it, then close.
    ///
    /// The agent is cut off and its tools and answers end before the question is asked, so
    /// the user hears nothing more while the answer is written. Answers `None` when the
    /// session is already stopped or does not answer by the deadline. The question carries
    /// no `input`, so the answer reads the whole call.
    pub async fn stop_with_text(&self, request: StopWithTextRequest) -> Option<String> {
        if self.state.lock().stopped {
            return None;
        }
        self.stop_speaking();
        self.silence();
        // No `input`, so the answer reads the whole call.
        let answer = self
            .session
            .request_out_of_band_text(OutOfBandRequest {
                instructions: request.instructions,
                input: None,
                metadata: None,
                deadline_ms: request.deadline_ms,
                max_output_tokens: request.max_output_tokens,
                reasoning_effort: request.reasoning_effort,
            })
            .await;
        self.session.close();
        answer
    }

    fn silence(&self) {
        self.state.lock().stopped = true;
        self.barge_in.dispose();
        self.playback.dispose();
    }
}

/// The conversation is the channel a computer tool's picture and notes reach the model on.
impl ModelChannel for VoiceConversation {
    fn show_image(&self, image_url: &str, note: &str) -> bool {
        VoiceConversation::show_image(self, image_url, note)
    }

    fn notify(&self, text: &str) {
        VoiceConversation::notify(self, text)
    }
}

/// `localeCompare` in the root locale, close enough for display names: letters compare
/// without their accents first, then as written.
fn locale_compare(a: &str, b: &str) -> Ordering {
    fn base(text: &str) -> String {
        text.nfd()
            .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
            .collect()
    }
    base(a).cmp(&base(b)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests;
