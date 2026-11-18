//! The browser half of a meeting: a real browser on a virtual display.
//!
//! Three choices here are important, and all three were established by watching
//! Google's RPCs reject us:
//!
//! - **Spawned as an ordinary browser, then attached over CDP.** Letting an
//!   automation library *launch* the browser made Meet answer `ResolveMeetingSpace`
//!   with 403 before any interaction — the page never even rendered a join button.
//!   Starting the browser the way a desktop would (its own process,
//!   `--remote-debugging-port`) and connecting afterwards turns that same call into a
//!   200. A launch path adds automation switches and instrumentation that Google
//!   reads; attaching does not.
//! - **Not `--headless`.** Meet's WebRTC path is markedly less reliable headless, so
//!   the browser runs normally against the Xvfb display from `audio_stack.rs`.
//! - **No user-agent override.** A hand-written UA used to be set here to "look
//!   normal". It was actively harmful: the browser still sends `Sec-CH-UA` client
//!   hints from its real build, so requests carried `Chrome/140` in the UA and
//!   `"Chromium";v="151"` in the hints simultaneously. Comparing those is the
//!   cheapest bot check there is; an honest Chromium is quieter than a mismatched
//!   pair.
//!
//! The media flags matter too — see `build_browser_args` below, where the reason each
//! one is present or absent is written down.
//!
//! Authentication is deliberately *not* here: signing in is platform-specific and
//! belongs to the provider (`providers/google_meet/sign_in.rs`). What this file owns
//! is the profile that a session is stored in — which is why the quit request in
//! `stop()` matters more than it looks: a browser that quits when asked flushes its
//! cookie store, and one that is signalled instead does not, so every join
//! re-authenticates.
//!
//! The browser is driven over the Chrome DevTools Protocol. `BrowserHandle`,
//! `BrowserContextHandle`, `PageHandle`, `FrameHandle`, `Locator` and `CdpSession` are
//! the handles the rest of the runtime holds; their operations keep the names and the
//! semantics of the Playwright calls the meeting, the computer and the sign-in flows were
//! written against. Locators resolve in an isolated world with the script in
//! `locator_engine.js`, so the page cannot see or disturb the queries.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::lib::log_redaction::err_json;
use crate::services::meeting::browser_tabs::TabSet;
use crate::utils::with_timeout::with_timeout;
use crate::{log_debug, log_error, log_info, log_warn};

/// Browser binaries to try, best first.
///
/// Real Google Chrome is preferred over Debian's `chromium` where present: Meet
/// scores the client, and Chrome-branded builds are the documented winning side of
/// that. `PRISM_CHROMIUM_PATH` overrides for hosts with a different layout.
static BROWSER_CANDIDATES: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PRISM_CHROMIUM_PATH")
        && !path.is_empty()
    {
        candidates.push(path);
    }
    for path in [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ] {
        candidates.push(path.to_string());
    }
    candidates
});

/// The browser profile, kept in the data dir so a signed-in session survives
/// restarts.
///
/// This is the whole reason sign-in is affordable: Google challenges a *new* device,
/// not a returning one, so persisting the profile turns login into a rare event
/// instead of a per-meeting gamble.
fn profile_dir() -> PathBuf {
    PathBuf::from(crate::lib::data_dir::resolve_data_dir()).join("meeting-browser-profile")
}

/// How long the browser gets to quit when asked, before the signal ladder starts.
const CLEAN_QUIT_MS: u64 = 5_000;

/// How long the browser gets to exit after SIGTERM, before SIGKILL.
const EXIT_GRACE_MS: u64 = 15_000;

/// Whether a spawned process has left, by either route.
fn has_exited(proc: &mut Child) -> bool {
    !matches!(proc.try_wait(), Ok(None))
}

/// Wait for a spawned process to leave, up to `ms`, polling every 200 ms. Reports
/// whether it did, whether it exited or died from a signal.
async fn wait_for_exit(proc: &mut Child, ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while !has_exited(proc) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    has_exited(proc)
}

/// Remove the profile's singleton lock files.
///
/// Chromium writes `SingletonLock` as a symlink naming `<hostname>-<pid>` and
/// refuses to start when it cannot prove that process is gone. After a container is
/// replaced, the hostname in the lock belongs to a container that no longer exists,
/// so Chromium can't check it and simply exits (code 21) — which looks exactly like
/// "the browser is broken" and is really "the last run didn't get to clean up".
///
/// Safe to clear unconditionally because this profile has exactly one owner: one
/// `AGENT_ID` per container means one data dir, and a meeting tears its browser down
/// before `start()` can be called again. Any lock present here is therefore stale by
/// construction. (If a deployment ever shared one data dir between containers, this
/// assumption — not this function — is what would need revisiting.)
///
/// Each removal logs `[Meeting] Cleared a stale browser profile lock ({name})`; an
/// absent file is the normal case.
async fn clear_stale_profile_locks(user_data_dir: &Path) {
    for name in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
        if tokio::fs::remove_file(user_data_dir.join(name))
            .await
            .is_ok()
        {
            log_info!("[Meeting] Cleared a stale browser profile lock ({})", name);
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BrowserStackOptions {
    /// DISPLAY, PULSE_SINK, PULSE_SOURCE and friends from the audio stack.
    pub env: IndexMap<String, String>,
    /// Where the profile lives. Defaults to the meeting bot's signed-in profile; a
    /// browser that may run beside a live call uses its own, since Chromium refuses a
    /// second instance on one profile.
    pub profile_dir: Option<PathBuf>,
}

/// The browser's command line.
///
/// Separate from `start()` so the media flags are assertable without a browser.
pub fn build_browser_args(port: u16, user_data_dir: &str) -> Vec<String> {
    vec![
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={user_data_dir}"),
        // Chromium's own sandbox needs unprivileged user namespaces, which the
        // container usually cannot get: we run as non-root `node` under a default
        // seccomp profile with no `SYS_ADMIN`, so the zygote fails to fork and the
        // browser dies at launch. Disabled deliberately rather than discovered in
        // production. The isolation that matters is the outer one — this whole
        // runtime already runs inside the Mirantis Agent Platform sandbox with filtered egress, and
        // the browser visits exactly one origin we chose.
        "--no-sandbox".into(),
        "--disable-setuid-sandbox".into(),
        // Auto-grant the mic/camera prompt — nobody is there to click "Allow". The
        // devices behind it are the real PulseAudio ones, not fakes. This flag has to
        // be exactly this one: `--use-fake-ui-for-media-stream` also answers
        // `getDisplayMedia` and rejects the capture, and
        // `--use-fake-device-for-media-stream` alongside it replaces the live
        // PulseAudio source with a tone.
        "--auto-accept-camera-and-microphone-capture".into(),
        // Pick the screen for `getDisplayMedia`. The value is matched against the names
        // in Chromium's own picker list, so it depends on two things below and nearby:
        // `--lang=en-US`, which keeps those names English, and a single-monitor
        // display, which is what `audio_stack.rs` gives us — one screen is named
        // "Entire screen". The space in it is safe because the process is spawned with
        // an argument list and no shell.
        //
        // The flag is a browser-wide switch, not a Meet one: *every* page this browser
        // loads gets the auto-selection, so any origin that calls `getDisplayMedia()`
        // receives the whole virtual display — no picker, and no user gesture of any
        // kind. Before this flag that call simply failed. Acceptable only because the
        // browser is ours and visits the one origin we send it to.
        "--auto-select-desktop-capture-source=Entire screen".into(),
        // Meet starts playing before any user gesture exists.
        "--autoplay-policy=no-user-gesture-required".into(),
        // The meeting tab sits in the background for as long as the agent is browsing in
        // the other one, and Chromium throttles a background tab's timers and its whole
        // renderer. The call is the thing that must not slow down, so all three are off.
        "--disable-background-timer-throttling".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-renderer-backgrounding".into(),
        // Containers give /dev/shm 64 MB by default, which Chrome exhausts and
        // then crashes on; this moves the shared memory to /tmp instead.
        "--disable-dev-shm-usage".into(),
        // No crash reports out of an agent container. Note these do NOT stop the
        // crashpad *handler* from starting — it re-parents itself to PID 1
        // regardless, which is why the image runs under tini to reap it (see the
        // ENTRYPOINT comment in the Dockerfile).
        "--disable-breakpad".into(),
        "--disable-crash-reporter".into(),
        // Meet localizes from Accept-Language or IP geolocation, which would serve
        // a differently-worded lobby and break every selector in the provider.
        "--lang=en-US".into(),
        "--accept-lang=en-US,en".into(),
        "--window-size=1280,720".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        // Force PulseAudio rather than letting Chrome pick ALSA and find nothing.
        "--alsa-output-device=pulse".into(),
        "about:blank".into(),
    ]
}

/// Camera and microphone permission for every origin the profile visits.
///
/// The flag above answers the permission *request*, but leaves
/// `navigator.permissions.query({ name: 'microphone' })` reporting `prompt`, where
/// the old fake-UI flag reported `granted`. Meet reads permission state to decide
/// whether to offer its "continue without microphone" panels, so the state is worth
/// keeping as it was.
///
/// The two mechanisms are not the same thing, which is why both are here. The flag
/// answers a prompt; this overrides the state the page reads. It is a *session*
/// override, not a stored content setting: `Browser.grantPermissions` over CDP writes
/// nothing into the persistent profile. It still recovers a profile that once recorded
/// a block — measured, a stored block reads `denied` and the override turns it into
/// `granted` — but only because `start()` re-applies it on every call. Nothing here
/// clears the stored block itself.
///
/// The override lives as long as the **CDP connection**, not as long as the browser.
/// Measured: detach and re-attach to the same browser process and both read `prompt`
/// again. So a second CDP client that grants any permission and then disconnects
/// clears these two as well, which would leave a live call deaf and mute. Worth
/// knowing before anything else is driven over the debugging port.
///
/// Either mechanism alone was measured to open the microphone, so this is the
/// backstop if a browser build drops the flag. A prompt nobody can click is a bot
/// that joins deaf.
///
/// The call carries no origin, which grants these two everywhere and *denies* every
/// other permission everywhere. Measured: notifications and geolocation move from
/// `prompt` (an unanswerable prompt in a browser nobody watches) to `denied`, while
/// clipboard and screen wake lock move from `granted` to `denied`. Both are
/// acceptable losses here — the agent never copies anything, and there is no real
/// screen to keep awake. Screen capture is not affected.
///
/// Best effort — a failure here is not a reason to abandon a join the flag can
/// carry on its own.
async fn grant_media_permissions(context: &BrowserContextHandle) {
    if let Err(err) = context.grant_permissions(&["microphone", "camera"]).await {
        log_warn!(
            json!({ "err": err_json(&err) }),
            "[Meeting] Could not pre-grant the media permissions"
        );
    }
}

/// An unused localhost port for the browser's debugging endpoint.
async fn free_port() -> anyhow::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

// ---------------------------------------------------------------------------
// The DevTools connection.
// ---------------------------------------------------------------------------

/// What every operation reports once its tab, its context or the browser is gone.
const CLOSED_MESSAGE: &str = "Target page, context or browser has been closed";

/// The default timeout of an operation that names none.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// The isolated world the locators run in, so the page can neither see nor disturb them.
const UTILITY_WORLD: &str = "__prism_utility_world__";

/// Gaps between the reads of a locator that is waiting for its element.
const POLL_INTERVALS_MS: [u64; 6] = [0, 20, 50, 100, 100, 250];

/// The script every locator operation runs, called with the query and the operation.
const LOCATOR_ENGINE: &str = include_str!("locator_engine.js");

/// The HTTP client for the `/json/version` handshake. Loopback only, so never proxied.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("the CDP handshake client builds")
});

/// Why a DevTools command did not answer.
#[derive(Debug, Clone)]
enum CommandError {
    /// The connection, the session or its target is gone.
    Closed,
    /// The browser answered with an error, as `Protocol error (<method>): <message>`.
    Protocol(String),
}

impl CommandError {
    fn into_anyhow(self) -> anyhow::Error {
        match self {
            CommandError::Closed => anyhow::anyhow!("{CLOSED_MESSAGE}"),
            CommandError::Protocol(message) => anyhow::anyhow!("{message}"),
        }
    }
}

struct PendingCommand {
    session: Option<String>,
    method: String,
    reply: oneshot::Sender<Result<Value, CommandError>>,
}

/// One WebSocket to the browser, shared by every session on it (flat mode).
struct Connection {
    out: mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<u64, PendingCommand>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Connection {
    fn new() -> (Arc<Connection>, mpsc::UnboundedReceiver<Message>) {
        let (out, rx) = mpsc::unbounded_channel();
        (
            Arc::new(Connection {
                out,
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                closed: AtomicBool::new(false),
            }),
            rx,
        )
    }

    async fn send(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, CommandError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CommandError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply, answer) = oneshot::channel();
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.pending.lock().insert(
            id,
            PendingCommand {
                session: session.map(str::to_string),
                method: method.to_string(),
                reply,
            },
        );
        if self.out.send(Message::text(message.to_string())).is_err() {
            self.pending.lock().remove(&id);
            return Err(CommandError::Closed);
        }
        answer.await.unwrap_or(Err(CommandError::Closed))
    }

    fn resolve(&self, id: u64, outcome: Result<Value, String>) {
        let Some(pending) = self.pending.lock().remove(&id) else {
            return;
        };
        let outcome = outcome.map_err(|message| {
            CommandError::Protocol(format!("Protocol error ({}): {}", pending.method, message))
        });
        let _ = pending.reply.send(outcome);
    }

    /// Fail every command still waiting on `session`; its target has gone.
    fn fail_session(&self, session: &str) {
        let failed: Vec<PendingCommand> = {
            let mut pending = self.pending.lock();
            let ids: Vec<u64> = pending
                .iter()
                .filter(|(_, command)| command.session.as_deref() == Some(session))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect()
        };
        for command in failed {
            let _ = command.reply.send(Err(CommandError::Closed));
        }
    }

    fn fail_all(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let failed: Vec<PendingCommand> = self.pending.lock().drain().map(|(_, c)| c).collect();
        for command in failed {
            let _ = command.reply.send(Err(CommandError::Closed));
        }
    }
}

async fn write_loop<S>(mut sink: S, mut rx: mpsc::UnboundedReceiver<Message>)
where
    S: futures::Sink<Message> + Unpin,
{
    while let Some(message) = rx.recv().await {
        let closing = matches!(message, Message::Close(_));
        if sink.send(message).await.is_err() || closing {
            break;
        }
    }
    let _ = sink.close().await;
}

async fn read_loop<S>(mut stream: S, conn: Arc<Connection>, browser: Weak<BrowserInner>)
where
    S: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(next) = stream.next().await {
        let text = match next {
            Ok(Message::Text(text)) => text.to_string(),
            Ok(Message::Binary(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            let outcome = match message.get("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_string()),
                None => Ok(message.get("result").cloned().unwrap_or_else(|| json!({}))),
            };
            conn.resolve(id, outcome);
            continue;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let Some(browser) = browser.upgrade() else {
            break;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let session = message.get("sessionId").and_then(Value::as_str);
        browser.dispatch(session, method, &params);
    }
    conn.fail_all();
    if let Some(browser) = browser.upgrade() {
        browser.on_disconnected();
    }
}

// ---------------------------------------------------------------------------
// Handles on the browser, driven over the DevTools protocol.
// ---------------------------------------------------------------------------

/// When a navigation counts as finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LoadState {
    /// The `load` event fired.
    #[default]
    Load,
    /// The `DOMContentLoaded` event fired.
    DomContentLoaded,
    /// No network connections for at least 500 ms.
    NetworkIdle,
    /// The navigation committed.
    Commit,
}

impl LoadState {
    /// The DevTools lifecycle event that marks this state.
    fn lifecycle_name(self) -> &'static str {
        match self {
            LoadState::Load => "load",
            LoadState::DomContentLoaded => "DOMContentLoaded",
            LoadState::NetworkIdle => "networkIdle",
            LoadState::Commit => "commit",
        }
    }
}

/// What a `Locator::wait_for` waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WaitForState {
    Attached,
    Detached,
    #[default]
    Visible,
    Hidden,
}

