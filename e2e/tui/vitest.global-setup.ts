/**
 * Exported as the named `setup` (one of Vitest's supported globalSetup shapes)
 * to avoid any default-export interop ambiguity across module loaders.
 */
import { reportLlmCacheStats, resetLlmCacheStats } from '../support/llm-cache-files';

export function setup(): void {
  resetLlmCacheStats();
}

export function teardown(): void {
  reportLlmCacheStats('tui');
}
