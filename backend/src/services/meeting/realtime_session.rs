//! The OpenAI Realtime API session — the agent's voice and ears in a meeting.
//!
//! This is a speech-to-speech session: meeting audio goes in as pcm16 and the
//! model's speech comes back as pcm16. There is deliberately no transcript in the
//! conversation path — nothing decides anything from words. Transcription exists
//! only so a call can be read back in the log, so it is requested only when
//! `MEETING_TRANSCRIPT_LOGGING` says the words will actually be written: it bills
//! per audio minute whether or not anybody reads them.
//!
//! The model carries the agent's real system prompt as session `instructions` and
//! the agent's real tools as Realtime function tools, so the participant in the
//! call *is* the agent itself rather than a separate voice persona relaying to it.
//!
//! Wire protocol notes that shaped this file:
//! - WebSocket is the right transport for a server-side media pipeline (WebRTC is
//!   for browsers that capture audio themselves; SIP is for telephony).
//! - Audio is base64 pcm16 mono at 24 kHz in both directions.
//! - `interrupt_response` is left OFF: the server would kill the response on any
//!   detected speech, including a cough or an "mm-hm". Interruption is decided
//!   locally instead (see barge_in.rs) so backchannels don't cut the bot off.
//! - `create_response` is left OFF too, always. The server would answer every
//!   utterance in the room, and the room is a single mixed channel — so whether an
//!   utterance was aimed at the agent is a question only the client can ask (see
//!   `response_policy.rs`). Every response on this session is one we asked for.
//! - Truncation is the client's job on this transport. The server has no idea how
//!   much of its audio actually reached the room, so after an interruption we tell
//!   it via `conversation.item.truncate` — otherwise the model's context claims it
//!   said things nobody heard, and later turns get incoherent.
//! - The same session answers *two* kinds of question. Alongside the conversation it
//!   takes out-of-band probes (`request_out_of_band_text`) — a short text question about
//!   an utterance it has already heard, which is how "was that said to me?" is
//!   decided. Those responses never enter the conversation, and the bookkeeping that
//!   keeps them apart from the agent's own turns is the delicate part of this file.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Weak};
use std::time::Duration;

use base64::Engine;
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::config::CONFIG;
use crate::lib::inference_gate::INFERENCE_GATE;
use crate::lib::log_redaction::err_json;
use crate::services::meeting::audio_playback::{PlaybackSnapshot, clock_ms};
use crate::services::meeting::openai_endpoint::{
    RealtimeEndpoint, build_realtime_socket_options, connect_realtime_socket, handshake_status,
    resolve_realtime_endpoint, url_host,
};
use crate::services::meeting::realtime_usage::{RealtimeSpend, record_realtime_usage};
use crate::services::meeting::resampler::REALTIME_SAMPLE_RATE;
use crate::services::meeting::transcript_log;
use crate::{log_debug, log_error, log_info, log_warn};

/// How long to wait for `response.created` after asking for a response.
///
/// Only a safety net for the optimistic active-response flag; see
/// `response_created_watchdog`.
const RESPONSE_CREATED_TIMEOUT_MS: u64 = 5_000;

/// Slack added to the played duration before truncating, per OpenAI's own
/// server-side transport (`TwilioRealtimeTransport`).
///
/// Truncating at exactly what was measured as heard makes the model repeat the last
/// word or two after an interruption: its context ends a fraction before the sound
/// the listener actually registered, so it resumes from there. Nudging the cut point
/// slightly *later* — always bounded by what was really sent to the device — trades a
/// few milliseconds the room may not have heard for speech that doesn't stutter.
const TRUNCATE_SLACK_MS: f64 = 50.0;

/// How long a close we asked for may wait for the server's answer before the socket is
/// dropped anyway.
const CLOSE_TIMEOUT_MS: u64 = 30_000;

/// A function tool offered to the model, already in JSON Schema form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RealtimeFunctionTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// The metadata key that marks a response as ours-and-out-of-band.
///
/// Set by this type rather than by the caller, so recognising a probe on the way
/// back never depends on a convention a caller might get wrong. Its value is the
/// client `event_id` of the `response.create` that opened it, which is what ties a
/// verdict — or a rejection — back to the request that asked for it.
const OUT_OF_BAND_MARKER: &str = "prism_oob";

/// A question asked of the model *beside* the conversation rather than in it.
///
/// `conversation: "none"` keeps the answer out of the session's conversation
/// state, so asking does not become part of what the agent has said. The reply is
/// text, and short: this exists for one-word judgements, not for speech.
#[derive(Debug, Clone, Default)]
pub struct OutOfBandRequest {
    /// Replaces the session prompt for this one response.
    pub instructions: String,
    /// The context for this response, in place of the conversation.
    ///
    /// An `{ type: 'item_reference', id }` entry points at an item the session already
    /// holds, so referencing an utterance re-sends no audio — but the tokens are still
    /// processed and still counted against the rate limit, so a reference saves
    /// bandwidth rather than cost.
    ///
    /// **Pass it.** Omitting it inherits the entire conversation, which grows for the
    /// length of the call: measured at 21,382 tokens on a live call against a 40,000
    /// tokens-per-minute limit, which is under two responses a minute. It is also
    /// ambiguous about *which* utterance is being judged, since the model can only be
    /// told "the most recent one" and two turns can close while one verdict is in
    /// flight. A bounded list ending on the item in question fixes both.
    pub input: Option<Vec<Value>>,
    /// Merged into the frame's metadata; the marker key is added on top.
    pub metadata: Option<IndexMap<String, String>>,
    /// After this, stop waiting and answer `None`.
    pub deadline_ms: u64,
    pub max_output_tokens: Option<u32>,
    /// Reasoning effort for this response alone. Omitted inherits the session's.
    ///
    /// Worth setting for anything that wants a short answer. The session runs at
    /// `high` for the sake of the agent's own turns, and a probe inheriting it spends
    /// its token budget thinking before it writes anything: measured against a live
    /// session, a one-word question at `high` burned 36 reasoning tokens and took
    /// 1401ms for an answer that needed five. At a budget of 16 it never got to the
    /// word at all — the response came back `incomplete` with empty output, which for
    /// a caller that treats no answer as a failure means silence every time.
    pub reasoning_effort: Option<String>,
}

/// One window of a recording of the user's own screen: the pictures taken in it, and the
/// narration over them as pcm16 mono at this session's own input rate.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordingSegment {
    /// Where the window starts, the way the model is told it: `0:30`.
    pub label: String,
    /// Pictures in the order they were taken, as data URIs.
    pub images: Vec<String>,
    pub audio: Bytes,
}

/// Whether a conversation item is somebody's turn in the room.
///
/// The agent's own speech qualifies; so does a participant's audio. What does *not*
/// is a message this runtime wrote into the conversation itself — `send_context()`
/// creates `role: 'user'` items carrying `input_text` for things nobody said out
/// loud ("you have just been admitted", "the people in the call are now…"). Those
/// would otherwise fill a probe's context window with the runtime's own notes and
/// change whether the latest utterance looks like it continues an exchange.
///
/// Judged on content rather than role for that reason: role alone cannot tell a
/// spoken turn from an injected one. A turn spoken in the room is audio and nothing
/// else, so anything carrying a second kind of part was written here — which is what
/// keeps a recording out, each of whose segments holds a label and pictures beside up
/// to half a minute of audio that a probe would otherwise re-read on every utterance.
fn is_spoken_turn(item: &Value) -> bool {
    let role = item.get("role").and_then(Value::as_str);
    if role == Some("assistant") {
        return true;
    }
    if role != Some("user") {
        return false;
    }
    let content = item
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    !content.is_empty()
        && content
            .iter()
            .all(|part| part.get("type").and_then(Value::as_str) == Some("input_audio"))
}

