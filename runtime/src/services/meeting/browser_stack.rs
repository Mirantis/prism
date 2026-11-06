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
//! written against.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::process::Child;

use crate::services::meeting::browser_tabs::TabSet;

/// Browser binaries to try, best first.
///
/// Real Google Chrome is preferred over Debian's `chromium` where present: Meet
/// scores the client, and Chrome-branded builds are the documented winning side of
/// that. `PRISM_CHROMIUM_PATH` overrides for hosts with a different layout.
static BROWSER_CANDIDATES: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PRISM_CHROMIUM_PATH") {
        if !path.is_empty() {
            candidates.push(path);
        }
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
async fn clear_stale_profile_locks(user_data_dir: &std::path::Path) {
    todo!()
}

/// Wait for a spawned process to leave, up to `ms`, polling every 200 ms. Reports
/// whether it did, whether it exited or died from a signal.
async fn wait_for_exit(proc: &mut Child, ms: u64) -> bool {
    todo!()
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
        // runtime already runs inside the Lens Agents sandbox with filtered egress, and
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
/// Best effort — a failure here (`[Meeting] Could not pre-grant the media permissions`,
/// warn) is not a reason to abandon a join the flag can carry on its own.
async fn grant_media_permissions(context: &BrowserContextHandle) {
    todo!()
}

/// An unused localhost port for the browser's debugging endpoint.
async fn free_port() -> anyhow::Result<u16> {
    todo!()
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

/// A connection to the browser's DevTools endpoint.
///
/// Cloning shares the one connection. Closing it detaches; the browser process keeps
/// running until it is asked to quit with `Browser.close`.
#[derive(Clone)]
pub struct BrowserHandle {
    inner: Arc<BrowserInner>,
}

struct BrowserInner {
    /// The `webSocketDebuggerUrl` the browser announced at `/json/version`.
    ws_url: String,
    /// Bumped for each command, so a reply can be matched to its request.
    next_command_id: AtomicU64,
    connected: AtomicBool,
    contexts: Mutex<Vec<BrowserContextHandle>>,
}

impl BrowserHandle {
    /// Attach to a running browser's debugging endpoint, `http://127.0.0.1:<port>`.
    ///
    /// Reads `/json/version` over plain HTTP, then opens the DevTools WebSocket it names.
    pub async fn connect_over_cdp(endpoint_url: &str) -> anyhow::Result<BrowserHandle> {
        todo!()
    }

    /// The browser's contexts. A browser attached over CDP has its default context here.
    pub fn contexts(&self) -> Vec<BrowserContextHandle> {
        self.inner.contexts.lock().clone()
    }

    /// Create a new, empty context.
    pub async fn new_context(&self) -> anyhow::Result<BrowserContextHandle> {
        todo!()
    }

    /// A DevTools session on the browser itself, for browser-wide commands.
    pub async fn new_browser_cdp_session(&self) -> anyhow::Result<CdpSession> {
        todo!()
    }

    /// Detach from the browser. The process keeps running.
    pub async fn close(&self) -> anyhow::Result<()> {
        todo!()
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

impl BrowserContextHandle {
    /// Grant these permissions to every origin, and deny every other permission.
    pub async fn grant_permissions(&self, permissions: &[&str]) -> anyhow::Result<()> {
        todo!()
    }

    /// Open a tab in this context.
    pub async fn new_page(&self) -> anyhow::Result<PageHandle> {
        todo!()
    }

    /// Call `listener` with every tab this context opens from now on.
    pub fn on_page(&self, listener: PageListener) {
        self.inner.page_listeners.lock().push(listener);
    }

    /// A DevTools session attached to one of this context's tabs.
    pub async fn new_cdp_session(&self, page: &PageHandle) -> anyhow::Result<CdpSession> {
        todo!()
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

struct PageInner {
    context: BrowserContextHandle,
    /// The DevTools target id of this tab.
    target_id: String,
    /// The DevTools session attached to it.
    session_id: String,
    /// The main frame's committed URL.
    url: Mutex<String>,
    closed: AtomicBool,
    frames: Mutex<Vec<FrameHandle>>,
    crash_listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    frame_listeners: Mutex<Vec<(u64, FrameListener)>>,
    next_listener_id: AtomicU64,
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

    /// The document's title.
    pub async fn title(&self) -> anyhow::Result<String> {
        todo!()
    }

    /// Navigate the main frame and wait for `options.wait_until`.
    ///
    /// Fails when a different navigation interrupts this one, with
    /// `Navigation to "<url>" is interrupted by another navigation to "<url>"`.
    pub async fn goto(&self, url: &str, options: GotoOptions) -> anyhow::Result<()> {
        todo!()
    }

    /// Wait until the main frame reaches `state`, or fail after `timeout_ms`.
    pub async fn wait_for_load_state(
        &self,
        state: LoadState,
        timeout_ms: u64,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Make this the tab the browser window shows.
    pub async fn bring_to_front(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Close the tab.
    pub async fn close(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Evaluate a JavaScript expression in the main frame and return its value as JSON.
    /// A promise is awaited.
    pub async fn evaluate(&self, expression: &str) -> anyhow::Result<Value> {
        todo!()
    }

    /// Call a JavaScript function, given as its source, with `arg` in the main frame,
    /// and return its value as JSON. A promise is awaited.
    pub async fn evaluate_function(&self, function: &str, arg: Value) -> anyhow::Result<Value> {
        todo!()
    }

    /// A picture of the tab's viewport.
    pub async fn screenshot(&self, options: ScreenshotOptions) -> anyhow::Result<Vec<u8>> {
        todo!()
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
        todo!()
    }

    /// Press one key, such as `Enter`, `Escape` or `PageDown`.
    pub async fn keyboard_press(&self, key: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Scroll with the mouse wheel by these pixel amounts.
    pub async fn mouse_wheel(&self, delta_x: f64, delta_y: f64) -> anyhow::Result<()> {
        todo!()
    }

    /// The main frame.
    pub fn main_frame(&self) -> FrameHandle {
        todo!()
    }

    /// Every frame of the tab, the main frame first.
    pub fn frames(&self) -> Vec<FrameHandle> {
        self.inner.frames.lock().clone()
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
}

impl PartialEq for FrameHandle {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Eq for FrameHandle {}

impl FrameHandle {
    /// The frame's committed URL.
    pub fn url(&self) -> String {
        self.inner.url.lock().clone()
    }

    /// Call a JavaScript function, given as its source, with `arg` in this frame, and
    /// return its value as JSON. A promise is awaited.
    pub async fn evaluate_function(&self, function: &str, arg: Value) -> anyhow::Result<Value> {
        todo!()
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

    /// How many elements match right now.
    pub async fn count(&self) -> anyhow::Result<usize> {
        todo!()
    }

    /// Wait for the element to reach `state`, failing after `timeout_ms`.
    pub async fn wait_for(&self, state: WaitForState, timeout_ms: u64) -> anyhow::Result<()> {
        todo!()
    }

    /// Whether the element is visible right now. Does not wait.
    pub async fn is_visible(&self) -> anyhow::Result<bool> {
        todo!()
    }

    /// Whether the element is enabled, waiting up to `timeout_ms` for it.
    pub async fn is_enabled(&self, timeout_ms: u64) -> anyhow::Result<bool> {
        todo!()
    }

    /// Click the element once it is visible, stable and receives pointer events.
    pub async fn click(&self, timeout_ms: u64) -> anyhow::Result<()> {
        todo!()
    }

    /// Replace the field's value with `text`.
    pub async fn fill(&self, text: &str, timeout_ms: u64) -> anyhow::Result<()> {
        todo!()
    }

    /// Focus the element and type `text` one key at a time, `delay_ms` apart.
    pub async fn type_text(
        &self,
        text: &str,
        delay_ms: u64,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Focus the element and press one key.
    pub async fn press(&self, key: &str, timeout_ms: u64) -> anyhow::Result<()> {
        todo!()
    }

    /// The attribute's value, or `None` when the element lacks it.
    pub async fn get_attribute(
        &self,
        name: &str,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<Option<String>> {
        todo!()
    }

    /// The element's rendered text.
    pub async fn inner_text(&self, timeout_ms: Option<u64>) -> anyhow::Result<String> {
        todo!()
    }

    /// An input's current value.
    pub async fn input_value(&self, timeout_ms: Option<u64>) -> anyhow::Result<String> {
        todo!()
    }

    /// Dispatch a DOM event of this type on the element.
    pub async fn dispatch_event(
        &self,
        event_type: &str,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Call a JavaScript function, given as its source, with the element and `arg`.
    pub async fn evaluate_function(&self, function: &str, arg: Value) -> anyhow::Result<Value> {
        todo!()
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
        todo!()
    }

    /// Detach the session.
    pub async fn detach(&self) -> anyhow::Result<()> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// The open tabs, oldest first. The active one is `front()`.
    pub fn list_tabs(&self) -> Vec<PageHandle> {
        self.tabs.list()
    }

    /// Match the browser's visible tab after the user has used its tab strip.
    pub async fn observe_front(&self) {
        todo!()
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
        todo!()
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
        todo!()
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
