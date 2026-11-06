//! Agent CRUD Service
//!
//! Manages agent lifecycle: creation, deletion, lookups, ownership validation,
//! platform token management, and subagent relationships.
//!
//! This is the authoritative service for agent data — the backend delegates
//! all agent operations here via the management API.

use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::SqliteConnection;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::db::models::{AgentModelMode, AgentType, AgentWorkspace, AgentWorkspaceRevision};
use crate::lib::workspace_docs::{DocumentWriteActor, DocumentWriteMethod, WorkspaceDocField};
use crate::lib::workspace_seed::WorkspaceSeed;

// Format-only validation for the per-agent model override. Letters/digits and
// a small set of separators cover Bedrock inference-profile IDs, region-prefixed
// IDs, and bare vendor SKUs. Membership in any curated list is intentionally
// NOT enforced — users can opt into models the runtime hasn't been told about.
static MODEL_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:\-/]+$").expect("valid model id pattern"));
const MODEL_ID_MAX_LEN: usize = 200;

/// Resolve the effective model ID from a stored per-agent override: the
/// override when set, otherwise the runtime's env-configured default. Single
/// source of truth for the fallback rule — call sites must not inline
/// `.unwrap_or(config.chat_model_id)` themselves. The default is provider-neutral
/// (`chat_model_id` resolves to the active vendor's model).
pub fn resolve_effective_model(stored: Option<&str>) -> String {
    stored
        .map(str::to_string)
        .unwrap_or_else(|| crate::config::CONFIG.chat_model_id.clone())
}

/// Resolve the effective model for a scoped override (heartbeat or cron): the
/// scoped override when set, otherwise the main per-agent override, otherwise
/// the runtime's env-configured default. Layers on top of
/// `resolve_effective_model` so the `config.chat_model_id` fallback stays in
/// exactly one place.
pub fn resolve_scoped_model(scoped: Option<&str>, main: Option<&str>) -> String {
    resolve_effective_model(scoped.or(main))
}

/// `String.prototype.trim`: JavaScript's whitespace and line terminators.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Validate and normalize a model-override input. Accepts a non-empty string
/// (format-checked, trimmed) or `null` to clear. Fails with `ValidationError` on
/// anything else. Shared by every model setter so the format rule lives once.
fn normalize_model_override(model: &Value) -> Result<Option<String>, ValidationError> {
    match model {
        Value::Null => Ok(None),
        Value::String(text) => {
            let trimmed = js_trim(text);
            let length = crate::support::js::len16(trimmed);
            if length == 0 || length > MODEL_ID_MAX_LEN || !MODEL_ID_PATTERN.is_match(trimmed) {
                return Err(ValidationError::new(format!(
                    "model must be 1-{MODEL_ID_MAX_LEN} chars of [A-Za-z0-9._:-/], or null to clear"
                )));
            }
            Ok(Some(trimmed.to_string()))
        }
        _ => Err(ValidationError::new("model must be a string or null")),
    }
}

/// The note a restore records when the caller supplies none. It names the
/// revision that was restored, since the history row otherwise says only that
/// something was restored.
fn default_rollback_reason(restored_from: &DateTime<Utc>) -> String {
    format!(
        "Restored the revision from {}.",
        crate::support::iso(restored_from)
    )
}

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// A subagent's full agent row plus the description its link holds.
#[derive(Debug, Clone, Serialize)]
pub struct SubagentWorkspace {
    #[serde(flatten)]
    pub agent: AgentWorkspace,
    pub description: String,
}

/// A scoped model override (heartbeat/cron) plus the model it resolves to.
/// `override` is the raw stored value (`None` when unset); `effective` is what
/// the corresponding run would actually use after applying the fallback chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOverrideInfo {
    pub r#override: Option<String>,
    pub effective: String,
}

/// Fixed or Auto, as the settings screen and the API name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelModeName {
    Fixed,
    Auto,
}

impl ModelModeName {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelModeName::Fixed => "fixed",
            ModelModeName::Auto => "auto",
        }
    }
}

/// The selection mode, stored and in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelModeInfo {
    pub r#override: Option<ModelModeName>,
    pub effective: ModelModeName,
}

/// One Auto tier, stored and in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTierInfo {
    pub r#override: Option<String>,
    pub effective: Option<String>,
}

