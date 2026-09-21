import { describe, expect, it } from 'vitest';
import { mountPaths, mountsExposing, servesPath, type ContainerPaths } from './mounts';

const paths: ContainerPaths = {
  workspaceRoot: '/data/workspace',
  skillsDir: '/data/skills',
  pluginsDir: '/data/plugins',
  toolOutputDir: '/data/tool-outputs',
  codingAgentHomes: ['/data/.claude', '/data/.codex'],
  runDir: '/data/exec-run',
  homeDir: '/data/exec-home',
};

describe('mountPaths', () => {
  it('mounts every path the agent reaches through a command', () => {
    expect(mountPaths(paths)).toEqual([
      '/data/.claude',
      '/data/.codex',
      '/data/exec-home',
      '/data/exec-run',
      '/data/plugins',
      '/data/skills',
      '/data/tool-outputs',
      '/data/workspace',
    ]);
  });

  it('leaves the database, the media store and the plugin scratch out', () => {
    const mounted = mountPaths(paths);
    expect(mounted).not.toContain('/data');
    for (const runtimeOwned of ['/data/agent.db', '/data/media', '/data/plugin-data']) {
      expect(servesPath(mounted, runtimeOwned)).toBe(false);
    }
  });

  it('drops a path an ancestor already covers', () => {
    // Mounting the same subtree twice is refused outright by some engines.
    const nested = mountPaths({ ...paths, runDir: '/data/workspace/exec-run' });
    expect(nested).not.toContain('/data/workspace/exec-run');
    expect(nested).toContain('/data/workspace');
  });

  it('mounts one path once when two of them are the same directory', () => {
    const shared = mountPaths({ ...paths, runDir: paths.homeDir });
    expect(shared.filter((p) => p === '/data/exec-home')).toHaveLength(1);
  });
});

describe('mountsExposing', () => {
  it('finds nothing in the ordinary mount set', () => {
    expect(mountsExposing(mountPaths(paths), '/data')).toEqual([]);
  });

  it('names the mount that swallowed the data dir', () => {
    // A workspace root at or above the data dir collapses every other mount
    // into itself, and that one carries the database. `mountPaths` cannot
    // refuse it — a nested path is dropped for good reasons — so the caller
    // asks this before it creates a container.
    expect(mountsExposing(mountPaths({ ...paths, workspaceRoot: '/data' }), '/data')).toEqual([
      '/data',
    ]);
    expect(mountsExposing(mountPaths({ ...paths, workspaceRoot: '/' }), '/data')).toEqual(['/']);
  });

  it('leaves a sibling whose name merely starts the same alone', () => {
    expect(mountsExposing(['/data-backup', '/data/skills'], '/data')).toEqual([]);
  });
});

describe('servesPath', () => {
  const mounts = mountPaths(paths);

  it('serves a mount itself and anything under it', () => {
    expect(servesPath(mounts, '/data/workspace')).toBe(true);
    expect(servesPath(mounts, '/data/workspace/repo/src')).toBe(true);
  });

  it('does not serve a sibling whose name merely starts the same', () => {
    // The separator is the whole point: `/data/skills-other` is a different
    // directory that string-prefix matching would hand to the container.
    expect(servesPath(mounts, '/data/skills-other')).toBe(false);
    expect(servesPath(mounts, '/data/workspace-backup/x')).toBe(false);
  });

  it('does not serve a path outside every mount', () => {
    // This is the terminal UI's case: a thread rooted in a repository on the
    // host, which the container was not created with.
    expect(servesPath(mounts, '/Users/me/dev/repo')).toBe(false);
    expect(servesPath(mounts, '/etc')).toBe(false);
  });

  it('resolves a relative or unnormalized path before deciding', () => {
    expect(servesPath(mounts, '/data/workspace/../skills')).toBe(true);
    expect(servesPath(mounts, '/data/workspace/../../etc')).toBe(false);
  });
});
