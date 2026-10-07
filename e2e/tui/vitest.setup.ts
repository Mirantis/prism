/**
 * Worker-side hardening of Vitest's source-map symbolication.
 *
 * Runs in each worker fork (via `setupFiles`). The companion `globalSetup`
 * (`vitest.global-setup.ts`) applies the same patch to the main Vitest process,
 * where the reporter that formats the final failing stack trace runs. Both are
 * needed — see `harden-source-map.ts` for the full rationale.
 */
import { beforeEach } from 'vitest';
import { hardenSourceMapSymbolication } from './harden-source-map';
import { forgetLlmCacheEntriesSince } from '../support/llm-cache-files';

hardenSourceMapSymbolication();

// Each step is a test in its scenario's suite, so a scenario starts with its first step. A failed
// step removes the LLM cache entries its scenario recorded, so the next run asks the model again.
let scenario: unknown;
let scenarioStartedAt = Date.now();
beforeEach(({ task, onTestFailed }) => {
  if (task.suite !== scenario) {
    scenario = task.suite;
    scenarioStartedAt = Date.now();
  }
  const startedAt = scenarioStartedAt;
  onTestFailed(() => forgetLlmCacheEntriesSince(startedAt));
});