/// The three Auto tiers, smallest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelTiersInfo {
    pub small: ModelTierInfo,
    pub medium: ModelTierInfo,
    pub large: ModelTierInfo,
}

/// The model selection as the settings screen shows it: per field, the stored
/// value (`None` when the agent has not set one) and the value in force after
/// the deployment default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelSelectionInfo {
    pub mode: ModelModeInfo,
    pub tiers: ModelTiersInfo,
}

#[derive(Debug, Clone)]
pub struct CreateAgentInput {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub agent_type: AgentType,
    pub team_name: String,
    /// Documents that replace the default templates (`PRISM_WORKSPACE_SEED_DIR`).
    pub documents: Option<WorkspaceSeed>,
}

/// One write to one identity document. `reason` is what the history shows the
/// user: the agent supplies its `changeDescription`, and a user write supplies
/// its own note.
#[derive(Debug, Clone)]
pub struct WriteWorkspaceDocInput {
    pub agent_id: String,
    pub field: WorkspaceDocField,
    pub content: String,
    pub actor: DocumentWriteActor,
    pub method: DocumentWriteMethod,
    pub reason: String,
}

/// One restore of one identity document. `expected_revision_id` is the newest
/// revision the caller read; a write that lands in between makes it stale and the
/// restore is refused rather than applied over the newer content.
#[derive(Debug, Clone)]
pub struct RollbackWorkspaceDocInput {
    pub agent_id: String,
    pub field: WorkspaceDocField,
    pub revision_id: String,
    pub expected_revision_id: String,
    pub reason: String,
}

/// What a restore did. An enum rather than an error, so the route maps each
/// outcome to its status code and nothing else has to know the codes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RollbackWorkspaceDocResult {
    Restored {
        content: String,
        revision: AgentWorkspaceRevision,
    },
    RevisionNotFound,
    Stale {
        #[serde(rename = "newestRevisionId")]
        newest_revision_id: Option<String>,
    },
}

/// Who may delete the agent: the owner named by `user_id`, or anyone the team allows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeleteAgentOptions {
    pub user_id: Option<String>,
    pub allowed_by_team: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteAgentResult {
    Deleted,
    Forbidden,
}

impl DeleteAgentResult {
    pub fn as_str(self) -> &'static str {
        match self {
            DeleteAgentResult::Deleted => "deleted",
            DeleteAgentResult::Forbidden => "forbidden",
        }
    }
}

/// What adding a subagent did: the child agent, or why it was refused.
#[derive(Debug, Clone)]
pub enum AddSubagentResult {
    Added(AgentWorkspace),
    ParentNotFound,
    ChildNotFound,
    SelfReference,
    AlreadyExists,
    NotSubagentType,
    ParentIsSubagent,
}

impl AddSubagentResult {
    /// The refusal code, or `None` for an added subagent.
    pub fn refusal(&self) -> Option<&'static str> {
        match self {
            AddSubagentResult::Added(_) => None,
            AddSubagentResult::ParentNotFound => Some("parent_not_found"),
            AddSubagentResult::ChildNotFound => Some("child_not_found"),
            AddSubagentResult::SelfReference => Some("self_reference"),
            AddSubagentResult::AlreadyExists => Some("already_exists"),
            AddSubagentResult::NotSubagentType => Some("not_subagent_type"),
            AddSubagentResult::ParentIsSubagent => Some("parent_is_subagent"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveSubagentResult {
    Deleted,
    ParentNotFound,
    LinkNotFound,
}

impl RemoveSubagentResult {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoveSubagentResult::Deleted => "deleted",
            RemoveSubagentResult::ParentNotFound => "parent_not_found",
            RemoveSubagentResult::LinkNotFound => "link_not_found",
        }
    }
}

/// Caller input that fails validation. Lets HTTP callers map to 400 while
/// non-HTTP callers (e.g. agent tools) just surface the message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ValidationError(pub String);

impl ValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

// ============================================================================
// Agent Service
// ============================================================================

pub struct AgentWorkspaceService;

impl AgentWorkspaceService {
    pub fn new() -> Self {
        AgentWorkspaceService
    }

    /// Create a new agent with org/team context. The seed revisions land with the
    /// row, so the content the agent was created with is the oldest thing its
    /// history holds.
    pub async fn create_agent(&self, input: CreateAgentInput) -> anyhow::Result<AgentWorkspace> {
        todo!()
    }

