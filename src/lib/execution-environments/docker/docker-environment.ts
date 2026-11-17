/**
 * The Docker execution environment: the agent's commands run in a container,
 * and so does its storage.
 *
 * Everything the agent works with sits in named volumes the engine owns, at
 * fixed paths under `/prism` (see `volumes.ts`). The runtime cannot open those
 * files, so `files` reaches them through the engine — which is what makes this
 * environment work on a remote engine, and on macOS and Windows without the
 * cost of a host bind mount. The volumes outlive the container, so nothing the
 * agent keeps is lost on a restart.
 */
import { createHash } from 'crypto';
import { agentProcesses } from '../../agent-processes';
import { config } from '../../../config';
import { resolveDataDir } from '../../data-dir';
import type { AgentPaths, ExecutionEnvironment } from '../execution-environment';
import { startContainer, stopContainer } from './container';
import { createDockerFiles } from './docker-files';
import { dockerBaseEnv } from './docker-env';
import { runDockerProgram, runDockerShell, type DockerExecContext } from './docker-process';
import { CONTAINER_PATHS, servesPath } from './volumes';

/** Hardcoded: the image is a component of this runtime, not a deployment choice. */
export const EXEC_IMAGE_REPO = 'ghcr.io/mirantis/prism-exec';

/** The tag a build with no version of its own takes, and the one that moves. */
export const EXEC_IMAGE_FALLBACK_TAG = 'latest';

/**
 * The image this runtime is paired with.
 *
 * The tag is the runtime's own version, because the two are one component: the
 * runtime decides the argv, the paths and the wrapper the image has to
 * satisfy, so a runtime running against some later image is running against
 * something it was never proven with. Every published build tags the image with
 * the version it bakes into the runtime beside it: a SEA binary's release tag,
 * or an image's `SERVICE_VERSION`. A checkout carries neither and takes `latest`.
 */
export function execImage(version: string = config.appVersion): string {
  return `${EXEC_IMAGE_REPO}:${version || EXEC_IMAGE_FALLBACK_TAG}`;
}

/**
 * Whether the engine's cached copy of this image can be out of date. Only the
 * fallback tag is republished; a version tag names one build for good.
 */
export function isMovingImage(image: string): boolean {
  return image.endsWith(`:${EXEC_IMAGE_FALLBACK_TAG}`);
}

/** The container this deployment's commands run in. */
export function execContainerName(deployment: string): string {
  return `prism-agent-exec-${deployment}`;
}

export function createDockerEnvironment(): ExecutionEnvironment {
  const deployment = deploymentId();
  const container = execContainerName(deployment);
  const image = execImage();
  const ctx: DockerExecContext = { container };
  const files = createDockerFiles(container);

  return {
    id: 'docker',
    displayName: `docker (${image})`,

    workspaceRoot: () => CONTAINER_PATHS.workspaceRoot,
    paths: (): AgentPaths => ({
      skillsDir: CONTAINER_PATHS.skillsDir,
      pluginsDir: CONTAINER_PATHS.pluginsDir,
      pluginDataDir: CONTAINER_PATHS.pluginDataDir,
      toolOutputDir: CONTAINER_PATHS.toolOutputDir,
      claudeHome: CONTAINER_PATHS.claudeHome,
      codexHome: CONTAINER_PATHS.codexHome,
    }),
    // The image creates every one of these and the engine seeds each volume
    // from it, so the workspace exists before the first command and there is
    // nothing here to fall back from.
    prepareWorkspace: () => ({ root: CONTAINER_PATHS.workspaceRoot, fellBackFrom: null }),

    start: () =>
      startContainer({
        name: container,
        image,
        refreshImage: isMovingImage(image),
        deployment,
      }),
    shutdown: () => stopContainer(container, image),

    servesPath,

    baseEnv: () => dockerBaseEnv(),
    runShell: (command, options) =>
      agentProcesses.track(() => runDockerShell(command, options, ctx), options.stdin === 'pipe'),
    runProgram: (command, args, options) =>
      agentProcesses.track(
        () => runDockerProgram(command, args, options, ctx),
        options.stdin === 'pipe',
      ),

    files,
  };
}

/**
 * What separates one deployment's container and volumes from another's.
 *
 * The data directory, not the agent id: the container is created before the
 * agent is resolved, so `config.agentId` is still unset on a first boot and
 * every such install would answer to the same name. Two runtimes on one host
 * must already hold separate data dirs — that is where the database is — so
 * hashing it separates exactly the deployments that have to stay separate, and
 * gives the same container and the same volumes back on every restart of one.
 */
export function deploymentId(): string {
  return createHash('sha256').update(resolveDataDir()).digest('hex').slice(0, 12);
}
