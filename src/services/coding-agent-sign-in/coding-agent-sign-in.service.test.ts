import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSubscription: vi.fn(async () => {}),
  usesSubscription: vi.fn(() => false),
  redetect: vi.fn(async () => {}),
  signedIn: vi.fn(async () => {}),
  prepareHome: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));

vi.mock('../../lib/execution-environments/get-execution-environment', () => ({
  getExecutionEnvironment: () => ({
    baseEnv: () => ({}),
    paths: () => ({ claudeHome: '/data/.claude', codexHome: '/data/.codex' }),
    files: { mkdir: mocks.mkdir },
  }),
}));
vi.mock('../../lib/coding-agents/subscription-switch', () => ({
  setSubscription: mocks.setSubscription,
  usesSubscription: mocks.usesSubscription,
}));
vi.mock('../../lib/coding-agents/availability', () => ({ redetectCodingAgents: mocks.redetect }));
vi.mock('../../lib/coding-agents/get-coding-agent', () => ({
  getCodingAgent: () => ({ prepareHome: mocks.prepareHome }),
}));
vi.mock('./coding-agent-sign-in-request.service', () => ({
  codingAgentSignInRequestService: { signedIn: mocks.signedIn },
}));
vi.mock('./coding-agent-account', () => ({
  homeOf: (_env: unknown, agent: string) => `/data/${agent}`,
  readAccount: vi.fn(),
  signOutCli: vi.fn(),
  cliInstalled: vi.fn(),
}));
vi.mock('../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

import type { SignInEnd, CliSignIn } from './cli-sign-in';
import {
  codingAgentSignInService as service,
  signInDeps,
  SignInClosedError,
  SignInUnavailableError,
} from './coding-agent-sign-in.service';

/** A CLI sign-in whose output and end the test decides. */
function fakeCli(prompt: { url: string; userCode: string | null } | Error) {
  let end!: (value: SignInEnd) => void;
  const ended = new Promise<SignInEnd>((resolve) => (end = resolve));
  const cli: CliSignIn & { codes: string[]; killed: boolean } = {
    prompt: prompt instanceof Error ? Promise.reject(prompt) : Promise.resolve(prompt),
    ended,
    codes: [],
    killed: false,
    submitCode: (code) => cli.codes.push(code),
    kill: () => {
      cli.killed = true;
      end('failed');
    },
  };
  void cli.prompt.catch(() => end('failed'));
  return { cli, end };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('codingAgentSignInService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInDeps.cliInstalled = vi.fn(async () => true);
    signInDeps.readSavedLogin = vi.fn(async () => 'subscription' as const);
    signInDeps.readCodexLogin = vi.fn(async () => 'chatgpt' as const);
    signInDeps.signOutCli = vi.fn(async () => {});
    signInDeps.readAccount = vi.fn(async () => ({ email: 'a@example.com', plan: 'Claude Max' }));
  });

  afterEach(async () => {
    // Each test leaves its attempts running; sign-out ends them.
    await service.signOut('claude-code');
    await service.signOut('codex');
  });

  it('signs Claude in with the code the person pastes, and turns the subscription on', async () => {
    const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
    signInDeps.startCliSignIn = vi.fn(() => cli);

    const attempt = await service.start('claude-code');
    expect(attempt).toMatchObject({ status: 'waiting', url: 'https://claude.com/auth', userCode: null });

    const checked = service.submitCode(attempt.id, 'the-code');
    expect(cli.codes).toEqual(['the-code']);
    end('exited');
    await expect(checked).resolves.toMatchObject({ status: 'signed_in', error: null });
    expect(mocks.setSubscription).toHaveBeenCalledWith('claude-code', true);
    await flush();
    expect(mocks.redetect).toHaveBeenCalled();
  });

  it('fails a refused code with a fresh-link message, and leaves the switch alone', async () => {
    const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
    signInDeps.startCliSignIn = vi.fn(() => cli);
    const attempt = await service.start('claude-code');

    const checked = service.submitCode(attempt.id, 'wrong');
    end('invalid_code');
    await expect(checked).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('Get a new link') });
    expect(mocks.setSubscription).not.toHaveBeenCalled();
  });

  it('refuses an account without a subscription', async () => {
    signInDeps.readSavedLogin = vi.fn(async () => 'none' as const);
    const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
    signInDeps.startCliSignIn = vi.fn(() => cli);
    const attempt = await service.start('claude-code');

    const checked = service.submitCode(attempt.id, 'code');
    end('exited');
    await expect(checked).resolves.toMatchObject({ status: 'failed', error: 'That account has no Claude subscription.' });
    expect(mocks.setSubscription).not.toHaveBeenCalled();
  });

  it('closes an older attempt when a new one starts, so its code cannot land', async () => {
    const first = fakeCli({ url: 'https://claude.com/1', userCode: null });
    const second = fakeCli({ url: 'https://claude.com/2', userCode: null });
    signInDeps.startCliSignIn = vi.fn().mockReturnValueOnce(first.cli).mockReturnValueOnce(second.cli);

    const old = await service.start('claude-code');
    const current = await service.start('claude-code');
    expect(first.cli.killed).toBe(true);
    expect(service.get('claude-code', old.id)).toBeNull();
    await expect(service.submitCode(old.id, 'code')).rejects.toBeInstanceOf(SignInClosedError);
    expect(second.cli.codes).toEqual([]);
    expect(service.get('claude-code', current.id)).toMatchObject({ status: 'waiting' });
  });

  it('ends the first of two sign-ins started at once', async () => {
    const first = fakeCli({ url: 'https://claude.com/1', userCode: null });
    const second = fakeCli({ url: 'https://claude.com/2', userCode: null });
    signInDeps.startCliSignIn = vi.fn().mockReturnValueOnce(first.cli).mockReturnValueOnce(second.cli);

    await Promise.all([service.start('claude-code'), service.start('claude-code')]);
    expect(first.cli.killed).toBe(true);
    expect(second.cli.killed).toBe(false);
  });

  it('confirms a Codex sign-in when the device-code command exits', async () => {
    const { cli, end } = fakeCli({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' });
    signInDeps.startCliSignIn = vi.fn(() => cli);

    const attempt = await service.start('codex');
    expect(attempt).toMatchObject({ status: 'waiting', userCode: 'ABCD-EFGH' });
    end('exited');
    await flush();
    expect(service.get('codex', attempt.id)).toMatchObject({ status: 'signed_in' });
    expect(mocks.setSubscription).toHaveBeenCalledWith('codex', true);
  });

  it('names the hosts to allow when the CLI shows no link', async () => {
    const { cli } = fakeCli(new Error('ended before it showed a link'));
    signInDeps.startCliSignIn = vi.fn(() => cli);

    const attempt = await service.start('codex');
    expect(attempt.status).toBe('failed');
    expect(attempt.error).toContain('auth.openai.com');
  });

  it('expires a link nobody finished', async () => {
    vi.useFakeTimers();
    try {
      const { cli } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
      signInDeps.startCliSignIn = vi.fn(() => cli);
      const attempt = await service.start('claude-code');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(service.get('claude-code', attempt.id)).toMatchObject({ status: 'expired' });
      expect(cli.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a sign-in for a coding agent this runtime does not have', async () => {
    signInDeps.cliInstalled = vi.fn(async () => false);
    await expect(service.start('codex')).rejects.toBeInstanceOf(SignInUnavailableError);
  });

  it('signs out and puts tasks back on the deployment models', async () => {
    const row = await service.signOut('claude-code');
    expect(signInDeps.signOutCli).toHaveBeenCalled();
    expect(mocks.setSubscription).toHaveBeenCalledWith('claude-code', false);
    expect(row).toMatchObject({ agent: 'claude-code', subscription: false, account: null, attempt: null });
  });

  it('lists the account only while the subscription is on', async () => {
    mocks.usesSubscription.mockImplementation(((agent: string) => agent === 'claude-code') as never);
    const rows = await service.list();
    expect(rows.map((r) => [r.agent, r.subscription, r.account?.plan ?? null])).toEqual([
      ['claude-code', true, 'Claude Max'],
      ['codex', false, null],
    ]);
  });
});
