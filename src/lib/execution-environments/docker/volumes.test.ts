import { describe, expect, it } from 'vitest';
import { CONTAINER_PATHS, purposes, servesPath, volumeMounts, volumeName } from './volumes';

describe('the volumes a deployment gets', () => {
  it('gives every agent directory one of its own', () => {
    const mounts = volumeMounts('abc123');
    expect(mounts).toHaveLength(purposes().length);
    expect(new Set(mounts.map((m) => m.name)).size).toBe(mounts.length);
    expect(new Set(mounts.map((m) => m.path)).size).toBe(mounts.length);
  });

  it('names them after the deployment, so two runtimes never share one', () => {
    expect(volumeName('abc123', 'workspaceRoot')).toBe('prism-exec-abc123-workspace-root');
    expect(volumeName('def456', 'workspaceRoot')).toBe('prism-exec-def456-workspace-root');
  });

  it('mounts each one at the path the image created', () => {
    const workspace = volumeMounts('abc123').find((m) => m.path === CONTAINER_PATHS.workspaceRoot);
    expect(workspace?.name).toBe('prism-exec-abc123-workspace-root');
    // Every path is under one root, which is what Dockerfile.exec creates and
    // makes writable for a container running as the runtime's uid.
    for (const mount of volumeMounts('abc123')) expect(mount.path.startsWith('/prism/')).toBe(true);
  });
});

describe('servesPath', () => {
  it('serves the container tree and nothing else', () => {
    expect(servesPath(CONTAINER_PATHS.workspaceRoot)).toBe(true);
    expect(servesPath(`${CONTAINER_PATHS.workspaceRoot}/repo/src`)).toBe(true);
    expect(servesPath(CONTAINER_PATHS.skillsDir)).toBe(true);
  });

  it('does not serve a path on this machine', () => {
    // The terminal UI's case: a thread rooted in a repository on the host,
    // which the container has no name for. It falls back to local.
    expect(servesPath('/Users/me/dev/repo')).toBe(false);
    expect(servesPath('/etc')).toBe(false);
    expect(servesPath('/data/agent.db')).toBe(false);
  });

  it('does not serve a sibling whose name merely starts the same', () => {
    expect(servesPath('/prismatic')).toBe(false);
    expect(servesPath('/prism-other/workspace')).toBe(false);
  });

  it('resolves a path before deciding, and refuses a relative one', () => {
    expect(servesPath('/prism/workspace/../skills')).toBe(true);
    expect(servesPath('/prism/workspace/../../etc')).toBe(false);
    // A relative path has no meaning without a cwd, and this process's cwd is
    // on the host.
    expect(servesPath('workspace')).toBe(false);
  });
});
