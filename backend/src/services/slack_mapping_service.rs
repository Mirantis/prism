//! Slack Mapping Service
//!
//! Manages SlackMapping records for both user/DM mappings and channel/team mappings.
//!
//! Mapping Types:
//! - User Mapping (DM mode): slackUserId + lensUserId + dmChannelId set
//! - Channel Mapping (Team mode): slackChannelId + slackChannelName set
//!
//! Each row is EITHER a user mapping OR a channel mapping, enforced in code.

use std::sync::LazyLock;

use diesel::SqliteConnection;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::db::models::{NewSlackMapping, SlackMapping, SlackMappingChangeset};
use crate::db::schema::agent_workspaces::dsl as aw;
use crate::db::schema::slack_mappings::dsl as m;
use crate::db::sql_types::DbDateTime;
use crate::lib::slack_source::get_slack_connection;

// ============================================================================
// Types
// ============================================================================

/// The agent a channel mapping belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingAgent {
    pub id: String,
    pub user_id: String,
    pub name: String,
}

/// The connection a channel mapping belongs to, with its agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingConnection {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub is_active: bool,
    pub agent: MappingAgent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMappingWithConnection {
    #[serde(flatten)]
    pub mapping: SlackMapping,
    pub connection: MappingConnection,
}

/// The agent a user mapping names: id and display name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingAgentRef {
    pub id: String,
    pub name: String,
}

/// A user mapping with its agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackUserMappingWithAgent {
    #[serde(flatten)]
    pub mapping: SlackMapping,
    pub agent_workspace: MappingAgentRef,
}

/// The workspace a user mapping's connection belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingTeam {
    pub team_id: String,
    pub team_name: String,
    pub is_active: bool,
}

/// A user mapping with its connection's workspace.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackUserMappingWithTeam {
    #[serde(flatten)]
    pub mapping: SlackMapping,
    pub connection: MappingTeam,
}

/// The connection state a DM mapping is cached with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingTeamState {
    pub team_id: String,
    pub is_active: bool,
}

/// A user mapping with a DM channel, and its connection's state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackDmMappingWithConnection {
    #[serde(flatten)]
    pub mapping: SlackMapping,
    pub connection: MappingTeamState,
}

/// The fields `update_channel_mapping` may change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMappingUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack_channel_name: Option<String>,
}

/// The error Prisma's `update` gives when no row matches.
fn no_record_for_update() -> anyhow::Error {
    anyhow::anyhow!(
        "An operation failed because it depends on one or more records that were required but not found. No record was found for an update."
    )
}

/// The error Prisma's `delete` gives when no row matches.
fn no_record_for_delete() -> anyhow::Error {
    anyhow::anyhow!(
        "An operation failed because it depends on one or more records that were required but not found. No record was found for a delete."
    )
}

// ============================================================================
// Slack Mapping Service
// ============================================================================

pub struct SlackMappingService;

impl SlackMappingService {
    pub fn new() -> Self {
        SlackMappingService
    }

    // ============================================================================
    // User Mappings (DM Mode)
    // ============================================================================

    /// Find a user mapping by Slack user ID (includes agent info)
    pub async fn find_user_mapping(
        &self,
        connection_id: &str,
        slack_user_id: &str,
    ) -> anyhow::Result<Option<SlackUserMappingWithAgent>> {
        let connection_id = connection_id.to_string();
        let slack_user_id = slack_user_id.to_string();
        crate::db::read(move |conn| {
            let row: Option<(SlackMapping, (String, String))> = m::slack_mappings
                .inner_join(aw::agent_workspaces)
                .filter(m::connection_id.eq(&connection_id))
                .filter(m::slack_user_id.eq(&slack_user_id))
                .select((SlackMapping::as_select(), (aw::id, aw::name)))
                .first(conn)
                .optional()?;
            Ok(row.map(|(mapping, (id, name))| SlackUserMappingWithAgent {
                mapping,
                agent_workspace: MappingAgentRef { id, name },
            }))
        })
        .await
    }

