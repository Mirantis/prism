import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live next to the harness; ignore the rest of the workspace
    // (the Playwright-BDD suite is run separately).
    include: ['tui/tests/**/*.test.ts'],
    // Boot is ~5-10s; real Bedrock chat round-trips ~20-30s; multi-step tool
    // calls (file create+share, `Ctrl+O`) can stretch to minutes under Opus 4.8.
    // Each Gherkin step is its own test, but a single step chains several
    // waitForFrame waits (e.g. share-file's chip step ~225s), so keep headroom.
    testTimeout: 240_000,
    hookTimeout: 60_000,
    // pty + child processes don't parallelize cleanly without explicit
    // isolation; serialize files (each file owns one runtime).
    pool: 'forks',
    fileParallelism: false,
    // Specs wire their own beforeAll/beforeEach; these only harden Vitest's
    // source-map symbolication so a malformed inline map can't fail an
    // otherwise-green run. The setup file patches each worker fork; globalSetup
    // patches the MAIN process where the reporter symbolicates the final stack
    // trace (setupFiles never run there). See harden-source-map.ts.
    setupFiles: ['tui/vitest.setup.ts'],
    globalSetup: ['tui/vitest.global-setup.ts'],
    globals: false,
  },
});
