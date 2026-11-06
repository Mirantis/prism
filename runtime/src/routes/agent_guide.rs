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

use axum::Json;
use axum::Router;
use axum::response::Response;
use axum::routing::patch;
use serde::{Deserialize, Serialize};

pub fn router() -> Router {
    Router::new().route("/agents/agent-guide", patch(update_agent_guide))
}

/// The body of `PATCH /agents/agent-guide`: `{ agentMd: string, reason?: string }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGuideBody {
    /// The whole document; an empty string clears it, which drops the
    /// `# Agent Guide` section from the prompt. Outer `None`: the key is missing,
    /// answered 400 `missing required field 'agentMd'`. A present value of any JSON
    /// type (`null` included) goes to `update_workspace_doc`, which checks it.
    #[serde(default, with = "::serde_with::rust::double_option")]
    pub agent_md: Option<Option<serde_json::Value>>,
    /// The note the document's history shows for this write. Passed to the
    /// service as it came, of any JSON type.
    #[serde(default)]
    pub reason: Option<serde_json::Value>,
}

/// The body of a successful write: the document as stored.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGuideResponse {
    pub agent_md: String,
}

/// `{ error }`, the body of every refusal and failure.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// PATCH /agents/agent-guide
///
/// Body: `{ agentMd: string, reason?: string }` — the whole document; an empty
/// string clears it, which drops the `# Agent Guide` section from the prompt.
/// `reason` is the note the document's history shows for this write. There is no
/// concurrency control: the last write wins, so two editors open at once
/// overwrite each other instead of merging.
///
/// A `ValidationError` answers 400 with its message; any other failure is logged
/// (`[AgentGuide] Failed to update the agent guide`, with `err`) and answers 500.
async fn update_agent_guide(Json(body): Json<AgentGuideBody>) -> Response {
    todo!()
}