    /// Create or update a user mapping (DM mode). A created row has its channel
    /// fields null.
    pub async fn upsert_user_mapping(
        &self,
        connection_id: &str,
        slack_user_id: &str,
        lens_user_id: &str,
        agent_id: &str,
        dm_channel_id: Option<&str>,
    ) -> anyhow::Result<SlackMapping> {
        let connection_id = connection_id.to_string();
        let slack_user_id = slack_user_id.to_string();
        let lens_user_id = lens_user_id.to_string();
        let agent_id = agent_id.to_string();
        let dm_channel_id = dm_channel_id.map(str::to_string);
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let existing: Option<String> = m::slack_mappings
                    .filter(m::connection_id.eq(&connection_id))
                    .filter(m::slack_user_id.eq(&slack_user_id))
                    .select(m::id)
                    .first(conn)
                    .optional()?;
                let id = match existing {
                    Some(id) => {
                        diesel::update(m::slack_mappings.filter(m::id.eq(&id)))
                            .set(SlackMappingChangeset {
                                lens_user_id: Some(Some(lens_user_id)),
                                agent_id: Some(agent_id),
                                dm_channel_id: dm_channel_id.map(Some),
                                ..Default::default()
                            })
                            .execute(conn)?;
                        id
                    }
                    None => {
                        let mut row = NewSlackMapping::new(connection_id, agent_id);
                        row.slack_user_id = Some(slack_user_id);
                        row.lens_user_id = Some(lens_user_id);
                        row.dm_channel_id = dm_channel_id;
                        // Ensure channel fields are null for user mappings
                        row.slack_channel_id = None;
                        row.slack_channel_name = None;
                        let id = row.id.clone();
                        diesel::insert_into(m::slack_mappings)
                            .values(&row)
                            .execute(conn)?;
                        id
                    }
                };
                Ok(m::slack_mappings
                    .filter(m::id.eq(&id))
                    .select(SlackMapping::as_select())
                    .first(conn)?)
            })
        })
        .await
    }

    /// Update DM channel ID for a user mapping
    pub async fn update_dm_channel_id(
        &self,
        mapping_id: &str,
        dm_channel_id: &str,
    ) -> anyhow::Result<()> {
        let mapping_id = mapping_id.to_string();
        let dm_channel_id = dm_channel_id.to_string();
        crate::db::run(move |conn| {
            let updated = diesel::update(m::slack_mappings.filter(m::id.eq(&mapping_id)))
                .set(SlackMappingChangeset {
                    dm_channel_id: Some(Some(dm_channel_id)),
                    ..Default::default()
                })
                .execute(conn)?;
            if updated == 0 {
                return Err(no_record_for_update());
            }
            Ok(())
        })
        .await
    }

    /// Delete a user mapping by Lens user ID and connection
    pub async fn delete_user_mapping(
        &self,
        connection_id: &str,
        lens_user_id: &str,
    ) -> anyhow::Result<()> {
        let connection_id = connection_id.to_string();
        let lens_user_id = lens_user_id.to_string();
        crate::db::run(move |conn| {
            diesel::delete(
                m::slack_mappings
                    .filter(m::connection_id.eq(&connection_id))
                    .filter(m::lens_user_id.eq(&lens_user_id))
                    .filter(m::slack_user_id.is_not_null()), // User mappings only
            )
            .execute(conn)?;
            Ok(())
        })
        .await
    }

    // ============================================================================
    // Channel Mappings (Team Mode)
    // ============================================================================

    /// Find a channel mapping by Slack channel ID, with the connection and the
    /// agent. `None` when the channel is not linked, no Slack connection is
    /// configured, or the agent row is gone.
    pub async fn find_by_channel_id(
        &self,
        channel_id: &str,
    ) -> anyhow::Result<Option<SlackMappingWithConnection>> {
        let channel = channel_id.to_string();
        let mapping: Option<SlackMapping> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::slack_channel_id.eq(&channel))
                .select(SlackMapping::as_select())
                .first(conn)
                .optional()?)
        })
        .await?;
        let Some(mapping) = mapping else {
            return Ok(None);
        };

        // The connection is env-sourced.
        let Some(conn) = get_slack_connection().await? else {
            return Ok(None);
        };

        // Fetch agent data from local database
        let agent_id = mapping.agent_id.clone();
        let agent: Option<(String, String, String)> = crate::db::read(move |db| {
            Ok(aw::agent_workspaces
                .filter(aw::id.eq(&agent_id))
                .select((aw::id, aw::user_id, aw::name))
                .first(db)
                .optional()?)
        })
        .await?;
        let Some((id, user_id, name)) = agent else {
            return Ok(None);
        };

        Ok(Some(SlackMappingWithConnection {
            mapping,
            connection: MappingConnection {
                id: conn.id,
                team_id: conn.team_id,
                team_name: conn.team_name,
                is_active: conn.is_active,
                agent: MappingAgent { id, user_id, name },
            },
        }))
    }

    /// Create a channel mapping (Team mode). For channel mappings, `lensUserId`
    /// stores the agent owner (an empty value stores null), and the user-only
    /// fields are null.
    pub async fn create_channel_mapping(
        &self,
        connection_id: &str,
        channel_id: &str,
        agent_id: &str,
        channel_name: Option<&str>,
        lens_user_id: Option<&str>,
    ) -> anyhow::Result<SlackMapping> {
        let mut row = NewSlackMapping::new(connection_id, agent_id);
        row.slack_channel_id = Some(channel_id.to_string());
        row.slack_channel_name = channel_name.map(str::to_string);
        // For channel mappings, lensUserId stores the agent owner
        row.lens_user_id = lens_user_id.filter(|id| !id.is_empty()).map(str::to_string);
        // Ensure user-only fields are null for channel mappings
        row.slack_user_id = None;
        row.dm_channel_id = None;
        crate::db::run(move |conn| {
            diesel::insert_into(m::slack_mappings)
                .values(&row)
                .execute(conn)?;
            Ok(m::slack_mappings
                .filter(m::id.eq(&row.id))
                .select(SlackMapping::as_select())
                .first(conn)?)
        })
        .await
    }

    /// Update a channel mapping. Fails when the channel has no mapping.
    pub async fn update_channel_mapping(
        &self,
        channel_id: &str,
        data: ChannelMappingUpdate,
    ) -> anyhow::Result<()> {
        let channel_id = channel_id.to_string();
        crate::db::run(move |conn| {
            let updated =
                diesel::update(m::slack_mappings.filter(m::slack_channel_id.eq(&channel_id)))
                    .set(SlackMappingChangeset {
                        slack_channel_name: data.slack_channel_name.map(Some),
                        ..Default::default()
                    })
                    .execute(conn)?;
            if updated == 0 {
                return Err(no_record_for_update());
            }
            Ok(())
        })
        .await
    }

    /// Delete a channel mapping. Fails when the channel has no mapping.
    pub async fn delete_channel_mapping(&self, channel_id: &str) -> anyhow::Result<()> {
        let channel_id = channel_id.to_string();
        crate::db::run(move |conn| {
            let deleted =
                diesel::delete(m::slack_mappings.filter(m::slack_channel_id.eq(&channel_id)))
                    .execute(conn)?;
            if deleted == 0 {
                return Err(no_record_for_delete());
            }
            Ok(())
        })
        .await
    }

    /// Delete the user mapping of a Slack user, if there is one.
    pub async fn remove_user_mapping(
        &self,
        connection_id: &str,
        slack_user_id: &str,
    ) -> anyhow::Result<()> {
        let (connection_id, slack_user_id) = (connection_id.to_string(), slack_user_id.to_string());
        crate::db::run(move |conn| {
            diesel::delete(
                m::slack_mappings
                    .filter(m::connection_id.eq(&connection_id))
                    .filter(m::slack_user_id.eq(&slack_user_id)),
            )
            .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// Create a channel mapping, or point an existing one at this agent and person.
    pub async fn upsert_channel_mapping(
        &self,
        connection_id: &str,
        channel_id: &str,
        agent_id: &str,
        channel_name: &str,
        lens_user_id: &str,
    ) -> anyhow::Result<SlackMapping> {
        let mut row = NewSlackMapping::new(connection_id, agent_id);
        row.slack_channel_id = Some(channel_id.to_string());
        row.slack_channel_name = Some(channel_name.to_string());
        row.lens_user_id = Some(lens_user_id.to_string());
        row.slack_user_id = None;
        row.dm_channel_id = None;
        crate::db::run(move |conn| {
            conn.transaction(|conn| {
                let updated = diesel::update(
                    m::slack_mappings.filter(m::slack_channel_id.eq(row.slack_channel_id.clone())),
                )
                .set(SlackMappingChangeset {
                    connection_id: Some(row.connection_id.clone()),
                    agent_id: Some(row.agent_id.clone()),
                    slack_channel_name: Some(row.slack_channel_name.clone()),
                    lens_user_id: Some(row.lens_user_id.clone()),
                    updated_at: Some(DbDateTime::now()),
                    ..Default::default()
                })
                .execute(conn)?;
                if updated == 0 {
                    diesel::insert_into(m::slack_mappings)
                        .values(&row)
                        .execute(conn)?;
                }
                Ok(m::slack_mappings
                    .filter(m::slack_channel_id.eq(row.slack_channel_id.clone()))
                    .select(SlackMapping::as_select())
                    .first(conn)?)
            })
        })
        .await
    }

    /// Delete a channel's mapping, if there is one.
    pub async fn remove_channel_mapping(&self, channel_id: &str) -> anyhow::Result<()> {
        let channel_id = channel_id.to_string();
        crate::db::run(move |conn| {
            diesel::delete(m::slack_mappings.filter(m::slack_channel_id.eq(&channel_id)))
                .execute(conn)?;
            Ok(())
        })
        .await
    }

    /// Delete all mappings (user + channel) for a given connection.
    /// Used when a SlackConnection is removed — no FK cascade exists because
    /// SlackConnection lives outside this database.
    pub async fn delete_by_connection_id(&self, connection_id: &str) -> anyhow::Result<i64> {
        let connection_id = connection_id.to_string();
        crate::db::run(move |conn| {
            SLACK_MAPPING_SERVICE.delete_by_connection_id_in(conn, &connection_id)
        })
        .await
    }

    /// `delete_by_connection_id` inside a caller's transaction, so the caller can
    /// batch it with other deletes for all-or-nothing semantics.
    pub fn delete_by_connection_id_in(
        &self,
        conn: &mut SqliteConnection,
        connection_id: &str,
    ) -> anyhow::Result<i64> {
        let deleted = diesel::delete(m::slack_mappings.filter(m::connection_id.eq(connection_id)))
            .execute(conn)?;
        Ok(deleted as i64)
    }

    /// Get all channel mappings for a connection
    pub async fn get_channel_mappings_by_connection_id(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Vec<SlackMapping>> {
        let connection_id = connection_id.to_string();
        crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::connection_id.eq(&connection_id))
                .filter(m::slack_channel_id.is_not_null()) // Channel mappings only
                .select(SlackMapping::as_select())
                .load(conn)?)
        })
        .await
    }

    /// Flag a linked channel as the agent's main channel, clearing the flag on the
    /// agent's other channels so at most one is ever main. Runs in a transaction so
    /// the clear + set are atomic.
    ///
    /// The set is scoped to BOTH agentId + channelId (not channelId alone) so a
    /// mismatched call can never flag a channel that belongs to another agent;
    /// fails with `No channel mapping {channelId} found for agent {agentId}` if no
    /// such channel exists for the agent.
    pub async fn set_main_channel(&self, agent_id: &str, channel_id: &str) -> anyhow::Result<()> {
        let agent = agent_id.to_string();
        let channel = channel_id.to_string();
        let set = crate::db::run(move |conn| {
            conn.transaction(|conn| {
                diesel::update(
                    m::slack_mappings
                        .filter(m::agent_id.eq(&agent))
                        .filter(m::slack_channel_id.is_not_null())
                        .filter(m::is_main_channel.eq(true)),
                )
                .set(SlackMappingChangeset {
                    is_main_channel: Some(false),
                    ..Default::default()
                })
                .execute(conn)?;
                let set = diesel::update(
                    m::slack_mappings
                        .filter(m::agent_id.eq(&agent))
                        .filter(m::slack_channel_id.eq(&channel)),
                )
                .set(SlackMappingChangeset {
                    is_main_channel: Some(true),
                    ..Default::default()
                })
                .execute(conn)?;
                Ok::<_, anyhow::Error>(set)
            })
        })
        .await?;
        if set == 0 {
            anyhow::bail!("No channel mapping {channel_id} found for agent {agent_id}");
        }
        Ok(())
    }

    /// The ids of the channels linked to the agent.
    pub async fn list_channel_ids(&self, agent_id: &str) -> anyhow::Result<Vec<String>> {
        let agent_id = agent_id.to_string();
        let channels: Vec<Option<String>> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::agent_id.eq(&agent_id))
                .filter(m::slack_channel_id.is_not_null())
                .select(m::slack_channel_id)
                .load(conn)?)
        })
        .await?;
        Ok(channels
            .into_iter()
            .flatten()
            .filter(|id| !id.is_empty())
            .collect())
    }

    /// Resolve the agent's main channel id: the flagged channel, else the oldest
    /// linked channel (same "flagged, else oldest" rule the adapter uses to route
    /// autonomous output). Returns `None` when the agent has no linked channels.
    pub async fn get_main_channel(&self, agent_id: &str) -> anyhow::Result<Option<String>> {
        let agent_id = agent_id.to_string();
        let channels: Vec<SlackMapping> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::agent_id.eq(&agent_id))
                .filter(m::slack_channel_id.is_not_null())
                .order(m::created_at.asc())
                .select(SlackMapping::as_select())
                .load(conn)?)
        })
        .await?;
        let main = channels
            .iter()
            .find(|c| c.is_main_channel)
            .or_else(|| channels.first());
        Ok(main.and_then(|c| c.slack_channel_id.clone()))
    }

    // ============================================================================
    // General Queries
    // ============================================================================

    /// Get all active user mappings with DM channel (for cache building). A
    /// mapping is left out while the Slack connection is missing or inactive.
    pub async fn get_active_user_mappings_with_dm_channel(
        &self,
    ) -> anyhow::Result<Vec<SlackDmMappingWithConnection>> {
        let mappings: Vec<SlackMapping> = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::dm_channel_id.is_not_null())
                .filter(m::slack_user_id.is_not_null()) // User mappings only
                .select(SlackMapping::as_select())
                .load(conn)?)
        })
        .await?;

        let mut results = Vec::new();
        for mapping in mappings {
            if let Some(conn) = get_slack_connection().await?.filter(|c| c.is_active) {
                results.push(SlackDmMappingWithConnection {
                    mapping,
                    connection: MappingTeamState {
                        team_id: conn.team_id,
                        is_active: conn.is_active,
                    },
                });
            }
        }
        Ok(results)
    }

    /// Check if a channel is already linked to an agent
    pub async fn is_channel_linked(&self, channel_id: &str) -> anyhow::Result<bool> {
        let channel_id = channel_id.to_string();
        let count: i64 = crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::slack_channel_id.eq(&channel_id))
                .count()
                .get_result(conn)?)
        })
        .await?;
        Ok(count > 0)
    }

    /// Count user mappings for a Lens user (DM only)
    pub async fn count_user_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        let lens_user_id = lens_user_id.to_string();
        crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::lens_user_id.eq(&lens_user_id))
                .filter(m::dm_channel_id.is_not_null())
                .count()
                .get_result(conn)?)
        })
        .await
    }

    /// Count all mappings for a Lens user (DM + channel)
    pub async fn count_all_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        let lens_user_id = lens_user_id.to_string();
        crate::db::read(move |conn| {
            Ok(m::slack_mappings
                .filter(m::lens_user_id.eq(&lens_user_id))
                .filter(
                    m::dm_channel_id
                        .is_not_null()
                        .or(m::slack_channel_id.is_not_null()),
                )
                .count()
                .get_result(conn)?)
        })
        .await
    }
}

