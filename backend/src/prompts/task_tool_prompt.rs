//! The subagents the Task tool can hand a task to, added to the system prompt when
//! the agent has subagents. How to use the tool is the Task tool's description.

use crate::lib::task_tool::Subagent;

pub fn get_task_tool_instructions(subagents: &[Subagent]) -> String {
    let list = subagents
        .iter()
        .map(|subagent| format!("- \"{}\": {}", subagent.name, subagent.description))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "## Subagents\n\nThe Task tool hands a task to one of these subagents, named in subagent_type:\n{list}"
    )
}
