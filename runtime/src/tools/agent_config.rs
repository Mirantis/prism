//! Agent-config tools.
//!
//! Update soul / memory / user / heartbeat / settings / vision /
//! bootstrap. A document write goes through
//! `AGENT_WORKSPACE_SERVICE.write_workspace_doc`, which records the revision;
//! the settings write is a direct database write, and it calls
//! `HEARTBEAT_SERVICE.start_heartbeat` after an interval change.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::ToolSet;

pub const RENAME_SELF_DESCRIPTION: &str = "Rename this agent. Use only when the user explicitly asks you to change your name. The new name is persisted and picked up on the next chat turn.";
pub const UPDATE_SOUL_DESCRIPTION: &str = "Update your soul (personality, values, boundaries).";
pub const UPDATE_MEMORY_DESCRIPTION: &str =
    "Update your curated memory summary (always in context). Critical facts go here.";
pub const UPDATE_USER_PROFILE_DESCRIPTION: &str =
    "Update the user profile with information learned from conversation.";
pub const UPDATE_HEARTBEAT_CONFIG_DESCRIPTION: &str = "Update heartbeat configuration.";
pub const UPDATE_SETTINGS_DESCRIPTION: &str = "Update agent behavioral settings (timezone, heartbeatIntervalMs, verbose). verbose controls chat delivery: false (default) delivers only the final message; true streams every intermediate step.";
pub const UPDATE_VISION_DESCRIPTION: &str = "Update the user's vision document.";
pub const CLEAR_BOOTSTRAP_DESCRIPTION: &str =
    "Clear the bootstrap instructions after onboarding is complete.";

/// One targeted find-and-replace edit.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEdit {
    /// Exact text to find in current content.
    pub old_text: String,
    /// Text to replace it with.
    pub new_text: String,
}

/// Shared input of the workspace-file update tools (dual-mode: full replace or
/// targeted edits).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileInput {
    /// Complete replacement content. Use for major restructuring or initial setup.
    #[serde(default)]
    pub new_content: Option<String>,
    /// Targeted find-and-replace edits. Preferred for small changes.
    #[serde(default)]
    pub edits: Option<Vec<WorkspaceFileEdit>>,
    /// Brief description of what changed.
    pub change_description: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenameSelfInput {
    /// The new name for this agent.
    pub name: String,
}

/// The settings `update_settings` changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettingName {
    #[serde(rename = "heartbeatIntervalMs")]
    HeartbeatIntervalMs,
    #[serde(rename = "timezone")]
    Timezone,
    #[serde(rename = "verbose")]
    Verbose,
}

impl SettingName {
    pub fn as_str(self) -> &'static str {
        match self {
            SettingName::HeartbeatIntervalMs => "heartbeatIntervalMs",
            SettingName::Timezone => "timezone",
            SettingName::Verbose => "verbose",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateSettingsInput {
    /// Which setting.
    pub setting: SettingName,
    /// The new value: a number, a string or a boolean.
    pub value: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearBootstrapInput {
    /// A brief message acknowledging the end of bootstrap.
    pub confirmation_message: String,
}

/// The input schema of `rename_self`; its name description ends with `AGENT_NAME_RULE`.
pub fn rename_self_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn workspace_file_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn update_settings_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

pub fn clear_bootstrap_input_schema() -> Value {
    todo!("JSON Schema supplied by the coordinator")
}

/// What a workspace-file update returns to the model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceFileUpdateResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Resolve the final content for a workspace-file update, then persist it.
///
/// - With `new_content`: use it directly (full replace).
/// - With `edits`: read the current content, apply the edits in order; a failed
///   edit names the document (`<label>: <error>`).
///
/// The lock is read live first, so it holds when switched on mid-turn. Both or
/// neither of `new_content` and `edits` is refused. Emits
/// `agent config updated` with `config.method` `replace` or `edit`.
async fn resolve_workspace_file_update(
    agent_id: &str,
    field: &str,
    input: WorkspaceFileInput,
) -> anyhow::Result<Value> {
    todo!()
}

/// The tools, in order: rename_self, update_soul, update_memory,
/// update_user_profile, update_heartbeat_config, update_settings,
/// update_vision, clear_bootstrap. Fails with `AGENT_ID not configured` when the
/// agent id is unset.
pub fn get_agent_config_tools() -> anyhow::Result<ToolSet> {
    todo!()
}
