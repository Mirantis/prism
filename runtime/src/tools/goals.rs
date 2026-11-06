//! Goal tools.
//!
//! The natural-language entry point to goals: the model calls `create_goal` when
//! the user explicitly asks for durable, autonomous, multi-turn work. State and
//! the background loop are owned by the goal service; these tools are a thin,
//! pre-bound (user/agent/thread/channel) surface over it.
//!
//! Chat-only by design (see the mode filter in `invoke`): goal turns and
//! autonomous runs must not create or nest goals.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;
use crate::services::channel_adapter_interface::ChannelName;

pub const CREATE_GOAL_DESCRIPTION: &str = "Start a durable goal: an objective you will pursue autonomously across many turns, unattended, until it is achieved or stopped. Create a goal only when the user explicitly asks for ongoing, multi-turn, self-driven work toward an objective (e.g. \"keep working until the tests pass\", \"make this a goal\", \"keep going until X\"). Do not create a goal for an ordinary one-off task you can just do now. Only one active goal per conversation — creating a new one replaces the existing one.";
pub const GET_GOAL_DESCRIPTION: &str = "Get the current active goal for this conversation (objective, status, turns used, token spend). Returns nothing active if there is no goal running.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGoalInput {
    /// The completion condition / objective to pursue, in plain language.
    pub objective: String,
    /// Optional cap on total tokens to spend on this goal before it stops.
    #[serde(default)]
    pub token_budget: Option<i64>,
}

pub fn create_goal_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn get_goal_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// create_goal and get_goal.
pub fn get_goal_tools(
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    origin_channel: ChannelName,
    origin_channel_id: Option<&str>,
) -> ToolSet {
    todo!()
}
