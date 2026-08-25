import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the e2e *support* code — the helpers the suites lean on, not
 * the suites themselves.
 *
 * Separate from `tui/vitest.config.ts` because nothing here boots a runtime,
 * spawns a PTY or needs a credential: these run in milliseconds and belong in
 * the ordinary `test` job. The `test:run` script is what puts them there, since
 * that workflow already calls `npm run test:run --workspaces --if-present`.
 */
export default defineConfig({
  test: {
    include: ['support/**/*.test.ts'],
    environment: 'node',
  },
});
