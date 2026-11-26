//! Presses on the buttons of the agent's generated UI. The first press wins; any later one gets the stored UI.
//!
//! - `POST /agents/generated-ui/{id}/press`

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::post;
use http::HeaderMap;
use serde_json::{Value, json};

use crate::config::CONFIG;
use crate::lib::forwarded_sender::sender_of;
use crate::protocol::chat_protocol::QuestionCardPerson;
use crate::services::generated_ui::generated_ui_service::{GENERATED_UI_SERVICE, PressOutcome};
use crate::support::http::{HandlerResult, JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new().route("/agents/generated-ui/{id}/press", post(press))
}

/// POST /agents/generated-ui/{id}/press
async fn press(Path(id): Path<String>, headers: HeaderMap, body: JsonBody) -> HandlerResult {
    let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
        return Ok(error_json(503, "Agent is not initialized."));
    };
    let body = body.or_empty();
    let Some(element_id) = body.get("elementId").and_then(Value::as_str) else {
        return Ok(error_json(400, "Name the button you pressed in elementId."));
    };
    let sender = sender_of(&headers).map(|sender| QuestionCardPerson {
        id: sender.id,
        name: sender.name,
    });
    let outcome = GENERATED_UI_SERVICE
        .press(&agent_id, &CONFIG.owner_user_id(), &id, element_id, sender)
        .await?;
    Ok(respond(outcome))
}

fn respond(outcome: PressOutcome) -> Response {
    match outcome {
        PressOutcome::NotFound => error_json(404, "That UI does not exist."),
        PressOutcome::Invalid(error) => error_json(400, error),
        PressOutcome::Closed(ui) => json(
            409,
            json!({ "error": "A button of this UI was already pressed.", "ui": ui }),
        ),
        PressOutcome::ReplyPending(ui) => json(202, json!({ "ui": ui, "replyPending": true })),
        PressOutcome::Pressed(ui) => json(200, json!({ "ui": ui })),
    }
}
