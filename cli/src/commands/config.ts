import type { SlashCommand } from './types.js';

export const configCommand: SlashCommand = {
  name: '/config',
  description: 'View agent identity and config files',
  run: async (ctx) => {
    ctx.openPanel('config');
    return '';
  },
};
