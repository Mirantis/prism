//! Teams Mapping Service
//!
//! Manages `TeamsMapping` records for both user/DM mappings and channel/team
//! mappings — the Microsoft Teams mirror of `slack_mapping_service.rs`.
//!
//! Mapping Types:
//! - User Mapping (DM mode): `teams_user_id` + `lens_user_id` + `dm_conversation_id` set
//! - Channel Mapping (Team mode): `channel_conversation_id` + `channel_name` set
//!
//! Each row is EITHER a user mapping OR a channel mapping, enforced in code.
//! Channel conversation ids are stored WITHOUT any `;messageid=` thread suffix.

use std::sync::LazyLock;

use chrono::Utc;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db::models::{NewTeamsMapping, TeamsMapping};
use crate::db::schema::{agent_workspaces as aw, teams_mappings as tm};
use crate::db::sql_types::DbDateTime;

/// The agent a user mapping belongs to, as `find_user_mapping` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsMappingAgent {
    pub id: String,
    pub name: String,
}

/// A user mapping with its agent (Prisma's `include: { agentWorkspace: { select: { id, name } } }`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsUserMappingWithAgent {
    #[serde(flatten)]
    pub mapping: TeamsMapping,
    pub agent_workspace: TeamsMappingAgent,
}

/// The agent a channel mapping belongs to, as `find_by_conversation_id` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelMappingAgent {
    pub id: String,
    pub user_id: String,
    pub name: String,
}

/// A channel mapping with its agent (Prisma's
/// `include: { agentWorkspace: { select: { id, userId, name } } }`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelMappingWithAgent {
    #[serde(flatten)]
    pub mapping: TeamsMapping,
    pub agent_workspace: TeamsChannelMappingAgent,
}

/// The fields `update_channel_mapping` may change. `None` leaves the column as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsChannelMappingUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
}

/// The error Prisma's `update` and `delete` give when no row matches.
fn record_not_found(operation: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "An operation failed because it depends on one or more records that were required but not found. No record was found for {operation}."
    )
}

pub struct TeamsMappingService;

impl Default for TeamsMappingService {
    fn default() -> Self {
        Self::new()
    }
}

impl TeamsMappingService {
    pub fn new() -> Self {
        TeamsMappingService
    }

    // ========================================================================
    // User Mappings (DM Mode)
    // ========================================================================

    /// Find a user mapping by Teams user ID (includes agent info). The lookup key
    /// is the `(connectionId, teamsUserId)` unique pair.
    pub async fn find_user_mapping(
        &self,
        connection_id: &str,
        teams_user_id: &str,
    ) -> anyhow::Result<Option<TeamsUserMappingWithAgent>> {
        let connection_id = connection_id.to_string();
        let teams_user_id = teams_user_id.to_string();
        crate::db::run(move |conn| {
            let Some(mapping) = tm::table
                .filter(tm::connection_id.eq(&connection_id))
                .filter(tm::teams_user_id.eq(&teams_user_id))
                .select(TeamsMapping::as_select())
                .first(conn)
                .optional()?
            else {
                return Ok(None);
            };
            let (id, name) = aw::table
                .filter(aw::id.eq(&mapping.agent_id))
                .select((aw::id, aw::name))
                .first::<(String, String)>(conn)?;
            Ok(Some(TeamsUserMappingWithAgent {
                mapping,
                agent_workspace: TeamsMappingAgent { id, name },
            }))
        })
        .await
    }

