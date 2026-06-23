import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const cronModelCommand: SlashCommand = {
  name: '/cron-model',
  description: 'Set the scheduled-task model (id or "reset" to use the main model)',
  run: async (ctx) => {
    const arg = ctx.args[0];
    if (!arg) return 'Usage: /cron-model <model-id|reset>.';
    try {
      const result =
        arg === 'reset' ? await ctx.api.setCronModel(null) : await ctx.api.setCronModel(arg);
      return result.model
        ? `Scheduled-task model set to "${result.model}".`
        : `Scheduled-task model reset — scheduled tasks use the main model ("${result.effective}").`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
