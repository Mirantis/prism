//! Startup Telemetry
//!
//! Single owner of the `agent started` product event — one census per boot,
//! emitted from `index.rs` once the agent row is resolved and cron tasks are
//! registered. It answers fleet-level product questions the startup logs can't:
//! which LLM vendor/models deployments actually run, whether they route through
//! the gateway, which integrations are wired up, what host Prism Agent runs on,
//! and how much of the feature surface is configured.
//!
//! Only ids, flags, counts and model identifiers — never tokens, URLs, paths or
//! user content. `deployment.environment.name` / `service.version` are already
//! OTel *resource* attributes (see `telemetry.rs`), so they are not repeated as
//! properties; heartbeat interval/status are owned by `heartbeat started`.

use crate::db::models::AgentWorkspace;
use crate::lib::telemetry::is_telemetry_enabled;

/// What the census counts beyond the agent row.
#[derive(Debug, Clone, Copy, Default)]
pub struct TrackAgentStartedOptions {
    pub cron_tasks: usize,
}

/// Emits `agent started` for the agent (its `id`, `user_id`, `webhooks_enabled`
/// and `locked_in` are read).
///
/// Gathering the census costs a skills-dir scan and a DB round-trip, both
/// pointless when `track_event` would no-op anyway (no OTel endpoint) — as in
/// the local dev loop. Best-effort: a census failure never takes down the boot; it
/// logs `{ err }` `[Startup] agent-started telemetry failed` at warn, the only
/// diagnostic for a census that silently stops arriving.
///
/// Props, in order: `agent.id`; `llm.provider`; `llm.routing` (`nexus` when the
/// selected vendor's gateway chat mount is set, else `direct` — the deployment's
/// shape, not where a request lands); `llm.chat_model`;
/// `llm.classification_model`; `model_catalog.state` (read synchronously — the
/// boot-time refresh may not have settled, and `pending` is itself the signal);
/// `llm.embedding_provider`; `llm.embedding_model` only when the embedding model id
/// is non-empty; `llm.region` only for `bedrock` and `bedrock-mantle`;
/// `tool_risk_gate.mode`; `threads.mode`; `coding_agent`;
/// `execution_environment`; `slack.enabled`; `teams.enabled` (all three Teams
/// settings set); `nexus.enabled`; `nexus.mcp_enabled`; `langfuse.enabled` (both
/// keys set); `program_status.enabled`; `runtime.sea` (the packaged binary vs a
/// container/source run); `runtime.node_version`; `runtime.platform`;
/// `runtime.arch`; `webhook.receiver_enabled`; `agent.locked_in`; `cron.tasks`;
/// `skills.count` (the globally installed skills, which include any a plugin
/// contributes — there is no workspace root at boot); `plugins.count`;
/// `agent.subagents`. Booleans and counts are sent as text.
pub async fn track_agent_started(agent: &AgentWorkspace, opts: TrackAgentStartedOptions) {
    if !is_telemetry_enabled() {
        return;
    }
    todo!()
}
