//! The runtime's persistent virtual desktop, browser, screen stream, and input.

use std::any::Any;
use std::collections::HashMap;

use indexmap::IndexMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use super::computer::{Computer, SignInFormInfo};
use super::computer_session::SignInOutcome;
use super::computer_tools::{
    ClickInput, ClickTextInput, ComputerBrowser, ComputerDesktop, ComputerUserScreen,
    DesktopActionResult, DragInput, FindTextInput, FindTextResult, KeyInput, ListElementsInput,
    MoveInput, ScreenLook, ScrollInput, TextLocation, TypeInput, UserScreenResult,
    WindowActionInput,
};
use super::desktop_control::DesktopControl;
use super::desktop_input::DesktopInput;
use super::desktop_session::DesktopSession;
use super::desktop_windows::WindowAction;
use super::picture_stream::{FrameSink, PictureStream};
use super::screen_size::{DEFAULT_SCREEN, ScreenSize};
use super::sign_in_form::SignInCredentials;
use crate::services::meeting::audio_stack::{AudioStack, AudioStackHandles};
use crate::services::meeting::browser_control::{BrowserCommand, BrowserResult};
use crate::services::meeting::browser_stack::{BrowserStack, PageHandle};

/// How the computer shows the model what it did: a picture into the live session, and a
/// line of narration when something changed that nobody asked about.
///
/// The note on a picture says the picture is a tool's answer rather than something the
/// user said, since a session takes both on the same conversation.
pub trait ModelChannel: Send + Sync {
    /// Put a picture in front of the model. False when it did not get through.
    fn show_image(&self, image_url: &str, note: &str) -> bool;
    /// Tell the model something in words, without asking it to answer.
    fn notify(&self, text: &str);
}

/// The channels of the actions running on one computer, keyed by this scope's number.
type ChannelMap = Arc<HashMap<u64, Arc<dyn ModelChannel>>>;

tokio::task_local! {
    /// Every computer's channel for the action the current task runs, by scope number.
    static MODEL_CHANNELS: ChannelMap;
}

static NEXT_SCOPE: AtomicU64 = AtomicU64::new(1);

/// Where one computer's pictures and narration go: the channel of the action the current
/// task runs on that computer. An action on another computer, nested inside it, sees its
/// own channel or none.
pub struct ModelChannelScope {
    id: u64,
}

impl ModelChannelScope {
    pub fn new() -> Self {
        ModelChannelScope {
            id: NEXT_SCOPE.fetch_add(1, Ordering::Relaxed),
        }
    }

    /// Run `action` with `channel` as this computer's channel. A task the action spawns
    /// starts with no channel.
    pub async fn run<F: Future>(&self, channel: Arc<dyn ModelChannel>, action: F) -> F::Output {
        let mut channels: HashMap<u64, Arc<dyn ModelChannel>> = MODEL_CHANNELS
            .try_with(|map| (**map).clone())
            .unwrap_or_default();
        channels.insert(self.id, channel);
        MODEL_CHANNELS.scope(Arc::new(channels), action).await
    }

    /// The channel of the action the current task runs on this computer.
    pub fn current(&self) -> Option<Arc<dyn ModelChannel>> {
        MODEL_CHANNELS
            .try_with(|map| map.get(&self.id).cloned())
            .ok()
            .flatten()
    }
}

impl Default for ModelChannelScope {
    fn default() -> Self {
        ModelChannelScope::new()
    }
}

/// Whether a capture chunk is nothing but silence, which is most of them.
fn is_silent(pcm: &[u8]) -> bool {
    pcm.iter().all(|&byte| byte == 0)
}

/// What `encodeURIComponent` leaves as it is.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// What the agent's working tab shows before it goes anywhere. A page with content, so
/// the screen stream has a picture from the first second; `about:blank` never repaints
/// and so never produces a frame.
static START_PAGE: LazyLock<String> = LazyLock::new(|| {
    let html = concat!(
        "<!doctype html><title>Ready</title>",
        "<body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;",
        "background:#18181b;color:#a1a1aa;font:24px system-ui,sans-serif\">Ready</body>",
    );
    format!(
        "data:text/html,{}",
        utf8_percent_encode(html, URI_COMPONENT)
    )
});