/// Options for `PageHandle::goto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GotoOptions {
    pub wait_until: LoadState,
    /// Milliseconds; `None` is the 30-second default.
    pub timeout_ms: Option<u64>,
}

/// The encoding of a screenshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScreenshotType {
    #[default]
    Png,
    Jpeg,
}

/// Options for `PageHandle::screenshot`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScreenshotOptions {
    pub kind: ScreenshotType,
    /// JPEG quality, 0–100.
    pub quality: Option<u8>,
    /// Milliseconds; `None` is the 30-second default.
    pub timeout_ms: Option<u64>,
    /// Also write the picture to this file.
    pub path: Option<PathBuf>,
}

/// How a locator matches text: an accessible name, a label, a placeholder or visible text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextMatch {
    /// A string. Without `exact` it matches case-insensitively as a substring, after
    /// whitespace is collapsed; with `exact` it matches the whole text, case-sensitively.
    Text { text: String, exact: bool },
    /// A JavaScript regular expression, `source` and `flags` as `/source/flags` writes
    /// them, evaluated in the page.
    Pattern { source: String, flags: String },
}

impl TextMatch {
    /// A substring match, as a bare string name is in Playwright.
    pub fn text(text: impl Into<String>) -> Self {
        TextMatch::Text {
            text: text.into(),
            exact: false,
        }
    }

    /// A whole-text match.
    pub fn exact(text: impl Into<String>) -> Self {
        TextMatch::Text {
            text: text.into(),
            exact: true,
        }
    }

    /// A JavaScript regular expression such as `/^chat$/i`, given as its source and flags.
    pub fn pattern(source: impl Into<String>, flags: impl Into<String>) -> Self {
        TextMatch::Pattern {
            source: source.into(),
            flags: flags.into(),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            TextMatch::Text { text, exact } => {
                json!({ "kind": "text", "text": text, "exact": exact })
            }
            TextMatch::Pattern { source, flags } => {
                json!({ "kind": "pattern", "source": source, "flags": flags })
            }
        }
    }

    /// How Playwright writes the match in a locator description.
    fn describe(&self) -> String {
        match self {
            TextMatch::Text { text, .. } => quote_js(text),
            TextMatch::Pattern { source, flags } => format!("/{source}/{flags}"),
        }
    }

    fn is_exact(&self) -> bool {
        matches!(self, TextMatch::Text { exact: true, .. })
    }
}

/// A string as a single-quoted JavaScript literal.
fn quote_js(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// One step of a locator's query, applied to what the steps before it matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocatorStep {
    /// A CSS selector.
    Css(String),
    /// An ARIA role, with the accessible name it must have.
    Role {
        role: String,
        name: Option<TextMatch>,
    },
    /// Elements whose visible text matches.
    Text(TextMatch),
    /// Form controls whose label matches.
    Label(TextMatch),
    /// Inputs whose placeholder matches.
    Placeholder(TextMatch),
    /// The element at this index of the matches; a negative index counts from the end.
    Nth(i64),
    /// Everything either locator matches, in document order.
    Or(Box<Locator>),
}

impl LocatorStep {
    fn to_json(&self) -> Value {
        match self {
            LocatorStep::Css(selector) => json!({ "kind": "css", "selector": selector }),
            LocatorStep::Role { role, name } => json!({
                "kind": "role",
                "role": role,
                "name": name.as_ref().map(TextMatch::to_json),
            }),
            LocatorStep::Text(text) => json!({ "kind": "text", "match": text.to_json() }),
            LocatorStep::Label(text) => json!({ "kind": "label", "match": text.to_json() }),
            LocatorStep::Placeholder(text) => {
                json!({ "kind": "placeholder", "match": text.to_json() })
            }
            LocatorStep::Nth(index) => json!({ "kind": "nth", "index": index }),
            LocatorStep::Or(other) => json!({ "kind": "or", "steps": other.steps_json() }),
        }
    }
}

/// A connection to the browser's DevTools endpoint.
///
/// Cloning shares the one connection. Closing it detaches; the browser process keeps
/// running until it is asked to quit with `Browser.close`.
#[derive(Clone)]
pub struct BrowserHandle {
    inner: Arc<BrowserInner>,
}

struct BrowserInner {
    conn: Arc<Connection>,
    /// The `webSocketDebuggerUrl` the browser announced at `/json/version`.
    ws_url: String,
    connected: AtomicBool,
    default_context: BrowserContextHandle,
    contexts: Mutex<Vec<BrowserContextHandle>>,
    /// Every session that belongs to a tab, its own and its out-of-process frames'.
    sessions: Mutex<HashMap<String, Arc<PageInner>>>,
    /// The tabs by DevTools target id.
    targets: Mutex<HashMap<String, Arc<PageInner>>>,
    /// Raised when a tab finishes attaching or goes away.
    pages_changed: Notify,
}

impl BrowserInner {
    fn new(conn: Arc<Connection>, ws_url: String) -> Arc<BrowserInner> {
        Arc::new_cyclic(|weak: &Weak<BrowserInner>| {
            let default_context = BrowserContextHandle {
                inner: Arc::new(ContextInner {
                    browser: weak.clone(),
                    context_id: None,
                    page_listeners: Mutex::new(Vec::new()),
                }),
            };
            BrowserInner {
                conn,
                ws_url,
                connected: AtomicBool::new(true),
                contexts: Mutex::new(vec![default_context.clone()]),
                default_context,
                sessions: Mutex::new(HashMap::new()),
                targets: Mutex::new(HashMap::new()),
                pages_changed: Notify::new(),
            }
        })
    }

    fn context_for(&self, browser_context_id: Option<&str>) -> BrowserContextHandle {
        if let Some(id) = browser_context_id
            && let Some(context) = self
                .contexts
                .lock()
                .iter()
                .find(|context| context.inner.context_id.as_deref() == Some(id))
        {
            return context.clone();
        }
        self.default_context.clone()
    }

    fn dispatch(self: &Arc<Self>, session: Option<&str>, method: &str, params: &Value) {
        match session {
            None => match method {
                "Target.attachedToTarget" => self.on_attached(None, params),
                "Target.detachedFromTarget" => {
                    if let Some(session) = params["sessionId"].as_str() {
                        self.on_session_detached(session);
                    }
                }
                "Target.targetDestroyed" => {
                    let page = params["targetId"]
                        .as_str()
                        .and_then(|target| self.targets.lock().get(target).cloned());
                    if let Some(page) = page {
                        self.close_page(&page);
                    }
                }
                "Target.targetCrashed" => {
                    let page = params["targetId"]
                        .as_str()
                        .and_then(|target| self.targets.lock().get(target).cloned());
                    if let Some(page) = page {
                        page.crashed();
                    }
                }
                _ => {}
            },
            Some(session) => {
                let page = self.sessions.lock().get(session).cloned();
                match method {
                    "Target.attachedToTarget" => self.on_attached(page, params),
                    "Target.detachedFromTarget" => {
                        if let Some(child) = params["sessionId"].as_str() {
                            self.on_session_detached(child);
                        }
                    }
                    _ => {
                        if let Some(page) = page {
                            page.on_event(session, method, params);
                        }
                    }
                }
            }
        }
    }

    fn on_attached(self: &Arc<Self>, parent: Option<Arc<PageInner>>, params: &Value) {
        let Some(session) = params["sessionId"].as_str().map(str::to_string) else {
            return;
        };
        let info = &params["targetInfo"];
        let target_id = info["targetId"].as_str().unwrap_or_default().to_string();
        let kind = info["type"].as_str().unwrap_or_default();
        let waiting = params["waitingForDebugger"].as_bool().unwrap_or(false);

        match (parent, kind) {
            (None, "page") => {
                let known = self
                    .targets
                    .lock()
                    .get(&target_id)
                    .is_some_and(|page| !page.is_closed());
                if known {
                    // A second session on a tab already driven, such as `new_cdp_session`.
                    return;
                }
                let context = self.context_for(info["browserContextId"].as_str());
                let page = Arc::new(PageInner::new(
                    self.conn.clone(),
                    context,
                    target_id.clone(),
                    session.clone(),
                    info["url"].as_str().unwrap_or_default().to_string(),
                ));
                self.sessions.lock().insert(session, page.clone());
                self.targets.lock().insert(target_id, page.clone());
                tokio::spawn(initialize_page(Arc::downgrade(self), page, waiting));
            }
            (Some(page), "iframe") => {
                self.sessions.lock().insert(session.clone(), page.clone());
                page.adopt_frame_session(&target_id, &session);
                tokio::spawn(initialize_frame_session(page, session, waiting));
            }
            _ => {
                if waiting {
                    let conn = self.conn.clone();
                    tokio::spawn(async move {
                        let _ = conn
                            .send(Some(&session), "Runtime.runIfWaitingForDebugger", json!({}))
                            .await;
                    });
                }
            }
        }
    }

    fn on_session_detached(&self, session: &str) {
        let page = self.sessions.lock().remove(session);
        self.conn.fail_session(session);
        let Some(page) = page else {
            return;
        };
        if page.session_id == session {
            self.close_page(&page);
        } else {
            page.forget_session(session);
        }
    }

    fn close_page(&self, page: &Arc<PageInner>) {
        let sessions: Vec<String> = {
            let mut map = self.sessions.lock();
            let owned: Vec<String> = map
                .iter()
                .filter(|(_, owner)| Arc::ptr_eq(owner, page))
                .map(|(session, _)| session.clone())
                .collect();
            for session in &owned {
                map.remove(session);
            }
            owned
        };
        for session in sessions {
            self.conn.fail_session(&session);
        }
        self.conn.fail_session(&page.session_id);
        {
            let mut targets = self.targets.lock();
            if targets
                .get(&page.target_id)
                .is_some_and(|known| Arc::ptr_eq(known, page))
            {
                targets.remove(&page.target_id);
            }
        }
        page.mark_closed();
        self.pages_changed.notify_waiters();
    }

    fn on_disconnected(&self) {
        self.connected.store(false, Ordering::SeqCst);
        let pages: Vec<Arc<PageInner>> = self.targets.lock().drain().map(|(_, p)| p).collect();
        self.sessions.lock().clear();
        for page in pages {
            page.mark_closed();
        }
        self.pages_changed.notify_waiters();
    }

    /// The tab with this target id once it has finished attaching, waiting up to `ms`.
    async fn wait_for_page(&self, target_id: &str, ms: u64) -> anyhow::Result<PageHandle> {
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            let notified = self.pages_changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(page) = self.targets.lock().get(target_id).cloned()
                && page.initialized.load(Ordering::SeqCst)
            {
                return Ok(PageHandle { inner: page });
            }
            if !self.connected.load(Ordering::SeqCst) {
                anyhow::bail!("{CLOSED_MESSAGE}");
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                anyhow::bail!("Timeout {ms}ms exceeded while waiting for the new tab");
            }
        }
    }
}

/// Attach a tab: enable the domains the handles read, then let it run.
async fn initialize_page(browser: Weak<BrowserInner>, page: Arc<PageInner>, waiting: bool) {
    let session = page.session_id.clone();
    let conn = page.conn.clone();
    let send = |method: &'static str, params: Value| {
        let conn = conn.clone();
        let session = session.clone();
        async move { conn.send(Some(&session), method, params).await }
    };
    let (_, tree, _, _, _, _) = tokio::join!(
        send("Page.enable", json!({})),
        send("Page.getFrameTree", json!({})),
        send("Page.setLifecycleEventsEnabled", json!({ "enabled": true })),
        send("Runtime.enable", json!({})),
        send(
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": true })
        ),
        send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })
        ),
    );
    if let Ok(tree) = tree {
        page.apply_frame_tree(&session, &tree["frameTree"]);
    }
    if waiting {
        let _ = send("Runtime.runIfWaitingForDebugger", json!({})).await;
    }
    page.seed_lifecycle().await;
    page.initialized.store(true, Ordering::SeqCst);
    if !page.is_closed() {
        let listeners = page.context.inner.page_listeners.lock().clone();
        for listener in listeners {
            listener(PageHandle {
                inner: page.clone(),
            });
        }
    }
    if let Some(browser) = browser.upgrade() {
        browser.pages_changed.notify_waiters();
    }
}

/// Attach an out-of-process frame: the same domains as a tab, on the frame's own session.
async fn initialize_frame_session(page: Arc<PageInner>, session: String, waiting: bool) {
    let conn = page.conn.clone();
    let send = |method: &'static str, params: Value| {
        let conn = conn.clone();
        let session = session.clone();
        async move { conn.send(Some(&session), method, params).await }
    };
    let (_, tree, _, _, _) = tokio::join!(
        send("Page.enable", json!({})),
        send("Page.getFrameTree", json!({})),
        send("Page.setLifecycleEventsEnabled", json!({ "enabled": true })),
        send("Runtime.enable", json!({})),
        send(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true })
        ),
    );
    if let Ok(tree) = tree {
        page.apply_frame_tree(&session, &tree["frameTree"]);
    }
    if waiting {
        let _ = send("Runtime.runIfWaitingForDebugger", json!({})).await;
    }
}

impl BrowserHandle {
    /// Attach to a running browser's debugging endpoint, `http://127.0.0.1:<port>`.
    ///
    /// Reads `/json/version` over plain HTTP, then opens the DevTools WebSocket it names.
    pub async fn connect_over_cdp(endpoint_url: &str) -> anyhow::Result<BrowserHandle> {
        let version_url = format!("{}/json/version", endpoint_url.trim_end_matches('/'));
        let version: Value = HTTP
            .get(&version_url)
            .send()
            .await
            .map_err(|err| anyhow::anyhow!("browserType.connectOverCDP: {err}"))?
            .json()
            .await
            .map_err(|err| anyhow::anyhow!("browserType.connectOverCDP: {err}"))?;
        let Some(ws_url) = version["webSocketDebuggerUrl"].as_str() else {
            anyhow::bail!(
                "browserType.connectOverCDP: {version_url} named no webSocketDebuggerUrl"
            );
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(512 << 20))
            .max_frame_size(Some(512 << 20));
        let (socket, _) = tokio_tungstenite::connect_async_with_config(ws_url, Some(config), false)
            .await
            .map_err(|err| anyhow::anyhow!("browserType.connectOverCDP: {err}"))?;
        let (sink, stream) = socket.split();

        let (conn, rx) = Connection::new();
        let inner = BrowserInner::new(conn.clone(), ws_url.to_string());
        tokio::spawn(write_loop(sink, rx));
        tokio::spawn(read_loop(stream, conn.clone(), Arc::downgrade(&inner)));

        // The browser announces the tabs it already has before it answers this, so the
        // wait below covers every one of them.
        conn.send(
            None,
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
        )
        .await
        .map_err(|err| anyhow::anyhow!("browserType.connectOverCDP: {}", err.into_anyhow()))?;
        let existing: Vec<String> = inner.targets.lock().keys().cloned().collect();
        for target in existing {
            let _ = inner.wait_for_page(&target, DEFAULT_TIMEOUT_MS).await;
        }
        Ok(BrowserHandle { inner })
    }

    /// The browser's contexts. A browser attached over CDP has its default context here.
    pub fn contexts(&self) -> Vec<BrowserContextHandle> {
        self.inner.contexts.lock().clone()
    }

    /// Create a new, empty context.
    pub async fn new_context(&self) -> anyhow::Result<BrowserContextHandle> {
        let created = self
            .inner
            .conn
            .send(
                None,
                "Target.createBrowserContext",
                json!({ "disposeOnDetach": true }),
            )
            .await
            .map_err(|err| anyhow::anyhow!("browser.newContext: {}", err.into_anyhow()))?;
        let context = BrowserContextHandle {
            inner: Arc::new(ContextInner {
                browser: Arc::downgrade(&self.inner),
                context_id: created["browserContextId"].as_str().map(str::to_string),
                page_listeners: Mutex::new(Vec::new()),
            }),
        };
        self.inner.contexts.lock().push(context.clone());
        Ok(context)
    }

    /// A DevTools session on the browser itself, for browser-wide commands.
    pub async fn new_browser_cdp_session(&self) -> anyhow::Result<CdpSession> {
        if !self.inner.connected.load(Ordering::SeqCst) {
            anyhow::bail!("browser.newBrowserCDPSession: {CLOSED_MESSAGE}");
        }
        Ok(CdpSession {
            browser: self.clone(),
            session_id: None,
        })
    }

