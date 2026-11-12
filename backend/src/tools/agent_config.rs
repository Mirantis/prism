//! Agent-config tools.
//!
//! Update soul / memory / user / heartbeat / settings / vision /
//! bootstrap. A document write goes through
//! `AGENT_WORKSPACE_SERVICE.write_workspace_doc`, which records the revision;
//! the settings write is a direct database write, and it calls
//! `HEARTBEAT_SERVICE.start_heartbeat` after an interval change.

use diesel::prelude::*;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::{Tool, ToolSet, execute_fn, tool, zod_schema};
use crate::config::CONFIG;
use crate::constants::{MAX_HEARTBEAT_INTERVAL_MS, MIN_HEARTBEAT_INTERVAL_MS};
use crate::db::models::AgentWorkspace;
use crate::db::schema::agent_workspaces;
use crate::lib::agent_name::AGENT_NAME_RULE;
use crate::lib::apply_edit::{EditOperation, EditResult, apply_edits};
use crate::lib::locked_in::{LockedField, refuse_locked_write};
use crate::lib::telemetry::track_event;
use crate::lib::timezone::is_timezone;
use crate::lib::workspace_docs::{DocumentWriteActor, DocumentWriteMethod, WorkspaceDocField};
use crate::log_error;
use crate::services::agent_workspace_service::{AGENT_WORKSPACE_SERVICE, WriteWorkspaceDocInput};
use crate::services::cron_scheduler_service::CRON_SCHEDULER_SERVICE;
use crate::services::heartbeat_service::{HEARTBEAT_SERVICE, HeartbeatSchedule};

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
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": format!("The new name for this agent. {AGENT_NAME_RULE}")
            }
        },
        "required": ["name"],
        "additionalProperties": false
    })
}

pub fn workspace_file_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "newContent": {
                "description": "Complete replacement content. Use for major restructuring or initial setup.",
                "type": "string"
            },
            "edits": {
                "description": "Targeted find-and-replace edits. Preferred for small changes — only specify what changed.",
                "minItems": 1,
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "oldText": {
                            "type": "string",
                            "description": "Exact text to find in current content"
                        },
                        "newText": {
                            "type": "string",
                            "description": "Text to replace it with"
                        }
                    },
                    "required": ["oldText", "newText"],
                    "additionalProperties": false
                }
            },
            "changeDescription": {
                "type": "string",
                "description": "Brief description of what changed"
            }
        },
        "required": ["changeDescription"],
        "additionalProperties": false
    })
}

pub fn update_settings_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "setting": {
                "type": "string",
                "enum": ["heartbeatIntervalMs", "timezone", "verbose"],
                "description": "Which setting"
            },
            "value": {
                "description": "The new value",
                "type": ["number", "string", "boolean"]
            }
        },
        "required": ["setting", "value"],
        "additionalProperties": false
    })
}

pub fn clear_bootstrap_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "confirmationMessage": {
                "type": "string",
                "description": "A brief message acknowledging the end of bootstrap"
            }
        },
        "required": ["confirmationMessage"],
        "additionalProperties": false
    })
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

impl WorkspaceFileUpdateResult {
    fn failure(error: impl Into<String>) -> Value {
        json!({ "success": false, "error": error.into() })
    }
}

/// The lock's name for a document the agent's own tools write.
fn locked_field(field: WorkspaceDocField) -> LockedField {
    match field {
        WorkspaceDocField::SoulMd => LockedField::SoulMd,
        WorkspaceDocField::MemoryMd => LockedField::MemoryMd,
        WorkspaceDocField::UserMd => LockedField::UserMd,
        WorkspaceDocField::HeartbeatMd => LockedField::HeartbeatMd,
        WorkspaceDocField::VisionMd => LockedField::VisionMd,
        WorkspaceDocField::BootstrapMd | WorkspaceDocField::AgentMd => LockedField::BootstrapMd,
    }
}

/// The document a field of the row holds.
fn document_of(agent: &AgentWorkspace, field: WorkspaceDocField) -> &str {
    match field {
        WorkspaceDocField::AgentMd => &agent.agent_md,
        WorkspaceDocField::SoulMd => &agent.soul_md,
        WorkspaceDocField::UserMd => &agent.user_md,
        WorkspaceDocField::HeartbeatMd => &agent.heartbeat_md,
        WorkspaceDocField::MemoryMd => &agent.memory_md,
        WorkspaceDocField::VisionMd => &agent.vision_md,
        WorkspaceDocField::BootstrapMd => &agent.bootstrap_md,
    }
}

