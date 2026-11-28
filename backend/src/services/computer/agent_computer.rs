//! The runtime's persistent virtual desktop, browser, screen stream, and input.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::computer::{Computer, CredentialFields, SignInFormInfo};
use super::computer_session::SignInOutcome;
use super::computer_tools::{
    ClickInput, ClickTextInput, ComputerBrowser, ComputerDesktop, ComputerUserScreen,
    DesktopActionResult, DragInput, FindTextInput, FindTextResult, KeyInput, ListElementsInput,
    MoveInput, ScreenLook, ScrollInput, TextLocation, TypeInput, UserScreenResult,
    WindowActionInput,
};
use super::desktop_control::{DesktopControl, MouseButton, Point};
use super::desktop_input::DesktopInput;
use super::desktop_session::DesktopSession;
use super::desktop_windows::{WindowAction, act_on_window, find_windows, list_windows};
use super::picture_stream::{FrameSink, PictureStream};
use super::screen_elements::{describe_elements, find_elements, read_screen_elements};
use super::screen_size::{DEFAULT_SCREEN, OCR_SCALE, ScreenSize, clamp_screen, size_text};
use super::screen_text::{find_text, read_lines, read_screen_words, upscale_for_ocr};
use super::secure_window::clear_password_fields;
use super::sign_in_form::{
    FillOutcome, SignInCredentials, fill_sign_in_form, find_sign_in, frame_origin,
};
use super::supported::{COMPUTER_BINARIES, unsupported_reason};
use super::video_stream::VideoStream;
use crate::lib::data_dir::resolve_data_dir;
use crate::lib::has_binary::{has_binaries, missing_binary};
use crate::lib::log_redaction::err_json;
use crate::services::meeting::audio_stack::{AudioStack, AudioStackHandles, AudioStackOptions};
use crate::services::meeting::browser_control::{
    BrowserAction, BrowserCommand, BrowserReading, BrowserResult, capture, normalize_url, read,
    run_browser_command, summarize_tabs,
};
use crate::services::meeting::browser_stack::{
    BROWSER_WINDOW_HEIGHT, BROWSER_WINDOW_WIDTH, BrowserStack, BrowserStackOptions, GotoOptions,
    LoadState, PageHandle, WindowPosition,
};
use crate::support::js;
use crate::support::js::round as js_round;
use crate::support::now_ms;
use crate::{log_debug, log_error, log_info, log_warn};

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

/// What the browser's first tab shows, written into it rather than loaded from an address,
/// so the address bar shows `about:blank` and no URL of its own. The page has content, so
/// the screen stream has a picture from the first second; an empty document never repaints
/// and so never produces a frame.
const START_PAGE: &str = r##"<!doctype html><title>Start page</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px;
    background:
      radial-gradient(ellipse at 50% 38%, rgba(92,108,195,.22), transparent 55%),
      radial-gradient(circle, rgba(255,255,255,.06) 1px, transparent 1.5px) 0 0 / 28px 28px,
      #10131f;
    color: #e4e4e7; font-family: system-ui, sans-serif;
  }
  svg { width: 96px; filter: drop-shadow(0 8px 28px rgba(224,50,86,.35)); }
  p { margin: 0; max-width: 420px; text-align: center; font-size: 18px; line-height: 1.5; color: #a1a1aa; }
</style>
<svg viewBox="0 0 19 17"><defs><linearGradient id="g" x1="18" y1="2" x2="1.5" y2="17.5" gradientUnits="userSpaceOnUse">
<stop stop-color="#E04150"/><stop offset=".23" stop-color="#FFA545"/><stop offset=".46" stop-color="#E98F46"/>
<stop offset=".66" stop-color="#E03256"/><stop offset=".82" stop-color="#B62C7F"/><stop offset="1" stop-color="#5C6CC3"/>
</linearGradient></defs><path fill="url(#g)" d="M16.6807 12.8477L14.3613 17.001H10.1729L12.4863 12.8477L10.1729 8.70117H14.3613L16.6807 12.8477ZM19 17.001H15.2549L17.124 13.6484L19 17.001ZM3.74512 17H0L1.86914 13.6484L3.74512 17ZM6.73438 13.248H11.373L9.27246 17H4.63965L2.31934 12.8477L4.41504 9.10156L6.73438 13.248ZM13.9111 7.89941H9.27832L6.95898 12.0459L4.86426 8.2998L7.17773 4.14746H11.8164L13.9111 7.89941ZM11.373 3.3457H7.62695L9.49707 0L11.373 3.3457Z"/></svg>
<p>This is my desktop. You can watch me work here, and take over at any time.</p>"##;

/// Show the start page in `page`. A blank document first, so the address bar shows none
/// of the site the tab showed before. False when the page did not load it.
async fn show_start_page(page: &PageHandle) -> bool {
    let shown = async {
        page.goto(
            "about:blank",
            GotoOptions {
                wait_until: LoadState::Load,
                timeout_ms: Some(10_000),
            },
        )
        .await?;
        page.set_content(START_PAGE, 10_000).await
    };
    match shown.await {
        Ok(()) => true,
        Err(err) => {
            log_warn!(
                json!({ "err": err_json(&err) }),
                "[VoiceChat] Start page did not load"
            );
            false
        }
    }
}

/// Make `page` the agent's first tab, showing the start page. The agent's first navigation
/// lands in it, and every tab a person can use is one the tab bookkeeping covers, so a
/// secure takeover clears its password fields too.
async fn open_start_tab(browser: &BrowserStack, page: PageHandle) {
    show_start_page(&page).await;
    browser.adopt_tab(page);
}

/// Where the browser window's top-left corner goes to centre it on a desktop of `size`.
fn centred_window(size: ScreenSize) -> WindowPosition {
    let offset = |screen: i64, window: u32| ((screen - i64::from(window)) / 2).max(0) as u32;
    WindowPosition {
        x: offset(size.width, BROWSER_WINDOW_WIDTH),
        y: offset(size.height, BROWSER_WINDOW_HEIGHT),
    }
}

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

/// What every desktop tool answers on a computer with no desktop.
const NO_DESKTOP: &str = "There is no desktop on this computer.";

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
    width: f64,
    height: f64,
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

/// The first line of an error's message, as the desktop tools report a failure.
fn detail(err: &anyhow::Error) -> String {
    err.to_string()
        .split('\n')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// `Math.round(n)` as a template literal writes it.
fn rounded(n: f64) -> String {
    js::number_text(js_round(n))
}

/// A value from the page as a template literal writes it.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Array(_)) | Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(other) => other.to_string(),
    }
}

