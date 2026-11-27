//! Bridges the chat surface to the runtime's chat socket.
//!
//! The session shows one conversation, and the adapter drops the events of every
//! other one: every client of the agent receives every event. The CLI does not
//! know the agent id or the user id; the runtime owns both.

use std::collections::HashMap;
use std::sync::Arc;

use crate::api::ApiClient;
use crate::event::{AppEvent, AppTx};
use crate::protocol::{
    CompactionEvent, ContextUsage, OutgoingMessage, SignInRequest, StreamEvent, TuiMessage,
    TurnEvent, TurnState, UpdateEvent, Viewer, Welcome, coerce_compaction, coerce_context_usage,
    coerce_message, coerce_update, ended_sign_in_in, sign_in_request_in,
};
use crate::ws_client::{WsClient, WsEvent};

/// Shown when the runtime closes the socket as too old. Nothing reconnects after it.
pub const UPDATE_REQUIRED_NOTICE: &str = "This prism-cli is older than the Prism runtime and cannot connect to it. Update prism-cli, then start it again.";

const HISTORY_LIMIT: usize = 50;

/// What the chat surface hears from the adapter.
pub enum Out {
    /// Connected (`None`), or why not.
    Status(Option<String>),
    Welcome(Viewer),
    History(Vec<TuiMessage>),
    Message(TuiMessage),
    Turn(TurnEvent),
    SendFailed {
        message_id: String,
        message: String,
    },
    ContextUsage(ContextUsage),
    Compaction(CompactionEvent),
    Update(UpdateEvent),
    SignIn(SignInRequest),
    SignInEnded(String),
    Unsupported(String),
    /// A history load finished, whether or not it applied.
    Resynced,
}

pub struct Adapter {
    client: Option<WsClient>,
    api: Arc<ApiClient>,
    tx: AppTx,
    thread_id: Option<String>,
    /// Messages submitted before the conversation existed, sent once it does.
    unthreaded: Vec<(String, String, Vec<String>)>,
    /// Events that arrived while history was loading. `None` while no load runs.
    held: Option<Vec<StreamEvent>>,
    sync_generation: u64,
    /// Every conversation that is working, from the last welcome and the events since.
    working: HashMap<String, TurnState>,
}

impl Adapter {
    pub fn new(api: Arc<ApiClient>, tx: AppTx) -> Adapter {
        Adapter {
            client: None,
            api,
            tx,
            thread_id: None,
            unthreaded: Vec::new(),
            held: None,
            sync_generation: 0,
            working: HashMap::new(),
        }
    }

    /// Open the chat socket.
    pub fn connect(&mut self, ws_url: String, version: &str) {
        if self.client.is_some() {
            return;
        }
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
        self.client = Some(WsClient::connect(ws_url, "prism-cli", version, events_tx));
        let tx = self.tx.clone();
        tokio::spawn(async move {
            while let Some(e) = events_rx.recv().await {
                if tx.send(AppEvent::Ws(e)).is_err() {
                    return;
                }
            }
        });
    }

    pub fn disconnect(&mut self) {
        if let Some(c) = self.client.take() {
            c.close();
        }
    }

    /// Make `thread_id` the one this session shows, and send what was submitted before it existed.
    pub fn adopt(&mut self, thread_id: &str) {
        self.thread_id = Some(thread_id.to_string());
        for (id, content, attachment_ids) in std::mem::take(&mut self.unthreaded) {
            if let Some(c) = &self.client {
                c.send(OutgoingMessage {
                    id,
                    thread_id: thread_id.to_string(),
                    content,
                    attachment_ids,
                });
            }
        }
    }

    /// Show an existing conversation: its history now, and its events from here on.
    pub fn resume_thread(&mut self, thread_id: &str) -> Vec<Out> {
        self.adopt(thread_id);
        let out = vec![self.turn_state(thread_id)];
        self.resync();
        out
    }

    fn turn_state(&self, thread_id: &str) -> Out {
        Out::Turn(TurnEvent {
            thread_id: thread_id.to_string(),
            state: self
                .working
                .get(thread_id)
                .copied()
                .unwrap_or(TurnState::Idle),
            outcome: None,
            error: None,
        })
    }

    /// Send a message under the id the caller drew it with. A message submitted
    /// before the conversation exists waits for it.
    pub fn submit(&mut self, id: String, text: String, attachment_ids: Vec<String>) {
        let Some(thread_id) = self.thread_id.clone() else {
            self.unthreaded.push((id, text, attachment_ids));
            return;
        };
        if let Some(c) = &self.client {
            c.send(OutgoingMessage {
                id,
                thread_id,
                content: text,
                attachment_ids,
            });
        }
    }

    /// Stop this conversation's work, whoever started it. False when it could not be asked.
    pub fn cancel(&self) -> bool {
        match (&self.thread_id, &self.client) {
            (Some(t), Some(c)) => c.cancel(t),
            _ => false,
        }
    }