    /// Create or update a user mapping (DM mode), keyed by `(connectionId, teamsUserId)`.
    ///
    /// On update, a `None` for `dm_conversation_id` or `tenant_id` leaves that
    /// column unchanged (Prisma skips an undefined field), and `updatedAt` is set
    /// to now. On create, the channel fields are null.
    pub async fn upsert_user_mapping(
        &self,
        connection_id: &str,
        teams_user_id: &str,
        lens_user_id: &str,
        agent_id: &str,
        dm_conversation_id: Option<&str>,
        tenant_id: Option<&str>,
    ) -> anyhow::Result<TeamsMapping> {
        let connection_id = connection_id.to_string();
        let teams_user_id = teams_user_id.to_string();
        let lens_user_id = lens_user_id.to_string();
        let agent_id = agent_id.to_string();
        let dm_conversation_id = dm_conversation_id.map(str::to_string);
        let tenant_id = tenant_id.map(str::to_string);
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let existing: Option<String> = tm::table
                    .filter(tm::connection_id.eq(&connection_id))
                    .filter(tm::teams_user_id.eq(&teams_user_id))
                    .select(tm::id)
                    .first(conn)
                    .optional()?;
                if let Some(id) = existing {
                    diesel::update(tm::table.filter(tm::id.eq(&id)))
                        .set((
                            tm::lens_user_id.eq(Some(&lens_user_id)),
                            tm::agent_id.eq(&agent_id),
                            tm::updated_at.eq(DbDateTime::from(Utc::now())),
                        ))
                        .execute(conn)?;
                    if let Some(dm) = &dm_conversation_id {
                        diesel::update(tm::table.filter(tm::id.eq(&id)))
                            .set(tm::dm_conversation_id.eq(Some(dm)))
                            .execute(conn)?;
                    }
                    if let Some(tenant) = &tenant_id {
                        diesel::update(tm::table.filter(tm::id.eq(&id)))
                            .set(tm::tenant_id.eq(Some(tenant)))
                            .execute(conn)?;
                    }
                    return Ok(tm::table
                        .filter(tm::id.eq(&id))
                        .select(TeamsMapping::as_select())
                        .first(conn)?);
                }
                let mut row = NewTeamsMapping::new(connection_id.clone(), agent_id.clone());
                row.teams_user_id = Some(teams_user_id.clone());
                row.lens_user_id = Some(lens_user_id.clone());
                row.dm_conversation_id = dm_conversation_id.clone();
                row.tenant_id = tenant_id.clone();
                // Ensure channel fields are null for user mappings
                row.channel_conversation_id = None;
                row.channel_name = None;
                Ok(diesel::insert_into(tm::table)
                    .values(&row)
                    .returning(TeamsMapping::as_returning())
                    .get_result(conn)?)
            })
        })
        .await
    }

    /// Update the personal-scope conversation ID for a user mapping — the target
    /// every proactive DM send is addressed to.
    pub async fn update_dm_conversation_id(
        &self,
        mapping_id: &str,
        dm_conversation_id: &str,
    ) -> anyhow::Result<()> {
        let mapping_id = mapping_id.to_string();
        let dm_conversation_id = dm_conversation_id.to_string();
        crate::db::run(move |conn| {
            let updated = diesel::update(tm::table.filter(tm::id.eq(&mapping_id)))
                .set((
                    tm::dm_conversation_id.eq(Some(&dm_conversation_id)),
                    tm::updated_at.eq(DbDateTime::from(Utc::now())),
                ))
                .execute(conn)?;
            if updated == 0 {
                return Err(record_not_found("an update"));
            }
            Ok(())
        })
        .await
    }

    /// Delete a user mapping by Lens user ID and connection (rows with a
    /// `teamsUserId` only).
    pub async fn delete_user_mapping(
        &self,
        connection_id: &str,
        lens_user_id: &str,
    ) -> anyhow::Result<()> {
        let connection_id = connection_id.to_string();
        let lens_user_id = lens_user_id.to_string();
        crate::db::run(move |conn| {
            diesel::delete(
                tm::table
                    .filter(tm::connection_id.eq(&connection_id))
                    .filter(tm::lens_user_id.eq(&lens_user_id))
                    // User mappings only
                    .filter(tm::teams_user_id.is_not_null()),
            )
            .execute(conn)?;
            Ok(())
        })
        .await
    }

    // ========================================================================
    // Channel Mappings (Team Mode)
    // ========================================================================

    /// Find a channel mapping by its (suffix-free) channel conversation ID.
    pub async fn find_by_conversation_id(
        &self,
        channel_conversation_id: &str,
    ) -> anyhow::Result<Option<TeamsChannelMappingWithAgent>> {
        let channel_conversation_id = channel_conversation_id.to_string();
        crate::db::run(move |conn| {
            let Some(mapping) = tm::table
                .filter(tm::channel_conversation_id.eq(&channel_conversation_id))
                .select(TeamsMapping::as_select())
                .first(conn)
                .optional()?
            else {
                return Ok(None);
            };
            let (id, user_id, name) = aw::table
                .filter(aw::id.eq(&mapping.agent_id))
                .select((aw::id, aw::user_id, aw::name))
                .first::<(String, String, String)>(conn)?;
            Ok(Some(TeamsChannelMappingWithAgent {
                mapping,
                agent_workspace: TeamsChannelMappingAgent { id, user_id, name },
            }))
        })
        .await
    }

    /// Create a channel mapping (Team mode). For channel mappings `lensUserId`
    /// stores the agent owner; an empty or missing one is stored as null. The
    /// user-only fields are null.
    pub async fn create_channel_mapping(
        &self,
        connection_id: &str,
        channel_conversation_id: &str,
        agent_id: &str,
        channel_name: Option<&str>,
        lens_user_id: Option<&str>,
        tenant_id: Option<&str>,
    ) -> anyhow::Result<TeamsMapping> {
        let mut row = NewTeamsMapping::new(connection_id, agent_id);
        row.channel_conversation_id = Some(channel_conversation_id.to_string());
        row.channel_name = channel_name.map(str::to_string);
        row.tenant_id = tenant_id.map(str::to_string);
        // For channel mappings, lensUserId stores the agent owner
        row.lens_user_id = lens_user_id.filter(|id| !id.is_empty()).map(str::to_string);
        // Ensure user-only fields are null for channel mappings
        row.teams_user_id = None;
        row.dm_conversation_id = None;
        crate::db::run(move |conn| {
            Ok(diesel::insert_into(tm::table)
                .values(&row)
                .returning(TeamsMapping::as_returning())
                .get_result(conn)?)
        })
        .await
    }

    /// Update a channel mapping. Throws (Prisma's `update`) when no row has the id.
    pub async fn update_channel_mapping(
        &self,
        channel_conversation_id: &str,
        data: TeamsChannelMappingUpdate,
    ) -> anyhow::Result<()> {
        let channel_conversation_id = channel_conversation_id.to_string();
        crate::db::run(move |conn| {
            let target = tm::table.filter(tm::channel_conversation_id.eq(&channel_conversation_id));
            let updated = match data.channel_name {
                Some(name) => diesel::update(target)
                    .set((
                        tm::channel_name.eq(Some(name)),
                        tm::updated_at.eq(DbDateTime::from(Utc::now())),
                    ))
                    .execute(conn)?,
                None => diesel::update(target)
                    .set(tm::updated_at.eq(DbDateTime::from(Utc::now())))
                    .execute(conn)?,
            };
            if updated == 0 {
                return Err(record_not_found("an update"));
            }
            Ok(())
        })
        .await
    }

    /// Delete a channel mapping. Throws (Prisma's `delete`) when no row has the id.
    pub async fn delete_channel_mapping(
        &self,
        channel_conversation_id: &str,
    ) -> anyhow::Result<()> {
        let channel_conversation_id = channel_conversation_id.to_string();
        crate::db::run(move |conn| {
            let deleted = diesel::delete(
                tm::table.filter(tm::channel_conversation_id.eq(&channel_conversation_id)),
            )
            .execute(conn)?;
            if deleted == 0 {
                return Err(record_not_found("a delete"));
            }
            Ok(())
        })
        .await
    }

    /// Get all channel mappings for a connection.
    pub async fn get_channel_mappings_by_connection_id(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Vec<TeamsMapping>> {
        let connection_id = connection_id.to_string();
        crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::connection_id.eq(&connection_id))
                // Channel mappings only
                .filter(tm::channel_conversation_id.is_not_null())
                .select(TeamsMapping::as_select())
                .load(conn)?)
        })
        .await
    }

    /// Flag a linked channel as the agent's main channel, clearing the flag on the
    /// agent's other channels so at most one is ever main. Runs in a transaction so
    /// the clear + set are atomic.
    ///
    /// The set is scoped to BOTH agentId + conversationId (not conversationId
    /// alone) so a mismatched call can never flag a channel that belongs to
    /// another agent; fails with
    /// `No channel mapping {channel_conversation_id} found for agent {agent_id}`
    /// if no such channel exists for the agent.
    ///
    /// That error is the ordinary cause — a mismatched agent or a typo'd id, where
    /// nothing was cleared that mattered. A delete that races the route's
    /// pre-check also lands there, having cleared the flag first; the caller sees
    /// an error and the main-channel resolver falls back to the oldest channel,
    /// so no alert is lost.
    pub async fn set_main_channel(
        &self,
        agent_id: &str,
        channel_conversation_id: &str,
    ) -> anyhow::Result<()> {
        let agent_id = agent_id.to_string();
        let channel_conversation_id = channel_conversation_id.to_string();
        let set = {
            let agent_id = agent_id.clone();
            let channel_conversation_id = channel_conversation_id.clone();
            crate::db::run(move |conn| {
                conn.transaction(|conn| {
                    diesel::update(
                        tm::table
                            .filter(tm::agent_id.eq(&agent_id))
                            .filter(tm::channel_conversation_id.is_not_null())
                            .filter(tm::is_main_channel.eq(true)),
                    )
                    .set((
                        tm::is_main_channel.eq(false),
                        tm::updated_at.eq(DbDateTime::from(Utc::now())),
                    ))
                    .execute(conn)?;
                    let set = diesel::update(
                        tm::table
                            .filter(tm::agent_id.eq(&agent_id))
                            .filter(tm::channel_conversation_id.eq(&channel_conversation_id)),
                    )
                    .set((
                        tm::is_main_channel.eq(true),
                        tm::updated_at.eq(DbDateTime::from(Utc::now())),
                    ))
                    .execute(conn)?;
                    Ok::<usize, anyhow::Error>(set)
                })
            })
            .await?
        };
        if set == 0 {
            anyhow::bail!(
                "No channel mapping {channel_conversation_id} found for agent {agent_id}"
            );
        }
        Ok(())
    }

    /// Resolve the agent's main channel conversation id: the flagged channel, else
    /// the oldest linked channel (same "flagged, else oldest" rule the adapter
    /// uses to route autonomous output). Returns `None` when the agent has no
    /// linked channels.
    pub async fn get_main_channel(&self, agent_id: &str) -> anyhow::Result<Option<String>> {
        let agent_id = agent_id.to_string();
        let channels: Vec<TeamsMapping> = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::agent_id.eq(&agent_id))
                .filter(tm::channel_conversation_id.is_not_null())
                .order(tm::created_at.asc())
                .select(TeamsMapping::as_select())
                .load(conn)?)
        })
        .await?;
        let main = channels
            .iter()
            .find(|m| m.is_main_channel)
            .or_else(|| channels.first());
        Ok(main.and_then(|m| m.channel_conversation_id.clone()))
    }

    // ========================================================================
    // General Queries
    // ========================================================================

    /// Check if a channel is already linked to an agent.
    pub async fn is_channel_linked(&self, channel_conversation_id: &str) -> anyhow::Result<bool> {
        let channel_conversation_id = channel_conversation_id.to_string();
        let count: i64 = crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::channel_conversation_id.eq(&channel_conversation_id))
                .count()
                .get_result(conn)?)
        })
        .await?;
        Ok(count > 0)
    }

    /// Count user mappings for a Lens user (DM only: rows with a `dmConversationId`).
    pub async fn count_user_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        let lens_user_id = lens_user_id.to_string();
        crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::lens_user_id.eq(&lens_user_id))
                .filter(tm::dm_conversation_id.is_not_null())
                .count()
                .get_result(conn)?)
        })
        .await
    }

    /// Count all mappings for a Lens user (DM + channel).
    pub async fn count_all_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        let lens_user_id = lens_user_id.to_string();
        crate::db::run(move |conn| {
            Ok(tm::table
                .filter(tm::lens_user_id.eq(&lens_user_id))
                .filter(
                    tm::dm_conversation_id
                        .is_not_null()
                        .or(tm::channel_conversation_id.is_not_null()),
                )
                .count()
                .get_result(conn)?)
        })
        .await
    }
}

