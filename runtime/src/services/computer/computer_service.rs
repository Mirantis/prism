//! Every computer the agent has: the runtime's own desktop and the remote computers, each
//! a `ComputerSession`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::agent_computer::{AgentComputer, ModelChannel};
use super::computer::Computer;
use super::computer_access::{
    ChangeListener, ChangeListeners, ComputerCaller, ComputerKind, ComputerUse,
};
use super::computer_session::{ComputerSession, Controller};
use super::remote::computer_link::ComputerLink;
use super::remote::link_protocol::CapabilityProblem;
use super::remote::remote_computer::RemoteComputer;
use super::screen_size::ScreenSize;

pub use super::computer_session::{ComputerViewer, SignInOutcome};

/// The id the runtime's own desktop goes by, in the API and as a tool's `computer`.
pub const LOCAL_COMPUTER_ID: &str = "local";

/// Whether a computer's client is linked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerConnection {
    Connected,
    Disconnected,
}

/// The invocation holding a computer, as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerOwner {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub mode: String,
}

/// One computer as the list shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSummary {
    pub id: String,
    pub kind: ComputerKind,
    pub name: String,
    pub connection: ComputerConnection,
    pub platform: Option<String>,
    pub client_version: Option<String>,
    pub display: Option<ScreenSize>,
    pub capabilities: Vec<String>,
    pub problems: Vec<CapabilityProblem>,
    pub last_connected_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub owner: Option<ComputerOwner>,
    pub controller: Option<Controller>,
}

/// What the model calls each platform's Command or Windows key.
fn super_key(platform: &str) -> Option<&'static str> {
    match platform {
        "macos" => Some("super is Command"),
        "windows" => Some("super is the Windows key"),
        _ => None,
    }
}

fn platform_name(platform: &str) -> Option<&'static str> {
    match platform {
        "macos" => Some("macOS"),
        "windows" => Some("Windows"),
        "linux" => Some("Linux"),
        _ => None,
    }
}

/// Bring up the runtime's own desktop with its sound going to `on_audio`; a computer that
/// fails to open is stopped before the failure is passed on.
async fn open_local(
    on_audio: Arc<dyn Fn(Bytes) + Send + Sync>,
) -> anyhow::Result<Arc<AgentComputer>> {
    todo!()
}

/// A remote computer's open link.
struct LinkedComputer {
    computer: Arc<RemoteComputer>,
    link: Arc<ComputerLink>,
}

/// Every computer the agent has: the runtime's own desktop and the remote computers, each
/// a `ComputerSession`. An invocation owns one computer at a time. Emits `change` whenever
/// any of them changes, which is what every status reader subscribes to.
pub struct ComputerService {
    /// The runtime's own desktop.
    pub local: Arc<ComputerSession>,
    remotes: Mutex<HashMap<String, Arc<ComputerSession>>>,
    links: Mutex<HashMap<String, LinkedComputer>>,
    /// Every viewer socket and every link listens for changes, so their number has no bound.
    listeners: ChangeListeners,
}

pub static COMPUTER_SERVICE: LazyLock<ComputerService> = LazyLock::new(ComputerService::new);

impl ComputerService {
    /// The service with the runtime's own session, whose opener brings up an
    /// `AgentComputer` with its sound going to every viewer of `COMPUTER_SERVICE.local`.
    pub fn new() -> Self {
        todo!()
    }

    /// Pass the session's changes on as the service's own.
    fn track(session: Arc<ComputerSession>) -> Arc<ComputerSession> {
        todo!()
    }

    pub fn on_change(&self, listener: ChangeListener) -> u64 {
        self.listeners.on(listener)
    }

    pub fn off_change(&self, id: u64) {
        self.listeners.off(id)
    }

    pub fn emit_change(&self) {
        self.listeners.emit()
    }

    /// The runtime's own desktop, up, as the `AgentComputer` it is.
    pub async fn open_local(&self) -> anyhow::Result<Arc<AgentComputer>> {
        todo!()
    }

    /// The runtime's own desktop, or a registered remote computer.
    pub fn session(&self, id: &str) -> Option<Arc<ComputerSession>> {
        todo!()
    }

    /// Every session, the runtime's own first.
    pub fn sessions(&self) -> Vec<Arc<ComputerSession>> {
        todo!()
    }

    pub fn create_use(
        &self,
        caller: ComputerCaller,
        signal: Option<&CancellationToken>,
    ) -> Arc<ComputerUse> {
        self.local.access.create(caller, signal)
    }

    /// The invocation ended: every computer it held or waited for is free.
    pub fn finish(&self, use_: &ComputerUse) {
        todo!()
    }

    pub fn yield_use(&self, use_: &ComputerUse) {
        todo!()
    }

    /// The computer a tool call names, or the run's default: the runtime's own when it has
    /// one, else the only remote computer. Fails, with a message for the model, otherwise.
    pub fn resolve(
        &self,
        use_: &ComputerUse,
        name: Option<&str>,
    ) -> anyhow::Result<Arc<ComputerSession>> {
        todo!()
    }

    /// Run `action` on the computer a tool call names, as the invocation `use_`.
    pub async fn act<T, F, Fut>(
        &self,
        use_: &Arc<ComputerUse>,
        session: &Arc<ComputerSession>,
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

    /// The computer an invocation used last, which its help requests are about; before it
    /// has used one, the computer a call that names none would use.
    pub fn current(&self, use_: &ComputerUse) -> Arc<ComputerSession> {
        todo!()
    }

    /// A remote computer's link came up. A link already open for it is replaced, and ends
    /// the way a dropped link ends, the hold it took included.
    pub fn linked(&self, id: &str, computer: Arc<RemoteComputer>, link: Arc<ComputerLink>) {
        todo!()
    }

    /// Whether `computer` is the one linked for `id` right now.
    pub fn is_linked(&self, id: &str, computer: &Arc<RemoteComputer>) -> bool {
        self.links
            .lock()
            .get(id)
            .is_some_and(|linked| Arc::ptr_eq(&linked.computer, computer))
    }

    pub fn unlinked(&self, id: &str, computer: &Arc<RemoteComputer>) {
        todo!()
    }

    /// Remove a remote computer: its link closes, and the runs holding or waiting for it are
    /// told so at their next step. False when there was no such computer.
    pub async fn remove(&self, id: &str, user_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    pub fn summaries(&self) -> Vec<ComputerSummary> {
        todo!()
    }

    /// The computers line of a turn's notices, for a run that may use a remote computer
    /// while any exists. It changes with every connection, so it never goes in the cached
    /// prompt.
    pub fn notice(&self, mode: &str) -> Option<String> {
        todo!()
    }

    pub async fn close(&self) {
        todo!()
    }

    fn names(&self) -> String {
        todo!()
    }

    fn use_of(&self, session: &ComputerSession) -> (Option<ComputerOwner>, Option<Controller>) {
        todo!()
    }
}
