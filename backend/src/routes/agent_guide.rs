//! Agent Guide Route
//!
//! PATCH /agents/agent-guide — replace the agent's operating manual (`agentMd`),
//! which reaches the system prompt as `# Agent Guide`. No tool writes this
//! document, so the user is its only author, and locked-in mode does not gate the
//! write — that lock covers the agent's own tools.
//!
//! This route exists for the shipped terminal UI, whose binary calls this URL.
//! `PATCH /agents/documents/{field}` writes any of the seven documents, `agentMd`
//! included, and both reach `update_workspace_doc`.
//!
//! Auth is terminated by the platform in front of the container, as for every
//! other route, so this one takes no credential from inside it.

use axum::Router;
use axum::response::Response;
use axum::routing::patch;
use serde::Serialize;
use serde_json::json;

use crate::lib::log_redaction::err_json;
use crate::lib::workspace_docs::WorkspaceDocField;
use crate::log_error;
use crate::services::agent_workspace_service::{AGENT_WORKSPACE_SERVICE, ValidationError};
use crate::support::http::{JsonBody, error_json, json};

pub fn router() -> Router {
    Router::new().route("/agents/agent-guide", patch(update_agent_guide))
}

/// The body of a successful write: the document as stored.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGuideResponse {
    pub agent_md: String,
}

/// PATCH /agents/agent-guide
///
/// Body: `{ agentMd: string, reason?: string }` — the whole document; an empty
/// string clears it, which drops the `# Agent Guide` section from the prompt.
/// `reason` is the note the document's history shows for this write. There is no
/// concurrency control: the last write wins, so two editors open at once
/// overwrite each other instead of merging.
async fn update_agent_guide(body: JsonBody) -> Response {
    let Some(agent_md) = body.field("agentMd") else {
        return error_json(400, "missing required field 'agentMd'");
    };
    let written = AGENT_WORKSPACE_SERVICE
        .update_workspace_doc(WorkspaceDocField::AgentMd, agent_md, body.field("reason"))
        .await;
    match written {
        Ok(agent_md) => json(200, AgentGuideResponse { agent_md }),
        Err(err) => {
            if let Some(validation) = err.downcast_ref::<ValidationError>() {
                return error_json(400, validation.to_string());
            }
            log_error!(
                json!({ "err": err_json(&err) }),
                "[AgentGuide] Failed to update the agent guide"
            );
            error_json(500, err.to_string())
        }
    }
}
