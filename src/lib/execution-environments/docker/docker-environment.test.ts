/**
 * What the environment is pointed at before it starts anything: the image it
 * pairs with, the container it claims, and the mounts it refuses to create.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
  EXEC_IMAGE_REPO,
  containerName,
  createDockerEnvironment,
  execImage,
  isMovingImage,
} from './docker-environment';

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

describe('containerName', () => {
  it('names a container before the agent id is known', () => {
    // `start()` runs before the agent is resolved, so the id is still unset on
    // a first boot and every such install would otherwise answer to one name.
    vi.stubEnv('AGENT_ID', '');
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    expect(containerName()).toMatch(/^prism-agent-exec-[0-9a-f]{12}$/);
  });

  it('gives one deployment the same container back on every restart', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const first = containerName();
    vi.stubEnv('PRISM_DATA_DIR', otherDataDir);
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    expect(containerName()).toBe(first);
  });

  it('separates two runtimes that hold separate data', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const mine = containerName();
    vi.stubEnv('PRISM_DATA_DIR', otherDataDir);
    expect(containerName()).not.toBe(mine);
  });
});

describe('what the container can see', () => {
  it('serves the mounts derived from the data dir it was created with', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const environment = createDockerEnvironment();

    expect(environment.servesPath(path.join(dataDir, 'skills'))).toBe(true);
    expect(environment.servesPath(path.join(otherDataDir, 'skills'))).toBe(false);
  });

  it('leaves the data dir itself unserved, so no command reaches the database', () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    const environment = createDockerEnvironment();

    expect(environment.servesPath(path.join(dataDir, 'agent.db'))).toBe(false);
    expect(environment.servesPath(path.join(dataDir, 'media'))).toBe(false);
  });

  it("mounts the coding agent's home where an operator moved it", () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(os.tmpdir(), 'elsewhere-claude'));
    const environment = createDockerEnvironment();

    // Without this the CLI writes its sessions into a path the container has
    // no mount for, and loses them with the container.
    expect(environment.servesPath(path.join(os.tmpdir(), 'elsewhere-claude'))).toBe(true);
  });

  it('refuses to start when the workspace root swallows the data dir', async () => {
    vi.stubEnv('PRISM_DATA_DIR', dataDir);
    vi.stubEnv('SHELL_WORKSPACE_ROOT', path.dirname(dataDir));
    const environment = createDockerEnvironment();

    // The throw lands before the first mkdir, and the selector reads it as a
    // reason to stay local rather than hand the database over.
    await expect(environment.start()).rejects.toThrow(/holds the runtime's own data directory/);
  });
});
