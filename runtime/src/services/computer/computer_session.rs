//! One computer, independent of calls, invocations, and viewers: who uses it and who
//! watches it.

use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Weak};

use bytes::Bytes;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::agent_computer::ModelChannel;
use super::computer::{Computer, SignInFormInfo, with_model_channel};
use super::computer_access::{ComputerAccess, ComputerKind, ComputerUse};
use super::picture_stream::ScreenFrame;
use super::sign_in_form::SignInCredentials;
use super::supported::has_computer;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::support::now_ms;
use crate::{log_error, log_warn};

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

/// Whether two handles are on the same computer.
fn same_computer(a: &Arc<dyn Computer>, b: &Arc<dyn Computer>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

fn describe(use_: &ComputerUse) -> UseSummary {
    UseSummary {
        id: use_.id.clone(),
        thread_id: use_.thread_id.clone(),
        mode: use_.mode.clone(),
    }
}

/// One computer, independent of calls, invocations, and viewers: who uses it and who
/// watches it. `start` brings the computer up, and a session caches what it returns until
/// the computer goes away.
pub struct ComputerSession {
    pub id: String,
    pub kind: ComputerKind,
    pub access: Arc<ComputerAccess>,
    /// This session, for the stream's frames and the opening that outlive a call.
    me: Weak<ComputerSession>,
    start: ComputerOpener,
    state: Mutex<SessionState>,
}

impl ComputerSession {
    /// The session's access clears a secure window through the computer it has then.
    pub fn new(id: String, kind: ComputerKind, start: ComputerOpener) -> Arc<Self> {
        Arc::new_cyclic(|me: &Weak<ComputerSession>| {
            let session = me.clone();
            let clear: super::computer_access::ClearSecrets = Arc::new(move || {
                let session = session.clone();
                Box::pin(async move {
                    match session.upgrade() {
                        Some(session) => session.forget_secure_window().await,
                        None => Ok(()),
                    }
                })
            });
            ComputerSession {
                id,
                kind,
                access: ComputerAccess::new(Some(clear), kind),
                me: me.clone(),
                start,
                state: Mutex::new(SessionState {
                    computer: None,
                    opening: None,
                    viewers: IndexMap::new(),
                    ready: HashSet::new(),
                    held_locally: false,
                }),
            }
        })
    }

    pub fn status(&self) -> SessionStatus {
        let (running, starting) = {
            let state = self.state.lock();
            (state.computer.is_some(), state.opening.is_some())
        };
        SessionStatus {
            computer_id: self.id.clone(),
            // The runtime's own desktop can come up when the host has one; a remote one is
            // up or not.
            available: if self.kind == ComputerKind::Local {
                has_computer()
            } else {
                running
            },
            running,
            starting,
            paused: self.access.paused(),
            secure: self.access.secure(),
            controller: self.access.human(),
            owner: self.access.owner().map(|owner| describe(&owner)),
            waiting: self
                .access
                .waiting()
                .iter()
                .map(|use_| describe(use_))
                .collect(),
        }
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
        let viewers: Vec<Arc<dyn ComputerViewer>> =
            self.state.lock().viewers.values().cloned().collect();
        for viewer in viewers {
            viewer.audio(pcm.clone());
        }
    }

    /// The computer, brought up by `start` when it is not up, with one opening shared by
    /// every caller. Fails with what `start` failed with.
    pub async fn open(&self) -> anyhow::Result<Arc<dyn Computer>> {
        let (opening, started) = {
            let mut state = self.state.lock();
            if let Some(computer) = &state.computer {
                return Ok(computer.clone());
            }
            match &state.opening {
                Some(opening) => (opening.clone(), false),
                None => {
                    let start = self.start.clone();
                    let me = self.me.clone();
                    let opening: Opening = async move {
                        let result = start().await;
                        if let Some(session) = me.upgrade() {
                            {
                                let mut state = session.state.lock();
                                if let Ok(computer) = &result {
                                    state.computer = Some(computer.clone());
                                }
                                state.opening = None;
                            }
                            session.access.emit_change();
                        }
                        result.map_err(|err| err.to_string())
                    }
                    .boxed()
                    .shared();
                    state.opening = Some(opening.clone());
                    (opening, true)
                }
            }
        };
        if started {
            self.access.emit_change();
        }
        opening.await.map_err(|message| anyhow::anyhow!(message))
    }

    /// A remote computer's link came up: viewers already watching get its screen.
    pub fn connected(&self, computer: Arc<dyn Computer>) {
        let watched = {
            let mut state = self.state.lock();
            state.computer = Some(computer.clone());
            !state.viewers.is_empty()
        };
        if watched {
            self.start_stream(&computer);
        }
        self.access.emit_change();
    }

    /// The computer went away. A person holding it from there no longer does.
    pub fn lost(&self, computer: &Arc<dyn Computer>) {
        let held = {
            let mut state = self.state.lock();
            if !state
                .computer
                .as_ref()
                .is_some_and(|current| same_computer(current, computer))
            {
                return;
            }
            state.computer = None;
            state.ready.clear();
            std::mem::replace(&mut state.held_locally, false)
        };
        if held {
            let access = self.access.clone();
            tokio::spawn(async move {
                if let Err(err) = access.hand_back(LOCAL_CONTROLLER).await {
                    log_warn!(
                        json!({ "err": err_json(&err) }),
                        "[Computer] Could not end the hold of a computer that went away"
                    );
                }
            });
        }
        self.access.emit_change();
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
        self.access
            .run(
                use_,
                || async move {
                    let computer = self.open().await?;
                    with_model_channel(&*computer, channel, action(computer.clone())).await
                },
                inspection,
            )
            .await
    }

    /// Show a viewer the screen. The runtime's own desktop comes up for it; a remote
    /// computer that is not connected is shown once it connects. Answers what detaches the
    /// viewer.
    pub async fn attach(
        self: &Arc<Self>,
        id: &str,
        viewer: Arc<dyn ComputerViewer>,
    ) -> anyhow::Result<Box<dyn FnOnce() + Send>> {
        self.state.lock().viewers.insert(id.to_string(), viewer);
        let detach: Box<dyn FnOnce() + Send> = {
            let session = self.clone();
            let id = id.to_string();
            Box::new(move || session.detach(&id))
        };
        if self.kind == ComputerKind::Remote {
            if let Some(computer) = self.computer() {
                self.start_stream(&computer);
            }
            self.access.emit_change();
            return Ok(detach);
        }
        match self.open().await {
            Ok(computer) => {
                if self.state.lock().viewers.contains_key(id) {
                    self.start_stream(&computer);
                }
                Ok(detach)
            }
            Err(err) => {
                self.detach(id);
                Err(err)
            }
        }
    }

    /// Restart the stream so every viewer receives a decoder configuration and keyframe.
    fn start_stream(&self, computer: &Arc<dyn Computer>) {
        self.state.lock().ready.clear();
        let me = self.me.clone();
        computer.start_screen_stream(Arc::new(move |frame: ScreenFrame| {
            let Some(session) = me.upgrade() else {
                return;
            };
            let receivers: Vec<Arc<dyn ComputerViewer>> = {
                let mut state = session.state.lock();
                let state = &mut *state;
                let mut receivers = Vec::new();
                for (viewer_id, client) in &state.viewers {
                    let passes = match &frame {
                        ScreenFrame::Start { .. } => true,
                        ScreenFrame::H264 { keyframe, .. } => {
                            *keyframe || state.ready.contains(viewer_id)
                        }
                        ScreenFrame::Jpeg { .. } => true,
                    };
                    if !passes {
                        continue;
                    }
                    if !matches!(frame, ScreenFrame::Start { .. }) {
                        state.ready.insert(viewer_id.clone());
                    }
                    receivers.push(client.clone());
                }
                receivers
            };
            for client in receivers {
                client.screen(frame.clone());
            }
        }));
    }

    pub fn detach(&self, id: &str) {
        let (watched, computer, empty) = {
            let mut state = self.state.lock();
            let watched = state.viewers.shift_remove(id).is_some();
            state.ready.remove(id);
            (watched, state.computer.clone(), state.viewers.is_empty())
        };
        self.access.disconnected(id);
        if empty {
            if let Some(computer) = computer {
                computer.stop_screen_stream();
            }
        }
        if watched && self.kind == ComputerKind::Remote {
            self.access.emit_change();
        }
    }

    /// A takeover answering a help request is secure: pass that request. Fails with `Open
    /// Computer before taking control.` for a client that is not a viewer.
    pub async fn take_control(&self, id: &str, help: Option<&HelpTarget>) -> anyhow::Result<()> {
        if !self.state.lock().viewers.contains_key(id) {
            anyhow::bail!("Open Computer before taking control.");
        }
        self.access
            .take_control(id, help.map(|help| help.id.as_str()))
            .await?;
        if let Some(target_id) = help.and_then(|help| help.target_id.as_deref()) {
            if let Some(computer) = self.computer() {
                computer.focus_target(target_id).await?;
            }
        }
        Ok(())
    }

    /// The person at a remote computer takes it, secure while a help request waits on it.
    pub async fn hold_locally(&self, help_id: Option<&str>) -> anyhow::Result<()> {
        // Set first, so a release that arrives while the agent's action drains still applies.
        self.state.lock().held_locally = true;
        if let Err(err) = self.access.take_control(LOCAL_CONTROLLER, help_id).await {
            self.state.lock().held_locally = false;
            return Err(err);
        }
        Ok(())
    }

    pub async fn release_locally(&self) -> anyhow::Result<()> {
        {
            let mut state = self.state.lock();
            if !state.held_locally {
                return Ok(());
            }
            state.held_locally = false;
        }
        self.access.hand_back(LOCAL_CONTROLLER).await
    }

    /// Nothing a person typed inside a secure window reaches the agent after it.
    async fn forget_secure_window(&self) -> anyhow::Result<()> {
        match self.computer() {
            Some(computer) => computer.clear_after_secure_window().await,
            None => Ok(()),
        }
    }

    pub async fn help_target(&self, tab: Option<i64>) -> anyhow::Result<Option<String>> {
        match self.computer() {
            Some(computer) => computer.tab_target(tab).await,
            None => Ok(None),
        }
    }

    /// The sign-in on a tab, when it holds one the user can answer.
    pub async fn sign_in_form(&self, tab: Option<i64>) -> anyhow::Result<Option<SignInFormInfo>> {
        match self.computer() {
            Some(computer) => computer.sign_in_form(tab).await,
            None => Ok(None),
        }
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
        let started_at = now_ms();
        let outcome = self.run_sign_in(help, credentials).await;
        let mut props = IndexMap::new();
        if let Some(agent_id) = agent_id.filter(|id| !id.is_empty()) {
            props.insert("agent.id".to_string(), agent_id.to_string());
        }
        props.insert("computer.help_id".to_string(), help.id.clone());
        props.insert("status".to_string(), outcome.as_str().to_string());
        props.insert(
            "elapsed_ms".to_string(),
            (now_ms() - started_at).to_string(),
        );
        track_event("computer sign-in filled", Some(user_id), Some(props));
        outcome
    }

    async fn run_sign_in(
        &self,
        help: &HelpTarget,
        credentials: &SignInCredentials,
    ) -> SignInOutcome {
        let computer = self.computer();
        let (Some(computer), Some(target_id), Some(site)) =
            (computer, help.target_id.as_deref(), help.site.as_deref())
        else {
            return SignInOutcome::TabGone;
        };
        // Somebody is at the keyboard: their takeover pauses the desktop, and this one would
        // queue behind it and type into a screen they are using.
        if self.access.paused() {
            return SignInOutcome::InUse;
        }
        let typed = self
            .access
            .run_secure(&help.id, computer.sign_in(target_id, site, credentials))
            .await;
        match typed {
            Ok(outcome) => outcome,
            Err(err) => {
                log_error!(
                    json!({ "err": err_json(&err) }),
                    "[Computer] A sign-in could not be typed"
                );
                SignInOutcome::Error
            }
        }
    }

    /// Fails with `Open Computer before continuing.` for a client that is not a viewer, and
    /// as `ComputerAccess::assert_can_hand_back` does.
    pub fn assert_can_hand_back(&self, id: &str) -> anyhow::Result<()> {
        if !self.state.lock().viewers.contains_key(id) {
            anyhow::bail!("Open Computer before continuing.");
        }
        self.access.assert_can_hand_back(id)
    }

    pub async fn hand_back(&self, id: &str) -> anyhow::Result<()> {
        self.assert_can_hand_back(id)?;
        if let Some(computer) = self.computer() {
            computer.release_input();
        }
        self.access.hand_back(id).await
    }

    /// Hand back from chat. Fails with `HELD_LOCALLY` while the person at a remote computer
    /// holds it, since only their client's release ends the secure window they may be
    /// typing in.
    pub async fn continue_from_chat(&self) -> anyhow::Result<()> {
        let human = self.access.human();
        if human.as_deref() == Some(LOCAL_CONTROLLER) {
            anyhow::bail!(HELD_LOCALLY);
        }
        let id = human.unwrap_or_else(|| "chat".to_string());
        self.access.assert_can_hand_back(&id)?;
        if let Some(computer) = self.computer() {
            computer.release_input();
        }
        self.access.hand_back(&id).await
    }

    /// A text frame from viewer `id`.
    pub fn input(&self, id: &str, text: &str) {
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let kind = frame.get("type").and_then(Value::as_str);
        if kind == Some("viewport") {
            return;
        }
        if kind.is_some_and(|kind| kind.starts_with("user_screen")) {
            if let Some(computer) = self.computer() {
                computer.handle_input(text);
            }
            return;
        }
        if self.access.human().as_deref() == Some(id) && self.access.paused() {
            if let Some(computer) = self.computer() {
                computer.handle_input(text);
            }
        }
    }

    pub async fn close(&self) {
        self.access.stop();
        for use_ in self.access.waiting() {
            use_.controller.cancel();
        }
        let opening = self.state.lock().opening.clone();
        if let Some(opening) = opening {
            let _ = opening.await;
        }
        let computer = {
            let mut state = self.state.lock();
            state.viewers.clear();
            state.computer.take()
        };
        if let Some(computer) = computer {
            if let Err(err) = computer.stop().await {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[Computer] Shutdown failed"
                );
            }
        }
    }
}
