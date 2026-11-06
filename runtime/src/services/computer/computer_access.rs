//! Invocation ownership and human takeover of one computer.

use std::future::Future;
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::services::channel_adapter_interface::ChannelName;

/// The runtime's own desktop, or a computer that links in from outside.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerKind {
    Local,
    Remote,
}

impl ComputerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ComputerKind::Local => "local",
            ComputerKind::Remote => "remote",
        }
    }
}

/// What a call is told when its invocation went to another computer while it waited.
const MOVED: &str = "This invocation moved to another computer before this call got its turn. Call it again if you still need it.";

/// A `change` listener.
pub type ChangeListener = Arc<dyn Fn() + Send + Sync>;

/// The `change` listeners of an emitter, called in the order they were added.
#[derive(Default)]
pub struct ChangeListeners {
    next: AtomicU64,
    list: Mutex<Vec<(u64, ChangeListener)>>,
}

impl ChangeListeners {
    pub fn new() -> Self {
        ChangeListeners::default()
    }

    /// Add a listener; the number it answers takes it off again.
    pub fn on(&self, listener: ChangeListener) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.list.lock().push((id, listener));
        id
    }

    pub fn off(&self, id: u64) {
        self.list.lock().retain(|(item, _)| *item != id);
    }

    /// Call every listener added before this call, outside the lock.
    pub fn emit(&self) {
        let listeners: Vec<ChangeListener> = self
            .list
            .lock()
            .iter()
            .map(|(_, listener)| listener.clone())
            .collect();
        for listener in listeners {
            listener();
        }
    }
}

/// Who runs an invocation, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerCaller {
    pub user_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel: Option<ChannelName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_channel_id: Option<String>,
}

/// Runs a wait with the invocation's conversation shown idle. The invocation sets it; a
/// caller waiting for a value sends it out of the future it hands over.
pub type IdleWrapper = Arc<dyn Fn(BoxFuture<'static, ()>) -> BoxFuture<'static, ()> + Send + Sync>;

/// One invocation's use of the computers. Shared as `Arc<ComputerUse>`; two uses are the
/// same when their `id`s are.
pub struct ComputerUse {
    pub caller: ComputerCaller,
    pub id: String,
    /// Ends the use. Cancelling it cancels `signal`.
    pub controller: CancellationToken,
    /// Cancelled when the invocation's own signal is, or by `controller`.
    pub signal: CancellationToken,
    /// When the use first asked for a computer, in epoch milliseconds.
    pub started_at: Mutex<Option<i64>>,
    /// The kind of the first computer this invocation waited for, for its telemetry.
    pub kind: Mutex<Option<ComputerKind>>,
    /// The computer this invocation used last, which its help requests are about.
    pub computer_id: Mutex<Option<String>>,
    pub failed: AtomicBool,
    pub closed: AtomicBool,
    /// Runs a wait with the invocation's conversation shown idle. The invocation sets it.
    pub idle: Mutex<Option<IdleWrapper>>,
}

impl Deref for ComputerUse {
    type Target = ComputerCaller;

    fn deref(&self) -> &ComputerCaller {
        &self.caller
    }
}

impl std::fmt::Debug for ComputerUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComputerUse")
            .field("id", &self.id)
            .field("caller", &self.caller)
            .finish_non_exhaustive()
    }
}

/// The takeover that answers a help request, while it lasts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SecureWindow {
    client_id: String,
    help_id: String,
    started_at: i64,
    /// Set while the desktop is being cleared, which is still inside the window.
    ending: bool,
}

/// How a secure window ended, for its telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecureExit {
    HandedBack,
    Disconnected,
    Removed,
}

impl SecureExit {
    pub fn as_str(self) -> &'static str {
        match self {
            SecureExit::HandedBack => "handed_back",
            SecureExit::Disconnected => "disconnected",
            SecureExit::Removed => "removed",
        }
    }
}

struct AccessState {
    owner: Option<Arc<ComputerUse>>,
    paused: bool,
    human: Option<String>,
    claimant: Option<String>,
    queue: Vec<Arc<ComputerUse>>,
    /// Set once the computer is gone for good; see `retire`. The message every later call
    /// fails with.
    retired: Option<String>,
    secure_window: Option<SecureWindow>,
}

/// What the desktop must forget before the agent runs again.
pub type ClearSecrets = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>;

static NEXT_ACCESS: AtomicU64 = AtomicU64::new(1);

/// Invocation ownership and human takeover share one gate for the desktop.
pub struct ComputerAccess {
    /// This gate's identity, as the secure guard counts its holders.
    holder: u64,
    clear_secrets: Option<ClearSecrets>,
    kind: ComputerKind,
    state: Mutex<AccessState>,
    /// Actions run one at a time, in arrival order: one model step may call several tools.
    tail: tokio::sync::Mutex<()>,
    /// Wakes every waiter on each `change`.
    changed: Notify,
    listeners: ChangeListeners,
}

impl ComputerAccess {
    /// `clear_secrets` is what the desktop must forget before the agent runs again.
    pub fn new(clear_secrets: Option<ClearSecrets>, kind: ComputerKind) -> Self {
        ComputerAccess {
            holder: NEXT_ACCESS.fetch_add(1, Ordering::Relaxed),
            clear_secrets,
            kind,
            state: Mutex::new(AccessState {
                owner: None,
                paused: false,
                human: None,
                claimant: None,
                queue: Vec::new(),
                retired: None,
                secure_window: None,
            }),
            tail: tokio::sync::Mutex::new(()),
            changed: Notify::new(),
            listeners: ChangeListeners::new(),
        }
    }

