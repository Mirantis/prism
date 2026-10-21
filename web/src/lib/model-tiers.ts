import type { ModelTier } from '@/types';

/** The Auto tiers in order, with what each is for and whether Auto needs it. */
export const TIER_ROWS: { tier: ModelTier; label: string; description: string; required: boolean }[] = [
  { tier: 'small', label: 'Small', description: 'Quick answers, lookups and simple changes.', required: true },
  { tier: 'medium', label: 'Medium', description: 'Moderate work on one topic. Leave empty to use small and large only.', required: false },
  { tier: 'large', label: 'Large', description: 'Multi-step work, code, planning, and anything unclear.', required: true },
];
