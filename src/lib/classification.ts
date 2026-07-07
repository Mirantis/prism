/**
 * Classification-gate model factory.
 *
 * Goes through the unified `createProvider()`, so it inherits whatever vendor
 * and routing (direct or Nexus) the runtime is configured for. The classifier
 * uses a fast model (`classificationModelId`) supported on either provider.
 *
 * Kept in its own module (rather than in `create-provider.ts`) so the provider
 * factories never transitively import `create-provider`, keeping that a leaf
 * factory with no import cycle.
 */

import { config } from '../config';
import { createProvider } from './create-provider';

export function getClassificationModel() {
  return createProvider()(config.classificationModelId);
}
