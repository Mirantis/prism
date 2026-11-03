import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setSubscription: vi.fn(async () => {}),
  usesSubscription: vi.fn(() => false),
  subscriptionForced: vi.fn(() => false),
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
  subscriptionForced: mocks.subscriptionForced,
}));
vi.mock('../../lib/coding-agents/availability', () => ({ redetectCodingAgents: mocks.redetect }));
vi.mock('../../lib/coding-agents/get-coding-agent', () => ({
  getCodingAgent: () => ({ prepareHome: mocks.prepareHome }),
}));
vi.mock('./coding-agent-sign-in-request.service', () => ({
  codingAgentSignInRequestService: { signedIn: mocks.signedIn },
  NAMES: { 'claude-code': 'Claude Code', codex: 'Codex' },
  PROVIDERS: { 'claude-code': 'Claude', codex: 'ChatGPT' },
}));
vi.mock('./coding-agent-account', () => ({
  homeOf: (_env: unknown, agent: string) => `/data/${agent}`,
  readAccount: vi.fn(),
  signOutCli: vi.fn(),
  cliInstalled: vi.fn(),
}));
vi.mock('../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

import { trackEvent } from '../../lib/telemetry';
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

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** The statuses `coding agent sign-in finished` was counted with. */
const finishedStatuses = () =>
  vi
    .mocked(trackEvent)
    .mock.calls.filter(([name]) => name === 'coding agent sign-in finished')
    .map(([, , props]) => (props as { status: string }).status);

describe('codingAgentSignInService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usesSubscription.mockReturnValue(false);
    mocks.subscriptionForced.mockReturnValue(false);
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
    expect(mocks.redetect).toHaveBeenCalled();
    expect(row).toMatchObject({ agent: 'claude-code', subscription: false, forced: false, account: null, attempt: null });
  });

  it('marks a coding agent the environment holds on the subscription, which a sign-out leaves on', async () => {
    mocks.subscriptionForced.mockImplementation(((agent: string) => agent === 'codex') as never);
    mocks.usesSubscription.mockImplementation(((agent: string) => agent === 'codex') as never);
    signInDeps.readAccount = vi.fn(async () => null);

    const row = await service.signOut('codex');

    expect(mocks.setSubscription).toHaveBeenCalledWith('codex', false);
    expect(row).toMatchObject({ agent: 'codex', subscription: true, forced: true, account: null });
    expect((await service.row('claude-code')).forced).toBe(false);
  });

  describe('a sign-out during the check of a sign-in', () => {
    it('keeps Claude signed out when the check answers after it', async () => {
      const probe = deferred<'subscription'>();
      signInDeps.readSavedLogin = vi.fn(() => probe.promise);
      const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
      signInDeps.startCliSignIn = vi.fn(() => cli);
      const attempt = await service.start('claude-code');
      const checked = service.submitCode(attempt.id, 'code');
      end('exited');
      await flush();

      const signedOut = service.signOut('claude-code');
      probe.resolve('subscription');
      await Promise.all([checked, signedOut]);
      await flush();

      expect(mocks.setSubscription.mock.calls).toEqual([['claude-code', false]]);
      expect(mocks.signedIn).not.toHaveBeenCalled();
      expect(finishedStatuses()).toEqual(['signed_out']);
    });

    it("keeps Codex signed out when its own check answers after it", async () => {
      const probe = deferred<'chatgpt'>();
      signInDeps.readCodexLogin = vi.fn(() => probe.promise);
      const { cli, end } = fakeCli({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' });
      signInDeps.startCliSignIn = vi.fn(() => cli);
      await service.start('codex');
      end('exited');
      await flush();
      expect(signInDeps.readCodexLogin).toHaveBeenCalled();

      const signedOut = service.signOut('codex');
      probe.resolve('chatgpt');
      await signedOut;
      await flush();

      expect(mocks.setSubscription.mock.calls).toEqual([['codex', false]]);
      expect(mocks.signedIn).not.toHaveBeenCalled();
    });

    it('signs out after a sign-in that the check already confirmed, and continues nothing', async () => {
      const redetected = deferred<void>();
      mocks.redetect.mockImplementationOnce(() => redetected.promise);
      const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
      signInDeps.startCliSignIn = vi.fn(() => cli);
      const attempt = await service.start('claude-code');
      const checked = service.submitCode(attempt.id, 'code');
      end('exited');
      await expect(checked).resolves.toMatchObject({ status: 'signed_in' });

      const signedOut = service.signOut('claude-code');
      redetected.resolve();
      await signedOut;
      await flush();

      expect(mocks.setSubscription.mock.calls).toEqual([
        ['claude-code', true],
        ['claude-code', false],
      ]);
      expect(mocks.signedIn).not.toHaveBeenCalled();
    });
  });

  it('counts an attempt that a newer one replaced before its link as replaced, not failed', async () => {
    const first = fakeCli({ url: 'https://claude.com/1', userCode: null });
    let failPrompt!: (err: Error) => void;
    first.cli.prompt = new Promise((_, reject) => (failPrompt = reject));
    first.cli.kill = () => failPrompt(new Error('killed'));
    const second = fakeCli({ url: 'https://claude.com/2', userCode: null });
    signInDeps.startCliSignIn = vi.fn().mockReturnValueOnce(first.cli).mockReturnValueOnce(second.cli);

    const [old] = await Promise.all([service.start('claude-code'), service.start('claude-code')]);

    expect(old.status).not.toBe('failed');
    expect(finishedStatuses()).toEqual(['replaced']);
  });

  it('counts an attempt that a sign-out ended', async () => {
    const { cli } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
    signInDeps.startCliSignIn = vi.fn(() => cli);
    await service.start('claude-code');
    await service.signOut('claude-code');
    expect(finishedStatuses()).toEqual(['signed_out']);
  });

  it('checks the login once more when the first check gets no answer', async () => {
    signInDeps.readSavedLogin = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude auth status did not answer in 10 s'))
      .mockResolvedValueOnce('subscription');
    const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
    signInDeps.startCliSignIn = vi.fn(() => cli);
    const attempt = await service.start('claude-code');
    const checked = service.submitCode(attempt.id, 'code');
    end('exited');
    await expect(checked).resolves.toMatchObject({ status: 'signed_in' });
    expect(signInDeps.signOutCli).not.toHaveBeenCalled();
  });

  it('removes the login when the check never answers, so none is left with the subscription off', async () => {
    signInDeps.readSavedLogin = vi.fn(async () => {
      throw new Error('claude auth status did not answer in 10 s');
    });
    const { cli, end } = fakeCli({ url: 'https://claude.com/auth', userCode: null });
    signInDeps.startCliSignIn = vi.fn(() => cli);
    const attempt = await service.start('claude-code');
    const checked = service.submitCode(attempt.id, 'code');
    end('exited');
    await expect(checked).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('claude.ai') });
    expect(signInDeps.readSavedLogin).toHaveBeenCalledTimes(2);
    expect(signInDeps.signOutCli).toHaveBeenCalledWith(expect.anything(), 'claude-code');
    expect(mocks.setSubscription).not.toHaveBeenCalled();
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
