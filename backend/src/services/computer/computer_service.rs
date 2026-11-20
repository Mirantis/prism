//! Every computer the agent has: the runtime's own desktop and the remote computers, each
//! a `ComputerSession`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, OnceLock, Weak};

use bytes::Bytes;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::agent_computer::{AgentComputer, ModelChannel};
use super::computer::Computer;
use super::computer_access::{
    ChangeListener, ChangeListeners, ComputerCaller, ComputerKind, ComputerUse,
};
use super::computer_session::{ComputerOpener, ComputerSession, Controller};
use super::remote::computer_link::ComputerLink;
use super::remote::link_protocol::{CAPABILITIES, CapabilityProblem, LINK_CLOSE};
use super::remote::remote_computer::RemoteComputer;
use super::remote::remote_computer_service::REMOTE_COMPUTER_SERVICE;
use super::screen_size::{DEFAULT_SCREEN, ScreenSize};
use super::supported::{has_computer, uses_remote_computers};
use crate::support::iso;

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

/// `JSON.stringify` of a name.
fn quoted(name: &str) -> String {
    serde_json::to_string(name).expect("a string serializes")
}

/// Bring up the runtime's own desktop with its sound going to `on_audio`; a computer that
/// fails to open is stopped before the failure is passed on.
async fn open_local(
    on_audio: Arc<dyn Fn(Bytes) + Send + Sync>,
) -> anyhow::Result<Arc<AgentComputer>> {
    let computer = Arc::new(AgentComputer::new());
    let opened = computer.open_browser(Some(DEFAULT_SCREEN)).await;
    if let Err(err) = opened {
        let _ = computer.stop().await;
        return Err(err);
    }
    computer.start_browser_audio(on_audio);
    Ok(computer)
}

/// A remote computer's open link.
struct LinkedComputer {
    computer: Arc<RemoteComputer>,
    link: Arc<ComputerLink>,
}

fn as_computer(computer: &Arc<RemoteComputer>) -> Arc<dyn Computer> {
    computer.clone()
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
    listeners: Arc<ChangeListeners>,
}

pub static COMPUTER_SERVICE: LazyLock<ComputerService> = LazyLock::new(ComputerService::new);

impl ComputerService {
    /// The service with the runtime's own session, whose opener brings up an
    /// `AgentComputer` with its sound going to every viewer of that session.
    pub fn new() -> Self {
        let listeners = Arc::new(ChangeListeners::new());
        let session_cell: Arc<OnceLock<Weak<ComputerSession>>> = Arc::new(OnceLock::new());
        let cell = session_cell.clone();
        let opener: ComputerOpener = Arc::new(move || {
            let cell = cell.clone();
            Box::pin(async move {
                let on_audio: Arc<dyn Fn(Bytes) + Send + Sync> = Arc::new(move |pcm: Bytes| {
                    if let Some(session) = cell.get().and_then(Weak::upgrade) {
                        session.broadcast_audio(pcm);
                    }
                });
                let computer: Arc<dyn Computer> = open_local(on_audio).await?;
                Ok(computer)
            })
        });
        let local =
            ComputerSession::new(LOCAL_COMPUTER_ID.to_string(), ComputerKind::Local, opener);
        let _ = session_cell.set(Arc::downgrade(&local));
        ComputerService {
            local: Self::track(&listeners, local),
            remotes: Mutex::new(HashMap::new()),
            links: Mutex::new(HashMap::new()),
            listeners,
        }
    }

    /// Pass the session's changes on as the service's own.
    fn track(
        listeners: &Arc<ChangeListeners>,
        session: Arc<ComputerSession>,
    ) -> Arc<ComputerSession> {
        let listeners = listeners.clone();
        session.access.on_change(Arc::new(move || listeners.emit()));
        session
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
        let computer = self.local.open().await?;
        computer
            .into_any()
            .downcast::<AgentComputer>()
            .map_err(|_| anyhow::anyhow!("The runtime's own computer is not its desktop."))
    }

