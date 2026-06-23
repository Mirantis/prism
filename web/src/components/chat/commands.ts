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
