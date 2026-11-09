/**
 * The agent's questions to a person, as a card on one of its messages: posting
 * it, taking the first answer, and closing it when the person replies in words.
 *
 * The card is stored on the message. Every lookup reads `$[0]`, so a card is the
 * only block on its message.
 */

import { randomUUID } from 'node:crypto';
import type { ConversationMessage, Prisma } from '@prisma/client';
import type { z } from 'zod';
import prisma from '../../lib/prisma';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import type { QuestionCardAnswer, QuestionCardBlock, QuestionCardPerson } from '../../protocol/chat-protocol';
import type { ChannelName } from '../channel-adapter.interface';
import { messageDeliveryService } from '../message-delivery.service';
import { pendingWorkService } from '../pending-work.service';
import { askQuestionsInputSchema, MAX_OTHER_CHARS, questionCardBlockSchema } from './question-card-schema';
import { answerMessageText, oneLine, questionCardText } from './question-card-text';

const IS_CARD = { path: '$[0].type', equals: 'question_card' } as const;
const WAITING = { path: '$[0].status', equals: 'waiting' } as const;

export interface QuestionCardCaller {
  agentId: string;
  userId: string;
  threadId: string;
  originChannel?: ChannelName;
  originChannelId?: string;
}

export type AnswerOutcome =
  | { result: 'answered'; card: QuestionCardBlock }
  /** The answers are stored and the next boot starts the turn, since the message could not be accepted. */
  | { result: 'reply_pending'; card: QuestionCardBlock }
  | { result: 'closed'; card: QuestionCardBlock }
  | { result: 'invalid'; error: string }
  | { result: 'not_found' };

/** A card that a typed reply closed, shown to clients once the reply is committed. */
export interface ClosedInChat {
  row: ConversationMessage;
  card: QuestionCardBlock;
}

/** The agent asked again while a card waits, or twice in one step. */
export class QuestionCardWaitingError extends Error {
  constructor() {
    super(
      'A question card already waits in this conversation, so nothing new was sent. End this turn; the answers arrive as the user\'s next message.',
    );
    this.name = 'QuestionCardWaitingError';
  }
}

/** The stored card of a row, or null when the block is not a well-formed card. */
function cardOf(row: Pick<ConversationMessage, 'blocks'>): QuestionCardBlock | null {
  const parsed = questionCardBlockSchema.safeParse((row.blocks as unknown[] | null)?.[0]);
  return parsed.success ? parsed.data : null;
}

/** The answers as the card stores them, or why they do not fit the card. */
function fitAnswers(
  card: QuestionCardBlock,
  answers: QuestionCardAnswer[],
): { answers: QuestionCardAnswer[] } | { error: string } {
  if (answers.length !== card.questions.length) return { error: 'Send one answer per question.' };
  const fitted: QuestionCardAnswer[] = [];
  for (const [index, question] of card.questions.entries()) {
    const options = [...new Set(answers[index].options)].sort((a, b) => a - b);
    const other = oneLine(answers[index].other ?? '') || undefined;
    if (options.some((option) => option >= question.options.length)) return { error: 'That option does not exist.' };
    if (other && !question.allowOther) return { error: 'That question takes no answer of your own.' };
    if (!question.multiSelect && options.length + (other ? 1 : 0) > 1) return { error: 'That question takes one answer.' };
    fitted.push({ options, ...(other ? { other } : {}) });
  }
  if (fitted.every((answer) => answer.options.length === 0 && !answer.other)) return { error: 'Answer at least one question.' };
  return { answers: fitted };
}

function closedProps(row: ConversationMessage, card: QuestionCardBlock) {
  return {
    'thread.id': row.threadId,
    'question_card.id': card.id,
    status: card.status,
    questions: String(card.questions.length),
    elapsed_ms: String(Date.now() - row.createdAt.getTime()),
  };
}

function answerCounts(answers: QuestionCardAnswer[]) {
  const answered = answers.filter((answer) => answer.options.length > 0 || answer.other).length;
  return {
    answered: String(answered),
    blank: String(answers.length - answered),
    other: String(answers.filter((answer) => answer.other).length),
  };
}

class QuestionCardService {
  /** Threads with a post under way. Taken in the tick of the check, so two calls in one step cannot both pass it. */
  private readonly posting = new Set<string>();

  /** Posts the card. Throws {@link QuestionCardWaitingError} while another waits in the thread. */
  async post(caller: QuestionCardCaller, input: z.output<typeof askQuestionsInputSchema>): Promise<QuestionCardBlock> {
    const { threadId } = caller;
    if (this.posting.has(threadId)) throw this.postRefused(caller, 'same_step');
    this.posting.add(threadId);
    try {
      if ((await this.waitingRows(threadId)).length > 0) throw this.postRefused(caller, 'card_waiting');
      const card: QuestionCardBlock = {
        type: 'question_card',
        id: randomUUID(),
        status: 'waiting',
        ...(input.intro ? { intro: input.intro } : {}),
        questions: input.questions,
        otherMaxLength: MAX_OTHER_CHARS,
      };
      const channelContext = await messageDeliveryService.threadContext(
        threadId,
        caller.originChannel,
        caller.originChannelId,
      );
      await messageDeliveryService.publish(
        caller.userId,
        threadId,
        questionCardText(input.questions, input.intro),
        'USER_INPUT',
        { blocks: [card], channelContext },
      );
      trackEvent('question card posted', caller.userId, {
        'agent.id': caller.agentId,
        'thread.id': threadId,
        'question_card.id': card.id,
        questions: String(card.questions.length),
        multi_select: String(card.questions.filter((question) => question.multiSelect).length),
        with_recommended: String(card.questions.filter((question) => question.recommended !== undefined).length),
        channel: channelContext.channel,
      });
      return card;
    } finally {
      this.posting.delete(threadId);
    }
  }

