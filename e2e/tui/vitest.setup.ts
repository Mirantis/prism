import { beforeEach } from 'vitest';
import { forgetLlmCacheEntriesSince } from '../support/llm-cache-files';

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
