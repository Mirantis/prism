/**
 * Slack Mapping Service
 *
 * Manages SlackMapping records for both user/DM mappings and channel/team mappings.
 * Extracted from slack-adapter.service.ts for cleaner separation of concerns.
 *
 * Mapping Types:
 * - User Mapping (DM mode): slackUserId + lensUserId + dmChannelId set
 * - Channel Mapping (Team mode): slackChannelId + slackChannelName set
 *
 * Each row is EITHER a user mapping OR a channel mapping, enforced in code.
 */

import { Prisma, SlackMapping } from '@prisma/client';
import prisma from '../lib/prisma';
import { getSlackConnection } from '../lib/slack-source';
import { config } from '../config';

// ============================================================================
// Types
// ============================================================================

export interface SlackMappingWithConnection extends SlackMapping {
  connection: {
    id: string;
    teamId: string;
    teamName: string;
    isActive: boolean;
    agent: {
      id: string;
      userId: string;
      name: string;
    };
  };
}

// ============================================================================
// Slack Mapping Service
// ============================================================================

class SlackMappingService {
  // ============================================================================
  // User Mappings (DM Mode)
  // ============================================================================

  /**
   * Find a user mapping by Slack user ID (includes agent info)
   */
  async findUserMapping(
    connectionId: string,
    slackUserId: string
  ): Promise<(SlackMapping & { agentWorkspace: { id: string; name: string } }) | null> {
    return prisma.slackMapping.findUnique({
      where: {
        connectionId_slackUserId: {
          connectionId,
          slackUserId,
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
   * Find all user mappings for a Lens user
   */
  async findUserMappingsByLensUserId(
    lensUserId: string
  ): Promise<Array<SlackMapping & { connection: { teamId: string; teamName: string; isActive: boolean } }>> {
    const mappings = await prisma.slackMapping.findMany({
      where: {
        lensUserId,
        slackUserId: { not: null }, // User mappings only
      },
    });

    // Fetch connection data from backend for each mapping
    const results: Array<SlackMapping & { connection: { teamId: string; teamName: string; isActive: boolean } }> = [];
    for (const mapping of mappings) {
      const conn = await getSlackConnection();
      if (conn) {
        results.push({
          ...mapping,
          connection: {
            teamId: conn.teamId,
            teamName: conn.teamName,
            isActive: conn.isActive,
          },
        });
      }
    }
    return results;
  }

  /**
   * Create or update a user mapping (DM mode)
   */
  async upsertUserMapping(
    connectionId: string,
    slackUserId: string,
    lensUserId: string,
    agentId: string,
    dmChannelId?: string
  ): Promise<SlackMapping> {
    return prisma.slackMapping.upsert({
      where: {
        connectionId_slackUserId: {
          connectionId,
          slackUserId,
        },
      },
      update: {
        lensUserId,
        agentId,
        dmChannelId,
        updatedAt: new Date(),
      },
      create: {
        connectionId,
        agentId,
        slackUserId,
        lensUserId,
        dmChannelId,
        // Ensure channel fields are null for user mappings
        slackChannelId: null,
        slackChannelName: null,
      },
    });
  }

  /**
   * Update DM channel ID for a user mapping
   */
  async updateDmChannelId(mappingId: string, dmChannelId: string): Promise<void> {
    await prisma.slackMapping.update({
      where: { id: mappingId },
      data: { dmChannelId },
    });
  }

  /**
   * Delete a user mapping by Lens user ID and connection
   */
  async deleteUserMapping(connectionId: string, lensUserId: string): Promise<void> {
    await prisma.slackMapping.deleteMany({
      where: {
        connectionId,
        lensUserId,
        slackUserId: { not: null }, // User mappings only
      },
    });
  }

  // ============================================================================
  // Channel Mappings (Team Mode)
  // ============================================================================

  /**
   * Find a channel mapping by Slack channel ID
   */
  async findByChannelId(channelId: string): Promise<SlackMappingWithConnection | null> {
    const mapping = await prisma.slackMapping.findUnique({
      where: { slackChannelId: channelId },
    });

    if (!mapping) return null;

    // Fetch connection data from backend
    const conn = await getSlackConnection();
    if (!conn) return null;

    // Fetch agent data from local database
    const agent = await prisma.agentWorkspace.findUnique({
      where: { id: mapping.agentId },
      select: { id: true, userId: true, name: true },
    });
    if (!agent) return null;

    return {
      ...mapping,
      connection: {
        id: conn.id,
        teamId: conn.teamId,
        teamName: conn.teamName,
        isActive: conn.isActive,
        agent,
      },
    };
  }

  /**
   * Create a channel mapping (Team mode)
   */
  async createChannelMapping(
    connectionId: string,
    channelId: string,
    agentId: string,
    channelName?: string,
    lensUserId?: string
  ): Promise<SlackMapping> {
    return prisma.slackMapping.create({
      data: {
        connectionId,
        agentId,
        slackChannelId: channelId,
        slackChannelName: channelName,
        // For channel mappings, lensUserId stores the agent owner
        lensUserId: lensUserId || null,
        // Ensure user-only fields are null for channel mappings
        slackUserId: null,
        dmChannelId: null,
      },
    });
  }

  /**
   * Update a channel mapping
   */
  async updateChannelMapping(
    channelId: string,
    data: { slackChannelName?: string }
  ): Promise<void> {
    await prisma.slackMapping.update({
      where: { slackChannelId: channelId },
      data,
    });
  }

  /**
   * Delete a channel mapping
   */
  async deleteChannelMapping(channelId: string): Promise<void> {
    await prisma.slackMapping.delete({
      where: { slackChannelId: channelId },
    });
  }

  /**
   * Delete all mappings (user + channel) for a given connection.
   * Used when a SlackConnection is removed — no FK cascade exists because
   * SlackConnection lives in the backend-only DB.
   *
   * Accepts an optional transaction client so callers can batch this with
   * other deletes for all-or-nothing semantics.
   */
  async deleteByConnectionId(
    connectionId: string,
    client?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = client ?? prisma;
    const result = await db.slackMapping.deleteMany({
      where: { connectionId },
    });
    return result.count;
  }

  /**
   * Get all channel mappings for a connection
   */
  async getChannelMappingsByConnectionId(
    connectionId: string
  ): Promise<SlackMapping[]> {
    return prisma.slackMapping.findMany({
      where: {
        connectionId,
        slackChannelId: { not: null }, // Channel mappings only
      },
    });
  }

  /**
   * Resolve the agent's "main" channel mapping — where autonomous output
   * (heartbeat alerts, and scheduled tasks with no resolvable origin channel)
   * is posted. Prefers the explicitly flagged channel; falls back to the oldest
   * linked channel so delivery still works before the user picks one (and for
   * legacy rows linked before the flag existed). Returns null if no channel is
   * linked.
   */
  async getMainChannel(agentId: string): Promise<SlackMapping | null> {
    const channels = await prisma.slackMapping.findMany({
      where: { agentId, slackChannelId: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    return channels.find(c => c.isMainChannel) ?? channels[0] ?? null;
  }

  /**
   * Flag a linked channel as the agent's main channel, clearing the flag on the
   * agent's other channels so at most one is ever main. Runs in a transaction so
   * the clear + set are atomic.
   *
   * The set is scoped to BOTH agentId + channelId (not channelId alone) so a
   * mismatched call can never flag a channel that belongs to another agent;
   * throws if no such channel exists for the agent.
   */
  async setMainChannel(agentId: string, channelId: string): Promise<void> {
    const [, set] = await prisma.$transaction([
      prisma.slackMapping.updateMany({
        where: { agentId, slackChannelId: { not: null }, isMainChannel: true },
        data: { isMainChannel: false },
      }),
      prisma.slackMapping.updateMany({
        where: { agentId, slackChannelId: channelId },
        data: { isMainChannel: true },
      }),
    ]);
    if (set.count === 0) {
      throw new Error(`No channel mapping ${channelId} found for agent ${agentId}`);
    }
  }

  // ============================================================================
  // General Queries
  // ============================================================================

  /**
   * Get all active user mappings with DM channel (for cache building)
   */
  async getActiveUserMappingsWithDmChannel(): Promise<
    Array<SlackMapping & { connection: { teamId: string; isActive: boolean } }>
  > {
    const mappings = await prisma.slackMapping.findMany({
      where: {
        dmChannelId: { not: null },
        slackUserId: { not: null }, // User mappings only
      },
    });

    const results: Array<SlackMapping & { connection: { teamId: string; isActive: boolean } }> = [];
    for (const mapping of mappings) {
      const conn = await getSlackConnection();
      if (conn?.isActive) {
        results.push({
          ...mapping,
          connection: { teamId: conn.teamId, isActive: conn.isActive },
        });
      }
    }
    return results;
  }

  /**
   * Check if a channel is already linked to an agent
   */
  async isChannelLinked(channelId: string): Promise<boolean> {
    const count = await prisma.slackMapping.count({
      where: { slackChannelId: channelId },
    });
    return count > 0;
  }

  /**
   * Count user mappings for a Lens user (DM only)
   */
  async countUserMappings(lensUserId: string): Promise<number> {
    return prisma.slackMapping.count({
      where: {
        lensUserId,
        dmChannelId: { not: null },
      },
    });
  }

  /**
   * Count all mappings for a Lens user (DM + channel)
   */
  async countAllMappings(lensUserId: string): Promise<number> {
    return prisma.slackMapping.count({
      where: {
        lensUserId,
        OR: [
          { dmChannelId: { not: null } },
          { slackChannelId: { not: null } },
        ],
      },
    });
  }
}

// Export singleton instance
export const slackMappingService = new SlackMappingService();
