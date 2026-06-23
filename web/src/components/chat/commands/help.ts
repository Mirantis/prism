import type { SlashCommand } from './types';

/**
 * `/help` lists the registry. It reads COMMANDS lazily (via the getter, at
 * run() time — after the array is built) so help can live in its own file
 * without a circular import on the barrel.
 */
export function makeHelpCommand(getCommands: () => SlashCommand[]): SlashCommand {
  return {
    name: '/help',
    description: 'List all commands',
    run: async () => getCommands().map((c) => `${c.name} — ${c.description}`).join('\n'),
  };
}
