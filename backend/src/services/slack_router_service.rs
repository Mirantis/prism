//! Slack Router Service
//!
//! In routed mode a router outside the runtime receives Slack's events for a
//! shared Slack app and delivers each one meant for this agent as an envelope
//! (`slack_router_envelope.rs`). This service owns the listener the envelopes
//! arrive on (`SLACK_PORT`, bound to `PRISM_HOST`) and what happens to an
//! envelope before the router gets its answer.
//!
//! - An envelope sent more than five minutes from this clock, or one whose
//!   `eventId` was accepted before, is answered and not applied. A retry that
//!   arrives while the first attempt still runs gets that attempt's answer.
//! - A link or a connection change is applied before the answer, so the
//!   router's retry covers a failure.
//! - A Slack event is recorded in `pending_work` before the answer and handled
//!   after it. The record ends once a stored message holds the event, or once
//!   the event is handled, so a restart before then handles it again.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::CONFIG;
use crate::lib::log_redaction::err_json;
use crate::routes::slack_router::create_slack_router_app;
use crate::services::pending_work_service::{
    PENDING_WORK_SERVICE, PendingWorkItem, PendingWorkKind,
};
use crate::services::slack_router_envelope::{
    RoutedLink, RouterEnvelope, SlackEnvelope, parse_router_envelope,
};
use crate::{log_error, log_info, log_warn};

/// How far an envelope's `sentAt` may be from this clock.
const ENVELOPE_MAX_SKEW_MS: i64 = 5 * 60_000;

/// How long an accepted event id is remembered. The router retries an event for
/// about ten minutes, and each attempt is sent at most `ENVELOPE_MAX_SKEW_MS`
/// before it arrives.
const SEEN_EVENT_TTL_MS: i64 = 15 * 60_000;

/// What the route answers: 200 for `Accepted` and `Dropped`, else 400 or 503.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouterOutcome {
    Accepted,
    Dropped,
    Invalid,
    Unavailable,
}

/// Ends a routed event's `pending_work` record once a stored message holds the
/// event. Only the first call ends it.
#[derive(Clone)]
pub struct HandOff {
    event_id: String,
    done: Arc<AtomicBool>,
}

