//! One dictation: the client's microphone in, the words it heard out, and nothing spoken back.
//!
//! A dictation is a Realtime session on the same managed endpoint and model voice chat uses,
//! and Mirantis Agent Platform meters it there. Turn detection is off and no response is ever asked for,
//! so the only usage it produces is the transcription: the buffer holds everything the client
//! sent until the client commits it, and the one transcript of that one item is the result.
//!
//! It takes no part in `VOICE_SESSION_LOCK`. The agent speaks nothing in a dictation, so a
//! dictation on one socket runs while a voice chat or a meeting holds the agent's voice.
//!
//! Every method is safe in every state. The client streams from the moment the user presses,
//! which is before the upstream has answered, so audio and a commit that arrive while the
//! session is connecting wait for it, and a cancel ends it wherever it is.

use std::sync::{Arc, Weak};
use std::time::Duration;

use base64::Engine;
use futures::{SinkExt, StreamExt};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::lib::telemetry::track_event;
use crate::log_warn;
use crate::services::meeting::audio_playback::clock_ms;
use crate::services::meeting::openai_endpoint::{
    RealtimeEndpoint, build_realtime_socket_options, connect_realtime_socket, handshake_status,
    resolve_realtime_endpoint, url_host,
};
use crate::services::meeting::realtime_usage::{
    RealtimePurpose, RealtimeSpend, record_realtime_usage,
};
use crate::services::meeting::resampler::REALTIME_SAMPLE_RATE;
use crate::services::voice::socket_audio::{is_audio_frame_usable, max_frame_bytes};
use crate::support::js::round as js_round;

/// Five minutes. Past it the session transcribes what it has, as if committed: by the audio
/// received, and by the clock, for a client that stops sending without letting go.
const MAX_AUDIO_MS: u64 = 5 * 60_000;

/// How long the upstream has to open and accept the configuration.
const CONNECT_TIMEOUT_MS: u64 = 10_000;

/// How long a committed buffer has to come back as a transcript.
const RESULT_TIMEOUT_MS: u64 = 30_000;

/// The shortest buffer the Realtime API commits. A shorter one is refused with an error, and
/// a press that short has no words in it, so the session answers an empty transcript itself.
const MIN_COMMIT_MS: usize = 100;

/// How the session answers the client that asked for it.
pub trait DictationSignal: Send + Sync {
    /// The upstream accepted the session; audio the client sends now is transcribed.
    fn ready(&self);
    /// Text of the transcript so far, in pieces, as the transcriber produces it.
    fn delta(&self, text: &str);
    /// The whole transcript. Empty when the recording had no speech in it.
    fn result(&self, text: &str);
    fn error(&self, message: &str);
}

#[derive(Clone)]
pub struct DictationSessionOptions {
    pub user_id: String,
    pub signal: Arc<dyn DictationSignal>,
    /// Called once, when the session has ended by any path.
    pub on_end: Option<Arc<dyn Fn() + Send + Sync>>,
    /// A local server in tests; the managed endpoint otherwise.
    pub endpoint_override: Option<RealtimeEndpoint>,
    /// The limits below are shortened by tests only.
    pub max_audio_ms: Option<u64>,
    pub connect_timeout_ms: Option<u64>,
    pub result_timeout_ms: Option<u64>,
}

/// How a dictation ended, as telemetry reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DictationOutcome {
    Transcribed,
    Empty,
    Cancelled,
    Failed,
    Disconnected,
}

impl DictationOutcome {
    fn as_str(self) -> &'static str {
        match self {
            DictationOutcome::Transcribed => "transcribed",
            DictationOutcome::Empty => "empty",
            DictationOutcome::Cancelled => "cancelled",
            DictationOutcome::Failed => "failed",
            DictationOutcome::Disconnected => "disconnected",
        }
    }
}

/// Why a client ended a dictation it no longer wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DictationCancelReason {
    #[default]
    Cancelled,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Connecting,
    Recording,
    Transcribing,
    Ended,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Connecting => "connecting",
            State::Recording => "recording",
            State::Transcribing => "transcribing",
            State::Ended => "ended",
        }
    }
}

/// Bytes of pcm16 mono audio per millisecond at the Realtime rate.
const BYTES_PER_MS: usize = (REALTIME_SAMPLE_RATE as usize * 2) / 1000;

struct DictationState {
    state: State,
    /// Frames to the socket's writer task; `None` until connected and after the end.
    outbound: Option<mpsc::UnboundedSender<Message>>,
    /// Frames the client sent before the upstream was ready, in order.
    pending: Vec<String>,
    commit_requested: bool,
    audio_bytes: usize,
    transcript: String,
    timer: Option<AbortHandle>,
    /// Answers `start()` once the session is ready or over.
    ready: Option<oneshot::Sender<bool>>,
}

