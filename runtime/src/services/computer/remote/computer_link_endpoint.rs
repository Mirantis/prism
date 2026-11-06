//! `/api/computer-link`: where a remote computer's client holds its link open.
//!
//! The upgrade gets the origin rule every route on this server gets, so a client that is
//! not a browser, which sends no `Origin`, passes it; the platform in front of the runtime
//! authenticates the user. The client names its computer in `?computer=`, and its first
//! message is `initialize`. After that the runtime sends the requests, and the client
//! reports the person at the computer and changes to its displays and permissions.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};

use axum::extract::Request;
use axum::extract::ws::WebSocket;
use axum::response::Response;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use super::computer_link::ComputerLink;
use super::remote_computer::RemoteComputer;
use crate::services::computer::computer_session::Controller;

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

pub struct ComputerLinkEndpoint {
    /// The open links, by connection number.
    sockets: Mutex<HashMap<u64, LinkSocket>>,
    liveness: Mutex<Option<JoinHandle<()>>>,
}

pub static COMPUTER_LINK_ENDPOINT: LazyLock<ComputerLinkEndpoint> =
    LazyLock::new(ComputerLinkEndpoint::new);

impl ComputerLinkEndpoint {
    pub fn new() -> Self {
        ComputerLinkEndpoint {
            sockets: Mutex::new(HashMap::new()),
            liveness: Mutex::new(None),
        }
    }

    /// Serve `COMPUTER_LINK_PATH` through `websocket_upgrades` with frames of at most
    /// `MAX_LINK_FRAME_BYTES`, ping every link each `PING_INTERVAL_SECONDS` and end one that
    /// did not answer the last ping, and log `[Computer:Link] Listening on
    /// /api/computer-link`.
    pub fn initialize(&'static self) {
        todo!()
    }

    /// One upgrade to `COMPUTER_LINK_PATH`: a refused origin answers 403 (logged as
    /// `[Computer:Link] refused a handshake (origin …, host …)`), and a `?computer=` that
    /// names no computer 404.
    pub async fn handle_upgrade(&'static self, req: Request) -> Response {
        todo!()
    }

    /// Serve one link for computer `id`: `initialize` first, within
    /// `INITIALIZE_TIMEOUT_MS`, then the person at the computer (`local.hold`,
    /// `local.release`, in the order they arrive), and the end of the link.
    async fn serve(&'static self, ws: WebSocket, id: String) {
        todo!()
    }

    /// The person at the computer takes it: secure while a help request waits on it.
    async fn hold(&self, id: &str, remote: &Arc<RemoteComputer>) -> anyhow::Result<()> {
        todo!()
    }

    /// Tell the client who is using its computer and what help it waits for, whenever that
    /// changes. A burst of changes is read once, after the tick that made them. Answers what
    /// stops the reports.
    fn report_state(&'static self, id: &str, link: Arc<ComputerLink>) -> Box<dyn FnOnce() + Send> {
        todo!()
    }

    async fn state_of(&self, id: &str) -> anyhow::Result<Option<ComputerLinkState>> {
        todo!()
    }

    /// Stop taking links; called from the process shutdown path, after the links close.
    /// Closes every link with 1001 (`runtime shutting down`).
    pub fn close(&self) {
        todo!()
    }
}

impl Default for ComputerLinkEndpoint {
    fn default() -> Self {
        ComputerLinkEndpoint::new()
    }
}
