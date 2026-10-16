import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';

import type { MessageTrigger } from '../message-delivery.service';
import { computerService, LOCAL_COMPUTER_ID } from './computer.service';
import type { ComputerSession } from './computer-session';
import type { ComputerCaller, ComputerUse } from './computer-access';
import type { ChannelName } from '../channel-adapter.interface';

export interface ComputerHelp {
  type: 'computer_help';
  id: string;
  reason: string;
  tab?: number;
  targetId?: string;
  /** The computer the work is blocked on; a request without one is about the runtime's own. */
  computerId?: string;
  /** The user answers this one with the credentials below, typed into `site`. */
  credentials?: true;
  /** What the page asks for. A second step of a sign-in asks for the password alone. */
  credentialFields?: 'both' | 'password';
  /** Where those go: the origin of the tab that asked, as it read when it asked. */
  site?: string;
  threadId?: string;
  originChannel?: ChannelName;
  originChannelId?: string;
  /** Asked by a background run with no conversation, so every channel got it and any turn answers it. */
  broadcast?: true;
  /** Asked by a run that waits for the answer, so that run continues the work itself. */
  requesterWaits?: true;
  status: 'waiting' | 'continued' | 'dismissed';
}

/** How long a background run waits for the user's answer before it goes on without one. */
export const HELP_ANSWER_WAIT_MS = 30 * 60_000;

/** What a run that waited for its help request learns. */
export type HelpAnswer = 'continued' | 'dismissed' | 'unanswered';

/**
 * `repeated` when a waiting broadcast request stands for this one and nothing was posted.
 * `answer` settles when the user answers, for a run that waits for that.
 */
export interface ComputerHelpRequest {
  help: ComputerHelp;
  repeated: boolean;
  answer?: Promise<HelpAnswer>;
}

/** A resolved request, and how many waiting runs it answered. */
export interface ResolvedHelp {
  help: ComputerHelp;
  answeredRuns: number;
}

/**
 * A heartbeat, a scheduled task and a webhook store none of their own steps, so a run
 * keeps them by waiting in memory for the answer. A restart ends the wait.
 */
export function waitsForAnswer(mode: string): boolean {
  return mode === 'heartbeat' || mode === 'cron' || mode === 'webhook';
}

function messageTrigger(mode: string): MessageTrigger {
  if (mode === 'goal') return 'GOAL';
  if (mode === 'cron') return 'CRON_TASK';
  if (mode === 'heartbeat') return 'HEARTBEAT';
  if (mode === 'webhook') return 'WEBHOOK';
  return 'USER_INPUT';
}

/**
 * A background run with no conversation of its own asks wherever its output goes,
 * which is every channel. A chat turn stays in its own channel, as every reply does.
 */
export function asksEveryChannel(caller: Pick<ComputerCaller, 'mode' | 'threadId'>): boolean {
  return messageTrigger(caller.mode) !== 'USER_INPUT' && !caller.threadId;
}

