import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const modelCommand: SlashCommand = {
  name: '/model',
  description: 'Set the agent model (id or "reset")',
  run: async (ctx) => {
    const arg = ctx.args[0];
    if (!arg) return 'Usage: /model <model-id|reset>.';
    try {
      const result =
        arg === 'reset'
          ? await ctx.api.setModel(null)
          : await ctx.api.setModel(arg);
      return result.model
        ? `Model set to "${result.model}".`
        : 'Model reset to the server default.';
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
