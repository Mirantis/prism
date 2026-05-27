/**
 * Agent Status Service
 *
 * Writes agent fields directly via Prisma, eliminating HTTP round-trips
 * to the backend for simple field updates (heartbeat timestamp, status).
 */

import { AgentStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AgentHeartbeatStatus } from '../types';

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

  async updateAgentById(agentId: string, data: Prisma.AgentWorkspaceUpdateInput): Promise<void> {
    await prisma.agentWorkspace.update({
      where: { id: agentId },
      data,
    });
  }

  async updateHeartbeatTimestamp(): Promise<void> {
    const agent = await prisma.agentWorkspace.findFirstOrThrow();

    await this.updateAgentById(agent.id, { lastHeartbeat: new Date() });
  }

  async updateAgentHeartbeatStatus(heartbeatStatus: AgentHeartbeatStatus): Promise<void> {
    const agent = await prisma.agentWorkspace.findFirstOrThrow();

    await this.updateAgentById(agent.id, { heartbeatStatus });
  }

  async updateAgentStatus(agentId: string, status: AgentStatus): Promise<void> {
    await prisma.agentWorkspace.update({ where: { id: agentId }, data: { status } });
  }
}

export const agentStatusService = new AgentStatusService();
