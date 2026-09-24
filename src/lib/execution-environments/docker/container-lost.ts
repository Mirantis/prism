/**
 * Naming the cause when the exec container is gone.
 *
 * The container is created once, at boot. When it disappears while the runtime
 * runs — the engine restarts, Docker Desktop is relaunched, somebody removes it,
 * or the OOM killer stops it — every command and every file call answers with
 * the engine's error until the runtime restarts. The agent's shell then fails
 * and its skills and plugins read as empty, so one warning names the cause.
 */
import { logger } from '../../../logger';

/**
 * The engine's answer for a container that is missing or stopped. Podman says
 * `no container with name or ID "<name>" found: no such container` and
 * `can only create exec sessions on running containers`; Docker says
 * `No such container: <name>` and `container <id> is not running`.
 */
const CONTAINER_LOST =
  /no such container|is not running|can only create exec sessions on running containers/i;

let reported = false;

export function isContainerLost(engineSaid: string): boolean {
  return CONTAINER_LOST.test(engineSaid);
}

/**
 * Warn once per process when the engine says the container is gone. Once is
 * enough: nothing brings the container back before the runtime restarts.
 */
export function reportIfContainerLost(container: string, engineSaid: string): void {
  if (reported || !isContainerLost(engineSaid)) return;
  reported = true;
  logger.warn(
    { container, engine: engineSaid.trim().slice(0, 300) },
    '[Docker] the exec container is gone; commands and file access fail until the runtime restarts',
  );
}

/** Test-only: forget that the warning was given. */
export function __resetContainerLostForTests(): void {
  reported = false;
}
