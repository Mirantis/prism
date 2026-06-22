import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const renameCommand: SlashCommand = {
  name: '/rename',
  description: 'Rename the agent (1-64 chars)',
  run: async (ctx) => {
    const name = ctx.rawArgs;
    if (name.length === 0) return 'Usage: /rename <new name> (1-64 chars).';
    if (name.length > 64) return 'Name too long — keep it to 64 characters or fewer.';
    try {
      const result = await ctx.api.setName(name);
      return `Renamed to "${result.name}".`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