    pub fn on_ws(&mut self, event: WsEvent) -> Vec<Out> {
        match event {
            WsEvent::Welcome(w) => self.on_welcome(w),
            WsEvent::Event(e) => {
                if let Some(held) = &mut self.held {
                    held.push(e);
                    return Vec::new();
                }
                self.apply(e)
            }
            WsEvent::Sent(_) => Vec::new(),
            WsEvent::SendFailed(f) => vec![Out::SendFailed {
                message_id: f.message_id,
                message: f.message,
            }],
            WsEvent::Disconnected => vec![Out::Status(Some("disconnected, retrying…".into()))],
            WsEvent::Error(message) => vec![Out::Status(Some(message))],
            WsEvent::Unsupported => {
                vec![
                    Out::Status(Some("update prism-cli".into())),
                    Out::Unsupported(UPDATE_REQUIRED_NOTICE.into()),
                ]
            }
        }
    }

    fn on_welcome(&mut self, welcome: Welcome) -> Vec<Out> {
        let mut out = vec![Out::Status(None), Out::Welcome(welcome.you.clone())];
        self.working.clear();
        for (thread, state) in &welcome.turns {
            self.working.insert(thread.clone(), *state);
        }
        let Some(thread_id) = self.thread_id.clone() else {
            return out;
        };
        out.push(self.turn_state(&thread_id));
        if !welcome.resumed {
            self.resync();
        }
        out
    }

    fn apply(&mut self, event: StreamEvent) -> Vec<Out> {
        let mut out = Vec::new();
        match event.kind.as_str() {
            "message" => {
                let Some(msg) = coerce_message(&event.payload) else {
                    return out;
                };
                if Some(&msg.thread_id) != self.thread_id.as_ref() {
                    return out;
                }
                let sign_in = sign_in_outs(&msg);
                out.push(Out::Message(msg));
                out.extend(sign_in);
            }
            "turn" => {
                let Some(turn) = TurnEvent::parse(&event.payload) else {
                    return out;
                };
                if turn.state == TurnState::Idle {
                    self.working.remove(&turn.thread_id);
                } else {
                    self.working.insert(turn.thread_id.clone(), turn.state);
                }
                if Some(&turn.thread_id) == self.thread_id.as_ref() {
                    out.push(Out::Turn(turn));
                }
            }
            "context" => {
                if let Some(usage) = coerce_context_usage(&event.payload)
                    && Some(&usage.thread_id) == self.thread_id.as_ref()
                {
                    out.push(Out::ContextUsage(usage));
                }
            }
            "compaction" => {
                let Some(c) = coerce_compaction(&event.payload) else {
                    return out;
                };
                if Some(&c.thread_id) != self.thread_id.as_ref() {
                    return out;
                }
                let completed = c.status == "completed";
                out.push(Out::Compaction(c));
                // Older messages were folded into the summary, so the stored history changed.
                if completed {
                    self.resync();
                }
            }
            "update" => {
                if let Some(u) = coerce_update(&event.payload) {
                    out.push(Out::Update(u));
                }
            }
            // `thread` and `computer` events have no place in the terminal UI.
            _ => {}
        }
        out
    }

    /// Replace the conversation on screen with its stored history. Events that
    /// arrive meanwhile are held and applied after it. Only the newest load applies.
    fn resync(&mut self) {
        let Some(thread_id) = self.thread_id.clone() else {
            return;
        };
        self.sync_generation += 1;
        let generation = self.sync_generation;
        if self.held.is_none() {
            self.held = Some(Vec::new());
        }
        let api = self.api.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let messages = api.load_history(&thread_id, HISTORY_LIMIT).await;
            let _ = tx.send(AppEvent::History {
                generation,
                messages,
            });
        });
    }

    pub fn on_history(&mut self, generation: u64, messages: Option<Vec<TuiMessage>>) -> Vec<Out> {
        if generation != self.sync_generation {
            return vec![Out::Resynced];
        }
        let held = self.held.take().unwrap_or_default();
        let mut out = Vec::new();
        match messages {
            Some(messages) => {
                // A sign-in can be asked for or answered while the stream was away.
                let sign_ins: Vec<Out> = messages.iter().flat_map(sign_in_outs).collect();
                out.push(Out::History(messages));
                out.extend(sign_ins);
            }
            None => out.push(Out::Status(Some(
                "could not reload the conversation".into(),
            ))),
        }
        for event in held {
            out.extend(self.apply(event));
        }
        out.push(Out::Resynced);
        out
    }
}

/// The sign-in a message asks for or ends.
fn sign_in_outs(msg: &TuiMessage) -> Vec<Out> {
    let mut out = Vec::new();
    if let Some(mut request) = sign_in_request_in(&msg.blocks) {
        request.thread_id = Some(msg.thread_id.clone());
        out.push(Out::SignIn(request));
    }
    if let Some(ended) = ended_sign_in_in(&msg.blocks) {
        out.push(Out::SignInEnded(ended));
    }
    out
}
