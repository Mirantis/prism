import { describe, it, expect } from 'vitest';
import { config } from '../../config';
import { getCodingAgent } from './get-coding-agent';

describe('getCodingAgent', () => {
  it('returns the adapter the config names, once per process', () => {
    config.codingAgent = 'claude-code';
    const agent = getCodingAgent();
    expect(agent.id).toBe('claude-code');
    expect(agent.displayName).toBe('Claude Code');
    // The instance that prepares the home at boot is the one that runs tasks.
    expect(getCodingAgent()).toBe(agent);
  });
});
