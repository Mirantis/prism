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

use diesel::prelude::*;
use serde_json::json;
use uuid::Uuid;

use crate::config::CONFIG;
use crate::db::models::{AgentType, AgentWorkspace};
use crate::db::schema::agent_workspaces::dsl as w;
use crate::lib::agent_name::{AGENT_NAME_RULE, normalise_agent_name};
use crate::lib::workspace_seed::read_workspace_seed;
use crate::services::agent_workspace_service::{AGENT_WORKSPACE_SERVICE, CreateAgentInput};
use crate::{log_info, log_warn};

/// Resolves the agent row, then pins the resolved id into the config's
/// `agent_id`, so downstream code that reads it directly (notably the WebSocket
/// gateway's access-control gate) sees a consistent value whether `AGENT_ID` came
/// from env or was synthesized here. The row names the owner, so the config's
/// `owner_user_id` becomes the row's `user_id`; `OWNER_USER_ID` seeds it on first
/// boot only.
pub async fn resolve_or_bootstrap_single_agent() -> anyhow::Result<AgentWorkspace> {
    let agent = resolve().await?;
    CONFIG.set_agent_id(Some(agent.id.clone()));
    CONFIG.set_owner_user_id(agent.user_id.clone());
    Ok(agent)
}

/// Steps 1–4 above. Logs `{ agentId }` `[SingleAgent] using existing agent
/// (AGENT_ID match)` or `[SingleAgent] using existing agent (DB findFirst — AGENT_ID
/// unset)` when a row is found.
async fn resolve() -> anyhow::Result<AgentWorkspace> {
    if let Some(agent_id) = CONFIG.agent_id().filter(|id| !id.is_empty()) {
        let existing = {
            let agent_id = agent_id.clone();
            crate::db::run(move |conn| {
                Ok(w::agent_workspaces
                    .filter(w::id.eq(&agent_id))
                    .select(AgentWorkspace::as_select())
                    .first(conn)
                    .optional()?)
            })
            .await?
        };
        if let Some(existing) = existing {
            log_info!(
                json!({ "agentId": existing.id }),
                "[SingleAgent] using existing agent (AGENT_ID match)"
            );
            return Ok(existing);
        }
        return bootstrap(&agent_id).await;
    }

    let any_existing = crate::db::run(|conn| {
        Ok(w::agent_workspaces
            .select(AgentWorkspace::as_select())
            .first(conn)
            .optional()?)
    })
    .await?;
    if let Some(existing) = any_existing {
        log_info!(
            json!({ "agentId": existing.id }),
            "[SingleAgent] using existing agent (DB findFirst — AGENT_ID unset)"
        );
        return Ok(existing);
    }

    bootstrap(&Uuid::new_v4().to_string()).await
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
    // Stored the way a rename stores it. A name outside the rule is the
    // operator's to keep, as it is, but one the agent could not give itself.
    let name = normalise_agent_name(&CONFIG.agent_name);
    if name.is_none() {
        log_warn!(
            json!({ "name": CONFIG.agent_name }),
            "[SingleAgent] AGENT_NAME does not follow the rule for names: {}",
            AGENT_NAME_RULE
        );
    }
    let documents = read_workspace_seed(CONFIG.workspace_seed_dir.as_deref());
    let seeded: Vec<&str> = documents.fields().into_iter().map(|f| f.as_str()).collect();
    let agent = AGENT_WORKSPACE_SERVICE
        .create_agent(CreateAgentInput {
            id: id.to_string(),
            user_id: CONFIG.owner_user_id(),
            name: name.unwrap_or_else(|| CONFIG.agent_name.clone()),
            agent_type: AgentType::Agent,
            team_name: CONFIG.team_name.clone(),
            documents: Some(documents.clone()),
        })
        .await?;
    // Only this boot reads the seed, so the log names the fields it found.
    log_info!(
        json!({ "agentId": agent.id, "name": agent.name, "ownerUserId": agent.user_id, "seeded": seeded }),
        "[SingleAgent] bootstrapped new agent — set AGENT_ID to this id to pin identity across restarts"
    );
    Ok(agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;
    use crate::db::testing::test_db;

    /// Sets `config.agent_id` and the owner for one test, and puts them back.
    struct ConfigGuard {
        agent_id: Option<String>,
        owner: String,
    }

    impl ConfigGuard {
        fn new(agent_id: Option<&str>) -> ConfigGuard {
            let guard = ConfigGuard {
                agent_id: CONFIG.agent_id(),
                owner: CONFIG.owner_user_id(),
            };
            CONFIG.set_agent_id(agent_id.map(str::to_string));
            guard
        }
    }

    impl Drop for ConfigGuard {
        fn drop(&mut self) {
            CONFIG.set_agent_id(self.agent_id.take());
            CONFIG.set_owner_user_id(std::mem::take(&mut self.owner));
        }
    }

    fn insert(id: &str, user_id: &str) {
        let mut row = NewAgentWorkspace::new(user_id, "", "", "", "", "");
        row.id = id.to_string();
        crate::db::run_sync(move |conn| {
            diesel::insert_into(w::agent_workspaces)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn uses_the_existing_row_when_agent_id_matches_and_pins_its_owner() {
        let _db = test_db();
        let _config = ConfigGuard::new(Some("fixed-id"));
        insert("fixed-id", "agent-record-user");

        let agent = resolve_or_bootstrap_single_agent().await.unwrap();

        assert_eq!(agent.id, "fixed-id");
        assert_eq!(CONFIG.owner_user_id(), "agent-record-user");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn bootstraps_with_the_supplied_agent_id_when_the_row_is_missing() {
        let _db = test_db();
        let _config = ConfigGuard::new(Some("fixed-id"));

        let agent = resolve_or_bootstrap_single_agent().await.unwrap();

        assert_eq!(agent.id, "fixed-id");
        assert_eq!(agent.name, "Prism");
        assert_eq!(agent.user_id, CONFIG.owner_user_id());
        assert_eq!(agent.agent_type, AgentType::Agent);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn uses_the_first_row_when_agent_id_is_unset() {
        let _db = test_db();
        let _config = ConfigGuard::new(None);
        insert("discovered-id", "owner");

        let agent = resolve_or_bootstrap_single_agent().await.unwrap();

        assert_eq!(agent.id, "discovered-id");
        assert_eq!(CONFIG.agent_id().as_deref(), Some("discovered-id"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn bootstraps_with_a_generated_uuid_when_agent_id_is_unset_and_the_db_is_empty() {
        let _db = test_db();
        let _config = ConfigGuard::new(None);

        let agent = resolve_or_bootstrap_single_agent().await.unwrap();

        assert!(Uuid::parse_str(&agent.id).is_ok());
        assert_eq!(CONFIG.agent_id(), Some(agent.id.clone()));
    }
}
