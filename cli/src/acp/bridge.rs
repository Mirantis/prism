//! One ACP client's sessions, between the runtime and that client.
//!
//! An ACP session is one Prism conversation, and the session id is the thread
//! id. A prompt is a message sent on the chat socket, and its response is that
//! conversation's turn going idle. Every other message of the conversation goes
//! to the client as a session update, during a prompt and between prompts.
//!
//! Each session handles the socket's frames in their order on a queue of its
//! own, so a history read and the events that arrive during it stay in order.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use super::content::{message_updates, prompt_content};
use super::rpc::{Outbox, RpcError};
use super::runtime::{HISTORY_PAGE, Runtime};
use crate::protocol::{
    OutgoingMessage, TURN_FAILED_TEXT, TuiMessage, TurnEvent, TurnOutcome, TurnState,
    coerce_message,
};
use crate::ws_client::WsEvent;

const CATCH_UP_RETRY: Duration = Duration::from_millis(2_000);

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

/// How a conversation's turn ended, for a prompt confirmed only after it.
#[derive(Clone)]
struct Ending {
    outcome: Option<TurnOutcome>,
    error: Option<String>,
}

const COMPLETED: Ending = Ending {
    outcome: Some(TurnOutcome::Completed),
    error: None,
};

struct Pending {
    message_id: String,
    /// The runtime has given the message to a turn, so the next idle turn answered it.
    scheduled: bool,
    /// The client cancelled it. Until it ends, a turn that starts is stopped too.
    cancelled: bool,
    done: Option<oneshot::Sender<Result<&'static str, RpcError>>>,
}

#[derive(Default)]
struct SessionState {
    /// The messages this session has received: the history it attached after, and each one since.
    received: HashSet<String>,
    /// The client's own prompts, which the runtime's copy does not echo back.
    own: HashSet<String>,
    prompts: Vec<Pending>,
    last_turn: Option<Ending>,
    working: bool,
}

struct Session {
    id: String,
    state: Mutex<SessionState>,
    jobs: mpsc::UnboundedSender<Job>,
    /// The client's prompts, uploads and send each, go to the runtime one at a
    /// time in the order the client sent them.
    sends: mpsc::UnboundedSender<Job>,
}

/// A queue that runs its jobs one at a time, in the order they were queued.
fn job_queue() -> mpsc::UnboundedSender<Job> {
    let (jobs, mut rx) = mpsc::unbounded_channel::<Job>();
    tokio::spawn(async move {
        while let Some(job) = rx.recv().await {
            job.await;
        }
    });
    jobs
}

impl Session {
    fn new(id: &str, working: bool) -> Arc<Session> {
        Arc::new(Session {
            id: id.to_string(),
            state: Mutex::new(SessionState {
                working,
                ..SessionState::default()
            }),
            jobs: job_queue(),
            sends: job_queue(),
        })
    }

    fn run(&self, job: impl Future<Output = ()> + Send + 'static) {
        let _ = self.jobs.send(Box::pin(job));
    }
}

pub struct Bridge {
    runtime: Arc<Runtime>,
    out: Outbox,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// The conversations with a turn running or queued, as the socket last said.
    working: Mutex<HashSet<String>>,
}

impl Bridge {
    pub fn new(runtime: Arc<Runtime>, out: Outbox) -> Arc<Bridge> {
        Arc::new(Bridge {
            runtime,
            out,
            sessions: Mutex::new(HashMap::new()),
            working: Mutex::new(HashSet::new()),
        })
    }

    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub async fn create(self: &Arc<Self>, cwd: &str) -> Result<String, RpcError> {
        let thread_id = self.runtime.create_thread(cwd).await?;
        self.attach(&thread_id, false).await?;
        Ok(thread_id)
    }

