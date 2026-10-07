/**
 * Main-process hardening of Vitest's source-map symbolication.
 *
 * Vitest runs `globalSetup` in the MAIN process — the same process whose
 * reporter symbolicates the final failing stack trace via `convert-source-map`.
 * `setupFiles` only run in worker forks, so without this the intermittent
 * `SyntaxError: … is not valid JSON` from a malformed inline source-map escapes
 * the reporter and fails an otherwise-green run. See `harden-source-map.ts`.
 *
 * Exported as the named `setup` (one of Vitest's supported globalSetup shapes)
 * to avoid any default-export interop ambiguity across module loaders.
 */
import { hardenSourceMapSymbolication } from './harden-source-map';
import { reportLlmCacheStats, resetLlmCacheStats } from '../support/llm-cache-files';

export function setup(): void {
  hardenSourceMapSymbolication();
  resetLlmCacheStats();
}

export function teardown(): void {
  reportLlmCacheStats('tui');
}