pub struct DictationSession {
    options: DictationSessionOptions,
    state: Mutex<DictationState>,
    /// Epoch ms.
    started_at: i64,
    spend: RealtimeSpend,
    max_audio_ms: u64,
    max_audio_bytes: usize,
    max_frame: usize,
    /// Cancelled when the session ends, so a connect in progress stops waiting.
    ended: CancellationToken,
    this: Weak<DictationSession>,
}

/// What a step decided to tell the client, said once the state lock is released.
enum Say {
    Ready,
    Delta(String),
    Result(String),
}

impl DictationSession {
    pub fn new(options: DictationSessionOptions) -> Arc<Self> {
        let max_audio_ms = options.max_audio_ms.unwrap_or(MAX_AUDIO_MS);
        Arc::new_cyclic(|this| Self {
            options,
            state: Mutex::new(DictationState {
                state: State::Idle,
                outbound: None,
                pending: Vec::new(),
                commit_requested: false,
                audio_bytes: 0,
                transcript: String::new(),
                timer: None,
                ready: None,
            }),
            started_at: clock_ms(),
            spend: RealtimeSpend::new(RealtimePurpose::Dictation, None),
            max_audio_ms,
            max_audio_bytes: max_audio_ms as usize * BYTES_PER_MS,
            max_frame: max_frame_bytes(REALTIME_SAMPLE_RATE),
            ended: CancellationToken::new(),
            this: this.clone(),
        })
    }

