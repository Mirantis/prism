//! A computer outside the runtime, used over its link.
//!
//! The client on that computer captures, types and reads its windows and controls; this
//! side does everything the runtime's own desktop also does around those: the model's
//! picture size and the coordinates in it, waiting for the screen to settle, OCR where the
//! computer offers no controls, and a viewer's pointer and keys. Coordinates on the link
//! are pixels of the display's full capture.

use std::any::Any;
use std::future::Future;
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use futures::future::BoxFuture;
use indexmap::IndexSet;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::computer_link::{ComputerLink, LinkError, LinkEvent, LinkFailure};
use super::link_protocol::{
    CapabilitiesChangedParams, Capability, CapabilityProblem, CaptureResult, DisplaysChangedParams,
    ElementsResult, EmptyResult, InitializeParams, LINK_JPEG_FRAME, LINK_KEYFRAME_FLAG,
    LINK_VIDEO_FRAME, LinkErrorReason, LinkSchema, RemoteDisplay, RemotePlatform, RemoteWindow,
    StreamStartResult, WindowsResult,
};
use crate::lib::has_binary::has_binaries;
use crate::services::computer::agent_computer::{
    ACTION_SETTLE_MS, ModelChannel, ModelChannelScope, window_action_done,
};
use crate::services::computer::computer::{Computer, SignInFormInfo};
use crate::services::computer::computer_session::SignInOutcome;
use crate::services::computer::computer_tools::{
    ClickInput, ClickTextInput, ComputerBrowser, ComputerDesktop, ComputerUserScreen,
    DesktopActionResult, DragInput, FindTextInput, FindTextResult, KeyInput, ListElementsInput,
    MoveInput, ScreenLook, ScrollInput, TextLocation, TypeInput, UserScreenResult,
    WindowActionInput,
};
use crate::services::computer::desktop_control::{MouseButton, ScrollDirection};
use crate::services::computer::desktop_input::{
    InputFrame, MAX_WHEEL_CLICKS, MOVE_FLUSH_MS, MetaAs, WHEEL_PIXELS_PER_CLICK, chord_for,
    input_frame, paste_text,
};
use crate::services::computer::desktop_windows::find_windows;
use crate::services::computer::picture_stream::{FrameSink, ScreenFrame, StreamEncoding};
use crate::services::computer::screen_elements::{ScreenElement, describe_elements, find_elements};
use crate::services::computer::screen_size::{MAX_SCREEN, ScreenSize, bounded_picture_for};
use crate::services::computer::screen_text::{find_text, read_screen_words, upscale_for_ocr};
use crate::services::computer::sign_in_form::SignInCredentials;
use crate::services::meeting::browser_control::{BrowserCommand, BrowserResult};
use crate::services::meeting::realtime_session::decode_base64_lenient;
use crate::support::js;
use crate::support::js::round as js_round;
use crate::{log_info, log_warn};

/// How long an input request may take on the computer, and a read of its screen or controls.
const INPUT_TIMEOUT_MS: u64 = 10_000;
const READ_TIMEOUT_MS: u64 = 30_000;
/// Extra time a typed text gets per character, up to a cap.
const TYPE_MS_PER_CHAR: u64 = 50;
const TYPE_TIMEOUT_CAP_MS: u64 = 120_000;
/// How many pointer positions a drag walks through between press and release.
const DRAG_STEPS: i64 = 10;
/// The picture quality the model's screenshots are asked for.
const CAPTURE_QUALITY: i64 = 80;

/// What the model is told the computer cannot do, by capability.
fn capability_words(capability: Capability) -> &'static str {
    match capability {
        Capability::Screen => "show its screen",
        Capability::Input => "take mouse and keyboard input",
        Capability::Windows => "list its windows",
        Capability::Elements => "read its controls",
        Capability::Stream => "stream its screen",
    }
}

/// What the runtime knows about the computer on the other end of a link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteComputerInfo {
    pub platform: RemotePlatform,
    pub client_version: String,
    pub display: ScreenSize,
    pub capabilities: Vec<Capability>,
    pub problems: Vec<CapabilityProblem>,
}

/// The primary display, else the first. A link's `displays` is never empty.
fn primary(displays: &[RemoteDisplay]) -> RemoteDisplay {
    displays
        .iter()
        .find(|display| display.primary)
        .unwrap_or(&displays[0])
        .clone()
}

/// The first line of an error's message.
fn detail(err: &dyn std::fmt::Display) -> String {
    err.to_string()
        .split('\n')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// A pointer position in display pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisplayPoint {
    pub x: i64,
    pub y: i64,
}

impl DisplayPoint {
    fn json(self) -> Value {
        json!({ "x": self.x, "y": self.y })
    }
}

/// A position held to the display: rounded, and inside it.
fn clamp_to(display: &RemoteDisplay, x: f64, y: f64) -> DisplayPoint {
    DisplayPoint {
        x: ((display.width - 1) as f64).min(0f64.max(js_round(x))) as i64,
        y: ((display.height - 1) as f64).min(0f64.max(js_round(y))) as i64,
    }
}

/// `Math.round(n)` as an integer, for the numbers a message shows.
fn rounded(n: f64) -> i64 {
    js_round(n) as i64
}

