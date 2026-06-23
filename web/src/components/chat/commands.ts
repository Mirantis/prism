/**
 * Slash-command registry for the web chat (barrel) — mirrors the TUI's
 * `cli/src/commands.ts`.
 *
 * Each command lives in its own file under ./commands/. This module assembles
 * them into the COMMANDS list and re-exports the shared types and parsing
 * helpers, so existing importers (ChatInput, AgentChat, CommandPopup, tests)
 * keep importing from './commands'.
 *
 * Commands are parsed and dispatched client-side; they never go to the agent as
 * chat text (the UI parses the command and calls a runtime REST endpoint). Each
 * command's `run` returns a short string shown back to the user as a synthetic
 * SYSTEM message, or '' to show nothing.
 */

import type { SlashCommand } from './commands/types';
import { skillsCommand } from './commands/skills';
import { goalCommand } from './commands/goal';
import { makeHelpCommand } from './commands/help';

export type { CommandContext, SlashCommand } from './commands/types';
export { parseCommandLine, isSlashMode } from './commands/parse';

export const COMMANDS: SlashCommand[] = [
  skillsCommand,
  goalCommand,
  makeHelpCommand(() => COMMANDS),
];

export function findExact(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function filterByPrefix(prefix: string): SlashCommand[] {
  if (!prefix.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}
