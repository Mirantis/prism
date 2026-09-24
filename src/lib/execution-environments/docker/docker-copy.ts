/**
 * Reaching the agent's volumes to copy files in or out.
 *
 * `docker cp` addresses a container, not a volume, so moving files needs one
 * to exist. When the runtime is serving commands there is one already. When it
 * is not — the deployment has moved back to running on this machine, and the
 * volumes still hold the work — a container is created for the copy and
 * removed afterwards.
 */
import { logger } from '../../../logger';
import { engineCall, engineFailure } from './engine';
import { execImage } from './docker-environment';
import { volumeMounts } from './volumes';

const CONTROL_TIMEOUT_MS = 60_000;

/** A large workspace crossing the engine's pipe is the slow case. */
const COPY_TIMEOUT_MS = 30 * 60_000;

export interface DockerAccess {
  container: string;
  /** Removes the container when this call created one; otherwise does nothing. */
  release(): Promise<void>;
}

/**
 * A container the volumes are mounted in, for as long as the caller needs one.
 *
 * Reuses the running exec container when it is there, so a copy never disturbs
 * work in progress.
 */
export async function openVolumes(deployment: string, container: string): Promise<DockerAccess> {
  if (await isRunning(container)) {
    return { container, release: () => Promise.resolve() };
  }

  const temporary = `${container}-copy`;
  await removeContainer(temporary);

  const image = execImage();
  const argv = [
    'run',
    '--detach',
    '--name',
    temporary,
    ...volumeMounts(deployment).flatMap((mount) => ['--volume', `${mount.name}:${mount.path}`]),
    image,
    'sleep',
    'infinity',
  ];
  const run = await engineCall(argv, { timeoutMs: CONTROL_TIMEOUT_MS });
  if (run.error || run.exitCode !== 0) {
    throw new Error(engineFailure('could not open the agent volumes', run));
  }
  logger.info({ container: temporary }, '[Docker] opened the volumes for a copy');

  return {
    container: temporary,
    release: async () => {
      await removeContainer(temporary);
    },
  };
}

/** Copy one entry from this machine into the container. */
export async function copyIntoContainer(
  container: string,
  from: string,
  to: string,
): Promise<void> {
  await copy(from, `${container}:${to}`);
}

/** Copy one entry out of the container onto this machine. */
export async function copyFromContainer(
  container: string,
  from: string,
  to: string,
): Promise<void> {
  await copy(`${container}:${from}`, to);
}

/**
 * `docker cp` names the destination in full rather than a directory to drop
 * into: given an existing directory the engine copies *inside* it, which would
 * nest a second copy on a re-run.
 */
async function copy(from: string, to: string): Promise<void> {
  const run = await engineCall(['cp', '--archive', from, to], { timeoutMs: COPY_TIMEOUT_MS });
  if (run.error || run.exitCode !== 0) {
    throw new Error(engineFailure(`could not copy ${from} to ${to}`, run));
  }
}

async function isRunning(container: string): Promise<boolean> {
  const run = await engineCall(['inspect', '--format', '{{.State.Running}}', container], {
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  return !run.error && run.exitCode === 0 && run.stdout.trim() === 'true';
}

async function removeContainer(name: string): Promise<void> {
  await engineCall(['rm', '--force', name], { timeoutMs: CONTROL_TIMEOUT_MS });
}
