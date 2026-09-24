import { afterEach, describe, expect, it } from 'vitest';
import { fakeExecutionEnvironment } from '../../test-utils/fake-execution-environment';
import {
  __resetExecutionEnvironmentDetectionForTests,
  __setExecutionEnvironmentForTests,
  filesFor,
  getExecutionEnvironment,
  getExecutionEnvironmentFor,
  getHostEnvironment,
} from './get-execution-environment';

afterEach(() => __resetExecutionEnvironmentDetectionForTests());

describe('getExecutionEnvironment', () => {
  it('serves the local environment until a probe says otherwise', () => {
    // Selection is async and this accessor is not, so `local` is what every
    // caller before boot gets — which is also what keeps the fourteen existing
    // call sites synchronous.
    expect(getExecutionEnvironment().id).toBe('local');
  });

  it('serves one instance, so every caller shares its state', () => {
    expect(getExecutionEnvironment()).toBe(getExecutionEnvironment());
  });

  it('stands in a test environment, and restores the real one', () => {
    const fake = fakeExecutionEnvironment({ workspaceRoot: '/elsewhere' });
    __setExecutionEnvironmentForTests(fake);
    expect(getExecutionEnvironment()).toBe(fake);
    __setExecutionEnvironmentForTests(null);
    expect(getExecutionEnvironment().displayName).toBe('local');
  });
});

describe('getExecutionEnvironmentFor', () => {
  it('uses the selected environment for a path it serves', () => {
    const served = fakeExecutionEnvironment({ servesPath: () => true });
    __setExecutionEnvironmentForTests(served);
    expect(getExecutionEnvironmentFor('/data/workspace')).toBe(served);
  });

  it('falls back to local for a path the environment cannot reach', () => {
    // A thread the terminal UI started in a repository: its root was never
    // mounted, because the container's mounts were fixed when it was created.
    __setExecutionEnvironmentForTests(fakeExecutionEnvironment({ servesPath: () => false }));
    expect(getExecutionEnvironmentFor('/Users/me/dev/repo').id).toBe('local');
  });

  it('uses the selected environment when no path is given', () => {
    // No cwd means the environment's own root, which it serves by definition.
    const served = fakeExecutionEnvironment({ servesPath: () => false });
    __setExecutionEnvironmentForTests(served);
    expect(getExecutionEnvironmentFor(undefined)).toBe(served);
  });

  it('hands every unreachable path the same local environment', () => {
    __setExecutionEnvironmentForTests(fakeExecutionEnvironment({ servesPath: () => false }));
    expect(getExecutionEnvironmentFor('/a')).toBe(getExecutionEnvironmentFor('/b'));
  });
});

describe('filesFor', () => {
  it('reads a path the environment serves through that environment', () => {
    const served = fakeExecutionEnvironment({ servesPath: (p) => p.startsWith('/prism') });
    __setExecutionEnvironmentForTests(served);
    expect(filesFor('/prism/skills')).toBe(served.files);
  });

  it('reads any other path on this machine', () => {
    // A thread the terminal UI started in a repository: its files, like its
    // commands, are on the host, even while the deployment runs in a container.
    const served = fakeExecutionEnvironment({ servesPath: (p) => p.startsWith('/prism') });
    __setExecutionEnvironmentForTests(served);
    expect(filesFor('/Users/me/dev/repo/.claude/skills')).toBe(getHostEnvironment().files);
    expect(filesFor('/Users/me/dev/repo/.claude/skills')).not.toBe(served.files);
  });
});
