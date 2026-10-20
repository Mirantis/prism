import { ApiError, type ModelSelectionInfo } from '../api-client.js';
import type { SlashCommand } from './types.js';

/** The tiers in force, as `small <id>, large <id>`. */
function describeTiers({ tiers }: ModelSelectionInfo): string {
  return (['small', 'medium', 'large'] as const)
    .filter((tier) => tiers[tier].effective)
    .map((tier) => `${tier} ${tiers[tier].effective}`)
    .join(', ');
}

export const modelModeCommand: SlashCommand = {
  name: '/model-mode',
  description: 'Show or switch Auto and Fixed model selection (auto|fixed)',
  run: async (ctx) => {
    const arg = ctx.args[0];
    if (arg !== undefined && arg !== 'auto' && arg !== 'fixed') return 'Usage: /model-mode [auto|fixed].';
    try {
      if (arg === undefined) {
        const selection = await ctx.api.getModelSelection();
        if (selection.mode.effective === 'fixed') return 'Model mode is fixed.';
        return `Model mode is auto: ${describeTiers(selection)}.`;
      }
      const selection = await ctx.api.setModelMode(arg);
      if (arg === 'fixed') return 'Model mode set to fixed.';
      return `Model mode set to auto: ${describeTiers(selection)}.`;
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
