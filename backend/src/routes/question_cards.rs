//! Answers to the agent's question cards. The first answer wins; any later one gets the stored card.
//!
//! - `POST /agents/question-cards/{id}/answer`

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::post;
use http::HeaderMap;
use serde_json::json;

use crate::config::CONFIG;
use crate::lib::forwarded_sender::sender_of;
use crate::protocol::chat_protocol::QuestionCardPerson;
use crate::services::question_cards::question_card_schema::parse_answer_body;
use crate::services::question_cards::question_card_service::{
    AnswerOutcome, QUESTION_CARD_SERVICE,
};
use crate::support::http::{HandlerResult, JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new().route("/agents/question-cards/{id}/answer", post(answer))
}

/// POST /agents/question-cards/{id}/answer
async fn answer(Path(id): Path<String>, headers: HeaderMap, body: JsonBody) -> HandlerResult {
    let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
        return Ok(error_json(503, "Agent is not initialized."));
    };
    let Some(answers) = parse_answer_body(&body.or_empty()) else {
        return Ok(error_json(400, "Those answers do not fit the card."));
    };
    let sender = sender_of(&headers).map(|sender| QuestionCardPerson {
        id: sender.id,
        name: sender.name,
    });
    let outcome = QUESTION_CARD_SERVICE
        .answer(&agent_id, &CONFIG.owner_user_id(), &id, &answers, sender)
        .await?;
    Ok(respond(outcome))
}

fn respond(outcome: AnswerOutcome) -> Response {
    match outcome {
        AnswerOutcome::NotFound => error_json(404, "That question card does not exist."),
        AnswerOutcome::Invalid(error) => error_json(400, error),
        AnswerOutcome::Closed(card) => json(
            409,
            json!({ "error": "These questions are already closed.", "card": card }),
        ),
        AnswerOutcome::ReplyPending(card) => {
            json(202, json!({ "card": card, "replyPending": true }))
        }
        AnswerOutcome::Answered(card) => json(200, json!({ "card": card })),
    }
}
