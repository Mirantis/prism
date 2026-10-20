/**
 * Agent CRUD Service
 *
 * Manages agent lifecycle: creation, deletion, lookups, ownership validation,
 * platform token management, and subagent relationships.
 *
 * This is the authoritative service for agent data — the backend delegates
 * all agent operations here via the management API.
 */

import { AgentWorkspace, AgentWorkspaceRevision } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { getDefaultWorkspaceFiles } from '../templates/default-workspace';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { config } from '../config';
import { DocumentWriteActor, DocumentWriteMethod, WorkspaceDocField } from '../lib/workspace-docs';
import type { WorkspaceSeed } from '../lib/workspace-seed';
import { documentRevisionService } from './document-revision.service';

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

/**
 * The note a restore records when the caller supplies none. It names the
 * revision that was restored, since the history row otherwise says only that
 * something was restored.
 */
function defaultRollbackReason(restoredFrom: Date): string {
  return `Restored the revision from ${restoredFrom.toISOString()}.`;
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
  /** Documents that replace the default templates (`PRISM_WORKSPACE_SEED_DIR`). */
  documents?: WorkspaceSeed;
}

/**
 * One write to one identity document. `reason` is what the history shows the
 * user: the agent supplies its `changeDescription`, and a user write supplies
 * its own note.
 */
export interface WriteWorkspaceDocInput {
  agentId: string;
  field: WorkspaceDocField;
  content: string;
  actor: DocumentWriteActor;
  method: DocumentWriteMethod;
  reason: string;
}

/**
 * One restore of one identity document. `expectedRevisionId` is the newest
 * revision the caller read; a write that lands in between makes it stale and the
 * restore is refused rather than applied over the newer content.
 */
export interface RollbackWorkspaceDocInput {
  agentId: string;
  field: WorkspaceDocField;
  revisionId: string;
  expectedRevisionId: string;
  reason: string;
}

/**
 * What a restore did. A union rather than a thrown error, so the route maps each
 * outcome to its status code and nothing else has to know the codes.
 */
