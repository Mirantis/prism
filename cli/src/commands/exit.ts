import type { SlashCommand } from './types.js';

export const exitCommand: SlashCommand = {
  name: '/exit',
  description: 'Shut down the TUI',
  run: async (ctx) => {
    ctx.requestShutdown();
    return 'Shutting down…';
  },
};
