//! Agent Bootstrap
//!
//! Resolves the one `AgentWorkspace` row the runtime runs against. If
//! it doesn't exist yet, creates it with sensible defaults
//! (`config.owner_user_id` / `agent_name` / `team_name`, and the documents
//! `PRISM_WORKSPACE_SEED_DIR` holds) so a fresh container — green-field, or
//! after a `/data` wipe — boots without external seeding.
//!
//! Resolution order:
//!   1. `AGENT_ID` set + row exists → use it.
//!   2. `AGENT_ID` set + row missing → bootstrap with that ID.
//!   3. `AGENT_ID` unset + DB has any row → use the first row (exactly
//!      one agent per container, so this is unambiguous).
//!   4. `AGENT_ID` unset + DB empty → bootstrap with a generated UUID.

use crate::db::models::AgentWorkspace;

/// Resolves the agent row, then pins the resolved id into the config's
/// `agent_id`, so downstream code that reads it directly (notably the WebSocket
/// gateway's access-control gate) sees a consistent value whether `AGENT_ID` came
/// from env or was synthesized here. The row names the owner, so the config's
/// `owner_user_id` becomes the row's `user_id`; `OWNER_USER_ID` seeds it on first
/// boot only.
pub async fn resolve_or_bootstrap_single_agent() -> anyhow::Result<AgentWorkspace> {
    todo!()
}

/// Steps 1–4 above. Logs `{ agentId }` `[SingleAgent] using existing agent
/// (AGENT_ID match)` or `[SingleAgent] using existing agent (DB findFirst — AGENT_ID
/// unset)` when a row is found.
async fn resolve() -> anyhow::Result<AgentWorkspace> {
    todo!()
}

/// Creates the agent row with `id`.
///
/// The name is stored the way a rename stores it (`normalise_agent_name`). A name
/// outside the rule is the operator's to keep, as it is, but one the agent could
/// not give itself: it warns `{ name }` `[SingleAgent] AGENT_NAME does not follow the
/// rule for names: <AGENT_NAME_RULE>` and keeps the configured name. The documents
/// come from `read_workspace_seed(config.workspace_seed_dir)`; the agent is created
/// through `AGENT_WORKSPACE_SERVICE.create_agent` with type `AGENT`. Only this boot
/// reads the seed, so the log names the fields it found: `{ agentId, name,
/// ownerUserId, seeded }` `[SingleAgent] bootstrapped new agent — set AGENT_ID to
/// this id to pin identity across restarts`.
async fn bootstrap(id: &str) -> anyhow::Result<AgentWorkspace> {
    todo!()
}
