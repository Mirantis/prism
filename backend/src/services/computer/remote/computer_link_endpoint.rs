//! `/api/computer-link`: where a remote computer's client holds its link open.
//!
//! The upgrade gets the origin rule every route on this server gets, so a client that is
//! not a browser, which sends no `Origin`, passes it; the platform in front of the runtime
//! authenticates the user. The client names its computer in `?computer=`, and its first
//! message is `initialize`. After that the runtime sends the requests, and the client
//! reports the person at the computer and changes to its displays and permissions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use axum::extract::ws::{WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequest, Request};
use axum::response::{IntoResponse, Response};
use diesel::prelude::*;
use http::{StatusCode, header};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::computer_link::{ComputerLink, LinkEvent, LinkRequest};
use super::link_protocol::{
    COMPUTER_LINK_PATH, InitializeParams, LINK_CLOSE, LINK_PROTOCOL_VERSION, LinkSchema,
    MAX_LINK_FRAME_BYTES, RPC_ERROR,
};
use super::remote_computer::RemoteComputer;
use super::remote_computer_service::{ConnectionInfo, REMOTE_COMPUTER_SERVICE};
use crate::config::CONFIG;
use crate::db::schema::conversation_threads;
use crate::lib::log_redaction::err_json;
use crate::lib::origin_guard::is_allowed_origin;
use crate::lib::telemetry::track_event;
use crate::services::computer::computer_help_service::COMPUTER_HELP_SERVICE;
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::computer::computer_session::Controller;
use crate::services::websocket_upgrades::{joined_header, refuse, serve_upgrades};
use crate::support::{js, now_ms};
use crate::{log_info, log_warn};

/// How long a new link has to send `initialize`.
const INITIALIZE_TIMEOUT_MS: u64 = 10_000;
/// The runtime pings this often, and ends a link that has not answered by the next ping.
const PING_INTERVAL_SECONDS: u64 = 30;

/// What `computer disconnected` reports for each way a link can end; any other code is
/// `closed`.
fn close_reason(code: u16) -> Option<&'static str> {
    match code {
        1001 => Some("going_away"),
        1006 => Some("lost"),
        4400 => Some("protocol_error"),
        4403 => Some("removed"),
        4409 => Some("replaced"),
        4426 => Some("unsupported_version"),
        _ => None,
    }
}

/// The invocation holding the computer, as `computer.state` names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStateOwner {
    pub thread_id: Option<String>,
    pub mode: String,
    /// The conversation's title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// The help request waiting on the computer, as `computer.state` names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkStateHelp {
    pub id: String,
    pub reason: String,
}

/// The `computer.state` notification: who is using the computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerLinkState {
    /// `true` while the agent holds the computer.
    pub agent_active: bool,
    /// `true` while someone watches the screen in the web UI.
    pub watched: bool,
    pub controller: Option<Controller>,
    pub owner: Option<LinkStateOwner>,
    pub help: Option<LinkStateHelp>,
}

/// One open link socket, as the liveness check sees it.
struct LinkSocket {
    link: Arc<ComputerLink>,
    /// Whether the socket answered the last ping.
    alive: Arc<AtomicBool>,
}

/// What one link's handlers share: the computer it became, and what its end undoes.
#[derive(Default)]
struct Served {
    remote: Option<Arc<RemoteComputer>>,
    since: i64,
    unwatch: Option<Box<dyn FnOnce() + Send>>,
    deadline: Option<JoinHandle<()>>,
}

/// `computer.state` reports for one link, read once per burst of changes.
#[derive(Default)]
struct Reports {
    last: String,
    building: bool,
    again: bool,
}

/// `new URL(req.url, 'http://localhost').searchParams.get('computer') ?? ''`.
fn computer_param(req: &Request) -> String {
    req.uri()
        .query()
        .and_then(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "computer")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_default()
}

pub struct ComputerLinkEndpoint {
    /// The open links, by connection number.
    sockets: Mutex<HashMap<u64, LinkSocket>>,
    liveness: Mutex<Option<JoinHandle<()>>>,
    /// Set from `initialize` until `close`; an upgrade outside that answers 503.
    accepting: AtomicBool,
    next_socket: AtomicU64,
}

