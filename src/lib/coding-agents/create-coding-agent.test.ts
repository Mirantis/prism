import { describe, it, expect } from 'vitest';
import { config } from '../../config';
import { createCodingAgent } from './create-coding-agent';

describe('createCodingAgent', () => {
  it('returns the adapter the config names', () => {
    config.codingAgent = 'claude-code';
    const agent = createCodingAgent();
    expect(agent.id).toBe('claude-code');
    expect(agent.displayName).toBe('Claude Code');
  });
});
