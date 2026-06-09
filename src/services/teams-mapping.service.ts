/**
 * Teams Mapping Service
 *
 * Manages TeamsMapping records for both user/personal-chat mappings and
 * channel/team mappings — the Teams analogue of `slack-mapping.service.ts`.
 *
 * Mapping Types:
 * - User Mapping (personal mode): teamsUserId + lensUserId + personalConversationId set
 * - Channel Mapping (team mode): teamsChannelId + teamsChannelName set
 *
 * Each row is EITHER a user mapping OR a channel mapping, enforced in code.
 */

import { Prisma, TeamsMapping } from '@prisma/client';
import prisma from '../lib/prisma';
import { getTeamsConnection } from '../lib/teams-source';

// ============================================================================
// Types
// ============================================================================

export interface TeamsMappingWithConnection extends TeamsMapping {
  connection: {
    id: string;
    appId: string;
    isActive: boolean;
    agent: {
      id: string;
      userId: string;
      name: string;
    };
  };
}

// ============================================================================
// Teams Mapping Service
// ============================================================================

class TeamsMappingService {
  // ============================================================================
  // User Mappings (Personal Mode)
  // ============================================================================

  /**
   * Find a user mapping by Teams user ID (includes agent info)
   */
  async findUserMapping(
    connectionId: string,
    teamsUserId: string
  ): Promise<(TeamsMapping & { agentWorkspace: { id: string; name: string } }) | null> {
    return prisma.teamsMapping.findUnique({
      where: {
        connectionId_teamsUserId: {
          connectionId,
          teamsUserId,
        },
      },
      include: {
        agentWorkspace: {
          select: { id: true, name: true },
        },
      },
    });
  }

  /**
   * Create or update a user mapping (personal mode)
   */
  async upsertUserMapping(
    connectionId: string,
    teamsUserId: string,
    lensUserId: string,
    agentId: string,
    personalConversationId?: string,
    conversationReference?: Prisma.InputJsonValue
  ): Promise<TeamsMapping> {
    return prisma.teamsMapping.upsert({
      where: {
        connectionId_teamsUserId: {
          connectionId,
          teamsUserId,
        },
      },
      update: {
        lensUserId,
        agentId,
        personalConversationId,
        conversationReference,
        updatedAt: new Date(),
      },
      create: {
        connectionId,
        agentId,
        teamsUserId,
        lensUserId,
        personalConversationId,
        conversationReference,
        // Ensure channel fields are null for user mappings
        teamsChannelId: null,
        teamsChannelName: null,
      },
    });
  }

  /**
   * Update the stored conversation reference (and personal conversation id)
   * for a user mapping. Called on every inbound personal-chat message so
   * proactive delivery always has a fresh route back.
   */
  async updateConversationReference(
    mappingId: string,
    personalConversationId: string,
    conversationReference: Prisma.InputJsonValue
  ): Promise<void> {
    await prisma.teamsMapping.update({
      where: { id: mappingId },
      data: { personalConversationId, conversationReference },
    });
  }

  /**
   * Delete a user mapping by Lens user ID and connection
   */
  async deleteUserMapping(connectionId: string, lensUserId: string): Promise<void> {
    await prisma.teamsMapping.deleteMany({
      where: {
        connectionId,
        lensUserId,
        teamsUserId: { not: null }, // User mappings only
      },
    });
  }

  // ============================================================================
  // Channel Mappings (Team Mode)
  // ============================================================================

  /**
   * Find a channel mapping by Teams channel ID
   */
  async findByChannelId(channelId: string): Promise<TeamsMappingWithConnection | null> {
    const mapping = await prisma.teamsMapping.findUnique({
      where: { teamsChannelId: channelId },
    });

    if (!mapping) return null;

    const conn = await getTeamsConnection();
    if (!conn) return null;

    const agent = await prisma.agentWorkspace.findUnique({
      where: { id: mapping.agentId },
      select: { id: true, userId: true, name: true },
    });
    if (!agent) return null;

    return {
      ...mapping,
      connection: {
        id: conn.id,
        appId: conn.appId,
        isActive: conn.isActive,
        agent,
      },
    };
  }

  /**
   * Update a channel mapping
   */
  async updateChannelMapping(
    channelId: string,
    data: { teamsChannelName?: string; serviceUrl?: string; tenantId?: string }
  ): Promise<void> {
    await prisma.teamsMapping.update({
      where: { teamsChannelId: channelId },
      data,
    });
  }

  /**
   * Delete a channel mapping
   */
  async deleteChannelMapping(channelId: string): Promise<void> {
    await prisma.teamsMapping.delete({
      where: { teamsChannelId: channelId },
    });
  }

  /**
   * Delete all mappings (user + channel) for a given connection.
   *
   * Accepts an optional transaction client so callers can batch this with
   * other deletes for all-or-nothing semantics.
   */
  async deleteByConnectionId(
    connectionId: string,
    client?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = client ?? prisma;
    const result = await db.teamsMapping.deleteMany({
      where: { connectionId },
    });
    return result.count;
  }

  // ============================================================================
  // General Queries
  // ============================================================================

  /**
   * Get all active user mappings with a stored conversation reference
   * (i.e. mappings we can deliver to proactively).
   */
  async getDeliverableUserMappings(): Promise<TeamsMapping[]> {
    return prisma.teamsMapping.findMany({
      where: {
        teamsUserId: { not: null }, // User mappings only
        conversationReference: { not: Prisma.DbNull },
      },
    });
  }

  /**
   * Check if a channel is already linked to an agent
   */
  async isChannelLinked(channelId: string): Promise<boolean> {
    const count = await prisma.teamsMapping.count({
      where: { teamsChannelId: channelId },
    });
    return count > 0;
  }

  /**
   * Count all mappings for a Lens user (personal + channel)
   */
  async countAllMappings(lensUserId: string): Promise<number> {
    return prisma.teamsMapping.count({
      where: {
        lensUserId,
        OR: [
          { teamsUserId: { not: null } },
          { teamsChannelId: { not: null } },
        ],
      },
    });
  }
}

// Export singleton instance
export const teamsMappingService = new TeamsMappingService();
