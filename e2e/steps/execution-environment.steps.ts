/**
 * Execution-environment step definitions.
 *
 * One claim, in two halves: a file the agent's command wrote inside the
 * container is really there, and it is still there once the container that
 * wrote it is gone. The second half is what the named volumes buy — the
 * container is disposable and the agent's work is not.
 *
 * Both halves ask the engine rather than the runtime. Reading it back through
 * the agent would only prove the container can see its own disk.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

const { Given, Then } = createBdd();

/** The container the runtime under test created, whatever its deployment id. */
let container: string;
let checkedPath: string;

/**
 * Gated here rather than by a `grep` in the config, because the suite's own
 * scripts pass `--grep-invert` on the command line and a CLI filter replaces
 * the config's outright. The whole run has to be in container mode: the
 * runtime picks one environment at boot, so this scenario is its own
 * invocation —
 *   EXECUTION_ENVIRONMENT=docker npm run test --workspace=prism-agent-e2e
 */
Given("the agent's commands run in a container", async ({}) => {
  test.skip(
    process.env.EXECUTION_ENVIRONMENT !== 'docker',
    'Needs a container engine, the prism-agent-exec image, and EXECUTION_ENVIRONMENT=docker.',
  );
  const { stdout } = await run('docker', [
    'ps',
    '--filter',
    'name=prism-agent-exec-',
    '--format',
    '{{.Names}}',
  ]);
  container = stdout.trim().split('\n')[0];
  expect(container, 'the runtime should have created an exec container').toBeTruthy();
});

Then(
  "the agent's workspace file {string} contains {string}",
  async ({}, name: string, expected: string) => {
    checkedPath = `/prism/workspace/${name}`;
    await expect
      .poll(() => readFromContainer(checkedPath), {
        message: `${checkedPath} should hold what the command wrote`,
      })
      .toContain(expected);
  },
);

Then('the file is still there after the container is replaced', async ({}) => {
  const before = await readFromContainer(checkedPath);
  expect(before).not.toBeNull();

  // What a restart does: the container goes, its volumes stay, and the next
  // one mounts them again.
  const { stdout: image } = await run('docker', [
    'inspect',
    '--format',
    '{{.Config.Image}}',
    container,
  ]);
  const { stdout: mounts } = await run('docker', [
    'inspect',
    '--format',
    '{{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}',
    container,
  ]);
  await run('docker', ['rm', '--force', container]);

  const replacement = `${container}-replacement`;
  await run('docker', [
    'run',
    '--detach',
    '--name',
    replacement,
    ...mounts.trim().split(/\s+/).flatMap((mount) => ['--volume', mount]),
    image.trim(),
    'sleep',
    'infinity',
  ]);

  try {
    const { stdout } = await run('docker', ['exec', replacement, 'cat', checkedPath]);
    expect(stdout).toContain('from-the-container');
  } finally {
    await run('docker', ['rm', '--force', replacement]).catch(() => undefined);
  }
});

/** What the container holds at that path, or null while it holds nothing. */
async function readFromContainer(path: string): Promise<string | null> {
  try {
    const { stdout } = await run('docker', ['exec', container, 'cat', path]);
    return stdout;
  } catch {
    return null;
  }
}