/** The Computer page, with the help request and, for a remote one, its computer selected. */
export function computerLink(helpId?: string, computerId?: string): string {
  const params = new URLSearchParams({
    ...(helpId ? { help: helpId } : {}),
    ...(computerId && computerId !== LOCAL_COMPUTER_ID ? { computer: computerId } : {}),
  }).toString();
  const suffix = `computer${params ? `?${params}` : ''}`;
  return config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${suffix}` : `/${suffix}`;
}

/** Help cards are conversation content; voice-only cards last for their call. */
class ComputerHelpService {
  private voice = new Map<string, ComputerHelp>();
  /** The runs waiting for an answer, each with the request it waits on. */
  private waits = new Set<{
    use: ComputerUse;
    helpId: string;
    answer: (status: 'continued' | 'dismissed') => void;
  }>();

  /**
   * @param credentials a sign-in the user answers with what the page asks for. Recorded
   * only when the tab really holds such a form, so the box for it is never offered where
   * the runtime could not type it; a request that loses the flag says so in the log, and
   * `computer_help` tells the agent which answer the user was offered.
   */
  async request(
    use: ComputerUse,
    reason: string,
    tab?: number,
    credentials = false,
  ): Promise<ComputerHelpRequest> {
    const trigger = messageTrigger(use.mode);
    const broadcast = asksEveryChannel(use);
    // A heartbeat asks again on every run, and each ask posts to every channel. So while
    // one broadcast request waits, it stands for them all, including an unrelated block
    // another background run meets at the same time. That run waits for the same answer
    // and is told what the waiting request asks, so it can name or ask for its own block.
    // A run in a conversation that waits for its answer joins the first waiting request
    // its turn was told of: its conversation's own, or a broadcast one. Either way only a
    // request on the computer the run uses, since help on another one clears no block here.
    const session = computerService.current(use);
    const candidates = broadcast
      ? await this.waitingBroadcasts(use.agentId, use.userId)
      : waitsForAnswer(use.mode)
        ? (await this.forTurn(use)).filter((item) => item.status === 'waiting')
        : [];
    const waiting = candidates.find((item) => (item.computerId ?? LOCAL_COMPUTER_ID) === session.id);
    if (waiting) {
      const answer = this.expectAnswer(use, waiting);
      computerService.yield(use);
      trackEvent('computer help repeated', use.userId, {
        'agent.id': use.agentId,
        'computer.help_id': waiting.id,
        mode: use.mode,
      });
      computerService.emit('change');
      return { help: waiting, repeated: true, answer };
    }
    const form = credentials ? await session.signInForm(tab) : undefined;
    if (credentials && !form) {
      logger.info(
        '[Computer] No sign-in form on the tab a help request named; asking for the desktop instead',
      );
    }
    const help: ComputerHelp = {
      type: 'computer_help',
      id: randomUUID(),
      reason,
      tab,
      // The tab the sign-in is really on when there is one, since that is where the
      // credentials are typed and what the user is shown.
      targetId: form?.targetId ?? (await session.helpTarget(tab)),
      computerId: session.id,
      ...(form
        ? { credentials: true as const, credentialFields: form.fields, site: form.origin }
        : {}),
      status: 'waiting',
      threadId: use.threadId,
      originChannel: use.originChannel,
      originChannelId: use.originChannelId,
      ...(broadcast ? { broadcast: true as const } : {}),
      ...(waitsForAnswer(use.mode) ? { requesterWaits: true as const } : {}),
    };
    const answer = this.expectAnswer(use, help);
    if (use.mode === 'voice') {
      this.voice.set(`${use.id}/${help.id}`, help);
    } else {
      const { conversationService } = await import('../conversation.service');
      const { messageDeliveryService } = await import('../message-delivery.service');
      help.threadId ??= (
        await conversationService.getOrCreateLatestThread(use.agentId, use.userId)
      ).id;
      // No context is a broadcast: every channel the user is reachable on.
      const channelContext = broadcast
        ? undefined
        : await messageDeliveryService.threadContext(
            help.threadId,
            use.originChannel,
            use.originChannelId,
          );
      const link =
        config.publicUrl || channelContext?.channel === 'websocket'
          ? `[Open Computer](${computerLink(help.id, help.computerId)})`
          : 'Open Computer in the Prism Web UI.';
      await messageDeliveryService.publish(
        use.userId,
        help.threadId,
        `${reason}\n\n${link}\n\nTell me when you are ready to continue.`,
        trigger,
        {
          blocks: [help],
          channelContext,
        },
      );
    }
    computerService.yield(use);
    trackEvent('computer help requested', use.userId, {
      'agent.id': use.agentId,
      'computer.help_id': help.id,
      'computer.delivery': broadcast ? 'all' : 'origin',
      credentials: help.credentials ? 'true' : 'false',
    });
    computerService.emit('change');
    return { help, repeated: false, answer };
  }

  /**
   * The answer a background run waits for, for at most {@link HELP_ANSWER_WAIT_MS}. Taken
   * before the request is posted, or as it is found, so no answer can arrive before the
   * wait exists. The end of the invocation cancels a wait its tool never reached.
   */
  private expectAnswer(use: ComputerUse, help: ComputerHelp): Promise<HelpAnswer> | undefined {
    if (!waitsForAnswer(use.mode)) return undefined;
    const started = Date.now();
    const answer = new Promise<HelpAnswer>((resolve, reject) => {
      const wait = {
        use,
        helpId: help.id,
        answer: (status: 'continued' | 'dismissed') => {
          settle(status);
          resolve(status);
        },
      };
      const settle = (outcome: HelpAnswer | 'canceled') => {
        clearTimeout(timer);
        use.signal.removeEventListener('abort', abort);
        this.waits.delete(wait);
        trackEvent('computer help wait ended', use.userId, {
          'agent.id': use.agentId,
          'computer.help_id': help.id,
          mode: use.mode,
          outcome,
          elapsed_ms: String(Date.now() - started),
        });
        computerService.emit('change');
      };
      const timer = setTimeout(() => {
        settle('unanswered');
        resolve('unanswered');
      }, HELP_ANSWER_WAIT_MS);
      const abort = () => {
        settle('canceled');
        reject(use.signal.reason);
      };
      this.waits.add(wait);
      use.signal.addEventListener('abort', abort, { once: true });
      if (use.signal.aborted) abort();
    });
    // The tool awaits it; this keeps the rejection quiet when the tool never got that far.
    answer.catch(() => {});
    return answer;
  }

  /** The runs waiting for an answer, as the Computer status lists them. */
  awaiting(): Array<{ id: string; helpId: string; mode: string; threadId?: string }> {
    return [...this.waits].map(({ use, helpId }) => ({
      id: use.id,
      helpId,
      mode: use.mode,
      threadId: use.threadId,
    }));
  }

  async list(agentId: string, userId: string, threadId?: string): Promise<ComputerHelp[]> {
    const messages = await prisma.conversationMessage.findMany({
      where: {
        thread: { agentId, userId },
        ...(threadId ? { threadId } : {}),
        blocks: { path: '$[0].type', equals: 'computer_help' },
      },
      select: { blocks: true },
      orderBy: { createdAt: 'asc' },
    });
    return [
      ...messages.flatMap((row) => row.blocks as unknown as ComputerHelp[]),
      ...(!threadId ? this.voice.values() : []),
    ];
  }

  /**
   * A turn's help: its own conversation's, and every broadcast request still waiting. A run
   * that asks every channel gets none, since its `computer_help` call joins a waiting request
   * and waits for the answer.
   */
  async forTurn(
    caller: Pick<ComputerCaller, 'agentId' | 'userId' | 'threadId' | 'mode'>,
  ): Promise<ComputerHelp[]> {
    if (asksEveryChannel(caller)) return [];
    const { agentId, userId, threadId } = caller;
    const own = threadId ? await this.list(agentId, userId, threadId) : [];
    const ids = new Set(own.map((help) => help.id));
    const broadcast = (await this.waitingBroadcasts(agentId, userId)).filter(
      (help) => !ids.has(help.id),
    );
    return [...own, ...broadcast];
  }

  /** The requests still waiting for the user's answer: the stored ones oldest first, then a call's. */
  async waiting(agentId: string, userId: string): Promise<ComputerHelp[]> {
    const messages = await prisma.conversationMessage.findMany({
      where: {
        thread: { agentId, userId },
        AND: [
          { blocks: { path: '$[0].type', equals: 'computer_help' } },
          { blocks: { path: '$[0].status', equals: 'waiting' } },
        ],
      },
      select: { blocks: true },
      orderBy: { createdAt: 'asc' },
    });
    return [
      ...messages.flatMap((row) => row.blocks as unknown as ComputerHelp[]),
      ...[...this.voice.values()].filter((help) => help.status === 'waiting'),
    ];
  }

  private async waitingBroadcasts(agentId: string, userId: string): Promise<ComputerHelp[]> {
    return (await this.waiting(agentId, userId)).filter((help) => help.broadcast);
  }

  async resolve(
    agentId: string,
    userId: string,
    id: string,
    status: 'continued' | 'dismissed',
  ): Promise<ResolvedHelp | null> {
    const voice = [...this.voice.values()].find((help) => help.id === id);
    if (voice) {
      if (voice.status !== 'waiting') return null;
      voice.status = status;
      this.resolved(agentId, userId, voice);
      return { help: voice, answeredRuns: 0 };
    }
    const row = await prisma.conversationMessage.findFirst({
      where: { thread: { agentId, userId }, blocks: { path: '$[0].id', equals: id } },
    });
    if (!row) throw new Error('Help request not found.');
    const help = (row.blocks as unknown as ComputerHelp[])[0];
    if (help.status !== 'waiting') return null;
    const updated = { ...help, status };
    const result = await prisma.conversationMessage.updateMany({
      where: { id: row.id, blocks: { path: '$[0].status', equals: 'waiting' } },
      data: { blocks: [updated] as unknown as Prisma.InputJsonValue },
    });
    if (!result.count) return null;
    this.resolved(agentId, userId, updated);
    const answeredRuns = this.answer(id, status);
    // The card is part of the transcript, so every open client shows it answered.
    const { messageDeliveryService } = await import('../message-delivery.service');
    await messageDeliveryService.showInConversation(userId, {
      ...row,
      blocks: [updated] as unknown as Prisma.JsonValue,
    });
    return { help: updated, answeredRuns };
  }

  /** Hands the user's answer to every run waiting on request `id`. */
  private answer(id: string, status: 'continued' | 'dismissed'): number {
    const waiting = [...this.waits].filter((wait) => wait.helpId === id);
    for (const wait of waiting) wait.answer(status);
    return waiting.length;
  }

  async continueRequest(
    agentId: string,
    userId: string,
    id: string,
    action: 'continue' | 'dismiss',
    clientId?: string,
  ): Promise<void> {
    const asked = (await this.list(agentId, userId)).find((item) => item.id === id);
    const session = this.sessionOf(asked);
    if (action === 'continue' && session.access.paused) {
      if (!clientId) throw new Error('Hand control back in Computer first.');
      session.assertCanHandBack(clientId);
    }
    const resolved = await this.resolve(
      agentId,
      userId,
      id,
      action === 'continue' ? 'continued' : 'dismissed',
    );
    if (!resolved || action === 'dismiss') return;
    if (session.access.paused) {
      if (!clientId) throw new Error('Hand control back in Computer first.');
      await session.handBack(clientId);
    }
    // The run that asked waits for this answer and continues the work itself. A run
    // that only joined the request does not continue the requester's work.
    if (resolved.answeredRuns && resolved.help.requesterWaits) return;
    const { help } = resolved;
    if (!help.threadId) {
      const { voiceChatService } = await import('../voice/voice-chat.service');
      voiceChatService.continueComputer(help.reason);
      return;
    }
    if (await this.resumeGoal(agentId, userId, help)) return;
    const { messageDeliveryService } = await import('../message-delivery.service');
    const { conversationEngineService } = await import('../conversation-engine.service');
    const context = await messageDeliveryService.threadContext(
      help.threadId,
      help.originChannel,
      help.originChannelId,
    );
    void conversationEngineService
      .chat({
        userId,
        agentId,
        threadId: help.threadId,
        message: `I finished helping with the computer. The help request was: ${JSON.stringify(help.reason)}\n\nInspect the current screen, then continue the original request.`,
        metadata: {
          channel: context.channel,
          channelId: context.channelId,
          channelThreadId: context.channelThreadId,
          channelLabel: context.channelLabel,
        },
      })
      .catch((error) => logger.error({ err: error }, '[Computer] Continuation failed'));
  }

  async resumeGoal(agentId: string, userId: string, help: ComputerHelp): Promise<boolean> {
    if (!help.threadId) return false;
    if ((await this.list(agentId, userId, help.threadId)).some((item) => item.status === 'waiting'))
      return false;
    const { goalService } = await import('../goal.service');
    const goal = await goalService.getGoalForThread(help.threadId);
    if (goal?.status !== 'paused' || goal.lastReason !== 'Waiting for computer help.') return false;
    await goalService.resumeGoal(goal.id);
    return true;
  }

  private resolved(agentId: string, userId: string, help: ComputerHelp): void {
    trackEvent('computer help resolved', userId, {
      'agent.id': agentId,
      'computer.help_id': help.id,
      status: help.status,
    });
    computerService.emit('change');
  }

  /** The computer a request is about; a removed one's requests fall back to the runtime's own. */
  sessionOf(help?: Pick<ComputerHelp, 'computerId'>): ComputerSession {
    return computerService.session(help?.computerId ?? LOCAL_COMPUTER_ID) ?? computerService.local;
  }

  endVoice(use: ComputerUse): void {
    for (const key of this.voice.keys()) if (key.startsWith(`${use.id}/`)) this.voice.delete(key);
    computerService.emit('change');
  }
}

export const computerHelpService = new ComputerHelpService();
