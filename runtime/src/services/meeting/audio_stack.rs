//! The virtual audio devices that let a browser talk to a program.
//!
//! Chrome will only send audio it captured from a microphone and will only play
//! audio to a speaker, so the bot needs both — as software. PulseAudio null-sinks
//! provide them:
//!
//! ```text
//!   meet_out          a sink Chrome plays the meeting into. Its `.monitor` source
//!                     is what `parec` records, giving us everything the room says.
//!   bot_speak         a sink we play the model's speech into...
//!   bot_mic           ...remapped from `bot_speak.monitor` into a *source*, which
//!                     is what Chrome sees as a microphone. (A monitor source can
//!                     technically be captured directly, but Chrome filters monitor
//!                     devices out of its microphone list, so the remap is required
//!                     rather than cosmetic.)
//! ```
//!
//! Xvfb is here for a related reason: Meet's WebRTC path is markedly less reliable
//! under `--headless` than in a real rendered browser, so Chrome runs normally on a
//! virtual display instead.
//!
//! Everything is per-meeting and private: its own PulseAudio daemon with its own
//! runtime dir, so nothing is shared with a host daemon (there isn't one in the
//! container) and teardown is unambiguous — kill the daemon, the devices are gone.

use std::path::PathBuf;
use std::sync::Arc;

use bytes::Bytes;
use indexmap::IndexMap;
use parking_lot::Mutex;
use tokio::process::Child;

use crate::services::meeting::audio_playback::PlaybackSink;

/// Device names inside our private daemon. Fixed — the daemon is not shared.
const MEET_OUT_SINK: &str = "meet_out";
const BOT_SPEAK_SINK: &str = "bot_speak";
const BOT_MIC_SOURCE: &str = "bot_mic";

/// How long to wait for the daemon's socket before giving up.
const DAEMON_READY_TIMEOUT_MS: u64 = 10_000;

/// Gap between reads while waiting for the browser to open the virtual mic.
const MIC_CAPTURE_POLL_MS: u64 = 500;

/// Is anything capturing this source, per `pactl list short sources`?
///
/// A separate pure function because the value is in the parsing: the interesting
/// answer ("has the browser actually opened the microphone?") is one word at the end
/// of a tab-separated line, and a test can pin that against real `pactl` output
/// without a PulseAudio daemon, which is the only way this gets covered at all.
///
/// Fields are split on whitespace rather than tabs — `pactl` has emitted both, and the
/// sample spec in the middle ("s16le 1ch 48000Hz") is what makes a naive tab split
/// look like it works. The name is the second field and the state is the last, which
/// holds under either separator.
pub fn source_is_running(pactl_short_sources: &str, source_name: &str) -> bool {
    for line in pactl_short_sources.split('\n') {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 || fields[1] != source_name {
            continue;
        }
        // RUNNING means a client is reading it; IDLE and SUSPENDED both mean nobody is.
        return fields[fields.len() - 1].to_uppercase() == "RUNNING";
    }
    false
}

/// The virtual display's geometry, which anything that grabs the screen needs too.
///
/// Full HD, the same size the agent's computer reserves, so one desktop size serves both
/// callers. A meeting uses it as it is; the computer crops it to what the client shows.
pub const VIRTUAL_DISPLAY_SIZE: &str = "1920x1080";

/// What `start()` reserves when the caller names no size.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AudioStackOptions {
    /// The screen the X server reserves, e.g. `2560x1440`.
    ///
    /// A framebuffer is allocated once and cannot grow, so a caller that resizes its screen
    /// while it runs reserves the largest it will ever want and crops down to what it is
    /// using. A meeting never resizes and reserves what it needs.
    pub screen: Option<String>,
}

/// Receives meeting audio, 48 kHz pcm16 mono.
pub type CaptureHandler = Arc<dyn Fn(Bytes) + Send + Sync>;

