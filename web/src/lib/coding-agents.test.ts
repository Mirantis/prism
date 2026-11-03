import { describe, it, expect } from 'vitest';
import { codingAgentSignInSearch } from './coding-agents';

describe('codingAgentSignInSearch', () => {
  it('opens the sign-in from a link that still has the request id', () => {
    expect(codingAgentSignInSearch({ agent: 'codex', 'sign-in': '3b241101-e2bb-4255-8caf-4136c566a962' })).toEqual({
      agent: 'codex',
    });
  });

  it('opens nothing for an unknown coding agent', () => {
    expect(codingAgentSignInSearch({ agent: 'other' })).toEqual({});
  });
});
