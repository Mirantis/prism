//! Agent State Route
//!
//! GET /agents/state — `{"state": "working" | "idle"}`: working while a turn runs
//! or waits, or other work is in flight (`services/agent_activity.rs`), so the
//! platform can show whether the agent is busy.

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde::Serialize;

use crate::services::agent_activity::is_agent_idle;
use crate::support::http::json;

pub fn router() -> Router {
    Router::new().route("/agents/state", get(get_state))
}

/// Whether the agent is busy, as the platform reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Idle,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Idle => "idle",
        }
    }
}

/// The body of `GET /agents/state`.
#[derive(Debug, Clone, Serialize)]
pub struct AgentStateBody {
    pub state: AgentState,
}

/// GET /agents/state
///
/// `idle` when `is_agent_idle()` answers true, else `working`.
async fn get_state() -> Response {
    let state = if is_agent_idle().await {
        AgentState::Idle
    } else {
        AgentState::Working
    };
    json(200, AgentStateBody { state })
}
