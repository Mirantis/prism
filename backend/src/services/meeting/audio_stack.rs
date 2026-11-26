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
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use crate::lib::log_redaction::err_json;
use crate::services::meeting::audio_playback::{PlaybackSink, SINK_BUFFER_MS};
use crate::services::meeting::resampler::MEETING_SAMPLE_RATE;
use crate::{log_debug, log_error, log_warn};

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

/// One process of the stack, waited on by a task of its own.
struct StackProcess {
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    /// Asks the waiting task to kill the process outright.
    kill: mpsc::UnboundedSender<()>,
}

impl StackProcess {
    /// Take over `child`; `on_exit` runs with its exit code (`None` for a signal) once it
    /// has gone.
    fn track(mut child: Child, on_exit: impl FnOnce(Option<i32>) + Send + 'static) -> StackProcess {
        let pid = child.id();
        let exited = Arc::new(AtomicBool::new(false));
        let (kill, mut kill_requests) = mpsc::unbounded_channel::<()>();
        let flag = exited.clone();
        tokio::spawn(async move {
            let status = loop {
                tokio::select! {
                    status = child.wait() => break status,
                    Some(()) = kill_requests.recv() => {
                        let _ = child.start_kill();
                    }
                }
            };
            flag.store(true, Ordering::SeqCst);
            on_exit(status.ok().and_then(|status| status.code()));
        });
        StackProcess { pid, exited, kill }
    }

    fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    #[cfg(unix)]
    fn terminate(&self) -> anyhow::Result<()> {
        if let Some(pid) = self.pid {
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            )?;
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn terminate(&self) -> anyhow::Result<()> {
        let _ = self.kill.send(());
        Ok(())
    }

    fn force_kill(&self) {
        let _ = self.kill.send(());
    }
}

/// A process exit code as Node reports it: the number, or `null` for a signal.
fn code_text(code: Option<i32>) -> String {
    code.map(|code| code.to_string())
        .unwrap_or_else(|| "null".to_string())
}

struct AudioStackState {
    pulse: Option<StackProcess>,
    xvfb: Option<StackProcess>,
    parec: Option<StackProcess>,
    pacat: Option<StackProcess>,
    /// Writes to `pacat`'s stdin, in order, off the caller's thread.
    playback: Option<mpsc::UnboundedSender<Bytes>>,
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

/// The playback sink: one chunk at a time into `pacat`.
struct PacatSink {
    state: Arc<Mutex<AudioStackState>>,
}

impl PlaybackSink for PacatSink {
    fn write(&self, chunk: Bytes) -> anyhow::Result<()> {
        // A closed pipe drops the frame; see `AudioStackHandles::playback_sink`.
        if let Some(playback) = &self.state.lock().playback {
            let _ = playback.send(chunk);
        }
        Ok(())
    }
}

/// Record the first unexpected death of capture or playback and tell the owner.
///
/// Once only: `stop()` kills both, so the second exit is our own doing, and a
/// teardown already under way must not be told twice about a stack it is
/// dismantling. Logs `[Meeting] Audio stack lost: {reason}` at error.
fn note_loss(state: &Mutex<AudioStackState>, reason: String) {
    let handler = {
        let mut state = state.lock();
        if state.stopped || state.lost_reason.is_some() {
            return;
        }
        state.lost_reason = Some(reason.clone());
        state.lost_handler.clone()
    };
    log_error!("[Meeting] Audio stack lost: {}", reason);
    if let Some(handler) = handler {
        handler(reason);
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
                playback: None,
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
        self.state.lock().screen = options
            .screen
            .unwrap_or_else(|| VIRTUAL_DISPLAY_SIZE.to_string());
        let started = async {
            let runtime_dir = tempfile::Builder::new()
                .prefix("prism-meeting-")
                .tempdir()?
                .keep();
            self.state.lock().runtime_dir = Some(runtime_dir);
            let display = self.start_xvfb().await?;
            self.state.lock().display = Some(display);
            self.start_pulse().await?;
            self.create_devices().await?;
            self.start_capture()?;
            self.start_playback()?;
            anyhow::Ok(())
        }
        .await;
        if let Err(err) = started {
            self.stop().await;
            return Err(err);
        }

        let (display, runtime_dir) = {
            let state = self.state.lock();
            (
                state.display.clone().unwrap_or_default(),
                state.runtime_dir.clone().unwrap_or_default(),
            )
        };
        let mut browser_env = IndexMap::new();
        browser_env.insert("DISPLAY".to_string(), display);
        browser_env.insert(
            "XDG_RUNTIME_DIR".to_string(),
            runtime_dir.to_string_lossy().into_owned(),
        );
        browser_env.insert(
            "PULSE_RUNTIME_PATH".to_string(),
            runtime_dir.join("pulse").to_string_lossy().into_owned(),
        );
        // Chrome picks its devices from these rather than needing a UI choice:
        // it plays into meet_out and records from bot_mic.
        browser_env.insert("PULSE_SINK".to_string(), MEET_OUT_SINK.to_string());
        browser_env.insert("PULSE_SOURCE".to_string(), BOT_MIC_SOURCE.to_string());

        let capture_state = self.state.clone();
        let lost_state = self.state.clone();
        Ok(AudioStackHandles {
            browser_env,
            on_capture: Arc::new(move |handler| {
                capture_state.lock().capture_handler = Some(handler);
            }),
            on_lost: Arc::new(move |handler| {
                let reason = {
                    let mut state = lost_state.lock();
                    state.lost_handler = Some(handler.clone());
                    state.lost_reason.clone()
                };
                if let Some(reason) = reason {
                    handler(reason);
                }
            }),
            playback_sink: Arc::new(PacatSink {
                state: self.state.clone(),
            }),
        })
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
        static DISPLAY_NUMBER: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"^(\d+)\n").expect("valid regex"));

