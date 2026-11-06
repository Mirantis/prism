//! Message routes.
//!
//! Root-mounted history replay. The runtime owns exactly one agent, so no agent id
//! appears in the path: the handler reads `config.agent_id`.
//!
//! - `GET /messages?limit=N&threadId&before`: `ConversationMessage[]` (`threadId`
//!   optional, defaults to the latest thread; `before` is a message id, and the
//!   page ends just before it)

use axum::Router;
use axum::extract::Query;
use axum::response::Response;
use axum::routing::get;
use serde::{Deserialize, Serialize};

/// The message routes, at the root (`/messages`).
pub fn router() -> Router {
    Router::new().route("/messages", get(list_messages))
}

/// The error body the handler answers with: `{ error }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: String,
}

/// The query of `GET /messages`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesQuery {
    /// Page size: `parseInt` of the text; a positive value is capped at
    /// `MAX_MESSAGE_PAGE`, anything else means 50.
    pub limit: Option<String>,
    /// Replay a specific thread (the resume flow), when a non-empty string.
    pub thread_id: Option<String>,
    /// A message id; the page ends just before it. Ignored when empty.
    pub before: Option<String>,
}

/// GET /messages
///
/// One page of a thread's history, oldest first with a tie broken by id (the order
/// every chat client keeps), each message with its shared-file metadata (no bytes)
/// so a client can render attachment chips: the value of
/// `ATTACHMENT_SERVICE.attach_meta_to_messages`. A page shorter than `limit` holds
/// the thread's first message.
///
/// With `threadId`, a cheap ownership check (no message load) answers 404
/// `Thread not found` when the thread does not belong to this agent and user;
/// without it, the latest thread (created when there is none). 503
/// `Agent not initialized (agentId unset)` without an agent id; 500 `{ error }` on
/// failure, logged as `[Messages] /messages failed`.
async fn list_messages(Query(query): Query<MessagesQuery>) -> Response {
    todo!()
}