    /// Open the upstream and configure it. Answers `true` once the upstream is ready, and
    /// `false` when the session ended first, having told the client why if it failed.
    pub async fn start(self: &Arc<Self>) -> bool {
        let (ready_tx, ready_rx) = oneshot::channel();
        {
            let mut state = self.state.lock();
            if state.state != State::Idle {
                return false;
            }
            state.state = State::Connecting;
            state.ready = Some(ready_tx);
        }
        track_event(
            "dictation started",
            Some(&self.options.user_id),
            Some(IndexMap::new()),
        );

        let endpoint = match &self.options.endpoint_override {
            Some(endpoint) => endpoint.clone(),
            None => match resolve_realtime_endpoint(None) {
                Ok(endpoint) => endpoint,
                Err(err) => {
                    self.fail(&err.to_string());
                    return false;
                }
            },
        };
        let socket_options = build_realtime_socket_options(&endpoint);
        if self.state.lock().state != State::Connecting {
            return false;
        }

        self.arm(
            self.options
                .connect_timeout_ms
                .unwrap_or(CONNECT_TIMEOUT_MS),
            "The transcriber did not answer in time.",
        );

        let connected = tokio::select! {
            result = connect_realtime_socket(&endpoint.url, &socket_options) => result,
            _ = self.ended.cancelled() => return false,
        };
        let socket = match connected {
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
                if let Some(status) = handshake_status(&message) {
                    fields.insert("status".into(), Value::from(status));
                }
                log_warn!(Value::Object(fields), "[Dictation] Realtime socket error");
                self.fail("The transcriber closed the connection (code 1006).");
                return false;
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
        {
            let mut state = self.state.lock();
            if state.state == State::Ended {
                let _ = tx.send(Message::Close(None));
                return false;
            }
            state.outbound = Some(tx);
        }
        self.configure();

        let weak = self.this.clone();
        tokio::spawn(async move {
            let mut code = 1006u16;
            while let Some(item) = stream.next().await {
                let Some(session) = weak.upgrade() else {
                    return;
                };
                match item {
                    Ok(Message::Text(text)) => session.handle_event(text.as_str()),
                    Ok(Message::Binary(data)) => {
                        session.handle_event(&String::from_utf8_lossy(&data))
                    }
                    Ok(Message::Close(frame)) => {
                        code = frame.map(|f| u16::from(f.code)).unwrap_or(1005);
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            let Some(session) = weak.upgrade() else {
                return;
            };
            if session.state.lock().state != State::Ended {
                session.fail(&format!(
                    "The transcriber closed the connection (code {code})."
                ));
            }
            session.resolve_start(false);
        });

        tokio::select! {
            ready = ready_rx => ready.unwrap_or(false),
            _ = self.ended.cancelled() => false,
        }
    }

    /// One frame of the client's microphone, pcm16 mono at the Realtime rate.
    pub fn push_audio(&self, pcm: &[u8]) {
        let reached_cap = {
            let mut state = self.state.lock();
            if state.state != State::Connecting && state.state != State::Recording {
                return;
            }
            if state.commit_requested {
                return;
            }
            if !is_audio_frame_usable(pcm, self.max_frame) {
                return;
            }
            state.audio_bytes += pcm.len();
            Self::send(
                &mut state,
                json!({
                    "type": "input_audio_buffer.append",
                    "audio": base64::engine::general_purpose::STANDARD.encode(pcm),
                }),
            );
            state.audio_bytes >= self.max_audio_bytes
        };
        // The cap stands in for the client's release, so a client that never lets go still
        // gets its words back rather than a session held open for as long as the socket.
        if reached_cap {
            self.commit();
        }
    }

    /// Transcribe everything recorded so far, then end.
    pub fn commit(&self) {
        let too_short = {
            let mut state = self.state.lock();
            if state.state != State::Connecting && state.state != State::Recording {
                return;
            }
            if state.commit_requested {
                return;
            }
            state.commit_requested = true;
            if state.audio_bytes < MIN_COMMIT_MS * BYTES_PER_MS {
                true
            } else {
                Self::send(&mut state, json!({ "type": "input_audio_buffer.commit" }));
                if state.state == State::Recording {
                    self.begin_transcribing(&mut state);
                }
                false
            }
        };
        if too_short {
            self.options.signal.result("");
            self.end(DictationOutcome::Empty);
        }
    }

    /// Drop the recording. Nothing is transcribed and nothing is sent back.
    pub fn cancel(&self, reason: DictationCancelReason) {
        if self.state.lock().state == State::Ended {
            return;
        }
        self.end(match reason {
            DictationCancelReason::Cancelled => DictationOutcome::Cancelled,
            DictationCancelReason::Disconnected => DictationOutcome::Disconnected,
        });
    }

    /// Send the session configuration: text output only, pcm16 at the Realtime rate, turn
    /// detection off so the buffer holds the whole recording until the client commits it,
    /// and transcription with `OPENAI_TRANSCRIPTION_MODEL` and no language, since a dictation
    /// is one speaker for seconds and the transcriber detects the language.
    fn configure(&self) {
        let state = self.state.lock();
        let Some(outbound) = &state.outbound else {
            return;
        };
        let update = json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                // Text, never audio: nothing in a dictation is spoken, and no response is
                // requested, so this only keeps the session from preparing a voice.
                "output_modalities": ["text"],
                "audio": {
                    "input": {
                        "format": { "type": "audio/pcm", "rate": REALTIME_SAMPLE_RATE },
                        // Off, so the buffer holds the whole recording until the client
                        // commits it. A detector would split a dictation at every pause into
                        // items the client never asked for, and answer each with a response.
                        "turn_detection": null,
                        "transcription": { "model": CONFIG.openai_transcription_model },
                    },
                },
            },
        });
        let _ = outbound.send(Message::text(update.to_string()));
    }

    /// Handle one upstream frame: `session.updated` makes a connecting session ready,
    /// transcription deltas reach the client as they arrive, the completed transcript ends
    /// it, and a failed transcription or an error fails it.
    fn handle_event(&self, data: &str) {
        let event: Value = match serde_json::from_str(data) {
            Ok(event) => event,
            Err(_) => {
                log_warn!("[Dictation] Unparseable Realtime frame");
                return;
            }
        };
        let was_connecting = self.state.lock().state == State::Connecting;

        match event.get("type").and_then(Value::as_str) {
            Some("session.updated") => {
                if self.state.lock().state == State::Connecting {
                    self.become_ready();
                }
            }

            Some("conversation.item.input_audio_transcription.delta") => {
                let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() {
                    return;
                }
                self.state.lock().transcript.push_str(delta);
                self.say(Say::Delta(delta.to_string()));
            }

            Some("conversation.item.input_audio_transcription.completed") => {
                record_realtime_usage(
                    &self.spend,
                    &CONFIG.openai_transcription_model,
                    event.get("usage"),
                );
                let text = match event.get("transcript").and_then(Value::as_str) {
                    Some(text) => text.to_string(),
                    None => self.state.lock().transcript.clone(),
                };
                let trimmed = crate::support::js::trim(&text).to_string();
                let empty = trimmed.is_empty();
                self.say(Say::Result(trimmed));
                self.end(if empty {
                    DictationOutcome::Empty
                } else {
                    DictationOutcome::Transcribed
                });
            }

            Some("conversation.item.input_audio_transcription.failed") => {
                let message = event
                    .get("error")
                    .and_then(|err| err.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.is_empty());
                self.fail(&match message {
                    Some(message) => format!("Transcription failed: {message}"),
                    None => "Transcription failed.".to_string(),
                });
            }

            Some("error") => {
                let message = event
                    .get("error")
                    .and_then(|err| err.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("The transcriber reported an error.")
                    .to_string();
                self.fail(&message);
            }

            _ => {}
        }

        let state = self.state.lock().state;
        if was_connecting && state != State::Connecting {
            self.resolve_start(state != State::Ended);
        }
    }

    /// The upstream accepted the configuration: send what waited, then record, with a clock
    /// that commits after the maximum length for a client that stopped sending.
    fn become_ready(&self) {
        self.disarm();
        let (tell_ready, commit_requested) = {
            let mut state = self.state.lock();
            state.state = State::Recording;
            let commit_requested = state.commit_requested;
            let pending: Vec<String> = state.pending.drain(..).collect();
            if let Some(outbound) = &state.outbound {
                for frame in pending {
                    let _ = outbound.send(Message::text(frame));
                }
            }
            if commit_requested {
                self.begin_transcribing(&mut state);
            } else {
                // The audio cap in `push_audio` counts bytes, which a client that stopped
                // sending never reaches. The clock ends that recording too, instead of
                // holding a Realtime session for as long as the chat socket stays open.
                let weak = self.this.clone();
                let ms = self.max_audio_ms;
                let timer = tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    if let Some(session) = weak.upgrade() {
                        session.commit();
                    }
                });
                state.timer = Some(timer.abort_handle());
            }
            (!commit_requested, commit_requested)
        };
        let _ = commit_requested;
        // A client that already let go needs no confirmation that recording can start.
        if tell_ready {
            self.say(Say::Ready);
        }
    }

