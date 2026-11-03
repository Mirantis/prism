import { describe, expect, it } from 'vitest';
import { FakeChild } from '../../test-utils/fake-child';
import { fakeExecutionEnvironment } from '../../test-utils/fake-execution-environment';
import { planName, readAccount } from './coding-agent-account';

describe('planName', () => {
  it('names the plan the login reports', () => {
    expect(planName('Claude', 'max')).toBe('Claude Max');
    expect(planName('ChatGPT', 'plus')).toBe('ChatGPT Plus');
  });

  it('assumes no plan when the login names none', () => {
    expect(planName('ChatGPT', undefined)).toBe('ChatGPT plan');
    expect(planName('ChatGPT', ' ')).toBe('ChatGPT plan');
  });
});

describe('the Claude account', () => {
  /** An environment whose `claude auth status --json` prints `status`. */
  const printing = (status: object) =>
    fakeExecutionEnvironment({
      files: { stat: async () => ({ size: 0, mtimeMs: 0, isFile: false, isDirectory: true, isSymbolicLink: false }) },
      runProgram: () => {
        const child = new FakeChild();
        child.emitLine(JSON.stringify(status));
        process.nextTick(() => child.finish(0));
        return child.asExecProcess();
      },
    });

  it('names the subscription the saved login reports', async () => {
    const status = { loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', subscriptionType: 'max' };
    expect(await readAccount(printing(status), 'claude-code')).toEqual({ plan: 'Claude Max', email: 'user@example.com' });
  });

  it('names none for a saved login that is not a subscription', async () => {
    expect(await readAccount(printing({ loggedIn: true, authMethod: 'api_key' }), 'claude-code')).toBeNull();
  });
});
