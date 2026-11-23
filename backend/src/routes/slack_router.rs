//! Slack router route.
//!
//! `POST /agents/slack/router`: where a Slack router delivers Slack events and
//! the agent's Slack links in routed mode. The `slack` listener
//! (`services/slack_router_service.rs`) serves this route alone, on
//! `SLACK_PORT`.
//!
//! The ingress in front verifies the router's signature, removes any
//! `x-nexus-webhook-verified` the caller sent, and adds
//! `x-nexus-webhook-verified: 1`. A request without that header is refused
//! before its body is read.
//!
//! The header proves nothing on its own: anyone who reaches `SLACK_PORT` past
//! the ingress can send it. Only the ingress may reach the port, so it must not
//! be published without one (docs/slack-router-protocol.md, "The ingress").

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use futures::future::BoxFuture;
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde_json::{Value, json};

use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::slack_router_service::RouterOutcome;
use crate::support::http::{finish, json as respond};

pub const SLACK_ROUTER_PATH: &str = "/agents/slack/router";

/// The largest envelope the router sends.
const ENVELOPE_LIMIT_BYTES: usize = 1024 * 1024;

/// What the route hands each envelope body to.
pub type AcceptEnvelope =
    Arc<dyn Fn(Value) -> BoxFuture<'static, anyhow::Result<RouterOutcome>> + Send + Sync>;

/// The `slack` listener's app: the route, and JSON answers for a body it
/// cannot read.
pub fn create_slack_router_app(accept: AcceptEnvelope) -> Router {
    finish(
        Router::new()
            .route(SLACK_ROUTER_PATH, post(handle))
            .with_state(accept),
    )
}

async fn handle(State(accept): State<AcceptEnvelope>, headers: HeaderMap, body: Body) -> Response {
    let verified = headers
        .get("x-nexus-webhook-verified")
        .and_then(|value| value.to_str().ok());
    if verified != Some("1") {
        return respond(401, json!({ "ok": false, "error": "not_verified" }));
    }
    let Ok(bytes) = axum::body::to_bytes(body, ENVELOPE_LIMIT_BYTES).await else {
        return respond(413, json!({ "ok": false, "error": "too_large" }));
    };
    let is_json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
        });
    // A body without a JSON type is no envelope.
    let envelope = if is_json {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => return respond(400, json!({ "ok": false, "error": "invalid_envelope" })),
        }
    } else {
        Value::Null
    };
    match accept(envelope).await {
        Ok(RouterOutcome::Accepted | RouterOutcome::Dropped) => respond(200, json!({ "ok": true })),
        Ok(RouterOutcome::Invalid) => {
            respond(400, json!({ "ok": false, "error": "invalid_envelope" }))
        }
        Ok(RouterOutcome::Unavailable) => {
            respond(503, json!({ "ok": false, "error": "unavailable" }))
        }
        Err(error) => {
            log_error!(
                json!({ "err": err_json(&error) }),
                "[SlackRouter] Could not apply an envelope"
            );
            respond(500, json!({ "ok": false, "error": "internal_error" }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support::http::testing::{TestResponse, send};
    use futures::FutureExt;
    use parking_lot::Mutex;

    fn app(outcome: anyhow::Result<RouterOutcome>, seen: Arc<Mutex<Vec<Value>>>) -> Router {
        let outcome = Arc::new(Mutex::new(Some(outcome)));
        create_slack_router_app(Arc::new(move |body| {
            seen.lock().push(body);
            let next = outcome.lock().take().unwrap_or(Ok(RouterOutcome::Accepted));
            async move { next }.boxed()
        }))
    }

    async fn post(router: Router, body: &[u8], verified: bool) -> TestResponse {
        let mut request = http::Request::builder()
            .method("POST")
            .uri(SLACK_ROUTER_PATH)
            .header(CONTENT_TYPE, "application/json");
        if verified {
            request = request.header("x-nexus-webhook-verified", "1");
        }
        send(router, request.body(Body::from(body.to_vec())).unwrap()).await
    }

    #[tokio::test]
    async fn refuses_a_request_the_ingress_did_not_verify() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let response = post(app(Ok(RouterOutcome::Accepted), seen.clone()), b"{}", false).await;
        assert_eq!(response.status, 401);
        assert_eq!(
            response.json(),
            json!({ "ok": false, "error": "not_verified" })
        );
        assert!(seen.lock().is_empty());
    }

    #[tokio::test]
    async fn answers_each_outcome_in_the_route_shape() {
        let cases = [
            (Ok(RouterOutcome::Accepted), 200, json!({ "ok": true })),
            (Ok(RouterOutcome::Dropped), 200, json!({ "ok": true })),
            (
                Ok(RouterOutcome::Invalid),
                400,
                json!({ "ok": false, "error": "invalid_envelope" }),
            ),
            (
                Ok(RouterOutcome::Unavailable),
                503,
                json!({ "ok": false, "error": "unavailable" }),
            ),
            (
                Err(anyhow::anyhow!("db")),
                500,
                json!({ "ok": false, "error": "internal_error" }),
            ),
        ];
        for (outcome, status, body) in cases {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let response = post(app(outcome, seen.clone()), br#"{"kind":"x"}"#, true).await;
            assert_eq!(response.status, status);
            assert_eq!(response.json(), body);
            assert_eq!(seen.lock().as_slice(), &[json!({ "kind": "x" })]);
        }
    }

    #[tokio::test]
    async fn answers_a_malformed_or_oversized_body_without_applying_it() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let malformed = post(app(Ok(RouterOutcome::Accepted), seen.clone()), b"{", true).await;
        assert_eq!(malformed.status, 400);
        assert_eq!(malformed.json()["error"], "invalid_envelope");
        let big = vec![b' '; ENVELOPE_LIMIT_BYTES + 1];
        let oversized = post(app(Ok(RouterOutcome::Accepted), seen.clone()), &big, true).await;
        assert_eq!(oversized.status, 413);
        assert_eq!(oversized.json()["error"], "too_large");
        assert!(seen.lock().is_empty());
    }
}