impl Default for SlackMappingService {
    fn default() -> Self {
        Self::new()
    }
}

pub static SLACK_MAPPING_SERVICE: LazyLock<SlackMappingService> =
    LazyLock::new(SlackMappingService::new);

/// Shared by the Slack tests: rows a test database needs.
#[cfg(test)]
pub(crate) mod testing {
    use diesel::prelude::*;

    use crate::db::models::{NewAgentWorkspace, NewSlackMapping};
    use crate::db::schema::agent_workspaces::dsl as aw;
    use crate::db::schema::slack_mappings::dsl as m;

    /// Inserts an agent with `id`, owned by `user_id`, named `name`.
    pub fn insert_agent(id: &str, user_id: &str, name: &str) {
        let mut row = NewAgentWorkspace::new(user_id, "", "", "", "", "");
        row.id = id.to_string();
        row.name = name.to_string();
        crate::db::run_sync(move |conn| {
            diesel::insert_into(aw::agent_workspaces)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    /// Inserts a mapping row.
    pub fn insert_mapping(row: NewSlackMapping) {
        crate::db::run_sync(move |conn| {
            diesel::insert_into(m::slack_mappings)
                .values(&row)
                .execute(conn)?;
            Ok(())
        })
        .unwrap();
    }

    /// A channel mapping of `agent_id`, created `age_ms` before now.
    pub fn channel_mapping(agent_id: &str, channel_id: &str, age_ms: i64) -> NewSlackMapping {
        let mut row = NewSlackMapping::new("T1", agent_id);
        row.slack_channel_id = Some(channel_id.to_string());
        row.slack_channel_name = Some(format!("name-{channel_id}"));
        row.lens_user_id = Some("owner".to_string());
        let at = chrono::Utc::now() - chrono::Duration::milliseconds(age_ms);
        row.created_at = at.into();
        row.updated_at = at.into();
        row
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::db::testing::test_db;
    use crate::lib::slack_config::{
        __reset_slack_config_for_tests, SlackConnectionRecord, set_slack_config_for_tests,
    };

    fn connection() -> SlackConnectionRecord {
        SlackConnectionRecord {
            id: "T1".into(),
            team_id: "T1".into(),
            team_name: "Team".into(),
            bot_token: "xoxb".into(),
            bot_id: "B1".into(),
            bot_user_id: "UBOT".into(),
            installed_at: crate::support::now_iso(),
            is_active: true,
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn the_main_channel_is_the_flagged_one_else_the_oldest() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        insert_mapping(channel_mapping("agent-1", "C-new", 1_000));
        insert_mapping(channel_mapping("agent-1", "C-old", 5_000));
        let service = SlackMappingService::new();
        assert_eq!(
            service
                .get_main_channel("agent-1")
                .await
                .unwrap()
                .as_deref(),
            Some("C-old")
        );

        service.set_main_channel("agent-1", "C-new").await.unwrap();
        assert_eq!(
            service
                .get_main_channel("agent-1")
                .await
                .unwrap()
                .as_deref(),
            Some("C-new")
        );
        assert_eq!(service.get_main_channel("agent-2").await.unwrap(), None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn refuses_to_flag_a_channel_of_another_agent() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        insert_mapping(channel_mapping("agent-1", "C1", 1_000));
        let err = SlackMappingService::new()
            .set_main_channel("agent-2", "C1")
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "No channel mapping C1 found for agent agent-2"
        );
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn upserts_a_user_mapping_and_keeps_its_dm_channel_when_none_is_given() {
        let _db = test_db();
        insert_agent("agent-1", "owner", "Agent");
        let service = SlackMappingService::new();
        let created = service
            .upsert_user_mapping("T1", "U1", "lens-1", "agent-1", Some("D1"))
            .await
            .unwrap();
        assert_eq!(created.dm_channel_id.as_deref(), Some("D1"));
        assert_eq!(created.slack_channel_id, None);

        let updated = service
            .upsert_user_mapping("T1", "U1", "lens-2", "agent-1", None)
            .await
            .unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.lens_user_id.as_deref(), Some("lens-2"));
        assert_eq!(updated.dm_channel_id.as_deref(), Some("D1"));

        let found = service
            .find_user_mapping("T1", "U1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.agent_workspace.name, "Agent");
        assert_eq!(service.count_all_mappings("lens-2").await.unwrap(), 1);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn finds_a_channel_mapping_with_its_connection_and_agent() {
        let _db = test_db();
        set_slack_config_for_tests(Some(connection()));
        insert_agent("agent-1", "owner", "Agent");
        insert_mapping(channel_mapping("agent-1", "C1", 1_000));
        let found = SlackMappingService::new().find_by_channel_id("C1").await;
        let missing = SlackMappingService::new().find_by_channel_id("C2").await;
        __reset_slack_config_for_tests();
        let found = found.unwrap().unwrap();
        assert_eq!(found.connection.team_id, "T1");
        assert_eq!(found.connection.agent.user_id, "owner");
        assert!(missing.unwrap().is_none());
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn deleting_a_missing_channel_mapping_fails() {
        let _db = test_db();
        let err = SlackMappingService::new()
            .delete_channel_mapping("C-none")
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("No record was found for a delete.")
        );
    }
}
