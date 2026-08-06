/**
 * Agent CRUD Service
 *
 * Manages agent lifecycle: creation, deletion, lookups, ownership validation,
 * Nexus token management, and subagent relationships.
 *
 * This is the authoritative service for agent data — the backend delegates
 * all agent operations here via the management API.
 */

import { AgentWorkspace } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { getDefaultWorkspaceFiles } from '../templates/default-workspace';
import { trackEvent } from '../lib/telemetry';
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
 * `?? config.chatModelId` themselves. The default is provider-neutral
 * (`chatModelId` resolves to the active vendor's model).
 */
export function resolveEffectiveModel(stored: string | null | undefined): string {
  return stored ?? config.chatModelId;
}

/**
 * Resolve the effective model for a scoped override (heartbeat or cron): the
 * scoped override when set, otherwise the main per-agent override, otherwise
 * the runtime's env-configured default. Layers on top of
 * `resolveEffectiveModel` so the `?? config.chatModelId` fallback stays in
 * exactly one place.
 */
export function resolveScopedModel(
  scoped: string | null | undefined,
  main: string | null | undefined,
): string {
  return resolveEffectiveModel(scoped ?? main);
}

/**
 * Validate and normalize a model-override input. Accepts a non-empty string
 * (format-checked, trimmed) or `null` to clear. Throws `ValidationError` on
 * anything else. Shared by every model setter so the format rule lives once.
 */
function normalizeModelOverride(model: unknown): string | null {
  if (model === null) return null;
  if (typeof model === 'string') {
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
    return trimmed;
  }
  throw new ValidationError('model must be a string or null');
}

// ============================================================================
// Types
// ============================================================================

export interface SubagentInfo {
  id: string;
  name: string;
  description: string;
}

/**
 * A scoped model override (heartbeat/cron) plus the model it resolves to.
 * `override` is the raw stored value (`null` when unset); `effective` is what
 * the corresponding run would actually use after applying the fallback chain.
 */
export interface ModelOverrideInfo {
  override: string | null;
  effective: string;
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

    const agent = await prisma.agentWorkspace.create({
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
        // Seed model overrides from ~/.prism/settings.json when present; null
        // leaves the agent on the env-default model (resolveEffectiveModel).
        model: config.agentDefaults?.model ?? null,
        heartbeatModel: config.agentDefaults?.heartbeatModel ?? null,
        cronModel: config.agentDefaults?.cronModel ?? null,
      },
    });
    trackEvent('agent created', input.userId, {
      'agent.id': agent.id,
      'agent.type': agent.agentType,
    });
    return agent;
  }

  // ============================================================================
  // Agent Lookup & Access
  // ============================================================================

  /**
   * Delete the agent this runtime owns, with an optional ownership check.
   * Resolves the single agent via `getAgent()` (which throws if it's
   * missing). Returns 'forbidden' when the ownership check fails,
   * 'deleted' on success.
   */
  async deleteAgent(
    options?: { userId?: string; allowedByTeam?: boolean },
  ): Promise<'deleted' | 'forbidden'> {
    const agent = await this.getAgent();
    if (!options?.allowedByTeam && (!options?.userId || agent.userId !== options.userId)) return 'forbidden';
    await prisma.agentWorkspace.delete({ where: { id: agent.id } });
    trackEvent('agent deleted', options?.userId ?? agent.userId, {
      'agent.id': agent.id,
    });
    return 'deleted';
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

    trackEvent('subagent added', null, {
      'agent.id': parentAgentId,
      'subagent.id': childAgentId,
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
    trackEvent('subagent removed', null, {
      'agent.id': parentAgentId,
      'subagent.id': childAgentId,
    });
    return 'deleted';
  }

  /**
   * Get the one agent this runtime owns (resolved from config.agentId,
   * pinned at boot by resolveOrBootstrapSingleAgent). Throws if AGENT_ID
   * is unset or the row is missing.
   */
  async getAgent(): Promise<AgentWorkspace> {
    if (!config.agentId) throw new Error('AGENT_ID not configured');
    const agent = await prisma.agentWorkspace.findUnique({ where: { id: config.agentId } });
    if (!agent) throw new Error(`Agent ${config.agentId} not found`);
    return agent;
  }

  async getAllAgents(): Promise<AgentWorkspace[]> {
    return prisma.agentWorkspace.findMany();
  }

  /**
   * Rename the agent. Shared by the management `PATCH /agents/:agentId/name`
   * endpoint and the `rename_self` agent tool so trim/validate/persist live
   * in one place. Resolves the single agent via `getAgent()` (which throws
   * if it's missing). Throws `ValidationError` for bad input.
   */
  async renameAgent(name: unknown): Promise<AgentWorkspace> {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (trimmed.length > AGENT_NAME_MAX) {
      throw new ValidationError(`name must be ≤ ${AGENT_NAME_MAX} chars`);
    }
    const agent = await this.getAgent();
    const updated = await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { name: trimmed },
    });
    trackEvent('agent renamed', null, {
      'agent.id': updated.id,
      'agent.name': updated.name,
    });
    return updated;
  }

  /**
   * Resolve the effective LLM model for an agent: the per-agent override if
   * set, otherwise the runtime's env-configured default. Callers that need
   * the raw override (e.g. to decide whether to display "unset") should use
   * `getAgent().model` instead.
   */
  async getEffectiveModel(): Promise<string> {
    const agent = await this.getAgent();
    return resolveEffectiveModel(agent.model);
  }

  /**
   * Set or clear the per-agent LLM model override. Passing `null` clears the
   * override and the agent falls back to the runtime's default model
   * (`config.chatModelId`). Validates format only — the model ID does NOT
   * have to be in the curated suggestion list, so users can opt into models
   * the runtime hasn't been told about yet. Returns the **resolved** effective
   * model after the write, so callers (e.g. the PATCH route) don't have to
   * reimplement the `?? config.chatModelId` fallback.
   */
  async updateModel(model: unknown): Promise<string> {
    const normalized = normalizeModelOverride(model);
    const agent = await this.getAgent();
    const updated = await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { model: normalized },
    });
    const effective = resolveEffectiveModel(updated.model);
    trackEvent('agent model updated', null, {
      'agent.id': updated.id,
      'agent.model': effective,
    });
    return effective;
  }

  /**
   * Read the heartbeat-specific model override and the model it currently
   * resolves to. `override` is the raw stored value (`null` when unset, so the
   * UI can render "empty → falls back"); `effective` is what a heartbeat run
   * would actually use (heartbeat override → main override → env default).
   */
  async getHeartbeatModelInfo(): Promise<ModelOverrideInfo> {
    const agent = await this.getAgent();
    return {
      override: agent.heartbeatModel,
      effective: resolveScopedModel(agent.heartbeatModel, agent.model),
    };
  }

  /** Cron equivalent of {@link getHeartbeatModelInfo}. */
  async getCronModelInfo(): Promise<ModelOverrideInfo> {
    const agent = await this.getAgent();
    return {
      override: agent.cronModel,
      effective: resolveScopedModel(agent.cronModel, agent.model),
    };
  }

  /**
   * Set or clear the heartbeat-specific model override. `null` clears it; the
   * agent then falls back to the main override, then the env default. Validates
   * format only (same rule as {@link updateModel}). Returns the raw override
   * and the resolved effective model after the write.
   */
  async updateHeartbeatModel(model: unknown): Promise<ModelOverrideInfo> {
    const normalized = normalizeModelOverride(model);
    const agent = await this.getAgent();
    const updated = await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { heartbeatModel: normalized },
    });
    const effective = resolveScopedModel(updated.heartbeatModel, updated.model);
    logger.info(
      { agentId: updated.id, heartbeatModel: updated.heartbeatModel, effective },
      '[AgentWorkspace] heartbeat model updated',
    );
    trackEvent('agent heartbeat model updated', null, {
      'agent.id': updated.id,
      'agent.model': effective,
    });
    return { override: updated.heartbeatModel, effective };
  }

  /**
   * Set the verbose (per-step delivery) flag. When false (default), only the
   * final text step of a multi-step chat turn is delivered to the channel;
   * intermediate steps are still persisted. When true, every text step is
   * delivered as it arrives (existing behavior).
   */
  async updateVerbose(verbose: unknown): Promise<boolean> {
    if (typeof verbose !== 'boolean') {
      throw new ValidationError('verbose must be a boolean');
    }
    const agent = await this.getAgent();
    const updated = await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { verbose },
    });
    trackEvent('agent verbose updated', null, {
      'agent.id': updated.id,
      'agent.verbose': String(updated.verbose),
    });
    return updated.verbose;
  }

  /**
   * Set locked-in mode. When on, the agent's own tools may no longer rewrite
   * the workspace markdown files (soul, memory summary, user profile, vision,
   * heartbeat config, bootstrap) — those tools are withheld from the tool set
   * and their writes refused. Vector memory, behavioural settings and renames
   * stay editable, and this setter itself is never reachable from a tool, so a
   * locked agent cannot unlock itself.
   */
  async updateLockedIn(lockedIn: unknown): Promise<boolean> {
    if (typeof lockedIn !== 'boolean') {
      throw new ValidationError('lockedIn must be a boolean');
    }
    const agent = await this.getAgent();
    const updated = await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { lockedIn },
    });
    trackEvent('agent locked-in updated', null, {
      'agent.id': updated.id,
      'agent.locked_in': String(updated.lockedIn),
    });
    return updated.lockedIn;
  }

  /**
   * Read locked-in mode. Called at every guarded write rather than snapshotted
   * per turn, so toggling the lock takes effect immediately — including
   * part-way through a turn that already collected its tools.
   */
  async isLockedIn(): Promise<boolean> {
    const agent = await this.getAgent();
    return agent.lockedIn;
  }

  /** Cron equivalent of {@link updateHeartbeatModel}. */
  async updateCronModel(model: unknown): Promise<ModelOverrideInfo> {
    const normalized = normalizeModelOverride(model);
    const agent = await this.getAgent();
    const updated = await prisma.agentWorkspace.update({
      where: { id: agent.id },
      data: { cronModel: normalized },
    });
    const effective = resolveScopedModel(updated.cronModel, updated.model);
    logger.info(
      { agentId: updated.id, cronModel: updated.cronModel, effective },
      '[AgentWorkspace] cron model updated',
    );
    trackEvent('agent cron model updated', null, {
      'agent.id': updated.id,
      'agent.model': effective,
    });
    return { override: updated.cronModel, effective };
  }
}

// Export singleton instance
export const agentWorkspaceService = new AgentWorkspaceService();
