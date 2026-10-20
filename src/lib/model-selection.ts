/**
 * The model selection an agent runs under: Fixed or Auto, and the three Auto
 * tiers, with the deployment defaults (`config.modelSelection`) applied.
 */

import { AgentModelMode, type AgentWorkspace } from '@prisma/client';
import { config } from '../config';

/** A tier of Auto model selection, smallest first. */
export type ModelTier = 'small' | 'medium' | 'large';
export const MODEL_TIERS: readonly ModelTier[] = ['small', 'medium', 'large'];

/** The model selection a turn runs under, after the deployment defaults. */
export interface ModelSelection {
  mode: 'fixed' | 'auto';
  tiers: Record<ModelTier, string | null>;
}

export type StoredModelSelection = Pick<AgentWorkspace, 'modelMode' | 'smallModel' | 'mediumModel' | 'largeModel'>;

/**
 * Merge an agent's stored model selection with the deployment defaults
 * (`config.modelSelection`). The one place a null column meets its env
 * fallback, as `resolveEffectiveModel` is for the fixed model.
 */
export function resolveModelSelection(stored: StoredModelSelection): ModelSelection {
  const mode = stored.modelMode
    ? stored.modelMode === AgentModelMode.AUTO ? 'auto' : 'fixed'
    : config.modelSelection.mode;
  return {
    mode,
    tiers: {
      small: stored.smallModel ?? config.modelSelection.tiers.small,
      medium: stored.mediumModel ?? config.modelSelection.tiers.medium,
      large: stored.largeModel ?? config.modelSelection.tiers.large,
    },
  };
}

/** The tiers Auto needs and lacks: small and large are required, medium is optional. */
export function missingAutoTiers(tiers: ModelSelection['tiers']): ModelTier[] {
  return (['small', 'large'] as const).filter((tier) => !tiers[tier]);
}
