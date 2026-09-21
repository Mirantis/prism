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
});
