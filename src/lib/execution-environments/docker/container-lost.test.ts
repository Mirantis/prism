import { beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.fn();
vi.mock('../../../logger', () => ({ logger: { warn: (...args: unknown[]) => warn(...args) } }));

const { __resetContainerLostForTests, isContainerLost, reportIfContainerLost } = await import(
  './container-lost'
);

beforeEach(() => {
  warn.mockClear();
  __resetContainerLostForTests();
});

describe('isContainerLost', () => {
  it('recognises what Podman answers for a missing and a stopped container', () => {
    // Captured from a real engine behind the `docker` shim.
    expect(
      isContainerLost(
        'Error response from daemon: no container with name or ID "prism-agent-exec-abc" found: no such container',
      ),
    ).toBe(true);
    expect(
      isContainerLost(
        'Error response from daemon: can only create exec sessions on running containers: container state improper',
      ),
    ).toBe(true);
  });

  it("recognises Docker's wording too", () => {
    expect(isContainerLost('Error response from daemon: No such container: prism-agent-exec-abc')).toBe(true);
    expect(isContainerLost('Error response from daemon: container 1a2b is not running')).toBe(true);
  });

  it("does not mistake a command's own failure for it", () => {
    expect(isContainerLost("cat: /prism/workspace/nope: No such file or directory")).toBe(false);
    expect(isContainerLost('bash: line 1: foo: command not found')).toBe(false);
  });
});

describe('reportIfContainerLost', () => {
  it('warns once, naming the container, however many calls then fail', () => {
    const said = 'Error response from daemon: No such container: prism-agent-exec-abc';
    reportIfContainerLost('prism-agent-exec-abc', said);
    reportIfContainerLost('prism-agent-exec-abc', said);
    reportIfContainerLost('prism-agent-exec-abc', said);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ container: 'prism-agent-exec-abc' });
  });

  it("stays quiet for a command's own error", () => {
    reportIfContainerLost('prism-agent-exec-abc', 'grep: no match');
    expect(warn).not.toHaveBeenCalled();
  });
});
