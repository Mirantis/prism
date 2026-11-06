//! Thread routes.
//!
//! Root-mounted endpoints to resolve, list, and open threads. The runtime owns
//! exactly one agent, so no agent id appears in the path: every handler reads
//! `config.agent_id`.
//!
//! - `GET  /latest-thread`: `{ threadId }`
//! - `GET  /threads`: `ThreadSummary[]` (resumable threads, newest first)
//! - `POST /threads`: `{ threadId }` (starts a new thread)

use axum::Json;
use axum::Router;
use axum::response::Response;
use axum::routing::{get, post};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::lib::context_window::ContextUsageSnapshot;

/// The thread routes, at the root (`/latest-thread`, `/threads`).
pub fn router() -> Router {
    Router::new()
        .route("/latest-thread", get(latest_thread))
        .route("/threads", get(list_threads))
        .route("/threads", post(start_thread))
}

/// The error body every handler here answers with: `{ error }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: String,
}

/// `{ threadId }`, the answer of `GET /latest-thread` and `POST /threads`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdResponse {
    pub thread_id: String,
}

/// One row of `GET /threads`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: Option<String>,
    #[serde(with = "crate::support::serde_iso")]
    pub updated_at: DateTime<Utc>,
    pub workspace_root: Option<String>,
    /// The git branch of `workspace_root`, or null when it has none or is unset.
    pub branch: Option<String>,
    /// The thread's context percentage, so a resumed session can show it without
    /// waiting for the first turn of that thread to complete.
    pub context_usage: Option<ContextUsageSnapshot>,
}

/// The body of `POST /threads`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartThreadBody {
    /// The directory the caller is rooted in, persisted on the new thread so shell
    /// tools can use it as their cwd. Ignored unless a non-empty string (after
    /// trimming); any other type is ignored too.
    pub workspace_root: Option<serde_json::Value>,
}

/// GET /latest-thread
///
/// The id of the owner's latest thread, created when there is none. 503
/// `Agent not initialized (agentId unset)` without an agent id; 500 `{ error }` on
/// failure, logged as `[Threads] /latest-thread failed`.
async fn latest_thread() -> Response {
    todo!()
}

/// GET /threads
///
/// Resumable threads only (newest first): `threadSource` DATABASE drops the threads
/// a channel reads live, which reopen only there. 50 bounds the response while
/// leaving a scrollable list plenty of rows. Each row is labelled with the git
/// branch of its workspace root when set, resolved once per unique root. Answers
/// `ThreadSummary[]`; 503 without an agent id; 500 `{ error }` on failure, logged as
/// `[Threads] GET /threads failed`.
async fn list_threads() -> Response {
    todo!()
}

/// POST /threads
///
/// Starts a new thread, with the optional `workspaceRoot` of the body, and answers
/// `{ threadId }`. The body is optional. 503 without an agent id; 500 `{ error }` on
/// failure, logged as `[Threads] POST /threads failed`.
async fn start_thread(body: Option<Json<StartThreadBody>>) -> Response {
    todo!()
}