/// `Number(value) || 0`, for a size the page sent.
fn js_number_or_zero(value: Option<&Value>) -> f64 {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => js::number_from(text).unwrap_or(f64::NAN),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if n.is_nan() { 0.0 } else { n }
}

/// `Buffer.from(text, 'base64')`: characters outside the alphabet are skipped, and either
/// alphabet is read.
fn decode_base64(text: &str) -> Bytes {
    let mut clean: String = text
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    Bytes::from(
        base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(clean)
            .unwrap_or_default(),
    )
}

fn data_url(jpeg: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    )
}

/// A tab number the model gave, as an index into the tab list, when it names one.
fn tab_index(number: f64) -> Option<usize> {
    (number.is_finite() && number >= 0.0 && number.fract() == 0.0).then_some(number as usize)
}

/// `{ success, message, ...reading }`.
fn screen_look(success: bool, message: String, reading: Option<BrowserReading>) -> ScreenLook {
    let mut look = ScreenLook {
        success,
        message,
        ..ScreenLook::default()
    };
    if let Some(reading) = reading {
        look.url = Some(reading.url);
        look.title = Some(reading.title);
        look.text = Some(reading.text);
        look.controls = Some(reading.controls);
    }
    look
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

    fn browser(&self) -> Option<Arc<BrowserStack>> {
        self.state.lock().browser.clone()
    }

    fn control(&self) -> Option<Arc<DesktopControl>> {
        self.state.lock().desktop_control.clone()
    }

    fn desktop_env(&self) -> IndexMap<String, String> {
        self.state.lock().desktop_env.clone()
    }

    /// Bring up the display, the desktop and the browser, at `screen` when given. Fails with
    /// `Could not open the browser: <reason>`, having stopped whatever had started.
    pub async fn open_browser(self: &Arc<Self>, screen: Option<ScreenSize>) -> anyhow::Result<()> {
        if let Some(screen) = screen {
            self.state.lock().size = clamp_screen(screen.width as f64, screen.height as f64);
        }
        let mut display: Option<Arc<AudioStack>> = None;
        let mut desktop: Option<Arc<DesktopSession>> = None;
        let opened = self.bring_up(&mut display, &mut desktop).await;
        let Err(err) = opened else {
            return Ok(());
        };
        let input = {
            let mut state = self.state.lock();
            state.desktop_control = None;
            state.input.take()
        };
        if let Some(input) = input {
            input.stop();
        }
        if let Some(desktop) = desktop {
            desktop.stop().await;
        }
        if let Some(display) = display {
            display.stop().await;
        }
        anyhow::bail!("Could not open the browser: {err}")
    }

    async fn bring_up(
        self: &Arc<Self>,
        display_slot: &mut Option<Arc<AudioStack>>,
        desktop_slot: &mut Option<Arc<DesktopSession>>,
    ) -> anyhow::Result<()> {
        if let Some(missing) = missing_binary(&COMPUTER_BINARIES).await {
            anyhow::bail!(unsupported_reason(&missing));
        }

        let display = Arc::new(AudioStack::new());
        *display_slot = Some(display.clone());
        let size = self.state.lock().size;
        let handles = display
            .start(AudioStackOptions {
                screen: Some(size_text(size)),
            })
            .await?;
        let env = handles.browser_env.clone();
        // A meeting ends on this; here the desktop's sound just stops reaching the page.
        (handles.on_lost)(Arc::new(|reason: String| {
            log_warn!("[VoiceChat] Desktop audio capture lost: {}", reason);
        }));
        // The desktop before the browser, so the window manager is there to place the
        // browser's window when it opens, and the session bus exists for it to join.
        let desktop = DesktopSession::new(env.clone());
        *desktop_slot = Some(desktop.clone());
        desktop.start().await?;
        desktop.start_dock().await?;
        let mut desktop_env = env.clone();
        desktop_env.extend(desktop.bus_env());
        let control = Arc::new(DesktopControl::new(env.clone(), size));
        {
            let mut state = self.state.lock();
            state.desktop_env = desktop_env;
            state.desktop_control = Some(control.clone());
            state.input = Some(DesktopInput::new(env.clone(), control));
        }

        // On the queue, so a reopen for a browser that leaves during the launch runs after
        // the computer holds it.
        self.on_front_queue(async {
            let browser = self.launch_browser().await?;
            self.state.lock().browser = Some(browser);
            anyhow::Ok(())
        })
        .await?;
        let mut state = self.state.lock();
        state.display = Some(display);
        state.desktop = Some(desktop);
        state.audio_handles = Some(Arc::new(handles));
        Ok(())
    }

    /// Start the browser on the desktop, centred, with the start page in its one tab.
    async fn launch_browser(self: &Arc<Self>) -> anyhow::Result<Arc<BrowserStack>> {
        let (size, env) = {
            let state = self.state.lock();
            (state.size, state.desktop_env.clone())
        };
        let browser = Arc::new(BrowserStack::new());
        let started = browser
            .start(BrowserStackOptions {
                // On the desktop's bus with accessibility on, so the browser's frame is in
                // the tree.
                env,
                profile_dir: Some(
                    Path::new(&resolve_data_dir()).join("voice-chat-browser-profile"),
                ),
                // Centred, so the wallpaper frames it.
                window_position: Some(centred_window(size)),
            })
            .await;
        let first_page = match started {
            Ok(page) => page,
            Err(err) => {
                browser.stop().await;
                return Err(err);
            }
        };
        let computer = Arc::downgrade(self);
        let gone = Arc::downgrade(&browser);
        browser.on_exit(Arc::new(move || {
            let (Some(computer), Some(gone)) = (computer.upgrade(), gone.upgrade()) else {
                return;
            };
            tokio::spawn(computer.reopen_browser(gone));
        }));
        open_start_tab(&browser, first_page).await;
        Ok(browser)
    }

    /// Replace `gone`, a browser that left on its own, with a new one on the same desktop.
    /// Chromium quits with its last window, and a person in control can close that window.
    ///
    /// Boxed, because it and `launch_browser` start each other.
    fn reopen_browser(self: Arc<Self>, gone: Arc<BrowserStack>) -> BoxFuture<'static, ()> {
        Box::pin(async move { self.replace_browser(&gone, self.launch_browser()).await })
    }

    /// Put the browser `launch` starts in place of `gone`, on the front queue.
    async fn replace_browser(
        &self,
        gone: &Arc<BrowserStack>,
        launch: impl Future<Output = anyhow::Result<Arc<BrowserStack>>>,
    ) {
        self.on_front_queue(async {
            if !self.holds(gone) {
                return;
            }
            log_warn!("[VoiceChat] The browser closed; opening a new one");
            gone.stop().await;
            if !self.holds(gone) {
                return;
            }
            match launch.await {
                Ok(fresh) => {
                    // `stop()` released the computer while this browser started.
                    if !self.swap_browser(gone, Some(fresh.clone())) {
                        fresh.stop().await;
                    }
                }
                Err(err) => {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "[VoiceChat] Could not open a new browser"
                    );
                    self.swap_browser(gone, None);
                }
            }
        })
        .await
    }

    /// Put `next` in place of `gone` while the computer holds `gone`. False when it holds
    /// another browser or none.
    fn swap_browser(&self, gone: &Arc<BrowserStack>, next: Option<Arc<BrowserStack>>) -> bool {
        let mut state = self.state.lock();
        let held = state
            .browser
            .as_ref()
            .is_some_and(|browser| Arc::ptr_eq(browser, gone));
        if held {
            state.browser = next;
        }
        held
    }

    /// Whether `browser` is the computer's browser.
    fn holds(&self, browser: &Arc<BrowserStack>) -> bool {
        self.state
            .lock()
            .browser
            .as_ref()
            .is_some_and(|held| Arc::ptr_eq(held, browser))
    }

    /// Send what the desktop plays, 48 kHz pcm16 mono, silence left out.
    ///
    /// False when there is no display to record from, which is a computer that never
    /// opened.
    pub fn start_browser_audio(&self, on_pcm: Arc<dyn Fn(Bytes) + Send + Sync>) -> bool {
        let Some(handles) = self.state.lock().audio_handles.clone() else {
            return false;
        };
        (handles.on_capture)(Arc::new(move |pcm: Bytes| {
            if !is_silent(&pcm) {
                on_pcm(pcm);
            }
        }));
        true
    }

    /// Whether the computer tools have a desktop to act on.
    pub fn has_desktop(&self) -> bool {
        self.state.lock().desktop_control.is_some()
    }

    async fn target_of(&self, page: &PageHandle) -> anyhow::Result<Option<String>> {
        if page.is_closed() {
            return Ok(None);
        }
        let session = page.context().new_cdp_session(page).await?;
        let info = session.send("Target.getTargetInfo", json!({})).await;
        session.detach().await?;
        let info = info?;
        Ok(info["targetInfo"]["targetId"].as_str().map(str::to_string))
    }

    fn tab_page(&self, tab: Option<i64>) -> Option<PageHandle> {
        let browser = self.browser()?;
        let page = match tab.filter(|tab| *tab != 0) {
            Some(tab) if tab >= 1 => browser.list_tabs().get((tab - 1) as usize).cloned(),
            Some(_) => None,
            None => browser.front(),
        };
        page.filter(|page| !page.is_closed())
    }

    async fn page_for_target(
        &self,
        target_id: &str,
    ) -> anyhow::Result<Option<(PageHandle, usize)>> {
        let pages = self.browser().map(|b| b.list_tabs()).unwrap_or_default();
        for (index, page) in pages.iter().enumerate() {
            if self.tab_target(Some(index as i64 + 1)).await?.as_deref() == Some(target_id) {
                return Ok(Some((page.clone(), index)));
            }
        }
        Ok(None)
    }

    /// The words on a shared-screen picture, or `None` where this host cannot read them.
    async fn read_user_screen_text(&self, jpeg: Bytes) -> Option<String> {
        let available = *self
            .ocr_available
            .get_or_init(|| has_binaries(&["ffmpeg", "tesseract"]))
            .await;
        if !available {
            return None;
        }
        let read = async {
            let png = upscale_for_ocr(jpeg, OCR_SCALE).await?;
            let lines = read_lines(&read_screen_words(png, OCR_SCALE).await?);
            anyhow::Ok(lines.join("\n"))
        };
        match read.await {
            Ok(text) => {
                if js::len16(&text) > USER_SCREEN_TEXT_MAX_CHARS {
                    Some(format!(
                        "{}\n…",
                        js::slice16(&text, 0, USER_SCREEN_TEXT_MAX_CHARS)
                    ))
                } else if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            }
            Err(err) => {
                log_info!(
                    "[VoiceChat] Could not read the user's screen as text: Error: {}",
                    err
                );
                None
            }
        }
    }

    /// Find `query` on the screen: a control of that name in the accessibility tree first,
    /// which is exact and quick, else words read off the screen. Queued with the other
    /// screen work.
    async fn locate_text(
        &self,
        control: Arc<DesktopControl>,
        query: &str,
    ) -> anyhow::Result<Vec<TextLocation>> {
        let env = self.desktop_env();
        self.on_front_queue(async {
            let elements = match read_screen_elements(&env).await {
                Ok(elements) => elements,
                Err(err) => {
                    log_debug!(
                        "[VoiceChat:Desktop] accessibility tree unavailable: Error: {}",
                        err
                    );
                    Vec::new()
                }
            };
            let widgets = find_elements(&elements, query);
            if !widgets.is_empty() {
                return Ok(widgets
                    .into_iter()
                    .map(|e| {
                        let (x, y) = control.to_picture(e.x + e.width / 2.0, e.y + e.height / 2.0);
                        TextLocation {
                            text: e.name,
                            line: format!("{} in {}", e.role, e.app),
                            x: js_round(x) as i64,
                            y: js_round(y) as i64,
                        }
                    })
                    .collect());
            }
            let png = control.capture_for_ocr().await?;
            let words = read_screen_words(png, OCR_SCALE).await?;
            Ok(find_text(&words, query)
                .into_iter()
                .map(|m| {
                    let (x, y) = control.to_picture(m.x, m.y);
                    TextLocation {
                        text: m.text,
                        line: m.line,
                        x: js_round(x) as i64,
                        y: js_round(y) as i64,
                    }
                })
                .collect())
        })
        .await
    }

    /// Run one desktop action, wait for the screen to settle, and show the model the
    /// result. Queued with the browser commands, since both move what is on the screen.
    async fn desktop_action<F, Fut>(&self, act: F, message: String) -> DesktopActionResult
    where
        F: FnOnce(Arc<DesktopControl>) -> Fut + Send,
        Fut: Future<Output = anyhow::Result<()>> + Send,
    {
        let Some(control) = self.control() else {
            return DesktopActionResult::new(false, NO_DESKTOP);
        };
        self.on_front_queue(async {
            let done = async {
                act(control.clone()).await?;
                tokio::time::sleep(Duration::from_millis(ACTION_SETTLE_MS)).await;
                self.show_desktop(&control, DESKTOP_AFTER_NOTE).await
            };
            match done.await {
                Ok(shown) => DesktopActionResult::new(
                    true,
                    if shown {
                        format!("{message}. The picture shows the screen now.")
                    } else {
                        format!("{message}. I could not get a picture afterwards.")
                    },
                ),
                Err(err) => {
                    let detail = detail(&err);
                    log_info!("[VoiceChat:Desktop] {} failed: {}", message, detail);
                    DesktopActionResult::new(false, format!("That did not work: {detail}"))
                }
            }
        })
        .await
    }

    /// One picture of the desktop into the session. Answers whether the model got it.
    async fn show_desktop(&self, control: &DesktopControl, note: &str) -> anyhow::Result<bool> {
        let jpeg = control.capture().await?;
        Ok(self
            .channel()
            .is_some_and(|channel| channel.show_image(&data_url(&jpeg), note)))
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
        match command.action {
            BrowserAction::NewTab => {
                if let Some(url) = &command.url
                    && !url.is_empty()
                    && normalize_url(url).is_none()
                {
                    return Ok(BrowserResult::message(
                        false,
                        format!("\"{url}\" is not a web address I can open."),
                    ));
                }
                let page = browser.open_tab().await?;
                if let Some(url) = command.url.filter(|url| !url.is_empty()) {
                    let navigate = BrowserCommand {
                        action: BrowserAction::Navigate,
                        url: Some(url),
                        tab: None,
                        target: None,
                        text: None,
                        key: None,
                        amount: None,
                    };
                    return Ok(run_browser_command(&page, &navigate).await);
                }
                Ok(BrowserResult::with_reading(
                    true,
                    "Opened a new tab.",
                    read(&page).await,
                ))
            }

            BrowserAction::SwitchTab => {
                let index = command.tab.and_then(|tab| tab_index(tab - 1.0));
                let page = match index {
                    Some(index) => browser.select_tab(index).await?,
                    None => None,
                };
                let Some(page) = page else {
                    let tab = command
                        .tab
                        .map_or_else(|| "of that number".to_string(), js::number_text);
                    return Ok(BrowserResult::message(
                        false,
                        format!("There is no tab {tab}."),
                    ));
                };
                let tab = command
                    .tab
                    .map_or_else(|| "undefined".to_string(), js::number_text);
                Ok(BrowserResult::with_reading(
                    true,
                    format!("Switched to tab {tab}."),
                    read(&page).await,
                ))
            }

            BrowserAction::CloseTab => {
                let tabs = browser.list_tabs();
                let index = match command.tab {
                    None => {
                        let front = browser.front();
                        tabs.iter()
                            .position(|page| Some(page) == front.as_ref())
                            .map(|index| index as f64)
                            .unwrap_or(-1.0)
                    }
                    Some(tab) => tab - 1.0,
                };
                // The window keeps its last tab, which goes back to the start page.
                if let [last] = tabs.as_slice()
                    && index == 0.0
                {
                    if !show_start_page(last).await {
                        return Ok(BrowserResult::message(
                            false,
                            "I could not close the page in the last tab.",
                        ));
                    }
                    return Ok(BrowserResult::with_reading(
                        true,
                        "Closed the page. The one tab left shows the start page.",
                        read(last).await,
                    ));
                }
                let closed = match tab_index(index) {
                    Some(index) => browser.close_tab(index).await?,
                    None => false,
                };
                let Some(page) = browser.front().filter(|_| closed) else {
                    return Ok(BrowserResult::message(
                        false,
                        "There is no such tab to close.",
                    ));
                };
                Ok(BrowserResult::with_reading(
                    true,
                    "Closed the tab.",
                    read(&page).await,
                ))
            }

            _ => Ok(run_browser_command(&browser.workbench().await?, &command).await),
        }
    }
}

