/**
 * Detection, through injected probes only.
 *
 * Nothing here asks the real engine: CI runners have Docker and developer
 * machines vary, so a case that shelled out would assert something different
 * on every host.
 */
import { describe, expect, it } from 'vitest';
import { detectEnvironment, type DetectionDeps } from './detect';

function deps(over: Partial<DetectionDeps> = {}): DetectionDeps {
  return {
    engineAnswers: () => Promise.resolve(false),
    clientInstalled: () => Promise.resolve(false),
    lastEnvironment: () => Promise.resolve(null),
    wait: () => Promise.resolve(),
    inContainer: () => false,
    configured: () => undefined,
    ...over,
  };
}

describe('detectEnvironment', () => {
  it('prefers Docker when an engine answers, with nothing configured', async () => {
    const detection = await detectEnvironment(deps({ engineAnswers: () => Promise.resolve(true) }));
    expect(detection).toEqual({
      name: 'docker',
      reason: 'a container engine answered',
      demanded: false,
    });
  });

  it('runs locally when no engine answers', async () => {
    expect(await detectEnvironment(deps())).toMatchObject({ name: 'local', demanded: false });
  });

  it('takes the operator over the probe, both ways', async () => {
    const forced = await detectEnvironment(
      deps({ configured: () => 'docker', engineAnswers: () => Promise.resolve(false) }),
    );
    // Demanded, so a failure to start must be reported rather than degraded.
    expect(forced).toEqual({
      name: 'docker',
      reason: 'EXECUTION_ENVIRONMENT=docker',
      demanded: true,
    });

    const refused = await detectEnvironment(
      deps({ configured: () => 'local', engineAnswers: () => Promise.resolve(true) }),
    );
    expect(refused).toMatchObject({ name: 'local', demanded: true });
  });

  it('runs locally on an unreadable setting, and says which one', async () => {
    const detection = await detectEnvironment(
      deps({ configured: () => 'podman', engineAnswers: () => Promise.resolve(true) }),
    );
    expect(detection.name).toBe('local');
    expect(detection.reason).toContain('podman');
    // Not demanded: the operator asked for something that does not exist, so
    // falling back is the answer rather than refusing to boot.
    expect(detection.demanded).toBe(false);
  });

  it('stays local when the runtime is itself in a container', async () => {
    // The published image is already the boundary and holds the toolchain; an
    // install that mounts an engine socket for some other reason must not have
    // its shell moved into a bare sibling.
    const detection = await detectEnvironment(
      deps({ inContainer: () => true, engineAnswers: () => Promise.resolve(true) }),
    );
    expect(detection).toMatchObject({
      name: 'local',
      reason: 'the runtime is already in a container',
    });
  });

  it('lets an operator opt into Docker from inside a container', async () => {
    const detection = await detectEnvironment(
      deps({ inContainer: () => true, configured: () => 'docker' }),
    );
    expect(detection).toMatchObject({ name: 'docker', demanded: true });
  });

  describe('when the last run used a container', () => {
    it('waits for an engine that is installed but still starting', async () => {
      let asked = 0;
      const detection = await detectEnvironment(
        deps({
          lastEnvironment: () => Promise.resolve('docker'),
          clientInstalled: () => Promise.resolve(true),
          // Down on the first probe and the first wait, up on the second.
          engineAnswers: () => Promise.resolve(++asked >= 3),
        }),
      );
      expect(detection).toEqual({
        name: 'docker',
        reason: 'a container engine answered after a wait',
        demanded: false,
      });
    });

    it('runs locally once the wait ends with no answer', async () => {
      const waits: number[] = [];
      const detection = await detectEnvironment(
        deps({
          lastEnvironment: () => Promise.resolve('docker'),
          clientInstalled: () => Promise.resolve(true),
          wait: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        }),
      );
      expect(detection).toMatchObject({ name: 'local', reason: 'the container engine did not answer' });
      // Bounded: the whole wait is a fixed number of polls.
      expect(waits.length).toBeGreaterThan(1);
      expect(waits.length).toBeLessThan(60);
    });

    it('does not wait when the client is not installed at all', async () => {
      let waited = false;
      const detection = await detectEnvironment(
        deps({
          lastEnvironment: () => Promise.resolve('docker'),
          wait: () => {
            waited = true;
            return Promise.resolve();
          },
        }),
      );
      // An uninstalled engine is not coming back, so boot is not held up.
      expect(detection).toMatchObject({ name: 'local', reason: 'no container engine' });
      expect(waited).toBe(false);
    });

    it('does not wait when the last run was local', async () => {
      let waited = false;
      await detectEnvironment(
        deps({
          lastEnvironment: () => Promise.resolve('local'),
          clientInstalled: () => Promise.resolve(true),
          wait: () => {
            waited = true;
            return Promise.resolve();
          },
        }),
      );
      expect(waited).toBe(false);
    });
  });
});