/// The screen stream the viewers watch.
struct RemoteStream {
    /// Tells this stream from one that replaced it.
    id: u64,
    on_frame: FrameSink,
    /// Set when the answer to `stream.start` is read. A frame before it belongs to the
    /// stream this one replaced, which a decoder set up for this one cannot read.
    started: bool,
    size: ScreenSize,
}

struct RemoteState {
    display: RemoteDisplay,
    capabilities: IndexSet<Capability>,
    problems: Vec<CapabilityProblem>,
    /// Where the agent's pointer and a viewer's pointer are, in display pixels.
    pointer: DisplayPoint,
    /// The buttons a viewer holds down, so handing back can let go of them.
    held: IndexSet<MouseButton>,
    move_timer: Option<JoinHandle<()>>,
    stream: Option<RemoteStream>,
    /// The number the next stream gets.
    next_stream: u64,
    /// The size of the last picture the model saw of this display.
    seen: Option<ScreenSize>,
    /// The viewers' frame sink, kept while they watch, whether or not a stream runs.
    watcher: Option<FrameSink>,
}

pub struct RemoteComputer {
    me: Weak<RemoteComputer>,
    channels: ModelChannelScope,
    /// Actions run one at a time, in arrival order.
    tail: tokio::sync::Mutex<()>,
    /// Read on every use, so a rename applies to a computer already connected.
    name_of: Arc<dyn Fn() -> String + Send + Sync>,
    link: Arc<ComputerLink>,
    hello: InitializeParams,
    /// Called when what the computer reports about itself changes, for the list to show.
    on_change: Arc<dyn Fn() + Send + Sync>,
    ocr_available: tokio::sync::OnceCell<bool>,
    state: Mutex<RemoteState>,
}