impl Default for AgentComputer {
    fn default() -> Self {
        AgentComputer::new()
    }
}

#[async_trait]
impl ComputerBrowser for AgentComputer {
    async fn browse(&self, command: BrowserCommand) -> anyhow::Result<BrowserResult> {
        // The browser is read in the queue, so a command queued behind a reopen uses the
        // new one.
        Ok(self
            .on_front_queue(async {
                let Some(browser) = self.browser() else {
                    return BrowserResult::message(false, "There is no browser on this computer.");
                };
                browser.observe_front().await;
                match self.run_browse_command(&browser, command).await {
                    Ok(mut result) => {
                        let tabs = browser.list_tabs();
                        let front = browser.front();
                        result.tabs = Some(summarize_tabs(&tabs, front.as_ref()).await);
                        result
                    }
                    Err(err) => {
                        log_error!(
                            json!({ "err": err_json(&err) }),
                            "[VoiceChat] Browser command failed"
                        );
                        BrowserResult::message(false, "I could not reach the browser.")
                    }
                }
            })
            .await)
    }

    /// Show the model the screen: the whole desktop where the runtime owns the display,
    /// else the browser tab in front. The tab's reading goes along in both cases, since
    /// the words on the page are worth more to a voice model than pixels.
    async fn look_at_screen(&self) -> anyhow::Result<ScreenLook> {
        let browser = self.browser();
        if let Some(browser) = &browser {
            browser.observe_front().await;
        }
        let page = browser.as_ref().and_then(|browser| browser.front());

        if let Some(control) = self.control() {
            return Ok(match self.show_desktop(&control, SCREEN_LOOK_NOTE).await {
                Ok(shown) => {
                    let reading = match &page {
                        Some(page) => Some(read(page).await),
                        None => None,
                    };
                    let message = if shown {
                        format!(
                            "This is my whole screen, as a {} by {} picture; the desktop tools take coordinates from it.",
                            control.picture_width(),
                            control.picture_height()
                        )
                    } else {
                        "Here is what the browser tab says. I could not get the picture through."
                            .to_string()
                    };
                    screen_look(true, message, reading)
                }
                Err(err) => {
                    log_error!(
                        json!({ "err": err_json(&err) }),
                        "[VoiceChat] Desktop capture failed"
                    );
                    screen_look(
                        false,
                        "I could not get a picture of the screen.".to_string(),
                        None,
                    )
                }
            });
        }

        let Some(page) = page else {
            return Ok(screen_look(
                false,
                "There is no browser window open.".to_string(),
                None,
            ));
        };
        Ok(match capture(&page).await {
            Ok(captured) => {
                let shown = self.channel().is_some_and(|channel| {
                    channel.show_image(&captured.image_url, SCREEN_LOOK_NOTE)
                });
                let message = if shown {
                    "This is what my browser is showing."
                } else {
                    "Here is what the page says. I could not get the picture through."
                };
                screen_look(true, message.to_string(), Some(captured.reading))
            }
            Err(err) => {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[VoiceChat] Screen capture failed"
                );
                screen_look(
                    false,
                    "I could not get a picture of the browser.".to_string(),
                    None,
                )
            }
        })
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
    async fn list_elements(&self, input: ListElementsInput) -> anyhow::Result<DesktopActionResult> {
        if self.control().is_none() {
            return Ok(DesktopActionResult::new(false, NO_DESKTOP));
        }
        let env = self.desktop_env();
        let elements = self.on_front_queue(read_screen_elements(&env)).await;
        Ok(match elements {
            Ok(elements) => DesktopActionResult::new(
                true,
                describe_elements(&elements, input.filter.as_deref()),
            ),
            Err(err) => {
                let detail = detail(&err);
                log_info!("[VoiceChat:Desktop] list elements failed: {}", detail);
                DesktopActionResult::new(
                    false,
                    format!("I could not read the desktop's controls: {detail}"),
                )
            }
        })
    }

