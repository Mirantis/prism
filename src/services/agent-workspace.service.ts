/**
 * Agent CRUD Service
 *
 * Manages agent lifecycle: creation, deletion, lookups, ownership validation,
 * Nexus token management, and subagent relationships.
 *
 * This is the authoritative service for agent data — the backend delegates
 * all agent operations here via the management API.
 */

import { AgentWorkspace, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { getDefaultWorkspaceFiles } from '../templates/default-workspace';
import { logger } from '../logger';
import { config } from '../config';

// Format-only validation for the per-agent model override. Letters/digits and
// a small set of separators cover Bedrock inference-profile IDs, region-prefixed
// IDs, and bare vendor SKUs. Membership in any curated list is intentionally
// NOT enforced — users can opt into models the runtime hasn't been told about.
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:\-/]+$/;
const MODEL_ID_MAX_LEN = 200;

/**
 * Resolve the effective model ID from a stored per-agent override: the
 * override when set, otherwise the runtime's env-configured default. Single
 * source of truth for the fallback rule — call sites must not inline
 * `?? config.bedrockModelId` themselves.
 */
export function resolveEffectiveModel(stored: string | null | undefined): string {
  return stored ?? config.bedrockModelId;
}

// ============================================================================
// Types
// ============================================================================

export interface SubagentInfo {
  id: string;
  name: string;
  description: string;
}

export interface CreateAgentInput {
  id: string;
  userId: string;
  name: string;
  agentType: AgentWorkspace['agentType'];
  teamName: string;
}

