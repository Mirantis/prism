/**
 * Inbound Message Service
 *
 * Owns what happens to a message a person sends over the chat socket: it is
 * stored under the id the client chose, confirmed, and then answered — in the
 * order messages arrived, one turn at a time for the agent. It also owns what
 * every client is told about each conversation's work: queued, running or idle.
 *
 * **Stored before anything else.** A message is written the moment it is
 * accepted, and only then scheduled. The queue therefore holds rows that already
 * exist, so nothing can lose a message that has been confirmed — not a client
 * going away, and not a queue that drains with nobody connected. A resend of the
 * same id finds its row and is confirmed again without a second answer.
 *
 * **One turn at a time.** A message for a conversation whose turn is running is
 * handed to that turn, which reads it at its next step. A message for another
 * conversation waits until the running turn ends, and every client sees it as
 * queued. The waiting is what "Prism is stopped" means while a person holds the
 * computer: the turn that asked for help is still running.
 */

import { Prisma, type ConversationMessage } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { trackEvent } from '../lib/telemetry';
import { chatWorkFor, conversationEngineService, type ChatTurnEnd, type ChatWork } from './conversation-engine.service';
import {
  conversationThreadActivityService,
  type ThreadActivityChange,
} from './conversation-thread-activity.service';
import { messageDeliveryService } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { eventStreamService } from './event-stream.service';
import { pendingWorkService } from './pending-work.service';
import {
  TURN_FAILED,
  turnError,
  type NackCode,
  type TurnEventPayload,
  type TurnOutcome,
  type TurnState,
} from '../protocol/chat-protocol';
import type { AgentMessageOrigin, ResumedReply } from '../types';
import { agentMessageOrigin } from '../prompts/agent-message-prompt';
import { withSenderTag } from '../prompts/context-builder';
import { webChatLabel } from './web-chat-label';

export interface InboundMessage {
  /** The client's id for the message, which becomes the row's. */
  id: string;
  threadId: string;
  content: string;
  attachmentIds: string[];
  /**
   * Who sent it, as the Mirantis Agent Platform sign-in named the connection: a stable id,
   * which tells one person's messages from another's, and a name to show. The
   * sign-in gives an email, or a user id, which serves as both today.
   */
  sender: { id: string; name: string } | null;
  /** Set when another agent of the project sent it, and `sender` is then null. */
  agentMessage?: AgentMessageOrigin;
  /** The runtime wrote it in the person's name, so it leaves a waiting question card open. */
  runtimeWritten?: true;
}

export interface Acceptance {
  message: ConversationMessage;
  /** A stream position at or after the stored message's `message` event. */
  seq: number;
  queued: boolean;
  duplicate: boolean;
}

/** A refusal the client can act on, with the code it is sent under. */
export class InboundMessageError extends Error {
  constructor(readonly code: NackCode, message: string) {
    super(message);
  }
}

/** How a turn ended, as every client is told it. */
function outcomeOf({ cancelled, error }: ChatTurnEnd): { outcome: TurnOutcome; error?: string } {
  if (cancelled) return { outcome: 'cancelled' };
  if (!error) return { outcome: 'completed' };
  return { outcome: 'failed', error: turnError(error) };
}

/**
 * How a message's sender is stored: a person's id as the external id and the
 * name for display, or the other agent's origin, which only this service sets.
 */
function senderInput(message: InboundMessage) {
  if (message.agentMessage) return { metadata: { channel: 'websocket' as const }, agentMessage: message.agentMessage };
  return {
    metadata: {
      channel: 'websocket' as const,
      ...(message.sender ? { senderExternalId: message.sender.id, senderName: message.sender.name } : {}),
    },
  };
}

/** One event per message received, a person's or another agent's, whether or not it came before. */
function trackReceived(message: InboundMessage, duplicate: boolean): void {
  const common = {
    ...(config.agentId ? { 'agent.id': config.agentId } : {}),
    'thread.id': message.threadId,
  };
  if (message.agentMessage) {
    trackEvent('agent message received', config.ownerUserId, {
      ...common,
      'agent_message.kind': message.agentMessage.kind,
      'agent_message.duplicate': String(duplicate),
      'agent_message.attachments': String(message.attachmentIds.length),
    });
    return;
  }
  trackEvent('chat message received', config.ownerUserId, {
    ...common,
    'chat.duplicate': String(duplicate),
    'chat.attachments': String(message.attachmentIds.length),
  });
}

interface Waiting {
  message: InboundMessage;
  titleSet: string | null;
  /** Set when the turn continues one a restart interrupted. */
  resumed?: ResumedReply;
}

