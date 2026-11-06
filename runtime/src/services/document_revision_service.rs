//! Identity-document revisions.
//!
//! Every accepted write to one of the seven identity documents appends one
//! snapshot to `agent_workspace_revisions`. The table is append-only: a restore
//! writes a new revision instead of removing the revisions after it, so no step
//! of the history is lost.
//!
//! A method that has to join the caller's transaction takes a connection as its
//! first argument, because the snapshot and the column write have to land or fail
//! together — see `AGENT_WORKSPACE_SERVICE.write_workspace_doc`. A method that owns
//! its own read opens none.

use std::collections::HashMap;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::SqliteConnection;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::db::models::{AgentWorkspace, AgentWorkspaceRevision};
use crate::lib::workspace_docs::{DocumentWriteActor, DocumentWriteMethod, WorkspaceDocField};

/// How many revisions one document keeps. The insert deletes anything older in
/// the same transaction, so the table is bounded at 500 revisions × 7 documents
/// per agent. A constant rather than a setting: no deployment needs a second
/// value, and every option is a fork in the code and a line in the docs.
///
/// The seed revision is a revision like any other, so a document written 500
/// times loses the content it was created with.
pub const MAX_REVISIONS_PER_DOCUMENT: i64 = 500;

/// Cap on the stored reason, in UTF-16 code units. A write is never refused over
/// the length of its own note.
const REASON_MAX_CHARS: usize = 500;

/// The reason recorded for the revisions a new agent is created with. It names
/// no source: a deployment may seed its own documents (`PRISM_WORKSPACE_SEED_DIR`).
pub const SEED_REASON: &str = "Created with the agent.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordRevisionInput {
    pub agent_id: String,
    pub field: WorkspaceDocField,
    pub content: String,
    pub actor: DocumentWriteActor,
    pub method: DocumentWriteMethod,
    pub reason: String,
}

/// One row of the history. The content is left out: a list of 500 revisions
/// carrying 500 whole documents is the wrong response, and the client reads the
/// content of the two revisions it compares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRevisionSummary {
    pub id: String,
    pub actor: String,
    pub method: String,
    pub reason: String,
    #[serde(with = "crate::support::serde_iso")]
    pub created_at: DateTime<Utc>,
    /// True while this revision holds exactly what the document reads now.
    pub matches_current: bool,
}

/// The history of one document, and whether the document still agrees with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentHistory {
    pub field: WorkspaceDocField,
    pub bound: i64,
    pub drifted: bool,
    pub revisions: Vec<DocumentRevisionSummary>,
}

/// The reason a revision stores: the first `REASON_MAX_CHARS` UTF-16 code units.
fn stored_reason(reason: &str) -> String {
    crate::support::js::slice16(reason, 0, REASON_MAX_CHARS)
}

/// The content last reported as drifted, per document. Remembered for the life of
/// the process, the shape `tool_risk_gate` uses for its truncation warning:
/// the Profile page polls this history, and one line per poll would bury the
/// finding. A second out-of-band write is different content, so it is reported
/// again. At most one entry per document, dropped when the document agrees again.
static REPORTED_DRIFT: LazyLock<Mutex<HashMap<WorkspaceDocField, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Log and count a drifted document once per drifted content.
fn note_drift(agent_id: &str, field: WorkspaceDocField, live_content: &str, drifted: bool) {
    todo!()
}

pub struct DocumentRevisionService;

impl DocumentRevisionService {
    pub fn new() -> Self {
        DocumentRevisionService
    }

    /// Append one revision and bring the document back inside the retention bound.
    ///
    /// `conn` is the caller's transaction, so the revision and the column write
    /// are one act.
    pub fn record(
        &self,
        conn: &mut SqliteConnection,
        input: RecordRevisionInput,
    ) -> anyhow::Result<AgentWorkspaceRevision> {
        todo!()
    }

    /// Record the seed revision of every document of a new agent. One insert, and
    /// no retention pass, because each field is gaining its first revision.
    ///
    /// Attributed to the user, because the content came with the agent's creation,
    /// from the template or the deployment's seed, rather than from anything the
    /// agent decided.
    ///
    /// `conn` is the caller's transaction, so the agent row and its history land
    /// together.
    pub fn record_seeds(
        &self,
        conn: &mut SqliteConnection,
        agent: &AgentWorkspace,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// The history of one document, newest first, with the drift verdict for the
    /// content the column holds now. Reporting the drift is part of reading it:
    /// this is the only place the column and its revisions meet.
    ///
    /// Which revisions hold the current content is a second query for their ids
    /// alone, because the summaries carry no content and reading 500 whole
    /// documents to compare them is the response this history avoids. A document
    /// that matches no revision was written outside the write path.
    pub async fn history(
        &self,
        agent: &AgentWorkspace,
        field: WorkspaceDocField,
    ) -> anyhow::Result<DocumentHistory> {
        todo!()
    }

    /// One revision with its content. Scoped to the field as well as the agent, so
    /// an id from another document is not found rather than served under the wrong
    /// document.
    pub fn get(
        &self,
        conn: &mut SqliteConnection,
        agent_id: &str,
        field: WorkspaceDocField,
        id: &str,
    ) -> anyhow::Result<Option<AgentWorkspaceRevision>> {
        todo!()
    }

    /// The newest revision of one document, or `None` while it has none.
    pub fn newest(
        &self,
        conn: &mut SqliteConnection,
        agent_id: &str,
        field: WorkspaceDocField,
    ) -> anyhow::Result<Option<AgentWorkspaceRevision>> {
        todo!()
    }

    /// Delete the revisions of one document that sit past the bound. Ordered by
    /// time and then by id, so a total order holds when two revisions share a
    /// millisecond and the same set is dropped whatever the read order.
    fn drop_over_bound(
        &self,
        conn: &mut SqliteConnection,
        agent_id: &str,
        field: WorkspaceDocField,
    ) -> anyhow::Result<i64> {
        todo!()
    }
}

impl Default for DocumentRevisionService {
    fn default() -> Self {
        Self::new()
    }
}

pub static DOCUMENT_REVISION_SERVICE: LazyLock<DocumentRevisionService> =
    LazyLock::new(DocumentRevisionService::new);
