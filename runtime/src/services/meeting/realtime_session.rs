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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use bytes::Bytes;
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::services::meeting::audio_playback::PlaybackSnapshot;
use crate::services::meeting::openai_endpoint::RealtimeEndpoint;

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

#[derive(Debug, Clone, Default)]
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
}

pub struct RealtimeSession {
    options: RealtimeSessionOptions,
    listeners: RwLock<Vec<RealtimeSessionListener>>,
    state: Mutex<SessionState>,
}

impl RealtimeSession {
    pub fn new(options: RealtimeSessionOptions) -> Arc<Self> {
        let tools = options.tools.clone();
        Arc::new(Self {
            options,
            listeners: RwLock::new(Vec::new()),
            state: Mutex::new(SessionState {
                outbound: None,
                open: false,
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
            }),
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
        todo!()
    }

    /// Send the session configuration: instructions, audio formats, tools, VAD.
    fn configure_session(&self) {
        todo!()
    }

    /// Replace the tools the model can call, mid-call. A partial `session.update`
    /// merges, so the rest of the session is unchanged; a reconnect sends these too.
    pub fn set_tools(&self, tools: Vec<RealtimeFunctionTool>) {
        todo!()
    }

    fn handle_message(&self, data: &str) {
        todo!()
    }

    /// Append captured meeting audio (pcm16 mono @24 kHz) to the input buffer.
    pub fn send_audio(&self, pcm24k: &[u8]) {
        todo!()
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
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Remember a response as a probe's, dropping only entries too old to be live.
    ///
    /// Deliberately never evicts by count: an entry forgotten while its response is
    /// still generating is one whose tool calls stop being recognised as a probe's.
    fn remember_probe_response(state: &mut SessionState, response_id: &str, send_id: &str) {
        let now = crate::support::now_ms();
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
        let at = crate::support::now_ms();
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
        let now = crate::support::now_ms();
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
    fn response_created_watchdog(&self) {
        todo!()
    }

    /// Abandon the in-flight response and tell the model how much of it was
    /// actually heard, so its context matches the room's experience.
    ///
    /// `played_ms` must be what reached the meeting, not what was received — audio
    /// deltas arrive far faster than real time.
    pub fn interrupt(&self, items: &[PlaybackSnapshot]) {
        todo!()
    }

    /// Return a tool result to the model and let it continue speaking.
    pub fn send_function_output(&self, call_id: &str, output: &str) {
        todo!()
    }

    /// Inject context the model should know but nobody said out loud (e.g. "you
    /// have just been admitted to the meeting").
    pub fn send_context(&self, text: &str) {
        todo!()
    }

    /// Show the model a picture of what the browser is showing.
    ///
    /// A user item rather than a tool result, because a `function_call_output` carries a
    /// string. Create it before that output, since the output asks for the response.
    ///
    /// The item carries no audio, so `is_spoken_turn` is false and the addressed gate's
    /// window skips it. A screenshot is not something anybody said.
    pub fn send_image(&self, image_url: &str, note: &str) {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Write one frame to the socket, when it is open.
    fn send(&self, payload: Value) {
        todo!()
    }

    pub fn is_open(&self) -> bool {
        let state = self.state.lock();
        state.open && !state.closed
    }

    /// Close the socket with 1000 (normal closure) and give up on waiting probes.
    pub fn close(&self) {
        todo!()
    }
}
