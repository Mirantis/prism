import { defineConfig } from 'vitest/config';
import SlackLastSequencer from './slack-last-sequencer';

export default defineConfig({
  test: {
    // Tests live next to the harness; ignore the rest of the workspace
    // (the Playwright-BDD suite is run separately).
    include: ['tui/tests/**/*.test.ts'],
    // Boot is ~5-10s; real Bedrock chat round-trips ~20-30s; multi-step tool
    // calls (file create+share, `Ctrl+O`) can stretch to minutes under Opus 4.8.
    // Each Gherkin step is its own test, but a single step chains several
    // waitForFrame waits, so keep headroom.
    // Must exceed the largest sum of sequential waits inside a single step —
    // share-file's chip step is 300 + 120 + 15s = 435s. A ceiling below that
    // turns a harness timeout (which names the frame it wanted) into a bare
    // vitest one, which is the less useful of the two failures.
    testTimeout: 600_000,
    // Same trade as testTimeout, which the ceiling above already makes for
    // tests but this line used to undercut for hooks: `beforeAll` runs
    // `npx prisma db push` and then boots a runtime behind
    // `waitForReady(60_000)` (tui/setup.ts), so any boot slower than ~55s hit
    // vitest's hook ceiling first and reported a bare hook timeout instead of
    // the harness error that names the phase and prints the runtime log tail.
    hookTimeout: 180_000,
    // pty + child processes don't parallelize cleanly without explicit
    // isolation; serialize files (each file owns one runtime).
    pool: 'forks',
    fileParallelism: false,
    // Order matters for exactly one file — see slack-last-sequencer.ts. With
    // `fileParallelism: false` the sequencer's order is the run order.
    sequence: { sequencer: SlackLastSequencer },
    // Specs wire their own beforeAll/beforeEach; these only harden Vitest's
    // source-map symbolication so a malformed inline map can't fail an
    // otherwise-green run. The setup file patches each worker fork; globalSetup
    // patches the MAIN process where the reporter symbolicates the final stack
    // trace (setupFiles never run there). See harden-source-map.ts.
    setupFiles: ['tui/vitest.setup.ts'],
    globalSetup: ['tui/vitest.global-setup.ts'],
    globals: false,
    // Which spec and which wait expired has to be readable from the run page,
    // not just from a 400KB step log: `github-actions` annotates each failure
    // on the run, and the JUnit file carries the same names for anything
    // reading the uploaded artifact. Vitest adds `github-actions` implicitly
    // only while `reporters` is unset, so it has to be named here. Paths are
    // relative to the vitest root (`e2e/`, the workspace dir the npm script
    // runs from) and deliberately not Playwright's `test-results/`, which
    // Playwright wipes at the start of its own run.
    reporters: [
      'default',
      ['junit', { outputFile: 'tui-test-results/junit.xml' }],
      ...(process.env.GITHUB_ACTIONS === 'true' ? (['github-actions'] as const) : []),
    ],
  },
});