    // ========================================================================
    // Agent Lookup & Access
    // ========================================================================

    /// Delete the agent this runtime owns, with an optional ownership check.
    /// Resolves the single agent via `get_agent()` (which fails if it's
    /// missing). Returns `Forbidden` when the ownership check fails,
    /// `Deleted` on success.
    pub async fn delete_agent(
        &self,
        options: Option<DeleteAgentOptions>,
    ) -> anyhow::Result<DeleteAgentResult> {
        todo!()
    }

    /// Get subagents for a given agent.
    /// Returns full agent data + description (frontend needs status, agentType, etc.).
    pub async fn get_subagents(&self, agent_id: &str) -> anyhow::Result<Vec<SubagentWorkspace>> {
        todo!()
    }

    /// Add a subagent to a parent agent.
    pub async fn add_subagent(
        &self,
        parent_agent_id: &str,
        child_agent_id: &str,
        description: Option<&str>,
    ) -> anyhow::Result<AddSubagentResult> {
        todo!()
    }

    /// Remove a subagent from a parent agent.
    pub async fn remove_subagent(
        &self,
        parent_agent_id: &str,
        child_agent_id: &str,
    ) -> anyhow::Result<RemoveSubagentResult> {
        todo!()
    }

    /// Get the one agent this runtime owns (resolved from `config.agent_id`,
    /// pinned at boot by `resolve_or_bootstrap_single_agent`). Fails with
    /// `AGENT_ID not configured` if AGENT_ID is unset, or `Agent <id> not found`
    /// if the row is missing.
    pub async fn get_agent(&self) -> anyhow::Result<AgentWorkspace> {
        todo!()
    }

    /// `get_agent` on a connection the caller holds. Inside a transaction, pass
    /// its connection: a read outside it waits on the transaction's lock.
    pub fn get_agent_in(&self, conn: &mut SqliteConnection) -> anyhow::Result<AgentWorkspace> {
        todo!()
    }

    pub async fn get_all_agents(&self) -> anyhow::Result<Vec<AgentWorkspace>> {
        todo!()
    }

    /// Rename the agent. Shared by the management `PATCH /agents/name`
    /// endpoint and the `rename_self` agent tool so trim/validate/persist live
    /// in one place. Resolves the single agent via `get_agent()` (which fails
    /// if it's missing). Fails with `ValidationError` for bad input.
    pub async fn rename_agent(&self, name: &Value) -> anyhow::Result<AgentWorkspace> {
        todo!()
    }

    /// Resolve the effective LLM model for an agent: the per-agent override if
    /// set, otherwise the runtime's env-configured default. Callers that need
    /// the raw override (e.g. to decide whether to display "unset") should use
    /// `get_agent().model` instead.
    pub async fn get_effective_model(&self) -> anyhow::Result<String> {
        todo!()
    }

    /// Set or clear the per-agent LLM model override. Passing `null` clears the
    /// override and the agent falls back to the runtime's default model
    /// (`config.chat_model_id`). Validates format only — the model ID does NOT
    /// have to be in the curated suggestion list, so users can opt into models
    /// the runtime hasn't been told about yet. Returns the **resolved** effective
    /// model after the write, so callers (e.g. the PATCH route) don't have to
    /// reimplement the `config.chat_model_id` fallback.
    pub async fn update_model(&self, model: &Value) -> anyhow::Result<String> {
        todo!()
    }

    /// Read the heartbeat-specific model override and the model it currently
    /// resolves to. `override` is the raw stored value (`None` when unset, so the
    /// UI can render "empty → falls back"); `effective` is what a heartbeat run
    /// would actually use (heartbeat override → main override → env default).
    pub async fn get_heartbeat_model_info(&self) -> anyhow::Result<ModelOverrideInfo> {
        todo!()
    }

    /// Cron equivalent of `get_heartbeat_model_info`.
    pub async fn get_cron_model_info(&self) -> anyhow::Result<ModelOverrideInfo> {
        todo!()
    }

    /// Set or clear the heartbeat-specific model override. `null` clears it; the
    /// agent then falls back to the main override, then the env default. Validates
    /// format only (same rule as `update_model`). Returns the raw override
    /// and the resolved effective model after the write.
    pub async fn update_heartbeat_model(&self, model: &Value) -> anyhow::Result<ModelOverrideInfo> {
        todo!()
    }