/**
 * Thrown when caller input fails validation. Lets HTTP callers map to 400
 * while non-HTTP callers (e.g. agent tools) just surface the message.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when the targeted agent does not exist. HTTP callers map to 404.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const AGENT_NAME_MAX = 64;

// ============================================================================
// Agent Service
// ============================================================================

class AgentWorkspaceService {
  /**
   * Create a new agent with org/team context.
   */
  async createAgent(input: CreateAgentInput): Promise<AgentWorkspace> {
    const defaults = getDefaultWorkspaceFiles();

    // Template the bootstrap with agent name and team name
    const bootstrapMd = defaults.bootstrapMd
      .replace(/\{\{agentName\}\}/g, () => input.name)
      .replace(/\{\{teamName\}\}/g, () => input.teamName);

    return prisma.agentWorkspace.create({
      data: {
        id: input.id,
        userId: input.userId,
        name: input.name,
        agentType: input.agentType,
        soulMd: defaults.soulMd,
        userMd: defaults.userMd,
        memoryMd: defaults.memoryMd,
        heartbeatMd: defaults.heartbeatMd,
        bootstrapMd,
        visionMd: defaults.visionMd,
        agentMd: defaults.agentMd,
        currentSessionId: uuidv4(),
      },
    });
  }

  // ============================================================================
  // Nexus MCP Agent Token
  // ============================================================================

  async getNexusMcpAgentToken(): Promise<null> {
    // Tool creds are injected at the sandbox proxy layer, so the runtime
    // never needs an explicit token. Kept as a no-op so call sites can
    // continue to thread an `Authorization` header when one exists.
    return null;
  }

  // ============================================================================
  // Agent Lookup & Access
  // ============================================================================

  /**
   * Delete an agent by ID with access check.
   */
  async deleteAgent(
    agentId: string,
    options?: { userId?: string; allowedByTeam?: boolean },
  ): Promise<'deleted' | 'not_found' | 'forbidden'> {
    const agent = await prisma.agentWorkspace.findUnique({ where: { id: agentId } });
    if (!agent) return 'not_found';
    if (!options?.allowedByTeam && (!options?.userId || agent.userId !== options.userId)) return 'forbidden';
    await prisma.agentWorkspace.delete({ where: { id: agentId } });
    return 'deleted';
  }

  /**
   * Validate that an agent exists and belongs to a user.
   */
  async validateOwnership(agentId: string, userId: string): Promise<{ valid: boolean; agent?: AgentWorkspace }> {
    const agent = await prisma.agentWorkspace.findFirst({ where: { id: agentId, userId } });
    if (!agent) return { valid: false };
    return { valid: true, agent };
  }

  /**
   * Get subagents for a given agent.
   * Returns full agent data + description (frontend needs status, agentType, etc.).
   */
  async getSubagents(agentId: string): Promise<(AgentWorkspace & { description: string })[]> {
    const links = await prisma.agentSubagent.findMany({
      where: { parentAgentId: agentId },
      include: { childAgentWorkspace: true },
      orderBy: { createdAt: 'asc' },
    });

    return links.map((link) => ({ ...link.childAgentWorkspace, description: link.description }));
  }

  /**
   * Add a subagent to a parent agent.
   */
  async addSubagent(
    parentAgentId: string,
    childAgentId: string,
    description?: string,
  ): Promise<AgentWorkspace | 'parent_not_found' | 'child_not_found' | 'self_reference' | 'already_exists' | 'not_subagent_type' | 'parent_is_subagent'> {
    if (parentAgentId === childAgentId) return 'self_reference';

    const parent = await prisma.agentWorkspace.findUnique({ where: { id: parentAgentId } });
    if (!parent) return 'parent_not_found';
    if (parent.agentType === 'SUBAGENT') return 'parent_is_subagent';

    const child = await prisma.agentWorkspace.findUnique({ where: { id: childAgentId } });
    if (!child) return 'child_not_found';
    if (child.agentType !== 'SUBAGENT') return 'not_subagent_type';

    const existing = await prisma.agentSubagent.findUnique({
      where: { parentAgentId_childAgentId: { parentAgentId, childAgentId } },
    });
    if (existing) return 'already_exists';

    await prisma.agentSubagent.create({
      data: {
        parentAgentId,
        childAgentId,
        ...(description && { description }),
      },
    });

    return child;
  }

  /**
   * Remove a subagent from a parent agent.
   */
  async removeSubagent(
    parentAgentId: string,
    childAgentId: string,
  ): Promise<'deleted' | 'parent_not_found' | 'link_not_found'> {
    const parent = await prisma.agentWorkspace.findUnique({ where: { id: parentAgentId } });
    if (!parent) return 'parent_not_found';

    const link = await prisma.agentSubagent.findUnique({
      where: { parentAgentId_childAgentId: { parentAgentId, childAgentId } },
    });
    if (!link) return 'link_not_found';

    await prisma.agentSubagent.delete({ where: { id: link.id } });
    return 'deleted';
  }

  /**
   * Get agent by ID (no access check).
   */
  async getAgentById(agentId: string): Promise<AgentWorkspace> {
    const agent = await prisma.agentWorkspace.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    return agent;
  }

  async getAllAgents(): Promise<AgentWorkspace[]> {
    return prisma.agentWorkspace.findMany();
  }

  /**
   * Rename an agent. Shared by the management `PATCH /agents/:agentId/name`
   * endpoint and the `rename_self` agent tool so trim/validate/persist live
   * in one place. Throws `ValidationError` for bad input and `NotFoundError`
   * when the agent doesn't exist.
   */
  async renameAgent(agentId: string, name: unknown): Promise<AgentWorkspace> {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (trimmed.length > AGENT_NAME_MAX) {
      throw new ValidationError(`name must be ≤ ${AGENT_NAME_MAX} chars`);
    }
    try {
      return await prisma.agentWorkspace.update({
        where: { id: agentId },
        data: { name: trimmed },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundError('Agent not found');
      }
      throw error;
    }
  }

  /**
   * Resolve the effective LLM model for an agent: the per-agent override if
   * set, otherwise the runtime's env-configured default. Callers that need
   * the raw override (e.g. to decide whether to display "unset") should use
   * `getAgentById(agentId).model` instead.
   */
  async getEffectiveModel(agentId: string): Promise<string> {
    const agent = await prisma.agentWorkspace.findUnique({
      where: { id: agentId },
      select: { model: true },
    });
    if (!agent) {
      throw new NotFoundError('Agent not found');
    }
    return resolveEffectiveModel(agent.model);
  }

  /**
   * Set or clear the per-agent LLM model override. Passing `null` clears the
   * override and the agent falls back to the runtime's default model
   * (`config.bedrockModelId`). Validates format only — the model ID does NOT
   * have to be in the curated suggestion list, so users can opt into models
   * the runtime hasn't been told about yet. Returns the **resolved** effective
   * model after the write, so callers (e.g. the PATCH route) don't have to
   * reimplement the `?? config.bedrockModelId` fallback.
   */
  async updateModel(agentId: string, model: unknown): Promise<string> {
    let normalized: string | null;
    if (model === null) {
      normalized = null;
    } else if (typeof model === 'string') {
      const trimmed = model.trim();
      if (
        trimmed.length === 0 ||
        trimmed.length > MODEL_ID_MAX_LEN ||
        !MODEL_ID_PATTERN.test(trimmed)
      ) {
        throw new ValidationError(
          `model must be 1-${MODEL_ID_MAX_LEN} chars of [A-Za-z0-9._:-/], or null to clear`,
        );
      }
      normalized = trimmed;
    } else {
      throw new ValidationError('model must be a string or null');
    }
    try {
      const updated = await prisma.agentWorkspace.update({
        where: { id: agentId },
        data: { model: normalized },
      });
      return resolveEffectiveModel(updated.model);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundError('Agent not found');
      }
      throw error;
    }
  }
}

// Export singleton instance
export const agentWorkspaceService = new AgentWorkspaceService();