    /// The invocation that holds the computer.
    pub fn owner(&self) -> Option<Arc<ComputerUse>> {
        self.state.lock().owner.clone()
    }

    pub fn paused(&self) -> bool {
        self.state.lock().paused
    }

    /// The client that holds the mouse and keyboard: a viewer's id, `local`, or a sign-in.
    pub fn human(&self) -> Option<String> {
        self.state.lock().human.clone()
    }

    /// Whether a person is answering a help request at the keyboard right now.
    ///
    /// For as long as this holds, the runtime calls no model, the agent's own
    /// processes are stopped, and the computer tools inspect nothing.
    pub fn secure(&self) -> bool {
        self.state.lock().secure_window.is_some()
    }

    /// A new use for `caller`, ended by `signal` too when one is given.
    pub fn create(
        &self,
        caller: ComputerCaller,
        signal: Option<&CancellationToken>,
    ) -> Arc<ComputerUse> {
        todo!()
    }

    /// The invocations waiting for the computer, in order.
    pub fn waiting(&self) -> Vec<Arc<ComputerUse>> {
        self.state.lock().queue.clone()
    }

    pub fn on_change(&self, listener: ChangeListener) -> u64 {
        self.listeners.on(listener)
    }

    pub fn off_change(&self, id: u64) {
        self.listeners.off(id)
    }

    /// Tell the listeners and every waiter that something changed.
    pub fn emit_change(&self) {
        self.listeners.emit();
        self.changed.notify_waiters();
    }

    /// Wait for the next change. Fails with the signal's reason when it is cancelled first.
    async fn wait(&self, signal: &CancellationToken) -> anyhow::Result<()> {
        todo!()
    }

    /// End this computer for good: the invocation holding it and every one waiting for it
    /// get `error` at their next step, and so does anybody who asks later. Their turns go on.
    /// A takeover ends with it, and so does its secure window, since nobody can hand back a
    /// computer that no longer exists.
    pub async fn retire(&self, error: String) {
        todo!()
    }

    pub async fn acquire(&self, use_: &Arc<ComputerUse>) -> anyhow::Result<()> {
        todo!()
    }

    /// Serialize actions as well as owners: one model step may call several tools. The
    /// action runs once, when the use holds the computer, it is not paused, and the actions
    /// before it are done; an `inspection` runs without holding it and while it is paused.
    pub async fn run<T, F, Fut>(
        &self,
        use_: &Arc<ComputerUse>,
        action: F,
        inspection: bool,
    ) -> anyhow::Result<T>
    where
        F: FnOnce() -> Fut + Send,
        Fut: Future<Output = anyhow::Result<T>> + Send,
        T: Send,
    {
        todo!()
    }

    /// A takeover naming a help request is secure; see `secure`. Fails with `Another viewer
    /// has control.`
    pub async fn take_control(&self, client_id: &str, help_id: Option<&str>) -> anyhow::Result<()> {
        todo!()
    }

    /// A sign-in the runtime types for the user: the same window a takeover opens, bounded
    /// by the typing rather than by a person at the keyboard.
    ///
    /// The desktop is taken first, so the agent's own actions stop and the one in flight is
    /// drained before a field is touched, and given back afterwards, which is what clears
    /// any password the page was left holding. The username can stay on the page, as the
    /// site itself shows it again after a rejected sign-in.
    pub async fn run_secure<T, Fut>(&self, help_id: &str, action: Fut) -> anyhow::Result<T>
    where
        Fut: Future<Output = anyhow::Result<T>> + Send,
        T: Send,
    {
        todo!()
    }

    fn begin_secure(&self, client_id: &str, help_id: &str) {
        todo!()
    }

    /// Close the window, in this order: forget what was typed, let the agent's
    /// processes run, then let it call a model again. A failure to clear still opens
    /// the gate — a runtime that never infers again is the worse outcome — and says so.
    ///
    /// `secure` holds until the clearing is done. The password fields are still filled
    /// while it runs, so this is the part of the window the screen tools must miss.
    pub async fn end_secure(&self, exit: SecureExit) {
        todo!()
    }

    /// Fails with `Another viewer has control.` when another client has or claims control.
    pub fn assert_can_hand_back(&self, client_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    pub async fn hand_back(&self, client_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// A viewer that goes away keeps the desktop paused for its return, but ends its
    /// secure window: nobody is typing, and the runtime would otherwise never infer again.
    pub fn disconnected(&self, client_id: &str) {
        todo!()
    }

    /// Whether `use_` holds this computer or waits for it.
    pub fn holds(&self, use_: &ComputerUse) -> bool {
        let state = self.state.lock();
        state
            .owner
            .as_ref()
            .is_some_and(|owner| owner.id == use_.id)
            || state.queue.iter().any(|item| item.id == use_.id)
    }

    pub fn yield_use(&self, use_: &ComputerUse) {
        todo!()
    }

    pub fn finish(&self, use_: &ComputerUse) {
        todo!()
    }

    pub fn stop(&self) {
        todo!()
    }
}
