//! The events the chat session's loop handles, and the handles that tasks use to
//! send them.

use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::api::{ApiClient, LlmProviderStatus};
use crate::images::bitmap::Bitmap;
use crate::panels::PanelMsg;
use crate::protocol::{AttachmentMeta, ContextUsage, TuiMessage};
use crate::term::terminal::TermInput;
use crate::ws_client::WsEvent;

/// A full-screen panel a command opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelId {
    Schedules,
    Config,
    Webhooks,
}

/// The conversation the session opened at launch.
pub struct Opened {
    pub thread_id: String,
    /// A single-thread agent's one conversation, shown with its history.
    pub existing: bool,
    pub context_usage: Option<ContextUsage>,
}

pub enum AppEvent {
    Term(TermInput),
    /// A lone Escape waited long enough to be the Escape key.
    FlushEscape,
    Ws(WsEvent),
    /// The launch conversation, or `None` when the runtime did not answer yet.
    Opened(Option<Opened>),
    RetryOpen,
    History {
        generation: u64,
        messages: Option<Vec<TuiMessage>>,
    },
    /// A line for the conversation, from this client.
    System(String),
    /// Send a message to the agent, as the user.
    SendMessage(String),
    OpenPanel(PanelId),
    Stage(AttachmentMeta),
    ClearStaged,
    Shutdown,
    Panel(PanelMsg),
    /// Hand the terminal to a child process; answer once it is free.
    Suspend(oneshot::Sender<()>),
    /// Take the terminal back; answer once the screen is drawn again.
    Resume(oneshot::Sender<()>),
    UpdateHint(String),
    LlmProvider(LlmProviderStatus),
    ImageLoaded {
        id: String,
        bitmap: Option<Arc<Bitmap>>,
    },
    SpinnerTick,
}

pub type AppTx = mpsc::UnboundedSender<AppEvent>;

/// What a background task needs to talk to the runtime and back to the session.
#[derive(Clone)]
pub struct Ctx {
    pub api: Arc<ApiClient>,
    pub tx: AppTx,
    /// The terminal is a TTY, so a child process has to be handed it.
    pub interactive: bool,
}

impl Ctx {
    pub fn send(&self, event: AppEvent) {
        let _ = self.tx.send(event);
    }

    /// Run `f` (a child process that needs the terminal) with the session's own
    /// input and drawing stopped.
    pub async fn suspended<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> T {
        if !self.interactive {
            return tokio::task::spawn_blocking(f)
                .await
                .expect("the child process task panicked");
        }
        let (ack, wait) = oneshot::channel();
        self.send(AppEvent::Suspend(ack));
        let _ = wait.await;
        let result = tokio::task::spawn_blocking(f).await;
        let (ack, wait) = oneshot::channel();
        self.send(AppEvent::Resume(ack));
        let _ = wait.await;
        result.expect("the child process task panicked")
    }
}