/// The out-of-band send id carried in a response's metadata, if any.
fn read_marker(metadata: Option<&Value>) -> Option<String> {
    let value = metadata?.get(OUT_OF_BAND_MARKER)?.as_str()?;
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// A probe on the wire, waiting for the model to answer it.
struct PendingProbe {
    send_id: String,
    settle: oneshot::Sender<Option<String>>,
    timer: AbortHandle,
    /// Accumulated `output_text` deltas, used when `response.done` carries no output.
    text: String,
}

/// A `response.create` the server has not acknowledged yet.
#[derive(Debug, Clone)]
struct PendingCreate {
    /// The client `event_id` sent with it, so a rejection can remove the right one.
    event_id: String,
    /// Set when a probe asked for this one; absent means the conversation did.
    probe_send_id: Option<String>,
    at: i64,
    /// When this stops being attributable.
    ///
    /// Per entry rather than one shared cutoff, because a probe waits longer than the
    /// conversation's watchdog does. Pruning a probe's entry at the watchdog's five
    /// seconds while its own deadline is six left a live probe opening in that second
    /// misread as the conversation's — which wedges the slot, since its
    /// metadata-marked `response.done` then takes the probe branch and releases
    /// nothing.
    expires_at: i64,
}

/// How long a response id stays recognisable as a probe's after it was opened.
///
/// Not a count. Capping the *number* trades a few hundred bytes for the chance of
/// forgetting a response that is still generating, after which its audio would be
/// played into the room and — far worse — a tool call on it would reach the bridge
/// and execute for real. An age bound cannot do that: no response outlives this, and
/// an entry is normally removed the moment its `response.done` arrives.
const PROBE_RESPONSE_TTL_MS: i64 = 120_000;

/// Spoken turns kept for a probe to draw context from.
///
/// Comfortably more than any window asks for, so the cap here is only a guard
/// against an hour-long call growing a list forever.
const CONVERSATION_ITEM_LIMIT: usize = 40;

fn tools_config(tools: &[RealtimeFunctionTool]) -> Map<String, Value> {
    let mut config = Map::new();
    config.insert(
        "tools".into(),
        Value::Array(
            tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    })
                })
                .collect(),
        ),
    );
    config.insert("tool_choice".into(), Value::from("auto"));
    config
}

/// The deployment settings the session configuration reads.
#[derive(Debug, Clone)]
struct SessionSettings {
    reasoning_effort: Option<String>,
    noise_reduction: String,
    transcription_model: String,
}

#[cfg(test)]
thread_local! {
    /// The settings a test on this thread runs under, in place of the configuration's.
    static SETTINGS_IN_TEST: std::cell::RefCell<Option<SessionSettings>> =
        const { std::cell::RefCell::new(None) };
}

/// Run this thread's sessions with `reasoning_effort` and `noise_reduction` in place of
/// the configured ones, or as configured (`None`).
#[cfg(test)]
pub(crate) fn set_settings_for_test(settings: Option<(Option<&str>, &str)>) {
    SETTINGS_IN_TEST.with(|cell| {
        *cell.borrow_mut() = settings.map(|(effort, noise)| SessionSettings {
            reasoning_effort: effort.map(str::to_string),
            noise_reduction: noise.to_string(),
            transcription_model: CONFIG.openai_transcription_model.clone(),
        })
    });
}

fn session_settings() -> SessionSettings {
    #[cfg(test)]
    if let Some(settings) = SETTINGS_IN_TEST.with(|cell| cell.borrow().clone()) {
        return settings;
    }
    SessionSettings {
        reasoning_effort: CONFIG
            .openai_realtime_reasoning_effort
            .map(|effort| effort.as_str().to_string()),
        noise_reduction: CONFIG.noise_reduction.as_str().to_string(),
        transcription_model: CONFIG.openai_transcription_model.clone(),
    }
}

/// base64 decoded as Node's `Buffer.from(text, 'base64')` decodes it: padding optional,
/// and characters outside the alphabet skipped.
pub(crate) fn decode_base64_lenient(text: &str) -> Vec<u8> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    if let Ok(bytes) = LENIENT.decode(text) {
        return bytes;
    }
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/')
        .collect();
    let usable = cleaned.len() - cleaned.len() % 4
        + if cleaned.len() % 4 >= 2 {
            cleaned.len() % 4
        } else {
            0
        };
    LENIENT.decode(&cleaned[..usable]).unwrap_or_default()
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[derive(Debug, Clone)]
pub struct RealtimeSessionOptions {
    /// The agent's system prompt — Soul, User, Agent Guide, memory, and the rest.
    pub instructions: String,
    pub tools: Vec<RealtimeFunctionTool>,
    /// Overrides `OPENAI_REALTIME_MODEL`.
    pub model: Option<String>,
    pub voice: Option<String>,
    /// What the room calls the agent, handed to the transcriber as a keyword.
    ///
    /// Names are the words a transcript gets wrong most: arbitrary, often short, and
    /// unstressed in the vocative ("hey Emma, …"), which is exactly where a speech
    /// model reaches for a common function word instead — a live call rendered "Hey
    /// Emma, what's on the agenda" as "Hey, **I'm** what's on the agenda".
    ///
    /// This no longer decides anything: nothing is judged from the transcript any
    /// more. It is kept because a log nobody can read the names in is a log that
    /// cannot be used to work out why a call went wrong.
    pub agent_name: Option<String>,
    /// Injected in tests so they can point at a local mock server.
    pub endpoint_override: Option<RealtimeEndpoint>,
    /// Where the session's tokens are spent.
    pub spend: RealtimeSpend,
}

/// Emitted when the model calls one of the agent's tools.
#[derive(Debug, Clone, PartialEq)]
pub struct RealtimeFunctionCall {
    pub call_id: String,
    pub name: String,
    /// Raw JSON text as streamed by the model; may be malformed.
    pub arguments_json: String,
}

/// The session's events. Consumers listen rather than passing a callback bag so the
/// session can be driven by more than one collaborator (playback, barge-in policy,
/// the service's telemetry) without threading callbacks through each of them.
#[derive(Debug, Clone)]
pub enum RealtimeSessionEvent {
    /// Model speech, pcm16 mono @24 kHz, tagged with the item it belongs to.
    Audio {
        pcm: Bytes,
        item_id: String,
    },
    SpeechStarted,
    SpeechStopped,
    /// The turn detector closed an utterance and added it to the conversation.
    ///
    /// Earlier than `Transcript` by however long transcription takes, and the only
    /// signal available before any words exist — which is what lets a one-to-one
    /// call answer as promptly as it did when the server created responses itself.
    UtteranceCommitted {
        item_id: String,
    },
    /// A participant's finished utterance, transcribed.
    Transcript {
        item_id: String,
        text: String,
    },
    FunctionCall(RealtimeFunctionCall),
    ResponseDone,
    /// A conversation response ended without producing anything.
    ///
    /// The agent decided to speak and the room heard silence — a rate limit, a server
    /// error, an exhausted token budget. Indistinguishable from never having been
    /// asked unless it is counted, which is what made this take two rounds to explain
    /// the first time it happened.
    ResponseFailed {
        status: String,
    },
    /// A protocol-level error from the API; the socket usually stays open.
    ApiError {
        message: String,
    },
    Closed {
        reason: String,
    },
}

/// A listener on the session's events, called in registration order.
pub type RealtimeSessionListener = Arc<dyn Fn(&RealtimeSessionEvent) + Send + Sync>;

/// The session's bookkeeping, behind one lock.
struct SessionState {
    /// Frames to the socket's writer task; `None` until connected and after close.
    outbound: Option<mpsc::UnboundedSender<Message>>,
    /// Whether the socket is open.
    open: bool,
    /// The task reading the socket, until it ends.
    reader: Option<AbortHandle>,
    /// Spoken turns the conversation holds, oldest first, bounded.
    ///
    /// What a gate probe's context window is drawn from. Bounded because a call runs
    /// for an hour and a probe only ever wants the recent few — and because an
    /// unbounded list is how the probe came to re-read the whole call and trip the
    /// token rate limit.
    conversation_items: VecDeque<String>,
    closed: bool,
    /// The audio item currently being spoken, for targeted truncation.
    current_item_id: Option<String>,
    response_active: bool,
    /// True once the server has actually opened the response we asked for.
    response_confirmed: bool,
    response_watchdog: Option<AbortHandle>,
    /// A `response.create` deferred until the open response finishes.
    response_pending: bool,
    /// Responses we have given up on, whose remaining audio must be discarded.
    ///
    /// An interrupt cannot un-send what is already in flight: deltas for the abandoned
    /// response keep arriving for as long as the socket takes to drain. Forwarding them
    /// would restart playback *over the person who interrupted*.
    ///
    /// Keyed by response rather than item on purpose: one turn can emit several audio
    /// items (a native preamble, then the answer), so an item-keyed set would happily
    /// play a *later* item of a response we already cancelled. This is also what
    /// OpenAI's own server-side transport does. Insertion-ordered, so the oldest is
    /// evicted first.
    abandoned_response_ids: indexmap::IndexSet<String>,
    /// Response each audio item belongs to, so an item can be matched to its turn.
    item_response_ids: HashMap<String, String>,
    /// Audio the server actually generated per item, in ms.
    ///
    /// The hard ceiling for `audio_end_ms`: the API rejects a truncate beyond an item's
    /// real duration. Our played-ms is derived from the same deltas so it should never
    /// exceed this, but "should never" is not a guarantee worth betting a live call on —
    /// a resampler rounding a few samples the wrong way would turn a barge-in into a
    /// protocol error. OpenAI's own SDK caps the same way.
    generated_ms_by_item: HashMap<String, f64>,
    /// The response currently generating, for attributing a barge-in.
    active_response_id: Option<String>,
    /// Out-of-band probes that have been sent but not yet answered, by send id.
    ///
    /// Bounded by the deadline every probe carries: each entry removes itself when it
    /// settles, and a probe the server never answers settles on its own timer.
    probes_by_send_id: HashMap<String, PendingProbe>,
    /// Probe send ids by the response id the server gave them, with when it opened.
    ///
    /// Kept until that response finishes, not until the probe settles — a probe that
    /// gave up on its deadline may still have a response generating behind it, and
    /// anything arriving on that response has to stay recognisable as *not the
    /// conversation's*. Bounded like `abandoned_response_ids`, since a response that
    /// never finishes would otherwise leave an entry for the rest of the call.
    probe_ids_by_response: IndexMap<String, (String, i64)>,
    probe_counter: u64,
    main_create_counter: u64,
    /// Every `response.create` on the wire that the server has not opened yet, oldest
    /// first, each knowing whether a probe asked for it.
    ///
    /// This is what lets `response.created` be attributed without relying on the
    /// server echoing `metadata` — documented for `response.done`, but not for
    /// `response.created`, and reported missing on at least one deployment. It has to
    /// be a queue rather than a flag: `created` events arrive in the order their
    /// requests were sent, and with a probe request and a conversation request both
    /// un-acked, a flag cannot say which of the two is opening. Getting that wrong
    /// swaps them — the probe claims the conversation's slot and never releases it,
    /// and the call goes mute for good.
    pending_creates: VecDeque<PendingCreate>,
    tools: Vec<RealtimeFunctionTool>,
    /// Frames written to the socket, so a test can wait for the server to hold them.
    #[cfg(test)]
    frames_sent: std::sync::atomic::AtomicUsize,
    /// Frames read and handled, so a test can wait for the session to have acted on them.
    #[cfg(test)]
    frames_handled: std::sync::atomic::AtomicUsize,
}