  /**
   * Stores the answers when the card still waits. One transaction updates the card
   * and writes the `pending_work` row of the answer message, so a restart keeps the
   * answers and only the first answer is stored.
   */
  async answer(
    agentId: string,
    userId: string,
    id: string,
    answers: QuestionCardAnswer[],
    sender: QuestionCardPerson | null,
  ): Promise<AnswerOutcome> {
    // Imported here because the inbound service imports the engine, which imports this module.
    const { inboundMessageService, InboundMessageError } = await import('../inbound-message.service');
    const row = await prisma.conversationMessage.findFirst({
      where: { thread: { agentId, userId }, AND: [{ blocks: IS_CARD }, { blocks: { path: '$[0].id', equals: id } }] },
    });
    const card = row && cardOf(row);
    if (!row || !card) return { result: 'not_found' };
    try {
      await inboundMessageService.checkThread(row.threadId, agentId);
    } catch (error) {
      if (error instanceof InboundMessageError) return { result: 'not_found' };
      throw error;
    }
    if (card.status !== 'waiting') return this.refuse(agentId, userId, row.threadId, card);

    const fitted = fitAnswers(card, answers);
    if ('error' in fitted) return { result: 'invalid', error: fitted.error };

    const answered: QuestionCardBlock = { ...card, status: 'answered', answers: fitted.answers, answeredBy: sender };
    const message = {
      id: randomUUID(),
      threadId: row.threadId,
      content: answerMessageText(card.questions, fitted.answers),
      attachmentIds: [],
      sender,
      // A later boot can store this message after the agent has posted a newer card.
      runtimeWritten: true as const,
    };
    const won = await pendingWorkService.beginWith(
      'chat',
      message.id,
      inboundMessageService.pendingWorkFor(message),
      async (tx) => {
        const { count } = await tx.conversationMessage.updateMany({
          where: { id: row.id, blocks: WAITING },
          data: { blocks: [answered] as unknown as Prisma.InputJsonValue },
        });
        return count === 1;
      },
    );
    if (!won) {
      const stored = await prisma.conversationMessage.findUnique({ where: { id: row.id } });
      return this.refuse(agentId, userId, row.threadId, (stored && cardOf(stored)) ?? card);
    }

    trackEvent('question card closed', userId, {
      'agent.id': agentId,
      ...closedProps(row, answered),
      ...answerCounts(fitted.answers),
    });
    await this.showCard(agentId, userId, row, answered);
    try {
      await inboundMessageService.accept(message);
    } catch (error) {
      this.stepFailed('accept', error, agentId, userId, row.threadId, card.id);
      return { result: 'reply_pending', card: answered };
    }
    return { result: 'answered', card: answered };
  }

  /** A message the person typed closes the cards waiting in its conversation, in that message's transaction. */
  async closeWaitingInChat(tx: Prisma.TransactionClient, threadId: string): Promise<ClosedInChat[]> {
    const closedCards: ClosedInChat[] = [];
    for (const row of await this.waitingRows(threadId, tx)) {
      const card = cardOf(row);
      if (!card) continue;
      const closed: QuestionCardBlock = { ...card, status: 'answered_in_chat' };
      const { count } = await tx.conversationMessage.updateMany({
        where: { id: row.id, blocks: WAITING },
        data: { blocks: [closed] as unknown as Prisma.InputJsonValue },
      });
      if (count > 0) closedCards.push({ row, card: closed });
    }
    return closedCards;
  }

  async showClosedInChat(agentId: string, userId: string, closedCards: ClosedInChat[]): Promise<void> {
    for (const { row, card } of closedCards) {
      trackEvent('question card closed', userId, { 'agent.id': agentId, ...closedProps(row, card) });
      await this.showCard(agentId, userId, row, card);
    }
  }

  /** Every open client shows the changed card. The stored card is already right, so a failure here stops nothing. */
  private async showCard(agentId: string, userId: string, row: ConversationMessage, card: QuestionCardBlock): Promise<void> {
    try {
      await messageDeliveryService.showInConversation(userId, {
        ...row,
        blocks: [card] as unknown as Prisma.JsonValue,
      });
    } catch (error) {
      this.stepFailed('show', error, agentId, userId, row.threadId, card.id);
    }
  }

  private stepFailed(
    step: 'show' | 'accept',
    error: unknown,
    agentId: string,
    userId: string,
    threadId: string,
    cardId: string,
  ): void {
    logger.error({ err: error, cardId, step }, '[QuestionCards] A step after the card closed failed');
    trackEvent('question card step failed', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'question_card.id': cardId,
      step,
    });
  }

  private waitingRows(threadId: string, db: Prisma.TransactionClient = prisma): Promise<ConversationMessage[]> {
    return db.conversationMessage.findMany({
      where: { threadId, AND: [{ blocks: IS_CARD }, { blocks: WAITING }] },
      orderBy: { createdAt: 'asc' },
    });
  }

  private postRefused(caller: QuestionCardCaller, reason: 'same_step' | 'card_waiting'): QuestionCardWaitingError {
    trackEvent('question card post refused', caller.userId, {
      'agent.id': caller.agentId,
      'thread.id': caller.threadId,
      reason,
    });
    return new QuestionCardWaitingError();
  }

  private refuse(agentId: string, userId: string, threadId: string, card: QuestionCardBlock): AnswerOutcome {
    trackEvent('question card answer refused', userId, {
      'agent.id': agentId,
      'thread.id': threadId,
      'question_card.id': card.id,
      status: card.status,
    });
    return { result: 'closed', card };
  }
}

export const questionCardService = new QuestionCardService();
