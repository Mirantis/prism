/**
 * The exec container's lifetime, which is the runtime's — and the volumes',
 * which is longer.
 *
 * The container is created at boot, runs the whole time and is removed at
 * shutdown, so a `shell_spawn` background process and a long `coding_agent`
 * task live between turns exactly as they do when they are children of the
 * runtime. The volumes it mounts are never removed: they hold the workspace,
 * the skills, the plugins and both coding agents' logins, and losing them on a
 * restart would lose the agent's work.
 */
import * as os from 'os';
import { config } from '../../../config';
import { trackEvent } from '../../telemetry';
import { logger } from '../../../logger';
import { engineCall, engineFailure } from './engine';
import { CONTAINER_PATHS, volumeMounts } from './volumes';

/** Pulling an image over a slow link is the one step that can take minutes. */
const PULL_TIMEOUT_MS = 10 * 60_000;
const CONTROL_TIMEOUT_MS = 60_000;

export interface ContainerSpec {
  name: string;
  image: string;
  /** The tag is republished, so the engine's cached copy of it can be stale. */
  refreshImage: boolean;
  /** Names the volumes after the deployment, so two runtimes never share one. */
  deployment: string;
  /** Passed by name, so the values ride the engine client's env, not an argv. */
  env: NodeJS.ProcessEnv;
}

/**
 * Bring the container up, replacing one a crashed run left behind. Throws with
 * the engine's own words when it cannot, which the selector turns into a fall
 * back to the local environment.
 */
export async function startContainer(spec: ContainerSpec): Promise<void> {
  const startedAt = Date.now();
  await ensureImage(spec.image, spec.refreshImage);
  // A container from a previous run holds the name, so it is removed rather
  // than reused: its mounts were fixed at *its* create. The volumes it was
  // using are untouched and the new container picks the same ones back up.
  await removeContainer(spec.name);

  const names = Object.keys(spec.env).filter((name) => spec.env[name] !== undefined);
  const mounts = volumeMounts(spec.deployment);

  const argv = [
    'run',
    '--detach',
    '--name',
    spec.name,
    // The runtime's own user, so a file the agent creates in a volume is owned
    // by whoever will read it back through the engine. A fresh volume takes
    // the mode of the image's directory, which `Dockerfile.exec` makes
    // world-writable for exactly this reason.
    '--user',
    `${os.userInfo().uid}:${os.userInfo().gid}`,
    '--workdir',
    CONTAINER_PATHS.workspaceRoot,
    '--env',
    `HOME=${CONTAINER_PATHS.homeDir}`,
    ...names.flatMap((name) => ['--env', name]),
    ...mounts.flatMap((mount) => ['--volume', `${mount.name}:${mount.path}`]),
    spec.image,
    // Held open by the image's own command; nothing runs here until a
    // `docker exec` arrives.
    'sleep',
    'infinity',
  ];

  const run = await engineCall(argv, { timeoutMs: CONTROL_TIMEOUT_MS, env: spec.env });
  if (run.error || run.exitCode !== 0) {
    trackEvent('exec container started', config.ownerUserId, {
      ...eventProps(spec.image),
      status: 'failed',
      elapsed_ms: String(Date.now() - startedAt),
    });
    throw new Error(engineFailure('could not start the exec container', run));
  }
  logger.info(
    { container: spec.name, image: spec.image, volumes: mounts.map((m) => m.name) },
    '[Docker] exec container ready',
  );
  trackEvent('exec container started', config.ownerUserId, {
    ...eventProps(spec.image),
    status: 'ready',
    volumes: String(mounts.length),
    elapsed_ms: String(Date.now() - startedAt),
  });
}

/**
 * Remove the container and leave every volume in place. Never throws: the
 * process is leaving either way.
 */
export async function stopContainer(name: string, image: string): Promise<void> {
  const startedAt = Date.now();
  const run = await removeContainer(name);
  const failed = Boolean(run.error) || run.exitCode !== 0;
  if (failed) {
    logger.warn({ container: name }, engineFailure('could not remove the exec container', run));
  }
  trackEvent('exec container stopped', config.ownerUserId, {
    ...eventProps(image),
    status: failed ? 'failed' : 'removed',
    elapsed_ms: String(Date.now() - startedAt),
  });
}

/** No container name: it is derived from the data dir, which is a host path. */
function eventProps(image: string): Record<string, string> {
  return { 'execution.environment': 'docker', 'execution.image': image };
}

/**
 * Make sure the engine holds the image, and hold the right one.
 *
 * A version tag names one build for good, so having it is enough and a pull on
 * every boot would only make an offline start fail for an image sitting right
 * there. A republished tag is the other way round: the copy the engine cached
 * on some earlier boot can be months behind the runtime asking for it, so it
 * is pulled again each time. That pull may fail — a registry that is down, a
 * machine that is offline — and a copy that works is better than no start at
 * all, so the failure is logged and the cached image is used.
 */
async function ensureImage(image: string, refresh: boolean): Promise<void> {
  const present = await engineCall(['image', 'inspect', image], {
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  const held = !present.error && present.exitCode === 0;
  if (held && !refresh) return;

  logger.info({ image }, '[Docker] pulling the exec image');
  const pull = await engineCall(['pull', image], { timeoutMs: PULL_TIMEOUT_MS });
  if (!pull.error && pull.exitCode === 0) return;
  if (!held) throw new Error(engineFailure(`could not pull ${image}`, pull));
  logger.warn({ image }, engineFailure('could not refresh the exec image', pull));
}

/**
 * Forced, and with no grace period to ask for: `--time` belongs to `stop`, not
 * `rm`, and passing it makes the engine reject the whole call. Nothing in the
 * container needs to flush anyway — the shutdown that calls this has already
 * killed the agent's own work, and what is left is the `sleep` holding the
 * container open.
 */
async function removeContainer(name: string) {
  return engineCall(['rm', '--force', name], { timeoutMs: CONTROL_TIMEOUT_MS });
}
