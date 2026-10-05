import type { SlashCommand } from './types.js';

export const webhooksCommand: SlashCommand = {
  name: '/webhooks',
  description: 'Manage webhook subscriptions (list, pause, edit)',
  run: async (ctx) => {
    ctx.openPanel('webhooks');
    return '';
  },
};
