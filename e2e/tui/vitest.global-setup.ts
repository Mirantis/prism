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
import path from 'node:path';
import { config } from 'dotenv';
import { hardenSourceMapSymbolication } from './harden-source-map';

export function setup(): void {
  // Load the shared e2e env exactly like playwright.config.ts does, so both
  // suites run the runtime against the same pinned model (BEDROCK_MODEL_ID in
  // e2e/.env.e2e — Sonnet). Without this the TUI runtimes silently fell back
  // to the runtime's Opus default, whose multi-tool turns overrun the frame
  // timeouts whenever Bedrock is slow (issue #67). Real shell/CI env still
  // wins for .env.e2e (dotenv never overrides existing vars); .env.e2e.local
  // carries secret overrides, same as the Playwright suite. globalSetup runs
  // in the main process, and the fork pool inherits its env.
  config({ path: path.resolve(import.meta.dirname, '../.env.e2e') });
  config({ path: path.resolve(import.meta.dirname, '../.env.e2e.local'), override: true });

  hardenSourceMapSymbolication();
}
