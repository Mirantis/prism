/**
 * Teams Mapping Service
 *
 * Manages TeamsMapping records for both user/DM mappings and channel/team
 * mappings — the Microsoft Teams mirror of slack-mapping.service.ts.
 *
 * Mapping Types:
 * - User Mapping (DM mode): teamsUserId + lensUserId + dmConversationId set
 * - Channel Mapping (Team mode): channelConversationId + channelName set
 *
 * Each row is EITHER a user mapping OR a channel mapping, enforced in code.
 * Channel conversation ids are stored WITHOUT any `;messageid=` thread suffix.
 */

import { TeamsMapping } from '@prisma/client';
import prisma from '../../lib/prisma';

class TeamsMappingService {
  // ============================================================================
  // User Mappings (DM Mode)
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
   * Create or update a user mapping (DM mode)
   */
  async upsertUserMapping(
    connectionId: string,
    teamsUserId: string,
    lensUserId: string,
    agentId: string,
    dmConversationId?: string,
    tenantId?: string
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
        dmConversationId,
        tenantId,
        updatedAt: new Date(),
      },
      create: {
        connectionId,
        agentId,
        teamsUserId,
        lensUserId,
        dmConversationId,
        tenantId,
        // Ensure channel fields are null for user mappings
        channelConversationId: null,
        channelName: null,
      },
    });
  }

  /**
   * Update the personal-scope conversation ID for a user mapping — the target
   * every proactive DM send is addressed to.
   */
  async updateDmConversationId(mappingId: string, dmConversationId: string): Promise<void> {
    await prisma.teamsMapping.update({
      where: { id: mappingId },
      data: { dmConversationId },
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
   * Find a channel mapping by its (suffix-free) channel conversation ID
   */
  async findByConversationId(
    channelConversationId: string
  ): Promise<(TeamsMapping & { agentWorkspace: { id: string; userId: string; name: string } }) | null> {
    return prisma.teamsMapping.findUnique({
      where: { channelConversationId },
      include: {
        agentWorkspace: {
          select: { id: true, userId: true, name: true },
        },
      },
    });
  }

  /**
   * Create a channel mapping (Team mode)
   */
  async createChannelMapping(
    connectionId: string,
    channelConversationId: string,
    agentId: string,
    channelName?: string,
    lensUserId?: string,
    tenantId?: string
  ): Promise<TeamsMapping> {
    return prisma.teamsMapping.create({
      data: {
        connectionId,
        agentId,
        channelConversationId,
        channelName,
        tenantId,
        // For channel mappings, lensUserId stores the agent owner
        lensUserId: lensUserId || null,
        // Ensure user-only fields are null for channel mappings
        teamsUserId: null,
        dmConversationId: null,
      },
    });
  }

  /**
   * Update a channel mapping
   */
  async updateChannelMapping(
    channelConversationId: string,
    data: { channelName?: string }
  ): Promise<void> {
    await prisma.teamsMapping.update({
      where: { channelConversationId },
      data,
    });
  }

  /**
   * Delete a channel mapping
   */
  async deleteChannelMapping(channelConversationId: string): Promise<void> {
    await prisma.teamsMapping.delete({
      where: { channelConversationId },
    });
  }

  /**
   * Get all channel mappings for a connection
   */
  async getChannelMappingsByConnectionId(connectionId: string): Promise<TeamsMapping[]> {
    return prisma.teamsMapping.findMany({
      where: {
        connectionId,
        channelConversationId: { not: null }, // Channel mappings only
      },
    });
  }

  /**
   * Flag a linked channel as the agent's main channel, clearing the flag on the
   * agent's other channels so at most one is ever main. Runs in a transaction so
   * the clear + set are atomic.
   *
   * The set is scoped to BOTH agentId + conversationId (not conversationId
   * alone) so a mismatched call can never flag a channel that belongs to
   * another agent; throws if no such channel exists for the agent.
   */
  async setMainChannel(agentId: string, channelConversationId: string): Promise<void> {
    const [, set] = await prisma.$transaction([
      prisma.teamsMapping.updateMany({
        where: { agentId, channelConversationId: { not: null }, isMainChannel: true },
        data: { isMainChannel: false },
      }),
      prisma.teamsMapping.updateMany({
        where: { agentId, channelConversationId },
        data: { isMainChannel: true },
      }),
    ]);
    // Throws for the ordinary cause — a mismatched agent or a typo'd id, where
    // nothing was cleared that mattered. A delete that races the route's
    // pre-check also lands here, having cleared the flag first; the caller sees
    // an error and the main-channel resolver falls back to the oldest channel,
    // so no alert is lost.
    if (set.count === 0) {
      throw new Error(`No channel mapping ${channelConversationId} found for agent ${agentId}`);
    }
  }

  /**
   * Resolve the agent's main channel conversation id: the flagged channel, else
   * the oldest linked channel (same "flagged, else oldest" rule the adapter
   * uses to route autonomous output). Returns null when the agent has no
   * linked channels.
   */
  async getMainChannel(agentId: string): Promise<string | null> {
    const channels = await prisma.teamsMapping.findMany({
      where: { agentId, channelConversationId: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    const main = channels.find((m) => m.isMainChannel) ?? channels[0];
    return main?.channelConversationId ?? null;
  }

  // ============================================================================
  // General Queries
  // ============================================================================

  /**
   * Check if a channel is already linked to an agent
   */
  async isChannelLinked(channelConversationId: string): Promise<boolean> {
    const count = await prisma.teamsMapping.count({
      where: { channelConversationId },
    });
    return count > 0;
  }

  /**
   * Count user mappings for a Lens user (DM only)
   */
  async countUserMappings(lensUserId: string): Promise<number> {
    return prisma.teamsMapping.count({
      where: {
        lensUserId,
        dmConversationId: { not: null },
      },
    });
  }

  /**
   * Count all mappings for a Lens user (DM + channel)
   */
  async countAllMappings(lensUserId: string): Promise<number> {
    return prisma.teamsMapping.count({
      where: {
        lensUserId,
        OR: [
          { dmConversationId: { not: null } },
          { channelConversationId: { not: null } },
        ],
      },
    });
  }
}

// Export singleton instance
export const teamsMappingService = new TeamsMappingService();
