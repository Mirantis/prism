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

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::SqliteConnection;
use diesel::prelude::*;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::models::{AgentWorkspace, AgentWorkspaceRevision, NewAgentWorkspaceRevision};
use crate::db::schema::agent_workspace_revisions::dsl as r;
use crate::lib::telemetry::track_event;
use crate::lib::workspace_docs::{
    DocumentWriteActor, DocumentWriteMethod, WORKSPACE_DOC_FIELDS, WorkspaceDocField,
};
use crate::log_warn;

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
    {
        let mut reported = REPORTED_DRIFT.lock();
        if !drifted {
            reported.remove(&field);
            return;
        }
        if reported.get(&field).map(String::as_str) == Some(live_content) {
            return;
        }
        reported.insert(field, live_content.to_string());
    }

    log_warn!(
        json!({ "agentId": agent_id, "field": field.as_str() }),
        "[DocumentRevisions] {} does not agree with its newest revision; it was written outside the write path",
        field.label()
    );
    // The agent and the field only. The content and the reason text stay out of telemetry.
    track_event(
        "agent document drift detected",
        None,
        Some(IndexMap::from([
            ("agent.id".to_string(), agent_id.to_string()),
            ("config.field".to_string(), field.as_str().to_string()),
        ])),
    );
}

/// The one builder for a revision row, so every insert stores the same shape.
fn revision_row(input: &RecordRevisionInput) -> NewAgentWorkspaceRevision {
    NewAgentWorkspaceRevision::new(
        input.agent_id.clone(),
        input.field.as_str(),
        input.content.clone(),
        input.actor.as_str(),
        input.method.as_str(),
        stored_reason(&input.reason),
    )
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
        let revision = diesel::insert_into(r::agent_workspace_revisions)
            .values(&revision_row(&input))
            .returning(AgentWorkspaceRevision::as_returning())
            .get_result(conn)?;
        self.drop_over_bound(conn, &input.agent_id, input.field)?;
        Ok(revision)
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
        let rows: Vec<NewAgentWorkspaceRevision> = WORKSPACE_DOC_FIELDS
            .into_iter()
            .map(|field| {
                revision_row(&RecordRevisionInput {
                    agent_id: agent.id.clone(),
                    field,
                    content: field.read(agent).to_string(),
                    actor: DocumentWriteActor::User,
                    method: DocumentWriteMethod::Seed,
                    reason: SEED_REASON.to_string(),
                })
            })
            .collect();
        diesel::insert_into(r::agent_workspace_revisions)
            .values(&rows)
            .execute(conn)?;
        Ok(())
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
        let agent_id = agent.id.clone();
        let content = field.read(agent).to_string();
        let (rows, matching) = crate::db::read(move |conn| {
            let rows: Vec<(String, String, String, String, DateTime<Utc>)> =
                r::agent_workspace_revisions
                    .filter(r::agent_id.eq(&agent_id))
                    .filter(r::field.eq(field.as_str()))
                    .order((r::created_at.desc(), r::id.desc()))
                    .select((r::id, r::actor, r::method, r::reason, r::created_at))
                    .load(conn)?;
            let matching: Vec<String> = r::agent_workspace_revisions
                .filter(r::agent_id.eq(&agent_id))
                .filter(r::field.eq(field.as_str()))
                .filter(r::content.eq(&content))
                .select(r::id)
                .load(conn)?;
            Ok((rows, matching))
        })
        .await?;

        let current: HashSet<String> = matching.into_iter().collect();
        let revisions: Vec<DocumentRevisionSummary> = rows
            .into_iter()
            .map(
                |(id, actor, method, reason, created_at)| DocumentRevisionSummary {
                    matches_current: current.contains(&id),
                    id,
                    actor,
                    method,
                    reason,
                    created_at,
                },
            )
            .collect();
        let drifted = revisions
            .first()
            .is_some_and(|newest| !newest.matches_current);
        note_drift(&agent.id, field, field.read(agent), drifted);

        Ok(DocumentHistory {
            field,
            bound: MAX_REVISIONS_PER_DOCUMENT,
            drifted,
            revisions,
        })
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
        Ok(r::agent_workspace_revisions
            .filter(r::id.eq(id))
            .filter(r::agent_id.eq(agent_id))
            .filter(r::field.eq(field.as_str()))
            .select(AgentWorkspaceRevision::as_select())
            .first(conn)
            .optional()?)
    }

    /// The newest revision of one document, or `None` while it has none.
    pub fn newest(
        &self,
        conn: &mut SqliteConnection,
        agent_id: &str,
        field: WorkspaceDocField,
    ) -> anyhow::Result<Option<AgentWorkspaceRevision>> {
        Ok(r::agent_workspace_revisions
            .filter(r::agent_id.eq(agent_id))
            .filter(r::field.eq(field.as_str()))
            .order((r::created_at.desc(), r::id.desc()))
            .select(AgentWorkspaceRevision::as_select())
            .first(conn)
            .optional()?)
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
        let over_bound: Vec<String> = r::agent_workspace_revisions
            .filter(r::agent_id.eq(agent_id))
            .filter(r::field.eq(field.as_str()))
            .order((r::created_at.desc(), r::id.desc()))
            .select(r::id)
            .limit(-1)
            .offset(MAX_REVISIONS_PER_DOCUMENT)
            .load(conn)?;
        if over_bound.is_empty() {
            return Ok(0);
        }

        diesel::delete(r::agent_workspace_revisions.filter(r::id.eq_any(&over_bound)))
            .execute(conn)?;
        Ok(over_bound.len() as i64)
    }
}

