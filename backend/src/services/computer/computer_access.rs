//! Invocation ownership and human takeover of one computer.

use std::future::Future;
use std::ops::Deref;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};

use futures::future::BoxFuture;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::futures::Notified;
use tokio_util::sync::CancellationToken;

use super::secure_guard::{hold_secure_guard, release_secure_guard};
use crate::ai::AbortError;
use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::{agent_props, track_event};
use crate::log_error;
use crate::services::channel_adapter_interface::ChannelName;
use crate::support::now_ms;

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

/// What a viewer is told when another one holds or claims the computer.
const ANOTHER_VIEWER: &str = "Another viewer has control.";

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
    /// This window's identity: a window that replaces one is another window even when
    /// it reads the same.
    number: u64,
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
    next_window: u64,
}

/// What the desktop must forget before the agent runs again.
pub type ClearSecrets = Arc<dyn Fn() -> BoxFuture<'static, anyhow::Result<()>> + Send + Sync>;

static NEXT_ACCESS: AtomicU64 = AtomicU64::new(1);

/// The error an aborted signal reads as.
fn aborted() -> anyhow::Error {
    AbortError::operation().into()
}

fn same(a: &ComputerUse, b: &ComputerUse) -> bool {
    a.id == b.id
}

/// Invocation ownership and human takeover share one gate for the desktop.
pub struct ComputerAccess {
    /// This gate, for the window a disconnect ends in the background.
    me: Weak<ComputerAccess>,
    /// This gate's identity; with a window's number, the key it holds the secure guard by.
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
    pub fn new(clear_secrets: Option<ClearSecrets>, kind: ComputerKind) -> Arc<Self> {
        Arc::new_cyclic(|me| ComputerAccess {
            me: me.clone(),
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
                next_window: 1,
            }),
            tail: tokio::sync::Mutex::new(()),
            changed: Notify::new(),
            listeners: ChangeListeners::new(),
        })
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
        let controller = CancellationToken::new();
        let own = controller.child_token();
        if let Some(outer) = signal {
            if outer.is_cancelled() {
                own.cancel();
            } else if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let outer = outer.clone();
                let linked = own.clone();
                runtime.spawn(async move {
                    tokio::select! {
                        _ = outer.cancelled() => linked.cancel(),
                        _ = linked.cancelled() => {}
                    }
                });
            }
        }
        Arc::new(ComputerUse {
            caller,
            id: uuid::Uuid::new_v4().to_string(),
            controller,
            signal: own,
            started_at: Mutex::new(None),
            kind: Mutex::new(None),
            computer_id: Mutex::new(None),
            failed: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            idle: Mutex::new(None),
        })
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
        self.changed.notify_waiters();
        self.listeners.emit();
    }

    /// A wait for the next change, listening from now on, so a change that lands between
    /// a check and the wait is not missed.
    fn next_change(&self) -> Pin<Box<Notified<'_>>> {
        let mut notified = Box::pin(self.changed.notified());
        notified.as_mut().enable();
        notified
    }

    /// Wait for the change `next` listens for. Fails with the signal's reason when it is
    /// cancelled first.
    async fn wait(
        &self,
        next: Pin<Box<Notified<'_>>>,
        signal: &CancellationToken,
    ) -> anyhow::Result<()> {
        if signal.is_cancelled() {
            return Err(aborted());
        }
        tokio::select! {
            _ = next => Ok(()),
            _ = signal.cancelled() => Err(aborted()),
        }
    }

    /// End this computer for good: the invocation holding it and every one waiting for it
    /// get `error` at their next step, and so does anybody who asks later. Their turns go on.
    /// A takeover ends with it, and so does its secure window, since nobody can hand back a
    /// computer that no longer exists.
    pub async fn retire(&self, error: String) {
        {
            let mut state = self.state.lock();
            state.retired = Some(error);
            state.owner = None;
            state.human = None;
            state.claimant = None;
            state.paused = false;
        }
        self.emit_change();
        self.end_secure(SecureExit::Removed).await;
    }

    fn retired(&self) -> Option<anyhow::Error> {
        self.state
            .lock()
            .retired
            .as_ref()
            .map(|message| anyhow::anyhow!("{message}"))
    }

    pub async fn acquire(&self, use_: &Arc<ComputerUse>) -> anyhow::Result<()> {
        if use_.signal.is_cancelled() {
            return Err(aborted());
        }
        if let Some(retired) = self.retired() {
            return Err(retired);
        }
        if use_.closed.load(Ordering::SeqCst) {
            anyhow::bail!("This computer invocation has ended.");
        }
        if self.owner().is_some_and(|owner| same(&owner, use_)) {
            return Ok(());
        }
        let first = {
            let mut started = use_.started_at.lock();
            if started.is_none() {
                *started = Some(now_ms());
                *use_.kind.lock() = Some(self.kind);
                true
            } else {
                false
            }
        };
        if first {
            track_event(
                "computer use started",
                Some(&use_.user_id),
                Some(IndexMap::from([
                    ("agent.id".to_string(), use_.agent_id.clone()),
                    ("computer.use_id".to_string(), use_.id.clone()),
                    ("computer.kind".to_string(), self.kind.as_str().to_string()),
                    ("mode".to_string(), use_.mode.clone()),
                ])),
            );
        }
        let queued = {
            let mut state = self.state.lock();
            if state.queue.iter().any(|item| same(item, use_)) {
                false
            } else {
                state.queue.push(use_.clone());
                true
            }
        };
        if queued {
            self.emit_change();
        }
        let result = self.wait_for_turn(use_).await;
        if result.is_err() {
            self.state.lock().queue.retain(|item| !same(item, use_));
            self.emit_change();
        }
        result
    }

    /// Wait until `use_` is first in the queue of a computer nobody holds or pauses, and
    /// take it.
    async fn wait_for_turn(&self, use_: &Arc<ComputerUse>) -> anyhow::Result<()> {
        loop {
            let next = self.next_change();
            {
                let state = self.state.lock();
                let first = state.queue.first().is_some_and(|item| same(item, use_));
                if state.owner.is_none() && first && !state.paused {
                    break;
                }
                if state.owner.as_ref().is_some_and(|owner| same(owner, use_)) {
                    return Ok(());
                }
            }
            self.wait(next, &use_.signal).await?;
            if let Some(retired) = self.retired() {
                return Err(retired);
            }
            // Taken out of the queue while it waited: another call of the same invocation
            // moved it to another computer, and nothing would put it back.
            let state = self.state.lock();
            let queued = state.queue.iter().any(|item| same(item, use_));
            let owns = state.owner.as_ref().is_some_and(|owner| same(owner, use_));
            if !queued && !owns {
                anyhow::bail!(MOVED);
            }
        }
        if use_.signal.is_cancelled() {
            return Err(aborted());
        }
        {
            let mut state = self.state.lock();
            if !state.queue.is_empty() {
                state.queue.remove(0);
            }
            state.owner = Some(use_.clone());
        }
        self.emit_change();
        Ok(())
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
        if !inspection {
            self.acquire(use_).await?;
        }
        let mut action = Some(action);
        loop {
            if use_.signal.is_cancelled() {
                return Err(aborted());
            }
            if let Some(retired) = self.retired() {
                return Err(retired);
            }
            if !inspection && !self.owner().is_some_and(|owner| same(&owner, use_)) {
                self.acquire(use_).await?;
            }
            let next = self.next_change();
            if !inspection && self.paused() {
                self.wait(next, &use_.signal).await?;
                continue;
            }
            drop(next);
            let turn = self.tail.lock().await;
            if use_.signal.is_cancelled() {
                return Err(aborted());
            }
            let retry = !inspection
                && (self.paused() || !self.owner().is_some_and(|owner| same(&owner, use_)));
            if retry {
                drop(turn);
                continue;
            }
            let run = action.take().expect("an action runs once");
            let value = run().await;
            drop(turn);
            return value;
        }
    }

    /// A takeover naming a help request is secure; see `secure`. Fails with `Another viewer
    /// has control.`
    pub async fn take_control(&self, client_id: &str, help_id: Option<&str>) -> anyhow::Result<()> {
        {
            let mut state = self.state.lock();
            let other_human = state
                .human
                .as_deref()
                .is_some_and(|human| human != client_id);
            let other_claimant = state
                .claimant
                .as_deref()
                .is_some_and(|claimant| claimant != client_id);
            if other_human || other_claimant {
                anyhow::bail!(ANOTHER_VIEWER);
            }
            state.paused = true;
            state.claimant = Some(client_id.to_string());
        }
        self.emit_change();
        drop(self.tail.lock().await);
        {
            let mut state = self.state.lock();
            if state.claimant.as_deref() != Some(client_id) {
                return Ok(());
            }
            state.human = Some(client_id.to_string());
            state.claimant = None;
        }
        // The window opens where the keyboard becomes theirs: `ComputerSession::input`
        // passes a frame on only once `human` is this client.
        if let Some(help_id) = help_id {
            self.begin_secure(client_id, help_id);
        }
        self.emit_change();
        Ok(())
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
        let client_id = format!("sign-in:{help_id}");
        self.take_control(&client_id, Some(help_id)).await?;
        // A viewer that claimed the desktop while this waited holds it now. Typing into a
        // screen somebody else has their hands on is the one thing not to do.
        if self.human().as_deref() != Some(client_id.as_str()) {
            anyhow::bail!(ANOTHER_VIEWER);
        }
        let result = action.await;
        if self.human().as_deref() == Some(client_id.as_str()) {
            self.hand_back(&client_id).await?;
        }
        result
    }

    fn begin_secure(&self, client_id: &str, help_id: &str) {
        {
            let mut state = self.state.lock();
            // A window that is clearing up is replaced rather than joined. The new one
            // holds the guard under its own number, so the one ending cannot free it.
            if state
                .secure_window
                .as_ref()
                .is_some_and(|window| !window.ending)
            {
                return;
            }
            let number = state.next_window;
            state.next_window += 1;
            state.secure_window = Some(SecureWindow {
                number,
                client_id: client_id.to_string(),
                help_id: help_id.to_string(),
                started_at: now_ms(),
                ending: false,
            });
            // Hold the guard before `state` is released. A viewer that leaves right
            // after would otherwise run `close_window` to the end first, release a key
            // that is not there yet, and leave this hold behind with no window to free
            // it. `close_window` takes `state` and the guard's lock one after the
            // other, never both, so this order cannot deadlock.
            hold_secure_guard((self.holder, number));
        }
        let mut props = agent_props();
        props.insert("computer.help_id".to_string(), help_id.to_string());
        track_event(
            "computer secure takeover started",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
    }

    /// Mark the open window as ending, and answer it; `None` when none is open or it is
    /// already ending.
    fn mark_ending(&self) -> Option<SecureWindow> {
        let mut state = self.state.lock();
        let window = state.secure_window.as_mut()?;
        if window.ending {
            return None;
        }
        window.ending = true;
        Some(window.clone())
    }

    /// Close the window, in this order: forget what was typed, let the agent's
    /// processes run, then let it call a model again. A failure to clear still opens
    /// the gate — a runtime that never infers again is the worse outcome — and says so.
    ///
    /// `secure` holds until the clearing is done. The password fields are still filled
    /// while it runs, so this is the part of the window the screen tools must miss.
    pub async fn end_secure(&self, exit: SecureExit) {
        let Some(open) = self.mark_ending() else {
            return;
        };
        self.close_window(open, exit).await;
    }

    async fn close_window(&self, open: SecureWindow, exit: SecureExit) {
        if let Some(clear) = &self.clear_secrets
            && let Err(err) = clear().await
        {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Computer] Could not clear what a secure takeover left behind"
            );
        }
        // A takeover that began while this one was clearing is the open window now and
        // stays. It holds the guard under its own number, so releasing this window's
        // hold leaves that one guarded.
        {
            let mut state = self.state.lock();
            if state
                .secure_window
                .as_ref()
                .is_some_and(|window| window.number == open.number)
            {
                state.secure_window = None;
            }
        }
        release_secure_guard((self.holder, open.number));
        let mut props = agent_props();
        props.insert("computer.help_id".to_string(), open.help_id.clone());
        props.insert("exit".to_string(), exit.as_str().to_string());
        props.insert(
            "elapsed_ms".to_string(),
            (now_ms() - open.started_at).to_string(),
        );
        track_event(
            "computer secure takeover ended",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
        self.emit_change();
    }

    /// Fails with `Another viewer has control.` when another client has or claims control.
    pub fn assert_can_hand_back(&self, client_id: &str) -> anyhow::Result<()> {
        let state = self.state.lock();
        let other_human = state
            .human
            .as_deref()
            .is_some_and(|human| human != client_id);
        let other_claimant = state
            .claimant
            .as_deref()
            .is_some_and(|claimant| claimant != client_id);
        if other_human || other_claimant {
            anyhow::bail!(ANOTHER_VIEWER);
        }
        Ok(())
    }

    pub async fn hand_back(&self, client_id: &str) -> anyhow::Result<()> {
        self.assert_can_hand_back(client_id)?;
        // Control goes first: `ComputerSession::input` passes a frame on only while this
        // client is `human`, so a key already on its way cannot refill a field that the
        // clearing below has just emptied. The desktop stays paused until that is done.
        {
            let mut state = self.state.lock();
            state.human = None;
            state.claimant = None;
        }
        self.emit_change();
        self.end_secure(SecureExit::HandedBack).await;
        // A viewer who took control while the clearing ran holds the desktop now.
        {
            let mut state = self.state.lock();
            if state.human.is_some() || state.claimant.is_some() {
                return Ok(());
            }
            state.paused = false;
        }
        self.emit_change();
        Ok(())
    }

    /// A viewer that goes away keeps the desktop paused for its return, but ends its
    /// secure window: nobody is typing, and the runtime would otherwise never infer again.
    pub fn disconnected(&self, client_id: &str) {
        let ending = {
            let mut state = self.state.lock();
            if state.claimant.as_deref() == Some(client_id) {
                state.claimant = None;
            }
            if state.human.as_deref() != Some(client_id) {
                return;
            }
            state.human = None;
            state
                .secure_window
                .as_ref()
                .is_some_and(|window| window.client_id == client_id)
        };
        if ending
            && let Some(open) = self.mark_ending()
            && let Some(access) = self.me.upgrade()
        {
            tokio::spawn(async move {
                access.close_window(open, SecureExit::Disconnected).await;
            });
        }
        self.emit_change();
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
        {
            let mut state = self.state.lock();
            if state.owner.as_ref().is_some_and(|owner| same(owner, use_)) {
                state.owner = None;
            }
            state.queue.retain(|item| !same(item, use_));
        }
        self.emit_change();
    }

    pub fn finish(&self, use_: &ComputerUse) {
        if use_.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let status = if use_.signal.is_cancelled() {
            "canceled"
        } else if use_.failed.load(Ordering::SeqCst) {
            "error"
        } else {
            "completed"
        };
        use_.controller.cancel();
        self.yield_use(use_);
        let started_at = *use_.started_at.lock();
        if let Some(started_at) = started_at {
            let kind = use_.kind.lock().unwrap_or(self.kind);
            track_event(
                "computer use finished",
                Some(&use_.user_id),
                Some(IndexMap::from([
                    ("agent.id".to_string(), use_.agent_id.clone()),
                    ("computer.use_id".to_string(), use_.id.clone()),
                    ("computer.kind".to_string(), kind.as_str().to_string()),
                    ("status".to_string(), status.to_string()),
                    (
                        "elapsed_ms".to_string(),
                        (now_ms() - started_at).to_string(),
                    ),
                ])),
            );
        }
    }

    pub fn stop(&self) {
        if let Some(owner) = self.owner() {
            owner.controller.cancel();
        }
        self.emit_change();
    }
}

#[cfg(test)]
#[path = "computer_access_tests.rs"]
mod tests;
