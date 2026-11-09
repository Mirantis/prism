//! Agent CRUD Service
//!
//! Manages agent lifecycle: creation, deletion, lookups, ownership validation,
//! platform token management, and subagent relationships.
//!
//! This is the authoritative service for agent data — the backend delegates
//! all agent operations here via the management API.

use std::collections::HashMap;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use diesel::SqliteConnection;
use diesel::prelude::*;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::config::{CONFIG, ModelSelectionMode};
use crate::db::models::{
    AgentModelMode, AgentSubagent, AgentType, AgentWorkspace, AgentWorkspaceChangeset,
    AgentWorkspaceRevision, NewAgentSubagent, NewAgentWorkspace,
};
use crate::db::schema::agent_subagents::dsl as s;
use crate::db::schema::agent_workspaces::dsl as w;
use crate::lib::agent_name::{AGENT_NAME_RULE, normalise_agent_name};
use crate::lib::model_selection::{
    MODEL_TIERS, ModelTier, StoredModelSelection, missing_auto_tiers, resolve_model_selection,
};
use crate::lib::telemetry::track_event;
use crate::lib::workspace_docs::{DocumentWriteActor, DocumentWriteMethod, WorkspaceDocField};
use crate::lib::workspace_seed::WorkspaceSeed;
use crate::log_info;
use crate::services::document_revision_service::{DOCUMENT_REVISION_SERVICE, RecordRevisionInput};
use crate::templates::default_workspace::get_default_workspace_files;

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
    crate::support::js::trim(text)
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

/// The selection mode, stored and in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelModeInfo {
    pub r#override: Option<ModelSelectionMode>,
    pub effective: ModelSelectionMode,
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
        static REGISTER_LOG_FIELDS: std::sync::Once = std::sync::Once::new();
        REGISTER_LOG_FIELDS
            .call_once(|| crate::lib::log_redaction::register_error_fields(validation_error_name));
        Self(message.into())
    }
}

