/**
 * The container engine, reached through its CLI.
 *
 * The CLI rather than the API socket because `docker` is also the front end for
 * Podman, Colima, Rancher Desktop and OrbStack, and it resolves `DOCKER_HOST`
 * and contexts on its own. That coverage is the whole reason: a developer
 * machine is as likely to be running Podman as Docker.
 *
 * Every call here runs on the **host** — this is the runtime talking to the
 * engine, not the agent running a command — so it goes through a local
 * environment of its own rather than whichever one the selector settled on.
 */
import { captureProgram, type CaptureResult } from '../capture';
import { createLocalEnvironment } from '../local/local-environment';
import type { ExecutionEnvironment } from '../execution-environment';

export const DOCKER = 'docker';

/** Enough for `docker version`, an id, or an error; never a command's output. */
const CONTROL_OUTPUT_LIMIT = 64 * 1024;

/** The host, where the engine's client runs. Fixed, not the selected environment. */
let host: ExecutionEnvironment | null = null;
function hostEnvironment(): ExecutionEnvironment {
  host ??= createLocalEnvironment();
  return host;
}

export interface EngineCallOptions {
  timeoutMs: number;
  /**
   * Values for the `-e NAME` flags in `args`. The engine's client reads them
   * from its own environment, so a token is never written into an argv that
   * `ps` on the host can read.
   */
  env?: NodeJS.ProcessEnv;
}

/** Run one engine subcommand and collect what it said. Never throws. */
export function engineCall(
  args: readonly string[],
  options: EngineCallOptions,
): Promise<CaptureResult> {
  const environment = hostEnvironment();
  return captureProgram(environment, DOCKER, args, {
    cwd: environment.workspaceRoot(),
    env: { ...environment.baseEnv(), ...options.env },
    timeoutMs: options.timeoutMs,
    limitBytes: CONTROL_OUTPUT_LIMIT,
  });
}

/** The engine's own report of a failed call, for a log line or an error. */
export function engineFailure(command: string, run: CaptureResult): string {
  if (run.error) return `${command}: ${run.error.message}`;
  if (run.timedOut) return `${command}: the engine did not answer in time`;
  const said = run.stderr.trim() || run.stdout.trim();
  return said ? `${command}: ${said}` : `${command}: exited ${run.exitCode}`;
}

/** Test-only: forget the host environment so a fake can stand in. */
export function __resetEngineHostForTests(environment: ExecutionEnvironment | null): void {
  host = environment;
}