impl RemoteComputer {
    /// `name_of` is read on every use, so a rename applies to a computer already connected.
    /// The computer listens to the link's notifications and binary frames from here on.
    pub fn new(
        name_of: Arc<dyn Fn() -> String + Send + Sync>,
        link: Arc<ComputerLink>,
        hello: InitializeParams,
        on_change: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Arc<Self> {
        let display = primary(&hello.displays);
        let pointer = DisplayPoint {
            x: display.width / 2,
            y: display.height / 2,
        };
        let computer = Arc::new_cyclic(|me| RemoteComputer {
            me: me.clone(),
            channels: ModelChannelScope::new(),
            tail: tokio::sync::Mutex::new(()),
            name_of,
            link: Arc::clone(&link),
            on_change: on_change.unwrap_or_else(|| Arc::new(|| {})),
            ocr_available: tokio::sync::OnceCell::new(),
            state: Mutex::new(RemoteState {
                display,
                capabilities: hello.capabilities.iter().copied().collect(),
                problems: hello.problems.clone(),
                pointer,
                held: IndexSet::new(),
                move_timer: None,
                stream: None,
                next_stream: 1,
                seen: None,
                watcher: None,
            }),
            hello,
        });
        let me = Arc::downgrade(&computer);
        link.on(Arc::new(move |event| {
            let Some(computer) = me.upgrade() else {
                return;
            };
            match event {
                LinkEvent::Notification { method, params } => {
                    computer.notified(method, params.as_ref())
                }
                LinkEvent::Binary(data) => computer.frame(data),
                _ => {}
            }
        }));
        computer
    }

    pub fn info(&self) -> RemoteComputerInfo {
        let state = self.state.lock();
        RemoteComputerInfo {
            platform: self.hello.platform,
            client_version: self.hello.client.version.clone(),
            display: ScreenSize {
                width: state.display.width,
                height: state.display.height,
            },
            capabilities: state.capabilities.iter().copied().collect(),
            problems: state.problems.clone(),
        }
    }

    pub fn name(&self) -> String {
        (self.name_of)()
    }

    fn channel(&self) -> Option<Arc<dyn ModelChannel>> {
        self.channels.current()
    }

    /// The largest picture the model is shown, which a capture is asked for.
    fn picture(&self) -> ScreenSize {
        bounded_picture_for(self.display_size())
    }

    /// The picture the model's coordinates refer to: the last one it saw, else the one
    /// asked for.
    fn seen_picture(&self) -> ScreenSize {
        let seen = self.state.lock().seen;
        seen.unwrap_or_else(|| self.picture())
    }

    fn display_id(&self) -> String {
        self.state.lock().display.id.clone()
    }

    /// A notification from the client: `displays.changed` or `capabilities.changed`.
    fn notified(&self, method: &str, params: Option<&Value>) {
        if method == "displays.changed" {
            let Ok(parsed) = DisplaysChangedParams::parse_input(params) else {
                return;
            };
            let restart = {
                let mut state = self.state.lock();
                let before = state.display.clone();
                state.display = primary(&parsed.displays);
                state.pointer = clamp_to(
                    &state.display,
                    state.pointer.x as f64,
                    state.pointer.y as f64,
                );
                let moved = before.id != state.display.id
                    || before.width != state.display.width
                    || before.height != state.display.height;
                if !moved {
                    return;
                }
                // The model's last picture and the viewers' stream are of the display that went.
                state.seen = None;
                state
                    .stream
                    .as_ref()
                    .map(|stream| Arc::clone(&stream.on_frame))
            };
            if let Some(on_frame) = restart {
                self.start_screen_stream(on_frame);
            }
            (self.on_change)();
            return;
        }
        if method == "capabilities.changed" {
            let Ok(parsed) = CapabilitiesChangedParams::parse_input(params) else {
                return;
            };
            let restart = {
                let mut state = self.state.lock();
                let could_stream = state.capabilities.contains(&Capability::Stream);
                state.capabilities = parsed.capabilities.into_iter().collect();
                state.problems = parsed.problems;
                let can_stream = state.capabilities.contains(&Capability::Stream);
                // The watcher stays, so the stream starts again when the permission comes back.
                if could_stream && !can_stream {
                    state.stream = None;
                }
                if !could_stream && can_stream {
                    state.watcher.clone()
                } else {
                    None
                }
            };
            if let Some(watcher) = restart {
                self.start_screen_stream(watcher);
            }
            (self.on_change)();
        }
    }

    /// A binary frame of the screen stream, passed on as the viewer socket sends it.
    fn frame(&self, data: &Bytes) {
        let on_frame = match &self.state.lock().stream {
            Some(stream) if stream.started => Arc::clone(&stream.on_frame),
            _ => return,
        };
        if data.len() < 2 {
            return;
        }
        let body = data.slice(2..);
        if data[0] == LINK_VIDEO_FRAME {
            on_frame(ScreenFrame::H264 {
                data: body,
                keyframe: (data[1] & LINK_KEYFRAME_FLAG) != 0,
            });
        } else if data[0] == LINK_JPEG_FRAME {
            on_frame(ScreenFrame::Jpeg {
                data: base64::engine::general_purpose::STANDARD.encode(&body),
            });
        }
    }

    fn can(&self, capability: Capability) -> bool {
        self.state.lock().capabilities.contains(&capability)
    }

    fn missing(&self, capability: Capability) -> String {
        let problem = self
            .state
            .lock()
            .problems
            .iter()
            .find(|item| item.capability == capability.as_str())
            .map(|item| item.message.clone());
        format!(
            "{} cannot {}{}",
            self.name(),
            capability_words(capability),
            match problem {
                Some(message) => format!(": {message}"),
                None => ".".to_string(),
            }
        )
    }

    fn cannot_read(&self) -> String {
        if self.can(Capability::Elements) {
            format!("I could not read the screen of {}.", self.name())
        } else {
            self.missing(Capability::Elements)
        }
    }

    /// What the model is told when the computer or the link refused.
    fn failure(&self, what: &str, err: &anyhow::Error) -> String {
        let message = format!("{what}: {}", detail(err));
        let Some(link) = err.downcast_ref::<LinkError>() else {
            return message;
        };
        match link.reason {
            LinkFailure::Refused(LinkErrorReason::PermissionDenied) => {
                let permission = link
                    .data
                    .get("permission")
                    .and_then(Value::as_str)
                    .unwrap_or("the permission it needs");
                format!(
                    "{message} Ask your user to grant {permission} to the computer client on {}.",
                    self.name()
                )
            }
            LinkFailure::Refused(LinkErrorReason::Held) => format!(
                "{message} The person at {} has control; wait until they hand it back.",
                self.name()
            ),
            _ => message,
        }
    }

    fn look_note(&self) -> String {
        format!(
            "This is a picture of the screen of {}, a computer your user connected, as it looks right now, in answer to your computer_screen call. Your user did not say this.",
            self.name()
        )
    }

    fn after_note(&self) -> String {
        format!(
            "This is a picture of the screen of {} right after the desktop action you just took. Your user did not say this.",
            self.name()
        )
    }

    /// One input request; `timeout_ms` is `INPUT_TIMEOUT_MS` unless a caller says otherwise.
    async fn call(&self, method: &str, params: Value, timeout_ms: u64) -> Result<(), LinkError> {
        self.link
            .request::<EmptyResult>(method, Some(params), timeout_ms, None)
            .await
            .map(|_| ())
    }

    /// Run one action, wait for the screen to settle, and show the model the result.
    async fn act<F, Fut>(
        &self,
        capability: Capability,
        action: F,
        message: String,
    ) -> DesktopActionResult
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = anyhow::Result<()>> + Send,
    {
        if !self.can(capability) {
            return DesktopActionResult::new(false, self.missing(capability));
        }
        self.on_queue(async {
            if let Err(err) = action().await {
                log_info!(
                    "[Computer:Remote] {}: {} failed: {}",
                    self.name(),
                    message,
                    detail(&err)
                );
                return DesktopActionResult::new(false, self.failure("That did not work", &err));
            }
            if !self.can(Capability::Screen) {
                return DesktopActionResult::new(true, format!("{message}."));
            }
            tokio::time::sleep(Duration::from_millis(ACTION_SETTLE_MS)).await;
            let shown = self.show_screen(&self.after_note()).await.unwrap_or(false);
            DesktopActionResult::new(
                true,
                if shown {
                    format!("{message}. The picture shows the screen now.")
                } else {
                    format!("{message}. I could not get a picture afterwards.")
                },
            )
        })
        .await
    }

    /// One picture of the screen into the session. Its own size is what the model's next
    /// coordinates refer to. One larger than asked for is refused: a provider may shrink it
    /// before the model sees it, to a scale the runtime cannot know.
    async fn show_screen(&self, note: &str) -> anyhow::Result<bool> {
        let asked = self.picture();
        let shot = self
            .link
            .request::<CaptureResult>(
                "screen.capture",
                Some(json!({
                    "display": self.display_id(),
                    "format": "jpeg",
                    "maxWidth": asked.width,
                    "maxHeight": asked.height,
                    "quality": CAPTURE_QUALITY,
                })),
                READ_TIMEOUT_MS,
                None,
            )
            .await?;
        // A client that keeps the display's shape may round the height by a pixel or two.
        if shot.width > asked.width || shot.height > asked.height + 2 {
            return Err(LinkError::new(
                format!(
                    "The computer sent a {} by {} picture, larger than the {} by {} it was asked for.",
                    shot.width, shot.height, asked.width, asked.height
                ),
                LinkFailure::Refused(LinkErrorReason::Internal),
            )
            .into());
        }
        self.state.lock().seen = Some(ScreenSize {
            width: shot.width,
            height: shot.height,
        });
        let url = format!("data:{};base64,{}", shot.media_type.as_str(), shot.data);
        Ok(self
            .channel()
            .map(|channel| channel.show_image(&url, note))
            .unwrap_or(false))
    }

    /// The computer's controls, in the model's picture coordinates. `filter` lets the client
    /// stop early; the callers match names again, so a client may ignore it.
    async fn read_elements(&self, filter: Option<&str>) -> anyhow::Result<Vec<ScreenElement>> {
        let params = match filter {
            Some(filter) if !filter.is_empty() => json!({ "filter": filter }),
            _ => json!({}),
        };
        let read = self
            .link
            .request::<ElementsResult>("elements.list", Some(params), READ_TIMEOUT_MS, None)
            .await?;
        Ok(read
            .elements
            .into_iter()
            .map(|e| {
                let (x, y) = self.to_picture(e.x, e.y);
                let (right, bottom) = self.to_picture(e.x + e.width, e.y + e.height);
                ScreenElement {
                    app: e.app,
                    role: e.role,
                    name: e.name,
                    x: js_round(x),
                    y: js_round(y),
                    width: js_round(right - x),
                    height: js_round(bottom - y),
                }
            })
            .collect())
    }

    /// The open windows, in the model's picture coordinates.
    async fn read_windows(&self) -> anyhow::Result<Vec<RemoteWindow>> {
        let read = self
            .link
            .request::<WindowsResult>("windows.list", Some(json!({})), READ_TIMEOUT_MS, None)
            .await?;
        Ok(read
            .windows
            .into_iter()
            .map(|w| {
                let (x, y) = self.to_picture(w.x, w.y);
                let (right, bottom) = self.to_picture(w.x + w.width, w.y + w.height);
                RemoteWindow {
                    x: js_round(x),
                    y: js_round(y),
                    width: js_round(right - x),
                    height: js_round(bottom - y),
                    ..w
                }
            })
            .collect())
    }

    /// Find `query` on the screen in picture coordinates: a control of that name first,
    /// else words read off a full-size capture. `None` when the computer offers neither.
    async fn locate_text(&self, query: &str) -> anyhow::Result<Option<Vec<TextLocation>>> {
        let ocr = self.can(Capability::Screen) && self.can_read_text().await;
        if !self.can(Capability::Elements) && !ocr {
            return Ok(None);
        }
        self.on_queue(async {
            if self.can(Capability::Elements) {
                let widgets = find_elements(&self.read_elements(Some(query)).await?, query);
                if !widgets.is_empty() || !ocr {
                    return Ok(Some(
                        widgets
                            .into_iter()
                            .map(|e| TextLocation {
                                line: if e.app.is_empty() {
                                    e.role.clone()
                                } else {
                                    format!("{} in {}", e.role, e.app)
                                },
                                x: rounded(e.x + e.width / 2.0),
                                y: rounded(e.y + e.height / 2.0),
                                text: e.name,
                            })
                            .collect(),
                    ));
                }
            }
            let shot = self
                .link
                .request::<CaptureResult>(
                    "screen.capture",
                    Some(json!({ "display": self.display_id(), "format": "png" })),
                    READ_TIMEOUT_MS,
                    None,
                )
                .await?;
            // A high-density screen already draws text large enough to read; a plain one is enlarged.
            let scale = if self.state.lock().display.scale >= 2.0 {
                1
            } else {
                2
            };
            let raw = Bytes::from(decode_base64_lenient(&shot.data));
            let png = if scale > 1 {
                upscale_for_ocr(raw, scale).await?
            } else {
                raw
            };
            let words = read_screen_words(png, scale).await?;
            let ratio = self.seen_picture().width as f64 / shot.width as f64;
            Ok(Some(
                find_text(&words, query)
                    .into_iter()
                    .map(|m| TextLocation {
                        text: m.text,
                        line: m.line,
                        x: rounded(m.x * ratio),
                        y: rounded(m.y * ratio),
                    })
                    .collect(),
            ))
        })
        .await
    }

    async fn can_read_text(&self) -> bool {
        *self
            .ocr_available
            .get_or_init(|| has_binaries(&["ffmpeg", "tesseract"]))
            .await
    }

    fn display_size(&self) -> ScreenSize {
        let state = self.state.lock();
        ScreenSize {
            width: state.display.width,
            height: state.display.height,
        }
    }

    fn clamp(&self, x: f64, y: f64) -> DisplayPoint {
        clamp_to(&self.state.lock().display, x, y)
    }

    fn to_display(&self, x: f64, y: f64) -> DisplayPoint {
        let picture = self.seen_picture();
        let size = self.display_size();
        self.clamp(
            (x * size.width as f64) / picture.width as f64,
            (y * size.height as f64) / picture.height as f64,
        )
    }

    fn to_picture(&self, x: f64, y: f64) -> (f64, f64) {
        let picture = self.seen_picture();
        let size = self.display_size();
        (
            (x * picture.width as f64) / size.width as f64,
            (y * picture.height as f64) / size.height as f64,
        )
    }

    fn stream_scale(&self) -> (f64, f64) {
        let state = self.state.lock();
        let size = match &state.stream {
            Some(stream) => stream.size,
            None => ScreenSize {
                width: state.display.width,
                height: state.display.height,
            },
        };
        (
            state.display.width as f64 / size.width as f64,
            state.display.height as f64 / size.height as f64,
        )
    }

    #[allow(clippy::wrong_self_convention)] // TypeScript's `fromStream`.
    fn from_stream(&self, x: f64, y: f64) -> DisplayPoint {
        let (sx, sy) = self.stream_scale();
        self.clamp(x * sx, y * sy)
    }

    fn schedule_move(&self) {
        let mut state = self.state.lock();
        if state.move_timer.is_some() {
            return;
        }
        let me = self.me.clone();
        state.move_timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(MOVE_FLUSH_MS)).await;
            if let Some(computer) = me.upgrade() {
                computer.move_now();
            }
        }));
    }

    fn flush_move(&self) {
        if self.state.lock().move_timer.is_some() {
            self.move_now();
        }
    }

    fn move_now(&self) {
        let (timer, pointer) = {
            let mut state = self.state.lock();
            (state.move_timer.take(), state.pointer)
        };
        if let Some(timer) = timer {
            timer.abort();
        }
        self.link.notify("input.pointer", Some(pointer.json()));
    }

    async fn on_queue<F: Future>(&self, run: F) -> F::Output {
        let _turn = self.tail.lock().await;
        run.await
    }

    /// `click` with the message a caller words from the verb (`Clicked`, `Double-clicked`),
    /// as `click_text` words it.
    async fn click_described(
        &self,
        input: ClickInput,
        describe: Option<Box<dyn FnOnce(&str) -> String + Send>>,
    ) -> DesktopActionResult {
        let button = input.button.unwrap_or(MouseButton::Left);
        let named = match (input.x, input.y) {
            (Some(x), Some(y)) => Some((x, y)),
            _ => None,
        };
        let at = match named {
            Some((x, y)) => self.to_display(x, y),
            None => self.state.lock().pointer,
        };
        let double = input.double == Some(true);
        let verb = if double { "Double-clicked" } else { "Clicked" };
        let message = match (describe, named) {
            (Some(describe), _) => describe(verb),
            (None, Some((x, y))) => format!(
                "{verb} {} at ({}, {})",
                button.as_str(),
                rounded(x),
                rounded(y)
            ),
            (None, None) => format!("{verb} {} where the pointer was", button.as_str()),
        };
        self.act(
            Capability::Input,
            || async move {
                self.state.lock().pointer = at;
                self.call(
                    "input.click",
                    json!({
                        "x": at.x,
                        "y": at.y,
                        "button": button.as_str(),
                        "count": if double { 2 } else { 1 },
                    }),
                    INPUT_TIMEOUT_MS,
                )
                .await?;
                Ok(())
            },
            message,
        )
        .await
    }
}