    /// Detach from the browser. The process keeps running.
    pub async fn close(&self) -> anyhow::Result<()> {
        if self.inner.connected.swap(false, Ordering::SeqCst) {
            let _ = self.inner.conn.out.send(Message::Close(None));
        }
        self.inner.conn.fail_all();
        self.inner.on_disconnected();
        Ok(())
    }

    /// The DevTools WebSocket this handle is attached to.
    pub fn ws_url(&self) -> &str {
        &self.inner.ws_url
    }
}

/// A listener for tabs a context opens, including ones a site opened for itself.
pub type PageListener = Arc<dyn Fn(PageHandle) + Send + Sync>;

/// One browser context: a profile's cookies, permissions and tabs.
#[derive(Clone)]
pub struct BrowserContextHandle {
    inner: Arc<ContextInner>,
}

struct ContextInner {
    browser: Weak<BrowserInner>,
    /// The DevTools `browserContextId`; `None` for the default context.
    context_id: Option<String>,
    page_listeners: Mutex<Vec<PageListener>>,
}

impl PartialEq for BrowserContextHandle {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

/// The DevTools name of a permission Playwright names.
fn protocol_permission(name: &str) -> Option<&'static str> {
    Some(match name {
        "geolocation" => "geolocation",
        "midi" => "midi",
        "notifications" => "notifications",
        "camera" => "videoCapture",
        "microphone" => "audioCapture",
        "background-sync" => "backgroundSync",
        "ambient-light-sensor" | "accelerometer" | "gyroscope" | "magnetometer" => "sensors",
        "clipboard-read" => "clipboardReadWrite",
        "clipboard-write" => "clipboardSanitizedWrite",
        "payment-handler" => "paymentHandler",
        "midi-sysex" => "midiSysex",
        "storage-access" => "storageAccess",
        "local-fonts" => "localFonts",
        _ => return None,
    })
}

impl BrowserContextHandle {
    fn browser(&self) -> anyhow::Result<Arc<BrowserInner>> {
        self.inner
            .browser
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("{CLOSED_MESSAGE}"))
    }

    /// Grant these permissions to every origin, and deny every other permission.
    pub async fn grant_permissions(&self, permissions: &[&str]) -> anyhow::Result<()> {
        let mut mapped = Vec::new();
        for permission in permissions {
            let Some(name) = protocol_permission(permission) else {
                anyhow::bail!("browserContext.grantPermissions: Unknown permission: {permission}");
            };
            mapped.push(name);
        }
        let browser = self.browser()?;
        let mut params = json!({ "permissions": mapped });
        if let Some(id) = &self.inner.context_id {
            params["browserContextId"] = json!(id);
        }
        browser
            .conn
            .send(None, "Browser.grantPermissions", params)
            .await
            .map_err(|err| {
                anyhow::anyhow!("browserContext.grantPermissions: {}", err.into_anyhow())
            })?;
        Ok(())
    }

    /// Open a tab in this context.
    pub async fn new_page(&self) -> anyhow::Result<PageHandle> {
        let browser = self.browser()?;
        let mut params = json!({ "url": "about:blank" });
        if let Some(id) = &self.inner.context_id {
            params["browserContextId"] = json!(id);
        }
        let created = browser
            .conn
            .send(None, "Target.createTarget", params)
            .await
            .map_err(|err| anyhow::anyhow!("browserContext.newPage: {}", err.into_anyhow()))?;
        let Some(target_id) = created["targetId"].as_str() else {
            anyhow::bail!("browserContext.newPage: the browser named no target");
        };
        browser
            .wait_for_page(target_id, DEFAULT_TIMEOUT_MS)
            .await
            .map_err(|err| anyhow::anyhow!("browserContext.newPage: {err}"))
    }

    /// Call `listener` with every tab this context opens from now on.
    pub fn on_page(&self, listener: PageListener) {
        self.inner.page_listeners.lock().push(listener);
    }

    /// A DevTools session attached to one of this context's tabs.
    pub async fn new_cdp_session(&self, page: &PageHandle) -> anyhow::Result<CdpSession> {
        let browser = self.browser()?;
        let attached = browser
            .conn
            .send(
                None,
                "Target.attachToTarget",
                json!({ "targetId": page.inner.target_id, "flatten": true }),
            )
            .await
            .map_err(|err| {
                anyhow::anyhow!("browserContext.newCDPSession: {}", err.into_anyhow())
            })?;
        let Some(session) = attached["sessionId"].as_str() else {
            anyhow::bail!("browserContext.newCDPSession: the browser named no session");
        };
        Ok(CdpSession {
            browser: BrowserHandle { inner: browser },
            session_id: Some(session.to_string()),
        })
    }
}

/// A listener for main-frame and subframe navigations.
pub type FrameListener = Arc<dyn Fn(&FrameHandle) + Send + Sync>;

/// One tab of the browser.
///
/// Cloning gives another handle on the same tab; equality is identity.
#[derive(Clone)]
pub struct PageHandle {
    inner: Arc<PageInner>,
}

/// Playwright's preparation of a page for a screenshot with the caret hidden: every
/// input, textarea and editable element, shadow roots included, gets a transparent
/// `caret-color` until [`CLEANUP_AFTER_SCREENSHOT`] puts the old value back.
const PREPARE_FOR_SCREENSHOT: &str = r#"(() => {
  const roots = [];
  const collect = (root) => {
    roots.push(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    do {
      const node = walker.currentNode;
      const shadowRoot = node instanceof Element ? node.shadowRoot : null;
      if (shadowRoot) collect(shadowRoot);
    } while (walker.nextNode());
  };
  collect(document);
  const saved = new Map();
  for (const root of roots) {
    root.querySelectorAll('input,textarea,[contenteditable]').forEach((element) => {
      saved.set(element, {
        value: element.style.getPropertyValue('caret-color'),
        priority: element.style.getPropertyPriority('caret-color'),
      });
      element.style.setProperty('caret-color', 'transparent', 'important');
    });
  }
  window.__prismCleanupScreenshot = () => {
    for (const [element, old] of saved) element.style.setProperty('caret-color', old.value, old.priority);
    delete window.__prismCleanupScreenshot;
  };
  return true;
})()"#;

const CLEANUP_AFTER_SCREENSHOT: &str =
    "window.__prismCleanupScreenshot ? (window.__prismCleanupScreenshot(), true) : false";

/// Which JavaScript world an evaluation runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum World {
    /// The page's own world, where its scripts and globals live.
    Main,
    /// The isolated world the locators run in.
    Utility,
}

#[derive(Debug, Clone)]
struct ExecutionContext {
    session: String,
    id: i64,
    frame_id: String,
    world: World,
}

#[derive(Debug, Clone)]
struct Commit {
    seq: u64,
    loader: String,
    url: String,
}

#[derive(Default)]
struct PageState {
    frames: IndexMap<String, FrameHandle>,
    contexts: Vec<ExecutionContext>,
    /// The main frame's current document, and the lifecycle events it has fired.
    main_loader: Option<String>,
    lifecycle: HashSet<String>,
    /// The main frame's recent cross-document commits, newest last.
    commits: Vec<Commit>,
    commit_seq: u64,
}

struct PageInner {
    conn: Arc<Connection>,
    context: BrowserContextHandle,
    /// The DevTools target id of this tab, which is also its main frame's id.
    target_id: String,
    /// The DevTools session attached to it.
    session_id: String,
    /// The main frame's committed URL.
    url: Mutex<String>,
    closed: AtomicBool,
    initialized: AtomicBool,
    state: Mutex<PageState>,
    /// Raised on every change a waiter could be waiting for.
    changed: Notify,
    crash_listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    frame_listeners: Mutex<Vec<(u64, FrameListener)>>,
    next_listener_id: AtomicU64,
    /// Where the mouse last went, in CSS pixels of the viewport.
    mouse: Mutex<(f64, f64)>,
}

/// Why an evaluation in the page did not produce a value.
#[derive(Debug)]
enum EvalError {
    Closed,
    /// The document the evaluation ran in went away, usually for a navigation.
    ContextLost,
    /// No document to run in appeared in time.
    NoContext(String),
    /// The script threw; the text is the exception's description.
    Exception(String),
    Protocol(String),
}

impl EvalError {
    fn message(&self) -> String {
        match self {
            EvalError::Closed => CLOSED_MESSAGE.to_string(),
            EvalError::ContextLost => {
                "Execution context was destroyed, most likely because of a navigation".to_string()
            }
            EvalError::NoContext(message)
            | EvalError::Exception(message)
            | EvalError::Protocol(message) => message.clone(),
        }
    }
}

/// Whether a protocol error says the context named in the call is already gone.
fn context_missing(message: &str) -> bool {
    message.contains("Cannot find context with specified id")
        || message.contains("Cannot find default execution context")
}

/// Whether a protocol error says the context went away during the call.
fn context_destroyed(message: &str) -> bool {
    message.contains("Execution context was destroyed")
        || message.contains("Inspected target navigated or closed")
}

/// The text of an exception a script threw, as the browser describes it.
fn exception_text(details: &Value) -> String {
    if let Some(exception) = details.get("exception") {
        if let Some(description) = exception.get("description").and_then(Value::as_str) {
            return description.to_string();
        }
        if let Some(value) = exception.get("value") {
            return match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
        }
    }
    details["text"].as_str().unwrap_or("Error").to_string()
}

impl PageInner {
    fn new(
        conn: Arc<Connection>,
        context: BrowserContextHandle,
        target_id: String,
        session_id: String,
        url: String,
    ) -> PageInner {
        PageInner {
            conn,
            context,
            target_id,
            session_id,
            url: Mutex::new(url),
            closed: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
            state: Mutex::new(PageState::default()),
            changed: Notify::new(),
            crash_listeners: Mutex::new(Vec::new()),
            frame_listeners: Mutex::new(Vec::new()),
            next_listener_id: AtomicU64::new(1),
            mouse: Mutex::new((0.0, 0.0)),
        }
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn mark_closed(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }

    fn crashed(&self) {
        let listeners = self.crash_listeners.lock().clone();
        for listener in listeners {
            listener();
        }
    }

    async fn send(&self, method: &str, params: Value) -> Result<Value, CommandError> {
        self.conn.send(Some(&self.session_id), method, params).await
    }

    fn new_frame(self: &Arc<Self>, id: &str, parent: Option<String>, session: &str) -> FrameHandle {
        FrameHandle {
            inner: Arc::new(FrameInner {
                frame_id: id.to_string(),
                url: Mutex::new(String::new()),
                parent_id: Mutex::new(parent),
                session_id: Mutex::new(session.to_string()),
                detached: AtomicBool::new(false),
                page: Arc::downgrade(self),
            }),
        }
    }

    /// The frame with this id, created when it is new.
    fn upsert_frame(
        self: &Arc<Self>,
        state: &mut PageState,
        id: &str,
        parent: Option<&str>,
        session: &str,
    ) -> FrameHandle {
        if let Some(frame) = state.frames.get(id) {
            if let Some(parent) = parent {
                *frame.inner.parent_id.lock() = Some(parent.to_string());
            }
            return frame.clone();
        }
        let frame = self.new_frame(id, parent.map(str::to_string), session);
        state.frames.insert(id.to_string(), frame.clone());
        frame
    }

    fn apply_frame_tree(self: &Arc<Self>, session: &str, tree: &Value) {
        let frame = &tree["frame"];
        if let Some(id) = frame["id"].as_str() {
            let url = format!(
                "{}{}",
                frame["url"].as_str().unwrap_or_default(),
                frame["urlFragment"].as_str().unwrap_or_default()
            );
            let mut state = self.state.lock();
            let handle = self.upsert_frame(&mut state, id, frame["parentId"].as_str(), session);
            {
                let mut current = handle.inner.url.lock();
                if current.is_empty() {
                    *current = url.clone();
                }
            }
            if id == self.target_id {
                if state.main_loader.is_none() {
                    state.main_loader = frame["loaderId"].as_str().map(str::to_string);
                }
                let mut page_url = self.url.lock();
                if page_url.is_empty() {
                    *page_url = url;
                }
            }
        }
        if let Some(children) = tree["childFrames"].as_array() {
            for child in children {
                self.apply_frame_tree(session, child);
            }
        }
        self.changed.notify_waiters();
    }

    /// Record the lifecycle a document already reached before its events were enabled.
    async fn seed_lifecycle(&self) {
        let ready = tokio::time::timeout(
            Duration::from_millis(2_000),
            self.evaluate_in(&self.target_id, World::Main, "document.readyState"),
        )
        .await;
        let Ok(Ok(Value::String(ready))) = ready else {
            return;
        };
        let mut state = self.state.lock();
        if !state.lifecycle.is_empty() {
            return;
        }
        if ready == "interactive" || ready == "complete" {
            state.lifecycle.insert("DOMContentLoaded".to_string());
        }
        if ready == "complete" {
            state.lifecycle.insert("load".to_string());
        }
        drop(state);
        self.changed.notify_waiters();
    }

    fn adopt_frame_session(self: &Arc<Self>, frame_id: &str, session: &str) {
        let mut state = self.state.lock();
        let frame = self.upsert_frame(&mut state, frame_id, None, session);
        *frame.inner.session_id.lock() = session.to_string();
    }

    fn forget_session(&self, session: &str) {
        let mut state = self.state.lock();
        state.contexts.retain(|context| context.session != session);
        for frame in state.frames.values() {
            let mut owner = frame.inner.session_id.lock();
            if *owner == session {
                *owner = self.session_id.clone();
            }
        }
    }

    fn fire_frame_navigated(&self, frame: &FrameHandle) {
        let listeners: Vec<FrameListener> = self
            .frame_listeners
            .lock()
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            listener(frame);
        }
    }