    async fn list_windows(&self) -> anyhow::Result<DesktopActionResult> {
        if self.control().is_none() {
            return Ok(DesktopActionResult::new(false, NO_DESKTOP));
        }
        Ok(match list_windows(&self.desktop_env()).await {
            Ok(windows) if windows.is_empty() => {
                DesktopActionResult::new(true, "No windows are open.")
            }
            Ok(windows) => {
                let lines: Vec<String> = windows
                    .iter()
                    .map(|w| {
                        format!(
                            "\"{}\" at ({}, {}), {} by {}",
                            w.title, w.x, w.y, w.width, w.height
                        )
                    })
                    .collect();
                DesktopActionResult::new(
                    true,
                    format!("{} window(s):\n{}", windows.len(), lines.join("\n")),
                )
            }
            Err(err) => {
                let detail = detail(&err);
                log_info!("[VoiceChat:Desktop] list windows failed: {}", detail);
                DesktopActionResult::new(false, format!("I could not list the windows: {detail}"))
            }
        })
    }

    async fn window_action(&self, input: WindowActionInput) -> anyhow::Result<DesktopActionResult> {
        if self.control().is_none() {
            return Ok(DesktopActionResult::new(false, NO_DESKTOP));
        }
        let env = self.desktop_env();
        let windows = match list_windows(&env).await {
            Ok(windows) => windows,
            Err(err) => {
                return Ok(DesktopActionResult::new(
                    false,
                    format!("I could not list the windows: {}", detail(&err)),
                ));
            }
        };
        let Some(window) = find_windows(&windows, &input.title)
            .into_iter()
            .next()
            .cloned()
        else {
            return Ok(DesktopActionResult::new(
                false,
                format!("There is no window with \"{}\" in its title.", input.title),
            ));
        };
        let message = format!("{} \"{}\"", window_action_done(input.action), window.title);
        let action = input.action;
        Ok(self
            .desktop_action(
                |_| async move { act_on_window(&env, &window, action).await },
                message,
            )
            .await)
    }