/// Receives the reason capture or playback died.
pub type LostHandler = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone)]
pub struct AudioStackHandles {
    /// Env vars Chrome needs to use the virtual devices and display: `DISPLAY`,
    /// `XDG_RUNTIME_DIR`, `PULSE_RUNTIME_PATH`, `PULSE_SINK` (`meet_out`, which Chrome
    /// plays into) and `PULSE_SOURCE` (`bot_mic`, which it records from).
    pub browser_env: IndexMap<String, String>,
    /// Meeting audio, 48 kHz pcm16 mono — feed to the conversation.
    pub on_capture: Arc<dyn Fn(CaptureHandler) + Send + Sync>,
    /// Called once if capture or playback dies while the stack is meant to be running.
    ///
    /// There is no recovery inside the stack: a dead `parec` means nothing the room
    /// says will ever reach a model again, and a dead `pacat` means nothing the model
    /// says will ever be heard, so the owner ends the call rather than leave a
    /// participant that has silently stopped taking part. Fires immediately if the
    /// loss happened before a handler was registered.
    pub on_lost: Arc<dyn Fn(LostHandler) + Send + Sync>,
    /// Sink for the model's speech, 48 kHz pcm16 mono.
    ///
    /// No backpressure handling needed: `AudioPlayback` paces writes to stay a fixed,
    /// small distance ahead of real time, so the pipe never fills. (An earlier version
    /// did wait for the pipe to drain, which both destroyed interruption latency — a full
    /// pipe holds ~680ms of speech — and could hang forever if pacat died while the pipe
    /// was full.) A frame written after `pacat` died is dropped: audio is realtime, and a
    /// retry would arrive too late to matter.
    pub playback_sink: Arc<dyn PlaybackSink>,
}

struct AudioStackState {
    pulse: Option<Child>,
    xvfb: Option<Child>,
    parec: Option<Child>,
    pacat: Option<Child>,
    runtime_dir: Option<PathBuf>,
    display: Option<String>,
    capture_handler: Option<CaptureHandler>,
    lost_handler: Option<LostHandler>,
    /// Kept so a loss that beats the handler's registration still gets reported.
    lost_reason: Option<String>,
    stopped: bool,
    /// The screen the X server reserves; see `AudioStackOptions`.
    screen: String,
}

/// Owns the display and audio processes for one meeting.
///
/// `start()` is all-or-nothing: a partial failure tears down whatever came up, so a
/// failed join can't leak a daemon or an X server.
pub struct AudioStack {
    state: Arc<Mutex<AudioStackState>>,
}

