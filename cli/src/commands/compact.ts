import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const compactCommand: SlashCommand = {
  name: '/compact',
  description: 'Summarize older history to free up context',
  run: async (ctx) => {
    if (!ctx.threadId) return 'No active conversation to compact.';
    try {
      // 202 — progress and the result arrive as WS `compaction` frames, which
      // App renders (spinner label + completion note), so nothing to say here.
      await ctx.api.compactThread(ctx.threadId);
      return '';
    } catch (err) {
      // Surfaces the runtime's reason, e.g. the 409 "Nothing to compact yet."
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
