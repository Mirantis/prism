/**
 * The execution environment this deployment runs in, and the one a given path
 * can be served by.
 *
 * Selection is async — it asks a container engine whether it is there — while
 * every caller wants it synchronously, so this follows the shape
 * `lib/coding-agents/availability.ts` already uses: a memoized probe awaited at
 * boot and at the top of `collectTools()`, and a synchronous accessor that
 * answers `local` until the probe has settled. That is what keeps the fourteen
 * existing call sites unchanged, and what guarantees the answer is fixed before
 * the first turn builds a tools block.
 */

import { logger } from '../../logger';
import { createLocalEnvironment } from './local/local-environment';
import { createDockerEnvironment } from './docker/docker-environment';
import { detectEnvironment, type DetectionDeps } from './docker/detect';
import type { ExecutionEnvironment, ExecutionEnvironmentName } from './execution-environment';

const FACTORIES: Record<ExecutionEnvironmentName, () => ExecutionEnvironment> = {
  local: createLocalEnvironment,
  docker: createDockerEnvironment,
};

/** `local` until the probe replaces it, so a caller before boot is never stuck. */
let instance: ExecutionEnvironment | null = null;
let probe: Promise<void> | null = null;

export function getExecutionEnvironment(): ExecutionEnvironment {
  instance ??= createLocalEnvironment();
  return instance;
}

/**
 * The environment that can run a command with this cwd.
 *
 * A thread the terminal UI started in a repository carries that repository's
 * absolute path, and the container's mounts were fixed when it was created, so
 * such a path is not in it. Those commands run on the host instead — the
 * alternative is breaking `prism` launched in a repo, which is how the terminal
 * UI is normally used.
 */
export function getExecutionEnvironmentFor(cwd?: string): ExecutionEnvironment {
  const environment = getExecutionEnvironment();
  if (!cwd || environment.servesPath(cwd)) return environment;
  reportFallback(cwd, environment.id);
  return localFallback();
}

/**
 * Resolve the environment and bring it up, once per process. Awaited at boot
 * and by `collectTools()`; every later caller gets the settled promise.
 */
export function ensureExecutionEnvironmentDetected(): Promise<void> {
  probe ??= resolve();
  return probe;
}

async function resolve(): Promise<void> {
  const detection = await detectEnvironment().catch((err: unknown) => {
    logger.warn({ err }, '[ExecutionEnvironment] detection failed; running locally');
    return null;
  });
  if (!detection || detection.name === 'local') {
    instance = createLocalEnvironment();
    logger.info(
      { environment: 'local', reason: detection?.reason ?? 'detection failed' },
      '[Startup] execution environment',
    );
    return;
  }

  const candidate = FACTORIES[detection.name]();
  try {
    await candidate.start();
  } catch (err) {
    // An operator who named the environment gets the failure, because silently
    // running unconfined is not what they asked for. Otherwise an agent that
    // still works on the host beats one that will not boot.
    if (detection.demanded) throw err;
    logger.warn(
      { err, environment: detection.name },
      '[ExecutionEnvironment] could not start; running locally',
    );
    instance = createLocalEnvironment();
    return;
  }
  instance = candidate;
  logger.info(
    { environment: candidate.id, detail: candidate.displayName, reason: detection.reason },
    '[Startup] execution environment',
  );
}

/** One local environment for every fallback, so they share its state. */
let fallback: ExecutionEnvironment | null = null;
function localFallback(): ExecutionEnvironment {
  fallback ??= createLocalEnvironment();
  return fallback;
}

/** Said once per path: a turn makes many calls, and this is a property of the thread. */
const reported = new Set<string>();
function reportFallback(cwd: string, environment: ExecutionEnvironmentName): void {
  if (reported.has(cwd)) return;
  reported.add(cwd);
  logger.info(
    { cwd, environment },
    '[ExecutionEnvironment] this path is outside the container; its commands run on the host',
  );
}

/** Test-only: stand in a fake environment, or restore the real one with null. */
export function __setExecutionEnvironmentForTests(env: ExecutionEnvironment | null): void {
  instance = env;
}

/** Test-only: forget the probe and the per-path reports. */
export function __resetExecutionEnvironmentDetectionForTests(): void {
  probe = null;
  instance = null;
  fallback = null;
  reported.clear();
}

export type { DetectionDeps };