    /// The runtime's own desktop, or a registered remote computer.
    pub fn session(&self, id: &str) -> Option<Arc<ComputerSession>> {
        if id == LOCAL_COMPUTER_ID {
            return Some(self.local.clone());
        }
        let row = REMOTE_COMPUTER_SERVICE.get(id)?;
        let mut remotes = self.remotes.lock();
        if let Some(session) = remotes.get(id) {
            return Some(session.clone());
        }
        let computer_id = id.to_string();
        let row_name = row.name.clone();
        let opener: ComputerOpener = Arc::new(move || {
            let computer_id = computer_id.clone();
            let row_name = row_name.clone();
            Box::pin(async move {
                let name = REMOTE_COMPUTER_SERVICE
                    .get(&computer_id)
                    .map(|row| row.name)
                    .unwrap_or(row_name);
                Err(anyhow::anyhow!(
                    "{name} is not connected. Ask your user to start the computer client on it."
                ))
            })
        });
        let session = Self::track(
            &self.listeners,
            ComputerSession::new(id.to_string(), ComputerKind::Remote, opener),
        );
        remotes.insert(id.to_string(), session.clone());
        Some(session)
    }

    /// Every session, the runtime's own first.
    pub fn sessions(&self) -> Vec<Arc<ComputerSession>> {
        let mut sessions = vec![self.local.clone()];
        for row in REMOTE_COMPUTER_SERVICE.list() {
            if let Some(session) = self.session(&row.id) {
                sessions.push(session);
            }
        }
        sessions
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
        for session in self.sessions() {
            if !Arc::ptr_eq(&session, &self.local) && session.access.holds(use_) {
                session.access.yield_use(use_);
            }
        }
        self.local.access.finish(use_);
    }

    pub fn yield_use(&self, use_: &ComputerUse) {
        for session in self.sessions() {
            if session.access.holds(use_) {
                session.access.yield_use(use_);
            }
        }
    }

    /// The computer a tool call names, or the run's default: the runtime's own when it has
    /// one, else the only remote computer. Fails, with a message for the model, otherwise.
    pub fn resolve(
        &self,
        use_: &ComputerUse,
        name: Option<&str>,
    ) -> anyhow::Result<Arc<ComputerSession>> {
        let remote = uses_remote_computers(&use_.mode);
        let wanted = name
            .map(|name| crate::support::js::trim(name).to_lowercase())
            .filter(|wanted| !wanted.is_empty());
        let Some(wanted) = wanted else {
            if has_computer() {
                return Ok(self.local.clone());
            }
            let rows = if remote {
                REMOTE_COMPUTER_SERVICE.list()
            } else {
                Vec::new()
            };
            if rows.len() == 1 {
                return self
                    .session(&rows[0].id)
                    .ok_or_else(|| anyhow::anyhow!("There is no computer in this run."));
            }
            if rows.len() > 1 {
                anyhow::bail!("Name the computer to use: {}.", self.names());
            }
            anyhow::bail!("There is no computer in this run.");
        };
        if wanted == LOCAL_COMPUTER_ID && has_computer() {
            return Ok(self.local.clone());
        }
        if !remote {
            anyhow::bail!(
                "Only your own computer is available in a {} run.",
                use_.mode
            );
        }
        let name = name.unwrap_or_default();
        let trimmed = crate::support::js::trim(name);
        let row = REMOTE_COMPUTER_SERVICE
            .list()
            .into_iter()
            .find(|item| item.id == trimmed || item.name.to_lowercase() == wanted);
        let Some(row) = row else {
            anyhow::bail!(
                "There is no computer named {}. The computers are: {}.",
                quoted(name),
                self.names()
            );
        };
        self.session(&row.id)
            .ok_or_else(|| anyhow::anyhow!("There is no computer named {}.", quoted(name)))
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
        let moved = use_.computer_id.lock().as_deref() != Some(session.id.as_str());
        if moved {
            for other in self.sessions() {
                if !Arc::ptr_eq(&other, session) && other.access.holds(use_) {
                    other.access.yield_use(use_);
                }
            }
            *use_.computer_id.lock() = Some(session.id.clone());
        }
        session.act(use_, action, channel, inspection).await
    }

