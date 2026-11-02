import { describe, expect, it, vi } from 'vitest';

const { environment } = vi.hoisted(() => ({
  environment: { id: 'local', paths: () => ({ claudeHome: '/data/.claude', codexHome: '/data/.codex' }) },
}));
vi.mock('../../lib/execution-environments/get-execution-environment', () => ({
  getExecutionEnvironment: () => environment,
}));

import { codingAgentHomesEnv } from './desktop-session';

describe('codingAgentHomesEnv', () => {
  it("points the terminal's coding agents at the homes tasks sign in to", () => {
    environment.id = 'local';
    expect(codingAgentHomesEnv()).toEqual({ CLAUDE_CONFIG_DIR: '/data/.claude', CODEX_HOME: '/data/.codex' });
  });

  it('leaves them alone when tasks run in another container', () => {
    environment.id = 'docker';
    expect(codingAgentHomesEnv()).toEqual({});
  });
});
