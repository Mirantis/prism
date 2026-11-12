//! Message routes.
//!
//! Root-mounted history replay. The runtime owns exactly one agent, so no agent id
//! appears in the path: the handler reads `config.agent_id`.
//!
//! - `GET /messages?limit=N&threadId&before`: `ConversationMessage[]` (`threadId`
//!   optional, defaults to the latest thread; `before` is a message id, and the
//!   page ends just before it)

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde_json::json;

use crate::config::CONFIG;
use crate::constants::MAX_MESSAGE_PAGE;
use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::attachment_service::ATTACHMENT_SERVICE;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::support::http::{QueryParams, error_json, json};
use crate::support::js::parse_int;

/// The message routes, at the root (`/messages`).
pub fn router() -> Router {
    Router::new().route("/messages", get(list_messages))
}

/// The page size `?limit` asks for: a positive `parseInt` of its text capped at
/// `MAX_MESSAGE_PAGE`, anything else 50.
fn page_limit(raw: Option<String>) -> i64 {
    match parse_int(&raw.unwrap_or_default()) {
        Some(limit) if limit > 0 => limit.min(MAX_MESSAGE_PAGE),
        _ => 50,
    }
}

/// GET /messages
///
/// One page of a thread's history, oldest first with a tie broken by id (the order
/// every chat client keeps), each message with its shared-file metadata (no bytes)
/// so a client can render attachment chips. A page shorter than `limit` holds the
/// thread's first message.
///
/// With `threadId`, a cheap ownership check (no message load) answers 404
/// `Thread not found` when the thread does not belong to this agent and user;
/// without it, the latest thread (created when there is none).
async fn list_messages(query: QueryParams) -> Response {
    match messages_page(&query).await {
        Ok(response) => response,
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[Messages] /messages failed"
            );
            error_json(500, err.to_string())
        }
    }
}

async fn messages_page(query: &QueryParams) -> anyhow::Result<Response> {
    let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
        return Ok(error_json(503, "Agent not initialized (agentId unset)"));
    };
    let limit = page_limit(query.text("limit"));

    let thread_id = match query.str("threadId").filter(|id| !id.is_empty()) {
        Some(requested) => {
            let owned = CONVERSATION_SERVICE
                .get_owned_thread_id(&CONFIG.owner_user_id(), &agent_id, requested)
                .await?;
            match owned {
                Some(owned) => owned,
                None => return Ok(error_json(404, "Thread not found")),
            }
        }
        None => {
            CONVERSATION_SERVICE
                .get_or_create_latest_thread(&agent_id, &CONFIG.owner_user_id())
                .await?
                .id
        }
    };
    let before = query.str("before").filter(|before| !before.is_empty());
    let mut messages = CONVERSATION_SERVICE
        .get_recent_messages(&thread_id, limit, before)
        .await?;
    messages.sort_by(|a, b| {
        a.created_at
            .timestamp_millis()
            .cmp(&b.created_at.timestamp_millis())
            .then_with(|| a.id.cmp(&b.id))
    });
    let enriched = ATTACHMENT_SERVICE.attach_meta_to_messages(messages).await?;
    Ok(json(200, enriched))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_page_size_as_parse_int_does() {
        assert_eq!(page_limit(None), 50);
        assert_eq!(page_limit(Some("10".into())), 10);
        assert_eq!(page_limit(Some("10abc".into())), 10);
        assert_eq!(page_limit(Some("0".into())), 50);
        assert_eq!(page_limit(Some("-3".into())), 50);
        assert_eq!(page_limit(Some("abc".into())), 50);
        assert_eq!(page_limit(Some("100000".into())), MAX_MESSAGE_PAGE);
    }
}
