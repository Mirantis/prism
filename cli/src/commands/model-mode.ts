import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const modelModeCommand: SlashCommand = {
  name: '/model-mode',
  description: 'Choose the model per turn ("auto") or use the set models ("fixed")',
  run: async (ctx) => {
    const arg = ctx.args[0];
    if (arg !== 'auto' && arg !== 'fixed') return 'Usage: /model-mode <auto|fixed>.';
    try {
      const { tiers } = await ctx.api.setModelMode(arg);
      if (arg === 'fixed') return 'Model mode set to fixed.';
      const set = (['small', 'medium', 'large'] as const)
        .filter((tier) => tiers[tier].effective)
        .map((tier) => `${tier} ${tiers[tier].effective}`);
      return `Model mode set to auto: ${set.join(', ')}.`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
