//! One computer, independent of calls, invocations, and viewers: who uses it and who
//! watches it.

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;

use bytes::Bytes;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::agent_computer::ModelChannel;
use super::computer::{Computer, SignInFormInfo};
use super::computer_access::{ComputerAccess, ComputerKind, ComputerUse};
use super::picture_stream::ScreenFrame;
use super::sign_in_form::SignInCredentials;

/// How a sign-in the user answered ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInOutcome {
    Filled,
    NoForm,
    NoPasswordStep,
    TabGone,
    SiteChanged,
    InUse,
    Error,
}

impl SignInOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SignInOutcome::Filled => "filled",
            SignInOutcome::NoForm => "no_form",
            SignInOutcome::NoPasswordStep => "no_password_step",
            SignInOutcome::TabGone => "tab_gone",
            SignInOutcome::SiteChanged => "site_changed",
            SignInOutcome::InUse => "in_use",
            SignInOutcome::Error => "error",
        }
    }
}

/// A socket watching a computer: its screen, and the desktop's sound.
pub trait ComputerViewer: Send + Sync {
    fn screen(&self, frame: ScreenFrame);
    fn audio(&self, pcm: Bytes);
}

/// The control a person at a remote computer takes, as `ComputerAccess` names it.
const LOCAL_CONTROLLER: &str = "local";

/// What a hand-back from chat is told while the person at the computer holds it.
pub const HELD_LOCALLY: &str =
    "The person at the computer still has control. It continues when they hand it back there.";

/// Who holds the mouse and keyboard: a viewer, or the person at a remote computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Controller {
    Viewer,
    Local,
}

/// One invocation as a session's status lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseSummary {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub mode: String,
}

/// A session's status, as the REST routes and the chat socket send it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub computer_id: String,
    /// The runtime's own desktop can come up when the host has one; a remote one is up or not.
    pub available: bool,
    pub running: bool,
    pub starting: bool,
    pub paused: bool,
    pub secure: bool,
    /// The client holding the mouse and keyboard.
    pub controller: Option<String>,
    pub owner: Option<UseSummary>,
    pub waiting: Vec<UseSummary>,
}

/// The help request a takeover or a sign-in answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HelpTarget {
    pub id: String,
    pub target_id: Option<String>,
    pub site: Option<String>,
}

/// What brings a computer up.
pub type ComputerOpener =
    Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<Arc<dyn Computer>>> + Send + Sync>;

/// An opening in progress, which every caller of `open` waits for. The error is the text
/// the opener failed with.
type Opening = Shared<BoxFuture<'static, Result<Arc<dyn Computer>, String>>>;

struct SessionState {
    computer: Option<Arc<dyn Computer>>,
    opening: Option<Opening>,
    /// The viewers, in the order they attached, which is the order frames go out in.
    viewers: IndexMap<String, Arc<dyn ComputerViewer>>,
    /// The viewers that have had a keyframe of the stream running now.
    ready: HashSet<String>,
    /// Whether the person at a remote computer holds it.
    held_locally: bool,
}

/// One computer, independent of calls, invocations, and viewers: who uses it and who
/// watches it. `start` brings the computer up, and a session caches what it returns until
/// the computer goes away.
pub struct ComputerSession {
    pub id: String,
    pub kind: ComputerKind,
    pub access: ComputerAccess,
    start: ComputerOpener,
    state: Mutex<SessionState>,
}

impl ComputerSession {
    /// The session's access clears a secure window through the computer it has then.
    pub fn new(id: String, kind: ComputerKind, start: ComputerOpener) -> Arc<Self> {
        todo!()
    }

    pub fn status(&self) -> SessionStatus {
        todo!()
    }

    pub fn watched(&self) -> bool {
        !self.state.lock().viewers.is_empty()
    }

    /// Who holds the mouse and keyboard: a viewer, the person at a remote computer, or
    /// nobody.
    pub fn controller(&self) -> Option<Controller> {
        match self.access.human() {
            None => None,
            Some(human) if human == LOCAL_CONTROLLER => Some(Controller::Local),
            Some(_) => Some(Controller::Viewer),
        }
    }

