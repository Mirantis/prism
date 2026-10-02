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
import { conversationEngineService } from './conversation-engine.service';
import {
  conversationThreadActivityService,
  type ThreadActivityChange,
} from './conversation-thread-activity.service';
import { messageDeliveryService } from './message-delivery.service';
import { eventStreamService } from './event-stream.service';
import type { NackCode, TurnEventPayload, TurnOutcome, TurnState } from '../protocol/chat-protocol';

export interface InboundMessage {
  /** The client's id for the message, which becomes the row's. */
  id: string;
  threadId: string;
  content: string;
  attachmentIds: string[];
  /**
   * Who sent it, as the Lens Agents sign-in named the connection: a stable id,
   * which tells one person's messages from another's, and a name to show. The
   * sign-in gives an email, or a user id, which serves as both today.
   */
  sender: { id: string; name: string } | null;
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

/** What every client is told when a turn fails. The details go to the log. */
const TURN_FAILED = 'The agent could not answer. Try again.';

/** How a message's sender is stored: the id as the external id, the name for display. */
function senderMetadata(message: InboundMessage) {
  return {
    channel: 'websocket' as const,
    ...(message.sender ? { senderExternalId: message.sender.id, senderName: message.sender.name } : {}),
  };
}

interface Waiting {
  message: InboundMessage;
  titleSet: string | null;
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
    const before = this.waiting.length;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i].message.threadId === threadId) this.waiting.splice(i, 1);
    }
    const dropped = this.waiting.length !== before;
    const stopped = conversationEngineService.cancel(threadId);
    if (stopped) this.outcomes.set(threadId, { outcome: 'cancelled' });
    if (dropped) this.announce(threadId);
    return stopped || dropped;
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
        {
          agentId,
          userId: config.ownerUserId,
          message: inbound.content,
          attachmentIds: inbound.attachmentIds,
          metadata: senderMetadata(inbound),
        },
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

    trackEvent('chat message received', config.ownerUserId, {
      'agent.id': agentId,
      'thread.id': inbound.threadId,
      'chat.duplicate': 'false',
      'chat.attachments': String(inbound.attachmentIds.length),
    });

    const queued = await this.scheduleStored({ message: inbound, titleSet: stored.titleSet });
    return { message: stored.message, seq: eventStreamService.seq, queued, duplicate: false };
  }

  /**
   * The id is already a row. A person's message in the same conversation is the
   * same message sent again, and is confirmed again. Anything else is refused:
   * the id is the client's choice, and must not attach to an agent's reply or to
   * another conversation. The client then offers to send it again.
   *
   * A confirmed message whose turn never ran — the process stopped between the
   * store and the turn — is scheduled now. One with an answer after it, or with
   * work under way on its thread, is left alone: answering it twice is worse.
   */
  private async acceptDuplicate(existing: ConversationMessage, inbound: InboundMessage): Promise<Acceptance> {
    if (existing.threadId !== inbound.threadId || existing.role !== 'USER') {
      throw new InboundMessageError('id_conflict', 'That message id is already taken by another message.');
    }

    trackEvent('chat message received', config.ownerUserId, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'thread.id': inbound.threadId,
      'chat.duplicate': 'true',
      'chat.attachments': String(inbound.attachmentIds.length),
    });

    let queued = this.announced.get(inbound.threadId) === 'queued';
    if (!this.hasWork(inbound.threadId) && !(await this.hasAnswer(existing))) {
      logger.info('Message %s was stored but never answered; scheduling it now', existing.id);
      queued = await this.scheduleStored({ message: inbound, titleSet: null });
    }
    // Shown again: if the first attempt failed after storing the row, no client
    // has seen it yet. Clients replace a message they already have.
    await messageDeliveryService.showInConversation(config.ownerUserId, existing);
    return { message: existing, seq: eventStreamService.seq, queued, duplicate: true };
  }

  /** Only this agent's web conversations take messages from the socket. */
  private async checkThread(threadId: string, agentId: string): Promise<void> {
    const thread = await prisma.conversationThread.findUnique({
      where: { id: threadId },
      select: { agentId: true, threadSource: true, externalThreadId: true },
    });
    // A Slack DM or a Teams conversation is also a DATABASE thread, keyed by its external id.
    if (
      !thread ||
      thread.agentId !== agentId ||
      thread.threadSource !== 'DATABASE' ||
      thread.externalThreadId !== null
    ) {
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
        ...this.chatInput(waiting),
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
      await conversationEngineService.chat(this.chatInput(waiting));
      if (!this.outcomes.has(threadId)) this.outcomes.set(threadId, { outcome: 'completed' });
    } catch (error) {
      // Through the serializer, which redacts; every client gets a sentence
      // instead, since an exception can carry request content or internals.
      logger.error({ err: error, threadId }, 'Turn failed');
      if (this.outcomes.get(threadId)?.outcome !== 'cancelled') {
        this.outcomes.set(threadId, { outcome: 'failed', error: TURN_FAILED });
      }
    } finally {
      this.runningThreadId = null;
      endHold();
      // A turn that ended without the activity changing still owes its `idle`.
      this.announce(threadId);
    }

    const next = this.waiting.shift();
    if (next) void this.run(next);
  }

  private chatInput(waiting: Waiting) {
    const { message } = waiting;
    return {
      agentId: config.agentId as string,
      userId: config.ownerUserId,
      message: message.content,
      threadId: message.threadId,
      attachmentIds: message.attachmentIds,
      stored: { titleSet: waiting.titleSet },
      metadata: senderMetadata(message),
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
