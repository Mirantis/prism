/**
 * Agent-config tools — direct AI SDK tools (no MCP round trip).
 *
 * Update soul / memory / user / heartbeat / settings / vision /
 * bootstrap. A document write goes through
 * `agentWorkspaceService.writeWorkspaceDoc`, which records the revision; the
 * settings write is a direct Prisma write, and it calls
 * `heartbeatService.startHeartbeat` after an interval change.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { heartbeatService } from '../services/heartbeat.service';
import { cronSchedulerService } from '../services/cron-scheduler.service';
import { isTimezone } from '../lib/timezone';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import { applyEdits } from '../lib/apply-edit';
import { refuseLockedWrite } from '../lib/locked-in';
import { WORKSPACE_DOC_LABELS } from '../lib/workspace-docs';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { config } from '../config';
import { MAX_HEARTBEAT_INTERVAL_MS, MIN_HEARTBEAT_INTERVAL_MS } from '../constants';

/** Shared input schema for workspace-file update tools (dual-mode: full replace or targeted edits). */
const workspaceFileInputSchema = z.object({
  newContent: z.string().optional().describe(
    'Complete replacement content. Use for major restructuring or initial setup.'
  ),
  edits: z.array(z.object({
    oldText: z.string().describe('Exact text to find in current content'),
    newText: z.string().describe('Text to replace it with'),
  })).min(1).optional().describe(
    'Targeted find-and-replace edits. Preferred for small changes — only specify what changed.'
  ),
  changeDescription: z.string().describe('Brief description of what changed'),
});

type WorkspaceFileInput = z.infer<typeof workspaceFileInputSchema>;

/** DB field names for workspace markdown files. */
type WorkspaceFileField = 'soulMd' | 'memoryMd' | 'userMd' | 'heartbeatMd' | 'visionMd';

/**
 * Resolve the final content for a workspace-file update, then persist it.
 *
 * - If `newContent` is provided: use it directly (full replace).
 * - If `edits` is provided: fetch current content, apply edits sequentially.
 * - Returns a plain object — AI SDK serializes to JSON for the LLM.
 */
async function resolveWorkspaceFileUpdate(
  agentId: string,
  field: WorkspaceFileField,
  input: WorkspaceFileInput,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const { newContent, edits, changeDescription } = input;
  const label = WORKSPACE_DOC_LABELS[field];

  // Every markdown-writing tool funnels through here, so one live read of the
  // lock covers all of them in every invocation mode. This check enforces the
  // lock, including when it is switched on mid-turn.
  if (await agentWorkspaceService.isLockedIn()) {
    return refuseLockedWrite(agentId, field);
  }

  if (newContent !== undefined && edits !== undefined) {
    return { success: false, error: 'Provide either newContent or edits, not both.' };
  }
  if (newContent === undefined && edits === undefined) {
    return { success: false, error: 'Provide either newContent (full replace) or edits (targeted changes).' };
  }

  let finalContent: string;

  if (newContent !== undefined) {
    finalContent = newContent;
  } else {
    const agent = await prisma.agentWorkspace.findUnique({ where: { id: agentId } });
    if (!agent) {
      return { success: false, error: `Agent ${agentId} not found` };
    }
    const currentContent = agent[field] ?? '';
    const result = applyEdits(currentContent, edits!);
    if (!result.success) {
      // Name the document, so a model that copied `oldText` from another
      // workspace file can see which one it searched.
      return { success: false, error: `${label}: ${result.error}` };
    }
    finalContent = result.content;
  }

  await agentWorkspaceService.writeWorkspaceDoc({
    agentId,
    field,
    content: finalContent,
    actor: 'agent',
    method: newContent !== undefined ? 'replace' : 'edit',
    reason: changeDescription,
  });
  trackEvent('agent config updated', null, {
    'agent.id': agentId,
    'config.field': field,
    'config.method': newContent !== undefined ? 'replace' : 'edit',
  });
  return { success: true, message: `${label} updated: ${changeDescription}` };
}

