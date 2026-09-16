import type { SlashCommand } from './types.js';

/**
 * Build the /help command. Takes a getter for the full command list (rather
 * than importing the registry) so it can list its siblings without a circular
 * import — the getter is read lazily at run() time, after the list is built.
 */
export function makeHelpCommand(getCommands: () => SlashCommand[]): SlashCommand {
  return {
    name: '/help',
    description: 'List all commands',
    run: async (ctx) => (ctx.availableCommands ?? getCommands()).map((c) => `${c.name} — ${c.description}`).join('\n'),
  };
}