    fn on_event(self: &Arc<Self>, session: &str, method: &str, params: &Value) {
        match method {
            "Page.frameAttached" => {
                if let Some(id) = params["frameId"].as_str() {
                    let mut state = self.state.lock();
                    self.upsert_frame(&mut state, id, params["parentFrameId"].as_str(), session);
                }
            }
            "Page.frameNavigated" => self.frame_navigated(session, &params["frame"]),
            "Page.navigatedWithinDocument" => {
                let (Some(id), Some(url)) = (params["frameId"].as_str(), params["url"].as_str())
                else {
                    return;
                };
                let frame = {
                    let mut state = self.state.lock();
                    self.upsert_frame(&mut state, id, None, session)
                };
                *frame.inner.url.lock() = url.to_string();
                if id == self.target_id {
                    *self.url.lock() = url.to_string();
                }
                self.changed.notify_waiters();
                self.fire_frame_navigated(&frame);
            }
            "Page.frameDetached" => {
                if params["reason"].as_str() == Some("swap") {
                    return;
                }
                if let Some(id) = params["frameId"].as_str() {
                    self.remove_frame(id);
                }
            }
            "Page.lifecycleEvent" => {
                if params["frameId"].as_str() != Some(self.target_id.as_str()) {
                    return;
                }
                let (Some(loader), Some(name)) =
                    (params["loaderId"].as_str(), params["name"].as_str())
                else {
                    return;
                };
                let mut state = self.state.lock();
                if name == "init" {
                    if state.main_loader.as_deref() != Some(loader) {
                        state.main_loader = Some(loader.to_string());
                        state.lifecycle.clear();
                    }
                } else if state.main_loader.as_deref() == Some(loader) {
                    state.lifecycle.insert(name.to_string());
                }
                drop(state);
                self.changed.notify_waiters();
            }
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                let aux = &context["auxData"];
                let (Some(id), Some(frame_id)) = (context["id"].as_i64(), aux["frameId"].as_str())
                else {
                    return;
                };
                let world = if aux["isDefault"].as_bool() == Some(true) {
                    World::Main
                } else if context["name"].as_str() == Some(UTILITY_WORLD) {
                    World::Utility
                } else {
                    return;
                };
                let mut state = self.state.lock();
                state
                    .contexts
                    .retain(|known| !(known.frame_id == frame_id && known.world == world));
                state.contexts.push(ExecutionContext {
                    session: session.to_string(),
                    id,
                    frame_id: frame_id.to_string(),
                    world,
                });
                drop(state);
                self.changed.notify_waiters();
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    self.state
                        .lock()
                        .contexts
                        .retain(|known| !(known.session == session && known.id == id));
                }
            }
            "Runtime.executionContextsCleared" => {
                self.state
                    .lock()
                    .contexts
                    .retain(|known| known.session != session);
            }
            "Inspector.targetCrashed" => self.crashed(),
            "Page.javascriptDialogOpening" => {
                // Nobody is there to answer a dialog, and one left open stalls the page.
                let accept = params["type"].as_str() == Some("beforeunload");
                let conn = self.conn.clone();
                let session = session.to_string();
                tokio::spawn(async move {
                    let _ = conn
                        .send(
                            Some(&session),
                            "Page.handleJavaScriptDialog",
                            json!({ "accept": accept }),
                        )
                        .await;
                });
            }
            _ => {}
        }
    }

    fn frame_navigated(self: &Arc<Self>, session: &str, frame: &Value) {
        let Some(id) = frame["id"].as_str() else {
            return;
        };
        let url = format!(
            "{}{}",
            frame["url"].as_str().unwrap_or_default(),
            frame["urlFragment"].as_str().unwrap_or_default()
        );
        let handle = {
            let mut state = self.state.lock();
            let handle = self.upsert_frame(&mut state, id, frame["parentId"].as_str(), session);
            if id == self.target_id {
                let loader = frame["loaderId"].as_str().unwrap_or_default().to_string();
                if state.main_loader.as_deref() != Some(loader.as_str()) {
                    state.main_loader = Some(loader.clone());
                    state.lifecycle.clear();
                }
                state.lifecycle.insert("commit".to_string());
                state.commit_seq += 1;
                let seq = state.commit_seq;
                state.commits.push(Commit {
                    seq,
                    loader,
                    url: url.clone(),
                });
                if state.commits.len() > 32 {
                    state.commits.remove(0);
                }
            }
            handle
        };
        *handle.inner.url.lock() = url.clone();
        if id == self.target_id {
            *self.url.lock() = url;
        }
        self.changed.notify_waiters();
        self.fire_frame_navigated(&handle);
    }

    fn remove_frame(&self, id: &str) {
        let mut state = self.state.lock();
        let mut doomed: HashSet<String> = HashSet::from([id.to_string()]);
        loop {
            let before = doomed.len();
            for (frame_id, frame) in &state.frames {
                if let Some(parent) = frame.inner.parent_id.lock().as_ref()
                    && doomed.contains(parent)
                {
                    doomed.insert(frame_id.clone());
                }
            }
            if doomed.len() == before {
                break;
            }
        }
        for frame_id in &doomed {
            if let Some(frame) = state.frames.shift_remove(frame_id) {
                frame.inner.detached.store(true, Ordering::SeqCst);
            }
        }
        state
            .contexts
            .retain(|context| !doomed.contains(&context.frame_id));
        drop(state);
        self.changed.notify_waiters();
    }

    fn frame_session(&self, frame_id: &str) -> String {
        self.state
            .lock()
            .frames
            .get(frame_id)
            .map(|frame| frame.inner.session_id.lock().clone())
            .unwrap_or_else(|| self.session_id.clone())
    }

    /// The session and id of the frame's context in `world`, waiting up to `ms` for one.
    async fn context_for(
        &self,
        frame_id: &str,
        world: World,
        ms: u64,
    ) -> Result<(String, i64), EvalError> {
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_closed() {
                return Err(EvalError::Closed);
            }
            {
                let state = self.state.lock();
                if let Some(frame) = state.frames.get(frame_id) {
                    if frame.inner.detached.load(Ordering::SeqCst) {
                        return Err(EvalError::NoContext("Frame was detached".to_string()));
                    }
                } else if frame_id != self.target_id {
                    return Err(EvalError::NoContext("Frame was detached".to_string()));
                }
                if let Some(context) = state
                    .contexts
                    .iter()
                    .find(|context| context.frame_id == frame_id && context.world == world)
                {
                    return Ok((context.session.clone(), context.id));
                }
            }
            if world == World::Utility {
                let session = self.frame_session(frame_id);
                let created = self
                    .conn
                    .send(
                        Some(&session),
                        "Page.createIsolatedWorld",
                        json!({
                            "frameId": frame_id,
                            "worldName": UTILITY_WORLD,
                            "grantUniveralAccess": true,
                        }),
                    )
                    .await;
                match created {
                    Ok(created) => {
                        if let Some(id) = created["executionContextId"].as_i64() {
                            let mut state = self.state.lock();
                            if let Some(known) = state.contexts.iter().find(|context| {
                                context.frame_id == frame_id && context.world == World::Utility
                            }) {
                                return Ok((known.session.clone(), known.id));
                            }
                            state.contexts.push(ExecutionContext {
                                session: session.clone(),
                                id,
                                frame_id: frame_id.to_string(),
                                world: World::Utility,
                            });
                            return Ok((session, id));
                        }
                    }
                    Err(CommandError::Closed) if self.is_closed() => return Err(EvalError::Closed),
                    Err(_) => {}
                }
                // The frame is between documents; ask again once something changes.
                let pause = tokio::time::sleep(Duration::from_millis(100));
                if tokio::time::timeout_at(deadline, pause).await.is_err() {
                    return Err(EvalError::NoContext(format!(
                        "Timeout {ms}ms exceeded while waiting for the page to run scripts"
                    )));
                }
                continue;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(EvalError::NoContext(format!(
                    "Timeout {ms}ms exceeded while waiting for the page to run scripts"
                )));
            }
        }
    }

    fn forget_context(&self, session: &str, id: i64) {
        self.state
            .lock()
            .contexts
            .retain(|context| !(context.session == session && context.id == id));
    }

    /// Evaluate an expression in a frame and return its value as JSON. A promise is awaited.
    async fn evaluate_in(
        &self,
        frame_id: &str,
        world: World,
        expression: &str,
    ) -> Result<Value, EvalError> {
        for _ in 0..3 {
            let (session, context) = self
                .context_for(frame_id, world, DEFAULT_TIMEOUT_MS)
                .await?;
            let answer = self
                .conn
                .send(
                    Some(&session),
                    "Runtime.evaluate",
                    json!({
                        "expression": expression,
                        "contextId": context,
                        "returnByValue": true,
                        "awaitPromise": true,
                        "userGesture": true,
                    }),
                )
                .await;
            match answer {
                Ok(result) => {
                    if let Some(details) = result.get("exceptionDetails") {
                        return Err(EvalError::Exception(exception_text(details)));
                    }
                    return Ok(result["result"]
                        .get("value")
                        .cloned()
                        .unwrap_or(Value::Null));
                }
                Err(CommandError::Closed) => {
                    if self.is_closed() {
                        return Err(EvalError::Closed);
                    }
                    self.forget_context(&session, context);
                    return Err(EvalError::ContextLost);
                }
                Err(CommandError::Protocol(message)) if context_missing(&message) => {
                    self.forget_context(&session, context);
                }
                Err(CommandError::Protocol(message)) if context_destroyed(&message) => {
                    self.forget_context(&session, context);
                    return Err(EvalError::ContextLost);
                }
                Err(CommandError::Protocol(message)) => return Err(EvalError::Protocol(message)),
            }
        }
        Err(EvalError::ContextLost)
    }

    async fn dispatch_key(&self, params: Value) -> anyhow::Result<()> {
        self.send("Input.dispatchKeyEvent", params)
            .await
            .map(|_| ())
            .map_err(CommandError::into_anyhow)
    }

    async fn insert_text(&self, text: &str) -> anyhow::Result<()> {
        self.send("Input.insertText", json!({ "text": text }))
            .await
            .map(|_| ())
            .map_err(CommandError::into_anyhow)
    }

    async fn key_down(
        &self,
        key: &KeyDefinition,
        modifiers: i64,
        text: &str,
    ) -> anyhow::Result<()> {
        self.dispatch_key(json!({
            "type": if text.is_empty() { "rawKeyDown" } else { "keyDown" },
            "modifiers": modifiers,
            "windowsVirtualKeyCode": key.key_code,
            "code": key.code,
            "key": key.key,
            "text": text,
            "unmodifiedText": text,
            "autoRepeat": false,
            "location": key.location,
            "isKeypad": key.location == 3,
        }))
        .await
    }

    async fn key_up(&self, key: &KeyDefinition, modifiers: i64) -> anyhow::Result<()> {
        self.dispatch_key(json!({
            "type": "keyUp",
            "modifiers": modifiers,
            "key": key.key,
            "windowsVirtualKeyCode": key.key_code,
            "code": key.code,
            "location": key.location,
        }))
        .await
    }

    /// Press one key or a chord such as `Control+A`, `delay_ms` between down and up.
    async fn press(&self, combo: &str, delay_ms: u64) -> anyhow::Result<()> {
        let tokens = split_key_combo(combo);
        let mut keys = Vec::new();
        for token in &tokens {
            let Some(key) = key_definition(token) else {
                anyhow::bail!("Unknown key: \"{token}\"");
            };
            keys.push(key);
        }
        let Some((main, held)) = keys.split_last() else {
            anyhow::bail!("Unknown key: \"{combo}\"");
        };
        let mut modifiers = 0;
        for key in held {
            self.key_down(key, modifiers, "").await?;
            modifiers |= modifier_bit(&key.key);
        }
        let text = if modifiers & !MODIFIER_SHIFT != 0 {
            String::new()
        } else {
            main.text.clone()
        };
        self.key_down(main, modifiers, &text).await?;
        if delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        self.key_up(main, modifiers).await?;
        for key in held.iter().rev() {
            modifiers &= !modifier_bit(&key.key);
            self.key_up(key, modifiers).await?;
        }
        Ok(())
    }

    /// Type text one key at a time; a character with no key on a US layout is inserted.
    async fn type_text(&self, text: &str, delay_ms: u64) -> anyhow::Result<()> {
        for ch in text.chars() {
            if let Some(key) = char_key(ch) {
                self.key_down(&key, 0, &key.text).await?;
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                self.key_up(&key, 0).await?;
            } else {
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                self.insert_text(&ch.to_string()).await?;
            }
        }
        Ok(())
    }

    async fn mouse_event(&self, params: Value) -> anyhow::Result<()> {
        self.send("Input.dispatchMouseEvent", params)
            .await
            .map(|_| ())
            .map_err(CommandError::into_anyhow)
    }

    async fn click_at(&self, x: f64, y: f64) -> anyhow::Result<()> {
        *self.mouse.lock() = (x, y);
        self.mouse_event(json!({
            "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0, "modifiers": 0,
        }))
        .await?;
        self.mouse_event(json!({
            "type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1,
            "clickCount": 1, "modifiers": 0,
        }))
        .await?;
        self.mouse_event(json!({
            "type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0,
            "clickCount": 1, "modifiers": 0,
        }))
        .await
    }
}

/// One key of a US keyboard, as `Input.dispatchKeyEvent` describes it.
#[derive(Debug, Clone)]
struct KeyDefinition {
    key: String,
    code: String,
    key_code: i64,
    /// What the key types; empty for a key that types nothing.
    text: String,
    location: i64,
}

const MODIFIER_ALT: i64 = 1;
const MODIFIER_CONTROL: i64 = 2;
const MODIFIER_META: i64 = 4;
const MODIFIER_SHIFT: i64 = 8;

fn modifier_bit(key: &str) -> i64 {
    match key {
        "Alt" => MODIFIER_ALT,
        "Control" => MODIFIER_CONTROL,
        "Meta" => MODIFIER_META,
        "Shift" => MODIFIER_SHIFT,
        _ => 0,
    }
}

/// Split `Control+Shift+A` into its keys; a `+` that is the key itself stays one.
fn split_key_combo(combo: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut building = String::new();
    for ch in combo.chars() {
        if ch == '+' && !building.is_empty() {
            keys.push(std::mem::take(&mut building));
        } else {
            building.push(ch);
        }
    }
    keys.push(building);
    keys
}

fn key(key: &str, code: &str, key_code: i64, text: &str, location: i64) -> KeyDefinition {
    KeyDefinition {
        key: key.to_string(),
        code: code.to_string(),
        key_code,
        text: text.to_string(),
        location,
    }
}

/// Punctuation on a US layout: the plain character, the shifted one, the code and key code.
const PUNCTUATION: [(char, char, &str, i64); 11] = [
    ('`', '~', "Backquote", 192),
    ('-', '_', "Minus", 189),
    ('=', '+', "Equal", 187),
    ('[', '{', "BracketLeft", 219),
    (']', '}', "BracketRight", 221),
    ('\\', '|', "Backslash", 220),
    (';', ':', "Semicolon", 186),
    ('\'', '"', "Quote", 222),
    (',', '<', "Comma", 188),
    ('.', '>', "Period", 190),
    ('/', '?', "Slash", 191),
];

/// The key that types `ch` on a US layout.
fn char_key(ch: char) -> Option<KeyDefinition> {
    let text = ch.to_string();
    if ch.is_ascii_lowercase() || ch.is_ascii_uppercase() {
        let upper = ch.to_ascii_uppercase();
        return Some(key(&text, &format!("Key{upper}"), upper as i64, &text, 0));
    }
    if ch.is_ascii_digit() {
        return Some(key(&text, &format!("Digit{ch}"), ch as i64, &text, 0));
    }
    if let Some(index) = ")!@#$%^&*(".find(ch) {
        return Some(key(
            &text,
            &format!("Digit{index}"),
            48 + index as i64,
            &text,
            0,
        ));
    }
    for (plain, shifted, code, key_code) in PUNCTUATION {
        if ch == plain || ch == shifted {
            return Some(key(&text, code, key_code, &text, 0));
        }
    }
    match ch {
        ' ' => Some(key(" ", "Space", 32, " ", 0)),
        '\n' | '\r' => Some(key("Enter", "Enter", 13, "\r", 0)),
        '\t' => Some(key("Tab", "Tab", 9, "", 0)),
        _ => None,
    }
}

/// A key by the name Playwright accepts: a key name, a code, or one character.
fn key_definition(name: &str) -> Option<KeyDefinition> {
    let named = match name {
        "Backspace" => key("Backspace", "Backspace", 8, "", 0),
        "Tab" => key("Tab", "Tab", 9, "", 0),
        "Enter" | "NumpadEnter" => key("Enter", "Enter", 13, "\r", 0),
        "Escape" => key("Escape", "Escape", 27, "", 0),
        "Space" => key(" ", "Space", 32, " ", 0),
        "PageUp" => key("PageUp", "PageUp", 33, "", 0),
        "PageDown" => key("PageDown", "PageDown", 34, "", 0),
        "End" => key("End", "End", 35, "", 0),
        "Home" => key("Home", "Home", 36, "", 0),
        "ArrowLeft" => key("ArrowLeft", "ArrowLeft", 37, "", 0),
        "ArrowUp" => key("ArrowUp", "ArrowUp", 38, "", 0),
        "ArrowRight" => key("ArrowRight", "ArrowRight", 39, "", 0),
        "ArrowDown" => key("ArrowDown", "ArrowDown", 40, "", 0),
        "Insert" => key("Insert", "Insert", 45, "", 0),
        "Delete" => key("Delete", "Delete", 46, "", 0),
        "Shift" | "ShiftLeft" => key("Shift", "ShiftLeft", 16, "", 1),
        "Control" | "ControlLeft" => key("Control", "ControlLeft", 17, "", 1),
        "Alt" | "AltLeft" => key("Alt", "AltLeft", 18, "", 1),
        "Meta" | "MetaLeft" => key("Meta", "MetaLeft", 91, "", 1),
        "ControlOrMeta" => {
            if cfg!(target_os = "macos") {
                key("Meta", "MetaLeft", 91, "", 1)
            } else {
                key("Control", "ControlLeft", 17, "", 1)
            }
        }
        "CapsLock" => key("CapsLock", "CapsLock", 20, "", 0),
        "ContextMenu" => key("ContextMenu", "ContextMenu", 93, "", 0),
        _ => {
            if let Some(number) = name.strip_prefix('F').and_then(|n| n.parse::<i64>().ok())
                && (1..=12).contains(&number)
            {
                return Some(key(name, name, 111 + number, "", 0));
            }
            if let Some(letter) = name.strip_prefix("Key")
                && letter.len() == 1
            {
                return char_key(letter.chars().next()?.to_ascii_lowercase());
            }
            if let Some(digit) = name.strip_prefix("Digit")
                && digit.len() == 1
            {
                return char_key(digit.chars().next()?);
            }
            let mut chars = name.chars();
            return match (chars.next(), chars.next()) {
                (Some(ch), None) => char_key(ch),
                _ => None,
            };
        }
    };
    Some(named)
}