/// The error's `name`, so a log line and a tool result read `ValidationError`.
fn validation_error_name(error: &(dyn std::error::Error + 'static)) -> Option<Map<String, Value>> {
    error.downcast_ref::<ValidationError>()?;
    let mut fields = Map::new();
    fields.insert("name".into(), json!("ValidationError"));
    Some(fields)
}

// ============================================================================
// Agent Service
// ============================================================================

pub struct AgentWorkspaceService;

/// `prisma.agentWorkspace.update({ where: { id }, data })`: the updated row, or an
/// error when no row has the id.
fn update_agent(
    conn: &mut SqliteConnection,
    id: &str,
    changeset: &AgentWorkspaceChangeset,
) -> anyhow::Result<AgentWorkspace> {
    Ok(diesel::update(w::agent_workspaces.filter(w::id.eq(id)))
        .set(changeset)
        .returning(AgentWorkspace::as_returning())
        .get_result(conn)?)
}

/// `prisma.agentWorkspace.findUnique({ where: { id } })`.
fn find_agent(conn: &mut SqliteConnection, id: &str) -> anyhow::Result<Option<AgentWorkspace>> {
    Ok(w::agent_workspaces
        .filter(w::id.eq(id))
        .select(AgentWorkspace::as_select())
        .first(conn)
        .optional()?)
}

/// The `{ 'agent.id': id }` props most events start with.
fn props(pairs: &[(&str, String)]) -> Option<IndexMap<String, String>> {
    Some(
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect(),
    )
}

impl AgentWorkspaceService {
    pub fn new() -> Self {
        AgentWorkspaceService
    }

    /// Create a new agent with org/team context. The seed revisions land with the
    /// row, so the content the agent was created with is the oldest thing its
    /// history holds.
    pub async fn create_agent(&self, input: CreateAgentInput) -> anyhow::Result<AgentWorkspace> {
        let defaults = get_default_workspace_files();
        let seed = input.documents.clone().unwrap_or_default();
        let doc = |field: WorkspaceDocField, default: String| -> String {
            seed.get(field).map(str::to_string).unwrap_or(default)
        };

        // Every document gets the name placeholders filled, since a seeded one may
        // use them as the default bootstrap does.
        let name = input.name.clone();
        let team_name = input.team_name.clone();
        let fill = |text: String| -> String {
            text.replace("{{agentName}}", &name)
                .replace("{{teamName}}", &team_name)
        };

        let mut row = NewAgentWorkspace::new(
            input.user_id.clone(),
            fill(doc(WorkspaceDocField::SoulMd, defaults.soul_md)),
            fill(doc(WorkspaceDocField::UserMd, defaults.user_md)),
            doc(WorkspaceDocField::MemoryMd, defaults.memory_md),
            fill(doc(WorkspaceDocField::HeartbeatMd, defaults.heartbeat_md)),
            fill(doc(WorkspaceDocField::BootstrapMd, defaults.bootstrap_md)),
        );
        row.id = input.id.clone();
        row.name = input.name.clone();
        row.agent_type = input.agent_type;
        row.vision_md = fill(doc(WorkspaceDocField::VisionMd, defaults.vision_md));
        row.agent_md = fill(doc(WorkspaceDocField::AgentMd, defaults.agent_md));
        row.current_session_id = Some(Uuid::new_v4().to_string());
        row.heartbeat_interval_ms = CONFIG.heartbeat_interval_ms;
        // Seed model overrides from ~/.prism/settings.json when present; None
        // leaves the agent on the env-default model (resolve_effective_model).
        row.model = CONFIG.agent_defaults.model.clone();
        row.heartbeat_model = CONFIG.agent_defaults.heartbeat_model.clone();
        row.cron_model = CONFIG.agent_defaults.cron_model.clone();

        // The seed revisions land with the row, so the content the agent was
        // created with is the oldest thing its history holds. Without them the
        // oldest reachable state is the first edit.
        let agent = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let created: AgentWorkspace = diesel::insert_into(w::agent_workspaces)
                    .values(&row)
                    .returning(AgentWorkspace::as_returning())
                    .get_result(conn)?;
                DOCUMENT_REVISION_SERVICE.record_seeds(conn, &created)?;
                anyhow::Ok(created)
            })
        })
        .await?;
        track_event(
            "agent created",
            Some(&input.user_id),
            props(&[
                ("agent.id", agent.id.clone()),
                ("agent.type", agent.agent_type.as_str().to_string()),
                ("agent.seeded_documents", seed.fields().len().to_string()),
            ]),
        );
        Ok(agent)
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
        let options = options.unwrap_or_default();
        let agent = self.get_agent().await?;
        let allowed_by_team = options.allowed_by_team.unwrap_or(false);
        let owner_matches = options
            .user_id
            .as_deref()
            .is_some_and(|user_id| !user_id.is_empty() && agent.user_id == user_id);
        if !allowed_by_team && !owner_matches {
            return Ok(DeleteAgentResult::Forbidden);
        }
        let id = agent.id.clone();
        crate::db::run(move |conn| {
            let deleted =
                diesel::delete(w::agent_workspaces.filter(w::id.eq(&id))).execute(conn)?;
            if deleted == 0 {
                anyhow::bail!("Record to delete does not exist.");
            }
            Ok(())
        })
        .await?;
        let user_id = options.user_id.unwrap_or_else(|| agent.user_id.clone());
        track_event(
            "agent deleted",
            Some(&user_id),
            props(&[("agent.id", agent.id.clone())]),
        );
        Ok(DeleteAgentResult::Deleted)
    }

    /// Get subagents for a given agent.
    /// Returns full agent data + description (frontend needs status, agentType, etc.).
    pub async fn get_subagents(&self, agent_id: &str) -> anyhow::Result<Vec<SubagentWorkspace>> {
        let agent_id = agent_id.to_string();
        crate::db::read(move |conn| {
            let links: Vec<AgentSubagent> = s::agent_subagents
                .filter(s::parent_agent_id.eq(&agent_id))
                .order(s::created_at.asc())
                .select(AgentSubagent::as_select())
                .load(conn)?;
            let child_ids: Vec<&str> = links.iter().map(|l| l.child_agent_id.as_str()).collect();
            let children: HashMap<String, AgentWorkspace> = w::agent_workspaces
                .filter(w::id.eq_any(&child_ids))
                .select(AgentWorkspace::as_select())
                .load(conn)?
                .into_iter()
                .map(|a| (a.id.clone(), a))
                .collect();
            Ok(links
                .into_iter()
                .filter_map(|link| {
                    children
                        .get(&link.child_agent_id)
                        .map(|agent| SubagentWorkspace {
                            agent: agent.clone(),
                            description: link.description,
                        })
                })
                .collect())
        })
        .await
    }

    /// Add a subagent to a parent agent.
    pub async fn add_subagent(
        &self,
        parent_agent_id: &str,
        child_agent_id: &str,
        description: Option<&str>,
    ) -> anyhow::Result<AddSubagentResult> {
        if parent_agent_id == child_agent_id {
            return Ok(AddSubagentResult::SelfReference);
        }

        let parent_id = parent_agent_id.to_string();
        let child_id = child_agent_id.to_string();
        let description = description.filter(|d| !d.is_empty()).map(str::to_string);
        let result = crate::db::run(move |conn| {
            let Some(parent) = find_agent(conn, &parent_id)? else {
                return Ok(AddSubagentResult::ParentNotFound);
            };
            if parent.agent_type == AgentType::Subagent {
                return Ok(AddSubagentResult::ParentIsSubagent);
            }

            let Some(child) = find_agent(conn, &child_id)? else {
                return Ok(AddSubagentResult::ChildNotFound);
            };
            if child.agent_type != AgentType::Subagent {
                return Ok(AddSubagentResult::NotSubagentType);
            }

            let existing: Option<String> = s::agent_subagents
                .filter(s::parent_agent_id.eq(&parent_id))
                .filter(s::child_agent_id.eq(&child_id))
                .select(s::id)
                .first(conn)
                .optional()?;
            if existing.is_some() {
                return Ok(AddSubagentResult::AlreadyExists);
            }

            let mut link = NewAgentSubagent::new(parent_id.clone(), child_id.clone());
            if let Some(description) = description {
                link.description = description;
            }
            diesel::insert_into(s::agent_subagents)
                .values(&link)
                .execute(conn)?;
            Ok(AddSubagentResult::Added(child))
        })
        .await?;

        if matches!(result, AddSubagentResult::Added(_)) {
            track_event(
                "subagent added",
                None,
                props(&[
                    ("agent.id", parent_agent_id.to_string()),
                    ("subagent.id", child_agent_id.to_string()),
                ]),
            );
        }
        Ok(result)
    }

    /// Remove a subagent from a parent agent.
    pub async fn remove_subagent(
        &self,
        parent_agent_id: &str,
        child_agent_id: &str,
    ) -> anyhow::Result<RemoveSubagentResult> {
        let parent_id = parent_agent_id.to_string();
        let child_id = child_agent_id.to_string();
        let result = crate::db::run(move |conn| {
            if find_agent(conn, &parent_id)?.is_none() {
                return Ok(RemoveSubagentResult::ParentNotFound);
            }
            let link: Option<String> = s::agent_subagents
                .filter(s::parent_agent_id.eq(&parent_id))
                .filter(s::child_agent_id.eq(&child_id))
                .select(s::id)
                .first(conn)
                .optional()?;
            let Some(link_id) = link else {
                return Ok(RemoveSubagentResult::LinkNotFound);
            };
            let deleted =
                diesel::delete(s::agent_subagents.filter(s::id.eq(&link_id))).execute(conn)?;
            if deleted == 0 {
                anyhow::bail!("Record to delete does not exist.");
            }
            Ok(RemoveSubagentResult::Deleted)
        })
        .await?;
        if result == RemoveSubagentResult::Deleted {
            track_event(
                "subagent removed",
                None,
                props(&[
                    ("agent.id", parent_agent_id.to_string()),
                    ("subagent.id", child_agent_id.to_string()),
                ]),
            );
        }
        Ok(result)
    }

    /// Get the one agent this runtime owns (resolved from `config.agent_id`,
    /// pinned at boot by `resolve_or_bootstrap_single_agent`). Fails with
    /// `AGENT_ID not configured` if AGENT_ID is unset, or `Agent <id> not found`
    /// if the row is missing.
    pub async fn get_agent(&self) -> anyhow::Result<AgentWorkspace> {
        let agent_id = configured_agent_id()?;
        let found = {
            let agent_id = agent_id.clone();
            crate::db::read(move |conn| find_agent(conn, &agent_id)).await?
        };
        found.ok_or_else(|| anyhow::anyhow!("Agent {agent_id} not found"))
    }

    /// `get_agent` on a connection the caller holds. Inside a transaction, pass
    /// its connection: a read outside it waits on the transaction's lock.
    pub fn get_agent_in(&self, conn: &mut SqliteConnection) -> anyhow::Result<AgentWorkspace> {
        let agent_id = configured_agent_id()?;
        find_agent(conn, &agent_id)?.ok_or_else(|| anyhow::anyhow!("Agent {agent_id} not found"))
    }

    pub async fn get_all_agents(&self) -> anyhow::Result<Vec<AgentWorkspace>> {
        crate::db::read(|conn| {
            Ok(w::agent_workspaces
                .select(AgentWorkspace::as_select())
                .load(conn)?)
        })
        .await
    }

    /// Rename the agent. Shared by the management `PATCH /agents/name`
    /// endpoint and the `rename_self` agent tool so trim/validate/persist live
    /// in one place. Resolves the single agent via `get_agent()` (which fails
    /// if it's missing). Fails with `ValidationError` for bad input.
    pub async fn rename_agent(&self, name: &Value) -> anyhow::Result<AgentWorkspace> {
        // Held to the rule for names (`lib/agent_name.rs`), an empty name included.
        let Some(normalised) = normalise_agent_name(name.as_str().unwrap_or("")) else {
            return Err(ValidationError::new(AGENT_NAME_RULE).into());
        };
        let agent = self.get_agent().await?;
        let updated = crate::db::run(move |conn| {
            update_agent(
                conn,
                &agent.id,
                &AgentWorkspaceChangeset {
                    name: Some(normalised),
                    ..Default::default()
                },
            )
        })
        .await?;
        track_event(
            "agent renamed",
            None,
            props(&[
                ("agent.id", updated.id.clone()),
                ("agent.name", updated.name.clone()),
            ]),
        );
        Ok(updated)
    }

    /// Resolve the effective LLM model for an agent: the per-agent override if
    /// set, otherwise the runtime's env-configured default. Callers that need
    /// the raw override (e.g. to decide whether to display "unset") should use
    /// `get_agent().model` instead.
    pub async fn get_effective_model(&self) -> anyhow::Result<String> {
        let agent = self.get_agent().await?;
        Ok(resolve_effective_model(agent.model.as_deref()))
    }

    /// Set or clear the per-agent LLM model override. Passing `null` clears the
    /// override and the agent falls back to the runtime's default model
    /// (`config.chat_model_id`). Validates format only — the model ID does NOT
    /// have to be in the curated suggestion list, so users can opt into models
    /// the runtime hasn't been told about yet. Returns the **resolved** effective
    /// model after the write, so callers (e.g. the PATCH route) don't have to
    /// reimplement the `config.chat_model_id` fallback.
    pub async fn update_model(&self, model: &Value) -> anyhow::Result<String> {
        let normalized = normalize_model_override(model)?;
        let agent = self.get_agent().await?;
        let updated = crate::db::run(move |conn| {
            update_agent(
                conn,
                &agent.id,
                &AgentWorkspaceChangeset {
                    model: Some(normalized),
                    ..Default::default()
                },
            )
        })
        .await?;
        let effective = resolve_effective_model(updated.model.as_deref());
        track_event(
            "agent model updated",
            None,
            props(&[
                ("agent.id", updated.id.clone()),
                ("agent.model", effective.clone()),
            ]),
        );
        Ok(effective)
    }

    /// Read the heartbeat-specific model override and the model it currently
    /// resolves to. `override` is the raw stored value (`None` when unset, so the
    /// UI can render "empty → falls back"); `effective` is what a heartbeat run
    /// would actually use (heartbeat override → main override → env default).
    pub async fn get_heartbeat_model_info(&self) -> anyhow::Result<ModelOverrideInfo> {
        let agent = self.get_agent().await?;
        Ok(ModelOverrideInfo {
            effective: resolve_scoped_model(
                agent.heartbeat_model.as_deref(),
                agent.model.as_deref(),
            ),
            r#override: agent.heartbeat_model,
        })
    }

    /// Cron equivalent of `get_heartbeat_model_info`.
    pub async fn get_cron_model_info(&self) -> anyhow::Result<ModelOverrideInfo> {
        let agent = self.get_agent().await?;
        Ok(ModelOverrideInfo {
            effective: resolve_scoped_model(agent.cron_model.as_deref(), agent.model.as_deref()),
            r#override: agent.cron_model,
        })
    }

    /// Set or clear the heartbeat-specific model override. `null` clears it; the
    /// agent then falls back to the main override, then the env default. Validates
    /// format only (same rule as `update_model`). Returns the raw override
    /// and the resolved effective model after the write.
    pub async fn update_heartbeat_model(&self, model: &Value) -> anyhow::Result<ModelOverrideInfo> {
        let normalized = normalize_model_override(model)?;
        let agent = self.get_agent().await?;
        let updated = crate::db::run(move |conn| {
            update_agent(
                conn,
                &agent.id,
                &AgentWorkspaceChangeset {
                    heartbeat_model: Some(normalized),
                    ..Default::default()
                },
            )
        })
        .await?;
        let effective =
            resolve_scoped_model(updated.heartbeat_model.as_deref(), updated.model.as_deref());
        log_info!(
            json!({ "agentId": updated.id, "heartbeatModel": updated.heartbeat_model, "effective": effective }),
            "[AgentWorkspace] heartbeat model updated"
        );
        track_event(
            "agent heartbeat model updated",
            None,
            props(&[
                ("agent.id", updated.id.clone()),
                ("agent.model", effective.clone()),
            ]),
        );
        Ok(ModelOverrideInfo {
            r#override: updated.heartbeat_model,
            effective,
        })
    }

    /// Set the verbose (per-step delivery) flag. When false (default), only the
    /// final text step of a multi-step chat turn is delivered to the channel;
    /// intermediate steps are still persisted. When true, every text step is
    /// delivered as it arrives (existing behavior).
    pub async fn update_verbose(&self, verbose: &Value) -> anyhow::Result<bool> {
        let Some(verbose) = verbose.as_bool() else {
            return Err(ValidationError::new("verbose must be a boolean").into());
        };
        let agent = self.get_agent().await?;
        let updated = crate::db::run(move |conn| {
            update_agent(
                conn,
                &agent.id,
                &AgentWorkspaceChangeset {
                    verbose: Some(verbose),
                    ..Default::default()
                },
            )
        })
        .await?;
        track_event(
            "agent verbose updated",
            None,
            props(&[
                ("agent.id", updated.id.clone()),
                ("agent.verbose", updated.verbose.to_string()),
            ]),
        );
        Ok(updated.verbose)
    }

    /// Set locked-in mode. When on, the agent's own tools may no longer rewrite
    /// the workspace markdown files (soul, memory summary, user profile, vision,
    /// heartbeat config, bootstrap) — those tools are withheld from the tool set
    /// and their writes refused. The agent guide is not in the set because no tool
    /// writes it. The user's own REST editor reaches every document either way.
    /// Vector memory, behavioural settings and renames stay editable.
    pub async fn update_locked_in(&self, locked_in: &Value) -> anyhow::Result<bool> {
        let Some(locked_in) = locked_in.as_bool() else {
            return Err(ValidationError::new("lockedIn must be a boolean").into());
        };
        let agent = self.get_agent().await?;
        let updated = crate::db::run(move |conn| {
            update_agent(
                conn,
                &agent.id,
                &AgentWorkspaceChangeset {
                    locked_in: Some(locked_in),
                    ..Default::default()
                },
            )
        })
        .await?;
        track_event(
            "agent locked-in updated",
            None,
            props(&[
                ("agent.id", updated.id.clone()),
                ("agent.locked_in", updated.locked_in.to_string()),
            ]),
        );
        Ok(updated.locked_in)
    }

    /// Read locked-in mode from the live agent row.
    pub async fn is_locked_in(&self) -> anyhow::Result<bool> {
        let agent = self.get_agent().await?;
        Ok(agent.locked_in)
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
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let updated = update_agent(
                    conn,
                    &input.agent_id,
                    &input.field.changeset(input.content.clone()),
                )?;
                DOCUMENT_REVISION_SERVICE.record(
                    conn,
                    RecordRevisionInput {
                        agent_id: input.agent_id.clone(),
                        field: input.field,
                        content: input.content.clone(),
                        actor: input.actor,
                        method: input.method,
                        reason: input.reason.clone(),
                    },
                )?;
                anyhow::Ok(input.field.read(&updated).to_string())
            })
        })
        .await
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
        let agent_id = input.agent_id.clone();
        let field = input.field;
        let result = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let Some(target) = DOCUMENT_REVISION_SERVICE.get(
                    conn,
                    &input.agent_id,
                    input.field,
                    &input.revision_id,
                )?
                else {
                    return Ok(RollbackWorkspaceDocResult::RevisionNotFound);
                };

                let newest =
                    DOCUMENT_REVISION_SERVICE.newest(conn, &input.agent_id, input.field)?;
                let newest_id = newest.map(|revision| revision.id);
                if newest_id.as_deref() != Some(input.expected_revision_id.as_str()) {
                    return Ok(RollbackWorkspaceDocResult::Stale {
                        newest_revision_id: newest_id,
                    });
                }

                update_agent(
                    conn,
                    &input.agent_id,
                    &input.field.changeset(target.content.clone()),
                )?;
                let trimmed = js_trim(&input.reason);
                let reason = if trimmed.is_empty() {
                    default_rollback_reason(&target.created_at)
                } else {
                    trimmed.to_string()
                };
                let revision = DOCUMENT_REVISION_SERVICE.record(
                    conn,
                    RecordRevisionInput {
                        agent_id: input.agent_id.clone(),
                        field: input.field,
                        content: target.content.clone(),
                        actor: DocumentWriteActor::User,
                        method: DocumentWriteMethod::Rollback,
                        reason,
                    },
                )?;
                anyhow::Ok(RollbackWorkspaceDocResult::Restored {
                    content: target.content,
                    revision,
                })
            })
        })
        .await?;

        match &result {
            RollbackWorkspaceDocResult::Restored { .. } => track_event(
                "agent config updated",
                None,
                props(&[
                    ("agent.id", agent_id),
                    ("config.field", field.as_str().to_string()),
                    ("config.method", "rollback".to_string()),
                ]),
            ),
            // The same shape as a refused locked write: the field and why, no content.
            RollbackWorkspaceDocResult::Stale { .. } => track_event(
                "agent document restore refused",
                None,
                props(&[
                    ("agent.id", agent_id),
                    ("config.field", field.as_str().to_string()),
                    ("restore.refusal", "stale_revision".to_string()),
                ]),
            ),
            RollbackWorkspaceDocResult::RevisionNotFound => {}
        }
        Ok(result)
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
        let Some(content) = content.as_str() else {
            return Err(ValidationError::new(format!("{field} must be a string")).into());
        };
        let agent = self.get_agent().await?;
        let stored = self
            .write_workspace_doc(WriteWorkspaceDocInput {
                agent_id: agent.id.clone(),
                field,
                content: content.to_string(),
                actor: DocumentWriteActor::User,
                method: DocumentWriteMethod::Rest,
                reason: reason.and_then(Value::as_str).unwrap_or("").to_string(),
            })
            .await?;
        track_event(
            "agent config updated",
            None,
            props(&[
                ("agent.id", agent.id.clone()),
                ("config.field", field.as_str().to_string()),
                ("config.method", "rest".to_string()),
            ]),
        );
        Ok(stored)
    }

    /// Read the agent's model selection: mode and tiers, stored and effective.
    pub async fn get_model_selection_info(&self) -> anyhow::Result<ModelSelectionInfo> {
        Ok(to_model_selection_info(&self.get_agent().await?))
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
        let mut data = AgentWorkspaceChangeset::default();
        if let Some(mode) = input.get("mode") {
            data.model_mode = Some(normalize_model_mode(mode)?);
        }
        for tier in MODEL_TIERS {
            if let Some(value) = input.get(tier.as_str()) {
                let normalized = normalize_model_override(value)?;
                match tier {
                    ModelTier::Small => data.small_model = Some(normalized),
                    ModelTier::Medium => data.medium_model = Some(normalized),
                    ModelTier::Large => data.large_model = Some(normalized),
                }
            }
        }

        // One transaction, so two writes in flight cannot each pass the check
        // against the row the other is about to change.
        let (updated, next) = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let agent = AGENT_WORKSPACE_SERVICE.get_agent_in(conn)?;
                let mut stored = StoredModelSelection::from(&agent);
                if let Some(mode) = data.model_mode {
                    stored.model_mode = mode;
                }
                if let Some(small) = &data.small_model {
                    stored.small_model = small.clone();
                }
                if let Some(medium) = &data.medium_model {
                    stored.medium_model = medium.clone();
                }
                if let Some(large) = &data.large_model {
                    stored.large_model = large.clone();
                }
                let merged = resolve_model_selection(&stored);
                let missing = if merged.mode == ModelSelectionMode::Auto {
                    missing_auto_tiers(&merged.tiers)
                } else {
                    Vec::new()
                };
                if !missing.is_empty() {
                    let names: Vec<&str> = missing.iter().map(ModelTier::as_str).collect();
                    return Err(ValidationError::new(format!(
                        "Auto mode needs a {} model",
                        names.join(" and a ")
                    ))
                    .into());
                }
                let row = update_agent(conn, &agent.id, &data)?;
                anyhow::Ok((row, merged))
            })
        })
        .await?;
        let mut event = vec![
            ("agent.id", updated.id.clone()),
            ("agent.model_mode", next.mode.as_str().to_string()),
        ];
        if next.mode == ModelSelectionMode::Auto {
            event.push((
                "agent.model_small",
                next.tiers.small.clone().unwrap_or_default(),
            ));
            event.push((
                "agent.model_medium",
                next.tiers.medium.clone().unwrap_or_default(),
            ));
            event.push((
                "agent.model_large",
                next.tiers.large.clone().unwrap_or_default(),
            ));
        }
        track_event("agent model updated", None, props(&event));
        Ok(to_model_selection_info(&updated))
    }

    /// Cron equivalent of `update_heartbeat_model`.
    pub async fn update_cron_model(&self, model: &Value) -> anyhow::Result<ModelOverrideInfo> {
        let normalized = normalize_model_override(model)?;
        let agent = self.get_agent().await?;
        let updated = crate::db::run(move |conn| {
            update_agent(
                conn,
                &agent.id,
                &AgentWorkspaceChangeset {
                    cron_model: Some(normalized),
                    ..Default::default()
                },
            )
        })
        .await?;
        let effective =
            resolve_scoped_model(updated.cron_model.as_deref(), updated.model.as_deref());
        log_info!(
            json!({ "agentId": updated.id, "cronModel": updated.cron_model, "effective": effective }),
            "[AgentWorkspace] cron model updated"
        );
        track_event(
            "agent cron model updated",
            None,
            props(&[
                ("agent.id", updated.id.clone()),
                ("agent.model", effective.clone()),
            ]),
        );
        Ok(ModelOverrideInfo {
            r#override: updated.cron_model,
            effective,
        })
    }
}