impl Default for AudioStack {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioStack {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(AudioStackState {
                pulse: None,
                xvfb: None,
                parec: None,
                pacat: None,
                runtime_dir: None,
                display: None,
                capture_handler: None,
                lost_handler: None,
                lost_reason: None,
                stopped: false,
                screen: VIRTUAL_DISPLAY_SIZE.to_string(),
            })),
        }
    }

    /// Bring up Xvfb, the PulseAudio daemon, its devices, and the audio pipes.
    ///
    /// The runtime dir is a fresh `prism-meeting-*` directory under the system temp dir.
    pub async fn start(&self, options: AudioStackOptions) -> anyhow::Result<AudioStackHandles> {
        todo!()
    }

    /// Start Xvfb on a free display.
    ///
    /// `-displayfd` has the server report the display number it actually took,
    /// which avoids racing another process for a hard-coded `:99`. Run as
    /// `Xvfb -displayfd 1 -screen 0 {screen}x24 -nolisten tcp`; the number is read off
    /// stdout as `^(\d+)\n`, anchored and newline-terminated, since matching a bare digit
    /// run would resolve `:1` from the first fragment of a display number delivered in
    /// pieces. Fails with `Xvfb did not report a display in time`,
    /// `Xvfb failed to start (is it installed?): {message}` or `Xvfb exited with code {code}`.
    async fn start_xvfb(&self) -> anyhow::Result<String> {
        todo!()
    }

    /// Start a private PulseAudio daemon.
    ///
    /// `-n` skips the system config (we load exactly the modules we need),
    /// `--exit-idle-time=-1` stops it shutting down between clients, and
    /// `--disallow-exit` keeps a client from taking it down with us still using it.
    /// Readiness is `pactl info` answering, polled every 200 ms, rather than a fixed
    /// sleep. Fails with `PulseAudio exited immediately: {stderr or code}` or
    /// `PulseAudio did not become ready: {message}`.
    async fn start_pulse(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Create the two null-sinks and remap one into a capture source for Chrome.
    ///
    /// Chrome hides monitor sources from its microphone list, so the bot's speech has to
    /// be re-presented as a real source. The defaults are set too, since Chrome reads them
    /// when `PULSE_SINK`/`PULSE_SOURCE` aren't honoured by a given code path (its audio
    /// backend has more than one).
    async fn create_devices(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Record the meeting from meet_out's monitor and hand chunks to the loop.
    ///
    /// `--latency-msec=20`: a short latency keeps the model's sense of "now" close to the
    /// room's.
    fn start_capture(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Play the model's speech into bot_speak, which Chrome hears as its mic.
    ///
    /// `--latency-msec` is `SINK_BUFFER_MS`: deep enough that a stalled scheduler can't
    /// starve the device mid-word, and equal to the figure playback estimates what the
    /// room has actually heard by.
    fn start_playback(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Wait until the browser is actually reading the virtual microphone.
    ///
    /// The device half of "can the room hear us", which is all this layer can answer. A
    /// meeting platform's own UI can report a live microphone over a capture device the
    /// browser never opened; those are two different systems, and only this one is ours.
    /// `bot_mic` going RUNNING means a client holds the source open, which for this
    /// private daemon can only be the browser — our own `parec` records the meeting sink's
    /// monitor, a different device, so this reading can't be contaminated by our capture.
    ///
    /// What it does **not** prove is that the room can hear us: WebRTC mute disables the
    /// track rather than closing the device, so a muted-but-open microphone still reads
    /// RUNNING. This answers "did a capture device ever open" — the provider answers
    /// whether the platform is transmitting it, because the provider owns the page and
    /// this owns the devices.
    ///
    /// Polled rather than awaited on an event because PulseAudio offers no such event to
    /// a shell client, and it is genuinely a wait: the browser opens the device a moment
    /// after an unmute lands. `false` on timeout rather than an error — what an unheard
    /// agent is worth is the caller's judgement, not this layer's. The timeout logs
    /// `[Meeting] bot_mic is still not being captured after {timeout_ms}ms`, with
    /// ` (last read failed: {failure})` when the last read failed.
    pub async fn wait_for_mic_capture(&self, timeout_ms: u64) -> bool {
        todo!()
    }

    /// One read of the same question, for a caller that will ask again anyway.
    ///
    /// The mid-call unmute retry runs every ten seconds for the length of a call, so it
    /// wants the reading without the waiting and — more to the point — without the warning
    /// line, which `wait_for_mic_capture` is right to log once on a join and would be wrong to
    /// log a hundred times on one meeting.
    pub async fn is_mic_captured(&self) -> bool {
        todo!()
    }

    /// Is anything reading `bot_mic` right now, and if the question failed, why.
    ///
    /// A failure is anomalous rather than expected: `start()` already ran a dozen `pactl`
    /// calls, so one failing now is worth reporting even though every caller retries.
    async fn read_mic_capture(&self) -> (bool, Option<String>) {
        todo!()
    }

    /// Record the first unexpected death of capture or playback and tell the owner.
    ///
    /// Once only: `stop()` kills both, so the second exit is our own doing, and a
    /// teardown already under way must not be told twice about a stack it is
    /// dismantling. Logs `[Meeting] Audio stack lost: {reason}` at error.
    fn note_loss(&self, reason: String) {
        todo!()
    }

    /// Run `pactl` against the private daemon and answer its stdout.
    async fn pactl(&self, args: &[&str]) -> anyhow::Result<String> {
        todo!()
    }

    /// Stop every process and remove the runtime dir.
    ///
    /// Ordered from client to daemon so nothing logs an error about a socket that
    /// disappeared underneath it: SIGTERM to `parec`, `pacat`, the daemon and Xvfb, 300 ms
    /// to exit cleanly, then SIGKILL to whatever is left. Idempotent, and never fails:
    /// teardown runs on the error path too, where a second failure would mask the first.
    pub async fn stop(&self) {
        todo!()
    }
}

/// Executables the audio/display stack needs on PATH.
pub const AUDIO_STACK_BINARIES: [&str; 5] = ["Xvfb", "pulseaudio", "pactl", "parec", "pacat"];
