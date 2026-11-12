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
use axum::extract::Path;
use axum::http::{Extensions, HeaderMap};
use axum::response::Response;
use axum::routing::head;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::lib::raw_body::get_raw_body;
use crate::lib::telemetry::track_event;
use crate::log_error;
use crate::services::webhook_service::{WEBHOOK_SERVICE, WebhookInboundResult};
use crate::support::http::{JsonBody, empty, error_json, json};

/// The webhook listener's JSON body limit (`express.json({ limit: '5mb' })`).
pub const WEBHOOK_BODY_LIMIT_BYTES: usize = 5 * 1024 * 1024;

/// The webhook routes. The listener parses JSON bodies up to
/// `WEBHOOK_BODY_LIMIT_BYTES` and keeps the raw bytes
/// (`support::http::with_json_body` with `keeping_raw_body`).
pub fn router() -> Router {
    Router::new().route(
        "/agents/webhooks/{name}",
        head(probe_webhook).post(receive_webhook),
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

/// HEAD /agents/webhooks/{name}
///
/// Some senders check the endpoint with a HEAD request before they save it.
/// Every name answers 200, so the check reveals no subscription names.
async fn probe_webhook() -> Response {
    empty(200)
}

/// The `webhook.outcome` of a delivery.
fn outcome(result: &WebhookInboundResult) -> &'static str {
    match result {
        WebhookInboundResult::Accepted { .. } | WebhookInboundResult::Delivered { .. } => {
            "accepted"
        }
        WebhookInboundResult::Ignored { .. } => "filtered",
        WebhookInboundResult::Unauthorized { .. } => "unauthorized",
        _ => "rejected",
    }
}

/// POST /agents/webhooks/{name}
///
/// The parsed body has to be a JSON object (400 `Body must be a JSON object`).
/// A new UUIDv7 `runId` goes with the payload, the headers and the raw body the
/// sender signed to `WEBHOOK_SERVICE.handle_inbound`.
async fn receive_webhook(
    Path(name): Path<String>,
    headers: HeaderMap,
    extensions: Extensions,
    body: JsonBody,
) -> Response {
    let Some(Value::Object(payload)) = body.0 else {
        return error_json(400, "Body must be a JSON object");
    };

    let run_id = uuid::Uuid::now_v7().to_string();
    let raw_body = get_raw_body(&extensions);
    let result = WEBHOOK_SERVICE
        .handle_inbound(&name, &payload, &headers, &run_id, raw_body.as_deref())
        .await;
    let result = match result {
        Ok(result) => result,
        Err(err) => {
            let msg = err.to_string();
            log_error!(
                "[Webhook] Failed to handle inbound webhook '{}': {}",
                name,
                msg
            );
            return error_json(500, msg);
        }
    };

    // One owning emitter for 'webhook received' — every delivery attempt is
    // counted with its gate outcome. No user resolved on this hot path.
    let mut props = IndexMap::new();
    props.insert("webhook.run_id".to_string(), run_id.clone());
    props.insert("webhook.outcome".to_string(), outcome(&result).to_string());
    // Which scheme turned it away (generic: 'token' | 'hmac' | 'none'), so a
    // misconfigured secret is distinguishable from a probe.
    if let WebhookInboundResult::Unauthorized { auth_type } = &result {
        props.insert("webhook.auth_type".to_string(), auth_type.clone());
    }
    track_event("webhook received", None, Some(props));

    match result {
        WebhookInboundResult::ReceiverDisabled => error_json(403, "Webhook receiver is disabled"),
        // Hide subscription names, state and verification failure reasons.
        WebhookInboundResult::NotFound
        | WebhookInboundResult::SubscriptionDisabled
        | WebhookInboundResult::Unauthorized { .. } => {
            error_json(401, "Webhook sender verification failed")
        }
        WebhookInboundResult::Busy => error_json(
            429,
            format!("Webhook \"{name}\" run queue is full — retry later"),
        ),
        WebhookInboundResult::Ignored { event } => json(
            200,
            WebhookOutcome {
                status: "ignored".to_string(),
                event,
                run_id: None,
            },
        ),
        WebhookInboundResult::Delivered { event } => json(
            200,
            WebhookOutcome {
                status: "delivered".to_string(),
                event,
                run_id: None,
            },
        ),
        WebhookInboundResult::Accepted { event } => json(
            202,
            WebhookOutcome {
                status: "accepted".to_string(),
                event,
                run_id: Some(run_id),
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::http::testing::{TestResponse, request, send};
    use crate::support::http::{JsonOptions, finish, with_json_body};
    use serde_json::json;

    fn webhook_app() -> Router {
        with_json_body(
            finish(router()),
            JsonOptions::limit(WEBHOOK_BODY_LIMIT_BYTES).keeping_raw_body(),
        )
    }

    async fn call(method: &str, body: Option<Value>) -> TestResponse {
        send(
            webhook_app(),
            request(method, "/agents/webhooks/alerts", body),
        )
        .await
    }

    #[tokio::test]
    async fn answers_200_to_a_head_probe_for_any_name() {
        let res = call("HEAD", None).await;
        assert_eq!(res.status, 200);
        assert!(res.body.is_empty());
    }

    #[tokio::test]
    async fn refuses_a_body_that_is_not_an_object() {
        for body in [None, Some(json!([1, 2]))] {
            let res = call("POST", body).await;
            assert_eq!(res.status, 400);
            assert_eq!(res.json(), json!({ "error": "Body must be a JSON object" }));
        }
    }

    #[test]
    fn counts_each_outcome_under_its_gate_name() {
        let event = || "push".to_string();
        assert_eq!(
            outcome(&WebhookInboundResult::Accepted { event: event() }),
            "accepted"
        );
        assert_eq!(
            outcome(&WebhookInboundResult::Delivered { event: event() }),
            "accepted"
        );
        assert_eq!(
            outcome(&WebhookInboundResult::Ignored { event: event() }),
            "filtered"
        );
        assert_eq!(
            outcome(&WebhookInboundResult::Unauthorized {
                auth_type: "hmac".into()
            }),
            "unauthorized"
        );
        assert_eq!(outcome(&WebhookInboundResult::Busy), "rejected");
        assert_eq!(outcome(&WebhookInboundResult::NotFound), "rejected");
    }

    #[test]
    fn answers_accepted_with_the_run_id_and_others_without() {
        let accepted = serde_json::to_value(WebhookOutcome {
            status: "accepted".into(),
            event: "push".into(),
            run_id: Some("r1".into()),
        })
        .unwrap();
        assert_eq!(
            accepted,
            json!({ "status": "accepted", "event": "push", "runId": "r1" })
        );
        let ignored = serde_json::to_value(WebhookOutcome {
            status: "ignored".into(),
            event: "push".into(),
            run_id: None,
        })
        .unwrap();
        assert_eq!(ignored, json!({ "status": "ignored", "event": "push" }));
    }
}