export function getAgentConfigTools(): Record<string, Tool> {
  if (!config.agentId) throw new Error('AGENT_ID not configured');
  const agentId = config.agentId;
  return {
    rename_self: tool({
      description:
        "Rename this agent. Use only when the user explicitly asks you to change your name. The new name is persisted and picked up on the next chat turn.",
      inputSchema: z.object({
        // No length or character limit here: `renameAgent` answers a name
        // outside the rule with the rule itself, which the agent can act on.
        name: z.string().min(1).describe("The new name for this agent: 1–64 characters, only letters, digits, spaces and - ' . &."),
      }),
      execute: async ({ name }) => {
        try {
          // 'agent renamed' telemetry is emitted by renameAgent itself, so the
          // management PATCH /agents/name endpoint is covered by the same event.
          const updated = await agentWorkspaceService.renameAgent(name);
          return {
            success: true,
            message: `Renamed agent to "${updated.name}".`,
            newName: updated.name,
          };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`[Tool/rename_self] Failed to rename agent ${agentId}: ${msg}`);
          return { success: false, error: msg };
        }
      },
    }),

    update_soul: tool({
      description: 'Update your soul (personality, values, boundaries).',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'soulMd', input),
    }),

    update_memory: tool({
      description: 'Update your curated memory summary (always in context). Critical facts go here.',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'memoryMd', input),
    }),

    update_user_profile: tool({
      description: 'Update the user profile with information learned from conversation.',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'userMd', input),
    }),

    update_heartbeat_config: tool({
      description: 'Update heartbeat configuration.',
      inputSchema: workspaceFileInputSchema,
      // The schedule stays as it is. Every cycle loads the checks fresh, so the
      // timer reads no part of this document.
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'heartbeatMd', input),
    }),

    update_settings: tool({
      description: 'Update agent behavioral settings (timezone, heartbeatIntervalMs, verbose). verbose controls chat delivery: false (default) delivers only the final message; true streams every intermediate step.',
      inputSchema: z.object({
        setting: z.enum(['heartbeatIntervalMs', 'timezone', 'verbose']).describe('Which setting'),
        value: z.union([z.number(), z.string(), z.boolean()]).describe('The new value'),
      }),
      execute: async ({ setting, value }) => {
        if (setting === 'verbose') {
          let boolVal: boolean;
          if (typeof value === 'boolean') {
            boolVal = value;
          } else if (value === 'true') {
            boolVal = true;
          } else if (value === 'false') {
            boolVal = false;
          } else {
            throw new Error('verbose must be a boolean or "true"/"false"');
          }
          const result = await agentWorkspaceService.updateVerbose(boolVal);
          return { success: true, message: `Updated verbose to ${result}` };
        }

        const numericSettings = ['heartbeatIntervalMs'] as const;
        const settingLabels: Record<string, string> = {
          heartbeatIntervalMs: 'Heartbeat interval',
        };
        let coerced: unknown = value;
        if ((numericSettings as readonly string[]).includes(setting)) {
          if (typeof value === 'string') {
            coerced = Number(value);
          }
          if (
            typeof coerced !== 'number' ||
            !Number.isFinite(coerced) ||
            !Number.isInteger(coerced)
          ) {
            throw new Error(`${settingLabels[setting]} must be a finite integer`);
          }
        }

        const updateData: Record<string, unknown> = {};

        switch (setting) {
          case 'heartbeatIntervalMs':
            if (typeof coerced !== 'number' || coerced < MIN_HEARTBEAT_INTERVAL_MS) {
              throw new Error(`Heartbeat interval must be >= ${MIN_HEARTBEAT_INTERVAL_MS}ms`);
            }
            if (coerced > MAX_HEARTBEAT_INTERVAL_MS) {
              throw new Error(`Heartbeat interval must be <= ${MAX_HEARTBEAT_INTERVAL_MS}ms (1 week)`);
            }
            updateData.heartbeatIntervalMs = coerced;
            break;
          case 'timezone':
            if (typeof value !== 'string' || !isTimezone(value)) {
              throw new Error('Timezone must be an IANA zone name such as Europe/Helsinki');
            }
            updateData.timezone = value;
            break;
        }

        const updatedAgent = await prisma.agentWorkspace.update({ where: { id: agentId }, data: updateData });

        if (setting === 'heartbeatIntervalMs' && updatedAgent) {
          try {
            // A new cadence starts now: the next check is one new interval away.
            heartbeatService.startHeartbeat(updatedAgent, 'new-interval');
          } catch (err) {
            logger.error({ err }, '[Tool] Failed to restart heartbeat after interval change');
          }
        }

        if (setting === 'timezone') {
          // Recurring tasks read their schedules in the new zone from now on.
          cronSchedulerService.useTimezone(updatedAgent.timezone);
        }

        trackEvent('agent config updated', null, {
          'agent.id': agentId,
          'config.field': setting,
          'config.method': 'set',
        });

        return { success: true, message: `Updated ${setting} to ${coerced}` };
      },
    }),

    update_vision: tool({
      description: "Update the user's vision document.",
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'visionMd', input),
    }),

    clear_bootstrap: tool({
      description: 'Clear the bootstrap instructions after onboarding is complete.',
      inputSchema: z.object({
        confirmationMessage: z.string().describe('A brief message acknowledging the end of bootstrap'),
      }),
      execute: async ({ confirmationMessage }) => {
        // Writes bootstrapMd, so it is part of the locked set. Guarded here
        // because it clears the field with a direct write instead of going
        // through resolveWorkspaceFileUpdate.
        if (await agentWorkspaceService.isLockedIn()) {
          return refuseLockedWrite(agentId, 'bootstrapMd');
        }
        await agentWorkspaceService.writeWorkspaceDoc({
          agentId,
          field: 'bootstrapMd',
          content: '',
          actor: 'agent',
          method: 'clear',
          reason: confirmationMessage,
        });
        trackEvent('agent config updated', null, {
          'agent.id': agentId,
          'config.field': 'bootstrapMd',
          'config.method': 'clear',
        });
        return { success: true, message: 'Bootstrap phase complete.', confirmationMessage };
      },
    }),
  };
}
