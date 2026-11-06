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

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{get, patch, post};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::models::AgentWorkspaceRevision;
use crate::lib::workspace_docs::WorkspaceDocField;

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
    todo!()
}

/// A write or a restore of the heartbeat config changes what a heartbeat run
/// reads, so the timer is restarted from the stored row, the same as a tool write
/// does (`tools/agent_config.rs`). `keep-schedule` leaves the next check where
/// it is, since the document holds the checks and not the cadence. It happens here
/// rather than in the service, because the heartbeat service imports the invoke
/// path, which builds context through the workspace service. A failure is logged
/// (`[DocumentRevisions] Failed to restart the heartbeat`, with `err`) and not
/// answered.
async fn restart_heartbeat() {
    todo!()
}

/// The body of `PATCH /agents/documents/{field}`: `{ content: string, reason?: string }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocumentBody {
    /// The whole document. Outer `None`: the key is missing, answered 400
    /// `missing required field 'content'`. A present value of any JSON type
    /// (`null` included) goes to `update_workspace_doc`, which checks it.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub content: Option<Option<Value>>,
    /// The note the history shows for this write, passed on as it came.
    #[serde(default)]
    pub reason: Option<Value>,
}

/// The body of `POST /agents/documents/{field}/revisions/{id}/restore`:
/// `{ expectedRevisionId: string, reason?: string }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBody {
    /// The newest revision the caller read. Anything but a non-empty string
    /// answers 400 `missing required field 'expectedRevisionId'`.
    #[serde(default)]
    pub expected_revision_id: Option<Value>,
    /// A string is kept; any other value reads as `''`.
    #[serde(default)]
    pub reason: Option<Value>,
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

/// `{ error }`, the body of every other refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// PATCH /agents/documents/{field}
///
/// Body: `{ content: string, reason?: string }` — the whole document; an empty
/// string clears it, which drops that section from the prompt. `reason` is the
/// note the document's history shows for this write. There is no concurrency
/// control: the last write wins, so two editors open at once overwrite each other
/// instead of merging.
///
/// A write of `heartbeatMd` restarts the heartbeat before the answer. A
/// `ValidationError` answers 400 with its message; any other failure is logged
/// (`[DocumentRevisions] Failed to write the document`, with `err` and `field`)
/// and answers 500.
async fn write_document(
    Path(field): Path<String>,
    Json(body): Json<WriteDocumentBody>,
) -> Response {
    todo!()
}

/// GET /agents/documents/{field}/revisions
///
/// The history of one document, newest first, without the content of each
/// revision: `DOCUMENT_REVISION_SERVICE.history(agent, field)` sent unchanged.
/// `drifted` reports a document that no longer agrees with its newest revision,
/// which is what a write outside this path leaves behind. A failure is logged
/// (`[DocumentRevisions] Failed to read the history`, with `err` and `field`) and
/// answers 500.
async fn history(Path(field): Path<String>) -> Response {
    todo!()
}

/// GET /agents/documents/{field}/revisions/{id}
///
/// One revision with its content, which is what the client compares two of:
/// `DOCUMENT_REVISION_SERVICE.get(agent_id, field, id)` sent unchanged, or 404
/// `revision not found`. A failure is logged
/// (`[DocumentRevisions] Failed to read a revision`, with `err` and `field`) and
/// answers 500.
async fn read_revision(Path((field, id)): Path<(String, String)>) -> Response {
    todo!()
}

/// POST /agents/documents/{field}/revisions/{id}/restore
///
/// Body: `{ expectedRevisionId: string, reason?: string }`.
///
/// `expectedRevisionId` is the newest revision the caller read. A write that
/// lands in between answers 409, so a restore never overwrites content the caller
/// has not seen — the read-modify-write in the agent's own document tools has no
/// such check, and a restore widens that window.
///
/// `rollback_workspace_doc` answers `revision_not_found` (404 `revision not
/// found`), `stale` (409 `StaleRestoreBody`) or `restored`. A restore of
/// `heartbeatMd` restarts the heartbeat before the answer. A failure is logged
/// (`[DocumentRevisions] Failed to restore a revision`, with `err` and `field`) and
/// answers 500.
async fn restore_revision(
    Path((field, id)): Path<(String, String)>,
    Json(body): Json<RestoreBody>,
) -> Response {
    todo!()
}