    /// Where a control or some words are on the screen right now, in picture coordinates.
    async fn find_text(&self, input: FindTextInput) -> anyhow::Result<FindTextResult> {
        let Some(control) = self.control() else {
            return Ok(FindTextResult {
                success: false,
                message: NO_DESKTOP.to_string(),
                matches: None,
            });
        };
        Ok(match self.locate_text(control, &input.text).await {
            Ok(matches) if matches.is_empty() => FindTextResult {
                success: false,
                message: format!(
                    "I cannot see the text \"{}\" on the screen right now.",
                    input.text
                ),
                matches: None,
            },
            Ok(matches) => FindTextResult {
                success: true,
                message: format!(
                    "\"{}\" appears {} on the screen.",
                    input.text,
                    if matches.len() == 1 {
                        "once".to_string()
                    } else {
                        format!("{} times", matches.len())
                    }
                ),
                matches: Some(matches),
            },
            Err(err) => {
                let detail = detail(&err);
                log_info!("[VoiceChat:Desktop] find text failed: {}", detail);
                FindTextResult {
                    success: false,
                    message: format!("I could not read the screen: {detail}"),
                    matches: None,
                }
            }
        })
    }

    /// Click the centre of some words on the screen.
    async fn click_text(&self, input: ClickTextInput) -> anyhow::Result<DesktopActionResult> {
        let Some(control) = self.control() else {
            return Ok(DesktopActionResult::new(false, NO_DESKTOP));
        };
        let matches = match self.locate_text(control, &input.text).await {
            Ok(matches) => matches,
            Err(err) => {
                let detail = detail(&err);
                log_info!("[VoiceChat:Desktop] click text failed: {}", detail);
                return Ok(DesktopActionResult::new(
                    false,
                    format!("I could not read the screen: {detail}"),
                ));
            }
        };
        if matches.is_empty() {
            return Ok(DesktopActionResult::new(
                false,
                format!(
                    "I cannot see the text \"{}\" on the screen right now.",
                    input.text
                ),
            ));
        }
        let count = matches.len() as i64;
        let index = (count.min(input.occurrence.unwrap_or(1).max(1)) - 1) as usize;
        let target = matches[index].clone();
        let button = input.button.unwrap_or(MouseButton::Left);
        let double = input.double.unwrap_or(false);
        let others = if count > 1 {
            format!(
                " ({count} matches; clicked number {}, in \"{}\")",
                index + 1,
                target.line
            )
        } else {
            String::new()
        };
        let message = format!(
            "{} \"{}\" at ({}, {}){others}",
            if double { "Double-clicked" } else { "Clicked" },
            target.text,
            target.x,
            target.y
        );
        let at = Point {
            x: target.x as f64,
            y: target.y as f64,
        };
        Ok(self
            .desktop_action(
                move |control| async move {
                    control
                        .click(Some(at), button, if double { 2 } else { 1 })
                        .await
                },
                message,
            )
            .await)
    }

    async fn move_pointer(&self, input: MoveInput) -> anyhow::Result<DesktopActionResult> {
        let message = format!(
            "Moved the pointer to ({}, {})",
            rounded(input.x),
            rounded(input.y)
        );
        Ok(self
            .desktop_action(
                move |control| async move { control.move_to(input.x, input.y).await },
                message,
            )
            .await)
    }

    async fn click(&self, input: ClickInput) -> anyhow::Result<DesktopActionResult> {
        let button = input.button.unwrap_or(MouseButton::Left);
        let at = match (input.x, input.y) {
            (Some(x), Some(y)) => Some(Point { x, y }),
            _ => None,
        };
        let double = input.double.unwrap_or(false);
        let verb = if double { "Double-clicked" } else { "Clicked" };
        let message = match at {
            Some(at) => format!(
                "{verb} {} at ({}, {})",
                button.as_str(),
                rounded(at.x),
                rounded(at.y)
            ),
            None => format!("{verb} {} where the pointer was", button.as_str()),
        };
        Ok(self
            .desktop_action(
                move |control| async move {
                    control.click(at, button, if double { 2 } else { 1 }).await
                },
                message,
            )
            .await)
    }

