import { ApiError, type Goal } from '../api-client.js';
import type { SlashCommand } from './types.js';

/** Reserved single-word /goal subcommands (everything else is an objective). */
const GOAL_SUBCOMMANDS = new Set(['status', 'list', 'stop', 'clear', 'cancel', 'off', 'pause', 'resume']);

/** Multi-line summary of a goal's current state. */
function formatGoal(g: Goal): string {
  const budget = g.tokenBudget != null ? `${g.tokensUsed}/${g.tokenBudget} tokens` : `${g.tokensUsed} tokens`;
  return [
    `Goal: ${g.objective}`,
    `Status: ${g.status}`,
    `Turns: ${g.turnCount}/${g.maxTurns}`,
    `Tokens: ${budget}`,
    ...(g.lastReason ? [`Last: ${g.lastReason}`] : []),
  ].join('\n');
}

export const goalCommand: SlashCommand = {
  name: '/goal',
  description: 'Set or manage a background goal (/goal <objective> | status | stop | pause | resume | list)',
  run: async (ctx) => {
    // A single reserved word is a management subcommand; anything else (incl.
    // multi-word input that starts with a reserved word) is a new objective.
    const single = ctx.args.length === 1 ? ctx.args[0].toLowerCase() : null;
    const isManagement = ctx.args.length === 0 || (single !== null && GOAL_SUBCOMMANDS.has(single));

    try {
      if (single === 'list') {
        const goals = await ctx.api.listGoals();
        if (goals.length === 0) return 'No goals yet.';
        return goals
          .map((g) => `${g.status === 'active' ? '▶' : '•'} [${g.status}] ${g.objective} (${g.turnCount}/${g.maxTurns} turns)`)
          .join('\n');
      }

      if (isManagement) {
        if (!ctx.threadId) return 'No active conversation yet.';
        const current = await ctx.api.getThreadGoal(ctx.threadId);

        // Status (no args or `status`).
        if (single === null || single === 'status') {
          return current ? formatGoal(current) : 'No active goal in this conversation.';
        }

        if (!current) return 'No active goal in this conversation.';
        if (single === 'pause') {
          const g = await ctx.api.pauseGoal(current.id);
          return `Goal paused: "${g.objective}".`;
        }
        if (single === 'resume') {
          const g = await ctx.api.resumeGoal(current.id);
          return `Goal resumed: "${g.objective}".`;
        }
        // stop / clear / cancel / off
        const g = await ctx.api.stopGoal(current.id);
        return `Goal stopped: "${g.objective}".`;
      }

      // Otherwise: start a new goal with the full argument as the objective.
      if (!ctx.threadId) return 'Start a conversation before setting a goal.';
      const goal = await ctx.api.createGoal({ threadId: ctx.threadId, objective: ctx.rawArgs });
      return `Goal set: "${goal.objective}". I'll keep working on it across up to ${goal.maxTurns} turns until it's done.`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
