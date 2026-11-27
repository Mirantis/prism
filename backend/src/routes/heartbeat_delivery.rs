//! Heartbeat Delivery Route
//!
//! GET /agents/heartbeat/delivery — where a heartbeat run may post:
//! `{ deliverTo, channelIds }`.
//!
//! PATCH /agents/heartbeat/delivery — change `deliverTo` (a `DELIVER_TARGETS`
//! value) and `channelIds` (linked channels of that target's channel; `null`
//! clears them). An invalid value is refused with 400.

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::{agent_props, track_event};
use crate::log_error;
use crate::services::agent_status_service::{AGENT_STATUS_SERVICE, HeartbeatDeliveryChanges};
use crate::support::http::{JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new().route(
        "/agents/heartbeat/delivery",
        get(get_heartbeat_delivery).patch(update_heartbeat_delivery),
    )
}

async fn get_heartbeat_delivery() -> Response {
    match AGENT_STATUS_SERVICE.get_heartbeat_delivery().await {
        Ok(delivery) => json(200, delivery),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[HeartbeatDelivery] Failed to read the heartbeat delivery"
            );
            error_json(500, err.to_string())
        }
    }
}

/// `deliverTo` and `channelIds` go to the service as they came, of any JSON
/// type; an absent key keeps the stored value, and `null` channels clear the list.
async fn update_heartbeat_delivery(body: JsonBody) -> Response {
    let changes = HeartbeatDeliveryChanges {
        deliver_to: body.field("deliverTo").cloned(),
        channel_ids: body.field("channelIds").cloned(),
    };
    let result = match AGENT_STATUS_SERVICE
        .update_heartbeat_delivery(changes)
        .await
    {
        Ok(result) => result,
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[HeartbeatDelivery] Failed to update the heartbeat delivery"
            );
            return error_json(500, err.to_string());
        }
    };
    let delivery = match result {
        Ok(delivery) => delivery,
        Err(refusal) => return error_json(400, refusal),
    };
    let mut props = agent_props();
    props.insert(
        "heartbeat.deliver_to".to_string(),
        delivery.deliver_to.clone(),
    );
    props.insert(
        "heartbeat.channels".to_string(),
        delivery.channel_ids.len().to_string(),
    );
    track_event("heartbeat delivery updated", None, Some(props));
    json(200, delivery)
}