class InboundMessageService {
  /** Acceptances in flight, by message id, so two copies of one send share one row. */
  private readonly accepting = new Map<string, Promise<Acceptance>>();
  private readonly waiting: Waiting[] = [];
  /** The thread of the turn this service is running, if one is. */
  private runningThreadId: string | null = null;
  /** How a thread's last turn ended, told once with the `idle` that follows it. */
  private readonly outcomes = new Map<string, { outcome: TurnOutcome; error?: string }>();
  /** The state each thread was last announced in. Idle threads are not kept. */
  private readonly announced = new Map<string, Exclude<TurnState, 'idle'>>();

  // Subscribed here, at import, rather than by the gateway: the turn state is this
  // service's to announce, and the gateway imports it at boot.
  constructor() {
    conversationThreadActivityService.events.on('change', ({ threadId }: ThreadActivityChange) => {
      this.announce(threadId);
    });
    // Every exchange the engine runs, whoever started it, so the `idle` after it says how it ended.
    conversationEngineService.events.on('turnEnded', (ended: ChatTurnEnd) => {
      this.outcomes.set(ended.threadId, outcomeOf(ended));
    });
  }

  /**
   * Store a message and schedule its answer. Resolves once the message is stored,
   * which is when the client may stop offering to send it again.
   */
  accept(message: InboundMessage): Promise<Acceptance> {
    // A second copy while the first is being stored waits for it, then gets the
    // answer any resend gets: the same check against the stored row.
    const inFlight = this.accepting.get(message.id);
    if (inFlight) {
      return inFlight.then(
        (first) => this.acceptDuplicate(first.message, message),
        () => this.accept(message),
      );
    }

    const acceptance = this.acceptOnce(message).finally(() => this.accepting.delete(message.id));
    this.accepting.set(message.id, acceptance);
    return acceptance;
  }

