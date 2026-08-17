/**
 * Agent-config tools — direct AI SDK tools (no MCP round trip).
 *
 * Update soul / memory / user / heartbeat / settings / vision /
 * bootstrap. Direct Prisma writes + in-process service calls
 * (heartbeatService.startHeartbeat after config changes).
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { heartbeatService } from '../services/heartbeat.service';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import { applyEdits } from '../lib/apply-edit';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { config } from '../config';

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
 * Refusal returned to the model when a workspace-markdown write is attempted
 * while locked-in mode is on.
 */
const LOCKED_IN_REFUSAL =
  'Locked-in mode is on, so your workspace files are read-only and this change was not saved. ' +
  'Tell the user what you would have changed and that they can turn locked-in mode off in their agent settings.';

/**
 * The one emitter for the refused-write event, so a refusal is never
 * double-counted.
 */
function refuseLockedWrite(
  agentId: string,
  field: WorkspaceFileField | 'bootstrapMd',
): { success: false; error: string } {
  trackEvent('agent locked write refused', null, {
    'agent.id': agentId,
    'config.field': field,
  });
  return { success: false, error: LOCKED_IN_REFUSAL };
}

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
  label: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const { newContent, edits, changeDescription } = input;

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
      return { success: false, error: result.error };
    }
    finalContent = result.content;
  }

  await prisma.agentWorkspace.update({ where: { id: agentId }, data: { [field]: finalContent } });
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
        name: z.string().min(1).max(64).describe('The new name for this agent (1–64 chars).'),
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
      description: 'Update your soul (personality, values, boundaries). Supports full replacement (newContent) or targeted edits.',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'soulMd', input, 'Soul'),
    }),

    update_memory: tool({
      description: 'Update your curated memory summary (always in context). Supports full replacement (newContent) or targeted edits.',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'memoryMd', input, 'Memory summary'),
    }),

    update_user_profile: tool({
      description: 'Update the user profile with information learned from conversation. Supports full replacement (newContent) or targeted edits (preferred for small changes).',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'userMd', input, 'User profile'),
    }),

    update_heartbeat_config: tool({
      description: 'Update heartbeat configuration. Supports full replacement (newContent) or targeted edits.',
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => {
        const result = await resolveWorkspaceFileUpdate(agentId, 'heartbeatMd', input, 'Heartbeat config');

        if (result.success) {
          const agent = await prisma.agentWorkspace.findUnique({ where: { id: agentId } });
          if (agent) {
            try {
              heartbeatService.startHeartbeat(agent);
            } catch (err) {
              logger.error({ err }, '[Tool] Failed to restart heartbeat after config change');
            }
          }
        }

        return result;
      },
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
            if (typeof coerced !== 'number' || coerced < 60000) throw new Error('Heartbeat interval must be >= 60000ms');
            updateData.heartbeatIntervalMs = coerced;
            break;
          case 'timezone':
            if (typeof value !== 'string') throw new Error('Timezone must be a string');
            updateData.timezone = value;
            break;
        }

        const updatedAgent = await prisma.agentWorkspace.update({ where: { id: agentId }, data: updateData });

        if (setting === 'heartbeatIntervalMs' && updatedAgent) {
          try {
            heartbeatService.startHeartbeat(updatedAgent);
          } catch (err) {
            logger.error({ err }, '[Tool] Failed to restart heartbeat after interval change');
          }
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
      description: "Update the user's vision document. Supports full replacement (newContent) or targeted edits.",
      inputSchema: workspaceFileInputSchema,
      execute: async (input) => resolveWorkspaceFileUpdate(agentId, 'visionMd', input, 'Vision'),
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
        await prisma.agentWorkspace.update({ where: { id: agentId }, data: { bootstrapMd: '' } });
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
