//! Identity-Document Routes
//!
//! The user's write to one of the seven identity documents, its history, and the
//! restore of one revision:
//!
//!   PATCH /agents/documents/{field}                    — replace the document
//!   GET   /agents/documents/{field}/revisions          — the history, newest first
//!   GET   /agents/documents/{field}/revisions/{id}     — one revision, with content
//!   POST  /agents/documents/{field}/revisions/{id}/restore
//!
//! Each of these is the user acting, so locked-in mode does not gate them — that
//! lock withholds the agent's own writers.

use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{get, patch, post};
use serde::Serialize;
use serde_json::{Value, json};

use crate::db::models::AgentWorkspaceRevision;
use crate::lib::log_redaction::err_json;
use crate::lib::workspace_docs::WorkspaceDocField;
use crate::log_error;
use crate::services::agent_workspace_service::{
    AGENT_WORKSPACE_SERVICE, RollbackWorkspaceDocInput, RollbackWorkspaceDocResult, ValidationError,
};
use crate::services::document_revision_service::DOCUMENT_REVISION_SERVICE;
use crate::services::heartbeat_service::{HEARTBEAT_SERVICE, HeartbeatSchedule};
use crate::support::http::{JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new()
        .route("/agents/documents/{field}", patch(write_document))
        .route("/agents/documents/{field}/revisions", get(history))
        .route(
            "/agents/documents/{field}/revisions/{id}",
            get(read_revision),
        )
        .route(
            "/agents/documents/{field}/revisions/{id}/restore",
            post(restore_revision),
        )
}

/// The document a path segment names, or the 400 the handler answers:
/// `unknown identity document '<field>'`, so each handler reads the field or
/// returns.
fn read_field(field: &str) -> Result<WorkspaceDocField, Response> {
    WorkspaceDocField::parse(field)
        .ok_or_else(|| error_json(400, format!("unknown identity document '{field}'")))
}

/// A write or a restore of the heartbeat config changes what a heartbeat run
/// reads, so the timer is restarted from the stored row, the same as a tool write
/// does (`tools/agent_config.rs`). `keep-schedule` leaves the next check where
/// it is, since the document holds the checks and not the cadence. It happens here
/// rather than in the service, because the heartbeat service imports the invoke
/// path, which builds context through the workspace service.
async fn restart_heartbeat() {
    match AGENT_WORKSPACE_SERVICE.get_agent().await {
        Ok(agent) => HEARTBEAT_SERVICE.start_heartbeat(&agent, HeartbeatSchedule::KeepSchedule),
        Err(err) => log_error!(
            json!({ "err": err_json(&err) }),
            "[DocumentRevisions] Failed to restart the heartbeat"
        ),
    }
}

/// The body of a successful write: `{ field, content }`.
#[derive(Debug, Clone, Serialize)]
pub struct DocumentWritten {
    pub field: String,
    pub content: String,
}

/// The body of a successful restore: `{ field, content, revision }`.
#[derive(Debug, Clone, Serialize)]
pub struct DocumentRestored {
    pub field: String,
    pub content: String,
    /// The `rollback` revision the restore recorded.
    pub revision: AgentWorkspaceRevision,
}

/// The 409 of a restore that lost to a newer write.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleRestoreBody {
    /// `the document changed since this history was read`.
    pub error: String,
    pub newest_revision_id: Option<String>,
}

/// Log a failure with the field it was for, and answer 500 with its message.
fn failure(err: anyhow::Error, field: WorkspaceDocField, message: &str) -> Response {
    log_error!(
        json!({ "err": err_json(&err), "field": field.as_str() }),
        "{}",
        message
    );
    error_json(500, err.to_string())
}