#[async_trait]
impl ComputerBrowser for RemoteComputer {
    /// Answers that the computer offers no browser control, naming the desktop tools.
    async fn browse(&self, _command: BrowserCommand) -> anyhow::Result<BrowserResult> {
        Ok(BrowserResult::message(
            false,
            format!(
                "{} offers no browser control. Use its browser through the desktop tools: computer_screen, computer_click_text, computer_type and computer_key.",
                self.name()
            ),
        ))
    }

    async fn look_at_screen(&self) -> anyhow::Result<ScreenLook> {
        if !self.can(Capability::Screen) {
            return Ok(ScreenLook {
                success: false,
                message: self.missing(Capability::Screen),
                ..Default::default()
            });
        }
        let note = self.look_note();
        match self.on_queue(self.show_screen(&note)).await {
            Ok(shown) => Ok(ScreenLook {
                success: shown,
                message: if shown {
                    format!(
                        "This is the whole screen of {}, as a {} by {} picture; the desktop tools take coordinates from it.",
                        self.name(),
                        ComputerDesktop::width(self),
                        ComputerDesktop::height(self)
                    )
                } else {
                    format!("I could not get the picture of {} through.", self.name())
                },
                ..Default::default()
            }),
            Err(err) => {
                log_info!(
                    "[Computer:Remote] {}: screen capture failed: {}",
                    self.name(),
                    detail(&err)
                );
                Ok(ScreenLook {
                    success: false,
                    message: self.failure("I could not get a picture of the screen", &err),
                    ..Default::default()
                })
            }
        }
    }
}

