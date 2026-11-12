//! Skills tools.
//!
//! Implements the "level 2" of progressive disclosure: the model sees only each
//! skill's name + description in the system prompt (the `# Skills` section), and
//! calls the `skill` tool to load a skill's full SKILL.md body on demand. The
//! same body-loading path backs the CLI's manual `/skills run`.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::services::skill_catalog_service::SKILL_CATALOG_SERVICE;

pub const SKILL_TOOL_NAME: &str = "skill";
pub const SKILL_DESCRIPTION: &str = "Load the full instructions for an available Agent Skill by name, then follow them. The available skills (name + one-line description) are listed in the \"# Skills\" section of your system prompt. Call this only when a skill is relevant to the current task. Don't guess a skill's contents from its description.";

#[derive(Debug, Clone, Deserialize)]
pub struct SkillInput {
    /// The skill name, exactly as shown in the # Skills list.
    pub name: String,
}

pub fn skill_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "The skill name, exactly as shown in the # Skills list"
            }
        },
        "required": ["name"],
        "additionalProperties": false
    })
}

/// The text a loaded skill is handed to the model in.
pub fn skill_instructions(name: &str, dir: &str, body: &str) -> String {
    format!(
        "[Skill: {name} — directory: {dir}]\nBundled files (scripts/, references/, assets/) live under that directory; read or run them with the shell tools using that absolute base. Now follow these instructions:\n\n{body}"
    )
}

async fn run_skill(input: Value, workspace_root: Option<String>) -> anyhow::Result<Value> {
    let SkillInput { name } = serde_json::from_value(input)?;
    let root = workspace_root.as_deref();
    let Some(found) = SKILL_CATALOG_SERVICE.get_skill_body(&name, root).await? else {
        let available: Vec<String> = SKILL_CATALOG_SERVICE
            .get_catalog(root)
            .await
            .into_iter()
            .map(|s| s.name)
            .collect();
        return Ok(json!({
            "error": format!("No available skill named \"{name}\"."),
            "availableSkills": available,
        }));
    };
    let entry = found.entry;
    Ok(json!({
        "name": entry.name,
        "skillDir": entry.dir,
        "skillMdPath": entry.skill_md_path,
        "instructions": skill_instructions(&entry.name, &entry.dir, &found.body),
    }))
}

/// Build the skills tool set. `workspace_root` (the thread's repo dir, when set)
/// merges that repo's skills with the global ones. Returns an empty set when
/// no skills are available, so the tool isn't offered when there's nothing it
/// could load.
///
/// The tool answers `{ name, skillDir, skillMdPath, instructions }`, or
/// `{ error: "No available skill named \"<name>\".", availableSkills }`.
pub async fn get_skill_tools(workspace_root: Option<&str>) -> ToolSet {
    let mut tools = ToolSet::new();
    if SKILL_CATALOG_SERVICE
        .get_catalog(workspace_root)
        .await
        .is_empty()
    {
        return tools;
    }
    tools.insert(
        SKILL_TOOL_NAME.to_string(),
        skill_tool(workspace_root.map(str::to_string)),
    );
    tools
}

/// The `skill` tool, loading from the skills `workspace_root` merges in.
fn skill_tool(workspace_root: Option<String>) -> Tool {
    tool(Tool {
        description: Some(SKILL_DESCRIPTION.to_string()),
        input_schema: zod_schema(skill_input_schema()),
        execute: Some(execute_fn(move |input, _| {
            run_skill(input, workspace_root.clone())
        })),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_definition_matches_the_typescript_runtime() {
        let mut tools = ToolSet::new();
        tools.insert(SKILL_TOOL_NAME.to_string(), skill_tool(None));
        crate::tools::schema_fixture::assert_matches_fixture("skills", &tools);
    }

    #[test]
    fn hands_the_skill_over_with_its_directory() {
        assert_eq!(
            skill_instructions("deploy", "/data/skills/deploy", "Run it."),
            "[Skill: deploy — directory: /data/skills/deploy]\nBundled files (scripts/, references/, assets/) live under that directory; read or run them with the shell tools using that absolute base. Now follow these instructions:\n\nRun it."
        );
    }
}
