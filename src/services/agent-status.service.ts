/**
 * Agent Status Service
 *
 * Writes agent fields directly via Prisma, eliminating HTTP round-trips
 * to the backend for simple field updates (heartbeat timestamp, status).
 */

import { AgentStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AgentHeartbeatStatus } from '../types';
import { DELIVER_TARGETS, deliveryTargetService, isValidDeliverTo, parseCommaList } from './delivery-target.service';

class AgentStatusService {
  private activeProcessingCount: Map<string, number> = new Map();

  /**
   * Mark an agent as processing. Sets status to RUNNING in DB on first concurrent task.
   * Must be paired with setDoneProcessing() in a finally block.
   */
  async setProcessing(agentId: string): Promise<void> {
    const count = (this.activeProcessingCount.get(agentId) ?? 0) + 1;
    this.activeProcessingCount.set(agentId, count);
    if (count === 1) {
      await this.updateAgentStatus(agentId, AgentStatus.RUNNING);
    }
  }

  /**
   * Mark an agent as done processing. Sets status to IDLE in DB when all concurrent tasks finish.
   */
  async setDoneProcessing(agentId: string): Promise<void> {
    const count = Math.max(0, (this.activeProcessingCount.get(agentId) ?? 1) - 1);
    this.activeProcessingCount.set(agentId, count);
    if (count === 0) {
      await this.updateAgentStatus(agentId, AgentStatus.IDLE);
    }
  }

  /**
   * Whether any invoke-loop turn (chat, heartbeat, cron, goal) is in flight.
   * Counts what setProcessing/setDoneProcessing bracket — the auxiliary model
   * calls (classification gates, thread titles) are not tracked here; they
   * are sub-second, fail-open calls whose loss on a restart is harmless.
   */
  isBusy(): boolean {
    for (const count of this.activeProcessingCount.values()) {
      if (count > 0) return true;
    }
    return false;
  }

  async updateAgentById(agentId: string, data: Prisma.AgentWorkspaceUpdateInput): Promise<void> {
    await prisma.agentWorkspace.update({
      where: { id: agentId },
      data,
    });
  }

  /**
   * Persist the heartbeat schedule. `nextHeartbeatAt` is the deadline the next
   * process arms, and `lastHeartbeat` the check that really ran — passed only by
   * a recorded cycle, so a cadence change moves the deadline without reporting a
   * heartbeat. Both columns move in one write, so no boot can read one of them
   * from an older event than the other.
   */
  async updateHeartbeatSchedule(schedule: { lastHeartbeat?: Date; nextHeartbeatAt: Date }): Promise<void> {
    const agent = await prisma.agentWorkspace.findFirstOrThrow();

    await this.updateAgentById(agent.id, {
      nextHeartbeatAt: schedule.nextHeartbeatAt,
      ...(schedule.lastHeartbeat ? { lastHeartbeat: schedule.lastHeartbeat } : {}),
    });
  }

  async updateAgentHeartbeatStatus(heartbeatStatus: AgentHeartbeatStatus): Promise<void> {
    const agent = await prisma.agentWorkspace.findFirstOrThrow();

    await this.updateAgentById(agent.id, { heartbeatStatus });
  }

  /** Where a heartbeat run may post: a `DELIVER_TARGETS` value and the chosen linked channels. */
  async getHeartbeatDelivery(): Promise<{ deliverTo: string; channelIds: string[] }> {
    const agent = await prisma.agentWorkspace.findFirstOrThrow({
      select: { heartbeatDeliverTo: true, heartbeatChannelIds: true },
    });
    return { deliverTo: agent.heartbeatDeliverTo, channelIds: parseCommaList(agent.heartbeatChannelIds) };
  }

  /**
   * Change where a heartbeat run may post. A channel list is kept only for the
   * target it was chosen for; the next run reads the new setting.
   */
  async updateHeartbeatDelivery(
    changes: { deliverTo?: unknown; channelIds?: unknown },
  ): Promise<{ ok: false; error: string } | { ok: true; value: { deliverTo: string; channelIds: string[] } }> {
    const agent = await prisma.agentWorkspace.findFirstOrThrow({
      select: { id: true, heartbeatDeliverTo: true, heartbeatChannelIds: true },
    });
    const deliverTo = changes.deliverTo ?? agent.heartbeatDeliverTo;
    if (!isValidDeliverTo(deliverTo)) {
      return { ok: false, error: `deliverTo must be one of: ${DELIVER_TARGETS.join(', ')}` };
    }
    let channelIds = deliverTo === agent.heartbeatDeliverTo ? agent.heartbeatChannelIds : null;
    if (changes.channelIds !== undefined) {
      const read = await deliveryTargetService.readChannelIds(
        changes.channelIds,
        deliverTo,
        agent.id,
        parseCommaList(agent.heartbeatChannelIds),
      );
      if (!read.ok) return read;
      channelIds = read.value;
    }
    await this.updateAgentById(agent.id, { heartbeatDeliverTo: deliverTo, heartbeatChannelIds: channelIds });
    return { ok: true, value: { deliverTo, channelIds: parseCommaList(channelIds) } };
  }

  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    await prisma.agentWorkspace.update({ where: { id: agentId }, data: { status } });
  }
}

export const agentStatusService = new AgentStatusService();