/// `config.agentId`, or the error a missing one gives.
fn configured_agent_id() -> anyhow::Result<String> {
    CONFIG
        .agent_id()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("AGENT_ID not configured"))
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
    let effective = resolve_model_selection(&StoredModelSelection::from(agent));
    ModelSelectionInfo {
        mode: ModelModeInfo {
            r#override: agent.model_mode.map(|mode| match mode {
                AgentModelMode::Auto => ModelSelectionMode::Auto,
                AgentModelMode::Fixed => ModelSelectionMode::Fixed,
            }),
            effective: effective.mode,
        },
        tiers: ModelTiersInfo {
            small: ModelTierInfo {
                r#override: agent.small_model.clone(),
                effective: effective.tiers.small.clone(),
            },
            medium: ModelTierInfo {
                r#override: agent.medium_model.clone(),
                effective: effective.tiers.medium.clone(),
            },
            large: ModelTierInfo {
                r#override: agent.large_model.clone(),
                effective: effective.tiers.large.clone(),
            },
        },
    }
}

pub static AGENT_WORKSPACE_SERVICE: LazyLock<AgentWorkspaceService> =
    LazyLock::new(AgentWorkspaceService::new);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::testing::test_db;
    use crate::lib::workspace_docs::WORKSPACE_DOC_FIELDS;

    async fn create(id: &str, documents: Option<WorkspaceSeed>) -> AgentWorkspace {
        AGENT_WORKSPACE_SERVICE
            .create_agent(CreateAgentInput {
                id: id.to_string(),
                user_id: "test-owner-id".to_string(),
                name: "Atlas".to_string(),
                agent_type: AgentType::Agent,
                team_name: "Ops".to_string(),
                documents,
            })
            .await
            .unwrap()
    }

    #[test]
    fn model_override_validation_keeps_its_messages() {
        assert_eq!(normalize_model_override(&Value::Null), Ok(None));
        assert_eq!(
            normalize_model_override(&json!("  us.anthropic.claude:1  ")),
            Ok(Some("us.anthropic.claude:1".to_string()))
        );
        assert_eq!(
            normalize_model_override(&json!("bad id")).unwrap_err().0,
            "model must be 1-200 chars of [A-Za-z0-9._:-/], or null to clear"
        );
        assert_eq!(
            normalize_model_override(&json!(3)).unwrap_err().0,
            "model must be a string or null"
        );
        assert_eq!(
            normalize_model_mode(&json!("other")).unwrap_err().0,
            "mode must be 'fixed', 'auto', or null to clear"
        );
    }

    #[test]
    fn model_selection_info_serializes_as_the_settings_screen_reads_it() {
        let info = ModelSelectionInfo {
            mode: ModelModeInfo {
                r#override: None,
                effective: ModelSelectionMode::Fixed,
            },
            tiers: ModelTiersInfo {
                small: ModelTierInfo {
                    r#override: Some("s".into()),
                    effective: Some("s".into()),
                },
                medium: ModelTierInfo {
                    r#override: None,
                    effective: None,
                },
                large: ModelTierInfo {
                    r#override: None,
                    effective: None,
                },
            },
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"mode":{"override":null,"effective":"fixed"},"tiers":{"small":{"override":"s","effective":"s"},"medium":{"override":null,"effective":null},"large":{"override":null,"effective":null}}}"#
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn creates_the_agent_with_filled_placeholders_and_seed_revisions() {
        let _db = test_db();
        let seed = WorkspaceSeed {
            soul_md: Some("You are {{agentName}} of {{teamName}}.".to_string()),
            ..Default::default()
        };
        let agent = create("test-agent-id", Some(seed)).await;

        assert_eq!(agent.soul_md, "You are Atlas of Ops.");
        assert!(agent.current_session_id.is_some());
        assert_eq!(agent.heartbeat_interval_ms, CONFIG.heartbeat_interval_ms);
        for field in WORKSPACE_DOC_FIELDS {
            let history = DOCUMENT_REVISION_SERVICE
                .history(&agent, field)
                .await
                .unwrap();
            assert_eq!(history.revisions.len(), 1);
            assert!(!history.drifted);
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_a_document_with_its_revision_and_restores_an_earlier_one() {
        let _db = test_db();
        let agent = create("test-agent-id", None).await;

        let stored = AGENT_WORKSPACE_SERVICE
            .update_workspace_doc(
                WorkspaceDocField::SoulMd,
                &json!("new soul"),
                Some(&json!("tweak")),
            )
            .await
            .unwrap();
        assert_eq!(stored, "new soul");

        let history = DOCUMENT_REVISION_SERVICE
            .history(
                &AGENT_WORKSPACE_SERVICE.get_agent().await.unwrap(),
                WorkspaceDocField::SoulMd,
            )
            .await
            .unwrap();
        assert_eq!(history.revisions.len(), 2);
        let (newest, seed) = (&history.revisions[0], &history.revisions[1]);
        assert_eq!(
            (newest.method.as_str(), newest.reason.as_str()),
            ("rest", "tweak")
        );

        // A stale expectation is refused.
        let stale = AGENT_WORKSPACE_SERVICE
            .rollback_workspace_doc(RollbackWorkspaceDocInput {
                agent_id: agent.id.clone(),
                field: WorkspaceDocField::SoulMd,
                revision_id: seed.id.clone(),
                expected_revision_id: seed.id.clone(),
                reason: String::new(),
            })
            .await
            .unwrap();
        assert!(matches!(
            stale,
            RollbackWorkspaceDocResult::Stale { newest_revision_id: Some(ref id) } if *id == newest.id
        ));

        let restored = AGENT_WORKSPACE_SERVICE
            .rollback_workspace_doc(RollbackWorkspaceDocInput {
                agent_id: agent.id.clone(),
                field: WorkspaceDocField::SoulMd,
                revision_id: seed.id.clone(),
                expected_revision_id: newest.id.clone(),
                reason: "  ".to_string(),
            })
            .await
            .unwrap();
        let RollbackWorkspaceDocResult::Restored { content, revision } = restored else {
            panic!("expected a restore");
        };
        assert_eq!(content, agent.soul_md);
        assert_eq!(revision.method, "rollback");
        assert_eq!(
            revision.reason,
            format!(
                "Restored the revision from {}.",
                crate::support::iso(&seed.created_at)
            )
        );
        assert_eq!(
            AGENT_WORKSPACE_SERVICE.get_agent().await.unwrap().soul_md,
            agent.soul_md
        );

        let missing = AGENT_WORKSPACE_SERVICE
            .rollback_workspace_doc(RollbackWorkspaceDocInput {
                agent_id: agent.id.clone(),
                field: WorkspaceDocField::SoulMd,
                revision_id: "nope".to_string(),
                expected_revision_id: String::new(),
                reason: String::new(),
            })
            .await
            .unwrap();
        assert!(matches!(
            missing,
            RollbackWorkspaceDocResult::RevisionNotFound
        ));
        assert_eq!(
            serde_json::to_string(&missing).unwrap(),
            r#"{"status":"revision_not_found"}"#
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn update_workspace_doc_refuses_content_that_is_not_a_string() {
        let _db = test_db();
        create("test-agent-id", None).await;
        let err = AGENT_WORKSPACE_SERVICE
            .update_workspace_doc(WorkspaceDocField::AgentMd, &json!(3), None)
            .await
            .unwrap_err();
        assert_eq!(
            err.downcast_ref::<ValidationError>().unwrap().0,
            "agentMd must be a string"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renames_holds_names_to_the_rule() {
        let _db = test_db();
        create("test-agent-id", None).await;
        let renamed = AGENT_WORKSPACE_SERVICE
            .rename_agent(&json!("  Max  "))
            .await
            .unwrap();
        assert_eq!(renamed.name, "Max");
        let err = AGENT_WORKSPACE_SERVICE
            .rename_agent(&json!("Max 🚀"))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), AGENT_NAME_RULE);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn model_overrides_resolve_through_the_fallback_chain() {
        let _db = test_db();
        create("test-agent-id", None).await;
        assert_eq!(
            AGENT_WORKSPACE_SERVICE.get_effective_model().await.unwrap(),
            CONFIG.chat_model_id
        );
        assert_eq!(
            AGENT_WORKSPACE_SERVICE
                .update_model(&json!("main-model"))
                .await
                .unwrap(),
            "main-model"
        );
        let info = AGENT_WORKSPACE_SERVICE
            .get_heartbeat_model_info()
            .await
            .unwrap();
        assert_eq!(
            (info.r#override, info.effective.as_str()),
            (None, "main-model")
        );
        let info = AGENT_WORKSPACE_SERVICE
            .update_cron_model(&json!("cron-model"))
            .await
            .unwrap();
        assert_eq!(info.effective, "cron-model");
        assert!(
            AGENT_WORKSPACE_SERVICE
                .update_verbose(&json!(true))
                .await
                .unwrap()
        );
        assert!(
            AGENT_WORKSPACE_SERVICE
                .update_verbose(&json!("yes"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn auto_mode_needs_a_small_and_a_large_model() {
        let _db = test_db();
        create("test-agent-id", None).await;
        let input: Map<String, Value> = serde_json::from_value(json!({ "mode": "auto" })).unwrap();
        let err = AGENT_WORKSPACE_SERVICE
            .update_model_selection(&input)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "Auto mode needs a small and a large model");

        let input: Map<String, Value> =
            serde_json::from_value(json!({ "mode": "auto", "small": "s", "large": "l" })).unwrap();
        let info = AGENT_WORKSPACE_SERVICE
            .update_model_selection(&input)
            .await
            .unwrap();
        assert_eq!(info.mode.r#override, Some(ModelSelectionMode::Auto));
        assert_eq!(info.tiers.large.effective.as_deref(), Some("l"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn subagents_link_only_a_subagent_to_an_agent() {
        let _db = test_db();
        create("test-agent-id", None).await;
        AGENT_WORKSPACE_SERVICE
            .create_agent(CreateAgentInput {
                id: "child".to_string(),
                user_id: "u".to_string(),
                name: "Helper".to_string(),
                agent_type: AgentType::Subagent,
                team_name: "Ops".to_string(),
                documents: None,
            })
            .await
            .unwrap();

        let svc = &*AGENT_WORKSPACE_SERVICE;
        assert_eq!(
            svc.add_subagent("test-agent-id", "test-agent-id", None)
                .await
                .unwrap()
                .refusal(),
            Some("self_reference")
        );
        assert_eq!(
            svc.add_subagent("child", "test-agent-id", None)
                .await
                .unwrap()
                .refusal(),
            Some("parent_is_subagent")
        );
        assert_eq!(
            svc.add_subagent("test-agent-id", "child", Some("does things"))
                .await
                .unwrap()
                .refusal(),
            None
        );
        assert_eq!(
            svc.add_subagent("test-agent-id", "child", None)
                .await
                .unwrap()
                .refusal(),
            Some("already_exists")
        );
        let subagents = svc.get_subagents("test-agent-id").await.unwrap();
        assert_eq!(subagents.len(), 1);
        assert_eq!(subagents[0].description, "does things");
        let json = serde_json::to_value(&subagents[0]).unwrap();
        assert_eq!(json["id"], "child");
        assert_eq!(json["description"], "does things");

        assert_eq!(
            svc.remove_subagent("test-agent-id", "child").await.unwrap(),
            RemoveSubagentResult::Deleted
        );
        assert_eq!(
            svc.remove_subagent("test-agent-id", "child").await.unwrap(),
            RemoveSubagentResult::LinkNotFound
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn delete_agent_checks_the_owner() {
        let _db = test_db();
        create("test-agent-id", None).await;
        let svc = &*AGENT_WORKSPACE_SERVICE;
        assert_eq!(
            svc.delete_agent(None).await.unwrap(),
            DeleteAgentResult::Forbidden
        );
        assert_eq!(
            svc.delete_agent(Some(DeleteAgentOptions {
                user_id: Some("test-owner-id".to_string()),
                allowed_by_team: None,
            }))
            .await
            .unwrap(),
            DeleteAgentResult::Deleted
        );
        assert_eq!(
            svc.get_agent().await.unwrap_err().to_string(),
            "Agent test-agent-id not found"
        );
    }
}
