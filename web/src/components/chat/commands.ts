/**
 * Slash-command registry for the web chat — mirrors the TUI's `cli/src/commands.ts`.
 *
 * Commands are parsed and dispatched client-side; they never go to the agent as
 * chat text (matches the repo convention: the UI parses the command and calls a
 * runtime REST endpoint). Each command's `run` returns a short string shown back
 * to the user as a synthetic SYSTEM message, or '' to show nothing.
 */

import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@/api/errors';
import type { Goal } from '@/types';

/** Reserved single-word /goal subcommands (everything else is an objective). */
const GOAL_SUBCOMMANDS = new Set(['status', 'list', 'stop', 'clear', 'cancel', 'off', 'pause', 'resume']);

/** Multi-line summary of a goal's current state (mirrors the CLI). */
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

export interface CommandContext {
  /** Whitespace-split arguments after the command word (empty if none). */
  args: string[];
  /** Everything after the command word, trimmed (preserves inner spaces). */
  rawArgs: string;
  /** The thread currently being viewed (undefined before the first turn). */
  threadId?: string;
}

export interface SlashCommand {
  /** Including the leading '/' (e.g. '/skills'). */
  name: string;
  description: string;
  run: (ctx: CommandContext) => Promise<string>;
}

/**
 * Split a trimmed input line into its command word and arguments. `headWord` is
 * the first whitespace-delimited token (e.g. '/skills'); `rawArgs` is everything
 * after it, trimmed (inner spaces survive); `args` is `rawArgs` split on runs of
 * whitespace, or [] when there are none.
 */
export function parseCommandLine(trimmed: string): {
  headWord: string;
  args: string[];
  rawArgs: string;
} {
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { headWord: trimmed, args: [], rawArgs: '' };
  }
  const headWord = trimmed.slice(0, firstSpace);
  const rawArgs = trimmed.slice(firstSpace + 1).trim();
  const args = rawArgs.length === 0 ? [] : rawArgs.split(/\s+/);
  return { headWord, args, rawArgs };
}

export const COMMANDS: SlashCommand[] = [
  {
    name: '/skills',
    description: 'List available skills, or run one (/skills [list] | /skills run <name>)',
    run: async (ctx) => {
      const sub = ctx.args[0];
      try {
        if (!sub || sub === 'list') {
          // Pass the active thread so the runtime includes any workspace skills
          // (web threads have no workspaceRoot, so this returns global skills).
          const skills = await runtimeApi.listSkills(ctx.threadId);
          if (skills.length === 0) {
            return 'No skills available. Drop SKILL.md bundles into the agent’s skills directory.';
          }
          return [
            'Available skills:',
            ...skills.map(
              (s) => `  ${s.name} — ${s.description}${s.source === 'workspace' ? ' (workspace)' : ''}`,
            ),
          ].join('\n');
        }
        if (sub === 'run') {
          const name = ctx.args[1];
          if (!name) return 'Usage: /skills run <name>.';
          const result = await runtimeApi.runSkill(name, ctx.threadId);
          return `▶ Running skill "${result.skill}"…`;
        }
        return 'Usage: /skills [list] | /skills run <name>.';
      } catch (err) {
        if (err instanceof ApiError) return err.message;
        throw err;
      }
    },
  },
  {
    name: '/goal',
    description: 'Set or manage a background goal (/goal <objective> | status | stop | pause | resume | list)',
    run: async (ctx) => {
      // A single reserved word is a management subcommand; anything else (incl.
      // multi-word input that starts with a reserved word) is a new objective.
      const single = ctx.args.length === 1 ? ctx.args[0].toLowerCase() : null;
      const isManagement = ctx.args.length === 0 || (single !== null && GOAL_SUBCOMMANDS.has(single));

      try {
        if (single === 'list') {
          const goals = await runtimeApi.listGoals();
          if (goals.length === 0) return 'No goals yet.';
          return goals
            .map((g) => `${g.status === 'active' ? '▶' : '•'} [${g.status}] ${g.objective} (${g.turnCount}/${g.maxTurns} turns)`)
            .join('\n');
        }

        if (isManagement) {
          if (!ctx.threadId) return 'No active conversation yet.';
          const current = await runtimeApi.getThreadGoal(ctx.threadId);

          // Status (no args or `status`).
          if (single === null || single === 'status') {
            return current ? formatGoal(current) : 'No active goal in this conversation.';
          }

          if (!current) return 'No active goal in this conversation.';
          if (single === 'pause') {
            const g = await runtimeApi.pauseGoal(current.id);
            return `Goal paused: "${g.objective}".`;
          }
          if (single === 'resume') {
            const g = await runtimeApi.resumeGoal(current.id);
            return `Goal resumed: "${g.objective}".`;
          }
          // stop / clear / cancel / off
          const g = await runtimeApi.stopGoal(current.id);
          return `Goal stopped: "${g.objective}".`;
        }

        // Otherwise: start a new goal with the full argument as the objective.
        if (!ctx.threadId) return 'Start a conversation before setting a goal.';
        const goal = await runtimeApi.createGoal({ threadId: ctx.threadId, objective: ctx.rawArgs });
        return `Goal set: "${goal.objective}". I'll keep working on it across up to ${goal.maxTurns} turns until it's done.`;
      } catch (err) {
        if (err instanceof ApiError) return err.message;
        throw err;
      }
    },
  },
  {
    name: '/help',
    description: 'List all commands',
    run: async () => COMMANDS.map((c) => `${c.name} — ${c.description}`).join('\n'),
  },
];

export function findExact(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function filterByPrefix(prefix: string): SlashCommand[] {
  if (!prefix.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

/**
 * Whether the input is in "slash mode" — a leading '/' with no space yet, so we
 * show the command popup. Once a space is typed the popup hides (the user is
 * typing arguments). Mirrors the TUI's `slashMode`.
 */
export function isSlashMode(value: string): boolean {
  return value.startsWith('/') && !value.includes(' ');
}
