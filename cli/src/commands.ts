/**
 * Slash command registry for the TUI (barrel).
 *
 * Each command lives in its own file under ./commands/. This module assembles
 * them into the COMMANDS list and re-exports the shared types and helpers, so
 * existing importers (App.tsx, tests) keep importing from './commands.js'.
 *
 * Commands are dispatched locally and never sent to the agent. Each command
 * receives a context with the chat state it needs and returns a short string
 * shown back to the user as a synthetic SYSTEM message in the chat.
 */

import type { SlashCommand } from './commands/types.js';
import { copyCommand } from './commands/copy.js';
import { schedulesCommand } from './commands/schedules.js';
import { configCommand } from './commands/config.js';
import { renameCommand } from './commands/rename.js';
import { modelCommand } from './commands/model.js';
import { heartbeatModelCommand } from './commands/heartbeat-model.js';
import { cronModelCommand } from './commands/cron-model.js';
import { heartbeatCommand } from './commands/heartbeat.js';
import { goalCommand } from './commands/goal.js';
import { skillsCommand } from './commands/skills.js';
import { attachCommand } from './commands/attach.js';
import { detachCommand } from './commands/detach.js';
import { saveCommand } from './commands/save.js';
import { makeHelpCommand } from './commands/help.js';
import { exitCommand } from './commands/exit.js';

export type { PanelId, CommandContext, SlashCommand } from './commands/types.js';
export { ATTACH_COMMAND } from './commands/types.js';
export { parseCommandLine } from './commands/parse.js';
export { parseInterval } from './commands/heartbeat.js';

export const COMMANDS: SlashCommand[] = [
  copyCommand,
  schedulesCommand,
  configCommand,
  renameCommand,
  modelCommand,
  heartbeatModelCommand,
  cronModelCommand,
  heartbeatCommand,
  goalCommand,
  skillsCommand,
  attachCommand,
  detachCommand,
  saveCommand,
  // /help lists the registry. The getter reads COMMANDS lazily (at run() time,
  // after this array is built) so help can live in its own file without a
  // circular import.
  makeHelpCommand(() => COMMANDS),
  exitCommand,
];

export function findExact(name: string): SlashCommand | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function filterByPrefix(prefix: string): SlashCommand[] {
  if (!prefix.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}