/// The label a screenshot goes into the session with; see `meeting_bot_service.rs`.
const SCREEN_LOOK_NOTE: &str = "This is a picture of your own screen as it looks right now, in answer to your computer_screen call. Your user did not say this.";
const DESKTOP_AFTER_NOTE: &str = "This is a picture of your own screen right after the desktop action you just took. Your user did not say this.";
/// How long the desktop gets to redraw after an action before the picture is taken.
pub const ACTION_SETTLE_MS: u64 = 400;
const USER_SCREEN_NOTE: &str = "This is a picture of your user's own screen, which they are sharing with you, in answer to your computer_user_screen call. Your user did not say this.";

/// A shared-screen picture larger than this is refused; a 1280-wide JPEG is far smaller.
const USER_SCREEN_MAX_CHARS: usize = 6 * 1024 * 1024;
/// How much of the words read off the user's screen goes back to the model.
const USER_SCREEN_TEXT_MAX_CHARS: usize = 4_000;

/// The past tense of each window action, for the message that comes back.
pub fn window_action_done(action: WindowAction) -> &'static str {
    match action {
        WindowAction::Focus => "Brought to the front",
        WindowAction::Close => "Closed",
        WindowAction::Maximize => "Maximised",
        WindowAction::Restore => "Restored",
        WindowAction::Minimize => "Minimised",
    }
}

/// The newest picture of the user's shared screen.
#[derive(Debug, Clone)]
struct SharedScreen {
    jpeg: Bytes,
    width: i64,
    height: i64,
    /// When it arrived, in epoch milliseconds.
    at: i64,
}

struct AgentComputerState {
    browser: Option<Arc<BrowserStack>>,
    /// The newest picture of the user's shared screen, while they share one.
    user_screen: Option<SharedScreen>,
    /// Mouse, keyboard and camera for the virtual display. `None` until the browser opens.
    desktop_control: Option<Arc<DesktopControl>>,
    /// DISPLAY plus the session bus, for the tree dump and `wmctrl`.
    desktop_env: IndexMap<String, String>,
    /// The user's own pointer and keyboard on that display, from the page.
    input: Option<Arc<DesktopInput>>,
    /// The first, blank tab `BrowserStack::start()` opens; `browse` works in others.
    main_page: Option<PageHandle>,
    /// The virtual display the browser and its desktop run on.
    display: Option<Arc<AudioStack>>,
    /// The virtual display's audio devices. Every program on the desktop plays into their
    /// sink, and its monitor is how the page hears them.
    audio_handles: Option<Arc<AudioStackHandles>>,
    /// The XFCE desktop on the virtual display.
    desktop: Option<Arc<DesktopSession>>,
    screen: Option<Arc<dyn PictureStream>>,
    /// The fixed desktop size; viewers scale its picture.
    size: ScreenSize,
}

/// Everything the runtime's computer owns, released together when it ends.
pub struct AgentComputer {
    /// Where pictures and narration go once the session has a model to show them to.
    channels: ModelChannelScope,
    state: Mutex<AgentComputerState>,
    /// Whether ffmpeg and Tesseract are on this host, so the shared screen can be read as
    /// text. Asked once.
    ocr_available: tokio::sync::OnceCell<bool>,
    /// Everything that moves the front tab runs in arrival order; see the meeting service.
    front_queue: tokio::sync::Mutex<()>,
}

impl AgentComputer {
    pub fn new() -> Self {
        AgentComputer {
            channels: ModelChannelScope::new(),
            state: Mutex::new(AgentComputerState {
                browser: None,
                user_screen: None,
                desktop_control: None,
                desktop_env: IndexMap::new(),
                input: None,
                main_page: None,
                display: None,
                audio_handles: None,
                desktop: None,
                screen: None,
                size: DEFAULT_SCREEN,
            }),
            ocr_available: tokio::sync::OnceCell::new(),
            front_queue: tokio::sync::Mutex::new(()),
        }
    }

    fn channel(&self) -> Option<Arc<dyn ModelChannel>> {
        self.channels.current()
    }

