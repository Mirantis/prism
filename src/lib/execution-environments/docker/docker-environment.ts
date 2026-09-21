/**
 * The Docker execution environment: the agent's commands run in a container,
 * and its files stay on this machine.
 *
 * `files` is the local filesystem, deliberately. Every path this environment
 * serves is bind-mounted into the container at the identical absolute path, so
 * the host side is the same bytes — which means no `docker exec cat`, an
 * atomic rename that is still atomic, and no change at all to the skill
 * catalog, the plugin catalog, the tool-output store, attachments or
 * share-file.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../config';
import { resolveClaudeConfigDir } from '../../coding-agents/claude-code/home';
import { resolveCodexHome } from '../../coding-agents/codex/credentials';
import {
  resolveDataDir,
  resolvePluginsDir,
  resolveSkillsDir,
  resolveToolOutputDir,
} from '../../data-dir';
import type { ExecutionEnvironment } from '../execution-environment';
import { localFiles } from '../local/local-files';
import { prepareLocalWorkspace, resolveLocalWorkspaceRoot } from '../local/local-workspace';
import { startContainer, stopContainer } from './container';
import { dockerBaseEnv } from './docker-env';
import { runDockerProgram, runDockerShell, type DockerExecContext } from './docker-process';
import { mountPaths, mountsExposing, servesPath, type ContainerPaths } from './mounts';

/** Hardcoded: the image is a component of this runtime, not a deployment choice. */
export const EXEC_IMAGE_REPO = 'ghcr.io/lensapp/prism-agent-exec';

/** The tag a build with no version of its own takes, and the one that moves. */
export const EXEC_IMAGE_FALLBACK_TAG = 'latest';

/**
 * The image this runtime is paired with.
 *
 * The tag is the runtime's own version, because the two are one component: the
 * runtime decides the argv, the mounts and the wrapper the image has to
 * satisfy, so a runtime running against some later image is running against
 * something it was never proven with. Every published build tags the image with
 * the version it bakes into the runtime beside it. A build carrying no version
 * — a checkout, the binary — has nothing to pair with and takes `latest`.
 */
export function execImage(version: string = config.serviceVersion): string {
  return `${EXEC_IMAGE_REPO}:${version || EXEC_IMAGE_FALLBACK_TAG}`;
}

/**
 * Whether the engine's cached copy of this image can be out of date. Only the
 * fallback tag is republished; a version tag names one build for good.
 */
export function isMovingImage(image: string): boolean {
  return image.endsWith(`:${EXEC_IMAGE_FALLBACK_TAG}`);
}

/** `<data>/exec-run` and `<data>/exec-home`, both mounted at their host path. */
export function resolveExecRunDir(): string {
  return path.join(resolveDataDir(), 'exec-run');
}
export function resolveExecHomeDir(): string {
  return path.join(resolveDataDir(), 'exec-home');
}

export function createDockerEnvironment(): ExecutionEnvironment {
  // Resolved once, at create: the mount list is fixed when the container is,
  // so a later change to the data dir would be a lie either way.
  const paths = containerPaths();
  const mounts = mountPaths(paths);
  const image = execImage();
  const container = containerName();
  const ctx: DockerExecContext = { container, runDir: paths.runDir };

  return {
    id: 'docker',
    displayName: `docker (${image})`,
    workspaceRoot: resolveLocalWorkspaceRoot,
    prepareWorkspace: prepareLocalWorkspace,

    start: async () => {
      assertMountsKeepTheDatabaseOut(mounts);
      // Every mount must exist before the container is created, or the engine
      // invents a root-owned directory for it on the host.
      for (const dir of mounts) fs.mkdirSync(dir, { recursive: true });
      await startContainer({
        name: container,
        image,
        refreshImage: isMovingImage(image),
        paths,
        env: dockerBaseEnv(),
      });
    },
    shutdown: () => stopContainer(container, image),

    servesPath: (candidate) => servesPath(mounts, candidate),

    baseEnv: () => dockerBaseEnv(),
    runShell: (command, options) => runDockerShell(command, options, ctx),
    runProgram: (command, args, options) => runDockerProgram(command, args, options, ctx),

    files: localFiles,
  };
}

/**
 * Named after the data dir, not the agent: the container is created before the
 * agent is resolved, so `config.agentId` is still unset here on a first boot
 * and every such install would answer to the same name. Two runtimes on one
 * host must already hold separate data dirs — that is where the database is —
 * so hashing it separates exactly the deployments that have to stay separate,
 * and gives the same container back on every restart of one of them.
 */
export function containerName(): string {
  const digest = createHash('sha256').update(resolveDataDir()).digest('hex').slice(0, 12);
  return `prism-agent-exec-${digest}`;
}

/**
 * Refuse a mount set that hands the container the runtime's own data.
 *
 * `mountPaths` drops a nested path when an ancestor is mounted, so a workspace
 * root set to the data dir or above it does not add the database to the list —
 * it swallows every other mount into one that already holds `agent.db`, the
 * media store and the plugin scratch. The configuration is legal and the
 * boundary would be gone without a word, so the environment refuses to start
 * and the selector falls back to local, where the agent's shell reaches those
 * files anyway and the docs say so.
 */
function assertMountsKeepTheDatabaseOut(mounts: readonly string[]): void {
  const exposed = mountsExposing(mounts, resolveDataDir());
  if (exposed.length === 0) return;
  throw new Error(
    `refusing to mount ${exposed.join(', ')}: it holds the runtime's own data directory ` +
      `(${resolveDataDir()}). Set the workspace root to a directory outside it.`,
  );
}

function containerPaths(): ContainerPaths {
  // The env the coding agents will run with, which is what decides where each
  // one keeps its home — an operator's `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
  // points somewhere this process would otherwise never mount.
  const agentEnv = dockerBaseEnv();
  return {
    workspaceRoot: resolveLocalWorkspaceRoot(),
    skillsDir: resolveSkillsDir(),
    pluginsDir: resolvePluginsDir(),
    toolOutputDir: resolveToolOutputDir(),
    // Both homes, whether or not their agent is available: which ones are
    // depends on a probe that runs *inside* the container, after this.
    codingAgentHomes: [resolveClaudeConfigDir(agentEnv), resolveCodexHome(agentEnv)],
    runDir: resolveExecRunDir(),
    homeDir: resolveExecHomeDir(),
  };
}