    async fn drag(&self, input: DragInput) -> anyhow::Result<DesktopActionResult> {
        let button = input.button.unwrap_or(MouseButton::Left);
        let message = format!(
            "Dragged {} from ({}, {}) to ({}, {})",
            button.as_str(),
            rounded(input.from_x),
            rounded(input.from_y),
            rounded(input.to_x),
            rounded(input.to_y)
        );
        Ok(self
            .desktop_action(
                move |control| async move {
                    control
                        .drag(
                            Point {
                                x: input.from_x,
                                y: input.from_y,
                            },
                            Point {
                                x: input.to_x,
                                y: input.to_y,
                            },
                            button,
                        )
                        .await
                },
                message,
            )
            .await)
    }

    async fn type_text(&self, input: TypeInput) -> anyhow::Result<DesktopActionResult> {
        let length = js::len16(&input.text);
        let message = format!(
            "Typed {length} character{}",
            if length == 1 { "" } else { "s" }
        );
        Ok(self
            .desktop_action(
                move |control| async move { control.type_text(&input.text).await },
                message,
            )
            .await)
    }

    async fn key(&self, input: KeyInput) -> anyhow::Result<DesktopActionResult> {
        let message = format!("Pressed {}", input.keys);
        Ok(self
            .desktop_action(
                move |control| async move { control.key(&input.keys).await },
                message,
            )
            .await)
    }

    async fn scroll(&self, input: ScrollInput) -> anyhow::Result<DesktopActionResult> {
        let message = format!(
            "Scrolled {} at ({}, {})",
            input.direction.as_str(),
            rounded(input.x),
            rounded(input.y)
        );
        let clicks = input.clicks.unwrap_or(3);
        Ok(self
            .desktop_action(
                move |control| async move {
                    control
                        .scroll(input.x, input.y, input.direction, clicks)
                        .await
                },
                message,
            )
            .await)
    }
}

#[async_trait]
impl ComputerUserScreen for AgentComputer {
    /// Show the model the user's shared screen, as last received: the picture into the
    /// session, and the words on it as text, since a model reading a picture gets the gist
    /// of a dialog but garbles an error code or a hostname, which is what people share.
    async fn look_at_user_screen(&self) -> anyhow::Result<UserScreenResult> {
        let Some(shared) = self.state.lock().user_screen.clone() else {
            return Ok(UserScreenResult {
                success: false,
                message: "Your user is not sharing their screen right now. Ask them to press the share button.".to_string(),
                text: None,
            });
        };
        let shown = self
            .channel()
            .is_some_and(|channel| channel.show_image(&data_url(&shared.jpeg), USER_SCREEN_NOTE));
        let age_seconds = js_round((now_ms() - shared.at) as f64 / 1000.0) as i64;
        let text = self.read_user_screen_text(shared.jpeg.clone()).await;
        let message = if shown {
            format!(
                "This is your user's shared screen, {} by {}, {}.{}",
                js::number_text(shared.width),
                js::number_text(shared.height),
                if age_seconds <= 1 {
                    "as of now".to_string()
                } else {
                    format!("as of {age_seconds} seconds ago")
                },
                if text.is_some() {
                    " The words on it are attached, read off the picture, top to bottom."
                } else {
                    ""
                }
            )
        } else {
            "I could not get the picture of your user's screen through.".to_string()
        };
        Ok(UserScreenResult {
            success: shown,
            message,
            text,
        })
    }
}

#[async_trait]
impl Computer for AgentComputer {
    async fn with_model_channel(&self, channel: Arc<dyn ModelChannel>, action: BoxFuture<'_, ()>) {
        self.channels.run(channel, action).await
    }

    /// Start sending the screen to the page as video; `open_browser()` has to have run.
    fn start_screen_stream(&self, on_frame: FrameSink) {
        let (display, size) = {
            let state = self.state.lock();
            let display = state
                .audio_handles
                .as_ref()
                .and_then(|handles| handles.browser_env.get("DISPLAY").cloned());
            (display, state.size)
        };
        let Some(display) = display.filter(|display| !display.is_empty()) else {
            return;
        };
        self.stop_screen_stream();
        let screen: Arc<dyn PictureStream> = VideoStream::new(display, size_text(size), on_frame);
        self.state.lock().screen = Some(screen.clone());
        screen.start();
    }

    /// Stop sending the screen. The computer runs on; a later client starts it again.
    fn stop_screen_stream(&self) {
        let screen = self.state.lock().screen.take();
        if let Some(screen) = screen {
            tokio::spawn(async move { screen.stop().await });
        }
    }

    /// A text frame from the page: the user's shared screen (`user_screen_started`,
    /// `user_screen` with base64 `data`, `width` and `height`, `user_screen_stopped`), or
    /// their pointer and keyboard while they hold the desktop.
    fn handle_input(&self, text: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let Some(kind) = frame
            .as_object()
            .and_then(|object| object.get("type"))
            .and_then(Value::as_str)
        else {
            return;
        };
        match kind {
            "user_screen_started" => {
                log_info!("[VoiceChat] User started sharing their screen");
                if let Some(channel) = self.channel() {
                    channel.notify(
                        "Your user has just started sharing their screen with you. Call computer_user_screen whenever you want to look at it, and do look when they refer to something on it.",
                    );
                }
            }
            "user_screen" => {
                let Some(data) = frame.get("data").and_then(Value::as_str) else {
                    return;
                };
                if js::len16(data) > USER_SCREEN_MAX_CHARS {
                    return;
                }
                let first = self.state.lock().user_screen.is_none();
                if first {
                    log_info!(
                        "[VoiceChat] First picture of the user's shared screen, {} by {}",
                        js_text(frame.get("width")),
                        js_text(frame.get("height"))
                    );
                }
                self.state.lock().user_screen = Some(SharedScreen {
                    jpeg: decode_base64(data),
                    width: js_number_or_zero(frame.get("width")),
                    height: js_number_or_zero(frame.get("height")),
                    at: now_ms(),
                });
            }
            "user_screen_stopped" => {
                log_info!("[VoiceChat] User stopped sharing their screen");
                self.state.lock().user_screen = None;
                if let Some(channel) = self.channel() {
                    channel.notify("Your user has stopped sharing their screen.");
                }
            }
            _ => {
                let input = self.state.lock().input.clone();
                if let Some(input) = input {
                    input.handle(&frame);
                }
            }
        }
    }

    fn release_input(&self) {
        let mut state = self.state.lock();
        if let Some(input) = state.input.take() {
            input.stop();
        }
        state.input = state
            .desktop_control
            .clone()
            .map(|control| DesktopInput::new(state.desktop_env.clone(), control));
    }