    /// The computer, while it is up.
    pub fn computer(&self) -> Option<Arc<dyn Computer>> {
        self.state.lock().computer.clone()
    }

    /// The desktop's sound, to every viewer.
    pub fn broadcast_audio(&self, pcm: Bytes) {
        todo!()
    }

    /// The computer, brought up by `start` when it is not up, with one opening shared by
    /// every caller. Fails with what `start` failed with.
    pub async fn open(&self) -> anyhow::Result<Arc<dyn Computer>> {
        todo!()
    }

    /// A remote computer's link came up: viewers already watching get its screen.
    pub fn connected(&self, computer: Arc<dyn Computer>) {
        todo!()
    }

    /// The computer went away. A person holding it from there no longer does.
    pub fn lost(&self, computer: &Arc<dyn Computer>) {
        todo!()
    }

    /// Run `action` on the computer as the invocation `use_`, with pictures going to
    /// `channel`.
    pub async fn act<T, F, Fut>(
        &self,
        use_: &Arc<ComputerUse>,
        action: F,
        channel: Arc<dyn ModelChannel>,
        inspection: bool,
    ) -> anyhow::Result<T>
    where
        F: FnOnce(Arc<dyn Computer>) -> Fut + Send,
        Fut: Future<Output = anyhow::Result<T>> + Send,
        T: Send,
    {
        todo!()
    }

    /// Show a viewer the screen. The runtime's own desktop comes up for it; a remote
    /// computer that is not connected is shown once it connects. Answers what detaches the
    /// viewer.
    pub async fn attach(
        self: &Arc<Self>,
        id: &str,
        viewer: Arc<dyn ComputerViewer>,
    ) -> anyhow::Result<Box<dyn FnOnce() + Send>> {
        todo!()
    }

    /// Restart the stream so every viewer receives a decoder configuration and keyframe.
    fn start_stream(self: &Arc<Self>, computer: &Arc<dyn Computer>) {
        todo!()
    }

    pub fn detach(&self, id: &str) {
        todo!()
    }

    /// A takeover answering a help request is secure: pass that request. Fails with `Open
    /// Computer before taking control.` for a client that is not a viewer.
    pub async fn take_control(&self, id: &str, help: Option<&HelpTarget>) -> anyhow::Result<()> {
        todo!()
    }

    /// The person at a remote computer takes it, secure while a help request waits on it.
    pub async fn hold_locally(&self, help_id: Option<&str>) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn release_locally(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// Nothing a person typed inside a secure window reaches the agent after it.
    async fn forget_secure_window(&self) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn help_target(&self, tab: Option<i64>) -> anyhow::Result<Option<String>> {
        todo!()
    }

    /// The sign-in on a tab, when it holds one the user can answer.
    pub async fn sign_in_form(&self, tab: Option<i64>) -> anyhow::Result<Option<SignInFormInfo>> {
        todo!()
    }

    /// Type a sign-in the user answered, with the agent stopped for as long as it takes.
    ///
    /// The window around it is the one a takeover opens, so nothing decides anything while
    /// a field holds a password, and the fields are cleared when it closes. Emits `computer
    /// sign-in filled` with the outcome.
    pub async fn sign_in(
        &self,
        help: &HelpTarget,
        credentials: &SignInCredentials,
        user_id: &str,
        agent_id: Option<&str>,
    ) -> SignInOutcome {
        todo!()
    }

    async fn run_sign_in(
        &self,
        help: &HelpTarget,
        credentials: &SignInCredentials,
    ) -> SignInOutcome {
        todo!()
    }

    /// Fails with `Open Computer before continuing.` for a client that is not a viewer, and
    /// as `ComputerAccess::assert_can_hand_back` does.
    pub fn assert_can_hand_back(&self, id: &str) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn hand_back(&self, id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Hand back from chat. Fails with `HELD_LOCALLY` while the person at a remote computer
    /// holds it, since only their client's release ends the secure window they may be
    /// typing in.
    pub async fn continue_from_chat(&self) -> anyhow::Result<()> {
        todo!()
    }

    /// A text frame from viewer `id`.
    pub fn input(&self, id: &str, text: &str) {
        todo!()
    }

    pub async fn close(&self) {
        todo!()
    }
}
