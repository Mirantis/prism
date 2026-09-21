/**
 * Which environment serves this deployment.
 *
 * Docker is preferred when it is there, so the boundary costs no configuration
 * — but the answer is derived from four things in order, and the operator's
 * word is the first of them.
 */
import * as fs from 'fs';
import { hasBinaries } from '../../has-binary';
import type { ExecutionEnvironmentName } from '../execution-environment';
import { engineCall } from './engine';

/** A slow engine is a broken one for this purpose; the agent still has to boot. */
const PROBE_TIMEOUT_MS = 10_000;

/** What marks the runtime's own process as already living in a container. */
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'];

export interface DetectionDeps {
  /** Overridden in tests so no case depends on an engine being installed. */
  engineAnswers: () => Promise<boolean>;
  inContainer: () => boolean;
  configured: () => string | undefined;
}

export interface Detection {
  name: ExecutionEnvironmentName;
  /** Why, for the startup log — an operator who expected Docker needs to know. */
  reason: string;
  /** The operator asked for this by name, so a failure to start must not degrade. */
  demanded: boolean;
}

export const defaultDetectionDeps: DetectionDeps = {
  engineAnswers,
  inContainer: () => CONTAINER_MARKERS.some((marker) => fs.existsSync(marker)),
  configured: () => process.env.EXECUTION_ENVIRONMENT?.trim().toLowerCase() || undefined,
};

export async function detectEnvironment(
  deps: DetectionDeps = defaultDetectionDeps,
): Promise<Detection> {
  const configured = deps.configured();
  if (configured === 'docker') {
    return { name: 'docker', reason: 'EXECUTION_ENVIRONMENT=docker', demanded: true };
  }
  if (configured === 'local') {
    return { name: 'local', reason: 'EXECUTION_ENVIRONMENT=local', demanded: true };
  }
  if (configured) {
    return { name: 'local', reason: `unknown EXECUTION_ENVIRONMENT "${configured}"`, demanded: false };
  }

  // The published image is already the boundary, and it holds the toolchain a
  // command expects. Starting a sibling would take that away from every
  // install that mounts an engine socket for some other reason.
  if (deps.inContainer()) {
    return { name: 'local', reason: 'the runtime is already in a container', demanded: false };
  }

  if (await deps.engineAnswers()) {
    return { name: 'docker', reason: 'a container engine answered', demanded: false };
  }
  return { name: 'local', reason: 'no container engine', demanded: false };
}

/** Whether a `docker` client is installed *and* its engine is actually up. */
async function engineAnswers(): Promise<boolean> {
  // The binary alone proves nothing: a machine with Docker Desktop installed
  // and not running has the client on PATH and no daemon behind it.
  if (!(await hasBinaries('docker'))) return false;
  const run = await engineCall(['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return !run.error && !run.timedOut && run.exitCode === 0;
}