async fn find_agent(agent_id: &str) -> anyhow::Result<Option<AgentWorkspace>> {
    let id = agent_id.to_string();
    crate::db::run(move |conn| {
        Ok(agent_workspaces::table
            .find(&id)
            .select(AgentWorkspace::as_select())
            .first(conn)
            .optional()?)
    })
    .await
}

/// `agent config updated` with the field and how it was written.
fn track_config_updated(agent_id: &str, field: &str, method: &str) {
    let mut props = IndexMap::new();
    props.insert("agent.id".to_string(), agent_id.to_string());
    props.insert("config.field".to_string(), field.to_string());
    props.insert("config.method".to_string(), method.to_string());
    track_event("agent config updated", None, Some(props));
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
    field: WorkspaceDocField,
    input: WorkspaceFileInput,
) -> anyhow::Result<Value> {
    let WorkspaceFileInput {
        new_content,
        edits,
        change_description,
    } = input;
    let label = field.label();

    // Every markdown-writing tool funnels through here, so one live read of the
    // lock covers all of them in every invocation mode. This check enforces the
    // lock, including when it is switched on mid-turn.
    if AGENT_WORKSPACE_SERVICE.is_locked_in().await? {
        return Ok(serde_json::to_value(refuse_locked_write(
            agent_id,
            locked_field(field),
        ))?);
    }

    if new_content.is_some() && edits.is_some() {
        return Ok(WorkspaceFileUpdateResult::failure(
            "Provide either newContent or edits, not both.",
        ));
    }
    let replace = new_content.is_some();
    let final_content = match (new_content, edits) {
        (Some(content), _) => content,
        (None, None) => {
            return Ok(WorkspaceFileUpdateResult::failure(
                "Provide either newContent (full replace) or edits (targeted changes).",
            ));
        }
        (None, Some(edits)) => {
            let Some(agent) = find_agent(agent_id).await? else {
                return Ok(WorkspaceFileUpdateResult::failure(format!(
                    "Agent {agent_id} not found"
                )));
            };
            let operations: Vec<EditOperation> = edits
                .into_iter()
                .map(|edit| EditOperation {
                    old_text: edit.old_text,
                    new_text: edit.new_text,
                })
                .collect();
            match apply_edits(document_of(&agent, field), &operations) {
                EditResult::Success { content } => content,
                // Name the document, so a model that copied `oldText` from another
                // workspace file can see which one it searched.
                EditResult::Failure { error } => {
                    return Ok(WorkspaceFileUpdateResult::failure(format!(
                        "{label}: {error}"
                    )));
                }
            }
        }
    };

    let method = if replace {
        DocumentWriteMethod::Replace
    } else {
        DocumentWriteMethod::Edit
    };
    AGENT_WORKSPACE_SERVICE
        .write_workspace_doc(WriteWorkspaceDocInput {
            agent_id: agent_id.to_string(),
            field,
            content: final_content,
            actor: DocumentWriteActor::Agent,
            method,
            reason: change_description.clone(),
        })
        .await?;
    track_config_updated(agent_id, field.as_str(), method.as_str());
    Ok(json!({
        "success": true,
        "message": format!("{label} updated: {change_description}"),
    }))
}

async fn run_rename_self(agent_id: &str, input: Value) -> anyhow::Result<Value> {
    let input: RenameSelfInput = serde_json::from_value(input)?;
    // 'agent renamed' telemetry is emitted by `rename_agent` itself, so the
    // management PATCH /agents/name endpoint is covered by the same event.
    match AGENT_WORKSPACE_SERVICE
        .rename_agent(&Value::String(input.name))
        .await
    {
        Ok(updated) => Ok(json!({
            "success": true,
            "message": format!("Renamed agent to \"{}\".", updated.name),
            "newName": updated.name,
        })),
        Err(error) => {
            let msg = error.to_string();
            log_error!(
                "[Tool/rename_self] Failed to rename agent {}: {}",
                agent_id,
                msg
            );
            Ok(json!({ "success": false, "error": msg }))
        }
    }
}