  /**
   * Stop the conversation's work: its running turn, whoever started it, and its
   * messages still waiting. Those stay in history, unanswered, as after any cancel.
   * Answers whether there was anything to stop.
   */
  async cancel(threadId: string): Promise<boolean> {
    const agentId = config.agentId;
    if (!agentId) {
      throw new InboundMessageError('unavailable', 'The agent is still starting. Try again shortly.');
    }
    // The same bar as a send: a client stops only this agent's web conversations.
    await this.checkThread(threadId, agentId);
    const dropped: Waiting[] = [];
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i].message.threadId === threadId) dropped.push(...this.waiting.splice(i, 1));
    }
    // Stopped, so no longer owed an answer.
    pendingWorkService.end('chat', dropped.flatMap((w) => w.resumed?.messageIds ?? [w.message.id]));
    const stopped = conversationEngineService.cancel(threadId);
    if (dropped.length > 0) this.announce(threadId);
    return stopped || dropped.length > 0;
  }

  /**
   * Continue a reply a restart interrupted, in its turn: it waits like any
   * message, behind the ones accepted before it.
   */
  resume(message: ConversationMessage, resumed: ResumedReply): void {
    const agentMessage = agentMessageOrigin(message);
    void this.scheduleStored({
      message: {
        id: message.id,
        threadId: message.threadId,
        content: message.content,
        attachmentIds: [],
        sender: null,
        ...(agentMessage ? { agentMessage } : {}),
      },
      titleSet: null,
      resumed,
    });
  }

  /** Every conversation with work queued or running, for a client that just connected. */
  turns(): Array<{ threadId: string; state: Exclude<TurnState, 'idle'> }> {
    return [...this.announced].map(([threadId, state]) => ({ threadId, state }));
  }

  private async acceptOnce(inbound: InboundMessage): Promise<Acceptance> {
    const agentId = config.agentId;
    if (!agentId) {
      throw new InboundMessageError('unavailable', 'The agent is still starting. Try again shortly.');
    }
    await this.checkThread(inbound.threadId, agentId);

    const existing = await prisma.conversationMessage.findUnique({ where: { id: inbound.id } });
    if (existing) return this.acceptDuplicate(existing, inbound);

    let stored: { message: ConversationMessage; titleSet: string | null };
    try {
      stored = await conversationEngineService.acceptUserMessage(
        this.engineInput(inbound, agentId),
        inbound.threadId,
        inbound.id,
      );
    } catch (error) {
      // Another process wrote the id between the lookup and the insert. There is
      // one process per agent, so this is a restart racing a resend.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await prisma.conversationMessage.findUnique({ where: { id: inbound.id } });
        if (raced) return this.acceptDuplicate(raced, inbound);
      }
      throw error;
    }

    trackReceived(inbound, false);

    const queued = await this.scheduleStored({ message: inbound, titleSet: stored.titleSet });
    return { message: stored.message, seq: eventStreamService.seq, queued, duplicate: false };
  }

  /**
   * The id is already a row. A person's message in the same conversation is the
   * same message sent again, and is confirmed again. So is another agent's
   * message delivered again, from the same sender with the same message id, in
   * the conversation that holds it: the newest conversation can be another one
   * by then. Anything else is refused: the id is the client's choice, and must
   * not attach to an agent's reply, to another sender's message or to another
   * conversation. The client then offers to send it again.
   *
   * A confirmed message whose turn never ran — the process stopped between the
   * store and the turn — is scheduled now, as the row holds it: the history
   * shows the row, so the turn answers its words and its sender. One with an
   * answer after it, or with work under way on its thread, is left alone:
   * answering it twice is worse.
   */
  private async acceptDuplicate(existing: ConversationMessage, received: InboundMessage): Promise<Acceptance> {
    const fromAgent = received.agentMessage !== undefined;
    const sameKind = existing.role === 'USER' && (existing.triggeredBy === 'AGENT_MESSAGE') === fromAgent;
    const stored = agentMessageOrigin(existing);
    const sameSender =
      !received.agentMessage ||
      (stored?.senderId === received.agentMessage.senderId && stored.messageId === received.agentMessage.messageId);
    if (!sameKind || !sameSender || (!fromAgent && existing.threadId !== received.threadId)) {
      throw new InboundMessageError('id_conflict', 'That message id is already taken by another message.');
    }
    const inbound: InboundMessage = {
      ...received,
      threadId: existing.threadId,
      content: existing.content,
      ...(stored ? { agentMessage: stored } : {}),
    };

    trackReceived(inbound, true);

    let queued = this.announced.get(inbound.threadId) === 'queued';
    if (
      !this.hasWork(inbound.threadId) &&
      !(await this.hasAnswer(existing)) &&
      (await this.turnReadsThread(existing))
    ) {
      logger.info('Message %s was stored but never answered; scheduling it now', existing.id);
      queued = await this.scheduleStored({ message: inbound, titleSet: null });
    }
    // Shown again: if the first attempt failed after storing the row, no client
    // has seen it yet. Clients replace a message they already have.
    await messageDeliveryService.showInConversation(config.ownerUserId, existing);
    return { message: existing, seq: eventStreamService.seq, queued, duplicate: true };
  }

  /**
   * A turn reads the thread that holds the message. Single-thread mode hides every other
   * web thread and answers in the one conversation, which does not hold it.
   */
  private async turnReadsThread(message: ConversationMessage): Promise<boolean> {
    if ((await conversationService.writableThreadId(message.threadId)) === message.threadId) return true;
    logger.info('Not answering message %s: single-thread mode hides thread %s', message.id, message.threadId);
    return false;
  }

  private engineInput(message: InboundMessage, agentId: string) {
    return {
      agentId,
      userId: config.ownerUserId,
      message: message.content,
      attachmentIds: message.attachmentIds,
      ...(message.runtimeWritten ? { runtimeWritten: message.runtimeWritten } : {}),
      ...senderInput(message),
    };
  }

  /** What `pending_work` holds for `message` until its answer ends, as `accept` writes it. */
  pendingWorkFor(message: InboundMessage): ChatWork {
    return chatWorkFor(this.engineInput(message, config.agentId as string), message.threadId);
  }

  /** Only this agent's web conversations that clients may see take messages from the socket. */
  async checkThread(threadId: string, agentId: string): Promise<void> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId, AND: await conversationService.clientThreadFilter(agentId, config.ownerUserId) },
      select: { agentId: true, threadSource: true },
    });
    if (!thread || thread.agentId !== agentId || thread.threadSource !== 'DATABASE') {
      throw new InboundMessageError('unknown_thread', 'That conversation does not exist.');
    }
  }

  private async hasAnswer(message: ConversationMessage): Promise<boolean> {
    const reply = await prisma.conversationMessage.findFirst({
      where: {
        threadId: message.threadId,
        role: 'AGENT',
        internalStep: false,
        createdAt: { gt: message.createdAt },
      },
      select: { id: true },
    });
    return reply !== null;
  }

  private hasWork(threadId: string): boolean {
    return this.announced.has(threadId) || this.runningThreadId === threadId;
  }

  /**
   * Schedule a message that is already stored, and never fail: from here the
   * client is told the message is safe, and a failure that reached it would say
   * the opposite. Offering it to a running turn needs the database; when that
   * fails, the message waits its turn instead of being offered.
   */
  private async scheduleStored(waiting: Waiting): Promise<boolean> {
    try {
      return await this.schedule(waiting);
    } catch (error) {
      logger.error(
        'Could not offer message %s to the running turn; queueing it: %s',
        waiting.message.id,
        error instanceof Error ? error.message : String(error),
      );
      if (this.runningThreadId === null) {
        void this.run(waiting);
        return false;
      }
      this.waiting.push(waiting);
      this.announce(waiting.message.threadId);
      return true;
    }
  }

  /**
   * Hand the message to the turn running on its thread, run it, or queue it.
   * Answers whether it was queued.
   */
  private async schedule(waiting: Waiting): Promise<boolean> {
    if (this.runningThreadId !== null) {
      // A turn is under way. One on this message's own thread reads it at its next
      // step, which is how a correction mid-answer steers the work.
      const offered = await conversationEngineService.chat({
        ...(await this.chatInput(waiting)),
        steerOnly: true,
      });
      if (offered.steered) return false;
      // The running turn can end while the offer awaits its thread lookup. It has
      // already looked for the next message by then, so nothing would run this one.
      if (this.runningThreadId === null) {
        void this.run(waiting);
        return false;
      }
      this.waiting.push(waiting);
      this.announce(waiting.message.threadId);
      return true;
    }
    void this.run(waiting);
    return false;
  }

  /** Answer one message, then the next one waiting. Never rejects. */
  private async run(waiting: Waiting): Promise<void> {
    const { threadId } = waiting.message;
    this.runningThreadId = threadId;
    this.announce(threadId);
    // Held until the outcome is recorded, so the `idle` every client sees carries
    // how the turn ended rather than arriving before it is known.
    const endHold = conversationThreadActivityService.beginThread(threadId, config.ownerUserId);
    try {
      await conversationEngineService.chat(await this.chatInput(waiting));
    } catch (error) {
      // Through the serializer, which redacts; every client gets a sentence
      // instead, since an exception can carry request content or internals.
      logger.error({ err: error, threadId }, 'Turn failed');
      this.outcomes.set(threadId, { outcome: 'failed', error: TURN_FAILED });
    } finally {
      this.runningThreadId = null;
      endHold();
      // A turn that ended without the activity changing still owes its `idle`.
      this.announce(threadId);
    }

    const next = this.waiting.shift();
    if (next) void this.run(next);
  }

  private async chatInput(waiting: Waiting) {
    const { message } = waiting;
    const channelLabel = await webChatLabel(message.threadId);
    return {
      agentId: config.agentId as string,
      userId: config.ownerUserId,
      // Tagged the way a turn with the channel instructions renders the stored
      // row, so a message handed to a running turn reads the same there as later.
      message: channelLabel ? withSenderTag(message.content, message.sender?.id, message.sender?.name) : message.content,
      threadId: message.threadId,
      attachmentIds: message.attachmentIds,
      stored: { id: message.id, titleSet: waiting.titleSet },
      ...(waiting.resumed ? { resumed: waiting.resumed } : {}),
      ...senderInput(message),
      channelLabelFor: webChatLabel,
    };
  }

  /** Tell every client the thread's state, when it differs from what they were last told. */
  private announce(threadId: string): void {
    const state = this.stateOf(threadId);
    const before = this.announced.get(threadId) ?? 'idle';
    if (state === before) return;

    if (state === 'idle') this.announced.delete(threadId);
    else this.announced.set(threadId, state);

    const payload: TurnEventPayload = { threadId, state };
    if (state === 'idle' && before === 'running') {
      const ended = this.outcomes.get(threadId) ?? { outcome: 'completed' as const };
      payload.outcome = ended.outcome;
      if (ended.error) payload.error = ended.error;
    }
    if (state === 'idle') this.outcomes.delete(threadId);
    eventStreamService.publish({ type: 'turn', payload });
  }

  private stateOf(threadId: string): TurnState {
    if (conversationThreadActivityService.workingThreadIds().includes(threadId)) return 'running';
    if (this.runningThreadId === threadId) return 'running';
    if (this.waiting.some((w) => w.message.threadId === threadId)) return 'queued';
    return 'idle';
  }

  /** Forget everything, as a restart would. For tests. */
  resetForTests(): void {
    this.accepting.clear();
    this.waiting.length = 0;
    this.runningThreadId = null;
    this.outcomes.clear();
    this.announced.clear();
  }
}

export const inboundMessageService = new InboundMessageService();