pub static COMPUTER_LINK_ENDPOINT: LazyLock<ComputerLinkEndpoint> =
    LazyLock::new(ComputerLinkEndpoint::new);

impl ComputerLinkEndpoint {
    pub fn new() -> Self {
        ComputerLinkEndpoint {
            sockets: Mutex::new(HashMap::new()),
            liveness: Mutex::new(None),
            accepting: AtomicBool::new(false),
            next_socket: AtomicU64::new(1),
        }
    }

    /// Serve `COMPUTER_LINK_PATH` through `websocket_upgrades` with frames of at most
    /// `MAX_LINK_FRAME_BYTES`, ping every link each `PING_INTERVAL_SECONDS` and end one that
    /// did not answer the last ping, and log `[Computer:Link] Listening on
    /// /api/computer-link`.
    pub fn initialize(&'static self) {
        self.accepting.store(true, Ordering::SeqCst);
        serve_upgrades(
            COMPUTER_LINK_PATH,
            Arc::new(move |req| Box::pin(self.handle_upgrade(req))),
        );
        let period = Duration::from_secs(PING_INTERVAL_SECONDS);
        let liveness = tokio::spawn(async move {
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                ticks.tick().await;
                self.check_liveness();
            }
        });
        if let Some(previous) = self.liveness.lock().replace(liveness) {
            previous.abort();
        }
        log_info!("[Computer:Link] Listening on {}", COMPUTER_LINK_PATH);
    }

    /// End each link that did not answer the last ping, and ping the rest.
    fn check_liveness(&self) {
        let sockets: Vec<(Arc<ComputerLink>, Arc<AtomicBool>)> = self
            .sockets
            .lock()
            .values()
            .map(|socket| (Arc::clone(&socket.link), Arc::clone(&socket.alive)))
            .collect();
        for (link, alive) in sockets {
            if !alive.load(Ordering::SeqCst) {
                link.terminate();
                continue;
            }
            alive.store(false, Ordering::SeqCst);
            link.ping();
        }
    }

    /// One upgrade to `COMPUTER_LINK_PATH`: a refused origin answers 403 (logged as
    /// `[Computer:Link] refused a handshake (origin …, host …)`), and a `?computer=` that
    /// names no computer 404.
    pub async fn handle_upgrade(&'static self, req: Request) -> Response {
        let headers = req.headers();
        let origin = joined_header(headers, header::ORIGIN);
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let forwarded = joined_header(headers, header::HeaderName::from_static("x-forwarded-host"));
        if !is_allowed_origin(origin.as_deref(), host.as_deref(), forwarded.as_deref()) {
            log_warn!(
                "[Computer:Link] refused a handshake (origin {}, host {})",
                origin.as_deref().unwrap_or("undefined"),
                host.as_deref().unwrap_or("undefined")
            );
            return refuse(StatusCode::FORBIDDEN);
        }
        let id = computer_param(&req);
        if REMOTE_COMPUTER_SERVICE.get(&id).is_none() {
            return refuse(StatusCode::NOT_FOUND);
        }
        if !self.accepting.load(Ordering::SeqCst) {
            return refuse(StatusCode::SERVICE_UNAVAILABLE);
        }
        let upgrade = match WebSocketUpgrade::from_request(req, &()).await {
            Ok(upgrade) => upgrade,
            Err(rejection) => return rejection.into_response(),
        };
        upgrade
            .max_message_size(MAX_LINK_FRAME_BYTES)
            .max_frame_size(MAX_LINK_FRAME_BYTES)
            .on_upgrade(move |ws| self.serve(ws, id))
    }

    /// Serve one link for computer `id`: `initialize` first, within
    /// `INITIALIZE_TIMEOUT_MS`, then the person at the computer (`local.hold`,
    /// `local.release`, in the order they arrive), and the end of the link.
    async fn serve(&'static self, ws: WebSocket, id: String) {
        let link = ComputerLink::new(ws);
        let number = self.next_socket.fetch_add(1, Ordering::SeqCst);
        let alive = Arc::new(AtomicBool::new(true));
        let answered = Arc::clone(&alive);
        link.on_pong(Arc::new(move || answered.store(true, Ordering::SeqCst)));
        self.sockets.lock().insert(
            number,
            LinkSocket {
                link: Arc::clone(&link),
                alive,
            },
        );
        let served = Arc::new(Mutex::new(Served::default()));
        let closing = Arc::downgrade(&link);
        served.lock().deadline = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(INITIALIZE_TIMEOUT_MS)).await;
            if let Some(link) = closing.upgrade() {
                link.close(LINK_CLOSE.protocol_error, "no initialize");
            }
        }));

        // Hold and release apply in the order the person did them.
        let (presence, mut queue) = mpsc::unbounded_channel::<String>();
        let holder = Arc::clone(&served);
        let holder_id = id.clone();
        tokio::spawn(async move {
            while let Some(method) = queue.recv().await {
                let current = holder.lock().remote.clone();
                if let Err(err) = self.presence(&holder_id, &method, current.as_ref()).await {
                    log_info!(
                        "[Computer:Link] {} on {}: Error: {}",
                        method,
                        current
                            .as_ref()
                            .map(|remote| remote.name())
                            .unwrap_or_else(|| "undefined".to_string()),
                        err
                    );
                }
            }
        });

        let me = Arc::downgrade(&link);
        link.on(Arc::new(move |event| {
            let Some(link) = me.upgrade() else {
                return;
            };
            match event {
                LinkEvent::Request(request) => self.requested(&id, &link, &served, request),
                LinkEvent::Notification { method, .. } => {
                    if served.lock().remote.is_none() {
                        link.close(LINK_CLOSE.protocol_error, "initialize first");
                        return;
                    }
                    if method == "local.hold" || method == "local.release" {
                        let _ = presence.send(method.clone());
                    }
                }
                LinkEvent::Binary(_) => {
                    if served.lock().remote.is_none() {
                        link.close(LINK_CLOSE.protocol_error, "initialize first");
                    }
                }
                LinkEvent::Close { code, .. } => self.ended(number, &id, &served, *code),
            }
        }));
        link.start();
    }

    /// A request from the client: `initialize`, the one it may send, and only first.
    fn requested(
        &'static self,
        id: &str,
        link: &Arc<ComputerLink>,
        served: &Arc<Mutex<Served>>,
        request: &LinkRequest,
    ) {
        if served.lock().remote.is_some() {
            link.fail(
                Some(&request.id),
                RPC_ERROR.method_not_found,
                &format!("The runtime answers no {} request.", request.method),
            );
            return;
        }
        if request.method != "initialize" {
            link.close(LINK_CLOSE.protocol_error, "initialize first");
            return;
        }
        if let Some(deadline) = served.lock().deadline.take() {
            deadline.abort();
        }
        let hello = match InitializeParams::parse_input(request.params.as_ref()) {
            Ok(hello) => hello,
            Err(issue) => {
                link.fail(
                    Some(&request.id),
                    RPC_ERROR.invalid_params,
                    &format!("initialize: {issue}"),
                );
                link.close(LINK_CLOSE.protocol_error, "invalid initialize");
                return;
            }
        };
        if hello.protocol_version != LINK_PROTOCOL_VERSION {
            link.fail(
                Some(&request.id),
                RPC_ERROR.invalid_params,
                &format!("This runtime speaks protocol version {LINK_PROTOCOL_VERSION}."),
            );
            link.close(
                LINK_CLOSE.unsupported_version,
                "unsupported protocol version",
            );
            return;
        }
        let Some(row) = REMOTE_COMPUTER_SERVICE.get(id) else {
            link.close(LINK_CLOSE.removed, "computer removed");
            return;
        };
        let (computer_id, row_name) = (id.to_string(), row.name.clone());
        let remote = RemoteComputer::new(
            Arc::new(move || {
                REMOTE_COMPUTER_SERVICE
                    .get(&computer_id)
                    .map(|row| row.name)
                    .unwrap_or_else(|| row_name.clone())
            }),
            Arc::clone(link),
            hello.clone(),
            Some(Arc::new(|| COMPUTER_SERVICE.emit_change())),
        );
        {
            let mut state = served.lock();
            state.remote = Some(Arc::clone(&remote));
            state.since = now_ms();
        }
        link.answer(
            &request.id,
            json!({
                "protocolVersion": LINK_PROTOCOL_VERSION,
                "computer": { "id": id, "name": row.name },
                "pingIntervalSeconds": PING_INTERVAL_SECONDS,
            }),
        );
        COMPUTER_SERVICE.linked(id, Arc::clone(&remote), Arc::clone(link));
        let unwatch = self.report_state(id, Arc::clone(link));
        served.lock().unwatch = Some(unwatch);
        let (recorded, info) = (
            id.to_string(),
            ConnectionInfo {
                platform: hello.platform,
                client_version: hello.client.version.clone(),
            },
        );
        tokio::spawn(async move {
            if let Err(err) = REMOTE_COMPUTER_SERVICE
                .record_connected(&recorded, info)
                .await
            {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[Computer:Link] Could not record the connection"
                );
            }
        });
        let mut props = IndexMap::new();
        if let Some(agent_id) = CONFIG.agent_id() {
            props.insert("agent.id".to_string(), agent_id);
        }
        props.insert("computer.id".to_string(), id.to_string());
        props.insert("platform".to_string(), hello.platform.as_str().to_string());
        props.insert("client.version".to_string(), hello.client.version.clone());
        track_event(
            "computer connected",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
        log_info!(
            "[Computer:Link] {} connected ({}, client {})",
            row.name,
            hello.platform.as_str(),
            hello.client.version
        );
    }

    /// `local.hold` or `local.release` from the person at the computer. A link that was
    /// replaced or closed speaks for nobody at the computer any more.
    async fn presence(
        &self,
        id: &str,
        method: &str,
        current: Option<&Arc<RemoteComputer>>,
    ) -> anyhow::Result<()> {
        let Some(current) = current else {
            return Ok(());
        };
        if !COMPUTER_SERVICE.is_linked(id, current) {
            return Ok(());
        }
        if method == "local.hold" {
            return self.hold(id, current).await;
        }
        match COMPUTER_SERVICE.session(id) {
            Some(session) => session.release_locally().await,
            None => Ok(()),
        }
    }

    /// The link ended: the computer is no longer linked, and its end is recorded.
    fn ended(&self, number: u64, id: &str, served: &Arc<Mutex<Served>>, code: u16) {
        self.sockets.lock().remove(&number);
        let (remote, unwatch, since) = {
            let mut state = served.lock();
            if let Some(deadline) = state.deadline.take() {
                deadline.abort();
            }
            (state.remote.take(), state.unwatch.take(), state.since)
        };
        let Some(remote) = remote else {
            return;
        };
        if let Some(unwatch) = unwatch {
            unwatch();
        }
        COMPUTER_SERVICE.unlinked(id, &remote);
        let stopping = Arc::clone(&remote);
        tokio::spawn(async move {
            let _ = crate::services::computer::computer::Computer::stop(&*stopping).await;
        });
        let seen = id.to_string();
        tokio::spawn(async move {
            if let Err(err) = REMOTE_COMPUTER_SERVICE.record_seen(&seen).await {
                log_warn!(
                    json!({ "err": err_json(&err) }),
                    "[Computer:Link] Could not record the disconnection"
                );
            }
        });
        let mut props = IndexMap::new();
        if let Some(agent_id) = CONFIG.agent_id() {
            props.insert("agent.id".to_string(), agent_id);
        }
        props.insert("computer.id".to_string(), id.to_string());
        props.insert(
            "reason".to_string(),
            close_reason(code).unwrap_or("closed").to_string(),
        );
        props.insert("elapsed_ms".to_string(), (now_ms() - since).to_string());
        track_event(
            "computer disconnected",
            Some(&CONFIG.owner_user_id()),
            Some(props),
        );
        log_info!("[Computer:Link] {} disconnected ({})", remote.name(), code);
    }

    /// The person at the computer takes it: secure while a help request waits on it.
    async fn hold(&self, id: &str, remote: &Arc<RemoteComputer>) -> anyhow::Result<()> {
        let Some(session) = COMPUTER_SERVICE.session(id) else {
            return Ok(());
        };
        let Some(agent_id) = CONFIG.agent_id() else {
            return Ok(());
        };
        let waiting = COMPUTER_HELP_SERVICE
            .waiting(&agent_id, &CONFIG.owner_user_id())
            .await?;
        // The link can end during the read, and then there is nobody left to release the hold.
        if !COMPUTER_SERVICE.is_linked(id, remote) {
            return Ok(());
        }
        let help = waiting
            .iter()
            .find(|help| help.computer_id.as_deref() == Some(id))
            .map(|help| help.id.as_str());
        session.hold_locally(help).await
    }

    /// Tell the client who is using its computer and what help it waits for, whenever that
    /// changes. A burst of changes is read once, after the tick that made them. Answers what
    /// stops the reports.
    fn report_state(&'static self, id: &str, link: Arc<ComputerLink>) -> Box<dyn FnOnce() + Send> {
        let reports = Arc::new(Mutex::new(Reports::default()));
        let (id, link): (String, Weak<ComputerLink>) = (id.to_string(), Arc::downgrade(&link));
        let build: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            {
                let mut state = reports.lock();
                if state.building {
                    state.again = true;
                    return;
                }
                state.building = true;
            }
            let (reports, id, link) = (Arc::clone(&reports), id.clone(), link.clone());
            tokio::spawn(async move {
                loop {
                    reports.lock().again = false;
                    tokio::task::yield_now().await;
                    let state = match self.state_of(&id).await {
                        Ok(state) => state,
                        Err(err) => {
                            log_warn!(
                                json!({ "err": err_json(&err) }),
                                "[Computer:Link] Could not read the computer state"
                            );
                            reports.lock().building = false;
                            return;
                        }
                    };
                    let value = serde_json::to_value(&state).unwrap_or_default();
                    let text = js::stringify(&value);
                    if let Some(link) = link.upgrade()
                        && state.is_some()
                        && link.open()
                    {
                        let mut kept = reports.lock();
                        if text != kept.last {
                            kept.last = text;
                            drop(kept);
                            link.notify("computer.state", Some(value));
                        }
                    }
                    let mut kept = reports.lock();
                    if !kept.again {
                        kept.building = false;
                        return;
                    }
                }
            });
        });
        let listener = COMPUTER_SERVICE.on_change(Arc::clone(&build));
        build();
        Box::new(move || COMPUTER_SERVICE.off_change(listener))
    }

    async fn state_of(&self, id: &str) -> anyhow::Result<Option<ComputerLinkState>> {
        let Some(session) = COMPUTER_SERVICE.session(id) else {
            return Ok(None);
        };
        let Some(agent_id) = CONFIG.agent_id() else {
            return Ok(None);
        };
        let owner = session.access.owner();
        let help = COMPUTER_HELP_SERVICE
            .waiting(&agent_id, &CONFIG.owner_user_id())
            .await?
            .into_iter()
            .find(|item| item.computer_id.as_deref() == Some(id));
        let title = match owner.as_ref().and_then(|owner| owner.thread_id.clone()) {
            Some(thread_id) => {
                crate::db::run(move |conn| {
                    Ok(conversation_threads::table
                        .find(&thread_id)
                        .select(conversation_threads::title)
                        .first::<Option<String>>(conn)
                        .optional()?
                        .flatten())
                })
                .await?
            }
            None => None,
        };
        Ok(Some(ComputerLinkState {
            agent_active: owner.is_some(),
            watched: session.watched(),
            controller: session.controller(),
            owner: owner.map(|owner| LinkStateOwner {
                thread_id: owner.thread_id.clone(),
                mode: owner.mode.clone(),
                title: title.filter(|title| !title.is_empty()),
            }),
            help: help.map(|help| LinkStateHelp {
                id: help.id,
                reason: help.reason,
            }),
        }))
    }

    /// Stop taking links; called from the process shutdown path, after the links close.
    /// Closes every link with 1001 (`runtime shutting down`).
    pub fn close(&self) {
        let links: Vec<Arc<ComputerLink>> = self
            .sockets
            .lock()
            .values()
            .map(|socket| Arc::clone(&socket.link))
            .collect();
        for link in links {
            link.close(LINK_CLOSE.shutting_down, "runtime shutting down");
        }
        if let Some(liveness) = self.liveness.lock().take() {
            liveness.abort();
        }
        self.accepting.store(false, Ordering::SeqCst);
    }
}

impl Default for ComputerLinkEndpoint {
    fn default() -> Self {
        ComputerLinkEndpoint::new()
    }
}

#[cfg(test)]
mod tests;
