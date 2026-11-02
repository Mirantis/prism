/**
 * Signing a coding agent in to the person's own Claude or ChatGPT
 * subscription, and out again.
 *
 * One attempt per coding agent at a time, held in memory: starting another
 * ends the one before, so an old link or code can never complete a newer
 * sign-in, and a restart ends them all. The code Claude shows goes from the
 * person's sheet to the CLI's stdin. Nothing stores, logs or shows it to a
 * model.
 */

import { randomUUID } from 'node:crypto';
import { config, CODING_AGENTS, type CodingAgentName } from '../../config';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import { getExecutionEnvironment } from '../../lib/execution-environments/get-execution-environment';
import { readSavedLogin } from '../../lib/coding-agents/claude-code/authenticated-home';
import { readCodexLogin } from '../../lib/coding-agents/codex/credentials';
import { redetectCodingAgents } from '../../lib/coding-agents/availability';
import { getCodingAgent } from '../../lib/coding-agents/get-coding-agent';
import { setSubscription, usesSubscription } from '../../lib/coding-agents/subscription-switch';
import { startCliSignIn, type CliSignIn } from './cli-sign-in';
import { cliInstalled, homeOf, readAccount, signOutCli, type SubscriptionAccount } from './coding-agent-account';
import { codingAgentSignInRequestService, NAMES } from './coding-agent-sign-in-request.service';

export type AttemptStatus = 'waiting' | 'checking' | 'signed_in' | 'failed' | 'expired';

export interface SignInAttempt {
  id: string;
  agent: CodingAgentName;
  status: AttemptStatus;
  url: string | null;
  userCode: string | null;
  expiresAt: string;
  error: string | null;
}

export interface CodingAgentRow {
  agent: CodingAgentName;
  name: string;
  available: boolean;
  subscription: boolean;
  account: SubscriptionAccount | null;
  attempt: SignInAttempt | null;
}

/** A sign-in the coding agent's CLI cannot run here. */
export class SignInUnavailableError extends Error {}
/** A code for an attempt that is not waiting for one. */
export class SignInClosedError extends Error {}

/** The hosts a sign-in and the tasks after it reach, named when one fails. */
const HOSTS: Record<CodingAgentName, string> = {
  'claude-code': 'platform.claude.com, api.anthropic.com and claude.ai',
  codex: 'auth.openai.com, chatgpt.com and api.openai.com',
};

/** How long a link stays good. Codex's own code lasts 15 minutes; Claude's is not stated. */
export const ATTEMPT_TTL_MS = 10 * 60_000;
/** How long the CLI gets to print its link. */
const PROMPT_TIMEOUT_MS = 30_000;
/** How long the CLI gets to check Claude's code. */
const CODE_TIMEOUT_MS = 60_000;

const failedMessage = (agent: CodingAgentName) =>
  `The sign-in didn't finish. If it keeps failing, check that the agent's website access allows ${HOSTS[agent]}.`;

interface Running {
  attempt: SignInAttempt;
  cli: CliSignIn;
  startedAt: number;
  timer: NodeJS.Timeout;
}

/** The CLI module seam, replaced in tests. */
export const signInDeps = { startCliSignIn, readAccount, signOutCli, cliInstalled, readSavedLogin, readCodexLogin };

class CodingAgentSignInService {
  private running = new Map<CodingAgentName, Running>();

  async list(): Promise<CodingAgentRow[]> {
    return Promise.all(CODING_AGENTS.map((agent) => this.row(agent)));
  }

  async row(agent: CodingAgentName): Promise<CodingAgentRow> {
    const environment = getExecutionEnvironment();
    const subscription = usesSubscription(agent);
    const [available, account] = await Promise.all([
      signInDeps.cliInstalled(environment, agent),
      subscription ? signInDeps.readAccount(environment, agent) : null,
    ]);
    // A finished attempt is read by its id; the row lists only one still under way.
    const running = this.running.get(agent)?.attempt;
    const attempt = running && (running.status === 'waiting' || running.status === 'checking') ? running : null;
    return { agent, name: NAMES[agent], available, subscription, account, attempt };
  }

  get(agent: CodingAgentName, id: string): SignInAttempt | null {
    const attempt = this.running.get(agent)?.attempt;
    return attempt?.id === id ? attempt : null;
  }