    /// Set the verbose (per-step delivery) flag. When false (default), only the
    /// final text step of a multi-step chat turn is delivered to the channel;
    /// intermediate steps are still persisted. When true, every text step is
    /// delivered as it arrives (existing behavior).
    pub async fn update_verbose(&self, verbose: &Value) -> anyhow::Result<bool> {
        todo!()
    }

    /// Set locked-in mode. When on, the agent's own tools may no longer rewrite
    /// the workspace markdown files (soul, memory summary, user profile, vision,
    /// heartbeat config, bootstrap) — those tools are withheld from the tool set
    /// and their writes refused. The agent guide is not in the set because no tool
    /// writes it. The user's own REST editor reaches every document either way.
    /// Vector memory, behavioural settings and renames stay editable.
    pub async fn update_locked_in(&self, locked_in: &Value) -> anyhow::Result<bool> {
        todo!()
    }

    /// Read locked-in mode from the live agent row.
    pub async fn is_locked_in(&self) -> anyhow::Result<bool> {
        todo!()
    }

    /// The one write path for an identity document. It replaces the column and
    /// appends a revision in one transaction, so a document and its history cannot
    /// disagree: a failed write leaves neither.
    ///
    /// The caller checks the lock, restarts the heartbeat and emits its own
    /// telemetry, because each of those differs per call site while this does not.
    /// Returns the stored content.
    pub async fn write_workspace_doc(
        &self,
        input: WriteWorkspaceDocInput,
    ) -> anyhow::Result<String> {
        todo!()
    }

    /// Restore an earlier revision of one identity document.
    ///
    /// One transaction reads the target revision, compares the newest revision
    /// against `expected_revision_id`, replaces the column and records the restore as
    /// a revision of its own. The history keeps every step, so a restore is itself
    /// reversible.
    ///
    /// Locked-in mode does not gate this. That lock withholds the agent's own
    /// writers, and a restore is the user acting.
    pub async fn rollback_workspace_doc(
        &self,
        input: RollbackWorkspaceDocInput,
    ) -> anyhow::Result<RollbackWorkspaceDocResult> {
        todo!()
    }

    /// Replace one identity document on the user's behalf. Locked-in mode does not
    /// gate this — that lock covers what the agent's own tools may rewrite.
    ///
    /// `reason` is the note the history shows for this write. Returns the stored
    /// content. Fails with `ValidationError` (`<field> must be a string`) when
    /// `content` is not a string.
    pub async fn update_workspace_doc(
        &self,
        field: WorkspaceDocField,
        content: &Value,
        reason: Option<&Value>,
    ) -> anyhow::Result<String> {
        todo!()
    }

    /// Read the agent's model selection: mode and tiers, stored and effective.
    pub async fn get_model_selection_info(&self) -> anyhow::Result<ModelSelectionInfo> {
        todo!()
    }

    /// Update the model selection. Each field present in `input` (`mode`, `small`,
    /// `medium`, `large`) is written, and `null` clears it back to the deployment
    /// default. A result in Auto mode with no small or no large model is refused
    /// with `ValidationError`, since Auto needs both. The check and the write are
    /// one transaction.
    pub async fn update_model_selection(
        &self,
        input: &Map<String, Value>,
    ) -> anyhow::Result<ModelSelectionInfo> {
        todo!()
    }

    /// Cron equivalent of `update_heartbeat_model`.
    pub async fn update_cron_model(&self, model: &Value) -> anyhow::Result<ModelOverrideInfo> {
        todo!()
    }
}

impl Default for AgentWorkspaceService {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize_model_mode(mode: &Value) -> Result<Option<AgentModelMode>, ValidationError> {
    match mode {
        Value::Null => Ok(None),
        Value::String(text) if text == "fixed" => Ok(Some(AgentModelMode::Fixed)),
        Value::String(text) if text == "auto" => Ok(Some(AgentModelMode::Auto)),
        _ => Err(ValidationError::new(
            "mode must be 'fixed', 'auto', or null to clear",
        )),
    }
}

fn to_model_selection_info(agent: &AgentWorkspace) -> ModelSelectionInfo {
    todo!()
}

pub static AGENT_WORKSPACE_SERVICE: LazyLock<AgentWorkspaceService> =
    LazyLock::new(AgentWorkspaceService::new);