impl Default for DocumentRevisionService {
    fn default() -> Self {
        Self::new()
    }
}

pub static DOCUMENT_REVISION_SERVICE: LazyLock<DocumentRevisionService> =
    LazyLock::new(DocumentRevisionService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;
    use crate::db::schema::agent_workspaces::dsl as w;
    use crate::db::testing::test_db;

    fn agent() -> AgentWorkspace {
        crate::db::run_sync(|conn| {
            let mut new_agent = NewAgentWorkspace::new("u", "soul", "user", "memory", "hb", "boot");
            new_agent.id = "agent-1".to_string();
            Ok(diesel::insert_into(w::agent_workspaces)
                .values(&new_agent)
                .returning(AgentWorkspace::as_returning())
                .get_result(conn)?)
        })
        .unwrap()
    }

    fn input(content: &str, reason: &str) -> RecordRevisionInput {
        RecordRevisionInput {
            agent_id: "agent-1".to_string(),
            field: WorkspaceDocField::SoulMd,
            content: content.to_string(),
            actor: DocumentWriteActor::Agent,
            method: DocumentWriteMethod::Replace,
            reason: reason.to_string(),
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn seeds_one_revision_per_document_attributed_to_the_user() {
        let _db = test_db();
        let agent = agent();
        crate::db::run_sync(|conn| DOCUMENT_REVISION_SERVICE.record_seeds(conn, &agent)).unwrap();

        for field in WORKSPACE_DOC_FIELDS {
            let history = DOCUMENT_REVISION_SERVICE
                .history(&agent, field)
                .await
                .unwrap();
            assert_eq!(history.revisions.len(), 1, "{field}");
            let seed = &history.revisions[0];
            assert_eq!(
                (
                    seed.actor.as_str(),
                    seed.method.as_str(),
                    seed.reason.as_str()
                ),
                ("user", "seed", SEED_REASON)
            );
            assert!(seed.matches_current);
            assert!(!history.drifted);
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn history_reports_drift_when_the_column_matches_no_newest_revision() {
        let _db = test_db();
        let mut agent = agent();
        crate::db::run_sync(|conn| DOCUMENT_REVISION_SERVICE.record_seeds(conn, &agent)).unwrap();

        agent.soul_md = "written straight into the database".to_string();
        let history = DOCUMENT_REVISION_SERVICE
            .history(&agent, WorkspaceDocField::SoulMd)
            .await
            .unwrap();
        assert!(history.drifted);
        assert!(!history.revisions[0].matches_current);
        assert_eq!(history.bound, 500);

        let json = serde_json::to_value(&history).unwrap();
        assert_eq!(json["field"], "soulMd");
        let keys: Vec<&str> = json["revisions"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "id",
                "actor",
                "method",
                "reason",
                "createdAt",
                "matchesCurrent"
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn record_caps_the_reason_and_newest_finds_the_last_write() {
        let _db = test_db();
        let _agent = agent();
        let long = "x".repeat(600);
        let revision =
            crate::db::run_sync(|conn| DOCUMENT_REVISION_SERVICE.record(conn, input("one", &long)))
                .unwrap();
        assert_eq!(revision.reason.len(), 500);
        // Revisions are ordered by millisecond and then by their random id, so the
        // second write gets a later millisecond to be the newest.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second =
            crate::db::run_sync(|conn| DOCUMENT_REVISION_SERVICE.record(conn, input("two", "")))
                .unwrap();

        let newest = crate::db::run_sync(|conn| {
            DOCUMENT_REVISION_SERVICE.newest(conn, "agent-1", WorkspaceDocField::SoulMd)
        })
        .unwrap()
        .unwrap();
        assert_eq!(newest.id, second.id);
        // Another document's id is not found under this one.
        let other = crate::db::run_sync(|conn| {
            DOCUMENT_REVISION_SERVICE.get(conn, "agent-1", WorkspaceDocField::UserMd, &second.id)
        })
        .unwrap();
        assert!(other.is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn record_keeps_the_newest_500_revisions_of_a_document() {
        let _db = test_db();
        let _agent = agent();
        crate::db::run_sync(|conn| {
            for i in 0..505 {
                DOCUMENT_REVISION_SERVICE.record(conn, input(&format!("v{i}"), ""))?;
            }
            Ok(())
        })
        .unwrap();
        let contents: Vec<String> = crate::db::run_sync(|conn| {
            Ok(r::agent_workspace_revisions
                .order((r::created_at.desc(), r::id.desc()))
                .select(r::content)
                .load(conn)?)
        })
        .unwrap();
        assert_eq!(contents.len(), 500);
    }
}
