/**
 * Execution-environment step definitions.
 *
 * One assertion, and it is the whole claim: a file the agent's command wrote
 * inside the container is readable **on this machine**, at the workspace root
 * the runtime was started with. Both halves are load-bearing. The container
 * writes it, so the bytes cross the mount rather than being written by the
 * runtime's own filesystem; and this suite reads it directly, since asking the
 * agent to `cat` it would only prove the container can see its own disk.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { E2E_WORKSPACE } from '../fixtures/test-data';

const { Given, Then } = createBdd();

/**
 * Gated here rather than by a `grep` in the config, because the suite's own
 * scripts pass `--grep-invert` on the command line and a CLI filter replaces
 * the config's outright. The whole run has to be in container mode: the
 * runtime picks one environment at boot, so this scenario is its own
 * invocation —
 *   EXECUTION_ENVIRONMENT=docker npm run test --workspace=prism-agent-e2e
 */
Given("the agent's commands run in a container", async () => {
  test.skip(
    process.env.EXECUTION_ENVIRONMENT !== 'docker',
    'Needs a container engine, the prism-agent-exec image, and EXECUTION_ENVIRONMENT=docker.',
  );
});

Then(
  'the workspace file {string} contains {string}',
  async (_fixtures, name: string, expected: string) => {
    const onDisk = path.join(E2E_WORKSPACE, name);
    await expect
      .poll(() => fs.readFile(onDisk, 'utf8').catch(() => null), {
        message: `${onDisk} should hold the command's output on the host`,
      })
      .toContain(expected);
  },
);
