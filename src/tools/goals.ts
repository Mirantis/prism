/**
 * Goal tools — direct AI SDK tools (no MCP round trip).
 *
 * The natural-language entry point to goals: the model calls `create_goal` when
 * the user explicitly asks for durable, autonomous, multi-turn work. State and
 * the background loop are owned by goalService; these tools are a thin,
 * pre-bound (userId/agentId/thread/channel) surface over it.
 *
 * Chat-only by design (see filterToolsByMode in invoke.ts): goal turns and
 * autonomous runs must not create or nest goals.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { goalService } from '../services/goal.service';
import { GOAL_MAX_OBJECTIVE_CHARS } from '../constants';
import { logger } from '../logger';

export function getGoalTools(
  userId: string,
  agentId: string,
  threadId: string | undefined,
  originChannel: 'slack' | 'websocket' | 'teams',
  originChannelId: string | undefined,
): Record<string, Tool> {
  return {
    create_goal: tool({
      description:
        'Start a durable GOAL: an objective you will pursue autonomously across many turns, ' +
        'unattended, until it is achieved or stopped. Create a goal ONLY when the user explicitly ' +
        'asks for ongoing, multi-turn, self-driven work toward an objective (e.g. "keep working ' +
        'until the tests pass", "make this a goal", "keep going until X"). Do NOT create a goal for ' +
        'an ordinary one-off task you can just do now. Only one active goal per conversation — ' +
        'creating a new one replaces the existing one.',
      inputSchema: z.object({
        objective: z
          .string()
          .min(1)
          .max(GOAL_MAX_OBJECTIVE_CHARS)
          .describe('The completion condition / objective to pursue, in plain language.'),
        tokenBudget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional cap on total tokens to spend on this goal before it stops.'),
      }),
      execute: async ({ objective, tokenBudget }) => {
        if (!threadId) {
          return { success: false, error: 'Goals require an active conversation thread.' };
        }
        try {
          const goal = await goalService.startGoal({
            userId,
            agentId,
            threadId,
            objective,
            tokenBudget: tokenBudget ?? null,
            originChannel,
            originChannelId,
          });
          return {
            success: true,
            goalId: goal.id,
            maxTurns: goal.maxTurns,
            message:
              `Started goal: "${goal.objective}". I'll keep working toward this on my own across ` +
              `multiple turns (up to ${goal.maxTurns}) until it's done.`,
          };
        } catch (err) {
          logger.error({ err }, '[GoalTool] Failed to start goal');
          return { success: false, error: err instanceof Error ? err.message : 'Failed to start goal' };
        }
      },
    }),

    get_goal: tool({
      description:
        'Get the current active goal for this conversation (objective, status, turns used, ' +
        'token spend). Returns nothing active if there is no goal running.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!threadId) return { success: true, active: false };
        const goal = await goalService.getGoalForThread(threadId);
        if (!goal) return { success: true, active: false };
        return {
          success: true,
          active: true,
          goalId: goal.id,
          objective: goal.objective,
          status: goal.status,
          turnCount: goal.turnCount,
          maxTurns: goal.maxTurns,
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget ?? null,
          lastReason: goal.lastReason ?? null,
        };
      },
    }),
  };
}
