/**
 * Both environments start every command through `agentProcesses`, so a secure
 * takeover suspends whatever the agent runs, wherever it runs it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeChild } from '../../test-utils/fake-child';
import type { ExecProcess } from './execution-environment';

const { track } = vi.hoisted(() => ({
  track: vi.fn((start: () => ExecProcess, _withStdin: boolean) => start()),
}));
vi.mock('../agent-processes', () => ({ agentProcesses: { track } }));
vi.mock('./docker/docker-process', () => ({
  runDockerShell: () => new FakeChild().asExecProcess(),
  runDockerProgram: () => new FakeChild().asExecProcess(),
}));

const { createLocalEnvironment } = await import('./local/local-environment');
const { createDockerEnvironment } = await import('./docker/docker-environment');

const options = { cwd: '/', env: {}, stdin: 'pipe' as const };

beforeEach(() => {
  track.mockClear();
});

describe.each([
  ['local', createLocalEnvironment],
  ['docker', createDockerEnvironment],
])('the %s environment', (_name, create) => {
  it('hands a shell command to agentProcesses', () => {
    create().runShell('true', options);
    expect(track).toHaveBeenCalledOnce();
    expect(track.mock.calls[0][1]).toBe(true);
  });

  it('hands a program to agentProcesses', () => {
    create().runProgram('true', [], { ...options, stdin: 'ignore' });
    expect(track).toHaveBeenCalledOnce();
    expect(track.mock.calls[0][1]).toBe(false);
  });
});
