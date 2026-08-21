/**
 * Memory tools — direct AI SDK tools (no MCP round trip).
 *
 * Factory closes over (userId, agentId) so the tool surface is
 * pre-bound when handed to invoke().
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import {
  memoryManagerService,
  MemoryWriteInput,
} from '../services/memory-manager.service';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import { refuseLockedWrite } from '../lib/locked-in';

export function getMemoryTools(
  userId: string,
  agentId: string,
): Record<string, Tool> {
  return {
    memory_search: tool({
      description: 'Search your memory for relevant information.',
      inputSchema: z.object({
        query: z.string().describe('What to search for in memory'),
        categories: z.array(z.string()).optional().describe('Filter by categories'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default: 25)'),
        daysBack: z.number().int().min(1).max(3650).optional().describe('How many days back to search (default: 365)'),
      }),
      execute: async ({ query, categories, limit, daysBack }) => {
        const results = await memoryManagerService.search(userId, query, {
          categories,
          limit: limit ?? 25,
          daysBack: daysBack ?? 365,
          agentId,
        });
        return { success: true, count: results.length, results };
      },
    }),

    memory_write: tool({
      description: 'Store important information to your memory.',
      inputSchema: z.object({
        content: z.string().describe('What to remember'),
        category: z.enum(['observation', 'action', 'decision', 'event']).describe('Category of information'),
        importance: z.number().optional().describe('Importance score 1-10 (default: 5)'),
      }),
      execute: async ({ content, category, importance }) => {
        // Locked-in mode freezes long-term memory too. Read live, so the lock
        // holds when it is switched on mid-turn.
        if (await agentWorkspaceService.isLockedIn()) {
          return refuseLockedWrite(agentId, 'memoryEntry');
        }
        const entry = await memoryManagerService.write(
          userId,
          { content, category, importance } as MemoryWriteInput,
          { agentId },
        );
        return { success: true, entryId: entry.id, category, importance: importance ?? 5 };
      },
    }),

    memory_delete: tool({
      description: 'Delete memory entries that are no longer relevant.',
      inputSchema: z.object({
        entryIds: z.array(z.string()).describe('IDs of memory entries to delete'),
        reason: z.string().optional().describe('Brief reason for deletion'),
      }),
      execute: async ({ entryIds, reason }) => {
        if (await agentWorkspaceService.isLockedIn()) {
          return refuseLockedWrite(agentId, 'memoryEntry');
        }
        const deletedCount = await memoryManagerService.deleteMany(userId, entryIds, { agentId });
        return { success: true, deletedCount, reason };
      },
    }),
  };
}