impl SessionState {
    /// Write one frame to the socket, when it is open.
    fn send(&self, payload: Value) {
        if !self.open || self.closed {
            return;
        }
        let Some(outbound) = &self.outbound else {
            return;
        };
        if outbound.send(Message::text(payload.to_string())).is_ok() {
            #[cfg(test)]
            self.frames_sent
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// Settle one waiting probe, once.
    fn settle_probe(&mut self, send_id: &str, text: Option<String>) {
        let Some(probe) = self.probes_by_send_id.remove(send_id) else {
            return;
        };
        probe.timer.abort();
        let _ = probe.settle.send(text);
    }
}

pub struct RealtimeSession {
    options: RealtimeSessionOptions,
    listeners: RwLock<Vec<RealtimeSessionListener>>,
    state: Mutex<SessionState>,
    this: Weak<RealtimeSession>,
}

/// What a frame asked of the session once its bookkeeping is done: events to raise, and
/// whether a deferred response goes out.
#[derive(Default)]
struct Followup {
    events: Vec<RealtimeSessionEvent>,
    request_response: bool,
}

impl RealtimeSession {
    pub fn new(options: RealtimeSessionOptions) -> Arc<Self> {
        let tools = options.tools.clone();
        Arc::new_cyclic(|this| Self {
            options,
            listeners: RwLock::new(Vec::new()),
            state: Mutex::new(SessionState {
                outbound: None,
                open: false,
                reader: None,
                conversation_items: VecDeque::new(),
                closed: false,
                current_item_id: None,
                response_active: false,
                response_confirmed: false,
                response_watchdog: None,
                response_pending: false,
                abandoned_response_ids: indexmap::IndexSet::new(),
                item_response_ids: HashMap::new(),
                generated_ms_by_item: HashMap::new(),
                active_response_id: None,
                probes_by_send_id: HashMap::new(),
                probe_ids_by_response: IndexMap::new(),
                probe_counter: 0,
                main_create_counter: 0,
                pending_creates: VecDeque::new(),
                tools,
                #[cfg(test)]
                frames_sent: Default::default(),
                #[cfg(test)]
                frames_handled: Default::default(),
            }),
            this: this.clone(),
        })
    }

    /// Listen to the session's events.
    pub fn on(&self, listener: RealtimeSessionListener) {
        self.listeners.write().push(listener);
    }

    /// Raise one event to every listener. Only this type raises its own events.
    fn emit_event(&self, event: RealtimeSessionEvent) {
        let listeners = self.listeners.read().clone();
        for listener in listeners {
            listener(&event);
        }
    }

    /// Open the socket and configure the session. Resolves once configured.
    pub async fn connect(self: &Arc<Self>) -> anyhow::Result<()> {
        let endpoint = match &self.options.endpoint_override {
            Some(endpoint) => endpoint.clone(),
            None => resolve_realtime_endpoint(self.options.model.as_deref())?,
        };
        let socket_options = build_realtime_socket_options(&endpoint);

        let socket = match connect_realtime_socket(&endpoint.url, &socket_options).await {
            Ok(socket) => socket,
            Err(err) => {
                let message = err.to_string();
                let mut fields = Map::new();
                let host = url::Url::parse(&endpoint.url)
                    .map(|url| url_host(&url))
                    .unwrap_or_default();
                fields.insert("host".into(), Value::from(host));
                if let Some(provider) = &CONFIG.realtime_provider {
                    fields.insert("provider".into(), Value::from(provider.clone()));
                }
                fields.insert(
                    "source".into(),
                    Value::from(CONFIG.realtime_source.as_str()),
                );
                if let Some(status) = handshake_status(&message) {
                    fields.insert("status".into(), Value::from(status));
                }
                log_warn!(Value::Object(fields), "[Meeting] Realtime handshake failed");
                anyhow::bail!("Realtime connection failed: {message}");
            }
        };

        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let closing = matches!(message, Message::Close(_));
                if sink.send(message).await.is_err() || closing {
                    break;
                }
            }
        });

        let weak = Arc::downgrade(self);
        // The reader starts once the state below holds its handle, so a socket that closes
        // at once is still reported.
        let (started_tx, started_rx) = oneshot::channel::<()>();
        let reader = tokio::spawn(async move {
            let _ = started_rx.await;
            let mut close: Option<(u16, String)> = None;
            while let Some(item) = stream.next().await {
                let Some(session) = weak.upgrade() else {
                    return;
                };
                match item {
                    Ok(Message::Text(text)) => {
                        session.handle_message(text.as_str());
                        #[cfg(test)]
                        session.count_handled_frame();
                    }
                    Ok(Message::Binary(data)) => {
                        session.handle_message(&String::from_utf8_lossy(&data));
                        #[cfg(test)]
                        session.count_handled_frame();
                    }
                    Ok(Message::Close(frame)) => {
                        close = Some(
                            frame
                                .map(|f| (u16::from(f.code), f.reason.as_str().to_string()))
                                .unwrap_or((1005, String::new())),
                        );
                    }
                    Ok(_) => {}
                    Err(tokio_tungstenite::tungstenite::Error::Protocol(
                        tokio_tungstenite::tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
                    )) => break,
                    Err(err) => {
                        // Post-handshake socket errors: report, then let the close handler run.
                        let err = anyhow::Error::new(err);
                        log_error!(
                            json!({ "err": err_json(&err) }),
                            "[Meeting] Realtime socket error"
                        );
                        session.emit_event(RealtimeSessionEvent::ApiError {
                            message: err.to_string(),
                        });
                        break;
                    }
                }
            }
            let Some(session) = weak.upgrade() else {
                return;
            };
            // Whoever takes the reader handle reports the close, so it is reported once.
            if session.state.lock().reader.take().is_none() {
                return;
            }
            let (code, reason) = close.unwrap_or((1006, String::new()));
            session.socket_closed(code, reason);
        });