    /// The buffer is committed; wait for its transcript up to the result timeout.
    fn begin_transcribing(&self, state: &mut DictationState) {
        state.state = State::Transcribing;
        self.arm_locked(
            state,
            self.options.result_timeout_ms.unwrap_or(RESULT_TIMEOUT_MS),
            "The transcript did not arrive in time.",
        );
    }

    /// Send now when the upstream is ready, or queue it until it is.
    fn send(state: &mut DictationState, event: Value) {
        let frame = event.to_string();
        if state.state == State::Connecting {
            state.pending.push(frame);
            return;
        }
        if let Some(outbound) = &state.outbound {
            let _ = outbound.send(Message::text(frame));
        }
    }

    /// Fail the session with `message` after `ms` unless disarmed first.
    fn arm(&self, ms: u64, message: &'static str) {
        let mut state = self.state.lock();
        self.arm_locked(&mut state, ms, message);
    }

    fn arm_locked(&self, state: &mut DictationState, ms: u64, message: &'static str) {
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        let weak = self.this.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if let Some(session) = weak.upgrade() {
                session.fail(message);
                session.resolve_start(false);
            }
        });
        state.timer = Some(timer.abort_handle());
    }

    fn disarm(&self) {
        if let Some(timer) = self.state.lock().timer.take() {
            timer.abort();
        }
    }

    /// Tell the client what went wrong and end. Logs `[Dictation] {message}` at warn with the
    /// state it failed in.
    fn fail(&self, message: &str) {
        let state = self.state.lock().state;
        if state == State::Ended {
            return;
        }
        log_warn!(
            json!({ "state": state.as_str() }),
            "[Dictation] {}",
            message
        );
        self.options.signal.error(message);
        self.end(DictationOutcome::Failed);
    }

    /// End once: close the upstream, emit `dictation finished` with the outcome, the audio's
    /// length and the elapsed time, and call `on_end`.
    fn end(&self, outcome: DictationOutcome) {
        let audio_bytes = {
            let mut state = self.state.lock();
            if state.state == State::Ended {
                return;
            }
            state.state = State::Ended;
            if let Some(timer) = state.timer.take() {
                timer.abort();
            }
            state.pending.clear();
            if let Some(outbound) = state.outbound.take() {
                let _ = outbound.send(Message::Close(None));
            }
            state.audio_bytes
        };
        self.ended.cancel();
        let mut props = IndexMap::new();
        props.insert("status".to_string(), outcome.as_str().to_string());
        props.insert(
            "audio_ms".to_string(),
            (js_round(audio_bytes as f64 / BYTES_PER_MS as f64) as i64).to_string(),
        );
        props.insert(
            "elapsed_ms".to_string(),
            (clock_ms() - self.started_at).to_string(),
        );
        track_event(
            "dictation finished",
            Some(&self.options.user_id),
            Some(props),
        );
        if let Some(on_end) = &self.options.on_end {
            on_end();
        }
    }

    /// Answer the `start()` still waiting, if one is.
    fn resolve_start(&self, ready: bool) {
        if let Some(tx) = self.state.lock().ready.take() {
            let _ = tx.send(ready);
        }
    }

    fn say(&self, what: Say) {
        match what {
            Say::Ready => self.options.signal.ready(),
            Say::Delta(text) => self.options.signal.delta(&text),
            Say::Result(text) => self.options.signal.result(&text),
        }
    }
}

#[cfg(test)]
mod tests;