    /// End a secure takeover: empty every password field the browser holds, and drop
    /// the retained picture of the user's own shared screen. Sharing goes on, so the
    /// next frame replaces what this drops.
    async fn clear_after_secure_window(&self) -> anyhow::Result<()> {
        self.state.lock().user_screen = None;
        // The tabs are read in the queue, so a browser reopened ahead of this is the one
        // cleared.
        self.on_front_queue(async {
            let pages = self.browser().map(|b| b.list_tabs()).unwrap_or_default();
            clear_password_fields(&pages).await;
        })
        .await;
        Ok(())
    }

    async fn tab_target(&self, tab: Option<i64>) -> anyhow::Result<Option<String>> {
        match self.tab_page(tab) {
            Some(page) => self.target_of(&page).await,
            None => Ok(None),
        }
    }

    /// Fails with `The tab needing help has closed. You have control of the current
    /// desktop.` when no tab has that target.
    async fn focus_target(&self, target_id: &str) -> anyhow::Result<()> {
        let Some((_, index)) = self.page_for_target(target_id).await? else {
            anyhow::bail!(
                "The tab needing help has closed. You have control of the current desktop."
            );
        };
        if let Some(browser) = self.browser() {
            browser.select_tab(index).await?;
        }
        Ok(())
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
        let mut pages: Vec<PageHandle> = Vec::new();
        let named = self.tab_page(tab);
        let open = self.browser().map(|b| b.list_tabs()).unwrap_or_default();
        for page in named.into_iter().chain(open) {
            if !pages.contains(&page) {
                pages.push(page);
            }
        }
        for page in pages {
            if page.is_closed() {
                continue;
            }
            let Some(found) = self.on_front_queue(find_sign_in(&page, None)).await else {
                continue;
            };
            return Ok(Some(SignInFormInfo {
                origin: found.site,
                fields: if found.password && !found.username {
                    CredentialFields::Password
                } else {
                    CredentialFields::Both
                },
                target_id: self.target_of(&page).await?,
            }));
        }
        Ok(None)
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
        let Some((page, index)) = self.page_for_target(target_id).await? else {
            return Ok(SignInOutcome::TabGone);
        };
        if !page
            .frames()
            .iter()
            .any(|frame| frame_origin(frame).as_deref() == Some(site))
        {
            return Ok(SignInOutcome::SiteChanged);
        }
        self.on_front_queue(async {
            if let Some(browser) = self.browser() {
                browser.select_tab(index).await?;
            }
            Ok(match fill_sign_in_form(&page, credentials, site).await? {
                FillOutcome::Filled => SignInOutcome::Filled,
                FillOutcome::NoForm => SignInOutcome::NoForm,
                FillOutcome::NoPasswordStep => SignInOutcome::NoPasswordStep,
            })
        })
        .await
    }