    /// Bring up the display, the desktop and the browser, at `screen` when given. Fails with
    /// `Could not open the browser: <reason>`, having stopped whatever had started.
    pub async fn open_browser(&self, screen: Option<ScreenSize>) -> anyhow::Result<()> {
        todo!()
    }

    /// Send what the desktop plays, 48 kHz pcm16 mono, silence left out.
    ///
    /// False when there is no display to record from, which is a computer that never
    /// opened.
    pub fn start_browser_audio(&self, on_pcm: Arc<dyn Fn(Bytes) + Send + Sync>) -> bool {
        todo!()
    }

    /// Whether the computer tools have a desktop to act on.
    pub fn has_desktop(&self) -> bool {
        self.state.lock().desktop_control.is_some()
    }

    async fn target_of(&self, page: &PageHandle) -> anyhow::Result<Option<String>> {
        todo!()
    }

    fn tab_page(&self, tab: Option<i64>) -> Option<PageHandle> {
        todo!()
    }

    async fn page_for_target(
        &self,
        target_id: &str,
    ) -> anyhow::Result<Option<(PageHandle, usize)>> {
        todo!()
    }

    /// The words on a shared-screen picture, or `None` where this host cannot read them.
    async fn read_user_screen_text(&self, jpeg: Bytes) -> Option<String> {
        todo!()
    }

    /// Find `query` on the screen: a control of that name in the accessibility tree first,
    /// which is exact and quick, else words read off the screen. Queued with the other
    /// screen work.
    async fn locate_text(
        &self,
        control: Arc<DesktopControl>,
        query: &str,
    ) -> anyhow::Result<Vec<TextLocation>> {
        todo!()
    }

    /// Run one desktop action, wait for the screen to settle, and show the model the
    /// result. Queued with the browser commands, since both move what is on the screen.
    async fn desktop_action<F, Fut>(&self, act: F, message: String) -> DesktopActionResult
    where
        F: FnOnce(Arc<DesktopControl>) -> Fut + Send,
        Fut: Future<Output = anyhow::Result<()>> + Send,
    {
        todo!()
    }

    /// One picture of the desktop into the session. Answers whether the model got it.
    async fn show_desktop(&self, control: &DesktopControl, note: &str) -> anyhow::Result<bool> {
        todo!()
    }

    async fn on_front_queue<F: Future>(&self, run: F) -> F::Output {
        let _turn = self.front_queue.lock().await;
        run.await
    }

    /// The tab commands are answered here; the rest go to the page. Same shape as the
    /// meeting's.
    async fn run_browse_command(
        &self,
        browser: &BrowserStack,
        command: BrowserCommand,
    ) -> anyhow::Result<BrowserResult> {
        todo!()
    }
}

impl Default for AgentComputer {
    fn default() -> Self {
        AgentComputer::new()
    }
}

#[async_trait]
impl ComputerBrowser for AgentComputer {
    async fn browse(&self, command: BrowserCommand) -> BrowserResult {
        todo!()
    }

    /// Show the model the screen: the whole desktop where the runtime owns the display,
    /// else the browser tab in front. The tab's reading goes along in both cases, since
    /// the words on the page are worth more to a voice model than pixels.
    async fn look_at_screen(&self) -> ScreenLook {
        todo!()
    }
}

#[async_trait]
impl ComputerDesktop for AgentComputer {
    /// The model's picture size; its coordinates refer to this, not to the screen.
    fn width(&self) -> i64 {
        self.state
            .lock()
            .desktop_control
            .as_ref()
            .map_or(0, |control| control.picture_width())
    }

    fn height(&self) -> i64 {
        self.state
            .lock()
            .desktop_control
            .as_ref()
            .map_or(0, |control| control.picture_height())
    }

    /// The desktop's controls as a reading, from the accessibility tree.
    async fn list_elements(&self, input: ListElementsInput) -> DesktopActionResult {
        todo!()
    }

    async fn list_windows(&self) -> DesktopActionResult {
        todo!()
    }

    async fn window_action(&self, input: WindowActionInput) -> DesktopActionResult {
        todo!()
    }

    /// Where a control or some words are on the screen right now, in picture coordinates.
    async fn find_text(&self, input: FindTextInput) -> FindTextResult {
        todo!()
    }

