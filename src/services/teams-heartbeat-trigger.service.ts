/**
 * Teams Heartbeat Trigger Service
 *
 * CRUD service for per-agent Teams heartbeat trigger config — the Teams
 * analogue of `slack-heartbeat-trigger.service.ts`. Each agent can have at
 * most one trigger. When configured, messages in the designated Teams
 * channel trigger the agent's heartbeat.
 *
 * Includes throttle logic: atomic CAS-style claim to prevent races.
 */

import prisma from '../lib/prisma';
import { Prisma, TeamsHeartbeatTrigger } from '@prisma/client';
import { config } from '../config';

export interface ClaimResult {
  claimed: boolean;
  /** Seconds remaining until cooldown expires (only set when not claimed) */
  remainingSeconds?: number;
}

class TeamsHeartbeatTriggerService {
  /**
   * Get all active triggers for a specific user.
   */
  async getActiveTriggers(userId: string) {
    return prisma.teamsHeartbeatTrigger.findMany({
      where: { userId, isActive: true },
      include: { agentWorkspace: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Create a new heartbeat trigger for the user.
   */
  async createTrigger(
    connectionId: string,
    channelId: string,
    channelName: string | null,
    userId: string,
    throttleSeconds?: number,
  ): Promise<TeamsHeartbeatTrigger> {
    if (!config.agentId) throw new Error('AGENT_ID not configured');
    return prisma.teamsHeartbeatTrigger.create({
      data: {
        connectionId,
        teamsChannelId: channelId,
        teamsChannelName: channelName,
        agentId: config.agentId,
        userId,
        isActive: true,
        ...(throttleSeconds !== undefined && { throttleSeconds }),
      },
    });
  }

  /**
   * Remove a specific trigger by ID, scoped to the user.
   */
  async deleteTrigger(triggerId: string, userId: string): Promise<void> {
    await prisma.teamsHeartbeatTrigger.deleteMany({
      where: { id: triggerId, userId },
    });
  }

  /**
   * Delete all triggers for a given connection.
   *
   * Accepts an optional transaction client so callers can batch this with
   * other deletes for all-or-nothing semantics.
   */
  async deleteByConnectionId(
    connectionId: string,
    client?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = client ?? prisma;
    const result = await db.teamsHeartbeatTrigger.deleteMany({
      where: { connectionId },
    });
    return result.count;
  }

  /**
   * Update throttle settings for a trigger.
   */
  async updateThrottle(
    triggerId: string,
    userId: string,
    throttleSeconds: number,
  ): Promise<TeamsHeartbeatTrigger | null> {
    const result = await prisma.teamsHeartbeatTrigger.updateMany({
      where: { id: triggerId, userId },
      data: { throttleSeconds },
    });
    if (result.count === 0) return null;
    return prisma.teamsHeartbeatTrigger.findUnique({ where: { id: triggerId } });
  }

  /**
   * Try to claim a trigger for firing.
   *
   * Read → check → CAS-update via Prisma's typed API; the CAS predicate
   * `where: { lastTriggeredAt: prev }` preserves the single-claimer
   * invariant — see the Slack counterpart for the full rationale.
   */
  async tryClaimTrigger(): Promise<ClaimResult> {
    const trigger = await prisma.teamsHeartbeatTrigger.findFirst({
      where: { isActive: true },
      select: { id: true, lastTriggeredAt: true, throttleSeconds: true },
    });

    if (!trigger) {
      return { claimed: false, remainingSeconds: 0 };
    }

    const now = new Date();
    const cooldownExpired =
      trigger.lastTriggeredAt === null ||
      trigger.lastTriggeredAt.getTime() + trigger.throttleSeconds * 1000 <= now.getTime();

    if (!cooldownExpired) {
      const elapsedMs = now.getTime() - trigger.lastTriggeredAt!.getTime();
      const remainingSeconds = Math.max(
        0,
        Math.ceil((trigger.throttleSeconds * 1000 - elapsedMs) / 1000),
      );
      return { claimed: false, remainingSeconds };
    }

    const result = await prisma.teamsHeartbeatTrigger.updateMany({
      where: {
        id: trigger.id,
        isActive: true,
        lastTriggeredAt: trigger.lastTriggeredAt,
      },
      data: { lastTriggeredAt: now },
    });

    if (result.count > 0) {
      return { claimed: true };
    }

    return { claimed: false, remainingSeconds: trigger.throttleSeconds };
  }

  /**
   * Fast check used by the Teams adapter to see if a channel is a heartbeat trigger.
   */
  async isHeartbeatTriggerChannel(
    channelId: string,
  ): Promise<{ isTrigger: boolean; userId?: string; agentId?: string }> {
    const trigger = await prisma.teamsHeartbeatTrigger.findUnique({
      where: { teamsChannelId: channelId, isActive: true },
    });

    if (!trigger) {
      return { isTrigger: false };
    }

    return { isTrigger: true, userId: trigger.userId, agentId: trigger.agentId };
  }
}

export const teamsHeartbeatTriggerService = new TeamsHeartbeatTriggerService();
