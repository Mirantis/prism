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
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::constants::GOAL_MAX_OBJECTIVE_CHARS;
use crate::lib::log_redaction::err_json;
use crate::log_error;
use crate::services::channel_adapter_interface::ChannelName;
use crate::services::goal_service::{GOAL_SERVICE, StartGoalInput};

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
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "objective": {
                "type": "string",
                "minLength": 1,
                "maxLength": GOAL_MAX_OBJECTIVE_CHARS,
                "description": "The completion condition / objective to pursue, in plain language."
            },
            "tokenBudget": {
                "description": "Optional cap on total tokens to spend on this goal before it stops.",
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991_i64
            }
        },
        "required": ["objective"],
        "additionalProperties": false
    })
}

pub fn get_goal_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

async fn run_create_goal(
    input: Value,
    user_id: String,
    agent_id: String,
    thread_id: Option<String>,
    origin_channel: ChannelName,
    origin_channel_id: Option<String>,
) -> anyhow::Result<Value> {
    let input: CreateGoalInput = serde_json::from_value(input)?;
    let Some(thread_id) = thread_id else {
        return Ok(json!({
            "success": false,
            "error": "Goals require an active conversation thread.",
        }));
    };
    let started = GOAL_SERVICE
        .start_goal(StartGoalInput {
            user_id,
            agent_id,
            thread_id,
            objective: input.objective,
            token_budget: input.token_budget,
            origin_channel: origin_channel.as_str().to_string(),
            origin_channel_id,
        })
        .await;
    match started {
        Ok(goal) => Ok(json!({
            "success": true,
            "goalId": goal.id,
            "maxTurns": goal.max_turns,
            "message": format!(
                "Started goal: \"{}\". I'll keep working toward this on my own across multiple turns (up to {}) until it's done.",
                goal.objective, goal.max_turns
            ),
        })),
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err) }),
                "[GoalTool] Failed to start goal"
            );
            Ok(json!({ "success": false, "error": err.to_string() }))
        }
    }
}

async fn run_get_goal(thread_id: Option<String>) -> anyhow::Result<Value> {
    let Some(thread_id) = thread_id else {
        return Ok(json!({ "success": true, "active": false }));
    };
    let Some(goal) = GOAL_SERVICE.get_goal_for_thread(&thread_id).await? else {
        return Ok(json!({ "success": true, "active": false }));
    };
    Ok(json!({
        "success": true,
        "active": true,
        "goalId": goal.id,
        "objective": goal.objective,
        "status": goal.status,
        "turnCount": goal.turn_count,
        "maxTurns": goal.max_turns,
        "tokensUsed": goal.tokens_used,
        "tokenBudget": goal.token_budget,
        "lastReason": goal.last_reason,
    }))
}

/// create_goal and get_goal.
pub fn get_goal_tools(
    user_id: &str,
    agent_id: &str,
    thread_id: Option<&str>,
    origin_channel: ChannelName,
    origin_channel_id: Option<&str>,
) -> ToolSet {
    let mut tools = ToolSet::new();
    let (user, agent) = (user_id.to_string(), agent_id.to_string());
    let thread = thread_id.map(str::to_string);
    let channel_id = origin_channel_id.map(str::to_string);
    tools.insert(
        "create_goal".to_string(),
        tool(Tool {
            description: Some(CREATE_GOAL_DESCRIPTION.to_string()),
            input_schema: zod_schema(create_goal_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                run_create_goal(
                    input,
                    user.clone(),
                    agent.clone(),
                    thread.clone(),
                    origin_channel,
                    channel_id.clone(),
                )
            })),
            ..Default::default()
        }),
    );
    let thread = thread_id.map(str::to_string);
    tools.insert(
        "get_goal".to_string(),
        tool(Tool {
            description: Some(GET_GOAL_DESCRIPTION.to_string()),
            input_schema: zod_schema(get_goal_input_schema()),
            execute: Some(execute_fn(move |_, _| run_get_goal(thread.clone()))),
            ..Default::default()
        }),
    );
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToolExecutionOptions;

    #[test]
    fn the_definitions_match_the_typescript_runtime() {
        let tools = get_goal_tools(
            "user-1",
            "agent-1",
            Some("thread-1"),
            ChannelName::Websocket,
            None,
        );
        crate::tools::schema_fixture::assert_matches_fixture("goals", &tools);
    }

    #[tokio::test]
    async fn create_goal_needs_a_thread() {
        let tools = get_goal_tools("user-1", "agent-1", None, ChannelName::Websocket, None);
        let execute = tools["create_goal"].execute.clone().unwrap();
        let result = execute(
            json!({ "objective": "keep going" }),
            ToolExecutionOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            json!({ "success": false, "error": "Goals require an active conversation thread." })
        );
    }

    #[tokio::test]
    async fn get_goal_without_a_thread_reports_nothing_active() {
        let tools = get_goal_tools("user-1", "agent-1", None, ChannelName::Websocket, None);
        let execute = tools["get_goal"].execute.clone().unwrap();
        let result = execute(json!({}), ToolExecutionOptions::default())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            r#"{"success":true,"active":false}"#
        );
    }
}
