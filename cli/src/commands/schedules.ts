import type { SlashCommand } from './types.js';

export const schedulesCommand: SlashCommand = {
  name: '/schedules',
  description: 'Manage scheduled cron tasks (list, create, delete)',
  run: async (ctx) => {
    ctx.openPanel('schedules');
    return '';
  },
};