impl PartialEq for PageHandle {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Eq for PageHandle {}

impl std::fmt::Debug for PageHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageHandle")
            .field("target_id", &self.inner.target_id)
            .finish()
    }
}

impl PageHandle {
    /// The context this tab belongs to.
    pub fn context(&self) -> BrowserContextHandle {
        self.inner.context.clone()
    }

    /// The main frame's URL as last committed.
    pub fn url(&self) -> String {
        self.inner.url.lock().clone()
    }

    /// Whether the tab has been closed, by us or by the site.
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }

    /// The DevTools target id of this tab.
    pub fn target_id(&self) -> &str {
        &self.inner.target_id
    }

    /// The document's title.
    pub async fn title(&self) -> anyhow::Result<String> {
        let value = self
            .inner
            .evaluate_in(&self.inner.target_id, World::Utility, "document.title")
            .await
            .map_err(|err| anyhow::anyhow!("page.title: {}", err.message()))?;
        Ok(value.as_str().unwrap_or_default().to_string())
    }

    /// Navigate the main frame and wait for `options.wait_until`.
    ///
    /// Fails when a different navigation interrupts this one, with
    /// `Navigation to "<url>" is interrupted by another navigation to "<url>"`.
    pub async fn goto(&self, url: &str, options: GotoOptions) -> anyhow::Result<()> {
        let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let timed_out = || anyhow::anyhow!("page.goto: Timeout {timeout_ms}ms exceeded.");
        if self.is_closed() {
            anyhow::bail!("page.goto: {CLOSED_MESSAGE}");
        }

        let before = self.inner.state.lock().commit_seq;
        let navigate = self.inner.send(
            "Page.navigate",
            json!({ "url": url, "frameId": self.inner.target_id }),
        );
        let result = match tokio::time::timeout_at(deadline, navigate).await {
            Err(_) => return Err(timed_out()),
            Ok(Err(CommandError::Closed)) => anyhow::bail!("page.goto: {CLOSED_MESSAGE}"),
            Ok(Err(CommandError::Protocol(message))) => anyhow::bail!("page.goto: {message}"),
            Ok(Ok(result)) => result,
        };
        if let Some(error) = result["errorText"].as_str().filter(|text| !text.is_empty()) {
            anyhow::bail!("page.goto: {error} at {url}");
        }
        let Some(loader) = result["loaderId"].as_str().map(str::to_string) else {
            // A navigation within the document commits nothing new.
            return Ok(());
        };

        let lifecycle = options.wait_until.lifecycle_name();
        let mut committed = false;
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_closed() {
                anyhow::bail!("page.goto: {CLOSED_MESSAGE}");
            }
            {
                let state = self.inner.state.lock();
                if !committed && let Some(commit) = state.commits.iter().find(|c| c.seq > before) {
                    if commit.loader != loader {
                        anyhow::bail!(
                            "page.goto: Navigation to \"{url}\" is interrupted by another navigation to \"{}\"",
                            commit.url
                        );
                    }
                    committed = true;
                }
                if committed && state.lifecycle.contains(lifecycle) {
                    return Ok(());
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(timed_out());
            }
        }
    }

    /// Wait until the main frame reaches `state`, or fail after `timeout_ms`.
    pub async fn wait_for_load_state(
        &self,
        state: LoadState,
        timeout_ms: u64,
    ) -> anyhow::Result<()> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let lifecycle = state.lifecycle_name();
        loop {
            let notified = self.inner.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_closed() {
                anyhow::bail!("page.waitForLoadState: {CLOSED_MESSAGE}");
            }
            {
                let current = self.inner.state.lock();
                if current.lifecycle.contains(lifecycle)
                    || (state == LoadState::Commit && current.main_loader.is_some())
                {
                    return Ok(());
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                anyhow::bail!("page.waitForLoadState: Timeout {timeout_ms}ms exceeded.");
            }
        }
    }

    /// Make this the tab the browser window shows.
    pub async fn bring_to_front(&self) -> anyhow::Result<()> {
        self.inner
            .send("Page.bringToFront", json!({}))
            .await
            .map(|_| ())
            .map_err(|err| anyhow::anyhow!("page.bringToFront: {}", err.into_anyhow()))
    }

    /// Close the tab.
    pub async fn close(&self) -> anyhow::Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        let notified = self.inner.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match self
            .inner
            .conn
            .send(
                None,
                "Target.closeTarget",
                json!({ "targetId": self.inner.target_id }),
            )
            .await
        {
            Ok(_) | Err(CommandError::Closed) => {}
            Err(CommandError::Protocol(message)) => anyhow::bail!("page.close: {message}"),
        }
        let deadline = Instant::now() + Duration::from_millis(DEFAULT_TIMEOUT_MS);
        while !self.is_closed() {
            if tokio::time::timeout_at(deadline, notified.as_mut())
                .await
                .is_err()
            {
                break;
            }
            notified.set(self.inner.changed.notified());
            notified.as_mut().enable();
        }
        self.inner.mark_closed();
        Ok(())
    }

    /// Evaluate a JavaScript expression in the main frame and return its value as JSON.
    /// A promise is awaited.
    pub async fn evaluate(&self, expression: &str) -> anyhow::Result<Value> {
        self.inner
            .evaluate_in(&self.inner.target_id, World::Main, expression)
            .await
            .map_err(|err| anyhow::anyhow!("page.evaluate: {}", err.message()))
    }

    /// Call a JavaScript function, given as its source, with `arg` in the main frame,
    /// and return its value as JSON. A promise is awaited.
    pub async fn evaluate_function(&self, function: &str, arg: Value) -> anyhow::Result<Value> {
        let expression = format!("({function})({arg})");
        self.inner
            .evaluate_in(&self.inner.target_id, World::Main, &expression)
            .await
            .map_err(|err| anyhow::anyhow!("page.evaluate: {}", err.message()))
    }

    /// A picture of the tab's viewport.
    pub async fn screenshot(&self, options: ScreenshotOptions) -> anyhow::Result<Vec<u8>> {
        let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let mut params = json!({
            "format": match options.kind { ScreenshotType::Png => "png", ScreenshotType::Jpeg => "jpeg" },
            "captureBeyondViewport": false,
            "fromSurface": true,
        });
        if options.kind == ScreenshotType::Jpeg
            && let Some(quality) = options.quality
        {
            params["quality"] = json!(quality);
        }
        // As Playwright prepares a page: the text caret hidden and the fonts loaded, so
        // the picture shows the page as it rests. A failed step leaves the page as it is.
        let target = &self.inner.target_id;
        let _ = self
            .inner
            .evaluate_in(target, World::Utility, PREPARE_FOR_SCREENSHOT)
            .await;
        let _ = self
            .inner
            .evaluate_in(
                target,
                World::Utility,
                "document.fonts.ready.then(() => true)",
            )
            .await;
        let shot = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.inner.send("Page.captureScreenshot", params),
        )
        .await;
        let _ = self
            .inner
            .evaluate_in(target, World::Utility, CLEANUP_AFTER_SCREENSHOT)
            .await;
        let shot = shot
            .map_err(|_| anyhow::anyhow!("page.screenshot: Timeout {timeout_ms}ms exceeded."))?
            .map_err(|err| anyhow::anyhow!("page.screenshot: {}", err.into_anyhow()))?;
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(shot["data"].as_str().unwrap_or_default())
            .map_err(|err| anyhow::anyhow!("page.screenshot: {err}"))?;
        if let Some(path) = &options.path {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(path, &bytes).await?;
        }
        Ok(bytes)
    }

    /// Sleep for `ms` milliseconds. Fails when the tab is closed, before or during the wait.
    pub async fn wait_for_timeout(&self, ms: u64) -> anyhow::Result<()> {
        if self.is_closed() {
            anyhow::bail!("Target page, context or browser has been closed");
        }
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        if self.is_closed() {
            anyhow::bail!("Target page, context or browser has been closed");
        }
        Ok(())
    }

    /// Type text into whatever has focus, one key at a time, `delay_ms` apart.
    pub async fn keyboard_type(&self, text: &str, delay_ms: u64) -> anyhow::Result<()> {
        self.inner
            .type_text(text, delay_ms)
            .await
            .map_err(|err| anyhow::anyhow!("keyboard.type: {err}"))
    }

    /// Press one key, such as `Enter`, `Escape` or `PageDown`.
    pub async fn keyboard_press(&self, key: &str) -> anyhow::Result<()> {
        self.inner
            .press(key, 0)
            .await
            .map_err(|err| anyhow::anyhow!("keyboard.press: {err}"))
    }

    /// Scroll with the mouse wheel by these pixel amounts.
    pub async fn mouse_wheel(&self, delta_x: f64, delta_y: f64) -> anyhow::Result<()> {
        let (x, y) = *self.inner.mouse.lock();
        self.inner
            .mouse_event(json!({
                "type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y,
                "modifiers": 0,
            }))
            .await
            .map_err(|err| anyhow::anyhow!("mouse.wheel: {err}"))
    }

    /// The main frame.
    pub fn main_frame(&self) -> FrameHandle {
        let mut state = self.inner.state.lock();
        if let Some(frame) = state.frames.get(&self.inner.target_id) {
            return frame.clone();
        }
        let frame = self
            .inner
            .new_frame(&self.inner.target_id, None, &self.inner.session_id);
        *frame.inner.url.lock() = self.url();
        state
            .frames
            .insert(self.inner.target_id.clone(), frame.clone());
        frame
    }

    /// Every frame of the tab, the main frame first.
    pub fn frames(&self) -> Vec<FrameHandle> {
        let main = self.main_frame();
        let state = self.inner.state.lock();
        let mut children: HashMap<String, Vec<FrameHandle>> = HashMap::new();
        for frame in state.frames.values() {
            if let Some(parent) = frame.inner.parent_id.lock().clone() {
                children.entry(parent).or_default().push(frame.clone());
            }
        }
        let mut ordered = Vec::new();
        let mut stack = vec![main];
        while let Some(frame) = stack.pop() {
            if let Some(kids) = children.get(&frame.inner.frame_id) {
                stack.extend(kids.iter().rev().cloned());
            }
            ordered.push(frame);
        }
        ordered
    }

    /// Call `listener` when the tab's renderer crashes.
    pub fn on_crash(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        self.inner.crash_listeners.lock().push(listener);
    }

    /// Call `listener` with each frame that commits a navigation. Answers an id for
    /// `remove_frame_listener`.
    pub fn on_frame_navigated(&self, listener: FrameListener) -> u64 {
        let id = self.inner.next_listener_id.fetch_add(1, Ordering::SeqCst);
        self.inner.frame_listeners.lock().push((id, listener));
        id
    }

    /// Stop calling a listener `on_frame_navigated` added.
    pub fn remove_frame_listener(&self, id: u64) {
        self.inner
            .frame_listeners
            .lock()
            .retain(|(listener_id, _)| *listener_id != id);
    }

    /// Elements matching a CSS selector.
    pub fn locator(&self, selector: &str) -> Locator {
        Locator {
            page: self.clone(),
            steps: vec![LocatorStep::Css(selector.to_string())],
        }
    }

    /// Elements with this ARIA role and, when given, accessible name.
    pub fn get_by_role(&self, role: &str, name: Option<TextMatch>) -> Locator {
        Locator {
            page: self.clone(),
            steps: vec![LocatorStep::Role {
                role: role.to_string(),
                name,
            }],
        }
    }

    /// Elements whose visible text matches.
    pub fn get_by_text(&self, text: TextMatch) -> Locator {
        Locator {
            page: self.clone(),
            steps: vec![LocatorStep::Text(text)],
        }
    }

    /// Form controls whose label matches.
    pub fn get_by_label(&self, text: TextMatch) -> Locator {
        Locator {
            page: self.clone(),
            steps: vec![LocatorStep::Label(text)],
        }
    }

    /// Inputs whose placeholder matches.
    pub fn get_by_placeholder(&self, text: TextMatch) -> Locator {
        Locator {
            page: self.clone(),
            steps: vec![LocatorStep::Placeholder(text)],
        }
    }
}

/// One frame of a tab: the main document or an iframe.
#[derive(Clone)]
pub struct FrameHandle {
    inner: Arc<FrameInner>,
}

struct FrameInner {
    /// The DevTools frame id.
    frame_id: String,
    url: Mutex<String>,
    parent_id: Mutex<Option<String>>,
    /// The session whose renderer holds this frame.
    session_id: Mutex<String>,
    detached: AtomicBool,
    page: Weak<PageInner>,
}

impl PartialEq for FrameHandle {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Eq for FrameHandle {}

impl std::fmt::Debug for FrameHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FrameHandle")
            .field("frame_id", &self.inner.frame_id)
            .field("url", &*self.inner.url.lock())
            .finish()
    }
}

impl FrameHandle {
    /// The frame's committed URL.
    pub fn url(&self) -> String {
        self.inner.url.lock().clone()
    }

    /// Whether the frame has left its tab.
    pub fn is_detached(&self) -> bool {
        self.inner.detached.load(Ordering::SeqCst)
    }

    /// Call a JavaScript function, given as its source, with `arg` in this frame, and
    /// return its value as JSON. A promise is awaited.
    pub async fn evaluate_function(&self, function: &str, arg: Value) -> anyhow::Result<Value> {
        let Some(page) = self.inner.page.upgrade() else {
            anyhow::bail!("frame.evaluate: {CLOSED_MESSAGE}");
        };
        let expression = format!("({function})({arg})");
        page.evaluate_in(&self.inner.frame_id, World::Main, &expression)
            .await
            .map_err(|err| anyhow::anyhow!("frame.evaluate: {}", err.message()))
    }
}

/// A query for elements of a tab, resolved each time an action runs.
///
/// Every action waits for the element up to its timeout, as Playwright's do, and a
/// locator that matches several elements is an error for an action unless narrowed with
/// `first()` or `nth()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Locator {
    page: PageHandle,
    steps: Vec<LocatorStep>,
}

/// What one read of a waiting locator concluded.
enum Probe<T> {
    Done(anyhow::Result<T>),
    /// Not yet; the text says what is still missing, for the timeout's call log.
    Retry(Option<String>),
}

/// How many elements a read of the engine found.
fn matched(value: &Value) -> u64 {
    value["count"].as_u64().unwrap_or(0)
}

impl Locator {
    /// The tab this locator queries.
    pub fn page(&self) -> &PageHandle {
        &self.page
    }

    /// The query, step by step.
    pub fn steps(&self) -> &[LocatorStep] {
        &self.steps
    }

    fn then(&self, step: LocatorStep) -> Locator {
        let mut steps = self.steps.clone();
        steps.push(step);
        Locator {
            page: self.page.clone(),
            steps,
        }
    }

    /// The first match.
    pub fn first(&self) -> Locator {
        self.then(LocatorStep::Nth(0))
    }

    /// The last match.
    pub fn last(&self) -> Locator {
        self.then(LocatorStep::Nth(-1))
    }

    /// The match at `index`.
    pub fn nth(&self, index: i64) -> Locator {
        self.then(LocatorStep::Nth(index))
    }

    /// Everything this or `other` matches, in document order.
    pub fn or(&self, other: Locator) -> Locator {
        self.then(LocatorStep::Or(Box::new(other)))
    }

    /// Elements inside this one matching a CSS selector.
    pub fn locator(&self, selector: &str) -> Locator {
        self.then(LocatorStep::Css(selector.to_string()))
    }

    /// Elements inside this one with an ARIA role and, when given, accessible name.
    pub fn get_by_role(&self, role: &str, name: Option<TextMatch>) -> Locator {
        self.then(LocatorStep::Role {
            role: role.to_string(),
            name,
        })
    }