/// The value of a numeric setting: a number, or a string `Number()` reads as one.
fn coerce_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => Some(crate::support::js::number_from(text).unwrap_or(f64::NAN)),
        _ => None,
    }
}

async fn run_update_settings(agent_id: &str, input: Value) -> anyhow::Result<Value> {
    let UpdateSettingsInput { setting, value } = serde_json::from_value(input)?;
    if setting == SettingName::Verbose {
        let bool_val = match &value {
            Value::Bool(flag) => *flag,
            Value::String(text) if text == "true" => true,
            Value::String(text) if text == "false" => false,
            _ => anyhow::bail!("verbose must be a boolean or \"true\"/\"false\""),
        };
        let result = AGENT_WORKSPACE_SERVICE
            .update_verbose(&Value::Bool(bool_val))
            .await?;
        return Ok(json!({
            "success": true,
            "message": format!("Updated verbose to {result}"),
        }));
    }

    // `coerced` as the message prints it, and the column value it sets.
    let (coerced_text, update): (String, SettingUpdate) = match setting {
        SettingName::HeartbeatIntervalMs => {
            let coerced = coerce_number(&value)
                .filter(|n| n.is_finite() && n.fract() == 0.0)
                .ok_or_else(|| anyhow::anyhow!("Heartbeat interval must be a finite integer"))?;
            if coerced < MIN_HEARTBEAT_INTERVAL_MS as f64 {
                anyhow::bail!("Heartbeat interval must be >= {MIN_HEARTBEAT_INTERVAL_MS}ms");
            }
            if coerced > MAX_HEARTBEAT_INTERVAL_MS as f64 {
                anyhow::bail!(
                    "Heartbeat interval must be <= {MAX_HEARTBEAT_INTERVAL_MS}ms (1 week)"
                );
            }
            (
                crate::support::js::number_text(coerced),
                SettingUpdate::HeartbeatIntervalMs(coerced as i64),
            )
        }
        SettingName::Timezone => {
            let zone = match &value {
                Value::String(zone) if is_timezone(zone) => zone.clone(),
                _ => anyhow::bail!("Timezone must be an IANA zone name such as Europe/Helsinki"),
            };
            (zone.clone(), SettingUpdate::Timezone(zone))
        }
        SettingName::Verbose => unreachable!("verbose returned above"),
    };

    let id = agent_id.to_string();
    let updated_agent = crate::db::run(move |conn| {
        let target = agent_workspaces::table.find(&id);
        let now = crate::db::sql_types::DbDateTime::now();
        let changed = match update {
            SettingUpdate::HeartbeatIntervalMs(ms) => diesel::update(target)
                .set((
                    agent_workspaces::heartbeat_interval_ms.eq(ms),
                    agent_workspaces::updated_at.eq(now),
                ))
                .execute(conn)?,
            SettingUpdate::Timezone(zone) => diesel::update(target)
                .set((
                    agent_workspaces::timezone.eq(zone),
                    agent_workspaces::updated_at.eq(now),
                ))
                .execute(conn)?,
        };
        if changed == 0 {
            anyhow::bail!("Record to update not found.");
        }
        Ok(agent_workspaces::table
            .find(&id)
            .select(AgentWorkspace::as_select())
            .first(conn)?)
    })
    .await?;

    if setting == SettingName::HeartbeatIntervalMs {
        // A new cadence starts now: the next check is one new interval away.
        HEARTBEAT_SERVICE.start_heartbeat(&updated_agent, HeartbeatSchedule::NewInterval);
    }

    if setting == SettingName::Timezone {
        // Recurring tasks read their schedules in the new zone from now on.
        CRON_SCHEDULER_SERVICE.use_timezone(&updated_agent.timezone);
    }

    track_config_updated(agent_id, setting.as_str(), "set");

    Ok(json!({
        "success": true,
        "message": format!("Updated {} to {coerced_text}", setting.as_str()),
    }))
}

/// The column a settings write sets.
enum SettingUpdate {
    HeartbeatIntervalMs(i64),
    Timezone(String),
}

