/**
 * Every coding agent, built the way the runtime builds it, starts its CLI through
 * `agentProcesses`, so a secure takeover suspends a running task.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeChild } from '../../test-utils/fake-child';
import { config } from '../../config';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../agent-processes', () => ({ agentProcesses: { spawn } }));
vi.mock('../telemetry', () => ({ trackEvent: vi.fn() }));

import { getCodingAgent } from './get-coding-agent';
import type { CodingAgentTask } from './coding-agent';

const task: CodingAgentTask = {
  taskId: 't1',
  prompt: 'do X',
  env: { PATH: '/bin' },
  mode: 'edit',
  maxTurns: 100,
  gateMode: 'off',
};

const originalAvailable = config.availableCodingAgents;
afterEach(() => {
  config.availableCodingAgents = originalAvailable;
  spawn.mockReset();
});

describe('a coding agent built by the runtime', () => {
  it.each(['claude-code', 'codex'] as const)('starts %s through agentProcesses', (id) => {
    config.availableCodingAgents = ['claude-code', 'codex'];
    spawn.mockImplementation(() => new FakeChild().asChildProcess());

    getCodingAgent(id).run(task);

    expect(spawn).toHaveBeenCalledOnce();
  });
});