    /// The computer an invocation used last, which its help requests are about; before it
    /// has used one, the computer a call that names none would use.
    pub fn current(&self, use_: &ComputerUse) -> Arc<ComputerSession> {
        let used = use_.computer_id.lock().clone();
        if let Some(session) = used.and_then(|id| self.session(&id)) {
            return session;
        }
        self.resolve(use_, None)
            .unwrap_or_else(|_| self.local.clone())
    }

    /// A remote computer's link came up. A link already open for it is replaced, and ends
    /// the way a dropped link ends, the hold it took included.
    pub fn linked(&self, id: &str, computer: Arc<RemoteComputer>, link: Arc<ComputerLink>) {
        let previous = self.links.lock().insert(
            id.to_string(),
            LinkedComputer {
                computer: computer.clone(),
                link,
            },
        );
        if let Some(previous) = previous {
            previous
                .link
                .close(LINK_CLOSE.replaced, "replaced by a newer link");
            if let Some(session) = self.session(id) {
                session.lost(&as_computer(&previous.computer));
            }
        }
        if let Some(session) = self.session(id) {
            session.connected(as_computer(&computer));
        }
        self.emit_change();
    }

    /// Whether `computer` is the one linked for `id` right now.
    pub fn is_linked(&self, id: &str, computer: &Arc<RemoteComputer>) -> bool {
        self.links
            .lock()
            .get(id)
            .is_some_and(|linked| Arc::ptr_eq(&linked.computer, computer))
    }

    pub fn unlinked(&self, id: &str, computer: &Arc<RemoteComputer>) {
        {
            let mut links = self.links.lock();
            if !links
                .get(id)
                .is_some_and(|linked| Arc::ptr_eq(&linked.computer, computer))
            {
                return;
            }
            links.remove(id);
        }
        let session = self.remotes.lock().get(id).cloned();
        if let Some(session) = session {
            session.lost(&as_computer(computer));
        }
        self.emit_change();
    }

    /// Remove a remote computer: its link closes, and the runs holding or waiting for it are
    /// told so at their next step. False when there was no such computer.
    pub async fn remove(&self, id: &str, user_id: &str) -> anyhow::Result<bool> {
        let name = REMOTE_COMPUTER_SERVICE.get(id).map(|row| row.name);
        if !REMOTE_COMPUTER_SERVICE.remove(id, user_id).await? {
            return Ok(false);
        }
        let linked = self.links.lock().remove(id);
        let session = self.remotes.lock().remove(id);
        // The link's close handler finds the link gone and does nothing, so its end runs
        // here: whatever the person at the computer held, and any secure window, end with
        // it.
        if let (Some(linked), Some(session)) = (&linked, &session) {
            session.lost(&as_computer(&linked.computer));
        }
        if let Some(session) = &session {
            session
                .access
                .retire(format!(
                    "{} was removed.",
                    name.as_deref().unwrap_or("That computer")
                ))
                .await;
        }
        if let Some(linked) = linked {
            linked.link.close(LINK_CLOSE.removed, "computer removed");
            linked.computer.stop().await?;
        }
        self.emit_change();
        Ok(true)
    }