    /// Forward a conversation's messages from here on. With `replay` its whole
    /// history goes first; without, the client is taken to have the history.
    pub async fn attach(self: &Arc<Self>, thread_id: &str, replay: bool) -> Result<(), RpcError> {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            let working = self.working.lock().unwrap().contains(thread_id);
            // Registered before the read, so a message that arrives during it waits behind it.
            sessions
                .entry(thread_id.to_string())
                .or_insert_with(|| Session::new(thread_id, working))
                .clone()
        };
        let (done, wait) = oneshot::channel();
        let bridge = self.clone();
        let s = session.clone();
        let thread = thread_id.to_string();
        session.run(async move {
            let result = async {
                let Some(history) = bridge.history(&thread, replay).await? else {
                    bridge.sessions.lock().unwrap().remove(&thread);
                    return Err(RpcError::session_not_found(&thread));
                };
                if !replay {
                    let mut st = s.state.lock().unwrap();
                    for m in &history {
                        st.received.insert(m.id.clone());
                    }
                    return Ok(());
                }
                {
                    let mut st = s.state.lock().unwrap();
                    st.received.clear();
                    st.own.clear();
                }
                for m in &history {
                    bridge.forward(&s, m);
                }
                Ok(())
            }
            .await;
            let _ = done.send(result);
        });
        wait.await
            .unwrap_or_else(|_| Err(RpcError::internal("the session closed")))
    }

    pub async fn list(&self, cwd: Option<&str>) -> Result<Value, RpcError> {
        let threads = self.runtime.list_threads(cwd).await?;
        // A session has a working directory, so a conversation started without one is not listed.
        let sessions: Vec<Value> = threads
            .into_iter()
            .filter_map(|t| {
                let root = t.workspace_root.clone()?;
                if cwd.is_some_and(|c| c != root) {
                    return None;
                }
                Some(json!({ "sessionId": t.id, "cwd": root, "title": t.title, "updatedAt": t.updated_at }))
            })
            .collect();
        Ok(json!({ "sessions": sessions }))
    }

    /// Take a prompt at the moment the client's request is read: it waits from
    /// now, so a `session/cancel` read right after it finds it, and its send is
    /// queued behind the session's earlier prompts. The answer comes when its turn ends.
    pub fn prompt(
        self: &Arc<Self>,
        session_id: &str,
        blocks: &[Value],
    ) -> Result<impl Future<Output = Result<Value, RpcError>> + Send + use<>, RpcError> {
        let session = self
            .session(session_id)
            .ok_or_else(|| RpcError::session_not_found(session_id))?;
        let content = prompt_content(blocks);
        let message_id = uuid::Uuid::new_v4().to_string();
        let (done, wait) = oneshot::channel();
        {
            let mut st = session.state.lock().unwrap();
            st.own.insert(message_id.clone());
            // Waiting from before the uploads, so a cancel during them holds for the turn that follows.
            st.prompts.push(Pending {
                message_id: message_id.clone(),
                scheduled: false,
                cancelled: false,
                done: Some(done),
            });
        }
        let bridge = self.clone();
        let s = session.clone();
        let id = message_id.clone();
        let _ = session.sends.send(Box::pin(async move {
            let mut attachment_ids = Vec::new();
            for image in content.images {
                match bridge.runtime.upload(image.data, &image.filename).await {
                    Ok(aid) => attachment_ids.push(aid),
                    Err(e) => {
                        bridge.end(&s, std::slice::from_ref(&id), |_| Err(e.clone()));
                        return;
                    }
                }
            }
            // A prompt sent while a turn runs goes to that turn, and both prompts end when it does.
            bridge.runtime.send(OutgoingMessage {
                id,
                thread_id: s.id.clone(),
                content: content.text,
                attachment_ids,
            });
        }));
        Ok(async move {
            let stop_reason = wait
                .await
                .unwrap_or_else(|_| Err(RpcError::internal("the session closed")))?;
            Ok(json!({ "stopReason": stop_reason }))
        })
    }

    /// Stop the turn the session's prompts wait for. A prompt not sent yet starts
    /// its turn afterwards, so the cancel is asked again when a turn starts.
    pub fn cancel(&self, session_id: &str) {
        let Some(session) = self.session(session_id) else {
            return;
        };
        {
            let mut st = session.state.lock().unwrap();
            if st.prompts.is_empty() {
                return;
            }
            for p in &mut st.prompts {
                p.cancelled = true;
            }
        }
        self.runtime.cancel(session_id);
    }

    pub fn on_ws(self: &Arc<Self>, event: WsEvent) {
        match event {
            WsEvent::Welcome(welcome) => {
                {
                    let mut working = self.working.lock().unwrap();
                    working.clear();
                    for (thread, _) in &welcome.turns {
                        working.insert(thread.clone());
                    }
                }
                // A resumed socket sends every missed event next, and the session follows those.
                if welcome.resumed {
                    return;
                }
                let sessions: Vec<Arc<Session>> =
                    self.sessions.lock().unwrap().values().cloned().collect();
                for session in sessions {
                    let working = self.working.lock().unwrap().contains(&session.id);
                    let bridge = self.clone();
                    let s = session.clone();
                    session.run(async move { bridge.catch_up(&s, working).await });
                }
            }
            WsEvent::Event(e) => {
                match e.kind.as_str() {
                    "message" => {
                        if let Some(message) = coerce_message(&e.payload) {
                            self.queue(&message.thread_id.clone(), move |b, s| {
                                b.forward(s, &message);
                            });
                        }
                    }
                    "turn" => {
                        let Some(turn) = TurnEvent::parse(&e.payload) else {
                            return;
                        };
                        let working = turn.state != TurnState::Idle;
                        {
                            let mut w = self.working.lock().unwrap();
                            if working {
                                w.insert(turn.thread_id.clone());
                            } else {
                                w.remove(&turn.thread_id);
                            }
                        }
                        self.queue(&turn.thread_id.clone(), move |b, s| {
                            let ids: Vec<String> = {
                                let mut st = s.state.lock().unwrap();
                                st.working = working;
                                if working {
                                    // In the session's order, so a cancel that ended with the turn before does not stop this one.
                                    if st.prompts.iter().any(|p| p.cancelled) {
                                        drop(st);
                                        b.runtime.cancel(&s.id);
                                    }
                                    return;
                                }
                                let ending = Ending {
                                    outcome: turn.outcome,
                                    error: turn.error.clone(),
                                };
                                st.last_turn = Some(ending);
                                st.prompts.iter().map(|p| p.message_id.clone()).collect()
                            };
                            b.settle(
                                s,
                                Ending {
                                    outcome: turn.outcome,
                                    error: turn.error.clone(),
                                },
                                &ids,
                            );
                        });
                    }
                    "thread" => {
                        let thread_id = e
                            .payload
                            .get("threadId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let title = e.payload.get("title").cloned().unwrap_or(Value::Null);
                        self.queue(&thread_id, move |b, s| {
                            b.update(
                                &s.id,
                                json!({ "sessionUpdate": "session_info_update", "title": title }),
                            );
                        });
                    }
                    "context" => {
                        let thread_id = e
                            .payload
                            .get("threadId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let used = e.payload.get("usedTokens").cloned().unwrap_or(Value::Null);
                        let size = e
                            .payload
                            .get("windowTokens")
                            .cloned()
                            .unwrap_or(Value::Null);
                        self.queue(&thread_id, move |b, s| {
                        b.update(&s.id, json!({ "sessionUpdate": "usage_update", "used": used, "size": size }));
                    });
                    }
                    _ => {}
                }
            }
            WsEvent::Sent(ack) => {
                let Some(session) = self.session_of_prompt(&ack.message_id) else {
                    return;
                };
                let id = ack.message_id.clone();
                let duplicate = ack.duplicate;
                let bridge = self.clone();
                let s = session.clone();
                // In the queue, behind the idle of a turn that ended before the runtime scheduled this message.
                session.run(async move {
                    let settle_with = {
                        let mut st = s.state.lock().unwrap();
                        if let Some(p) = st.prompts.iter_mut().find(|p| p.message_id == id) {
                            p.scheduled = true;
                        }
                        // A message confirmed a second time was stored before the socket went away. With
                        // no turn on the conversation now, its turn ended while the confirmation was lost.
                        (duplicate && !st.working)
                            .then(|| st.last_turn.clone().unwrap_or(COMPLETED))
                    };
                    if let Some(ending) = settle_with {
                        bridge.settle(&s, ending, &[id]);
                    }
                });
            }
            WsEvent::SendFailed(failure) => {
                let Some(session) = self.session_of_prompt(&failure.message_id) else {
                    return;
                };
                let message = failure.message.clone();
                self.end(&session, &[failure.message_id], |_| {
                    Err(RpcError::internal(&message))
                });
            }
            WsEvent::Error(message) => eprintln!("prism acp: {message}"),
            WsEvent::Disconnected | WsEvent::Unsupported => {}
        }
    }

    fn session_of_prompt(&self, message_id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .find(|s| {
                s.state
                    .lock()
                    .unwrap()
                    .prompts
                    .iter()
                    .any(|p| p.message_id == message_id)
            })
            .cloned()
    }

    /// Queue work on a session this connection has open. An event of any other conversation is dropped.
    fn queue(
        self: &Arc<Self>,
        thread_id: &str,
        work: impl FnOnce(&Arc<Bridge>, &Arc<Session>) + Send + 'static,
    ) {
        let Some(session) = self.session(thread_id) else {
            return;
        };
        let bridge = self.clone();
        let s = session.clone();
        session.run(async move { work(&bridge, &s) });
    }

    /// Send a message the session receives for the first time, unless it is the client's own prompt.
    fn forward(&self, session: &Arc<Session>, message: &TuiMessage) {
        {
            let mut st = session.state.lock().unwrap();
            // A message arrives again when it changes in place, and ACP v1 has no update for a sent message.
            if !st.received.insert(message.id.clone()) {
                return;
            }
            if st.own.contains(&message.id) {
                return;
            }
        }
        for update in message_updates(message, |id| self.runtime.attachment_url(id)) {
            self.update(&session.id, update);
        }
    }

    fn update(&self, session_id: &str, update: Value) {
        self.out.notify(
            "session/update",
            json!({ "sessionId": session_id, "update": update }),
        );
    }

    /// Answer those of `ids` that the turn which just ended had been given.
    fn settle(&self, session: &Arc<Session>, ending: Ending, ids: &[String]) {
        let scheduled: Vec<String> = {
            let st = session.state.lock().unwrap();
            st.prompts
                .iter()
                .filter(|p| p.scheduled && ids.contains(&p.message_id))
                .map(|p| p.message_id.clone())
                .collect()
        };
        self.end(session, &scheduled, |_| {
            if ending.outcome == Some(TurnOutcome::Failed) {
                return Err(RpcError::internal(
                    ending.error.as_deref().unwrap_or(TURN_FAILED_TEXT),
                ));
            }
            // A conversation that goes idle with no outcome only ever waited, and a wait ends early by a cancel alone.
            Ok(if ending.outcome == Some(TurnOutcome::Completed) {
                "end_turn"
            } else {
                "cancelled"
            })
        });
    }

    /// Take the prompts that still wait off the session, and finish each.
    fn end(
        &self,
        session: &Arc<Session>,
        ids: &[String],
        finish: impl Fn(&str) -> Result<&'static str, RpcError>,
    ) {
        let ending: Vec<Pending> = {
            let mut st = session.state.lock().unwrap();
            let (ending, keep): (Vec<Pending>, Vec<Pending>) = std::mem::take(&mut st.prompts)
                .into_iter()
                .partition(|p| ids.contains(&p.message_id));
            st.prompts = keep;
            ending
        };
        for mut p in ending {
            if let Some(done) = p.done.take() {
                let _ = done.send(finish(&p.message_id));
            }
        }
    }

    /// After the socket came back without the missed events: send what the client
    /// missed, and end the prompts whose turn ended while the socket was away.
    async fn catch_up(self: &Arc<Self>, session: &Arc<Session>, working: bool) {
        let confirmed: Vec<String> = {
            let mut st = session.state.lock().unwrap();
            st.working = working;
            st.last_turn = None;
            st.prompts
                .iter()
                .filter(|p| p.scheduled)
                .map(|p| p.message_id.clone())
                .collect()
        };
        for message in self.missed(session).await {
            self.forward(session, &message);
        }
        if !working {
            self.settle(session, COMPLETED, &confirmed);
        }
    }

    /// The conversation from the oldest message this session has received, oldest first.
    async fn missed(&self, session: &Arc<Session>) -> Vec<TuiMessage> {
        let mut messages: Vec<TuiMessage> = Vec::new();
        let mut before: Option<String> = None;
        loop {
            let page = self.page(&session.id, before.as_deref()).await;
            let page_len = page.len();
            let first = page.first().map(|m| m.id.clone());
            messages.splice(0..0, page);
            let has = {
                let st = session.state.lock().unwrap();
                messages.iter().position(|m| st.received.contains(&m.id))
            };
            if let Some(at) = has {
                return messages.split_off(at);
            }
            if page_len < HISTORY_PAGE {
                return messages;
            }
            before = first;
        }
    }

    /// One page of the conversation, asked for until the runtime answers.
    async fn page(&self, thread_id: &str, before: Option<&str>) -> Vec<TuiMessage> {
        loop {
            match self.runtime.messages(thread_id, before).await {
                Ok(page) => return page.unwrap_or_default(),
                Err(_) => tokio::time::sleep(CATCH_UP_RETRY).await,
            }
        }
    }

    /// The conversation's newest page, or with `whole` every page, oldest first.
    async fn history(
        &self,
        thread_id: &str,
        whole: bool,
    ) -> Result<Option<Vec<TuiMessage>>, RpcError> {
        let mut messages: Vec<TuiMessage> = Vec::new();
        let mut before: Option<String> = None;
        loop {
            let Some(page) = self.runtime.messages(thread_id, before.as_deref()).await? else {
                return Ok(None);
            };
            let page_len = page.len();
            let first = page.first().map(|m| m.id.clone());
            messages.splice(0..0, page);
            if !whole || page_len < HISTORY_PAGE {
                return Ok(Some(messages));
            }
            before = first;
        }
    }
}
