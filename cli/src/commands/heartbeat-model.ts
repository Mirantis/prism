import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const heartbeatModelCommand: SlashCommand = {
  name: '/heartbeat-model',
  description: 'Set the heartbeat model (id or "reset" to use the main model)',
  run: async (ctx) => {
    const arg = ctx.args[0];
    if (!arg) return 'Usage: /heartbeat-model <model-id|reset>.';
    try {
      const result =
        arg === 'reset'
          ? await ctx.api.setHeartbeatModel(null)
          : await ctx.api.setHeartbeatModel(arg);
      return result.model
        ? `Heartbeat model set to "${result.model}".`
        : `Heartbeat model reset — heartbeats use the main model ("${result.effective}").`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