impl HandOff {
    fn new(event_id: &str) -> Self {
        HandOff {
            event_id: event_id.to_string(),
            done: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The hand-off ends the record even during a shutdown, since the stored
    /// message holds the event from then on.
    pub fn hand_off(&self) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        PENDING_WORK_SERVICE.finish(PendingWorkKind::RoutedEvent, self.event_id.as_str());
    }

    fn handed_off(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
}

/// What the Slack adapter does with each kind of envelope.
#[async_trait]
pub trait SlackRouterHandlers: Send + Sync {
    /// Validate the token again and start the workspace's app. Answers whether
    /// `team_id` is connected.
    async fn connect(&self, team_id: &str) -> anyhow::Result<bool>;
    async fn disconnect(&self) -> anyhow::Result<()>;
    async fn link(&self, team_id: &str, link: &RoutedLink) -> anyhow::Result<()>;
    /// Whether an event of `team_id` can be handled now. Connects when no app
    /// runs for the team.
    async fn ready(&self, team_id: &str) -> anyhow::Result<bool>;
    /// Handle a Slack event. `hand_off` ends its record once a stored message
    /// holds it.
    async fn handle(&self, envelope: SlackEnvelope, hand_off: HandOff) -> anyhow::Result<()>;
}

type Attempt = Shared<BoxFuture<'static, Result<RouterOutcome, Arc<anyhow::Error>>>>;

struct Listener {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
    addr: SocketAddr,
}

#[derive(Default)]
struct RouterState {
    /// Event ids accepted in the last `SEEN_EVENT_TTL_MS`, oldest first, with
    /// the time each was accepted. Kept in memory: an event whose record ended
    /// before a restart is handled again when it arrives after the restart,
    /// which takes a lost answer and a restart inside the router's retry window.
    ///
    /// For `link`, `connected` and `disconnected` this map is the only dedupe.
    /// The protocol asks the router not to send a link envelope again once a
    /// later one for the same DM or channel was accepted.
    seen: IndexMap<String, i64>,
    /// The attempts still being applied, by event id. An id moves to `seen`
    /// only once its attempt is accepted, so a failed attempt leaves the retry
    /// open.
    in_flight: HashMap<String, Attempt>,
}

pub struct SlackRouterService {
    handlers: RwLock<Option<Arc<dyn SlackRouterHandlers>>>,
    listener: Mutex<Option<Listener>>,
    state: Arc<Mutex<RouterState>>,
}

impl SlackRouterService {
    pub fn new() -> Self {
        SlackRouterService {
            handlers: RwLock::new(None),
            listener: Mutex::new(None),
            state: Arc::new(Mutex::new(RouterState::default())),
        }
    }

    /// Open the listener on `SLACK_PORT`, which hands each envelope it accepts
    /// to `handlers`.
    pub async fn start(
        &'static self,
        handlers: Arc<dyn SlackRouterHandlers>,
    ) -> anyhow::Result<()> {
        let port = CONFIG.slack_port.clone().map_err(anyhow::Error::msg)?;
        self.listen(handlers, &CONFIG.host, port).await
    }

    async fn listen(
        &'static self,
        handlers: Arc<dyn SlackRouterHandlers>,
        host: &str,
        port: u16,
    ) -> anyhow::Result<()> {
        *self.handlers.write() = Some(handlers);
        if self.listener.lock().is_some() {
            return Ok(());
        }
        let listener = tokio::net::TcpListener::bind((host, port)).await?;
        let addr = listener.local_addr()?;
        let router = create_slack_router_app(Arc::new(move |body| self.accept(body).boxed()));
        let shutdown = CancellationToken::new();
        let token = shutdown.clone();
        let task = tokio::spawn(async move {
            if let Err(err) = crate::support::http::serve(listener, router, token).await {
                log_error!(
                    json!({ "err": err_json(&anyhow::Error::from(err)) }),
                    "[SlackRouter] Listener error"
                );
            }
        });
        *self.listener.lock() = Some(Listener {
            shutdown,
            task,
            addr,
        });
        log_info!(
            json!({ "port": addr.port(), "host": host }),
            "[SlackRouter] Listening for the Slack router"
        );
        Ok(())
    }

    /// Test-only: the handlers `start` would set, without a listener.
    #[cfg(test)]
    pub(crate) fn set_handlers(&self, handlers: Option<Arc<dyn SlackRouterHandlers>>) {
        *self.handlers.write() = handlers;
    }

    /// The address the listener is bound to, while it runs.
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.listener.lock().as_ref().map(|listener| listener.addr)
    }

    pub async fn stop(&self) {
        *self.handlers.write() = None;
        let listener = self.listener.lock().take();
        if let Some(listener) = listener {
            listener.shutdown.cancel();
            let _ = listener.task.await;
        }
    }

    pub async fn accept(&self, body: Value) -> anyhow::Result<RouterOutcome> {
        let handlers = self.handlers.read().clone();
        let Some(handlers) =
            handlers.filter(|_| !PENDING_WORK_SERVICE.shutdown_signal().is_cancelled())
        else {
            return Ok(RouterOutcome::Unavailable);
        };

        let envelope = match parse_router_envelope(&body) {
            Ok(envelope) => envelope,
            Err(reason) => {
                log_warn!(
                    json!({ "reason": reason }),
                    "[SlackRouter] Refused an envelope that does not match the schema"
                );
                return Ok(RouterOutcome::Invalid);
            }
        };
        let sent_at = chrono::DateTime::parse_from_rfc3339(envelope.sent_at())
            .map(|at| at.timestamp_millis())
            .unwrap_or_default();
        let now = chrono::Utc::now().timestamp_millis();
        if (now - sent_at).abs() > ENVELOPE_MAX_SKEW_MS {
            log_warn!(
                json!({ "eventId": envelope.event_id(), "kind": envelope.kind() }),
                "[SlackRouter] Dropped an envelope sent more than five minutes from this clock"
            );
            return Ok(RouterOutcome::Dropped);
        }

        let event_id = envelope.event_id().to_string();
        let attempt = {
            let mut state = self.state.lock();
            forget_old_events(&mut state.seen, now);
            if state.seen.contains_key(&event_id) {
                log_info!(
                    json!({ "eventId": event_id }),
                    "[SlackRouter] Dropped an envelope accepted before"
                );
                return Ok(RouterOutcome::Dropped);
            }
            // A retry sent while the first attempt still runs gets that
            // attempt's answer, so a failure of the first attempt still reaches
            // the router.
            if let Some(running) = state.in_flight.get(&event_id) {
                log_info!(
                    json!({ "eventId": event_id }),
                    "[SlackRouter] Answering a retry with the attempt still running"
                );
                running.clone()
            } else {
                let shared_state = self.state.clone();
                let id = event_id.clone();
                // The attempt records its own outcome before anyone reads it.
                let attempt: Attempt = async move {
                    let outcome = apply(envelope, handlers).await.map_err(Arc::new);
                    let mut state = shared_state.lock();
                    state.in_flight.remove(&id);
                    if matches!(
                        outcome,
                        Ok(RouterOutcome::Accepted | RouterOutcome::Dropped)
                    ) {
                        state.seen.insert(id, chrono::Utc::now().timestamp_millis());
                    }
                    outcome
                }
                .boxed()
                .shared();
                state.in_flight.insert(event_id.clone(), attempt.clone());
                // It runs to the end even when the request that started it is gone.
                tokio::spawn(attempt.clone());
                attempt
            }
        };
        let outcome = attempt.await;
        outcome.map_err(|err| anyhow::anyhow!("{:#}", err))
    }

    /// Handle the Slack events a restart interrupted. Called at boot, after the
    /// adapter has started; with no handlers this runtime is not routed any
    /// more, and the events have nowhere to go.
    pub async fn resume(&self, items: Vec<PendingWorkItem>) -> anyhow::Result<()> {
        let handlers = self.handlers.read().clone();
        for item in items {
            let parsed = parse_router_envelope(&item.payload);
            let (Some(handlers), Ok(RouterEnvelope::Slack(envelope))) = (handlers.clone(), parsed)
            else {
                PENDING_WORK_SERVICE.end(PendingWorkKind::RoutedEvent, item.key.as_str());
                continue;
            };
            // An event for a workspace with no app stays for the next boot.
            if !handlers.ready(&envelope.team_id).await? {
                continue;
            }
            self.state
                .lock()
                .seen
                .insert(item.key.clone(), chrono::Utc::now().timestamp_millis());
            tokio::spawn(handle(envelope, handlers));
        }
        Ok(())
    }
}

impl Default for SlackRouterService {
    fn default() -> Self {
        Self::new()
    }
}

async fn apply(
    envelope: RouterEnvelope,
    handlers: Arc<dyn SlackRouterHandlers>,
) -> anyhow::Result<RouterOutcome> {
    match envelope {
        RouterEnvelope::Connected { workspace, .. } => {
            Ok(if handlers.connect(&workspace.team_id.0).await? {
                RouterOutcome::Accepted
            } else {
                RouterOutcome::Unavailable
            })
        }
        RouterEnvelope::Disconnected { .. } => {
            handlers.disconnect().await?;
            Ok(RouterOutcome::Accepted)
        }
        RouterEnvelope::Link { team_id, link, .. } => {
            handlers.link(&team_id, &link).await?;
            Ok(RouterOutcome::Accepted)
        }
        RouterEnvelope::Slack(envelope) => {
            if !handlers.ready(&envelope.team_id).await? {
                return Ok(RouterOutcome::Unavailable);
            }
            // A row left by a delivery before a restart is the same event.
            let claimed = PENDING_WORK_SERVICE
                .claim(
                    PendingWorkKind::RoutedEvent,
                    &envelope.event_id,
                    envelope.to_value(),
                )
                .await?;
            if !claimed {
                return Ok(RouterOutcome::Dropped);
            }
            tokio::spawn(handle(envelope, handlers));
            Ok(RouterOutcome::Accepted)
        }
    }
}

/// The end of the handling ends the record unless a shutdown cut it short,
/// so such an event is handled again at the next boot.
async fn handle(envelope: SlackEnvelope, handlers: Arc<dyn SlackRouterHandlers>) {
    let event_id = envelope.event_id.clone();
    let hand_off = HandOff::new(&event_id);
    if let Err(err) = handlers.handle(envelope, hand_off.clone()).await {
        log_error!(
            json!({ "err": err_json(&err), "eventId": event_id }),
            "[SlackRouter] Could not handle a Slack event"
        );
    }
    if !hand_off.handed_off() {
        PENDING_WORK_SERVICE.end(PendingWorkKind::RoutedEvent, event_id.as_str());
    }
}

fn forget_old_events(seen: &mut IndexMap<String, i64>, now: i64) {
    let oldest = now - SEEN_EVENT_TTL_MS;
    while let Some((_, accepted_at)) = seen.first() {
        if *accepted_at >= oldest {
            return;
        }
        seen.shift_remove_index(0);
    }
}

pub static SLACK_ROUTER_SERVICE: LazyLock<SlackRouterService> =
    LazyLock::new(SlackRouterService::new);

#[cfg(test)]
mod tests;