        let closed_meanwhile = {
            let mut state = self.state.lock();
            state.reader = Some(reader.abort_handle());
            if state.closed {
                true
            } else {
                state.outbound = Some(tx.clone());
                state.open = true;
                false
            }
        };
        let _ = started_tx.send(());
        // A `close()` that landed while the socket was opening has nothing to close yet;
        // this socket is the one it meant.
        if closed_meanwhile {
            let _ = tx.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "meeting ended".into(),
            })));
            return Ok(());
        }

        self.configure_session();
        Ok(())
    }

    /// The socket is gone, however it went.
    ///
    /// Probes are settled here rather than only in `close()`: this is the *common* way a
    /// call ends from the session's point of view, and by the time teardown calls
    /// `close()` the `closed` flag is already set, so its own settling never runs.
    /// Without this a caller waits out its whole deadline after the socket is already
    /// gone.
    fn socket_closed(&self, code: u16, reason: String) {
        {
            let mut state = self.state.lock();
            state.closed = true;
            state.open = false;
            state.outbound = None;
        }
        self.settle_all_probes();
        let reason = if reason.is_empty() {
            format!("code {code}")
        } else {
            reason
        };
        self.emit_event(RealtimeSessionEvent::Closed { reason });
    }

    /// Send the session configuration: instructions, audio formats, tools, VAD.
    fn configure_session(&self) {
        let settings = session_settings();
        let pcm = json!({ "type": "audio/pcm", "rate": REALTIME_SAMPLE_RATE });

        let mut input = Map::new();
        input.insert("format".into(), pcm.clone());
        // Semantic VAD judges whether a speaker is *done* rather than just whether the
        // line went quiet — meetings are full of mid-thought pauses that energy-based VAD
        // reads as a finished turn.
        input.insert(
            "turn_detection".into(),
            json!({
                "type": "semantic_vad",
                // `low` waits longest before deciding a speaker has finished, which reads
                // as a pause before every single answer. `medium` still judges meaning
                // rather than silence, so a mid-thought pause is not mistaken for the end
                // of a turn the way an energy-based detector would; it just stops being
                // maximally patient about it. Barge-in covers the remaining case: if it
                // does start early, the speaker talking on takes the floor straight back.
                "eagerness": "medium",
                // The model never answers on its own. Whether an utterance in a mixed
                // room channel was aimed at the agent is a judgement only the client can
                // make; `response_policy.rs` makes it and asks for the response.
                // Detection of the turn *boundary* still belongs here.
                "create_response": false,
                // Off for the same family of reasons: interruption is decided locally so
                // a backchannel ("mm-hm") doesn't cut the agent off mid-sentence.
                "interrupt_response": false,
            }),
        );
        // `far_field` reads like the right fit for a meeting, but it describes the
        // *humans'* microphones rather than this input: what arrives here is Meet's mixed
        // output, already suppressed, echo-cancelled and levelled per participant.
        // Reducing it again is a second pass over a cleaned mix, and it cost a live agent
        // minutes of not hearing a person in the room. `off` omits the whole key rather
        // than sending a null one, which the API rejects — that would end the call
        // instead of disabling the filter.
        if settings.noise_reduction != "off" {
            input.insert(
                "noise_reduction".into(),
                json!({ "type": settings.noise_reduction }),
            );
        }
        // Only when the log is going to carry it. Whether the agent was addressed is
        // judged from the audio now (`addressed_audio_gate.rs`), so nothing else reads
        // these words — and transcription bills per audio minute whether or not anybody
        // looks. Read once, at connect: an utterance already past cannot be transcribed
        // retroactively anyway.
        //
        // `gpt-live-transcribe` accepts `keywords`, which is how the agent's name and the
        // room's roster are given to it. The transcriber detects the language, because a
        // call can be in any language.
        if transcript_log::full() {
            let mut transcription = Map::new();
            transcription.insert(
                "model".into(),
                Value::from(settings.transcription_model.clone()),
            );
            if let Some(agent_name) = self.options.agent_name.as_deref().filter(|n| !n.is_empty()) {
                transcription.insert("keywords".into(), json!([agent_name]));
            }
            input.insert("transcription".into(), Value::Object(transcription));
        }

        let mut output = Map::new();
        output.insert("format".into(), pcm);
        if let Some(voice) = self.options.voice.as_deref().filter(|v| !v.is_empty()) {
            output.insert("voice".into(), Value::from(voice));
        }

        let mut session = Map::new();
        session.insert("type".into(), Value::from("realtime"));
        session.insert(
            "instructions".into(),
            Value::from(self.options.instructions.clone()),
        );
        session.insert("output_modalities".into(), json!(["audio"]));
        // A deployment-wide setting, not something a single join decides. Omitted entirely
        // when config says so, which hands the level back to the API's own default of
        // `low`.
        if let Some(effort) = settings.reasoning_effort.filter(|e| !e.is_empty()) {
            session.insert("reasoning".into(), json!({ "effort": effort }));
        }
        session.insert(
            "audio".into(),
            json!({ "input": Value::Object(input), "output": Value::Object(output) }),
        );

        let state = self.state.lock();
        if !state.tools.is_empty() {
            session.extend(tools_config(&state.tools));
        }
        state.send(json!({ "type": "session.update", "session": Value::Object(session) }));
    }

    /// Replace the tools the model can call, mid-call. A partial `session.update`
    /// merges, so the rest of the session is unchanged; a reconnect sends these too.
    pub fn set_tools(&self, tools: Vec<RealtimeFunctionTool>) {
        let mut state = self.state.lock();
        state.tools = tools;
        if !state.open || state.closed {
            return;
        }
        let mut session = Map::new();
        session.insert("type".into(), Value::from("realtime"));
        session.extend(tools_config(&state.tools));
        state.send(json!({ "type": "session.update", "session": Value::Object(session) }));
    }

    fn handle_message(&self, data: &str) {
        let event: Value = match serde_json::from_str(data) {
            Ok(event) => event,
            Err(_) => {
                log_warn!("[Meeting] Unparseable Realtime frame");
                return;
            }
        };

        let followup = self.apply_event(&event);
        for event in followup.events {
            self.emit_event(event);
        }
        if followup.request_response {
            self.request_response();
        }
    }

    /// Bring the bookkeeping up to date with one server event, and say what follows.
    fn apply_event(&self, event: &Value) -> Followup {
        let mut followup = Followup::default();
        let Some(kind) = str_field(event, "type") else {
            return followup;
        };

        match kind {
            "session.created" | "session.updated" => {}

            // GA renamed the audio output events to the `response.output_audio.*`
            // family; the older `response.audio.*` names are accepted too so a model
            // snapshot that still emits them doesn't go silent.
            "response.output_audio.delta" | "response.audio.delta" => {
                let mut state = self.state.lock();
                let item_id = str_field(event, "item_id").unwrap_or("").to_string();
                let response_id = match event.get("response_id").and_then(Value::as_str) {
                    Some(id) => Some(id.to_string()),
                    None => state.active_response_id.clone(),
                }
                .filter(|id| !id.is_empty());
                let Some(delta) = str_field(event, "delta").filter(|d| !d.is_empty()) else {
                    return followup;
                };
                if let Some(response_id) = &response_id {
                    // A probe asks for text only, so audio on one is a contract violation
                    // rather than something to play into the room.
                    if Self::is_probe_response(&state, response_id) {
                        return followup;
                    }
                    // Tail of a turn we already yielded the floor on — see
                    // `abandoned_response_ids`. Dropped before it can restart playback.
                    if state.abandoned_response_ids.contains(response_id) {
                        return followup;
                    }
                }
                let pcm = Bytes::from(decode_base64_lenient(delta));
                if !item_id.is_empty() {
                    state.current_item_id = Some(item_id.clone());
                    if let Some(response_id) = &response_id {
                        state
                            .item_response_ids
                            .insert(item_id.clone(), response_id.clone());
                    }
                    // pcm16 mono at the session rate: two bytes per sample.
                    let ms = (pcm.len() as f64 / 2.0 / REALTIME_SAMPLE_RATE as f64) * 1000.0;
                    *state
                        .generated_ms_by_item
                        .entry(item_id.clone())
                        .or_insert(0.0) += ms;
                }
                followup
                    .events
                    .push(RealtimeSessionEvent::Audio { pcm, item_id });
            }

            "input_audio_buffer.speech_started" => {
                followup.events.push(RealtimeSessionEvent::SpeechStarted);
            }

            "input_audio_buffer.speech_stopped" => {
                followup.events.push(RealtimeSessionEvent::SpeechStopped);
            }

            // The turn detector decided the speaker was finished and committed the audio
            // as a conversation item. With `create_response` off this is where a response
            // *would* have been created, so it is the moment to decide whether to ask for
            // one.
            "input_audio_buffer.committed" => {
                let item_id = str_field(event, "item_id").unwrap_or("").to_string();
                followup
                    .events
                    .push(RealtimeSessionEvent::UtteranceCommitted { item_id });
            }

            // Every item the conversation gains, which is what a gate probe's context
            // window is drawn from. Only spoken turns are kept: a `function_call_output`
            // can be 12,000 characters of tool result (`tool_bridge.rs`) — measured at
            // ~2,900 tokens for one — and says nothing about who was addressed, so
            // including it would make each probe cost more than the room does.
            "conversation.item.added" | "conversation.item.created" => {
                let Some(item) = event.get("item") else {
                    return followup;
                };
                let id = str_field(item, "id").filter(|id| !id.is_empty());
                if let Some(id) = id
                    && str_field(item, "type") == Some("message")
                    && is_spoken_turn(item)
                {
                    Self::remember_conversation_item(&mut self.state.lock(), id);
                }
            }

            // Transcription can fail outright. Nothing reads these words any more, so
            // this costs a log line rather than a verdict — but it is still worth `warn`:
            // a room whose transcripts fail cannot be read back at all, and that is the
            // difference between diagnosing a bad verdict and guessing at it.
            "conversation.item.input_audio_transcription.failed" => {
                let item_id = str_field(event, "item_id").unwrap_or("");
                let message = event
                    .get("error")
                    .and_then(|err| str_field(err, "message"))
                    .filter(|m| !m.is_empty());
                log_warn!(
                    "[Meeting] Transcription failed for {}{} — it will not appear in the log",
                    if item_id.is_empty() {
                        "an utterance"
                    } else {
                        item_id
                    },
                    message.map(|m| format!(": {m}")).unwrap_or_default()
                );
            }

            "conversation.item.input_audio_transcription.completed" => {
                record_realtime_usage(
                    &self.options.spend,
                    &CONFIG.openai_transcription_model,
                    event.get("usage"),
                );
                let item_id = str_field(event, "item_id").unwrap_or("");
                if let Some(transcript) = str_field(event, "transcript") {
                    let trimmed = crate::support::js::trim(transcript);
                    if !trimmed.is_empty() {
                        followup.events.push(RealtimeSessionEvent::Transcript {
                            item_id: item_id.to_string(),
                            text: trimmed.to_string(),
                        });
                        return followup;
                    }
                }
                log_warn!(
                    "[Meeting] Transcription came back empty for {} — it will not appear in the log",
                    if item_id.is_empty() {
                        "an utterance"
                    } else {
                        item_id
                    }
                );
            }

            "response.created" => {
                let created = event.get("response");
                let mut state = self.state.lock();
                // An out-of-band probe does not occupy the conversation's response slot,
                // so none of the slot bookkeeping below may run for one. In particular it
                // must not set `response_confirmed`: a dropped conversation request
                // followed by a probe opening would otherwise satisfy the watchdog that
                // exists to undo it, and the agent would go mute for the rest of the
                // call.
                if let Some(probe_send_id) = Self::attribute_created_to_probe(&mut state, created) {
                    if let Some(id) = created
                        .and_then(|c| str_field(c, "id"))
                        .filter(|id| !id.is_empty())
                    {
                        Self::remember_probe_response(&mut state, id, &probe_send_id);
                    }
                    return followup;
                }
                // Confirms the optimistic flag `request_response()` set on send. Setting it
                // here as well keeps the bookkeeping right for any response the server
                // opens that we did not ask for — with `create_response` off there should
                // be none, but colliding with one would wedge the session.
                state.response_active = true;
                state.response_confirmed = true;
                state.active_response_id =
                    created.and_then(|c| str_field(c, "id")).map(str::to_string);
                log_info!(
                    "[Meeting:Resp] Conversation response {} opened",
                    state.active_response_id.as_deref().unwrap_or("?")
                );
            }

            "response.function_call_arguments.done" => {
                let call_id = str_field(event, "call_id").unwrap_or("");
                let name = str_field(event, "name").unwrap_or("");
                let arguments_json = str_field(event, "arguments").unwrap_or("{}");
                if call_id.is_empty() || name.is_empty() {
                    log_warn!("[Meeting] Function call event missing call_id or name");
                    return followup;
                }
                // A probe must never reach the tool bridge. Every probe is sent with
                // `tools: []` and `tool_choice: 'none'`, so this should be unreachable —
                // but the session's tools are the agent's real ones, including shell and
                // its own configuration, and a tool call is executed for real. Two
                // independent guards, because one of them silently not applying is
                // exactly the kind of thing that only shows up in a live call.
                //
                // This one depends on the event naming its response: attribution is
                // impossible without it, and unlike the audio path there is no safe
                // fallback — guessing the conversation would execute the call, and
                // guessing a probe would drop a real one. It has always been present in
                // practice.
                let response_id = str_field(event, "response_id").unwrap_or("");
                if Self::is_probe_response(&self.state.lock(), response_id) {
                    log_warn!(
                        "[Meeting] Ignored a tool call ({}) on an out-of-band response — probes carry no tools",
                        name
                    );
                    return followup;
                }
                followup
                    .events
                    .push(RealtimeSessionEvent::FunctionCall(RealtimeFunctionCall {
                        call_id: call_id.to_string(),
                        name: name.to_string(),
                        arguments_json: arguments_json.to_string(),
                    }));
            }

            // GA streams a text-only response as `response.output_text.*`; the older
            // `response.text.*` names are accepted too. Only probes ask for text, so these
            // deltas are theirs — the conversation's responses are audio.
            "response.output_text.delta" | "response.text.delta" => {
                let response_id = str_field(event, "response_id").unwrap_or("");
                let mut state = self.state.lock();
                if let (Some(probe), Some(delta)) = (
                    Self::probe_for(&mut state, response_id),
                    str_field(event, "delta"),
                ) {
                    probe.text.push_str(delta);
                }
            }

            "response.done" => {
                let done = event.get("response");
                // Every response bills, a probe and a stale one included.
                let model = self
                    .options
                    .model
                    .clone()
                    .filter(|model| !model.is_empty())
                    .unwrap_or_else(|| CONFIG.openai_realtime_model.clone());
                record_realtime_usage(
                    &self.options.spend,
                    &model,
                    done.and_then(|d| d.get("usage")),
                );
                let mut state = self.state.lock();
                // A probe finishing must release nothing: the conversation's own response
                // may still be generating, and clearing the slot here would both fire a
                // deferred duplicate and count the probe as something the room heard.
                if let Some(probe_send_id) = Self::probe_send_id_for(&state, done) {
                    if let Some(id) = done
                        .and_then(|d| str_field(d, "id"))
                        .filter(|id| !id.is_empty())
                    {
                        state.probe_ids_by_response.shift_remove(id);
                    }
                    // The send queue entry has to go too. When this probe was matched by
                    // its marker rather than by an id recorded at `response.created` —
                    // because that event was missed — its entry is still queued, and the
                    // next bare conversation `created` would take it, be classified
                    // out-of-band, have its audio discarded and never release the slot.
                    // That is a mute call for the rest of the meeting.
                    Self::drop_create(&mut state, &probe_send_id);
                    let Some(probe_text) = state
                        .probes_by_send_id
                        .get(&probe_send_id)
                        .map(|p| p.text.clone())
                    else {
                        return followup;
                    };
                    let from_output = done
                        .and_then(|d| d.get("output"))
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .flat_map(|item| {
                                    item.get("content")
                                        .and_then(Value::as_array)
                                        .cloned()
                                        .unwrap_or_default()
                                })
                                .map(|part| {
                                    str_field(&part, "text")
                                        .or_else(|| str_field(&part, "transcript"))
                                        .unwrap_or("")
                                        .to_string()
                                })
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                    let from_output = crate::support::js::trim(&from_output).to_string();
                    let from_deltas = crate::support::js::trim(&probe_text).to_string();
                    let answer = if !from_output.is_empty() {
                        Some(from_output)
                    } else if !from_deltas.is_empty() {
                        Some(from_deltas)
                    } else {
                        None
                    };
                    // A response that completes with nothing to say is the failure this
                    // gate cannot otherwise explain: it looks identical to a rejection and
                    // to a timeout in the log, and the cause is usually the token budget
                    // being spent on reasoning before the word. Say which it was, with the
                    // numbers, so it never has to be inferred from timing again.
                    if answer.is_none() {
                        log_warn!(
                            "[Meeting:Resp] Probe {} answered nothing (status={}, details={}, output_tokens={})",
                            done.and_then(|d| str_field(d, "id")).unwrap_or("?"),
                            done.and_then(|d| str_field(d, "status"))
                                .unwrap_or("unknown"),
                            json_or_empty(done.and_then(|d| d.get("status_details"))),
                            json_or_empty(
                                done.and_then(|d| d.get("usage"))
                                    .and_then(|u| u.get("output_token_details"))
                            )
                        );
                    }
                    state.settle_probe(&probe_send_id, answer);
                    return followup;
                }
                // A completion for a response that is no longer the live one says nothing
                // about the live one. Sequence that made this matter: A opens, a barge-in
                // cancels A, B is requested and opens, and *then* A's delayed cancelled
                // `response.done` arrives. Clearing the slot here would wipe B's state
                // while B is still speaking, after which a later interruption sends no
                // cancel at all and a second request can go out concurrently.
                let finished_id = done.and_then(|d| str_field(d, "id")).unwrap_or("");
                let stale = !finished_id.is_empty()
                    && ((state
                        .active_response_id
                        .as_deref()
                        .is_some_and(|active| active != finished_id))
                        || state.abandoned_response_ids.contains(finished_id));
                if stale {
                    log_debug!(
                        "[Meeting:Resp] Ignoring a completion for {} — {} is the live response",
                        done.and_then(|d| str_field(d, "id")).unwrap_or("?"),
                        state.active_response_id.as_deref().unwrap_or("nothing")
                    );
                    return followup;
                }

                state.response_active = false;
                state.response_confirmed = false;
                // Cleared with the response it names. Left set, the next
                // `request_response()` has a window before its own `response.created`
                // lands in which `interrupt()` would cancel and abandon *this* finished
                // response instead — so the new one is neither cancelled nor marked
                // abandoned, and carries on speaking over the person who interrupted.
                state.active_response_id = None;
                let queued = if state.response_pending {
                    " — releasing the queued request"
                } else {
                    ""
                };
                let status = done
                    .and_then(|d| str_field(d, "status"))
                    .filter(|s| !s.is_empty());
                let done_id = done.and_then(|d| str_field(d, "id")).unwrap_or("?");
                match status {
                    Some(status) if status != "completed" => {
                        // The room heard nothing. Deliberately **not** retried: the API's
                        // own suggested delay for a rate limit was 26 seconds, and
                        // answering a question the room asked half a minute ago is worse
                        // than not answering it — the same reason a stale verdict is
                        // dropped. Someone repeating themselves recovers this; a queue of
                        // late answers arriving together does not. So it is reported
                        // loudly and counted instead, and the real fix is not needing to
                        // retry.
                        log_warn!(
                            "[Meeting:Resp] Conversation response {} produced nothing (status={}, details={}){}",
                            done_id,
                            status,
                            json_or_empty(done.and_then(|d| d.get("status_details"))),
                            queued
                        );
                        followup.events.push(RealtimeSessionEvent::ResponseFailed {
                            status: status.to_string(),
                        });
                    }
                    _ => {
                        log_info!(
                            "[Meeting:Resp] Conversation response {} done status={}{}",
                            done_id,
                            status.unwrap_or("unknown"),
                            queued
                        );
                    }
                }
                followup.events.push(RealtimeSessionEvent::ResponseDone);
                // Release a response that was requested while this one was still open.
                if state.response_pending {
                    state.response_pending = false;
                    followup.request_response = true;
                }
            }

            "error" => {
                let err = event.get("error");
                let message = err
                    .and_then(|e| str_field(e, "message"))
                    .unwrap_or("unknown Realtime API error")
                    .to_string();
                // A rejected `response.create` never opens a response, so metadata never
                // comes back for it — the client `event_id` echoed here is the only thing
                // that says which request failed. Settle that probe and touch no slot
                // state: a probe rejected with "already has an active response" must not
                // set `response_pending`, or the rejection queues a phantom answer that
                // speaks unprompted when the open response finishes.
                //
                // The id lives on `error.event_id`, **not** the top level. This event has
                // two: the outer one is the server's id for the error itself, and the
                // inner one names the client event that caused it.
                let failed_send_id = err.and_then(|e| str_field(e, "event_id")).unwrap_or("");
                let mut state = self.state.lock();
                let failed_create = if failed_send_id.is_empty() {
                    None
                } else {
                    Self::drop_create(&mut state, failed_send_id)
                };
                let failed_probe = state.probes_by_send_id.contains_key(failed_send_id);
                // Classified from the queue entry, not from whether anybody is still
                // waiting. A probe that already hit its deadline is gone from
                // `probes_by_send_id`, and treating its late rejection as the
                // conversation's is how an `already has an active response` error queues
                // a phantom answer for a question nothing asked.
                if failed_probe
                    || failed_create
                        .as_ref()
                        .is_some_and(|c| c.probe_send_id.is_some())
                {
                    log_warn!(
                        "[Meeting] Out-of-band request rejected: {}{}",
                        message,
                        if failed_probe {
                            ""
                        } else {
                            " (after it had already given up)"
                        }
                    );
                    if failed_probe {
                        state.settle_probe(failed_send_id, None);
                    }
                    return followup;
                }
                // Two opposite errors mention an active response, and confusing them
                // wedges the session: matching them loosely once meant a failed *cancel*
                // was read as "a response is running", after which every later request
                // deferred forever and the bot went mute for the rest of the call.
                let lower = message.to_lowercase();
                if lower.contains("already has an active response") {
                    // The server is mid-response and dropped our request. Remember it so
                    // the answer goes out when that one finishes instead of being lost.
                    state.response_active = true;
                    state.response_confirmed = true;
                    state.response_pending = true;
                    log_warn!(
                        "[Meeting] Response request arrived too early; queued behind the open one"
                    );
                    return followup;
                }
                if lower.contains("no active response") {
                    // Same correlation problem as a stale completion: this error answers a
                    // *cancel* we sent, and by the time it arrives a new response may
                    // already be running. Clearing the flags then would strand that one
                    // exactly as a stale `response.done` would, so a confirmed live
                    // response wins.
                    if state.response_confirmed && state.active_response_id.is_some() {
                        log_debug!(
                            "[Meeting] A cancel found nothing to cancel, but a newer response is live"
                        );
                        return followup;
                    }
                    // We cancelled something already finished — a barge-in landing just
                    // as the model stopped. The response is over, so release the flags
                    // rather than leaving them set on a response that no longer exists.
                    state.response_active = false;
                    state.response_confirmed = false;
                    log_debug!("[Meeting] Cancelled a response that had already finished");
                    if state.response_pending {
                        state.response_pending = false;
                        followup.request_response = true;
                    }
                    return followup;
                }
                log_error!("[Meeting] Realtime API error: {}", message);
                followup
                    .events
                    .push(RealtimeSessionEvent::ApiError { message });
            }

            _ => {}
        }
        followup
    }

    /// Append captured meeting audio (pcm16 mono @24 kHz) to the input buffer.
    pub fn send_audio(&self, pcm24k: &[u8]) {
        if pcm24k.is_empty() {
            return;
        }
        self.send(json!({
            "type": "input_audio_buffer.append",
            "audio": base64::engine::general_purpose::STANDARD.encode(pcm24k),
        }));
    }

    /// Ask the model to respond now (addressed-only mode drives turns this way).
    ///
    /// Deferred while a response is still generating: the API rejects a second
    /// `response.create` and the request would simply be lost. This matters most for
    /// tool results — `response.function_call_arguments.done` arrives *before* the
    /// `response.done` of the response that made the call, so a tool that answers
    /// quickly (a cache hit, or a rejected argument) gets here while the previous
    /// response is still open. Without the deferral its answer would never be spoken
    /// until some later turn happened to trigger a response.
    pub fn request_response(&self) {
        // The one boundary every spoken answer crosses — a turn the policy allowed, a
        // verdict that landed late, the report on a recording. A secure takeover of the
        // computer stops the runtime, and an answer here can call the agent's tools.
        if INFERENCE_GATE.held() {
            log_info!("[Meeting:Resp] Not answering — the computer is held for a secure sign-in");
            return;
        }
        let mut state = self.state.lock();
        if state.response_active {
            // Only one can be queued. A second request while one is already waiting is
            // dropped here, silently — which is invisible without this line, and reads in
            // the room as the agent ignoring something it was asked.
            log_info!(
                "[Meeting:Resp] Deferred a request — response {} is still open{}",
                state
                    .active_response_id
                    .as_deref()
                    .unwrap_or("(unconfirmed)"),
                if state.response_pending {
                    ", and one was already queued"
                } else {
                    ""
                }
            );
            state.response_pending = true;
            return;
        }
        // Marked active on *send*, not on the server's `response.created`. Waiting for
        // confirmation leaves a round-trip-wide window in which a second request looks
        // legal, and the API answers that with "Conversation already has an active
        // response in progress" — after which the second answer is simply lost.
        state.response_active = true;
        self.response_created_watchdog(&mut state);
        // Given an id of its own so that a rejection — which echoes it — can remove this
        // request from the queue rather than leaving it to misplace a later
        // `response.created`.
        state.main_create_counter += 1;
        let event_id = format!("main_{}", state.main_create_counter);
        Self::note_create_sent(&mut state, &event_id, None, RESPONSE_CREATED_TIMEOUT_MS);
        state.send(json!({ "type": "response.create", "event_id": event_id }));
    }

    /// Ask the model a question beside the conversation and wait for its text.
    ///
    /// Resolves `None` when there is no answer to be had — the socket is shut, the
    /// request was rejected, the deadline passed, or the model returned nothing. The
    /// caller decides what silence means; this only reports it.
    ///
    /// Deliberately *not* routed through `request_response()`. That method guards the
    /// conversation's single response slot, and a probe does not compete for it: going
    /// through it would defer the probe behind whatever the agent is saying, which is
    /// the opposite of what a "should I answer this?" question is for.
    pub async fn request_out_of_band_text(&self, request: OutOfBandRequest) -> Option<String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock();
            if !state.open || state.closed {
                return None;
            }

            state.probe_counter += 1;
            let send_id = format!("oob_{}", state.probe_counter);
            let weak = self.this.clone();
            let timer_id = send_id.clone();
            let deadline = request.deadline_ms;
            let timer = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(deadline)).await;
                let Some(session) = weak.upgrade() else {
                    return;
                };
                let mut state = session.state.lock();
                if !state.probes_by_send_id.contains_key(&timer_id) {
                    return;
                }
                log_warn!("[Meeting] Out-of-band request {} went unanswered", timer_id);
                state.settle_probe(&timer_id, None);
            });

            state.probes_by_send_id.insert(
                send_id.clone(),
                PendingProbe {
                    send_id: send_id.clone(),
                    settle: tx,
                    timer: timer.abort_handle(),
                    text: String::new(),
                },
            );
            // Attributable for its whole deadline and a little past it: a probe that
            // opens at the last moment must still be recognised as a probe.
            Self::note_create_sent(
                &mut state,
                &send_id,
                Some(&send_id),
                request.deadline_ms + RESPONSE_CREATED_TIMEOUT_MS,
            );

            let mut metadata = Map::new();
            for (key, value) in request.metadata.iter().flatten() {
                metadata.insert(key.clone(), Value::from(value.clone()));
            }
            metadata.insert(OUT_OF_BAND_MARKER.into(), Value::from(send_id.clone()));

            let mut response = Map::new();
            // Keeps the answer out of the conversation, so asking is not something the
            // agent has said.
            response.insert("conversation".into(), Value::from("none"));
            response.insert("output_modalities".into(), json!(["text"]));
            response.insert(
                "instructions".into(),
                Value::from(request.instructions.clone()),
            );
            response.insert("metadata".into(), Value::Object(metadata));
            // Not inherited from the session: the agent's real tools are live in a
            // meeting, and a probe reading an untrusted utterance must not be able to
            // reach them. See the guard in `response.function_call_arguments.done`.
            response.insert("tools".into(), json!([]));
            response.insert("tool_choice".into(), Value::from("none"));
            if let Some(effort) = request
                .reasoning_effort
                .as_deref()
                .filter(|e| !e.is_empty())
            {
                response.insert("reasoning".into(), json!({ "effort": effort }));
            }
            if let Some(max) = request.max_output_tokens.filter(|max| *max > 0) {
                response.insert("max_output_tokens".into(), Value::from(max));
            }
            if let Some(input) = &request.input {
                response.insert("input".into(), Value::Array(input.clone()));
            }
            state.send(json!({
                "type": "response.create",
                "event_id": send_id,
                "response": Value::Object(response),
            }));
        }
        rx.await.unwrap_or(None)
    }

    /// Whether a response id is a probe's rather than the conversation's.
    ///
    /// Deliberately independent of whether that probe is still waiting: a probe can
    /// give up on its deadline while the server keeps generating, and anything
    /// arriving on such a response is still not the conversation's — least of all a
    /// tool call, which would otherwise be executed for real.
    fn is_probe_response(state: &SessionState, response_id: &str) -> bool {
        !response_id.is_empty() && state.probe_ids_by_response.contains_key(response_id)
    }

    /// Note a spoken turn, evicting the oldest past the cap.
    fn remember_conversation_item(state: &mut SessionState, item_id: &str) {
        if state.conversation_items.iter().any(|id| id == item_id) {
            return;
        }
        state.conversation_items.push_back(item_id.to_string());
        while state.conversation_items.len() > CONVERSATION_ITEM_LIMIT {
            state.conversation_items.pop_front();
        }
    }

    /// The most recent spoken turns, oldest first — the context a probe can draw on.
    ///
    /// Tool calls and their output are deliberately absent: one tool result can be
    /// 12,000 characters, measured at ~2,900 tokens, and it says nothing about who was
    /// addressed. Including them is what made a probe cost more than the room did.
    pub fn recent_conversation_items(&self, limit: usize) -> Vec<String> {
        if limit == 0 {
            return Vec::new();
        }
        let state = self.state.lock();
        let skip = state.conversation_items.len().saturating_sub(limit);
        state
            .conversation_items
            .iter()
            .skip(skip)
            .cloned()
            .collect()
    }

    /// Give up on every probe still waiting.
    ///
    /// Nobody is going to answer them once the socket is gone. Settling rather than
    /// leaving them pending is what stops a caller awaiting a verdict for the whole
    /// length of its deadline after the call has already ended.
    fn settle_all_probes(&self) {
        let mut state = self.state.lock();
        let ids: Vec<String> = state.probes_by_send_id.keys().cloned().collect();
        for id in ids {
            state.settle_probe(&id, None);
        }
    }

    /// The probe still waiting on a response id, if one is.
    fn probe_for<'a>(
        state: &'a mut SessionState,
        response_id: &str,
    ) -> Option<&'a mut PendingProbe> {
        if response_id.is_empty() {
            return None;
        }
        let send_id = state.probe_ids_by_response.get(response_id)?.0.clone();
        state.probes_by_send_id.get_mut(&send_id)
    }

    /// Remember a response as a probe's, dropping only entries too old to be live.
    ///
    /// Deliberately never evicts by count: an entry forgotten while its response is
    /// still generating is one whose tool calls stop being recognised as a probe's.
    fn remember_probe_response(state: &mut SessionState, response_id: &str, send_id: &str) {
        let now = clock_ms();
        let cutoff = now - PROBE_RESPONSE_TTL_MS;
        state
            .probe_ids_by_response
            .retain(|_, (_, at)| *at >= cutoff);
        state
            .probe_ids_by_response
            .insert(response_id.to_string(), (send_id.to_string(), now));
    }

    /// Note a `response.create` on the wire, so its `response.created` can be placed.
    fn note_create_sent(
        state: &mut SessionState,
        event_id: &str,
        probe_send_id: Option<&str>,
        ttl_ms: u64,
    ) {
        let at = clock_ms();
        state.pending_creates.push_back(PendingCreate {
            event_id: event_id.to_string(),
            probe_send_id: probe_send_id.map(str::to_string),
            at,
            expires_at: at + ttl_ms as i64,
        });
    }

    /// Forget a request the server rejected, handing back what it was.
    ///
    /// The entry is the only surviving record of *whose* request an error belongs to
    /// once the probe itself has given up, so the caller needs it returned rather
    /// than merely removed: a probe that timed out is still not the conversation, and
    /// treating its late rejection as one queues a phantom answer.
    fn drop_create(state: &mut SessionState, event_id: &str) -> Option<PendingCreate> {
        let index = state
            .pending_creates
            .iter()
            .position(|c| c.event_id == event_id)?;
        state.pending_creates.remove(index)
    }

    /// Which request a bare `response.created` belongs to.
    ///
    /// Oldest first, because the server opens responses in the order it received the
    /// requests. Entries past their own expiry are discarded first: a request the API
    /// dropped silently gets no `created`, and leaving it at the head of the queue
    /// would misplace every later one.
    fn take_create(state: &mut SessionState) -> Option<PendingCreate> {
        let now = clock_ms();
        while state
            .pending_creates
            .front()
            .map(|c| c.expires_at < now)
            .unwrap_or(false)
        {
            state.pending_creates.pop_front();
        }
        state.pending_creates.pop_front()
    }

    /// Which probe a finished response belongs to — by the id recorded when it opened,
    /// or failing that by the marker the server echoes on `response.done`.
    fn probe_send_id_for(state: &SessionState, done: Option<&Value>) -> Option<String> {
        let by_id = done
            .and_then(|d| d.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .and_then(|id| state.probe_ids_by_response.get(id))
            .map(|(send_id, _)| send_id.clone());
        by_id.or_else(|| read_marker(done.and_then(|d| d.get("metadata"))))
    }

    /// Decide whether a newly opened response is a probe's, and which.
    ///
    /// The marker settles it when the server echoes metadata, and is trusted even if
    /// that probe has already given up — a response we know is out-of-band must never
    /// be allowed to claim the conversation's slot, because nothing would then
    /// release it. Otherwise the send queue decides, in order.
    fn attribute_created_to_probe(
        state: &mut SessionState,
        created: Option<&Value>,
    ) -> Option<String> {
        if let Some(marked) = read_marker(created.and_then(|c| c.get("metadata"))) {
            Self::drop_create(state, &marked);
            return Some(marked);
        }
        Self::take_create(state).and_then(|c| c.probe_send_id)
    }

    /// Undo an optimistic `response_active` if the server never opens the response.
    ///
    /// Without this, a `response.create` that the API drops (a rejected tool argument,
    /// a transient error) would leave the flag set and every later request deferred
    /// forever — the bot goes permanently mute, which is far worse than one duplicate.
    fn response_created_watchdog(&self, state: &mut SessionState) {
        if let Some(previous) = state.response_watchdog.take() {
            previous.abort();
        }
        let weak = self.this.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(RESPONSE_CREATED_TIMEOUT_MS)).await;
            let Some(session) = weak.upgrade() else {
                return;
            };
            let release = {
                let mut state = session.state.lock();
                state.response_watchdog = None;
                if !state.response_active || state.response_confirmed {
                    return;
                }
                log_warn!(
                    "[Meeting] No response.created arrived; clearing the active-response flag"
                );
                // The queue entry for the dropped request is not removed here: it ages out
                // on the same timeout inside `take_create()`, which is also what covers a
                // request dropped without any watchdog running.
                state.response_active = false;
                let pending = state.response_pending;
                state.response_pending = false;
                pending
            };
            if release {
                session.request_response();
            }
        });
        state.response_watchdog = Some(timer.abort_handle());
    }

    /// Abandon the in-flight response and tell the model how much of it was
    /// actually heard, so its context matches the room's experience.
    ///
    /// `played_ms` must be what reached the meeting, not what was received — audio
    /// deltas arrive far faster than real time.
    pub fn interrupt(&self, items: &[PlaybackSnapshot]) {
        let mut state = self.state.lock();
        // A response queued behind this one is abandoned with it: the human now has the
        // floor, and their speech is what should decide the next turn. (Any tool result
        // already sits in the conversation, so nothing is lost.)
        if state.response_pending {
            log_info!("[Meeting:Resp] Dropped a queued request — a human took the floor");
        }
        state.response_pending = false;
        if state.response_active {
            // Named explicitly so a probe in flight cannot be the thing that gets
            // cancelled. Without an id the API cancels "an in-progress response in the
            // default conversation", which is also what we want — but only the id makes
            // that a guarantee rather than a documented default, and the id is unknown
            // only in the round trip before `response.created` lands.
            let mut cancel = Map::new();
            cancel.insert("type".into(), Value::from("response.cancel"));
            if let Some(active) = state
                .active_response_id
                .as_deref()
                .filter(|a| !a.is_empty())
            {
                cancel.insert("response_id".into(), Value::from(active));
            }
            state.send(Value::Object(cancel));
            state.response_active = false;
            // The send queue is deliberately left alone: cancelling does not stop the
            // `response.created` for a request already on the wire, so dropping its entry
            // here would misplace that event when it lands.
        }

        for (index, item) in items.iter().enumerate() {
            // OpenAI's transport formula: nudge the cut point past what was measured as
            // heard, bounded by what actually reached the device — and truncate an item
            // that never started at 0 so its transcript still leaves the context.
            let generated = state
                .generated_ms_by_item
                .get(&item.item_id)
                .copied()
                .unwrap_or(item.sent_ms);
            let ceiling = item.sent_ms.min(generated);
            let audio_end_ms = if index == 0 || item.played_ms > 0.0 {
                ceiling
                    .min(item.played_ms + TRUNCATE_SLACK_MS)
                    .floor()
                    .max(0.0) as i64
            } else {
                0
            };
            state.send(json!({
                "type": "conversation.item.truncate",
                "item_id": item.item_id,
                "content_index": 0,
                "audio_end_ms": audio_end_ms,
            }));
            if let Some(response_id) = state.item_response_ids.remove(&item.item_id) {
                state.abandoned_response_ids.insert(response_id);
            }
            state.generated_ms_by_item.remove(&item.item_id);
        }
        if let Some(active) = state.active_response_id.clone().filter(|a| !a.is_empty()) {
            state.abandoned_response_ids.insert(active);
        }

        // Bounded: only recent turns matter, and a long call would otherwise grow this
        // set for every interruption.
        while state.abandoned_response_ids.len() > 32 {
            state.abandoned_response_ids.shift_remove_index(0);
        }
        state.current_item_id = None;
    }

    /// Return a tool result to the model and let it continue speaking.
    pub fn send_function_output(&self, call_id: &str, output: &str) {
        self.send(json!({
            "type": "conversation.item.create",
            "item": { "type": "function_call_output", "call_id": call_id, "output": output },
        }));
        // The model does not resume on its own after a tool result — even with automatic
        // turn detection, a function_call_output needs an explicit response.create or the
        // answer never gets spoken.
        self.request_response();
    }

    /// Inject context the model should know but nobody said out loud (e.g. "you
    /// have just been admitted to the meeting").
    pub fn send_context(&self, text: &str) {
        self.send(json!({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": text }],
            },
        }));
    }

    /// Show the model a picture of what the browser is showing.
    ///
    /// A user item rather than a tool result, because a `function_call_output` carries a
    /// string. Create it before that output, since the output asks for the response.
    ///
    /// The item carries no audio, so `is_spoken_turn` is false and the addressed gate's
    /// window skips it. A screenshot is not something anybody said.
    pub fn send_image(&self, image_url: &str, note: &str) {
        self.send(json!({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [
                    { "type": "input_image", "image_url": image_url },
                    { "type": "input_text", "text": note },
                ],
            },
        }));
    }

    /// Put a recording of the user's own screen in front of the model: the pictures in the
    /// order they were taken, and the words said over them.
    ///
    /// One item per window rather than one for the whole recording. A window's audio is
    /// around two megabytes of base64 where five minutes in a single event would be twenty,
    /// and keeping each window together is what tells the model which words go with which
    /// picture — the thing a recording has that a shared screen does not.
    ///
    /// The label rides in the same item as the audio on purpose: every segment then carries
    /// a part that is not audio, which is how `is_spoken_turn` tells a recording from somebody
    /// talking.
    pub fn send_recording(&self, segments: &[RecordingSegment], note: &str) {
        self.send_context(note);
        for segment in segments {
            let mut content = vec![json!({
                "type": "input_text",
                "text": format!("At {}:", segment.label),
            })];
            for image in &segment.images {
                content.push(json!({ "type": "input_image", "image_url": image }));
            }
            if !segment.audio.is_empty() {
                content.push(json!({
                    "type": "input_audio",
                    "audio": base64::engine::general_purpose::STANDARD.encode(&segment.audio),
                }));
            }
            self.send(json!({
                "type": "conversation.item.create",
                "item": { "type": "message", "role": "user", "content": content },
            }));
        }
    }

    /// Tell the transcriber which names to expect, mid-call.
    ///
    /// The roster changes while the call runs — people join and leave — and the whole
    /// value of these hints is that they name the *current* room. Sent as a partial
    /// `session.update`, which merges rather than replacing, so nothing else about the
    /// session has to be restated here (restating it would risk resetting turn
    /// detection under a live conversation).
    ///
    /// Silently a no-op before the socket opens; the connect-time config already
    /// carries the agent's own name, which is the one that matters most. Also a no-op
    /// when the transcript is not being written down — this would otherwise re-enable
    /// transcription on the roster poll for a call that had deliberately switched it
    /// off, and start billing per minute for words nothing reads.
    pub fn set_transcription_keywords(&self, keywords: &[String]) {
        if !self.is_open() || keywords.is_empty() {
            return;
        }
        if !transcript_log::full() {
            return;
        }
        self.send(json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "audio": {
                    "input": {
                        "transcription": {
                            "model": session_settings().transcription_model,
                            "keywords": keywords,
                        },
                    },
                },
            },
        }));
    }

    /// Write one frame to the socket, when it is open.
    fn send(&self, payload: Value) {
        self.state.lock().send(payload);
    }

    #[cfg(test)]
    fn count_handled_frame(&self) {
        self.state
            .lock()
            .frames_handled
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// Frames written to the socket and frames read and handled, in that order.
    #[cfg(test)]
    pub(crate) fn frame_counts(&self) -> (usize, usize) {
        let state = self.state.lock();
        (
            state.frames_sent.load(std::sync::atomic::Ordering::SeqCst),
            state
                .frames_handled
                .load(std::sync::atomic::Ordering::SeqCst),
        )
    }

    pub fn is_open(&self) -> bool {
        let state = self.state.lock();
        state.open && !state.closed
    }

    /// Close the socket with 1000 (normal closure) and give up on waiting probes.
    pub fn close(&self) {
        let outbound = {
            let mut state = self.state.lock();
            if state.closed {
                return;
            }
            state.closed = true;
            state.open = false;
            state.outbound.take()
        };
        self.settle_all_probes();
        // 1000 = normal closure; anything else shows up as an error in OpenAI's logs.
        let Some(outbound) = outbound else {
            return;
        };
        let _ = outbound.send(Message::Close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "meeting ended".into(),
        })));
        // A server that never answers the close is dropped after a while, as a WebSocket
        // client drops it, and the close is reported then.
        let weak = self.this.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(CLOSE_TIMEOUT_MS)).await;
            let Some(session) = weak.upgrade() else {
                return;
            };
            let Some(reader) = session.state.lock().reader.take() else {
                return;
            };
            reader.abort();
            session.socket_closed(1006, String::new());
        });
    }
}

/// `JSON.stringify(value ?? {})`.
fn json_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(value) if !value.is_null() => value.to_string(),
        _ => "{}".to_string(),
    }
}

#[cfg(test)]
pub(crate) mod tests;