    fn steps_json(&self) -> Value {
        Value::Array(self.steps.iter().map(LocatorStep::to_json).collect())
    }

    /// The locator as Playwright writes it in an error, such as
    /// `getByRole('button', { name: /join now/i }).first()`.
    pub fn describe(&self) -> String {
        let mut out = String::new();
        for (index, step) in self.steps.iter().enumerate() {
            let dot = if index == 0 { "" } else { "." };
            let part = match step {
                LocatorStep::Css(selector) => format!("{dot}locator({})", quote_js(selector)),
                LocatorStep::Role { role, name } => match name {
                    None => format!("{dot}getByRole({})", quote_js(role)),
                    Some(name) if name.is_exact() => format!(
                        "{dot}getByRole({}, {{ name: {}, exact: true }})",
                        quote_js(role),
                        name.describe()
                    ),
                    Some(name) => format!(
                        "{dot}getByRole({}, {{ name: {} }})",
                        quote_js(role),
                        name.describe()
                    ),
                },
                LocatorStep::Text(text) => described_text(dot, "getByText", text),
                LocatorStep::Label(text) => described_text(dot, "getByLabel", text),
                LocatorStep::Placeholder(text) => described_text(dot, "getByPlaceholder", text),
                LocatorStep::Nth(0) => ".first()".to_string(),
                LocatorStep::Nth(-1) => ".last()".to_string(),
                LocatorStep::Nth(n) => format!(".nth({n})"),
                LocatorStep::Or(other) => format!(".or({})", other.describe()),
            };
            out.push_str(&part);
        }
        out
    }

    /// One read of the engine in the main frame's isolated world.
    async fn read(&self, op: &Value, user_fn: Option<&str>) -> Result<Value, EvalError> {
        let input = json!({ "steps": self.steps_json(), "op": op });
        let expression = format!(
            "({LOCATOR_ENGINE})({input}, {})",
            user_fn
                .map(|f| format!("({f})"))
                .unwrap_or_else(|| "undefined".to_string())
        );
        self.page
            .inner
            .evaluate_in(&self.page.inner.target_id, World::Utility, &expression)
            .await
    }

    fn strict_violation(&self, api: &str, count: u64) -> anyhow::Error {
        anyhow::anyhow!(
            "{api}: Error: strict mode violation: {} resolved to {count} elements",
            self.describe()
        )
    }

    /// Read the engine until `decide` concludes, or fail after `timeout_ms`.
    async fn poll<T>(
        &self,
        api: &str,
        timeout_ms: u64,
        op: Value,
        user_fn: Option<&str>,
        mut decide: impl FnMut(&Value) -> Probe<T>,
    ) -> anyhow::Result<T> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut reason: Option<String> = None;
        for attempt in 0usize.. {
            let pause = POLL_INTERVALS_MS[attempt.min(POLL_INTERVALS_MS.len() - 1)];
            if attempt > 0 {
                if Instant::now() >= deadline {
                    break;
                }
                let wake = (Instant::now() + Duration::from_millis(pause)).min(deadline);
                tokio::time::sleep_until(wake).await;
                if Instant::now() >= deadline {
                    break;
                }
            }
            let read = tokio::time::timeout_at(deadline, self.read(&op, user_fn)).await;
            match read {
                Err(_) => break,
                Ok(Ok(value)) => {
                    if let Some(error) = value["error"].as_str() {
                        anyhow::bail!("{api}: Error: {error}");
                    }
                    match decide(&value) {
                        Probe::Done(outcome) => return outcome,
                        Probe::Retry(why) => {
                            if why.is_some() {
                                reason = why;
                            }
                        }
                    }
                }
                Ok(Err(EvalError::Closed)) => anyhow::bail!("{api}: {CLOSED_MESSAGE}"),
                Ok(Err(EvalError::ContextLost | EvalError::NoContext(_))) => {}
                Ok(Err(EvalError::Exception(message) | EvalError::Protocol(message))) => {
                    anyhow::bail!("{api}: {message}")
                }
            }
        }
        let mut message = format!(
            "{api}: Timeout {timeout_ms}ms exceeded.\nCall log:\n  - waiting for {}",
            self.describe()
        );
        if let Some(reason) = reason {
            message.push_str(&format!("\n  - {reason}"));
        }
        Err(anyhow::anyhow!("{message}"))
    }

    /// Wait until exactly one element matches, then hand its read to `answer`.
    async fn poll_one<T>(
        &self,
        api: &str,
        timeout_ms: u64,
        op: Value,
        user_fn: Option<&str>,
        mut answer: impl FnMut(&Value) -> Probe<T>,
    ) -> anyhow::Result<T> {
        self.poll(api, timeout_ms, op, user_fn, |value| match matched(value) {
            0 => Probe::Retry(None),
            1 => answer(value),
            n => Probe::Done(Err(self.strict_violation(api, n))),
        })
        .await
    }

    /// How many elements match right now.
    pub async fn count(&self) -> anyhow::Result<usize> {
        let value = self
            .read(&json!({ "type": "count" }), None)
            .await
            .map_err(|err| anyhow::anyhow!("locator.count: {}", err.message()))?;
        Ok(matched(&value) as usize)
    }

    /// Wait for the element to reach `state`, failing after `timeout_ms`.
    pub async fn wait_for(&self, state: WaitForState, timeout_ms: u64) -> anyhow::Result<()> {
        let api = "locator.waitFor";
        self.poll(api, timeout_ms, json!({ "type": "state" }), None, |value| {
            let count = matched(value);
            if count > 1 {
                return Probe::Done(Err(self.strict_violation(api, count)));
            }
            let visible = value["visible"].as_bool().unwrap_or(false);
            let reached = match state {
                WaitForState::Attached => count == 1,
                WaitForState::Detached => count == 0,
                WaitForState::Visible => count == 1 && visible,
                WaitForState::Hidden => count == 0 || !visible,
            };
            if reached {
                Probe::Done(Ok(()))
            } else {
                Probe::Retry(None)
            }
        })
        .await
    }

    /// Whether the element is visible right now. Does not wait.
    pub async fn is_visible(&self) -> anyhow::Result<bool> {
        let value = self
            .read(&json!({ "type": "state" }), None)
            .await
            .map_err(|err| anyhow::anyhow!("locator.isVisible: {}", err.message()))?;
        let count = matched(&value);
        if count > 1 {
            return Err(self.strict_violation("locator.isVisible", count));
        }
        Ok(count == 1 && value["visible"].as_bool().unwrap_or(false))
    }

    /// Whether the element is enabled, waiting up to `timeout_ms` for it.
    pub async fn is_enabled(&self, timeout_ms: u64) -> anyhow::Result<bool> {
        self.poll_one(
            "locator.isEnabled",
            timeout_ms,
            json!({ "type": "enabled" }),
            None,
            |value| Probe::Done(Ok(value["enabled"].as_bool().unwrap_or(false))),
        )
        .await
    }

    /// Click the element once it is visible, stable and receives pointer events.
    pub async fn click(&self, timeout_ms: u64) -> anyhow::Result<()> {
        let api = "locator.click";
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let (x, y) = self
            .poll_one(api, timeout_ms, json!({ "type": "click" }), None, |value| {
                if let Some(reason) = value["retry"].as_str() {
                    return Probe::Retry(Some(reason.to_string()));
                }
                match (value["x"].as_f64(), value["y"].as_f64()) {
                    (Some(x), Some(y)) => Probe::Done(Ok((x, y))),
                    _ => Probe::Retry(None),
                }
            })
            .await?;
        tokio::time::timeout_at(deadline, self.page.inner.click_at(x, y))
            .await
            .map_err(|_| anyhow::anyhow!("{api}: Timeout {timeout_ms}ms exceeded."))?
            .map_err(|err| anyhow::anyhow!("{api}: {err}"))
    }

    /// Replace the field's value with `text`.
    pub async fn fill(&self, text: &str, timeout_ms: u64) -> anyhow::Result<()> {
        let api = "locator.fill";
        self.poll_one(
            api,
            timeout_ms,
            json!({ "type": "fill" }),
            None,
            |value| match value["retry"].as_str() {
                Some(reason) => Probe::Retry(Some(reason.to_string())),
                None => Probe::Done(Ok(())),
            },
        )
        .await?;
        let typed = if text.is_empty() {
            self.page.inner.press("Delete", 0).await
        } else {
            self.page.inner.insert_text(text).await
        };
        typed.map_err(|err| anyhow::anyhow!("{api}: {err}"))
    }

    /// Wait for the element and focus it.
    async fn focus(&self, api: &str, timeout_ms: u64) -> anyhow::Result<()> {
        self.poll_one(api, timeout_ms, json!({ "type": "focus" }), None, |_| {
            Probe::Done(Ok(()))
        })
        .await
    }

    /// Focus the element and type `text` one key at a time, `delay_ms` apart.
    pub async fn type_text(
        &self,
        text: &str,
        delay_ms: u64,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        let api = "locator.type";
        self.focus(api, timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))
            .await?;
        self.page
            .inner
            .type_text(text, delay_ms)
            .await
            .map_err(|err| anyhow::anyhow!("{api}: {err}"))
    }

    /// Focus the element and press one key.
    pub async fn press(&self, key: &str, timeout_ms: u64) -> anyhow::Result<()> {
        let api = "locator.press";
        self.focus(api, timeout_ms).await?;
        self.page
            .inner
            .press(key, 0)
            .await
            .map_err(|err| anyhow::anyhow!("{api}: {err}"))
    }

    /// The attribute's value, or `None` when the element lacks it.
    pub async fn get_attribute(
        &self,
        name: &str,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<Option<String>> {
        self.poll_one(
            "locator.getAttribute",
            timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            json!({ "type": "attribute", "name": name }),
            None,
            |value| Probe::Done(Ok(value["value"].as_str().map(str::to_string))),
        )
        .await
    }

    /// The element's rendered text.
    pub async fn inner_text(&self, timeout_ms: Option<u64>) -> anyhow::Result<String> {
        self.poll_one(
            "locator.innerText",
            timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            json!({ "type": "innerText" }),
            None,
            |value| Probe::Done(Ok(value["value"].as_str().unwrap_or_default().to_string())),
        )
        .await
    }

    /// An input's current value.
    pub async fn input_value(&self, timeout_ms: Option<u64>) -> anyhow::Result<String> {
        self.poll_one(
            "locator.inputValue",
            timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            json!({ "type": "inputValue" }),
            None,
            |value| Probe::Done(Ok(value["value"].as_str().unwrap_or_default().to_string())),
        )
        .await
    }

    /// Dispatch a DOM event of this type on the element.
    pub async fn dispatch_event(
        &self,
        event_type: &str,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        self.poll_one(
            "locator.dispatchEvent",
            timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            json!({ "type": "dispatch", "eventType": event_type }),
            None,
            |_| Probe::Done(Ok(())),
        )
        .await
    }

    /// Call a JavaScript function, given as its source, with the element and `arg`.
    pub async fn evaluate_function(&self, function: &str, arg: Value) -> anyhow::Result<Value> {
        self.poll_one(
            "locator.evaluate",
            DEFAULT_TIMEOUT_MS,
            json!({ "type": "evaluate", "arg": arg }),
            Some(function),
            |value| Probe::Done(Ok(value.get("value").cloned().unwrap_or(Value::Null))),
        )
        .await
    }
}

fn described_text(dot: &str, method: &str, text: &TextMatch) -> String {
    if text.is_exact() {
        format!("{dot}{method}({}, {{ exact: true }})", text.describe())
    } else {
        format!("{dot}{method}({})", text.describe())
    }
}

/// A DevTools protocol session: on the browser, or attached to one tab.
pub struct CdpSession {
    browser: BrowserHandle,
    /// The flat-mode session id; `None` for the browser's own session.
    session_id: Option<String>,
}

impl CdpSession {
    /// Send one DevTools command and wait for its result.
    pub async fn send(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.browser
            .inner
            .conn
            .send(self.session_id.as_deref(), method, params)
            .await
            .map_err(CommandError::into_anyhow)
    }

    /// Detach the session.
    pub async fn detach(&self) -> anyhow::Result<()> {
        let Some(session) = &self.session_id else {
            return Ok(());
        };
        self.browser
            .inner
            .conn
            .send(
                None,
                "Target.detachFromTarget",
                json!({ "sessionId": session }),
            )
            .await
            .map(|_| ())
            .map_err(CommandError::into_anyhow)
    }
}

// ---------------------------------------------------------------------------
// The browser process and its tabs.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct BrowserStackState {
    browser: Option<BrowserHandle>,
    context: Option<BrowserContextHandle>,
    process: Option<Child>,
    /// The meeting's own tab, kept so `front()` can answer before a second one exists.
    main_page: Option<PageHandle>,
}

pub struct BrowserStack {
    state: Mutex<BrowserStackState>,
    /// The tabs the agent browses in. The meeting's tab is never one of them.
    ///
    /// A tab the site opened itself is in here too — a link with `target="_blank"` makes a
    /// page the agent never asked for, and a list without it would report a click that did
    /// nothing.
    tabs: Arc<TabSet>,
    /// Tail of the browser's stderr, for explaining a launch failure.
    browser_stderr: Arc<Mutex<String>>,
}

impl Default for BrowserStack {
    fn default() -> Self {
        Self::new()
    }
}

/// Keep the last 2,000 UTF-16 units of the browser's stderr.
fn append_stderr(tail: &Mutex<String>, chunk: &str) {
    let line = chunk.trim();
    if line.is_empty() {
        return;
    }
    let mut tail = tail.lock();
    let joined = format!("{tail}{line}\n");
    let length = crate::support::js::len16(&joined);
    *tail = if length > 2_000 {
        crate::support::js::slice16(&joined, length - 2_000, length)
    } else {
        joined
    };
}

#[cfg(unix)]
fn signal_terminate(proc: &mut Child) {
    if let Some(pid) = proc.id() {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
    }
}

#[cfg(not(unix))]
fn signal_terminate(proc: &mut Child) {
    let _ = proc.start_kill();
}