    pub fn summaries(&self) -> Vec<ComputerSummary> {
        let mut list = Vec::new();
        if has_computer() {
            let (owner, controller) = self.use_of(&self.local);
            list.push(ComputerSummary {
                id: LOCAL_COMPUTER_ID.to_string(),
                kind: ComputerKind::Local,
                name: "This runtime".to_string(),
                connection: ComputerConnection::Connected,
                platform: Some("linux".to_string()),
                client_version: None,
                display: Some(DEFAULT_SCREEN),
                capabilities: CAPABILITIES
                    .iter()
                    .map(|capability| capability.as_str().to_string())
                    .collect(),
                problems: Vec::new(),
                last_connected_at: None,
                last_seen_at: None,
                owner,
                controller,
            });
        }
        for row in REMOTE_COMPUTER_SERVICE.list() {
            let Some(session) = self.session(&row.id) else {
                continue;
            };
            let info = self
                .links
                .lock()
                .get(&row.id)
                .map(|linked| linked.computer.clone());
            let info = info.map(|computer| computer.info());
            let (owner, controller) = self.use_of(&session);
            list.push(ComputerSummary {
                id: row.id.clone(),
                kind: ComputerKind::Remote,
                name: row.name.clone(),
                connection: if info.is_some() {
                    ComputerConnection::Connected
                } else {
                    ComputerConnection::Disconnected
                },
                platform: info
                    .as_ref()
                    .map(|info| info.platform.as_str().to_string())
                    .or(row.platform.clone()),
                client_version: info
                    .as_ref()
                    .map(|info| info.client_version.clone())
                    .or(row.client_version.clone()),
                display: info.as_ref().map(|info| info.display),
                capabilities: info
                    .as_ref()
                    .map(|info| {
                        info.capabilities
                            .iter()
                            .map(|capability| capability.as_str().to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
                problems: info
                    .as_ref()
                    .map(|info| info.problems.clone())
                    .unwrap_or_default(),
                last_connected_at: row.last_connected_at.as_ref().map(iso),
                last_seen_at: row.last_seen_at.as_ref().map(iso),
                owner,
                controller,
            });
        }
        list
    }

    /// The computers line of a turn's notices, for a run that may use a remote computer
    /// while any exists. It changes with every connection, so it never goes in the cached
    /// prompt.
    pub fn notice(&self, mode: &str) -> Option<String> {
        if !uses_remote_computers(mode) || REMOTE_COMPUTER_SERVICE.count() == 0 {
            return None;
        }
        let rows = REMOTE_COMPUTER_SERVICE.list();
        let mut parts: Vec<String> = Vec::new();
        if has_computer() {
            parts.push("\"local\" (your own computer)".to_string());
        }
        for row in &rows {
            let info = self
                .links
                .lock()
                .get(&row.id)
                .map(|linked| linked.computer.clone())
                .map(|computer| computer.info());
            let platform = info
                .as_ref()
                .map(|info| info.platform.as_str().to_string())
                .or(row.platform.clone())
                .filter(|platform| !platform.is_empty());
            let mut traits: Vec<String> = Vec::new();
            if let Some(platform) = &platform {
                traits.push(
                    platform_name(platform)
                        .map(str::to_string)
                        .unwrap_or_else(|| platform.clone()),
                );
            }
            traits.push(
                if info.is_some() {
                    "connected"
                } else {
                    "not connected"
                }
                .to_string(),
            );
            if let Some(key) = platform.as_deref().and_then(super_key) {
                traits.push(key.to_string());
            }
            parts.push(format!("{} ({})", quoted(&row.name), traits.join(", ")));
        }
        let fallback = if has_computer() {
            Some("your own computer".to_string())
        } else if rows.len() == 1 {
            Some(quoted(&rows[0].name))
        } else {
            None
        };
        Some(format!(
            "Computers you can use: {}. A remote computer is your user's own machine. Pass its name as `computer` to use it; {}",
            parts.join("; "),
            match fallback {
                Some(fallback) => format!("without one, the computer tools use {fallback}."),
                None => "every computer tool call needs one.".to_string(),
            }
        ))
    }

    pub async fn close(&self) {
        let links: Vec<LinkedComputer> = self.links.lock().drain().map(|(_, l)| l).collect();
        for linked in &links {
            linked
                .link
                .close(LINK_CLOSE.shutting_down, "runtime shutting down");
        }
        let remotes: Vec<Arc<ComputerSession>> = self.remotes.lock().values().cloned().collect();
        futures::future::join_all(remotes.iter().map(|session| session.close())).await;
        self.local.close().await;
    }

    fn names(&self) -> String {
        let mut names = Vec::new();
        if has_computer() {
            names.push(format!("\"{LOCAL_COMPUTER_ID}\""));
        }
        for row in REMOTE_COMPUTER_SERVICE.list() {
            names.push(quoted(&row.name));
        }
        names.join(", ")
    }

    fn use_of(&self, session: &ComputerSession) -> (Option<ComputerOwner>, Option<Controller>) {
        let owner = session.access.owner().map(|owner| ComputerOwner {
            thread_id: owner.thread_id.clone(),
            mode: owner.mode.clone(),
        });
        (owner, session.controller())
    }
}

impl Default for ComputerService {
    fn default() -> Self {
        ComputerService::new()
    }
}