async fn run_clear_bootstrap(agent_id: &str, input: Value) -> anyhow::Result<Value> {
    let ClearBootstrapInput {
        confirmation_message,
    } = serde_json::from_value(input)?;
    // Writes bootstrapMd, so it is part of the locked set. Guarded here
    // because it clears the field with a direct write instead of going
    // through `resolve_workspace_file_update`.
    if AGENT_WORKSPACE_SERVICE.is_locked_in().await? {
        return Ok(serde_json::to_value(refuse_locked_write(
            agent_id,
            LockedField::BootstrapMd,
        ))?);
    }
    AGENT_WORKSPACE_SERVICE
        .write_workspace_doc(WriteWorkspaceDocInput {
            agent_id: agent_id.to_string(),
            field: WorkspaceDocField::BootstrapMd,
            content: String::new(),
            actor: DocumentWriteActor::Agent,
            method: DocumentWriteMethod::Clear,
            reason: confirmation_message.clone(),
        })
        .await?;
    track_config_updated(agent_id, "bootstrapMd", "clear");
    Ok(json!({
        "success": true,
        "message": "Bootstrap phase complete.",
        "confirmationMessage": confirmation_message,
    }))
}

/// A workspace-file tool writing `field`.
fn workspace_file_tool(agent_id: &str, description: &str, field: WorkspaceDocField) -> Tool {
    let agent = agent_id.to_string();
    tool(Tool {
        description: Some(description.to_string()),
        input_schema: zod_schema(workspace_file_input_schema()),
        execute: Some(execute_fn(move |input, _| {
            let agent = agent.clone();
            async move {
                let input: WorkspaceFileInput = serde_json::from_value(input)?;
                resolve_workspace_file_update(&agent, field, input).await
            }
        })),
        ..Default::default()
    })
}