impl BrowserStack {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BrowserStackState::default()),
            tabs: Arc::new(TabSet::new()),
            browser_stderr: Arc::new(Mutex::new(String::new())),
        }
    }

    /// Start the browser on the virtual display and return a blank page.
    ///
    /// Spawned as its own process with `build_browser_args`, the parent's environment and
    /// `options.env`, stderr kept (the last 2,000 characters) so a launch failure can say
    /// why. The meeting's own page logs `[Meeting] Browser page crashed` at error when its
    /// renderer dies, and a tab the site opens for itself joins the tab set.
    pub async fn start(&self, options: BrowserStackOptions) -> anyhow::Result<PageHandle> {
        // Before the spawn below, not just before the CDP attach that needs it: the
        // child inherits this environment, so doing this later would give the browser of
        // the *first* meeting a different environment from every one after it. Harmless
        // in itself — Chromium bypasses loopback on its own — but an env that changes
        // shape once a meeting has run is a trap for the next reader.
        bypass_proxy_for_loopback();
        let executable_path = resolve_browser().await?;
        let port = free_port().await?;
        let user_data_dir = options.profile_dir.clone().unwrap_or_else(profile_dir);
        tokio::fs::create_dir_all(&user_data_dir).await?;
        clear_stale_profile_locks(&user_data_dir).await;

        // Spawned as its own process rather than launched by an automation library. See
        // the module comment: that launch path is what Meet answers 403 to.
        let mut command = tokio::process::Command::new(&executable_path);
        command
            .args(build_browser_args(port, &user_data_dir.to_string_lossy()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .envs(&options.env);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let err = anyhow::Error::from(err);
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Meeting] Browser process failed"
                );
                return Err(err);
            }
        };
        // Kept so a launch failure can say *why*. Without it, an exit code is all the
        // diagnosis there is, and Chromium's codes are not self-explanatory.
        if let Some(mut stderr) = child.stderr.take() {
            let tail = self.browser_stderr.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 8192];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => append_stderr(&tail, &String::from_utf8_lossy(&buffer[..read])),
                    }
                }
            });
        }
        self.state.lock().process = Some(child);

        let browser = self.attach(port).await?;
        // A CDP-attached browser already has a context; making another would lose the
        // persistent profile, and with it the signed-in session.
        let context = match browser.contexts().into_iter().next() {
            Some(context) => context,
            None => browser.new_context().await?,
        };
        {
            let mut state = self.state.lock();
            state.browser = Some(browser);
            state.context = Some(context.clone());
        }
        grant_media_permissions(&context).await;

        let page = context.new_page().await?;
        page.on_crash(Arc::new(|| log_error!("[Meeting] Browser page crashed")));
        self.state.lock().main_page = Some(page.clone());
        // A page the site opens for itself — a link with `target="_blank"` — arrives here
        // and nowhere else. Registered after the meeting's own page, so that one is never
        // adopted as a tab the agent may navigate.
        let tabs = self.tabs.clone();
        context.on_page(Arc::new(move |opened| tabs.add(opened)));

        Ok(page)
    }

    /// The tab the display is showing, which is the tab a screen share presents.
    ///
    /// Only the methods below bring a tab to the front. So the active tab is in front once
    /// one exists, and before that the meeting tab is the only tab.
    pub fn front(&self) -> Option<PageHandle> {
        self.tabs
            .current()
            .or_else(|| self.state.lock().main_page.clone())
    }

    /// The tab the agent is working in, opening the first one on demand.
    ///
    /// A `goto` on the meeting page would end the call, so every address the agent opens
    /// lands here instead. Reading that page is a different matter: the participants
    /// panel, the share controls and a screenshot of the call all come off it.
    ///
    /// Every call brings the tab to the front, because a screen share captures the display
    /// and not one window.
    ///
    /// The meeting tab then runs in the background. The anti-throttling flags in
    /// `build_browser_args()` keep it working there.
    pub async fn workbench(&self) -> anyhow::Result<PageHandle> {
        if let Some(page) = self.tabs.raise().await? {
            return Ok(page);
        }
        self.open_tab().await
    }

    /// Open a tab and make it the active one.
    ///
    /// Fails with `The browser is not running.` when there is no browser. A tab whose
    /// renderer dies logs `[Meeting] Browser tab crashed` at error.
    pub async fn open_tab(&self) -> anyhow::Result<PageHandle> {
        let Some(context) = self.state.lock().context.clone() else {
            anyhow::bail!("The browser is not running.");
        };
        let page = context.new_page().await?;
        page.on_crash(Arc::new(|| log_error!("[Meeting] Browser tab crashed")));
        self.tabs.add(page.clone());
        page.bring_to_front().await?;
        Ok(page)
    }

    /// The open tabs, oldest first. The active one is `front()`.
    pub fn list_tabs(&self) -> Vec<PageHandle> {
        self.tabs.list()
    }

    /// Match the browser's visible tab after the user has used its tab strip.
    pub async fn observe_front(&self) {
        for page in self.tabs.list() {
            let visible = page
                .evaluate("document.visibilityState === 'visible'")
                .await
                .ok()
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if visible {
                self.tabs.observe(&page);
                return;
            }
        }
    }

    /// Put the active tab back in front, if there is one.
    ///
    /// For a caller that had to work in the meeting tab and now owes the room the tab it
    /// was watching. Opens nothing: a call that never browsed has no tab to raise.
    pub async fn raise_active_tab(&self) -> anyhow::Result<Option<PageHandle>> {
        self.tabs.raise().await
    }

    /// Make tab `index` (zero-based, as `list_tabs` orders them) the active one.
    pub async fn select_tab(&self, index: usize) -> anyhow::Result<Option<PageHandle>> {
        self.tabs.select(index).await
    }

    /// Close tab `index`. The tab before it becomes active.
    pub async fn close_tab(&self, index: usize) -> anyhow::Result<bool> {
        self.tabs.close(index).await
    }

    /// Wait for the debugging endpoint to come up, then connect to it.
    ///
    /// Tries for 30 seconds, 400 ms apart. A browser that exits first fails with
    /// `Browser exited before it was ready (code {code})`, followed by
    /// `: {the last three stderr lines joined with " | "}` when it wrote any; running out of
    /// time fails with `Could not attach to the browser: {last error}`.
    async fn attach(&self, port: u16) -> anyhow::Result<BrowserHandle> {
        let deadline = Instant::now() + Duration::from_millis(30_000);
        let mut last_error = String::new();
        while Instant::now() < deadline {
            let exit_code = {
                let mut state = self.state.lock();
                state
                    .process
                    .as_mut()
                    .and_then(|proc| proc.try_wait().ok().flatten())
                    .and_then(|status| status.code())
            };
            if let Some(code) = exit_code {
                let tail = self.browser_stderr.lock().clone();
                let tail = crate::support::js::trim(&tail);
                let detail = if tail.is_empty() {
                    String::new()
                } else {
                    let lines: Vec<&str> = tail.split('\n').collect();
                    format!(": {}", lines[lines.len().saturating_sub(3)..].join(" | "))
                };
                anyhow::bail!("Browser exited before it was ready (code {code}){detail}");
            }
            match BrowserHandle::connect_over_cdp(&format!("http://127.0.0.1:{port}")).await {
                Ok(browser) => return Ok(browser),
                Err(err) => {
                    last_error = err.to_string();
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
            }
        }
        anyhow::bail!("Could not attach to the browser: {last_error}")
    }

    /// Close the browser. Idempotent, and never fails — teardown must not fail.
    ///
    /// Asks the browser to quit with `Browser.close` first and waits `CLEAN_QUIT_MS` for it,
    /// logging at debug whether it quit when asked. Chromium batches cookie writes and
    /// flushes them when it quits normally; killed by a signal it takes a fast path that
    /// skips the flush, so the next start signs in again. Then detaches, sends SIGTERM, and
    /// after `EXIT_GRACE_MS` logs
    /// `[Meeting] Browser did not exit in time; killing it — the next join may need a fresh sign-in`
    /// at warn and sends SIGKILL.
    pub async fn stop(&self) {
        // Taken and released in the same act, so a second call has nothing to work with
        // and the ladder below cannot run twice against one process.
        let (browser, mut proc) = {
            let mut state = self.state.lock();
            state.context = None;
            state.main_page = None;
            (state.browser.take(), state.process.take())
        };
        self.tabs.clear();

        // Ask the browser to quit before signalling it. Chromium batches cookie writes
        // and flushes them when it quits normally; killed by a signal it takes a fast
        // path that skips the flush, leaving the store as it was some seconds earlier and
        // a `-journal` file beside it. The session Google handed this profile is what is
        // lost that way, so the next start signs in again — and an account that logs in
        // on every start gets challenged. `Browser.close` is the request; detaching only
        // closes the connection.
        if let (Some(browser), Some(proc)) = (&browser, proc.as_mut()) {
            let ask = async {
                let session = browser.new_browser_cdp_session().await?;
                with_timeout(
                    async { session.send("Browser.close", json!({})).await.map(|_| ()) },
                    CLEAN_QUIT_MS as i64,
                )
                .await
            };
            if let Err(err) = ask.await {
                // A connection that drops while the request is in flight is the browser
                // leaving, so the exit test below is the answer rather than this.
                log_debug!("[Meeting] Browser quit request ended early: Error: {}", err);
            }
            if wait_for_exit(proc, CLEAN_QUIT_MS).await {
                log_debug!("[Meeting] Browser quit when asked, so its cookie store is flushed");
            } else {
                log_debug!("[Meeting] Browser did not quit when asked — signalling it");
            }
        }

        // The context belongs to the persistent profile; closing it would be closing
        // the browser's only window out from under the process we spawned. Detach
        // instead, then stop the process itself.
        if let Some(browser) = &browser
            && let Err(err) = browser.close().await
        {
            log_debug!("[Meeting] Browser close failed: Error: {}", err);
        }

        // We spawned it, so we have to reap it: closing the CDP connection leaves the
        // process running with the profile locked, and the next meeting would fail to
        // start with a SingletonLock error.
        let Some(mut proc) = proc else {
            return;
        };
        if has_exited(&mut proc) {
            return;
        }
        signal_terminate(&mut proc);
        // Fifteen seconds, because the cost of being wrong lands on the *next* join: a
        // browser killed mid-write loses the session it was holding.
        if !wait_for_exit(&mut proc, EXIT_GRACE_MS).await {
            log_warn!(
                "[Meeting] Browser did not exit in time; killing it — the next join may need a fresh sign-in"
            );
            let _ = proc.start_kill();
        }
    }
}

/// First browser binary that actually exists on disk, best candidate first.
pub async fn resolve_browser() -> anyhow::Result<String> {
    for candidate in BROWSER_CANDIDATES.iter() {
        if tokio::fs::metadata(candidate).await.is_ok() {
            return Ok(candidate.clone());
        }
    }
    anyhow::bail!(
        "No browser found (looked in {}). Voice meetings need the browser toolchain, which ships in the container image.",
        BROWSER_CANDIDATES.join(", ")
    )
}

/// Addresses that must never be sent to an egress proxy.
const LOOPBACK_PROXY_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// Keep the loopback CDP handshake away from any configured egress proxy.
///
/// Attaching over CDP fetches `/json/version` over plain HTTP before it opens the
/// WebSocket, and an HTTP client that honours `HTTP_PROXY`/`HTTPS_PROXY` for that fetch
/// sends it to the proxy where those are set without a loopback exemption — an ordinary
/// corporate-proxy shape, not an exotic one. The request to *our own browser* is
/// tunnelled to the proxy, which answers with an empty reply. The join then fails as
/// `socket hang up` after burning the full 30s attach deadline, blaming the browser for
/// something the browser had no part in. It cost an afternoon to find the first time.
///
/// Two details are important:
///
/// - **Merged, not assigned.** A deployment that already sets `NO_PROXY` keeps its
///   own entries; we only widen the bypass. Assigning would silently disable
///   whatever exemptions the operator needs.
/// - **The literal `127.0.0.1`, not just `localhost`.** Proxy clients string-match the
///   URL host — no name resolution, no CIDR — and this connects to `127.0.0.1`. So
///   the conventional `NO_PROXY=localhost` looks correct and still fails, which is
///   exactly the trap that makes this worth owning in code rather than leaving to
///   deployment config.
///
/// Called from `start()` rather than from the attach itself, so the Chromium child —
/// spawned with the parent's environment — sees the same value on the first meeting as
/// on every one after it. It is unaffected either way, since it bypasses loopback of its
/// own accord and still proxies everything else, which it must to reach the meeting.
///
/// A lone `*` is left alone. Every proxy client agrees it means "bypass everything",
/// so there is nothing to add; but curl and Python only honour `*` as the *whole*
/// value, not as one entry in a list, so appending would narrow the bypass for the
/// `shell_exec` children that inherit this env — the opposite of the intent.
pub fn bypass_proxy_for_loopback() {
    for key in ["NO_PROXY", "no_proxy"] {
        let current = std::env::var(key).unwrap_or_default();
        let entries: Vec<String> = current
            .split(',')
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
        if entries.iter().any(|entry| entry == "*") {
            continue;
        }
        let missing: Vec<String> = LOOPBACK_PROXY_HOSTS
            .iter()
            .filter(|host| !entries.iter().any(|entry| entry == *host))
            .map(|host| host.to_string())
            .collect();
        if missing.is_empty() {
            continue;
        }
        let merged = entries
            .into_iter()
            .chain(missing)
            .collect::<Vec<_>>()
            .join(",");
        // SAFETY: the runtime changes these two variables from this one place, before it
        // spawns the browser, and reads them only through the environment.
        unsafe { std::env::set_var(key, merged) };
    }
}

/// Whether a browser is available — used to gate the meeting tools.
pub async fn is_browser_available() -> bool {
    resolve_browser().await.is_ok()
}

