//! Skills tools.
//!
//! Implements the "level 2" of progressive disclosure: the model sees only each
//! skill's name + description in the system prompt (the `# Skills` section), and
//! calls the `skill` tool to load a skill's full SKILL.md body on demand. The
//! same body-loading path backs the CLI's manual `/skills run`.

use serde::Deserialize;
use serde_json::Value;

use crate::ai::ToolSet;

pub const SKILL_TOOL_NAME: &str = "skill";
pub const SKILL_DESCRIPTION: &str = "Load the full instructions for an available Agent Skill by name, then follow them. The available skills (name + one-line description) are listed in the \"# Skills\" section of your system prompt. Call this only when a skill is relevant to the current task. Don't guess a skill's contents from its description.";

#[derive(Debug, Clone, Deserialize)]
pub struct SkillInput {
    /// The skill name, exactly as shown in the # Skills list.
    pub name: String,
}

pub fn skill_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// The text a loaded skill is handed to the model in.
pub fn skill_instructions(name: &str, dir: &str, body: &str) -> String {
    format!(
        "[Skill: {name} — directory: {dir}]\nBundled files (scripts/, references/, assets/) live under that directory; read or run them with the shell tools using that absolute base. Now follow these instructions:\n\n{body}"
    )
}

/// Build the skills tool set. `workspace_root` (the thread's repo dir, when set)
/// merges that repo's skills with the global ones. Returns an empty set when
/// no skills are available, so the tool isn't offered when there's nothing it
/// could load.
///
/// The tool answers `{ name, skillDir, skillMdPath, instructions }`, or
/// `{ error: "No available skill named \"<name>\".", availableSkills }`.
pub async fn get_skill_tools(workspace_root: Option<&str>) -> ToolSet {
    todo!()
}