    /// Release everything. Safe to call more than once.
    async fn stop(&self) -> anyhow::Result<()> {
        let input = self.state.lock().input.take();
        if let Some(input) = input {
            input.stop();
        }
        let screen = self.state.lock().screen.take();
        if let Some(screen) = screen {
            screen.stop().await;
        }
        let (browser, desktop, display) = {
            let mut state = self.state.lock();
            state.desktop_control = None;
            state.audio_handles = None;
            (
                state.browser.take(),
                state.desktop.take(),
                state.display.take(),
            )
        };
        if let Some(browser) = browser {
            browser.stop().await;
        }
        if let Some(desktop) = desktop {
            desktop.stop().await;
        }
        if let Some(display) = display {
            display.stop().await;
        }
        Ok(())
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::meeting::browser_stack::testing::{FakeBrowser, Live};

    fn command(action: BrowserAction, tab: Option<f64>) -> BrowserCommand {
        BrowserCommand {
            action,
            url: None,
            tab,
            target: None,
            text: None,
            key: None,
            amount: None,
        }
    }

    /// A computer whose browser is `stack`; the desktop parts stay unset.
    fn computer_with(stack: &Arc<BrowserStack>) -> Arc<AgentComputer> {
        let computer = Arc::new(AgentComputer::new());
        computer.state.lock().browser = Some(stack.clone());
        computer
    }

    /// A launch held back until `release` sends its result.
    fn held_launch() -> (
        tokio::sync::oneshot::Sender<anyhow::Result<Arc<BrowserStack>>>,
        impl Future<Output = anyhow::Result<Arc<BrowserStack>>> + Send + 'static,
    ) {
        let (release, launched) = tokio::sync::oneshot::channel();
        (release, async move { launched.await.unwrap() })
    }

    /// Wait until `fake`'s connection has closed, which `replace_browser` does first.
    async fn closed(fake: &FakeBrowser) {
        while fake.is_connected() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn shows_the_start_page_under_about_blank() {
        let Some(live) = Live::start().await else {
            return;
        };
        live.show("<title>Inbox</title><p>Mail</p>").await;

        assert!(show_start_page(&live.page).await);

        assert_eq!(live.page.title().await.unwrap(), "Start page");
        assert_eq!(live.page.url(), "about:blank");
        live.stop().await;
    }

    #[test]
    fn centres_the_browser_window_on_the_desktop() {
        let size = ScreenSize {
            width: 1920,
            height: 1080,
        };
        assert_eq!(centred_window(size), WindowPosition { x: 320, y: 180 });
        let small = ScreenSize {
            width: 1024,
            height: 600,
        };
        assert_eq!(centred_window(small), WindowPosition { x: 0, y: 0 });
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn keeps_the_last_tab_and_shows_the_start_page_in_it() {
        let Some(live) = Live::start().await else {
            return;
        };
        live.show("<title>Inbox</title><p>Mail</p>").await;
        let stack = live.stack();
        stack.adopt_tab(live.page.clone());
        let computer = computer_with(&stack);

        let result = computer
            .browse(command(BrowserAction::CloseTab, None))
            .await
            .unwrap();

        assert!(result.success);
        assert_eq!(
            result.message,
            "Closed the page. The one tab left shows the start page."
        );
        assert!(!live.page.is_closed());
        assert_eq!(live.page.title().await.unwrap(), "Start page");
        assert_eq!(live.page.url(), "about:blank");
        live.stop().await;
    }

    #[tokio::test]
    async fn reports_a_failure_when_the_last_tab_does_not_load_the_start_page() {
        let fake = FakeBrowser::new();
        let stack = fake.stack();
        stack.adopt_tab(fake.scripted_page("https://notes.example.com/inbox"));
        fake.fail("Page.navigate");
        let computer = computer_with(&stack);

        let result = computer
            .browse(command(BrowserAction::CloseTab, None))
            .await
            .unwrap();

        assert!(!result.success);
        assert_eq!(
            result.message,
            "I could not close the page in the last tab."
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn makes_the_start_tab_the_agents_first_tab_and_the_one_in_front() {
        let Some(live) = Live::start().await else {
            return;
        };
        let stack = live.stack();

        open_start_tab(&stack, live.page.clone()).await;

        assert_eq!(stack.list_tabs(), vec![live.page.clone()]);
        assert_eq!(stack.front(), Some(live.page.clone()));
        assert_eq!(live.page.title().await.unwrap(), "Start page");
        live.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closes_a_tab_normally_while_another_is_open() {
        let Some(live) = Live::start().await else {
            return;
        };
        live.show("<title>Notes</title>").await;
        let second = live.browser.contexts()[0].new_page().await.unwrap();
        let stack = live.stack();
        stack.adopt_tab(live.page.clone());
        stack.adopt_tab(second.clone());
        let computer = computer_with(&stack);

        let result = computer
            .browse(command(BrowserAction::CloseTab, Some(2.0)))
            .await
            .unwrap();

        assert!(result.success);
        assert_eq!(result.message, "Closed the tab.");
        assert!(second.is_closed());
        assert_eq!(live.page.title().await.unwrap(), "Notes");
        live.stop().await;
    }

    #[tokio::test]
    async fn replaces_a_browser_that_closed_and_clears_the_new_tabs_at_a_hand_back() {
        let old = FakeBrowser::new();
        let gone = old.stack();
        let new = FakeBrowser::new();
        let fresh = new.stack();
        let tab = new.scripted_page("https://notes.example.com/sign-in");
        fresh.adopt_tab(tab.clone());
        let computer = computer_with(&gone);
        let (release, launch) = held_launch();

        let replacing = {
            let computer = computer.clone();
            tokio::spawn(async move { computer.replace_browser(&gone, launch).await })
        };
        closed(&old).await;
        let hand_back = {
            let computer = computer.clone();
            tokio::spawn(async move { computer.clear_after_secure_window().await })
        };
        release.send(Ok(fresh.clone())).ok();
        replacing.await.unwrap();
        hand_back.await.unwrap().unwrap();

        assert!(computer.holds(&fresh));
        assert!(new.sent_to(&tab).contains(&"Runtime.evaluate".to_string()));
    }

    #[tokio::test]
    async fn answers_a_command_sent_during_a_failed_reopen_with_no_browser() {
        let old = FakeBrowser::new();
        let gone = old.stack();
        let computer = computer_with(&gone);
        let (release, launch) = held_launch();

        let replacing = {
            let computer = computer.clone();
            tokio::spawn(async move { computer.replace_browser(&gone, launch).await })
        };
        closed(&old).await;
        let browsing = {
            let computer = computer.clone();
            tokio::spawn(async move {
                computer
                    .browse(command(BrowserAction::SwitchTab, Some(5.0)))
                    .await
            })
        };
        release
            .send(Err(anyhow::anyhow!(
                "Browser exited before it was ready (code 21)"
            )))
            .ok();
        replacing.await.unwrap();

        assert_eq!(
            browsing.await.unwrap().unwrap(),
            BrowserResult::message(false, "There is no browser on this computer.")
        );
    }

    #[tokio::test]
    async fn stops_the_browser_that_finishes_starting_after_the_computer_stopped() {
        let old = FakeBrowser::new();
        let gone = old.stack();
        let new = FakeBrowser::new();
        let fresh = new.stack();
        let computer = computer_with(&gone);
        let (release, launch) = held_launch();

        let replacing = {
            let computer = computer.clone();
            tokio::spawn(async move { computer.replace_browser(&gone, launch).await })
        };
        closed(&old).await;
        computer.stop().await.unwrap();
        release.send(Ok(fresh)).ok();
        replacing.await.unwrap();

        assert!(!new.is_connected());
        assert!(computer.browser().is_none());
    }

    #[test]
    fn reads_a_shared_picture_as_the_page_encoded_it() {
        assert_eq!(decode_base64("aGVsbG8=").as_ref(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").as_ref(), b"hello");
        assert_eq!(decode_base64("aGVs\nbG8=").as_ref(), b"hello");
    }

    #[test]
    fn hears_silence_as_nothing() {
        assert!(is_silent(&[0, 0, 0, 0]));
        assert!(!is_silent(&[0, 1, 0, 0]));
    }

    #[test]
    fn names_a_tab_only_by_a_whole_number() {
        assert_eq!(tab_index(0.0), Some(0));
        assert_eq!(tab_index(2.0), Some(2));
        assert_eq!(tab_index(-1.0), None);
        assert_eq!(tab_index(1.5), None);
    }

    #[test]
    fn writes_a_size_the_page_sent_as_a_template_literal_does() {
        assert_eq!(js_text(Some(&json!(1280))), "1280");
        assert_eq!(js_text(Some(&json!("720"))), "720");
        assert_eq!(js_text(None), "undefined");
        assert_eq!(js_number_or_zero(Some(&json!("720"))), 720.0);
        assert_eq!(js_number_or_zero(Some(&json!("wide"))), 0.0);
        assert_eq!(js_number_or_zero(None), 0.0);
    }

    #[tokio::test]
    async fn answers_every_desktop_tool_without_a_desktop() {
        let computer = AgentComputer::new();
        assert_eq!(computer.width(), 0);
        assert!(!computer.has_desktop());
        let windows = computer.list_windows().await.unwrap();
        assert_eq!(windows, DesktopActionResult::new(false, NO_DESKTOP));
        let moved = computer
            .move_pointer(MoveInput { x: 1.0, y: 2.0 })
            .await
            .unwrap();
        assert_eq!(moved, DesktopActionResult::new(false, NO_DESKTOP));
        let browsed = computer
            .browse(BrowserCommand {
                action: BrowserAction::Read,
                url: None,
                tab: None,
                target: None,
                text: None,
                key: None,
                amount: None,
            })
            .await
            .unwrap();
        assert_eq!(
            browsed,
            BrowserResult::message(false, "There is no browser on this computer.")
        );
        let look = computer.look_at_screen().await.unwrap();
        assert_eq!(
            serde_json::to_value(look).unwrap(),
            json!({ "success": false, "message": "There is no browser window open." })
        );
    }

    #[tokio::test]
    async fn tells_the_model_when_the_user_is_not_sharing() {
        let computer = AgentComputer::new();
        let answer = computer.look_at_user_screen().await.unwrap();
        assert_eq!(
            serde_json::to_value(answer).unwrap(),
            json!({
                "success": false,
                "message": "Your user is not sharing their screen right now. Ask them to press the share button."
            })
        );
    }
}