  /** Starts a sign-in, ending any earlier one, and answers once the CLI shows its link. */
  async start(agent: CodingAgentName): Promise<SignInAttempt> {
    const environment = getExecutionEnvironment();
    if (!(await signInDeps.cliInstalled(environment, agent))) {
      throw new SignInUnavailableError(`${NAMES[agent]} isn't available on this agent.`);
    }
    const home = homeOf(environment, agent);
    // Codex refuses a home that does not exist yet.
    await environment.files.mkdir(home).catch(() => {});
    // No await from here to `running.set`, so two starts at once can't both
    // find the slot empty and leave one CLI that nothing ends.
    this.end(agent);
    const cli = signInDeps.startCliSignIn(environment, agent, home);
    const startedAt = Date.now();
    const attempt: SignInAttempt = {
      id: randomUUID(),
      agent,
      status: 'checking',
      url: null,
      userCode: null,
      expiresAt: new Date(startedAt + ATTEMPT_TTL_MS).toISOString(),
      error: null,
    };
    const timer = setTimeout(() => this.expire(agent, attempt.id), ATTEMPT_TTL_MS);
    timer.unref?.();
    const running: Running = { attempt, cli, startedAt, timer };
    this.running.set(agent, running);
    trackEvent('coding agent sign-in started', config.ownerUserId, { 'coding_agent.name': agent });

    let promptTimer: NodeJS.Timeout | undefined;
    try {
      const prompt = await Promise.race([
        cli.prompt,
        new Promise<never>((_, reject) => {
          promptTimer = setTimeout(() => reject(new Error('no sign-in link in time')), PROMPT_TIMEOUT_MS);
        }),
      ]);
      Object.assign(attempt, { status: 'waiting', url: prompt.url, userCode: prompt.userCode });
    } catch (err) {
      logger.warn({ err, agent }, '[CodingAgents] Sign-in showed no link');
      this.finish(running, 'failed', failedMessage(agent));
      return attempt;
    } finally {
      clearTimeout(promptTimer);
    }
    // Codex's command ends once the person has entered the code on OpenAI's page;
    // Claude's ends on its own only when something went wrong.
    void cli.ended.then((end) => {
      // A newer attempt that replaced this one ended it; that is no failure.
      if (attempt.status !== 'waiting' || this.running.get(agent) !== running) return;
      if (agent === 'codex' && end === 'exited') {
        attempt.status = 'checking';
        void this.confirm(running);
      } else this.finish(running, 'failed', failedMessage(agent));
    });
    return attempt;
  }

  /** Claude's code, typed into the waiting CLI. Answers once the CLI has taken it or refused it. */
  async submitCode(id: string, code: string): Promise<SignInAttempt> {
    const running = this.running.get('claude-code');
    if (!running || running.attempt.id !== id || running.attempt.status !== 'waiting') {
      throw new SignInClosedError('That sign-in is closed. Get a new link.');
    }
    running.attempt.status = 'checking';
    running.cli.submitCode(code);
    let codeTimer: NodeJS.Timeout | undefined;
    const end = await Promise.race([
      running.cli.ended,
      new Promise<'timeout'>((resolve) => {
        codeTimer = setTimeout(() => resolve('timeout'), CODE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(codeTimer);
    if (end === 'exited') await this.confirm(running);
    else if (end === 'invalid_code') {
      this.finish(running, 'failed', "That code didn't work. Get a new link and paste the code it shows.");
    } else this.finish(running, 'failed', failedMessage('claude-code'));
    return running.attempt;
  }

  /** Signs the CLI out and puts coding tasks back on the deployment's models. */
  async signOut(agent: CodingAgentName): Promise<CodingAgentRow> {
    this.end(agent);
    await signInDeps.signOutCli(getExecutionEnvironment(), agent);
    await setSubscription(agent, false);
    trackEvent('coding agent signed out', config.ownerUserId, { 'coding_agent.name': agent });
    return this.row(agent);
  }

  /** Whether the CLI's home now holds the subscription the person signed in to. */
  private async confirm(running: Running): Promise<void> {
    const { agent } = running.attempt;
    const environment = getExecutionEnvironment();
    const home = homeOf(environment, agent);
    try {
      const signedIn =
        agent === 'claude-code'
          ? (await signInDeps.readSavedLogin(environment, environment.baseEnv(), home)) === 'subscription'
          : (await signInDeps.readCodexLogin(environment, environment.baseEnv(), home)) === 'chatgpt';
      if (!signedIn) {
        this.finish(running, 'failed', `That account has no ${agent === 'claude-code' ? 'Claude' : 'ChatGPT'} subscription.`);
        return;
      }
      await setSubscription(agent, true);
    } catch (err) {
      logger.warn({ err, agent }, '[CodingAgents] Could not confirm the sign-in');
      this.finish(running, 'failed', failedMessage(agent));
      return;
    }
    this.finish(running, 'signed_in', null);
    void this.afterSignIn(agent);
  }

  private async afterSignIn(agent: CodingAgentName): Promise<void> {
    try {
      await redetectCodingAgents();
      if (config.availableCodingAgents.includes(agent)) await getCodingAgent(agent).prepareHome();
      if (config.agentId) {
        await codingAgentSignInRequestService.signedIn(config.agentId, config.ownerUserId, agent);
      }
    } catch (err) {
      logger.error({ err, agent }, '[CodingAgents] After sign-in failed');
    }
  }

  private expire(agent: CodingAgentName, id: string): void {
    const running = this.running.get(agent);
    if (running?.attempt.id !== id || running.attempt.status !== 'waiting') return;
    this.finish(running, 'expired', null);
  }

  /** Ends the agent's attempt, if one is running, without a trace in its status. */
  private end(agent: CodingAgentName): void {
    const running = this.running.get(agent);
    if (!running) return;
    this.running.delete(agent);
    clearTimeout(running.timer);
    running.cli.kill();
  }

  private finish(running: Running, status: AttemptStatus, error: string | null): void {
    if (['signed_in', 'failed', 'expired'].includes(running.attempt.status)) return;
    Object.assign(running.attempt, { status, error });
    clearTimeout(running.timer);
    if (status !== 'signed_in') running.cli.kill();
    trackEvent('coding agent sign-in finished', config.ownerUserId, {
      'coding_agent.name': running.attempt.agent,
      status,
      elapsed_ms: String(Date.now() - running.startedAt),
    });
  }
}

export const codingAgentSignInService = new CodingAgentSignInService();
