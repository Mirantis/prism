/**
 * Classification-gate model factory.
 *
 * Routes through Nexus when NEXUS_API_URL is configured, otherwise falls
 * back to direct Bedrock — the gate's classification model (default
 * Haiku) is supported either way; Nexus is only needed for usage/audit
 * tracking.
 *
 * Lives in its own module so `nexus-provider.ts` doesn't need to import
 * `create-provider.ts` (which would create a cycle:
 * create-provider → nexus-provider → create-provider).
 */

import { config } from '../config';
import { createProvider } from './create-provider';

export function getClassificationModel() {
  return createProvider()(config.classificationModelId);
}