pub static TEAMS_MAPPING_SERVICE: LazyLock<TeamsMappingService> =
    LazyLock::new(TeamsMappingService::new);

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::models::NewAgentWorkspace;
    use crate::db::testing::test_db;
    use chrono::Duration;

    /// Inserts an agent, which every mapping references, and returns its id.
    pub(crate) async fn insert_agent(name: &str) -> String {
        let mut agent = NewAgentWorkspace::new("owner-1", "", "", "", "", "");
        agent.name = name.to_string();
        let id = agent.id.clone();
        crate::db::run(move |conn| {
            diesel::insert_into(aw::table)
                .values(&agent)
                .execute(conn)?;
            Ok(())
        })
        .await
        .expect("insert agent");
        id
    }

    /// Inserts a channel mapping created `age_secs` seconds ago.
    pub(crate) async fn insert_channel(
        agent_id: &str,
        conversation_id: &str,
        name: Option<&str>,
        lens_user_id: Option<&str>,
        is_main: bool,
        age_secs: i64,
    ) {
        let mut row = NewTeamsMapping::new("tenant-1", agent_id);
        row.channel_conversation_id = Some(conversation_id.to_string());
        row.channel_name = name.map(str::to_string);
        row.lens_user_id = lens_user_id.map(str::to_string);
        row.is_main_channel = is_main;
        row.created_at = (Utc::now() - Duration::seconds(age_secs)).into();
        crate::db::run(move |conn| {
            diesel::insert_into(tm::table).values(&row).execute(conn)?;
            Ok(())
        })
        .await
        .expect("insert channel mapping");
    }

    /// Inserts a DM mapping created `age_secs` seconds ago.
    pub(crate) async fn insert_dm(
        agent_id: &str,
        teams_user_id: &str,
        lens_user_id: &str,
        dm_conversation_id: &str,
        age_secs: i64,
    ) {
        let mut row = NewTeamsMapping::new("tenant-1", agent_id);
        row.teams_user_id = Some(teams_user_id.to_string());
        row.lens_user_id = Some(lens_user_id.to_string());
        row.dm_conversation_id = Some(dm_conversation_id.to_string());
        row.created_at = (Utc::now() - Duration::seconds(age_secs)).into();
        crate::db::run(move |conn| {
            diesel::insert_into(tm::table).values(&row).execute(conn)?;
            Ok(())
        })
        .await
        .expect("insert dm mapping");
    }

    async fn all_mappings() -> Vec<TeamsMapping> {
        crate::db::run(|conn| {
            Ok(tm::table
                .order(tm::created_at.asc())
                .select(TeamsMapping::as_select())
                .load(conn)?)
        })
        .await
        .expect("load mappings")
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_a_user_mapping_by_connection_and_teams_user_with_its_agent() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_dm(&agent, "aad-user-1", "lens-1", "a:dm", 0).await;

        let found = TEAMS_MAPPING_SERVICE
            .find_user_mapping("tenant-1", "aad-user-1")
            .await
            .unwrap()
            .expect("mapping");

        assert_eq!(found.mapping.lens_user_id.as_deref(), Some("lens-1"));
        assert_eq!(
            found.agent_workspace,
            TeamsMappingAgent {
                id: agent.clone(),
                name: "Atlas".to_string()
            }
        );
        assert!(
            TEAMS_MAPPING_SERVICE
                .find_user_mapping("tenant-2", "aad-user-1")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn upsert_creates_a_user_mapping_with_null_channel_fields_and_keeps_unset_fields_on_update()
     {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;

        let created = TEAMS_MAPPING_SERVICE
            .upsert_user_mapping(
                "tenant-1",
                "aad-user-1",
                "lens-1",
                &agent,
                Some("19:dm-conversation"),
                Some("tenant-1"),
            )
            .await
            .unwrap();
        assert_eq!(created.teams_user_id.as_deref(), Some("aad-user-1"));
        assert_eq!(
            created.dm_conversation_id.as_deref(),
            Some("19:dm-conversation")
        );
        assert_eq!(created.channel_conversation_id, None);
        assert_eq!(created.channel_name, None);

        let updated = TEAMS_MAPPING_SERVICE
            .upsert_user_mapping("tenant-1", "aad-user-1", "lens-2", &agent, None, None)
            .await
            .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.lens_user_id.as_deref(), Some("lens-2"));
        assert_eq!(
            updated.dm_conversation_id.as_deref(),
            Some("19:dm-conversation")
        );
        assert_eq!(updated.tenant_id.as_deref(), Some("tenant-1"));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn writes_the_new_proactive_send_target_of_a_user_mapping() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_dm(&agent, "aad-user-1", "lens-1", "a:old", 0).await;
        let id = all_mappings().await[0].id.clone();

        TEAMS_MAPPING_SERVICE
            .update_dm_conversation_id(&id, "19:new-conversation")
            .await
            .unwrap();

        assert_eq!(
            all_mappings().await[0].dm_conversation_id.as_deref(),
            Some("19:new-conversation")
        );
        assert!(
            TEAMS_MAPPING_SERVICE
                .update_dm_conversation_id("missing", "x")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn deletes_user_rows_only() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_dm(&agent, "aad-user-1", "lens-1", "a:dm", 0).await;
        insert_channel(
            &agent,
            "19:abc@thread.tacv2",
            None,
            Some("lens-1"),
            false,
            0,
        )
        .await;

        TEAMS_MAPPING_SERVICE
            .delete_user_mapping("tenant-1", "lens-1")
            .await
            .unwrap();

        let left = all_mappings().await;
        assert_eq!(left.len(), 1);
        assert_eq!(
            left[0].channel_conversation_id.as_deref(),
            Some("19:abc@thread.tacv2")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_a_channel_mapping_by_its_conversation_id_with_its_agent() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_channel(
            &agent,
            "19:abc@thread.tacv2",
            Some("General"),
            Some("lens-1"),
            false,
            0,
        )
        .await;

        let found = TEAMS_MAPPING_SERVICE
            .find_by_conversation_id("19:abc@thread.tacv2")
            .await
            .unwrap()
            .expect("mapping");

        assert_eq!(found.mapping.channel_name.as_deref(), Some("General"));
        assert_eq!(
            found.agent_workspace,
            TeamsChannelMappingAgent {
                id: agent,
                user_id: "owner-1".to_string(),
                name: "Atlas".to_string()
            }
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn creates_a_channel_mapping_with_null_user_fields() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;

        let created = TEAMS_MAPPING_SERVICE
            .create_channel_mapping(
                "tenant-1",
                "19:abc@thread.tacv2",
                &agent,
                Some("General"),
                Some("lens-1"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            created.channel_conversation_id.as_deref(),
            Some("19:abc@thread.tacv2")
        );
        assert_eq!(created.channel_name.as_deref(), Some("General"));
        assert_eq!(created.teams_user_id, None);
        assert_eq!(created.dm_conversation_id, None);
        assert_eq!(created.lens_user_id.as_deref(), Some("lens-1"));

        let unowned = TEAMS_MAPPING_SERVICE
            .create_channel_mapping(
                "tenant-1",
                "19:def@thread.tacv2",
                &agent,
                None,
                Some(""),
                None,
            )
            .await
            .unwrap();
        assert_eq!(unowned.lens_user_id, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn renames_and_deletes_a_channel_mapping_by_its_conversation_id() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_channel(
            &agent,
            "19:abc@thread.tacv2",
            Some("General"),
            None,
            false,
            0,
        )
        .await;

        TEAMS_MAPPING_SERVICE
            .update_channel_mapping(
                "19:abc@thread.tacv2",
                TeamsChannelMappingUpdate {
                    channel_name: Some("Ops".to_string()),
                },
            )
            .await
            .unwrap();
        assert_eq!(all_mappings().await[0].channel_name.as_deref(), Some("Ops"));

        TEAMS_MAPPING_SERVICE
            .delete_channel_mapping("19:abc@thread.tacv2")
            .await
            .unwrap();
        assert!(all_mappings().await.is_empty());
        assert!(
            TEAMS_MAPPING_SERVICE
                .delete_channel_mapping("19:abc@thread.tacv2")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn sets_one_main_channel_and_clears_the_old_flag() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_channel(&agent, "19:old@thread.tacv2", None, None, true, 20).await;
        insert_channel(&agent, "19:abc@thread.tacv2", None, None, false, 10).await;

        TEAMS_MAPPING_SERVICE
            .set_main_channel(&agent, "19:abc@thread.tacv2")
            .await
            .unwrap();

        let flags: Vec<(Option<String>, bool)> = all_mappings()
            .await
            .into_iter()
            .map(|m| (m.channel_conversation_id, m.is_main_channel))
            .collect();
        assert_eq!(
            flags,
            vec![
                (Some("19:old@thread.tacv2".to_string()), false),
                (Some("19:abc@thread.tacv2".to_string()), true),
            ]
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_to_flag_a_channel_that_does_not_belong_to_the_agent() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        let other = insert_agent("Other").await;
        insert_channel(&other, "19:other@thread.tacv2", None, None, false, 0).await;

        let err = TEAMS_MAPPING_SERVICE
            .set_main_channel(&agent, "19:other@thread.tacv2")
            .await
            .unwrap_err();

        assert!(err.to_string().contains("No channel mapping"));
        assert!(!all_mappings().await[0].is_main_channel);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn resolves_the_main_channel_flagged_else_oldest_else_none() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        assert_eq!(
            TEAMS_MAPPING_SERVICE
                .get_main_channel(&agent)
                .await
                .unwrap(),
            None
        );

        insert_channel(&agent, "19:oldest@thread.tacv2", None, None, false, 20).await;
        insert_channel(&agent, "19:newer@thread.tacv2", None, None, false, 10).await;
        assert_eq!(
            TEAMS_MAPPING_SERVICE
                .get_main_channel(&agent)
                .await
                .unwrap()
                .as_deref(),
            Some("19:oldest@thread.tacv2")
        );

        insert_channel(&agent, "19:flagged@thread.tacv2", None, None, true, 0).await;
        assert_eq!(
            TEAMS_MAPPING_SERVICE
                .get_main_channel(&agent)
                .await
                .unwrap()
                .as_deref(),
            Some("19:flagged@thread.tacv2")
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn counts_linked_channels_and_a_users_dm_and_channel_rows() {
        let _db = test_db();
        let agent = insert_agent("Atlas").await;
        insert_dm(&agent, "aad-user-1", "lens-1", "a:dm-1", 0).await;
        insert_dm(&agent, "aad-user-2", "lens-1", "a:dm-2", 0).await;
        insert_channel(
            &agent,
            "19:abc@thread.tacv2",
            None,
            Some("lens-1"),
            false,
            0,
        )
        .await;

        assert!(
            TEAMS_MAPPING_SERVICE
                .is_channel_linked("19:abc@thread.tacv2")
                .await
                .unwrap()
        );
        assert!(
            !TEAMS_MAPPING_SERVICE
                .is_channel_linked("19:none@thread.tacv2")
                .await
                .unwrap()
        );
        assert_eq!(
            TEAMS_MAPPING_SERVICE
                .count_user_mappings("lens-1")
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            TEAMS_MAPPING_SERVICE
                .count_all_mappings("lens-1")
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            TEAMS_MAPPING_SERVICE
                .count_all_mappings("lens-2")
                .await
                .unwrap(),
            0
        );
    }
}
