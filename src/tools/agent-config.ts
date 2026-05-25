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
import { logger } from '../logger';

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
  label: string,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const { newContent, edits, changeDescription } = input;

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
  return { success: true, message: `${label} updated: ${changeDescription}` };
}

export function getAgentConfigTools(agentId: string): Record<string, Tool> {
  return {
    rename_self: tool({
      description:
        "Rename this agent. Use only when the user explicitly asks you to change your name. The new name is persisted and picked up on the next chat turn.",
      inputSchema: z.object({
        name: z.string().min(1).max(64).describe('The new name for this agent (1–64 chars).'),
      }),
      execute: async ({ name }) => {
        try {
          const updated = await agentWorkspaceService.renameAgent(agentId, name);
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
      description: 'Update agent behavioral settings (proactivity, verbosity, timezone, heartbeatIntervalMs).',
      inputSchema: z.object({
        setting: z.enum(['proactivity', 'verbosity', 'heartbeatIntervalMs', 'timezone']).describe('Which setting'),
        value: z.union([z.number(), z.string()]).describe('The new value'),
      }),
      execute: async ({ setting, value }) => {
        const numericSettings = ['proactivity', 'verbosity', 'heartbeatIntervalMs'] as const;
        const settingLabels: Record<string, string> = {
          proactivity: 'Proactivity',
          verbosity: 'Verbosity',
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
          case 'proactivity':
            if (typeof coerced !== 'number' || coerced < 1 || coerced > 5) throw new Error('Proactivity must be 1-5');
            updateData.proactivity = coerced;
            break;
          case 'verbosity':
            if (typeof coerced !== 'number' || coerced < 1 || coerced > 5) throw new Error('Verbosity must be 1-5');
            updateData.verbosity = coerced;
            break;
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
        await prisma.agentWorkspace.update({ where: { id: agentId }, data: { bootstrapMd: '' } });
        return { success: true, message: 'Bootstrap phase complete.', confirmationMessage };
      },
    }),
  };
}
