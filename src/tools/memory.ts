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
import { trackEvent } from '../lib/telemetry';

const BOUND_FORMAT =
  'Give a UTC date (2026-10-06, the whole day) or a date-time with an offset (2026-10-06T14:30:00Z).';

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

/**
 * One bound of the search window. A bare date covers that whole day in UTC, the zone the
 * agent's prompt gives the date in, so a `since` and an `until` of one date search that day.
 */
function parseBound(bound: 'since' | 'until', value: string): Date | null {
  if (isoDate.safeParse(value).success) {
    return new Date(`${value}T${bound === 'since' ? '00:00:00.000' : '23:59:59.999'}Z`);
  }
  return isoDateTime.safeParse(value).success ? new Date(value) : null;
}

function parseWindow(
  input: { since?: string; until?: string },
): { since?: Date; until?: Date } | { error: string } {
  const window: { since?: Date; until?: Date } = {};
  for (const bound of ['since', 'until'] as const) {
    const value = input[bound];
    if (value === undefined) continue;
    const date = parseBound(bound, value);
    if (!date) return { error: `${bound} is not a date or a date-time: "${value}". ${BOUND_FORMAT}` };
    window[bound] = date;
  }
  if (window.since && window.until && window.since > window.until) {
    return { error: `since (${input.since}) is after until (${input.until}).` };
  }
  return window;
}

export function getMemoryTools(
  userId: string,
  agentId: string,
): Record<string, Tool> {
  return {
    memory_search: tool({
      description:
        'Search your memory for relevant information. Without a query, lists the most recent entries.',
      inputSchema: z.object({
        query: z.string().optional().describe('What to search for in memory, by meaning'),
        categories: z.array(z.string()).optional().describe('Filter by categories'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default: 25)'),
        since: z
          .string()
          .optional()
          .describe(`Only entries recorded at or after this time. ${BOUND_FORMAT}`),
        until: z
          .string()
          .optional()
          .describe(`Only entries recorded at or before this time. ${BOUND_FORMAT}`),
        sort: z
          .enum(['relevance', 'newest'])
          .optional()
          .describe('relevance (default) puts the closest matches first, newest the most recent'),
      }),
      execute: async ({ query, categories, limit, since, until, sort }) => {
        const searched = {
          'agent.id': agentId,
          'memory.search.has_query': String(Boolean(query?.trim())),
          'memory.search.has_window': String(since !== undefined || until !== undefined),
          'memory.search.sort': sort ?? 'relevance',
        };
        const window = parseWindow({ since, until });
        if ('error' in window) {
          trackEvent('memory searched', userId, {
            ...searched,
            'memory.search.status': 'invalid_window',
          });
          return { success: false, error: window.error };
        }
        const results = await memoryManagerService.search(userId, query, {
          categories,
          limit: limit ?? 25,
          since: window.since,
          until: window.until,
          sort,
          agentId,
        });
        trackEvent('memory searched', userId, {
          ...searched,
          'memory.search.status': 'ok',
          'memory.search.result_count': String(results.length),
        });
        return { success: true, count: results.length, results };
      },
    }),

    memory_write: tool({
      description:
        'Store important information to your memory. User preferences go here, with the ' +
        'category observation.',
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
