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

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use indexmap::IndexSet;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinHandle;

use super::computer_link::{ComputerLink, LinkError, LinkEvent};
use super::link_protocol::{
    Capability, CapabilityProblem, InitializeParams, RemoteDisplay, RemotePlatform, RemoteWindow,
};
use crate::services::computer::agent_computer::{ModelChannel, ModelChannelScope};
use crate::services::computer::computer::{Computer, SignInFormInfo};
use crate::services::computer::computer_session::SignInOutcome;
use crate::services::computer::computer_tools::{
    ClickInput, ClickTextInput, ComputerBrowser, ComputerDesktop, ComputerUserScreen,
    DesktopActionResult, DragInput, FindTextInput, FindTextResult, KeyInput, ListElementsInput,
    MoveInput, ScreenLook, ScrollInput, TextLocation, TypeInput, UserScreenResult,
    WindowActionInput,
};
use crate::services::computer::desktop_control::MouseButton;
use crate::services::computer::picture_stream::FrameSink;
use crate::services::computer::screen_elements::ScreenElement;
use crate::services::computer::screen_size::ScreenSize;
use crate::services::computer::sign_in_form::SignInCredentials;
use crate::services::meeting::browser_control::{BrowserCommand, BrowserResult};

/// How long an input request may take on the computer, and a read of its screen or controls.
const INPUT_TIMEOUT_MS: u64 = 10_000;
const READ_TIMEOUT_MS: u64 = 30_000;
/// Extra time a typed text gets per character, up to a cap.
const TYPE_MS_PER_CHAR: u64 = 50;
const TYPE_TIMEOUT_CAP_MS: u64 = 120_000;
/// How many pointer positions a drag walks through between press and release.
const DRAG_STEPS: i64 = 10;
/// How long a viewer's movement is gathered before one position goes out.
const MOVE_FLUSH_MS: u64 = 16;
const WHEEL_PIXELS_PER_CLICK: f64 = 60.0;
const MAX_WHEEL_CLICKS: i64 = 10;
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
        todo!()
    }

    pub fn info(&self) -> RemoteComputerInfo {
        todo!()
    }

    pub fn name(&self) -> String {
        (self.name_of)()
    }

    fn channel(&self) -> Option<Arc<dyn ModelChannel>> {
        self.channels.current()
    }

    /// The largest picture the model is shown, which a capture is asked for.
    fn picture(&self) -> ScreenSize {
        todo!()
    }

    /// The picture the model's coordinates refer to: the last one it saw, else the one
    /// asked for.
    fn seen_picture(&self) -> ScreenSize {
        todo!()
    }

    /// A notification from the client: `displays.changed` or `capabilities.changed`.
    fn notified(&self, method: &str, params: Option<&Value>) {
        todo!()
    }

    /// A binary frame of the screen stream, passed on as the viewer socket sends it.
    fn frame(&self, data: &Bytes) {
        todo!()
    }

    fn can(&self, capability: Capability) -> bool {
        self.state.lock().capabilities.contains(&capability)
    }

    fn missing(&self, capability: Capability) -> String {
        todo!()
    }

    fn cannot_read(&self) -> String {
        todo!()
    }

    /// What the model is told when the computer or the link refused.
    fn failure(&self, what: &str, err: &anyhow::Error) -> String {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// One picture of the screen into the session. Its own size is what the model's next
    /// coordinates refer to. One larger than asked for is refused: a provider may shrink it
    /// before the model sees it, to a scale the runtime cannot know.
    async fn show_screen(&self, note: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// The computer's controls, in the model's picture coordinates. `filter` lets the client
    /// stop early; the callers match names again, so a client may ignore it.
    async fn read_elements(&self, filter: Option<&str>) -> anyhow::Result<Vec<ScreenElement>> {
        todo!()
    }

    /// The open windows, in the model's picture coordinates.
    async fn read_windows(&self) -> anyhow::Result<Vec<RemoteWindow>> {
        todo!()
    }

    /// Find `query` on the screen in picture coordinates: a control of that name first,
    /// else words read off a full-size capture. `None` when the computer offers neither.
    async fn locate_text(&self, query: &str) -> anyhow::Result<Option<Vec<TextLocation>>> {
        todo!()
    }

    async fn can_read_text(&self) -> bool {
        todo!()
    }

    fn display_size(&self) -> ScreenSize {
        todo!()
    }

    fn clamp(&self, x: f64, y: f64) -> DisplayPoint {
        todo!()
    }

    fn to_display(&self, x: f64, y: f64) -> DisplayPoint {
        todo!()
    }

    fn to_picture(&self, x: f64, y: f64) -> (f64, f64) {
        todo!()
    }

    fn stream_scale(&self) -> (f64, f64) {
        todo!()
    }

    fn from_stream(&self, x: f64, y: f64) -> DisplayPoint {
        todo!()
    }

    fn schedule_move(&self) {
        todo!()
    }

    fn flush_move(&self) {
        todo!()
    }

    fn move_now(&self) {
        todo!()
    }

    async fn on_queue<F: Future>(&self, run: F) -> F::Output {
        let _turn = self.tail.lock().await;
        run.await
    }
}

#[async_trait]
impl ComputerBrowser for RemoteComputer {
    /// Answers that the computer offers no browser control, naming the desktop tools.
    async fn browse(&self, command: BrowserCommand) -> anyhow::Result<BrowserResult> {
        todo!()
    }

    async fn look_at_screen(&self) -> anyhow::Result<ScreenLook> {
        todo!()
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
        todo!()
    }

    async fn list_windows(&self) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn window_action(&self, input: WindowActionInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn find_text(&self, input: FindTextInput) -> anyhow::Result<FindTextResult> {
        todo!()
    }

    async fn click_text(&self, input: ClickTextInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn move_pointer(&self, input: MoveInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn click(&self, input: ClickInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn drag(&self, input: DragInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn type_text(&self, input: TypeInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn key(&self, input: KeyInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }

    async fn scroll(&self, input: ScrollInput) -> anyhow::Result<DesktopActionResult> {
        todo!()
    }
}

impl RemoteComputer {
    /// `click` with the message a caller words from the verb (`Clicked`, `Double-clicked`),
    /// as `click_text` words it.
    async fn click_described(
        &self,
        input: ClickInput,
        describe: Option<Box<dyn FnOnce(&str) -> String + Send>>,
    ) -> DesktopActionResult {
        todo!()
    }
}

#[async_trait]
impl ComputerUserScreen for RemoteComputer {
    /// Answers that the user is not sharing their screen.
    async fn look_at_user_screen(&self) -> anyhow::Result<UserScreenResult> {
        todo!()
    }
}

#[async_trait]
impl Computer for RemoteComputer {
    async fn with_model_channel(&self, channel: Arc<dyn ModelChannel>, action: BoxFuture<'_, ()>) {
        self.channels.run(channel, action).await
    }

    fn start_screen_stream(&self, on_frame: FrameSink) {
        todo!()
    }

    fn stop_screen_stream(&self) {
        todo!()
    }

    /// A viewer's pointer and keyboard while it holds the computer; positions are stream
    /// pixels.
    fn handle_input(&self, text: &str) {
        todo!()
    }

    fn release_input(&self) {
        todo!()
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
        todo!()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}
