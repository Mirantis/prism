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

use serde::{Deserialize, Serialize};

use crate::db::models::TeamsMapping;

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
        todo!()
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
        todo!()
    }

    /// Update the personal-scope conversation ID for a user mapping — the target
    /// every proactive DM send is addressed to.
    pub async fn update_dm_conversation_id(
        &self,
        mapping_id: &str,
        dm_conversation_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Delete a user mapping by Lens user ID and connection (rows with a
    /// `teamsUserId` only).
    pub async fn delete_user_mapping(
        &self,
        connection_id: &str,
        lens_user_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    // ========================================================================
    // Channel Mappings (Team Mode)
    // ========================================================================

    /// Find a channel mapping by its (suffix-free) channel conversation ID.
    pub async fn find_by_conversation_id(
        &self,
        channel_conversation_id: &str,
    ) -> anyhow::Result<Option<TeamsChannelMappingWithAgent>> {
        todo!()
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
        todo!()
    }

    /// Update a channel mapping. Throws (Prisma's `update`) when no row has the id.
    pub async fn update_channel_mapping(
        &self,
        channel_conversation_id: &str,
        data: TeamsChannelMappingUpdate,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Delete a channel mapping. Throws (Prisma's `delete`) when no row has the id.
    pub async fn delete_channel_mapping(
        &self,
        channel_conversation_id: &str,
    ) -> anyhow::Result<()> {
        todo!()
    }

    /// Get all channel mappings for a connection.
    pub async fn get_channel_mappings_by_connection_id(
        &self,
        connection_id: &str,
    ) -> anyhow::Result<Vec<TeamsMapping>> {
        todo!()
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
        todo!()
    }

    /// Resolve the agent's main channel conversation id: the flagged channel, else
    /// the oldest linked channel (same "flagged, else oldest" rule the adapter
    /// uses to route autonomous output). Returns `None` when the agent has no
    /// linked channels.
    pub async fn get_main_channel(&self, agent_id: &str) -> anyhow::Result<Option<String>> {
        todo!()
    }

    // ========================================================================
    // General Queries
    // ========================================================================

    /// Check if a channel is already linked to an agent.
    pub async fn is_channel_linked(&self, channel_conversation_id: &str) -> anyhow::Result<bool> {
        todo!()
    }

    /// Count user mappings for a Lens user (DM only: rows with a `dmConversationId`).
    pub async fn count_user_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        todo!()
    }

    /// Count all mappings for a Lens user (DM + channel).
    pub async fn count_all_mappings(&self, lens_user_id: &str) -> anyhow::Result<i64> {
        todo!()
    }
}

pub static TEAMS_MAPPING_SERVICE: LazyLock<TeamsMappingService> =
    LazyLock::new(TeamsMappingService::new);