    /// Click the centre of some words on the screen.
    async fn click_text(&self, input: ClickTextInput) -> DesktopActionResult {
        todo!()
    }

    async fn move_pointer(&self, input: MoveInput) -> DesktopActionResult {
        todo!()
    }

    async fn click(&self, input: ClickInput) -> DesktopActionResult {
        todo!()
    }

    async fn drag(&self, input: DragInput) -> DesktopActionResult {
        todo!()
    }

    async fn type_text(&self, input: TypeInput) -> DesktopActionResult {
        todo!()
    }

    async fn key(&self, input: KeyInput) -> DesktopActionResult {
        todo!()
    }

    async fn scroll(&self, input: ScrollInput) -> DesktopActionResult {
        todo!()
    }
}

#[async_trait]
impl ComputerUserScreen for AgentComputer {
    /// Show the model the user's shared screen, as last received: the picture into the
    /// session, and the words on it as text, since a model reading a picture gets the gist
    /// of a dialog but garbles an error code or a hostname, which is what people share.
    async fn look_at_user_screen(&self) -> UserScreenResult {
        todo!()
    }
}

#[async_trait]
impl Computer for AgentComputer {
    async fn with_model_channel(&self, channel: Arc<dyn ModelChannel>, action: BoxFuture<'_, ()>) {
        self.channels.run(channel, action).await
    }

    /// Start sending the screen to the page as video; `open_browser()` has to have run.
    fn start_screen_stream(&self, on_frame: FrameSink) {
        todo!()
    }

    /// Stop sending the screen. The computer runs on; a later client starts it again.
    fn stop_screen_stream(&self) {
        todo!()
    }

    /// A text frame from the page: the user's shared screen (`user_screen_started`,
    /// `user_screen` with base64 `data`, `width` and `height`, `user_screen_stopped`), or
    /// their pointer and keyboard while they hold the desktop.
    fn handle_input(&self, text: &str) {
        todo!()
    }

    fn release_input(&self) {
        todo!()
    }

    /// End a secure takeover: empty every password field the browser holds, and drop
    /// the retained picture of the user's own shared screen. Sharing goes on, so the
    /// next frame replaces what this drops.
    async fn clear_after_secure_window(&self) -> anyhow::Result<()> {
        todo!()
    }

    async fn tab_target(&self, tab: Option<i64>) -> anyhow::Result<Option<String>> {
        todo!()
    }

    /// Fails with `The tab needing help has closed. You have control of the current
    /// desktop.` when no tab has that target.
    async fn focus_target(&self, target_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// The sign-in on a tab: where it goes, and what the box for it asks for.
    ///
    /// Asked when the agent says a help request is that kind, so the box is only offered
    /// where the runtime can really type it, and names the site the user signs in to. The
    /// site is the origin of the frame holding the form rather than the tab's own, since a
    /// sign-in is often an iframe from somewhere else, and that is where the password goes.
    /// A page that asks for the username first needs both fields, since the runtime answers
    /// its second screen as well; only a page that asks for the password alone drops the
    /// username.
    ///
    /// The tab the agent named first, then every other one it has open: it asks for help
    /// with the work rather than with a tab, and the sign-in is often not where it was
    /// last looking. Whichever tab holds the form is the one the box names and the one
    /// the typing goes to.
    async fn sign_in_form(&self, tab: Option<i64>) -> anyhow::Result<Option<SignInFormInfo>> {
        todo!()
    }

    /// Type a sign-in the user answered, into the tab that asked for it.
    ///
    /// Only a frame whose origin is the one the user was shown is touched, so a page that
    /// has moved on, or an iframe that has been replaced by another site's, takes nothing.
    /// The tab is brought to the front first: a background tab takes no key press, and the
    /// sign-in happens where anybody watching the screen can see it.
    async fn sign_in(
        &self,
        target_id: &str,
        site: &str,
        credentials: &SignInCredentials,
    ) -> anyhow::Result<SignInOutcome> {
        todo!()
    }

    /// Release everything. Safe to call more than once.
    async fn stop(&self) -> anyhow::Result<()> {
        todo!()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}