/// PATCH /agents/documents/{field}
///
/// Body: `{ content: string, reason?: string }` — the whole document; an empty
/// string clears it, which drops that section from the prompt. `reason` is the
/// note the document's history shows for this write. There is no concurrency
/// control: the last write wins, so two editors open at once overwrite each other
/// instead of merging.
async fn write_document(Path(field): Path<String>, body: JsonBody) -> Response {
    let field = match read_field(&field) {
        Ok(field) => field,
        Err(response) => return response,
    };
    let Some(content) = body.field("content") else {
        return error_json(400, "missing required field 'content'");
    };
    let written = AGENT_WORKSPACE_SERVICE
        .update_workspace_doc(field, content, body.field("reason"))
        .await;
    match written {
        Ok(content) => {
            if field == WorkspaceDocField::HeartbeatMd {
                restart_heartbeat().await;
            }
            json(
                200,
                DocumentWritten {
                    field: field.as_str().to_string(),
                    content,
                },
            )
        }
        Err(err) => {
            if let Some(validation) = err.downcast_ref::<ValidationError>() {
                return error_json(400, validation.to_string());
            }
            failure(
                err,
                field,
                "[DocumentRevisions] Failed to write the document",
            )
        }
    }
}

/// GET /agents/documents/{field}/revisions
///
/// The history of one document, newest first, without the content of each
/// revision. `drifted` reports a document that no longer agrees with its newest
/// revision, which is what a write outside this path leaves behind.
async fn history(Path(field): Path<String>) -> Response {
    let field = match read_field(&field) {
        Ok(field) => field,
        Err(response) => return response,
    };
    let result = async {
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        DOCUMENT_REVISION_SERVICE.history(&agent, field).await
    }
    .await;
    match result {
        Ok(history) => json(200, history),
        Err(err) => failure(err, field, "[DocumentRevisions] Failed to read the history"),
    }
}

/// GET /agents/documents/{field}/revisions/{id}
///
/// One revision with its content, which is what the client compares two of.
async fn read_revision(Path((field, id)): Path<(String, String)>) -> Response {
    let field = match read_field(&field) {
        Ok(field) => field,
        Err(response) => return response,
    };
    let result = async {
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        let agent_id = agent.id;
        crate::db::read(move |conn| DOCUMENT_REVISION_SERVICE.get(conn, &agent_id, field, &id))
            .await
    }
    .await;
    match result {
        Ok(Some(revision)) => json(200, revision),
        Ok(None) => error_json(404, "revision not found"),
        Err(err) => failure(err, field, "[DocumentRevisions] Failed to read a revision"),
    }
}

/// POST /agents/documents/{field}/revisions/{id}/restore
///
/// Body: `{ expectedRevisionId: string, reason?: string }`.
///
/// `expectedRevisionId` is the newest revision the caller read. A write that
/// lands in between answers 409, so a restore never overwrites content the caller
/// has not seen — the read-modify-write in the agent's own document tools has no
/// such check, and a restore widens that window.
async fn restore_revision(Path((field, id)): Path<(String, String)>, body: JsonBody) -> Response {
    let field = match read_field(&field) {
        Ok(field) => field,
        Err(response) => return response,
    };
    let expected_revision_id = match body.field("expectedRevisionId") {
        Some(Value::String(id)) if !id.is_empty() => id.clone(),
        _ => return error_json(400, "missing required field 'expectedRevisionId'"),
    };
    let reason = match body.field("reason") {
        Some(Value::String(reason)) => reason.clone(),
        _ => String::new(),
    };
    let result = async {
        let agent = AGENT_WORKSPACE_SERVICE.get_agent().await?;
        AGENT_WORKSPACE_SERVICE
            .rollback_workspace_doc(RollbackWorkspaceDocInput {
                agent_id: agent.id,
                field,
                revision_id: id,
                expected_revision_id,
                reason,
            })
            .await
    }
    .await;
    match result {
        Ok(RollbackWorkspaceDocResult::RevisionNotFound) => error_json(404, "revision not found"),
        Ok(RollbackWorkspaceDocResult::Stale { newest_revision_id }) => json(
            409,
            StaleRestoreBody {
                error: "the document changed since this history was read".to_string(),
                newest_revision_id,
            },
        ),
        Ok(RollbackWorkspaceDocResult::Restored { content, revision }) => {
            if field == WorkspaceDocField::HeartbeatMd {
                restart_heartbeat().await;
            }
            json(
                200,
                DocumentRestored {
                    field: field.as_str().to_string(),
                    content,
                    revision,
                },
            )
        }
        Err(err) => failure(
            err,
            field,
            "[DocumentRevisions] Failed to restore a revision",
        ),
    }
}
