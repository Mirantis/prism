/**
 * What the environment is pointed at before it starts anything: the image it
 * pairs with, the container and volumes it claims, and the paths it hands the
 * rest of the runtime.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  EXEC_IMAGE_REPO,
  createDockerEnvironment,
  deploymentId,
  execImage,
  isMovingImage,
} from './docker-environment';
import { CONTAINER_PATHS, volumeName } from './volumes';

const dataDir = path.join(os.tmpdir(), 'prism-exec-env-a');
const otherDataDir = path.join(os.tmpdir(), 'prism-exec-env-b');

afterEach(() => vi.unstubAllEnvs());

describe('execImage', () => {
  it('pairs the image with the runtime build that asks for it', () => {
    expect(execImage('v2026.9.21120000')).toBe(`${EXEC_IMAGE_REPO}:v2026.9.21120000`);
    expect(execImage('canary-0f1e2d3')).toBe(`${EXEC_IMAGE_REPO}:canary-0f1e2d3`);
  });

  it('takes the moving tag for a build carrying no version', () => {
    // A checkout and the packaged binary have nothing to pair with.
    expect(execImage('')).toBe(`${EXEC_IMAGE_REPO}:latest`);
  });

  it('says which of those two the engine may hold a stale copy of', () => {
    expect(isMovingImage(execImage(''))).toBe(true);
    expect(isMovingImage(execImage('v2026.9.21120000'))).toBe(false);
  });
});

describe('deploymentId', () => {
  it('names a deployment before the agent id is known', () => {
    // `start()` runs before the agent is resolved, so the id is still unset on
    // a first boot and every such install would otherwise answer to one name.
    vi.stubEnv('AGENT_ID', '');
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    expect(deploymentId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('gives one deployment the same container and volumes back on every restart', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const first = deploymentId();
    vi.stubEnv('PRISM_DATA_DIR', otherDataDir);
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    expect(deploymentId()).toBe(first);
  });

  it('separates two runtimes that hold separate data', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const mine = deploymentId();
    vi.stubEnv('PRISM_DATA_DIR', otherDataDir);
    const theirs = deploymentId();

    expect(theirs).not.toBe(mine);
    // Which is what keeps one runtime's workspace out of the other's.
    expect(volumeName(mine, 'workspaceRoot')).not.toBe(volumeName(theirs, 'workspaceRoot'));
  });
});

describe('the environment it builds', () => {
  it('puts the agent in the container, not on this machine', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const environment = createDockerEnvironment();

    expect(environment.workspaceRoot()).toBe(CONTAINER_PATHS.workspaceRoot);
    expect(environment.paths()).toEqual({
      skillsDir: CONTAINER_PATHS.skillsDir,
      pluginsDir: CONTAINER_PATHS.pluginsDir,
      pluginDataDir: CONTAINER_PATHS.pluginDataDir,
      toolOutputDir: CONTAINER_PATHS.toolOutputDir,
      claudeHome: CONTAINER_PATHS.claudeHome,
      codexHome: CONTAINER_PATHS.codexHome,
    });
  });

  it('ignores a data dir that names nothing inside the container', () => {
    // The volumes are the engine's, so where this machine keeps its data
    // changes which volumes are used, never where the agent finds them.
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const mine = createDockerEnvironment().paths();
    vi.stubEnv('PRISM_DATA_DIR', otherDataDir);
    expect(createDockerEnvironment().paths()).toEqual(mine);
  });

  it('serves the container tree and leaves the rest to the local environment', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const environment = createDockerEnvironment();

    expect(environment.servesPath(`${CONTAINER_PATHS.skillsDir}/my-skill`)).toBe(true);
    // The database, and a repository the terminal UI was started in.
    expect(environment.servesPath(path.join(dataDir, 'agent.db'))).toBe(false);
    expect(environment.servesPath('/Users/me/dev/repo')).toBe(false);
  });

  it('needs nothing prepared on this machine for its workspace', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    // The image creates the directory and the engine seeds the volume from it,
    // so there is no host directory to make and nothing to fall back from.
    expect(createDockerEnvironment().prepareWorkspace()).toEqual({
      root: CONTAINER_PATHS.workspaceRoot,
      fellBackFrom: null,
    });
  });
});