#[async_trait]
impl ComputerDesktop for RemoteComputer {
    fn width(&self) -> i64 {
        self.seen_picture().width
    }

    fn height(&self) -> i64 {
        self.seen_picture().height
    }

    async fn list_elements(&self, input: ListElementsInput) -> anyhow::Result<DesktopActionResult> {
        if !self.can(Capability::Elements) {
            return Ok(DesktopActionResult::new(
                false,
                self.missing(Capability::Elements),
            ));
        }
        let filter = input.filter.as_deref();
        Ok(match self.on_queue(self.read_elements(filter)).await {
            Ok(elements) => DesktopActionResult::new(true, describe_elements(&elements, filter)),
            Err(err) => DesktopActionResult::new(
                false,
                self.failure("I could not read the computer's controls", &err),
            ),
        })
    }

    async fn list_windows(&self) -> anyhow::Result<DesktopActionResult> {
        if !self.can(Capability::Windows) {
            return Ok(DesktopActionResult::new(
                false,
                self.missing(Capability::Windows),
            ));
        }
        let windows = match self.read_windows().await {
            Ok(windows) => windows,
            Err(err) => {
                return Ok(DesktopActionResult::new(
                    false,
                    self.failure("I could not list the windows", &err),
                ));
            }
        };
        if windows.is_empty() {
            return Ok(DesktopActionResult::new(true, "No windows are open."));
        }
        let lines: Vec<String> = windows
            .iter()
            .map(|w| {
                format!(
                    "\"{}\"{} at ({}, {}), {} by {}",
                    w.title,
                    if w.app.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", w.app)
                    },
                    js::number_text(w.x),
                    js::number_text(w.y),
                    js::number_text(w.width),
                    js::number_text(w.height)
                )
            })
            .collect();
        Ok(DesktopActionResult::new(
            true,
            format!("{} window(s):\n{}", windows.len(), lines.join("\n")),
        ))
    }

    async fn window_action(&self, input: WindowActionInput) -> anyhow::Result<DesktopActionResult> {
        if !self.can(Capability::Windows) {
            return Ok(DesktopActionResult::new(
                false,
                self.missing(Capability::Windows),
            ));
        }
        let windows = match self.read_windows().await {
            Ok(windows) => windows,
            Err(err) => {
                return Ok(DesktopActionResult::new(
                    false,
                    self.failure("I could not list the windows", &err),
                ));
            }
        };
        let Some(window) = find_windows(&windows, &input.title)
            .first()
            .copied()
            .cloned()
        else {
            return Ok(DesktopActionResult::new(
                false,
                format!("There is no window with \"{}\" in its title.", input.title),
            ));
        };
        let action = input.action;
        let id = window.id.clone();
        Ok(self
            .act(
                Capability::Windows,
                || async move {
                    self.call(
                        "windows.act",
                        json!({ "id": id, "action": action.as_str() }),
                        INPUT_TIMEOUT_MS,
                    )
                    .await?;
                    Ok(())
                },
                format!("{} \"{}\"", window_action_done(action), window.title),
            )
            .await)
    }

    async fn find_text(&self, input: FindTextInput) -> anyhow::Result<FindTextResult> {
        let failed = |message: String| FindTextResult {
            success: false,
            message,
            matches: None,
        };
        Ok(match self.locate_text(&input.text).await {
            Err(err) => failed(self.failure("I could not read the screen", &err)),
            Ok(None) => failed(self.cannot_read()),
            Ok(Some(matches)) if matches.is_empty() => failed(format!(
                "I cannot see the text \"{}\" on the screen right now.",
                input.text
            )),
            Ok(Some(matches)) => FindTextResult {
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
        })
    }

    async fn click_text(&self, input: ClickTextInput) -> anyhow::Result<DesktopActionResult> {
        let matches = match self.locate_text(&input.text).await {
            Ok(matches) => matches,
            Err(err) => {
                return Ok(DesktopActionResult::new(
                    false,
                    self.failure("I could not read the screen", &err),
                ));
            }
        };
        let Some(matches) = matches else {
            return Ok(DesktopActionResult::new(false, self.cannot_read()));
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
        let index = (count.min(1_i64.max(input.occurrence.unwrap_or(1))) - 1) as usize;
        let target = matches[index].clone();
        let others = if matches.len() > 1 {
            format!(
                " ({} matches; clicked number {}, in \"{}\")",
                matches.len(),
                index + 1,
                target.line
            )
        } else {
            String::new()
        };
        let click = ClickInput {
            x: Some(target.x as f64),
            y: Some(target.y as f64),
            button: input.button,
            double: input.double,
        };
        Ok(self
            .click_described(
                click,
                Some(Box::new(move |verb: &str| {
                    format!(
                        "{verb} \"{}\" at ({}, {}){others}",
                        target.text, target.x, target.y
                    )
                })),
            )
            .await)
    }

    async fn move_pointer(&self, input: MoveInput) -> anyhow::Result<DesktopActionResult> {
        let at = self.to_display(input.x, input.y);
        Ok(self
            .act(
                Capability::Input,
                || async move {
                    self.state.lock().pointer = at;
                    self.call("input.pointer", at.json(), INPUT_TIMEOUT_MS)
                        .await?;
                    Ok(())
                },
                format!(
                    "Moved the pointer to ({}, {})",
                    rounded(input.x),
                    rounded(input.y)
                ),
            )
            .await)
    }

    async fn click(&self, input: ClickInput) -> anyhow::Result<DesktopActionResult> {
        Ok(self.click_described(input, None).await)
    }

    async fn drag(&self, input: DragInput) -> anyhow::Result<DesktopActionResult> {
        let button = input.button.unwrap_or(MouseButton::Left);
        let from = self.to_display(input.from_x, input.from_y);
        let to = self.to_display(input.to_x, input.to_y);
        Ok(self
            .act(
                Capability::Input,
                || async move {
                    // Notifications apply in arrival order, so only the release needs an answer.
                    self.link.notify("input.pointer", Some(from.json()));
                    self.link.notify(
                        "input.button",
                        Some(json!({ "button": button.as_str(), "down": true })),
                    );
                    for step in 1..=DRAG_STEPS {
                        let along = |a: i64, b: i64| {
                            rounded(a as f64 + ((b - a) * step) as f64 / DRAG_STEPS as f64)
                        };
                        self.link.notify(
                            "input.pointer",
                            Some(json!({ "x": along(from.x, to.x), "y": along(from.y, to.y) })),
                        );
                    }
                    self.state.lock().pointer = to;
                    self.call(
                        "input.button",
                        json!({ "button": button.as_str(), "down": false }),
                        INPUT_TIMEOUT_MS,
                    )
                    .await?;
                    Ok(())
                },
                format!(
                    "Dragged {} from ({}, {}) to ({}, {})",
                    button.as_str(),
                    rounded(input.from_x),
                    rounded(input.from_y),
                    rounded(input.to_x),
                    rounded(input.to_y)
                ),
            )
            .await)
    }

    async fn type_text(&self, input: TypeInput) -> anyhow::Result<DesktopActionResult> {
        let length = js::len16(&input.text);
        let timeout = TYPE_TIMEOUT_CAP_MS.min(INPUT_TIMEOUT_MS + length as u64 * TYPE_MS_PER_CHAR);
        let text = input.text.clone();
        Ok(self
            .act(
                Capability::Input,
                || async move {
                    self.call("input.text", json!({ "text": text }), timeout)
                        .await?;
                    Ok(())
                },
                format!(
                    "Typed {length} character{}",
                    if length == 1 { "" } else { "s" }
                ),
            )
            .await)
    }

    async fn key(&self, input: KeyInput) -> anyhow::Result<DesktopActionResult> {
        let keys = input.keys.clone();
        Ok(self
            .act(
                Capability::Input,
                || async move {
                    self.call("input.key", json!({ "keys": keys }), INPUT_TIMEOUT_MS)
                        .await?;
                    Ok(())
                },
                format!("Pressed {}", input.keys),
            )
            .await)
    }

    async fn scroll(&self, input: ScrollInput) -> anyhow::Result<DesktopActionResult> {
        let at = self.to_display(input.x, input.y);
        let clicks = input.clicks.unwrap_or(3);
        let dy = if input.direction == ScrollDirection::Down {
            clicks
        } else {
            -clicks
        };
        Ok(self
            .act(
                Capability::Input,
                || async move {
                    self.state.lock().pointer = at;
                    self.call(
                        "input.wheel",
                        json!({ "x": at.x, "y": at.y, "dy": dy }),
                        INPUT_TIMEOUT_MS,
                    )
                    .await?;
                    Ok(())
                },
                format!(
                    "Scrolled {} at ({}, {})",
                    input.direction.as_str(),
                    rounded(input.x),
                    rounded(input.y)
                ),
            )
            .await)
    }
}

#[async_trait]
impl ComputerUserScreen for RemoteComputer {
    /// Answers that the user is not sharing their screen.
    async fn look_at_user_screen(&self) -> anyhow::Result<UserScreenResult> {
        Ok(UserScreenResult {
            success: false,
            message: "Your user is not sharing their screen right now.".to_string(),
            text: None,
        })
    }
}

#[async_trait]
impl Computer for RemoteComputer {
    async fn with_model_channel(&self, channel: Arc<dyn ModelChannel>, action: BoxFuture<'_, ()>) {
        self.channels.run(channel, action).await
    }

    fn start_screen_stream(&self, on_frame: FrameSink) {
        let (id, display) = {
            let mut state = self.state.lock();
            // Kept even when the computer cannot stream yet, so the stream starts once it can.
            state.watcher = Some(Arc::clone(&on_frame));
            if !state.capabilities.contains(&Capability::Stream) {
                return;
            }
            let id = state.next_stream;
            state.next_stream += 1;
            let size = ScreenSize {
                width: state.display.width,
                height: state.display.height,
            };
            state.stream = Some(RemoteStream {
                id,
                on_frame,
                started: false,
                size,
            });
            (id, state.display.id.clone())
        };
        let me = self.me.clone();
        // The client answers before this stream's first frame, so the answer is where it begins.
        let on_answer = Box::new(move |started: &StreamStartResult| {
            let Some(computer) = me.upgrade() else {
                return;
            };
            let on_frame = {
                let mut state = computer.state.lock();
                let Some(stream) = state.stream.as_mut().filter(|stream| stream.id == id) else {
                    return;
                };
                stream.size = ScreenSize {
                    width: started.width,
                    height: started.height,
                };
                stream.started = true;
                Arc::clone(&stream.on_frame)
            };
            on_frame(match started.encoding {
                StreamEncoding::H264 => ScreenFrame::Start {
                    encoding: StreamEncoding::H264,
                    codec: Some(
                        started
                            .codec
                            .clone()
                            .unwrap_or_else(|| "avc1.42E01F".to_string()),
                    ),
                },
                StreamEncoding::Jpeg => ScreenFrame::Start {
                    encoding: StreamEncoding::Jpeg,
                    codec: None,
                },
            });
        });
        let answer = self.link.request::<StreamStartResult>(
            "stream.start",
            Some(json!({
                "display": display,
                "encodings": ["h264", "jpeg"],
                "maxWidth": MAX_SCREEN.width,
                "fps": 30,
            })),
            READ_TIMEOUT_MS,
            Some(on_answer),
        );
        let me = self.me.clone();
        tokio::spawn(async move {
            let Err(err) = answer.await else {
                return;
            };
            let Some(computer) = me.upgrade() else {
                return;
            };
            {
                let mut state = computer.state.lock();
                if state.stream.as_ref().is_some_and(|stream| stream.id == id) {
                    state.stream = None;
                }
            }
            log_warn!(
                "[Computer:Remote] {}: the screen stream did not start: {}",
                computer.name(),
                detail(&err)
            );
        });
    }

    fn stop_screen_stream(&self) {
        {
            let mut state = self.state.lock();
            state.watcher = None;
            if state.stream.take().is_none() {
                return;
            }
        }
        // Sent now; nobody waits for the answer.
        drop(
            self.link
                .request::<EmptyResult>("stream.stop", None, INPUT_TIMEOUT_MS, None),
        );
    }

    /// A viewer's pointer and keyboard while it holds the computer; positions are stream
    /// pixels.
    fn handle_input(&self, text: &str) {
        if !self.can(Capability::Input) {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let Some(frame) = input_frame(&value) else {
            return;
        };
        match frame {
            InputFrame::Pointer { x, y } => {
                let at = self.from_stream(x, y);
                self.state.lock().pointer = at;
                self.move_now();
            }
            InputFrame::PointerMove { dx, dy } => {
                let (sx, sy) = self.stream_scale();
                let pointer = self.state.lock().pointer;
                let at = self.clamp(pointer.x as f64 + dx * sx, pointer.y as f64 + dy * sy);
                self.state.lock().pointer = at;
                self.schedule_move();
            }
            InputFrame::PointerButton { button, down } => {
                self.flush_move();
                {
                    let mut state = self.state.lock();
                    if down {
                        state.held.insert(button);
                    } else {
                        state.held.shift_remove(&button);
                    }
                }
                self.link.notify(
                    "input.button",
                    Some(json!({ "button": button.as_str(), "down": down })),
                );
            }
            InputFrame::Wheel { dy } => {
                let clicks =
                    MAX_WHEEL_CLICKS.min(1_i64.max(rounded(dy.abs() / WHEEL_PIXELS_PER_CLICK)));
                self.flush_move();
                let pointer = self.state.lock().pointer;
                self.link.notify(
                    "input.wheel",
                    Some(json!({
                        "x": pointer.x,
                        "y": pointer.y,
                        "dy": if dy > 0.0 { clicks } else { -clicks },
                    })),
                );
            }
            InputFrame::Key(frame) => {
                if let Some(keys) = chord_for(&frame, MetaAs::Super) {
                    self.link.notify("input.key", Some(json!({ "keys": keys })));
                }
            }
            InputFrame::Text { text } => {
                let typed = paste_text(&text);
                if !typed.is_empty() {
                    self.link
                        .notify("input.text", Some(json!({ "text": typed })));
                }
            }
        }
    }

    fn release_input(&self) {
        self.flush_move();
        let held: Vec<MouseButton> = self.state.lock().held.drain(..).collect();
        for button in held {
            self.link.notify(
                "input.button",
                Some(json!({ "button": button.as_str(), "down": false })),
            );
        }
    }

    async fn clear_after_secure_window(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn tab_target(&self, _tab: Option<i64>) -> anyhow::Result<Option<String>> {
        Ok(None)
    }

    async fn focus_target(&self, _target_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn sign_in_form(&self, _tab: Option<i64>) -> anyhow::Result<Option<SignInFormInfo>> {
        Ok(None)
    }

    async fn sign_in(
        &self,
        _target_id: &str,
        _site: &str,
        _credentials: &SignInCredentials,
    ) -> anyhow::Result<SignInOutcome> {
        Ok(SignInOutcome::NoForm)
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let timer = {
            let mut state = self.state.lock();
            state.stream = None;
            state.move_timer.take()
        };
        if let Some(timer) = timer {
            timer.abort();
        }
        Ok(())
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

#[cfg(test)]
mod tests;