        // The reservation, not the size in use: a screen that resizes crops this one.
        let screen = format!("{}x24", self.state.lock().screen);
        let mut child = tokio::process::Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                &screen,
                "-nolisten",
                "tcp",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| anyhow::anyhow!("Xvfb failed to start (is it installed?): {err}"))?;

        let (display_tx, display_rx) = oneshot::channel::<String>();
        if let Some(mut stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut output = String::new();
                let mut buffer = [0u8; 256];
                let mut display_tx = Some(display_tx);
                loop {
                    match stdout.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            output.push_str(&String::from_utf8_lossy(&buffer[..read]));
                            if let Some(found) = DISPLAY_NUMBER.captures(&output)
                                && let Some(tx) = display_tx.take()
                            {
                                let _ = tx.send(format!(":{}", &found[1]));
                            }
                        }
                    }
                }
            });
        }

        let (exit_tx, exit_rx) = oneshot::channel::<Option<i32>>();
        let process = StackProcess::track(child, move |code| {
            let _ = exit_tx.send(code);
        });
        self.state.lock().xvfb = Some(process);

        let stopped = self.state.clone();
        tokio::select! {
            Ok(display) = display_rx => Ok(display),
            Ok(code) = exit_rx => {
                if stopped.lock().stopped {
                    anyhow::bail!("Xvfb did not report a display in time");
                }
                anyhow::bail!("Xvfb exited with code {}", code_text(code))
            }
            _ = tokio::time::sleep(Duration::from_millis(DAEMON_READY_TIMEOUT_MS)) => {
                anyhow::bail!("Xvfb did not report a display in time")
            }
        }
    }

    /// Env pointing PulseAudio clients at our private daemon.
    fn pulse_env(&self) -> anyhow::Result<[(String, String); 2]> {
        let Some(runtime_dir) = self.state.lock().runtime_dir.clone() else {
            anyhow::bail!("The audio stack has no runtime dir");
        };
        Ok([
            (
                "XDG_RUNTIME_DIR".to_string(),
                runtime_dir.to_string_lossy().into_owned(),
            ),
            (
                "PULSE_RUNTIME_PATH".to_string(),
                runtime_dir.join("pulse").to_string_lossy().into_owned(),
            ),
        ])
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
        let spawned = tokio::process::Command::new("pulseaudio")
            .args([
                "-n",
                "--daemonize=no",
                "--exit-idle-time=-1",
                "--disallow-exit",
                "--load=module-native-protocol-unix",
            ])
            .envs(self.pulse_env()?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn();

        let stderr = Arc::new(Mutex::new(String::new()));
        let exit_code: Arc<Mutex<Option<Option<i32>>>> = Arc::new(Mutex::new(None));
        match spawned {
            Ok(mut child) => {
                if let Some(mut pipe) = child.stderr.take() {
                    let stderr = stderr.clone();
                    tokio::spawn(async move {
                        let mut buffer = [0u8; 1024];
                        loop {
                            match pipe.read(&mut buffer).await {
                                Ok(0) | Err(_) => break,
                                Ok(read) => stderr
                                    .lock()
                                    .push_str(&String::from_utf8_lossy(&buffer[..read])),
                            }
                        }
                    });
                }
                let recorded = exit_code.clone();
                let process = StackProcess::track(child, move |code| {
                    *recorded.lock() = Some(code);
                });
                self.state.lock().pulse = Some(process);
            }
            Err(err) => {
                let err = anyhow::Error::from(err);
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Meeting] PulseAudio failed to spawn"
                );
            }
        }

        // Wait for the daemon to answer, rather than sleeping a fixed interval:
        // `pactl info` is the readiness check the socket's existence only approximates.
        let deadline = crate::support::now_ms() + DAEMON_READY_TIMEOUT_MS as i64;
        loop {
            if let Some(Some(code)) = *exit_code.lock() {
                let stderr = stderr.lock().clone();
                let detail = crate::support::js::trim(&stderr);
                if detail.is_empty() {
                    anyhow::bail!("PulseAudio exited immediately: code {code}");
                }
                anyhow::bail!("PulseAudio exited immediately: {detail}");
            }
            match self.pactl(&["info"]).await {
                Ok(_) => return Ok(()),
                Err(err) => {
                    if crate::support::now_ms() > deadline {
                        anyhow::bail!("PulseAudio did not become ready: {err}");
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }

    /// Create the two null-sinks and remap one into a capture source for Chrome.
    ///
    /// Chrome hides monitor sources from its microphone list, so the bot's speech has to
    /// be re-presented as a real source. The defaults are set too, since Chrome reads them
    /// when `PULSE_SINK`/`PULSE_SOURCE` aren't honoured by a given code path (its audio
    /// backend has more than one).
    async fn create_devices(&self) -> anyhow::Result<()> {
        let rate = format!("rate={MEETING_SAMPLE_RATE}");
        self.pactl(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={MEET_OUT_SINK}"),
            "sink_properties=device.description=MeetOutput",
            &rate,
            "channels=1",
        ])
        .await?;
        self.pactl(&[
            "load-module",
            "module-null-sink",
            &format!("sink_name={BOT_SPEAK_SINK}"),
            "sink_properties=device.description=BotSpeech",
            &rate,
            "channels=1",
        ])
        .await?;
        self.pactl(&[
            "load-module",
            "module-remap-source",
            &format!("source_name={BOT_MIC_SOURCE}"),
            &format!("master={BOT_SPEAK_SINK}.monitor"),
            "source_properties=device.description=BotMicrophone",
            "channels=1",
        ])
        .await?;
        self.pactl(&["set-default-sink", MEET_OUT_SINK]).await?;
        self.pactl(&["set-default-source", BOT_MIC_SOURCE]).await?;
        Ok(())
    }

    /// Record the meeting from meet_out's monitor and hand chunks to the loop.
    ///
    /// `--latency-msec=20`: a short latency keeps the model's sense of "now" close to the
    /// room's.
    fn start_capture(&self) -> anyhow::Result<()> {
        let spawned = tokio::process::Command::new("parec")
            .args([
                "--device",
                &format!("{MEET_OUT_SINK}.monitor"),
                "--format=s16le",
                &format!("--rate={MEETING_SAMPLE_RATE}"),
                "--channels=1",
                "--latency-msec=20",
            ])
            .envs(self.pulse_env()?)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(err) => {
                note_loss(
                    &self.state,
                    format!("the capture process failed to run: {err}"),
                );
                return Ok(());
            }
        };

        if let Some(mut stdout) = child.stdout.take() {
            let state = self.state.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 8192];
                loop {
                    match stdout.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let handler = state.lock().capture_handler.clone();
                            if let Some(handler) = handler {
                                handler(Bytes::copy_from_slice(&buffer[..read]));
                            }
                        }
                    }
                }
            });
        }
        let state = self.state.clone();
        let process = StackProcess::track(child, move |code| {
            note_loss(
                &state,
                format!("the capture process exited (code {})", code_text(code)),
            );
        });
        self.state.lock().parec = Some(process);
        Ok(())
    }

    /// Play the model's speech into bot_speak, which Chrome hears as its mic.
    ///
    /// `--latency-msec` is `SINK_BUFFER_MS`: deep enough that a stalled scheduler can't
    /// starve the device mid-word, and equal to the figure playback estimates what the
    /// room has actually heard by.
    fn start_playback(&self) -> anyhow::Result<()> {
        let spawned = tokio::process::Command::new("pacat")
            .args([
                "--device",
                BOT_SPEAK_SINK,
                "--format=s16le",
                &format!("--rate={MEETING_SAMPLE_RATE}"),
                "--channels=1",
                &format!("--latency-msec={SINK_BUFFER_MS}"),
            ])
            .envs(self.pulse_env()?)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(err) => {
                note_loss(
                    &self.state,
                    format!("the playback process failed to run: {err}"),
                );
                return Ok(());
            }
        };

        if let Some(mut stdin) = child.stdin.take() {
            let (chunks, mut queued) = mpsc::unbounded_channel::<Bytes>();
            self.state.lock().playback = Some(chunks);
            tokio::spawn(async move {
                while let Some(chunk) = queued.recv().await {
                    // The sink drops frames once this ends; an EPIPE here is pacat going
                    // away, which the exit watcher reports.
                    if let Err(err) = stdin.write_all(&chunk).await {
                        log_warn!("[Meeting] pacat stdin: {}", err);
                        break;
                    }
                }
            });
        }
        let state = self.state.clone();
        let process = StackProcess::track(child, move |code| {
            state.lock().playback = None;
            note_loss(
                &state,
                format!("the playback process exited (code {})", code_text(code)),
            );
        });
        self.state.lock().pacat = Some(process);
        Ok(())
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
        let deadline = crate::support::now_ms() + timeout_ms as i64;
        loop {
            // A stack torn down under us has no daemon left to ask, so polling on would
            // just burn the whole budget for a call that is already over.
            if self.state.lock().stopped {
                return false;
            }
            let (capturing, failure) = self.read_mic_capture().await;
            if capturing {
                return true;
            }

            if crate::support::now_ms() >= deadline {
                let detail = failure
                    .map(|failure| format!(" (last read failed: {failure})"))
                    .unwrap_or_default();
                log_warn!(
                    "[Meeting] {} is still not being captured after {}ms{}",
                    BOT_MIC_SOURCE,
                    timeout_ms,
                    detail
                );
                return false;
            }
            tokio::time::sleep(Duration::from_millis(MIC_CAPTURE_POLL_MS)).await;
        }
    }

    /// One read of the same question, for a caller that will ask again anyway.
    ///
    /// The mid-call unmute retry runs every ten seconds for the length of a call, so it
    /// wants the reading without the waiting and — more to the point — without the warning
    /// line, which `wait_for_mic_capture` is right to log once on a join and would be wrong to
    /// log a hundred times on one meeting.
    pub async fn is_mic_captured(&self) -> bool {
        if self.state.lock().stopped {
            return false;
        }
        self.read_mic_capture().await.0
    }

    /// Is anything reading `bot_mic` right now, and if the question failed, why.
    ///
    /// A failure is anomalous rather than expected: `start()` already ran a dozen `pactl`
    /// calls, so one failing now is worth reporting even though every caller retries.
    async fn read_mic_capture(&self) -> (bool, Option<String>) {
        match self.pactl(&["list", "short", "sources"]).await {
            Ok(sources) => (source_is_running(&sources, BOT_MIC_SOURCE), None),
            Err(err) => (false, Some(err.to_string())),
        }
    }

    /// Run `pactl` against the private daemon and answer its stdout.
    async fn pactl(&self, args: &[&str]) -> anyhow::Result<String> {
        let output = tokio::process::Command::new("pactl")
            .args(args)
            .envs(self.pulse_env()?)
            .stdin(Stdio::null())
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!(
                "Command failed: pactl {}\n{}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Stop every process and remove the runtime dir.
    ///
    /// Ordered from client to daemon so nothing logs an error about a socket that
    /// disappeared underneath it: SIGTERM to `parec`, `pacat`, the daemon and Xvfb, 300 ms
    /// to exit cleanly, then SIGKILL to whatever is left. Idempotent, and never fails:
    /// teardown runs on the error path too, where a second failure would mask the first.
    pub async fn stop(&self) {
        let processes: Vec<StackProcess> = {
            let mut state = self.state.lock();
            state.stopped = true;
            state.capture_handler = None;
            // The owner is already ending the call — the deaths below are its own doing.
            state.lost_handler = None;
            state.playback = None;
            [
                state.parec.take(),
                state.pacat.take(),
                state.pulse.take(),
                state.xvfb.take(),
            ]
            .into_iter()
            .flatten()
            .collect()
        };

        for process in &processes {
            if process.has_exited() {
                continue;
            }
            if let Err(err) = process.terminate() {
                log_debug!("[Meeting] Failed to signal a stack process: Error: {}", err);
            }
        }

        // Give them a moment to exit cleanly, then insist.
        tokio::time::sleep(Duration::from_millis(300)).await;
        for process in &processes {
            if !process.has_exited() {
                process.force_kill();
            }
        }

        let runtime_dir = self.state.lock().runtime_dir.take();
        if let Some(runtime_dir) = runtime_dir
            && let Err(err) = tokio::fs::remove_dir_all(&runtime_dir).await
            && err.kind() != std::io::ErrorKind::NotFound
        {
            log_debug!("[Meeting] Could not remove runtime dir: Error: {}", err);
        }
    }
}

/// Executables the audio/display stack needs on PATH.
pub const AUDIO_STACK_BINARIES: [&str; 5] = ["Xvfb", "pulseaudio", "pactl", "parec", "pacat"];

#[cfg(test)]
mod tests {
    use super::*;

    /// Tab-separated, as `pactl` writes it — the mic open, the meeting monitor idle.
    const CAPTURING: &str = "0\tmeet_out.monitor\tmodule-null-sink.c\ts16le 1ch 48000Hz\tIDLE\n1\tbot_speak.monitor\tmodule-null-sink.c\ts16le 1ch 48000Hz\tRUNNING\n2\tbot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tRUNNING";

    const MIC_RUNNING: &str = "bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tRUNNING";

    #[test]
    fn sees_the_virtual_mic_being_captured() {
        assert!(source_is_running(CAPTURING, "bot_mic"));
    }

    #[test]
    fn does_not_read_an_idle_or_suspended_source_as_captured() {
        // The devices are up, the daemon is healthy, and nothing is listening to the agent.
        let idle = CAPTURING.replace(
            MIC_RUNNING,
            "bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tIDLE",
        );
        assert!(!source_is_running(&idle, "bot_mic"));
        let suspended = CAPTURING.replace(
            MIC_RUNNING,
            "bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tSUSPENDED",
        );
        assert!(!source_is_running(&suspended, "bot_mic"));
    }

    #[test]
    fn does_not_credit_one_source_with_anothers_state() {
        let idle_mic = CAPTURING.replace(
            MIC_RUNNING,
            "bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tIDLE",
        );
        assert!(!source_is_running(&idle_mic, "bot_mic"));
        assert!(source_is_running(&idle_mic, "bot_speak.monitor"));
    }

    #[test]
    fn reads_space_separated_output_too() {
        let spaced = CAPTURING.replace('\t', "   ");
        assert!(source_is_running(&spaced, "bot_mic"));
    }

    #[test]
    fn answers_no_for_a_source_that_is_not_there_at_all() {
        assert!(!source_is_running(CAPTURING, "bot_microphone"));
        assert!(!source_is_running("", "bot_mic"));
    }

    #[tokio::test]
    async fn answers_no_once_the_stack_is_gone_rather_than_asking_a_dead_daemon() {
        let stack = AudioStack::new();
        stack.stop().await;
        assert!(!stack.is_mic_captured().await);
    }

    #[tokio::test]
    async fn gives_up_at_once_on_a_stack_that_has_already_been_torn_down() {
        let stack = AudioStack::new();
        stack.stop().await;
        let started = std::time::Instant::now();
        assert!(!stack.wait_for_mic_capture(10_000).await);
        assert!(started.elapsed() < Duration::from_millis(1_000));
    }

    #[test]
    fn reports_a_loss_once_and_to_a_handler_registered_late() {
        let stack = AudioStack::new();
        note_loss(
            &stack.state,
            "the capture process exited (code 1)".to_string(),
        );
        note_loss(
            &stack.state,
            "the playback process exited (code 1)".to_string(),
        );
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorder = seen.clone();
        let handler: LostHandler = Arc::new(move |reason| recorder.lock().push(reason));
        // What `on_lost` does with a handler that arrives after the loss.
        let reason = {
            let mut state = stack.state.lock();
            state.lost_handler = Some(handler.clone());
            state.lost_reason.clone()
        };
        if let Some(reason) = reason {
            handler(reason);
        }
        assert_eq!(
            *seen.lock(),
            vec!["the capture process exited (code 1)".to_string()]
        );
    }
}