/// The tools, in order: rename_self, update_soul, update_memory,
/// update_user_profile, update_heartbeat_config, update_settings,
/// update_vision, clear_bootstrap. Fails with `AGENT_ID not configured` when the
/// agent id is unset.
pub fn get_agent_config_tools() -> anyhow::Result<ToolSet> {
    let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) else {
        anyhow::bail!("AGENT_ID not configured");
    };
    let mut tools = ToolSet::new();

    let agent = agent_id.clone();
    tools.insert(
        "rename_self".to_string(),
        tool(Tool {
            description: Some(RENAME_SELF_DESCRIPTION.to_string()),
            // `rename_agent` checks the name and answers one outside the rule, an
            // empty one included, with the rule itself, which the agent can act on.
            input_schema: zod_schema(rename_self_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let agent = agent.clone();
                async move { run_rename_self(&agent, input).await }
            })),
            ..Default::default()
        }),
    );
    tools.insert(
        "update_soul".to_string(),
        workspace_file_tool(
            &agent_id,
            UPDATE_SOUL_DESCRIPTION,
            WorkspaceDocField::SoulMd,
        ),
    );
    tools.insert(
        "update_memory".to_string(),
        workspace_file_tool(
            &agent_id,
            UPDATE_MEMORY_DESCRIPTION,
            WorkspaceDocField::MemoryMd,
        ),
    );
    tools.insert(
        "update_user_profile".to_string(),
        workspace_file_tool(
            &agent_id,
            UPDATE_USER_PROFILE_DESCRIPTION,
            WorkspaceDocField::UserMd,
        ),
    );
    // The schedule stays as it is. Every cycle loads the checks fresh, so the
    // timer reads no part of this document.
    tools.insert(
        "update_heartbeat_config".to_string(),
        workspace_file_tool(
            &agent_id,
            UPDATE_HEARTBEAT_CONFIG_DESCRIPTION,
            WorkspaceDocField::HeartbeatMd,
        ),
    );
    let agent = agent_id.clone();
    tools.insert(
        "update_settings".to_string(),
        tool(Tool {
            description: Some(UPDATE_SETTINGS_DESCRIPTION.to_string()),
            input_schema: zod_schema(update_settings_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let agent = agent.clone();
                async move { run_update_settings(&agent, input).await }
            })),
            ..Default::default()
        }),
    );
    tools.insert(
        "update_vision".to_string(),
        workspace_file_tool(
            &agent_id,
            UPDATE_VISION_DESCRIPTION,
            WorkspaceDocField::VisionMd,
        ),
    );
    let agent = agent_id.clone();
    tools.insert(
        "clear_bootstrap".to_string(),
        tool(Tool {
            description: Some(CLEAR_BOOTSTRAP_DESCRIPTION.to_string()),
            input_schema: zod_schema(clear_bootstrap_input_schema()),
            execute: Some(execute_fn(move |input, _| {
                let agent = agent.clone();
                async move { run_clear_bootstrap(&agent, input).await }
            })),
            ..Default::default()
        }),
    );
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ToolExecutionOptions;

    async fn call(tools: &ToolSet, name: &str, input: Value) -> anyhow::Result<Value> {
        let execute = tools[name].execute.clone().unwrap();
        execute(input, ToolExecutionOptions::default()).await
    }

    #[test]
    fn the_definitions_match_the_typescript_runtime() {
        let tools = get_agent_config_tools().unwrap();
        crate::tools::schema_fixture::assert_matches_fixture("agent-config", &tools);
    }

    #[test]
    fn exposes_all_expected_tools() {
        let tools = get_agent_config_tools().unwrap();
        let names: Vec<&str> = tools.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            [
                "rename_self",
                "update_soul",
                "update_memory",
                "update_user_profile",
                "update_heartbeat_config",
                "update_settings",
                "update_vision",
                "clear_bootstrap",
            ]
        );
    }

    #[test]
    fn does_not_accept_locked_in_as_a_writable_setting() {
        let schema = update_settings_input_schema();
        let settings = schema["properties"]["setting"]["enum"].as_array().unwrap();
        assert!(!settings.contains(&json!("lockedIn")));
    }

    #[tokio::test]
    async fn validates_the_heartbeat_interval_minimum() {
        let tools = get_agent_config_tools().unwrap();
        let err = call(
            &tools,
            "update_settings",
            json!({ "setting": "heartbeatIntervalMs", "value": 1000 }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "Heartbeat interval must be >= 60000ms");
    }

    #[tokio::test]
    async fn validates_the_heartbeat_interval_maximum() {
        let tools = get_agent_config_tools().unwrap();
        let err = call(
            &tools,
            "update_settings",
            json!({ "setting": "heartbeatIntervalMs", "value": 999_999_999_999_i64 }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Heartbeat interval must be <= 604800000ms (1 week)"
        );
    }

    #[tokio::test]
    async fn rejects_a_non_numeric_string_for_a_numeric_setting() {
        let tools = get_agent_config_tools().unwrap();
        let err = call(
            &tools,
            "update_settings",
            json!({ "setting": "heartbeatIntervalMs", "value": "abc" }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Heartbeat interval must be a finite integer"
        );
    }

    #[tokio::test]
    async fn rejects_a_non_integer_for_a_numeric_setting() {
        let tools = get_agent_config_tools().unwrap();
        for value in [json!(60000.5), json!(true)] {
            let err = call(
                &tools,
                "update_settings",
                json!({ "setting": "heartbeatIntervalMs", "value": value }),
            )
            .await
            .unwrap_err();
            assert_eq!(
                err.to_string(),
                "Heartbeat interval must be a finite integer"
            );
        }
    }

    #[tokio::test]
    async fn rejects_a_timezone_that_is_not_an_iana_zone() {
        let tools = get_agent_config_tools().unwrap();
        let err = call(
            &tools,
            "update_settings",
            json!({ "setting": "timezone", "value": "Mars/Olympus" }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Timezone must be an IANA zone name such as Europe/Helsinki"
        );
    }

    #[tokio::test]
    async fn rejects_a_verbose_value_that_is_not_a_boolean() {
        let tools = get_agent_config_tools().unwrap();
        let err = call(
            &tools,
            "update_settings",
            json!({ "setting": "verbose", "value": "yes" }),
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "verbose must be a boolean or \"true\"/\"false\""
        );
    }

    #[test]
    fn reads_a_numeric_string_as_javascript_number_does() {
        assert_eq!(coerce_number(&json!("120000")), Some(120000.0));
        assert!(coerce_number(&json!("abc")).unwrap().is_nan());
        assert_eq!(coerce_number(&json!(true)), None);
    }
}