export type RollbackWorkspaceDocResult =
  | { status: 'restored'; content: string; revision: AgentWorkspaceRevision }
  | { status: 'revision_not_found' }
  | { status: 'stale'; newestRevisionId: string | null };

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
    const docs = { ...getDefaultWorkspaceFiles(), ...input.documents };

    // Every document gets the name placeholders filled, since a seeded one may
    // use them as the default bootstrap does.
    const fill = (text: string) =>
      text
        .replace(/\{\{agentName\}\}/g, () => input.name)
        .replace(/\{\{teamName\}\}/g, () => input.teamName);

    // The seed revisions land with the row, so the content the agent was
    // created with is the oldest thing its history holds. Without them the
    // oldest reachable state is the first edit.
    const agent = await prisma.$transaction(async (tx) => {
      const created = await tx.agentWorkspace.create({
        data: {
          id: input.id,
          userId: input.userId,
          name: input.name,
          agentType: input.agentType,
          soulMd: fill(docs.soulMd),
          userMd: fill(docs.userMd),
          memoryMd: docs.memoryMd,
          heartbeatMd: fill(docs.heartbeatMd),
          bootstrapMd: fill(docs.bootstrapMd),
          visionMd: fill(docs.visionMd),
          agentMd: fill(docs.agentMd),
          currentSessionId: uuidv4(),
          // Seed model overrides from ~/.prism/settings.json when present; null
          // leaves the agent on the env-default model (resolveEffectiveModel).
          model: config.agentDefaults?.model ?? null,
          heartbeatModel: config.agentDefaults?.heartbeatModel ?? null,
          cronModel: config.agentDefaults?.cronModel ?? null,
        },
      });
      await documentRevisionService.recordSeeds(tx, created);
      return created;
    });
    trackEvent('agent created', input.userId, {
      'agent.id': agent.id,
      'agent.type': agent.agentType,
      'agent.seeded_documents': String(Object.keys(input.documents ?? {}).length),
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
   * and their writes refused. The agent guide is not in the set because no tool
   * writes it. The user's own REST editor reaches every document either way.
   * Vector memory, behavioural settings and renames stay editable.
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

  /** Read locked-in mode from the live agent row. */
  async isLockedIn(): Promise<boolean> {
    const agent = await this.getAgent();
    return agent.lockedIn;
  }

  /**
   * The one write path for an identity document. It replaces the column and
   * appends a revision in one transaction, so a document and its history cannot
   * disagree: a failed write leaves neither.
   *
   * The caller checks the lock, restarts the heartbeat and emits its own
   * telemetry, because each of those differs per call site while this does not.
   * Returns the stored content.
   */
  async writeWorkspaceDoc(input: WriteWorkspaceDocInput): Promise<string> {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.agentWorkspace.update({
        where: { id: input.agentId },
        data: { [input.field]: input.content },
      });
      await documentRevisionService.record(tx, {
        agentId: input.agentId,
        field: input.field,
        content: input.content,
        actor: input.actor,
        method: input.method,
        reason: input.reason,
      });
      return updated[input.field];
    });
  }

  /**
   * Restore an earlier revision of one identity document.
   *
   * One transaction reads the target revision, compares the newest revision
   * against `expectedRevisionId`, replaces the column and records the restore as
   * a revision of its own. The history keeps every step, so a restore is itself
   * reversible.
   *
   * Locked-in mode does not gate this. That lock withholds the agent's own
   * writers, and a restore is the user acting.
   */
  async rollbackWorkspaceDoc(
    input: RollbackWorkspaceDocInput,
  ): Promise<RollbackWorkspaceDocResult> {
    const result = await prisma.$transaction<RollbackWorkspaceDocResult>(async (tx) => {
      const target = await documentRevisionService.get(
        tx,
        input.agentId,
        input.field,
        input.revisionId,
      );
      if (!target) return { status: 'revision_not_found' };

      const newest = await documentRevisionService.newest(tx, input.agentId, input.field);
      if ((newest?.id ?? null) !== input.expectedRevisionId) {
        return { status: 'stale', newestRevisionId: newest?.id ?? null };
      }

      await tx.agentWorkspace.update({
        where: { id: input.agentId },
        data: { [input.field]: target.content },
      });
      const revision = await documentRevisionService.record(tx, {
        agentId: input.agentId,
        field: input.field,
        content: target.content,
        actor: 'user',
        method: 'rollback',
        reason: input.reason.trim() || defaultRollbackReason(target.createdAt),
      });
      return { status: 'restored', content: target.content, revision };
    });

    if (result.status === 'restored') {
      trackEvent('agent config updated', null, {
        'agent.id': input.agentId,
        'config.field': input.field,
        'config.method': 'rollback',
      });
    }
    if (result.status === 'stale') {
      // The same shape as a refused locked write: the field and why, no content.
      trackEvent('agent document restore refused', null, {
        'agent.id': input.agentId,
        'config.field': input.field,
        'restore.refusal': 'stale_revision',
      });
    }
    return result;
  }

  /**
   * Replace one identity document on the user's behalf. Locked-in mode does not
   * gate this — that lock covers what the agent's own tools may rewrite.
   *
   * `reason` is the note the history shows for this write. Returns the stored
   * content.
   */
  async updateWorkspaceDoc(
    field: WorkspaceDocField,
    content: unknown,
    reason?: unknown,
  ): Promise<string> {
    if (typeof content !== 'string') {
      throw new ValidationError(`${field} must be a string`);
    }
    const agent = await this.getAgent();
    const stored = await this.writeWorkspaceDoc({
      agentId: agent.id,
      field,
      content,
      actor: 'user',
      method: 'rest',
      reason: typeof reason === 'string' ? reason : '',
    });
    trackEvent('agent config updated', null, {
      'agent.id': agent.id,
      'config.field': field,
      'config.method': 'rest',
    });
    return stored;
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
