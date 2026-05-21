/**
 * Slack Heartbeat Trigger Service
 *
 * CRUD service for per-agent Slack heartbeat trigger config.
 * Each agent can have at most one trigger. When configured, messages
 * in the designated Slack channel trigger the agent's heartbeat.
 *
 * Includes throttle logic: atomic claim via raw SQL to prevent
 * race conditions across multiple backend instances.
 */

import prisma from '../lib/prisma';
import { Prisma, SlackHeartbeatTrigger } from '@prisma/client';

export interface ClaimResult {
  claimed: boolean;
  /** Seconds remaining until cooldown expires (only set when not claimed) */
  remainingSeconds?: number;
}

class SlackHeartbeatTriggerService {
  /**
   * Get all active triggers for a specific user.
   */
  async getActiveTriggers(userId: string, agentId: string) {
    return prisma.slackHeartbeatTrigger.findMany({
      where: { userId, agentId, isActive: true },
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
    agentId: string,
    userId: string,
    throttleSeconds?: number,
  ): Promise<SlackHeartbeatTrigger> {
    return prisma.slackHeartbeatTrigger.create({
      data: {
        connectionId,
        slackChannelId: channelId,
        slackChannelName: channelName,
        agentId,
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
    await prisma.slackHeartbeatTrigger.deleteMany({
      where: { id: triggerId, userId },
    });
  }

  /**
   * Delete all triggers for a given connection. Used when a SlackConnection
   * is removed — no FK cascade exists because SlackConnection lives in the
   * backend-only DB.
   *
   * Accepts an optional transaction client so callers can batch this with
   * other deletes for all-or-nothing semantics.
   */
  async deleteByConnectionId(
    connectionId: string,
    client?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = client ?? prisma;
    const result = await db.slackHeartbeatTrigger.deleteMany({
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
  ): Promise<SlackHeartbeatTrigger | null> {
    const result = await prisma.slackHeartbeatTrigger.updateMany({
      where: { id: triggerId, userId },
      data: { throttleSeconds },
    });
    if (result.count === 0) return null;
    return prisma.slackHeartbeatTrigger.findUnique({ where: { id: triggerId } });
  }

  /**
   * Try to claim a trigger for firing.
   *
   * Read → check → CAS-update via Prisma's typed API instead of a raw
   * UPDATE, because the cooldown comparison ("lastTriggered + throttle
   * <= now") needs portable Postgres + SQLite semantics, and Prisma's
   * typed `where` can't express a column-vs-column-plus-interval check.
   * The CAS predicate `where: { lastTriggeredAt: prev }` preserves the
   * single-claimer invariant: if a concurrent writer claimed between
   * our read and update, `count === 0` and we treat it as throttled.
   */
  async tryClaimTrigger(agentId: string): Promise<ClaimResult> {
    const trigger = await prisma.slackHeartbeatTrigger.findFirst({
      where: { agentId, isActive: true },
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

    const result = await prisma.slackHeartbeatTrigger.updateMany({
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
   * Fast check used by the Slack adapter to see if a channel is a heartbeat trigger.
   */
  async isHeartbeatTriggerChannel(
    channelId: string,
  ): Promise<{ isTrigger: boolean; userId?: string; agentId?: string }> {
    const trigger = await prisma.slackHeartbeatTrigger.findUnique({
      where: { slackChannelId: channelId, isActive: true },
    });

    if (!trigger) {
      return { isTrigger: false };
    }

    return { isTrigger: true, userId: trigger.userId, agentId: trigger.agentId };
  }
}

export const slackHeartbeatTriggerService = new SlackHeartbeatTriggerService();
