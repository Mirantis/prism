//! Thread routes.
//!
//! Root-mounted endpoints to resolve, list, and open threads. The runtime owns
//! exactly one agent, so no agent id appears in the path: every handler reads
//! `config.agent_id`.
//!
//! - `GET  /latest-thread`: `{ threadId }`
//! - `GET  /threads`: `ThreadSummary[]` (resumable threads, newest first)
//! - `POST /threads`: `{ threadId }` (starts a new thread)

use std::collections::HashMap;

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use crate::config::CONFIG;
use crate::db::models::ThreadSource;
use crate::lib::context_window::{ContextUsageSnapshot, build_context_snapshot};
use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::conversation_service::{
    CONVERSATION_SERVICE, ListThreadsOptions, StartThreadOptions,
};
use crate::support::http::{JsonBody, error_json, json};
use crate::utils::git_branch::get_git_branch;

/// The thread routes, at the root (`/latest-thread`, `/threads`).
pub fn router() -> Router {
    Router::new()
        .route("/latest-thread", get(latest_thread))
        .route("/threads", get(list_threads).post(start_thread))
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

/// The agent id, or the 503 a request answers before boot has one.
fn agent_id() -> Result<String, Response> {
    CONFIG
        .agent_id()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error_json(503, "Agent not initialized (agentId unset)"))
}

/// The answer, or 500 `{ error }` logged under `message`.
fn answer(result: anyhow::Result<Response>, message: &str) -> Response {
    result.unwrap_or_else(|err| {
        log_error!(json!({ "err": err_json(&err) }), "{}", message);
        error_json(500, err.to_string())
    })
}

/// GET /latest-thread
///
/// The id of the owner's latest thread, created when there is none.
async fn latest_thread() -> Response {
    let agent_id = match agent_id() {
        Ok(id) => id,
        Err(response) => return response,
    };
    let result = async {
        let thread = CONVERSATION_SERVICE
            .get_or_create_latest_thread(&agent_id, &CONFIG.owner_user_id())
            .await?;
        Ok(json(
            200,
            ThreadIdResponse {
                thread_id: thread.id,
            },
        ))
    }
    .await;
    answer(result, "[Threads] /latest-thread failed")
}

/// GET /threads
///
/// Resumable threads only (newest first): `threadSource` DATABASE drops the threads
/// a channel reads live, which reopen only there. 50 bounds the response while
/// leaving a scrollable list plenty of rows. Each row is labelled with the git
/// branch of its workspace root when set.
async fn list_threads() -> Response {
    let agent_id = match agent_id() {
        Ok(id) => id,
        Err(response) => return response,
    };
    let result = async {
        let threads = CONVERSATION_SERVICE
            .list_threads(
                &CONFIG.owner_user_id(),
                &agent_id,
                Some(ListThreadsOptions {
                    thread_source: Some(ThreadSource::Database),
                    limit: Some(50),
                }),
            )
            .await?;
        // Resolve the git branch once per unique workspace root — many threads in
        // the same repo would otherwise each spawn a redundant `git` subprocess.
        let mut unique_roots: Vec<String> = Vec::new();
        for root in threads.iter().filter_map(|t| t.workspace_root.clone()) {
            if !root.is_empty() && !unique_roots.contains(&root) {
                unique_roots.push(root);
            }
        }
        let branches =
            futures::future::join_all(unique_roots.iter().map(|root| get_git_branch(root))).await;
        let branch_by_root: HashMap<String, Option<String>> =
            unique_roots.into_iter().zip(branches).collect();
        let summaries: Vec<ThreadSummary> = threads
            .into_iter()
            .map(|t| ThreadSummary {
                branch: t
                    .workspace_root
                    .as_ref()
                    .filter(|root| !root.is_empty())
                    .and_then(|root| branch_by_root.get(root).cloned().flatten()),
                // The thread's context percentage up front, so a resumed session can
                // show it without waiting for the first turn of that thread to complete.
                context_usage: build_context_snapshot(
                    &t.id,
                    t.context_model.as_deref(),
                    t.context_tokens,
                ),
                id: t.id,
                title: t.title,
                updated_at: t.updated_at,
                workspace_root: t.workspace_root,
            })
            .collect();
        Ok(json(200, summaries))
    }
    .await;
    answer(result, "[Threads] GET /threads failed")
}

/// POST /threads
///
/// Starts a new thread and answers `{ threadId }`. The body's optional
/// `workspaceRoot` is the directory the caller is rooted in, persisted on the new
/// thread so shell tools can use it as their cwd; it is ignored unless a
/// non-empty string after trimming.
async fn start_thread(body: JsonBody) -> Response {
    let agent_id = match agent_id() {
        Ok(id) => id,
        Err(response) => return response,
    };
    let workspace_root = match body.field("workspaceRoot") {
        Some(Value::String(raw)) if !crate::support::js::trim(raw).is_empty() => Some(raw.clone()),
        _ => None,
    };
    let result = async {
        let thread = CONVERSATION_SERVICE
            .start_new_thread(
                &agent_id,
                &CONFIG.owner_user_id(),
                workspace_root.map(|root| StartThreadOptions {
                    workspace_root: Some(root),
                }),
            )
            .await?;
        Ok(json(
            200,
            ThreadIdResponse {
                thread_id: thread.id,
            },
        ))
    }
    .await;
    answer(result, "[Threads] POST /threads failed")
}
