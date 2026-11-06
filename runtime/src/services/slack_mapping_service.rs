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
use serde::{Deserialize, Serialize};

use crate::db::models::SlackMapping;

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
        todo!()
    }

    /// Find all user mappings for a Lens user, each with the Slack connection's
    /// workspace. A mapping is left out while no Slack connection is configured.
    pub async fn find_user_mappings_by_lens_user_id(
        &self,
        lens_user_id: &str,
    ) -> anyhow::Result<Vec<SlackUserMappingWithTeam>> {
        todo!()
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
        todo!()
    }

    /// Update DM channel ID for a user mapping
    pub async fn update_dm_channel_id(
        &self,
        mapping_id: &str,
        dm_channel_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Delete a user mapping by Lens user ID and connection
    pub async fn delete_user_mapping(
        &self,
        connection_id: &str,
        lens_user_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
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
        todo!()
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
        todo!()
    }

    /// Update a channel mapping. Fails when the channel has no mapping.
    pub async fn update_channel_mapping(
        &self,
        channel_id: &str,
        data: ChannelMappingUpdate,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Delete a channel mapping. Fails when the channel has no mapping.
    pub async fn delete_channel_mapping(&self, channel_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    /// Delete all mappings (user + channel) for a given connection.
    /// Used when a SlackConnection is removed — no FK cascade exists because
    /// SlackConnection lives outside this database.
    pub async fn delete_by_connection_id(&self, connection_id: &str) -> anyhow::Result<i64> {
        todo!()
    }

    /// `delete_by_connection_id` inside a caller's transaction, so the caller can
    /// batch it with other deletes for all-or-nothing semantics.
    pub fn delete_by_connection_id_in(
        &self,
        conn: &mut SqliteConnection,
        connection_id: &str,
    ) -> anyhow::Result<i64> {
        todo!()
    }

    /// Get all channel mappings for a connection
    pub async fn get_channel_mappings_by_connection_id(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Vec<SlackMapping>> {
        todo!()
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
        todo!()
    }

    /// The ids of the channels linked to the agent.
    pub async fn list_channel_ids(&self, agent_id: &str) -> anyhow::Result<Vec<String>> {
        todo!()
    }

    /// Resolve the agent's main channel id: the flagged channel, else the oldest
    /// linked channel (same "flagged, else oldest" rule the adapter uses to route
    /// autonomous output). Returns `None` when the agent has no linked channels.
    pub async fn get_main_channel(&self, agent_id: &str) -> anyhow::Result<Option<String>> {
        todo!()
    }

    // ============================================================================
    // General Queries
    // ============================================================================

    /// Get all active user mappings with DM channel (for cache building). A
    /// mapping is left out while the Slack connection is missing or inactive.
    pub async fn get_active_user_mappings_with_dm_channel(
        &self,
    ) -> anyhow::Result<Vec<SlackDmMappingWithConnection>> {
        todo!()
    }

    /// Check if a channel is already linked to an agent
    pub async fn is_channel_linked(&self, channel_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// Count user mappings for a Lens user (DM only)
    pub async fn count_user_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        todo!()
    }

    /// Count all mappings for a Lens user (DM + channel)
    pub async fn count_all_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        todo!()
    }
}

impl Default for SlackMappingService {
    fn default() -> Self {
        Self::new()
    }
}

pub static SLACK_MAPPING_SERVICE: LazyLock<SlackMappingService> =
    LazyLock::new(SlackMappingService::new);