// ---------------------------------------------------------------------------
// Test support: a browser with no process behind it.
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A browser whose every command is answered with an empty result and recorded.
    ///
    /// Tabs come from `page`. Closing a tab detaches it, as the browser would.
    pub(crate) struct FakeBrowser {
        pub browser: BrowserHandle,
        pub commands: Arc<Mutex<Vec<(Option<String>, String)>>>,
        next_target: AtomicU64,
    }

    impl FakeBrowser {
        pub fn new() -> FakeBrowser {
            let (conn, mut rx) = Connection::new();
            let inner = BrowserInner::new(conn.clone(), "ws://fake".to_string());
            let commands: Arc<Mutex<Vec<(Option<String>, String)>>> = Arc::default();
            let recorded = commands.clone();
            let weak = Arc::downgrade(&inner);
            tokio::spawn(async move {
                while let Some(message) = rx.recv().await {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(command) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    let id = command["id"].as_u64().unwrap_or_default();
                    let method = command["method"].as_str().unwrap_or_default().to_string();
                    let session = command["sessionId"].as_str().map(str::to_string);
                    recorded.lock().push((session, method.clone()));
                    conn.resolve(id, Ok(json!({})));
                    if method == "Target.closeTarget"
                        && let Some(browser) = weak.upgrade()
                    {
                        let target = command["params"]["targetId"].as_str().unwrap_or_default();
                        let page = browser.targets.lock().get(target).cloned();
                        if let Some(page) = page {
                            browser.dispatch(
                                None,
                                "Target.detachedFromTarget",
                                &json!({ "sessionId": page.session_id }),
                            );
                        }
                    }
                }
            });
            FakeBrowser {
                browser: BrowserHandle { inner },
                commands,
                next_target: AtomicU64::new(1),
            }
        }

        /// A tab at `url`, attached and running.
        pub fn page(&self, url: &str) -> PageHandle {
            let n = self.next_target.fetch_add(1, Ordering::SeqCst);
            let inner = &self.browser.inner;
            let page = Arc::new(PageInner::new(
                inner.conn.clone(),
                inner.default_context.clone(),
                format!("target-{n}"),
                format!("session-{n}"),
                url.to_string(),
            ));
            page.initialized.store(true, Ordering::SeqCst);
            inner
                .sessions
                .lock()
                .insert(page.session_id.clone(), page.clone());
            inner
                .targets
                .lock()
                .insert(page.target_id.clone(), page.clone());
            PageHandle { inner: page }
        }

        /// Close a tab the way a site does: the browser reports it gone.
        pub fn close_from_site(&self, page: &PageHandle) {
            let session = page.inner.session_id.clone();
            self.browser.inner.dispatch(
                None,
                "Target.detachedFromTarget",
                &json!({ "sessionId": session }),
            );
        }

        /// The methods sent on a tab's session, oldest first.
        pub fn sent_to(&self, page: &PageHandle) -> Vec<String> {
            self.commands
                .lock()
                .iter()
                .filter(|(session, _)| session.as_deref() == Some(page.inner.session_id.as_str()))
                .map(|(_, method)| method.clone())
                .collect()
        }

        /// Deliver an event from the browser, as if a tab's session raised it.
        pub fn emit(&self, page: &PageHandle, method: &str, params: Value) {
            let session = page.inner.session_id.clone();
            self.browser.inner.dispatch(Some(&session), method, &params);
        }
    }

    /// A Chrome to run against: `PRISM_TEST_CHROME`, or one installed in the usual places.
    fn chrome() -> Option<String> {
        if let Ok(path) = std::env::var("PRISM_TEST_CHROME") {
            return Some(path);
        }
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
        ]
        .into_iter()
        .find(|path| Path::new(path).exists())
        .map(str::to_string)
    }

    /// A real headless browser with one tab, for tests that need a DOM. `start` answers
    /// `None` on a host without Chrome, and those tests then pass without running.
    ///
    /// One runs at a time: a browser is the heaviest thing a test starts, and several at
    /// once beside the rest of the suite push the page reads past their deadlines.
    pub(crate) struct Live {
        pub browser: BrowserHandle,
        pub page: PageHandle,
        process: Child,
        _profile: tempfile::TempDir,
        // Last, so it is released after the browser is gone.
        _one_at_a_time: tokio::sync::OwnedMutexGuard<()>,
    }

    static ONE_BROWSER: std::sync::LazyLock<Arc<tokio::sync::Mutex<()>>> =
        std::sync::LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));

    impl Live {
        pub async fn start() -> Option<Live> {
            let chrome = chrome()?;
            let one_at_a_time = ONE_BROWSER.clone().lock_owned().await;
            let profile = tempfile::tempdir().ok()?;
            let port = free_port().await.ok()?;
            let process = tokio::process::Command::new(chrome)
                .args([
                    "--headless=new".to_string(),
                    format!("--remote-debugging-port={port}"),
                    format!("--user-data-dir={}", profile.path().display()),
                    "--no-first-run".to_string(),
                    "--no-default-browser-check".to_string(),
                    "--window-size=1280,720".to_string(),
                    "about:blank".to_string(),
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .ok()?;
            let mut browser = None;
            for _ in 0..75 {
                if let Ok(connected) =
                    BrowserHandle::connect_over_cdp(&format!("http://127.0.0.1:{port}")).await
                {
                    browser = Some(connected);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let browser = browser?;
            let page = browser.contexts()[0].new_page().await.ok()?;
            Some(Live {
                browser,
                page,
                process,
                _profile: profile,
                _one_at_a_time: one_at_a_time,
            })
        }

        /// Load this markup into the tab.
        pub async fn show(&self, html: &str) {
            let url = format!("data:text/html;charset=utf-8,{}", urlencoding::encode(html));
            self.page
                .goto(
                    &url,
                    GotoOptions {
                        wait_until: LoadState::Load,
                        timeout_ms: Some(10_000),
                    },
                )
                .await
                .unwrap();
        }

        pub async fn stop(mut self) {
            let _ = self.browser.close().await;
            let _ = self.process.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::FakeBrowser;
    use super::*;

    #[test]
    fn grants_camera_and_microphone_without_the_fake_ui_path() {
        let args = build_browser_args(9222, "/tmp/profile");
        assert!(args.contains(&"--auto-accept-camera-and-microphone-capture".to_string()));
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--use-fake-ui-for-media-stream")
        );
    }

    #[test]
    fn selects_the_whole_virtual_screen_so_no_picker_has_to_be_clicked() {
        let args = build_browser_args(9222, "/tmp/profile");
        assert!(args.contains(&"--auto-select-desktop-capture-source=Entire screen".to_string()));
        // The source name is English only because the browser's language is pinned.
        assert!(args.contains(&"--lang=en-US".to_string()));
    }

    #[test]
    fn never_substitutes_a_fake_capture_device() {
        let args = build_browser_args(9222, "/tmp/profile");
        assert!(!args.iter().any(|arg| arg.contains("use-fake-device")));
    }

    #[test]
    fn carries_the_debugging_port_and_profile_it_was_given() {
        let args = build_browser_args(41234, "/data/meeting-browser-profile");
        assert_eq!(args[0], "--remote-debugging-port=41234");
        assert_eq!(args[1], "--user-data-dir=/data/meeting-browser-profile");
        assert_eq!(args.last().map(String::as_str), Some("about:blank"));
        assert!(!args.iter().any(|arg| arg.starts_with("--headless")));
    }

    #[tokio::test]
    async fn removes_only_the_singleton_files_leaving_the_session_intact() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "SingletonLock",
            "SingletonCookie",
            "SingletonSocket",
            "Cookies",
        ] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        clear_stale_profile_locks(dir.path()).await;
        assert!(!dir.path().join("SingletonLock").exists());
        assert!(!dir.path().join("SingletonCookie").exists());
        assert!(!dir.path().join("SingletonSocket").exists());
        assert!(dir.path().join("Cookies").exists());
    }

    #[tokio::test]
    async fn clearing_locks_is_a_no_op_when_the_profile_is_clean() {
        let dir = tempfile::tempdir().unwrap();
        clear_stale_profile_locks(dir.path()).await;
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    #[serial_test::serial(proxy_env)]
    fn exempts_loopback_and_keeps_the_deployments_own_entries() {
        // SAFETY: serialised with every other test that touches these variables.
        unsafe {
            std::env::set_var("NO_PROXY", "internal.example, localhost");
            std::env::remove_var("no_proxy");
        }
        bypass_proxy_for_loopback();
        bypass_proxy_for_loopback();
        let entries: Vec<String> = std::env::var("NO_PROXY")
            .unwrap()
            .split(',')
            .map(str::to_string)
            .collect();
        assert_eq!(
            entries,
            vec!["internal.example", "localhost", "127.0.0.1", "::1"]
        );
        let lower: Vec<String> = std::env::var("no_proxy")
            .unwrap()
            .split(',')
            .map(str::to_string)
            .collect();
        assert_eq!(lower, vec!["127.0.0.1", "localhost", "::1"]);

        // A total bypass is left alone rather than narrowed.
        unsafe { std::env::set_var("NO_PROXY", "*") };
        bypass_proxy_for_loopback();
        assert_eq!(std::env::var("NO_PROXY").unwrap(), "*");
        unsafe {
            std::env::remove_var("NO_PROXY");
            std::env::remove_var("no_proxy");
        }
    }

    #[tokio::test]
    #[serial_test::serial(proxy_env)]
    async fn explains_that_the_toolchain_ships_in_the_container_when_nothing_is_found() {
        let err = match resolve_browser().await {
            Ok(_) => return, // A host with a browser installed has nothing to explain.
            Err(err) => err.to_string(),
        };
        assert!(err.starts_with("No browser found (looked in "));
        assert!(err.ends_with(
            "Voice meetings need the browser toolchain, which ships in the container image."
        ));
        assert!(!is_browser_available().await);
    }

    #[test]
    fn describes_a_locator_as_playwright_writes_it() {
        let fake_page = || {
            let (conn, _rx) = Connection::new();
            let inner = BrowserInner::new(conn.clone(), String::new());
            PageHandle {
                inner: Arc::new(PageInner::new(
                    conn,
                    inner.default_context.clone(),
                    "t".into(),
                    "s".into(),
                    String::new(),
                )),
            }
        };
        let page = fake_page();
        let locator = page
            .get_by_role("button", Some(TextMatch::pattern("join now", "i")))
            .or(page.get_by_role("link", Some(TextMatch::exact("Join"))))
            .first();
        assert_eq!(
            locator.describe(),
            "getByRole('button', { name: /join now/i }).or(getByRole('link', { name: 'Join', exact: true })).first()"
        );
        assert_eq!(
            page.locator("[data-is-muted]").first().describe(),
            "locator('[data-is-muted]').first()"
        );
    }

    #[test]
    fn splits_a_chord_into_its_keys() {
        assert_eq!(split_key_combo("Control+A"), vec!["Control", "A"]);
        assert_eq!(split_key_combo("Control++"), vec!["Control", "+"]);
        assert_eq!(split_key_combo("+"), vec!["+"]);
        assert_eq!(key_definition("Enter").unwrap().text, "\r");
        assert_eq!(key_definition("a").unwrap().code, "KeyA");
        assert_eq!(key_definition("F5").unwrap().key_code, 116);
        assert!(key_definition("NotAKey").is_none());
    }

    #[tokio::test]
    async fn a_page_closed_by_the_browser_reads_as_closed() {
        let fake = FakeBrowser::new();
        let page = fake.page("https://example.com/");
        assert!(!page.is_closed());
        fake.close_from_site(&page);
        assert!(page.is_closed());
        assert!(page.wait_for_timeout(1).await.is_err());
    }

    #[tokio::test]
    async fn a_navigation_moves_the_url_and_tells_the_listeners() {
        let fake = FakeBrowser::new();
        let page = fake.page("about:blank");
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorder = seen.clone();
        let id = page.on_frame_navigated(Arc::new(move |frame| recorder.lock().push(frame.url())));
        fake.emit(
            &page,
            "Page.frameNavigated",
            json!({ "frame": { "id": page.target_id(), "loaderId": "L1", "url": "https://example.com/a" } }),
        );
        page.remove_frame_listener(id);
        fake.emit(
            &page,
            "Page.navigatedWithinDocument",
            json!({ "frameId": page.target_id(), "url": "https://example.com/a#b" }),
        );
        assert_eq!(page.url(), "https://example.com/a#b");
        assert_eq!(*seen.lock(), vec!["https://example.com/a".to_string()]);
        assert_eq!(page.main_frame().url(), "https://example.com/a#b");
    }

    #[tokio::test]
    async fn frames_come_main_first_in_tree_order_and_leave_with_their_parent() {
        let fake = FakeBrowser::new();
        let page = fake.page("about:blank");
        let main = page.target_id().to_string();
        for (id, parent) in [("A", main.as_str()), ("B", main.as_str()), ("A1", "A")] {
            fake.emit(
                &page,
                "Page.frameAttached",
                json!({ "frameId": id, "parentFrameId": parent }),
            );
        }
        let ids: Vec<String> = page
            .frames()
            .iter()
            .map(|frame| frame.inner.frame_id.clone())
            .collect();
        assert_eq!(ids, vec![main.clone(), "A".into(), "A1".into(), "B".into()]);

        fake.emit(
            &page,
            "Page.frameDetached",
            json!({ "frameId": "A", "reason": "swap" }),
        );
        assert_eq!(page.frames().len(), 4);
        fake.emit(
            &page,
            "Page.frameDetached",
            json!({ "frameId": "A", "reason": "remove" }),
        );
        let ids: Vec<String> = page
            .frames()
            .iter()
            .map(|frame| frame.inner.frame_id.clone())
            .collect();
        assert_eq!(ids, vec![main, "B".into()]);
    }

    #[tokio::test]
    async fn a_goto_another_navigation_overtakes_is_reported_as_interrupted() {
        let fake = FakeBrowser::new();
        let page = fake.page("about:blank");
        let target = page.target_id().to_string();
        let navigating = {
            let page = page.clone();
            tokio::spawn(async move {
                page.goto(
                    "https://meet.google.com/abc",
                    GotoOptions {
                        wait_until: LoadState::DomContentLoaded,
                        timeout_ms: Some(2_000),
                    },
                )
                .await
            })
        };
        // The fake answers `Page.navigate` with no loader, which is a same-document
        // navigation: it resolves at once.
        assert!(navigating.await.unwrap().is_ok());

        // A commit that is not ours, seen before ours, is an interruption.
        let before = page.inner.state.lock().commit_seq;
        fake.emit(
            &page,
            "Page.frameNavigated",
            json!({ "frame": { "id": target, "loaderId": "OTHER", "url": "about:blank" } }),
        );
        let state = page.inner.state.lock();
        let commit = state.commits.iter().find(|c| c.seq > before).unwrap();
        assert_eq!(commit.loader, "OTHER");
    }

    /// Against a real headless browser, when the host has one.
    mod live {
        use super::super::testing::Live;
        use super::*;

        #[tokio::test(flavor = "multi_thread")]
        async fn finds_controls_by_role_name_label_text_and_placeholder() {
            let Some(live) = Live::start().await else {
                return;
            };
            live.show(
                r##"<button aria-label="Turn off microphone" data-is-muted="false">mic</button>
                <button>Ask to join without camera</button>
                <button disabled>Join now</button>
                <a href="#x">Sign in with Google</a>
                <label>Your name <input id="name"></label>
                <textarea placeholder="Send a message"></textarea>
                <div style="display:none"><button>Hidden button</button></div>
                <p>Some <b>bold</b> text</p>"##,
            )
            .await;
            let page = &live.page;
            let by =
                |source: &str| page.get_by_role("button", Some(TextMatch::pattern(source, "i")));

            assert_eq!(by("ask to join").count().await.unwrap(), 1);
            assert!(!by("join now").first().is_enabled(1_000).await.unwrap());
            assert_eq!(by("hidden button").count().await.unwrap(), 0);
            assert_eq!(
                page.locator("[data-is-muted][aria-label*=\"microphone\" i]")
                    .first()
                    .get_attribute("data-is-muted", Some(1_000))
                    .await
                    .unwrap()
                    .as_deref(),
                Some("false")
            );
            assert_eq!(
                page.get_by_role("link", Some(TextMatch::exact("Sign in")))
                    .count()
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                page.get_by_role("link", Some(TextMatch::text("sign in")))
                    .count()
                    .await
                    .unwrap(),
                1
            );
            page.get_by_label(TextMatch::text("your name"))
                .fill("Prism", 2_000)
                .await
                .unwrap();
            assert_eq!(
                page.locator("#name")
                    .input_value(Some(1_000))
                    .await
                    .unwrap(),
                "Prism"
            );
            assert_eq!(
                page.get_by_placeholder(TextMatch::text("send a"))
                    .count()
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                page.get_by_text(TextMatch::text("bold"))
                    .count()
                    .await
                    .unwrap(),
                1
            );
            assert!(
                page.locator("textarea")
                    .inner_text(Some(1_000))
                    .await
                    .is_ok()
            );
            let err = page
                .locator("button")
                .wait_for(WaitForState::Visible, 500)
                .await
                .unwrap_err();
            assert!(err.to_string().contains("strict mode violation"), "{err}");
            live.stop().await;
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn clicks_a_control_and_reports_a_covered_one() {
            let Some(live) = Live::start().await else {
                return;
            };
            live.show(
                r#"<button id="go" onclick="this.textContent='clicked'">Go</button>
                <div style="position:relative">
                  <button id="under">Under</button>
                  <div class="scrim" style="position:absolute;inset:0;width:300px;height:60px"></div>
                </div>
                <input id="box"><textarea id="area"></textarea>"#,
            )
            .await;
            let page = &live.page;
            page.locator("#go").click(3_000).await.unwrap();
            assert_eq!(
                page.locator("#go").inner_text(Some(1_000)).await.unwrap(),
                "clicked"
            );
            let err = page
                .locator("#under")
                .click(800)
                .await
                .unwrap_err()
                .to_string();
            assert!(
                err.starts_with("locator.click: Timeout 800ms exceeded."),
                "{err}"
            );
            assert!(err.contains("intercepts pointer events"), "{err}");

            page.locator("#box")
                .type_text("hi there", 0, Some(2_000))
                .await
                .unwrap();
            assert_eq!(
                page.locator("#box").input_value(None).await.unwrap(),
                "hi there"
            );
            page.locator("#area").fill("draft", 2_000).await.unwrap();
            page.locator("#area").press("Enter", 2_000).await.unwrap();
            assert_eq!(
                page.locator("#area").input_value(None).await.unwrap(),
                "draft\n"
            );
            live.stop().await;
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn evaluates_in_the_page_and_reports_a_bad_address() {
            let Some(live) = Live::start().await else {
                return;
            };
            live.show(r#"<title>Hello</title><p>x</p><input id="i" style="caret-color: red">"#)
                .await;
            let page = &live.page;
            assert_eq!(page.title().await.unwrap(), "Hello");
            assert_eq!(
                page.evaluate_function("(a) => a.n + 1", json!({ "n": 2 }))
                    .await
                    .unwrap(),
                json!(3)
            );
            let err = page
                .evaluate("(() => { throw new Error('boom') })()")
                .await
                .unwrap_err();
            assert!(err.to_string().contains("boom"), "{err}");
            assert_eq!(page.frames().len(), 1);
            assert!(page.url().starts_with("data:text/html"));
            let shot = page
                .screenshot(ScreenshotOptions {
                    kind: ScreenshotType::Jpeg,
                    quality: Some(75),
                    ..Default::default()
                })
                .await
                .unwrap();
            assert_eq!(&shot[..2], &[0xFF, 0xD8]);
            // The caret is hidden for the picture only: the page's own style is back.
            assert_eq!(
                page.evaluate("document.getElementById('i').style.caretColor")
                    .await
                    .unwrap(),
                json!("red")
            );
            let err = page
                .goto(
                    "http://nonexistent.invalid/",
                    GotoOptions {
                        wait_until: LoadState::DomContentLoaded,
                        timeout_ms: Some(10_000),
                    },
                )
                .await
                .unwrap_err()
                .to_string();
            assert!(err.starts_with("page.goto: net::ERR_"), "{err}");
            live.stop().await;
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn tells_the_context_about_a_tab_it_opens() {
            let Some(live) = Live::start().await else {
                return;
            };
            let opened = Arc::new(Mutex::new(Vec::<PageHandle>::new()));
            let recorder = opened.clone();
            live.page
                .context()
                .on_page(Arc::new(move |page| recorder.lock().push(page)));
            let tab = live.page.context().new_page().await.unwrap();
            assert_eq!(*opened.lock(), vec![tab.clone()]);
            tab.close().await.unwrap();
            assert!(tab.is_closed());
            live.stop().await;
        }
    }
}
