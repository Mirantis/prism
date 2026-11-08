/**
 * Question cards on a database built from the committed migrations: one waiting
 * card per conversation, the first answer wins, and a person's words close it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { openMigratedDatabase, type MigratedDatabase } from '../../test-utils/migrated-database';
import type { QuestionCardBlock } from '../../protocol/chat-protocol';

const { database, delivery, inbound, track, InboundError } = vi.hoisted(() => {
  class InboundError extends Error {}
  return {
    database: { client: undefined as PrismaClient | undefined },
    delivery: { threadContext: vi.fn(), publish: vi.fn(), showInConversation: vi.fn() },
    inbound: { accept: vi.fn(), checkThread: vi.fn(), pendingWorkFor: vi.fn() },
    track: vi.fn(),
    InboundError,
  };
});

vi.mock('../../lib/prisma', () => {
  const client = new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) });
  return { default: client, prisma: client };
});
vi.mock('../message-delivery.service', () => ({ messageDeliveryService: delivery }));
vi.mock('../inbound-message.service', () => ({ inboundMessageService: inbound, InboundMessageError: InboundError }));
vi.mock('../../lib/telemetry', () => ({ trackEvent: track }));
vi.mock('../../config', async (original) => {
  const actual = await original<typeof import('../../config')>();
  return { ...actual, config: { ...actual.config, agentId: 'agent-1', ownerUserId: 'user-1' } };
});
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { questionCardsRouter } from '../../routes/question-cards';
import { getAskQuestionsTools } from '../../tools/ask-questions';
import { QuestionCardWaitingError, questionCardService as service } from './question-card.service';

const AGENT = 'agent-1';
const USER = 'user-1';
const THREAD = 'thread-1';
const ADA = { id: 'ada-id', name: 'Ada Example' };
const GRACE = { id: 'grace-id', name: 'Grace Example' };
const SECRET = 'my private answer text';

let opened: MigratedDatabase;
let seq = 0;

const QUESTIONS: QuestionCardBlock['questions'] = [
  {
    text: 'Budget?',
    options: [{ label: 'Low' }, { label: 'High' }],
    allowOther: true,
    multiSelect: false,
  },
  {
    text: 'Channels?',
    options: [{ label: 'Mail' }, { label: 'Web' }],
    allowOther: false,
    multiSelect: true,
  },
];

function card(over: Partial<QuestionCardBlock> = {}): QuestionCardBlock {
  seq += 1;
  return { type: 'question_card', id: `card-${seq}`, status: 'waiting', questions: QUESTIONS, otherMaxLength: 500, ...over };
}

async function seed(block: unknown = card(), threadId = THREAD): Promise<string> {
  const row = await opened.client.conversationMessage.create({
    data: { threadId, role: 'AGENT', content: 'text', triggeredBy: 'USER_INPUT', blocks: [block] as never },
  });
  return row.id;
}

async function stored(messageId: string): Promise<QuestionCardBlock> {
  const row = await opened.client.conversationMessage.findUniqueOrThrow({ where: { id: messageId } });
  return (row.blocks as unknown as QuestionCardBlock[])[0];
}

const VALID = [{ options: [1] }, { options: [] }];
const answer = (id: string, answers: Parameters<typeof service.answer>[3] = VALID, sender: typeof ADA | null = ADA) =>
  service.answer(AGENT, USER, id, answers, sender);

const closeInChat = async () => {
  const closed = await opened.client.$transaction((tx) => service.closeWaitingInChat(tx, THREAD));
  await service.showClosedInChat(AGENT, USER, closed);
};

beforeAll(async () => {
  opened = openMigratedDatabase();
  database.client = opened.client;
  await opened.client.agentWorkspace.create({
    data: { id: AGENT, userId: USER, soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
  });
});

afterAll(async () => {
  await opened.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await opened.client.pendingWork.deleteMany();
  await opened.client.conversationThread.deleteMany();
  await opened.client.conversationThread.create({ data: { id: THREAD, agentId: AGENT, userId: USER } });
  delivery.threadContext.mockResolvedValue({ channel: 'slack', threadId: THREAD, channelId: 'C1' });
  delivery.publish.mockImplementation(async (_user, threadId, content, _trigger, options) =>
    opened.client.conversationMessage.create({
      data: { threadId, role: 'AGENT', content, triggeredBy: 'USER_INPUT', blocks: options.blocks },
    }),
  );
  delivery.showInConversation.mockResolvedValue(undefined);
  inbound.accept.mockResolvedValue({});
  inbound.checkThread.mockResolvedValue(undefined);
  inbound.pendingWorkFor.mockImplementation((message) => ({ threadId: message.threadId, message: { message: message.content } }));
});

describe('post', () => {
  const input = { questions: QUESTIONS };
  const caller = { agentId: AGENT, userId: USER, threadId: THREAD, originChannel: 'slack' as const, originChannelId: 'C1' };

  it('publishes one card as the only block, with the plain text as the message', async () => {
    const posted = await service.post(caller, { ...input, intro: 'Two decisions.' });

    expect(delivery.publish).toHaveBeenCalledTimes(1);
    const [, threadId, content, trigger, options] = delivery.publish.mock.calls[0];
    expect([threadId, trigger]).toEqual([THREAD, 'USER_INPUT']);
    expect(content).toMatch(/^Two decisions\.\n\n1\. Budget\?/);
    expect(options.blocks).toEqual([posted]);
    expect(options.channelContext).toMatchObject({ channel: 'slack', channelId: 'C1' });
    expect(posted).toMatchObject({ status: 'waiting', otherMaxLength: 500 });
    expect(track).toHaveBeenCalledWith('question card posted', USER, expect.objectContaining({ questions: '2' }));
  });

  it('stores the intro on the card, and no field without one', async () => {
    const withIntro = await service.post(caller, { ...input, intro: 'Two decisions.' });
    expect(withIntro.intro).toBe('Two decisions.');
    await opened.client.conversationMessage.deleteMany();
    const blank = await service.post(caller, { ...input, intro: '' });
    expect(blank).not.toHaveProperty('intro');
  });

  it('refuses a new card while one waits in the conversation', async () => {
    await service.post(caller, input);
    await expect(service.post(caller, input)).rejects.toBeInstanceOf(QuestionCardWaitingError);
    expect(delivery.publish).toHaveBeenCalledTimes(1);
  });

  it('fails the tool call with the reason while a card waits', async () => {
    const tool = getAskQuestionsTools(USER, AGENT, THREAD, 'websocket', undefined).ask_questions;
    const run = () => (tool.execute as (input: unknown, options: unknown) => Promise<unknown>)(input, {});
    await run();
    await expect(run()).rejects.toThrow('already waits');
    expect(delivery.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses the second of two calls in one step', async () => {
    const results = await Promise.allSettled([service.post(caller, input), service.post(caller, input)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(delivery.publish).toHaveBeenCalledTimes(1);
  });

  it('posts again once the earlier card has closed', async () => {
    await seed(card({ status: 'answered_in_chat' }));
    await service.post(caller, input);
    expect(delivery.publish).toHaveBeenCalledTimes(1);
  });
});

describe('answer', () => {
  it('stores the answers and who sent them, shows the card, and accepts one message from that person', async () => {
    const block = card();
    const messageId = await seed(block);

    const outcome = await answer(block.id, [{ options: [0], other: undefined }, { options: [1, 0] }]);

    expect(outcome).toMatchObject({ result: 'answered', card: { status: 'answered', answeredBy: ADA } });
    expect(await stored(messageId)).toMatchObject({ status: 'answered', answers: [{ options: [0] }, { options: [0, 1] }], answeredBy: ADA });
    const shown = delivery.showInConversation.mock.calls[0][1];
    expect(shown.id).toBe(messageId);
    expect(shown.blocks[0].status).toBe('answered');
    expect(inbound.accept).toHaveBeenCalledTimes(1);
    expect(inbound.accept.mock.calls[0][0]).toMatchObject({
      threadId: THREAD,
      content: '1. Budget? Low\n2. Channels? Mail, Web',
      sender: ADA,
    });
  });

  it('writes the pending_work row of the answer message with the card', async () => {
    const block = card();
    await seed(block);
    await answer(block.id);
    const [row] = await opened.client.pendingWork.findMany({ where: { kind: 'chat' } });
    expect(row.key).toBe(inbound.accept.mock.calls[0][0].id);
    expect(row.payload).toMatchObject({ threadId: THREAD, message: { message: '1. Budget? High\n2. Channels? no answer' } });
  });

  describe('a step after the card closes fails', () => {
    const answerOverRoute = (id: string) => {
      const app = express();
      app.use(express.json());
      app.use('/agents', questionCardsRouter);
      return request(app).post(`/agents/question-cards/${id}/answer`).send({ answers: VALID });
    };

    it('accepts the answer message and answers 200 when showing the card throws', async () => {
      const block = card();
      const messageId = await seed(block);
      delivery.showInConversation.mockRejectedValueOnce(new Error('stream is closed'));

      const response = await answerOverRoute(block.id);

      expect(response.status).toBe(200);
      expect(response.body.card.status).toBe('answered');
      expect((await stored(messageId)).status).toBe('answered');
      expect(inbound.accept).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith('question card step failed', USER, expect.objectContaining({ step: 'show' }));
    });

    it('answers 202 with the reply pending and keeps the row for the next boot when accept rejects', async () => {
      const block = card();
      const messageId = await seed(block);
      inbound.accept.mockRejectedValueOnce(new Error('database is busy'));

      const response = await answerOverRoute(block.id);

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ replyPending: true, card: { status: 'answered' } });
      expect((await stored(messageId)).status).toBe('answered');
      expect(await opened.client.pendingWork.count({ where: { kind: 'chat' } })).toBe(1);
      expect(track).toHaveBeenCalledWith('question card step failed', USER, expect.objectContaining({ step: 'accept' }));
    });

    it('goes on when showing a card closed in chat throws', async () => {
      const messageId = await seed(card());
      delivery.showInConversation.mockRejectedValueOnce(new Error('stream is closed'));

      await expect(closeInChat()).resolves.toBeUndefined();
      expect((await stored(messageId)).status).toBe('answered_in_chat');
    });
  });

  it('lets the first answer win when a second has already read the card as waiting', async () => {
    const block = card();
    const messageId = await seed(block);
    // Ada has read the card as waiting when Grace answers, so only the conditional update can decide.
    let first: Awaited<ReturnType<typeof service.answer>> | undefined;
    inbound.checkThread.mockImplementationOnce(async () => {
      first = await answer(block.id, [{ options: [0] }, { options: [] }], GRACE);
    });

    const second = await answer(block.id, VALID, ADA);

    const final = await stored(messageId);
    expect(final).toMatchObject({ status: 'answered', answeredBy: GRACE, answers: [{ options: [0] }, { options: [] }] });
    expect(first).toMatchObject({ result: 'answered', card: final });
    expect(second).toEqual({ result: 'closed', card: final });
    expect(inbound.accept).toHaveBeenCalledTimes(1);
    expect(await opened.client.pendingWork.count({ where: { kind: 'chat' } })).toBe(1);
  });

  it.each(['answered', 'answered_in_chat'] as const)('changes nothing on a card already %s', async (status) => {
    const block = card({ status, answers: [{ options: [0] }, { options: [] }], answeredBy: ADA });
    const messageId = await seed(block);

    expect(await answer(block.id, VALID, GRACE)).toEqual({ result: 'closed', card: block });
    expect(await stored(messageId)).toEqual(block);
    expect(inbound.accept).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('question card answer refused', USER, expect.objectContaining({ status }));
  });

  it('collapses line breaks in Other, so that a question stays one line', async () => {
    const block = card();
    const messageId = await seed(block);
    await answer(block.id, [{ options: [], other: 'first\r\n  second' }, { options: [] }]);
    expect((await stored(messageId)).answers?.[0].other).toBe('first second');
    expect(inbound.accept.mock.calls[0][0].content).toContain('Budget? first second');
  });

  it.each([
    ['too few answers', [{ options: [0] }]],
    ['an option that does not exist', [{ options: [2] }, { options: [] }]],
    ['two choices on a single-select question', [{ options: [0, 1] }, { options: [] }]],
    ['an option and Other on a single-select question', [{ options: [0], other: 'mine' }, { options: [] }]],
    ['Other where the question takes none', [{ options: [0] }, { options: [], other: 'mine' }]],
    ['nothing answered', [{ options: [] }, { options: [] }]],
    ['only an empty Other', [{ options: [], other: '' }, { options: [] }]],
  ])('refuses %s and leaves the card waiting', async (_name, answers) => {
    const block = card();
    const messageId = await seed(block);
    expect(await answer(block.id, answers)).toMatchObject({ result: 'invalid' });
    expect((await stored(messageId)).status).toBe('waiting');
    expect(inbound.accept).not.toHaveBeenCalled();
  });

  it('records a null answeredBy when the request has no sender headers', async () => {
    const block = card();
    const messageId = await seed(block);
    await answer(block.id, VALID, null);
    expect((await stored(messageId)).answeredBy).toBeNull();
  });

  it('finds no card with an unknown id, a malformed block or a conversation clients cannot see', async () => {
    expect(await answer('nope')).toEqual({ result: 'not_found' });

    await seed({ type: 'question_card', id: 'forged', status: 'waiting', questions: 'none' });
    expect(await answer('forged')).toEqual({ result: 'not_found' });

    const hidden = card();
    await seed(hidden);
    inbound.checkThread.mockRejectedValueOnce(new InboundError('unknown'));
    expect(await answer(hidden.id)).toEqual({ result: 'not_found' });
  });

  it('counts answers in telemetry and never sends their text', async () => {
    const block = card();
    await seed(block);
    await answer(block.id, [{ options: [], other: SECRET }, { options: [] }]);
    expect(track).toHaveBeenCalledWith(
      'question card closed',
      USER,
      expect.objectContaining({ status: 'answered', questions: '2', answered: '1', blank: '1', other: '1' }),
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(track.mock.calls)).not.toContain('Budget?');
  });
});

describe('closeWaitingInChat', () => {
  it('closes the waiting card and shows it, and leaves a closed one alone', async () => {
    const waiting = await seed(card());
    const closed = card({ status: 'answered', answers: VALID, answeredBy: ADA });
    const closedId = await seed(closed);

    await closeInChat();

    expect((await stored(waiting)).status).toBe('answered_in_chat');
    expect(await stored(closedId)).toEqual(closed);
    expect(delivery.showInConversation).toHaveBeenCalledTimes(1);
    const closedEvent = track.mock.calls.find(([name]) => name === 'question card closed')?.[2];
    expect(closedEvent).toMatchObject({ status: 'answered_in_chat', questions: '2' });
    expect(closedEvent).not.toHaveProperty('blank');
    expect(closedEvent).not.toHaveProperty('answered');
  });

  it('leaves a card in another conversation waiting', async () => {
    await opened.client.conversationThread.create({ data: { id: 'thread-2', agentId: AGENT, userId: USER } });
    const other = await seed(card(), 'thread-2');
    await closeInChat();
    expect((await stored(other)).status).toBe('waiting');
  });
});
