//! Heartbeat Delivery Route
//!
//! GET /agents/heartbeat/delivery — where a heartbeat run may post:
//! `{ deliverTo, channelIds }`.
//!
//! PATCH /agents/heartbeat/delivery — change `deliverTo` (a `DELIVER_TARGETS`
//! value) and `channelIds` (linked channels of that target's channel; `null`
//! clears them). An invalid value is refused with 400.

use axum::Json;
use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};

pub fn router() -> Router {
    Router::new().route(
        "/agents/heartbeat/delivery",
        get(get_heartbeat_delivery).patch(update_heartbeat_delivery),
    )
}

/// The body of `PATCH /agents/heartbeat/delivery`. Both fields go to
/// `AGENT_STATUS_SERVICE.update_heartbeat_delivery` as they came, of any JSON type;
/// the service checks them and its error text is answered 400.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDeliveryBody {
    /// A `DELIVER_TARGETS` value. Absent keeps the stored one.
    #[serde(default)]
    pub deliver_to: Option<serde_json::Value>,
    /// Linked channels of that target's channel. Absent keeps the stored list and
    /// `null` clears it, so the two are told apart.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub channel_ids: Option<Option<serde_json::Value>>,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// GET /agents/heartbeat/delivery
///
/// Sends `AGENT_STATUS_SERVICE.get_heartbeat_delivery()` (`{ deliverTo, channelIds }`)
/// unchanged. A failure is logged
/// (`[HeartbeatDelivery] Failed to read the heartbeat delivery`, with `err`) and
/// answers 500 with the error's message.
async fn get_heartbeat_delivery() -> Response {
    todo!()
}

/// PATCH /agents/heartbeat/delivery
///
/// A refusal from the service answers 400 `{ error }`. A write emits
/// `heartbeat delivery updated` (user `null`) with `agent.id` when
/// `config.agent_id` is set, `heartbeat.deliver_to` and `heartbeat.channels` (the
/// channel count as text), then sends the stored `{ deliverTo, channelIds }`. A
/// failure is logged (`[HeartbeatDelivery] Failed to update the heartbeat
/// delivery`, with `err`) and answers 500.
async fn update_heartbeat_delivery(Json(body): Json<HeartbeatDeliveryBody>) -> Response {
    todo!()
}
