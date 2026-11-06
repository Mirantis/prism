//! Inbound Webhook Route
//!
//! POST /agents/webhooks/{name} — the ingestion endpoint external systems
//! (Alertmanager, PagerDuty, GitHub, …) POST events to. Agent-mode
//! subscriptions are fire-and-forget: the route answers 202 with a runId and
//! the agent's response is delivered to the subscription's channels when the
//! run finishes. Deliver-only subscriptions publish synchronously (200).
//!
//! The webhook listener serves this router alone, on `WEBHOOK_PORT`
//! (`webhook_receiver_service.rs`, `create_webhook_app`). A subscription can require
//! its sender to prove itself with a token or an HMAC signature, which the service
//! verifies before doing any work (401 on failure). Subscription CRUD lives in
//! `routes/management.rs`, on the main port.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::head;
use serde::Serialize;

/// The webhook listener's JSON body limit (`express.json({ limit: '5mb' })`).
pub const WEBHOOK_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;

pub fn router() -> Router {
    Router::new().route(
        "/agents/webhooks/{name}",
        head(probe_webhook)
            .post(receive_webhook)
            .layer(DefaultBodyLimit::max(WEBHOOK_BODY_LIMIT_BYTES)),
    )
}

/// The body of a 200 or 202 answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookOutcome {
    /// `ignored`, `delivered` or `accepted`.
    pub status: String,
    /// The event name the service read off the delivery.
    pub event: String,
    /// The run's id, on `accepted` alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// HEAD /agents/webhooks/{name}
///
/// Some senders check the endpoint with a HEAD request before they save it.
/// Every name answers 200 with no body, so the check reveals no subscription
/// names.
async fn probe_webhook() -> Response {
    todo!()
}

/// POST /agents/webhooks/{name}
///
/// The body is read as raw bytes, because HMAC verification has to hash the exact
/// bytes the sender signed. Express parses it as JSON only for a JSON content type
/// (5 MB limit, objects and arrays only, malformed JSON answered 400 by the
/// parser) and keeps the raw buffer beside it; with any other content type the
/// parsed body and the raw body are both absent. A parsed body that is not a JSON
/// object answers 400 `Body must be a JSON object`.
///
/// A new UUIDv7 `runId` goes with the payload, the headers and the raw body to
/// `WEBHOOK_SERVICE.handle_inbound`. Every attempt emits `webhook received` (user
/// `null`) with `webhook.run_id` and `webhook.outcome` (`accepted` for accepted or
/// delivered, `filtered` for ignored, `unauthorized`, else `rejected`), plus
/// `webhook.auth_type` on `unauthorized` — the one owning emitter of that event.
///
/// Then: `receiver_disabled` 403 `Webhook receiver is disabled`; `not_found`,
/// `subscription_disabled` and `unauthorized` 401 `Webhook sender verification
/// failed`, hiding subscription names, state and verification failure reasons;
/// `busy` 429 `Webhook "<name>" run queue is full — retry later`; `ignored` and
/// `delivered` 200 `{ status, event }`; `accepted` 202 `{ status, event, runId }`.
/// A failure logs `[Webhook] Failed to handle inbound webhook '<name>': <message>`
/// and answers 500 with the message.
async fn receive_webhook(Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    todo!()
}
