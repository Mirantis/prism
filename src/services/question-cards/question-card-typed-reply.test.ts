/**
 * A typed reply and the card it closes, on a database built from the committed
 * migrations, through the engine's real store path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../../test-utils/migrated-database';
import type { QuestionCardBlock } from '../../protocol/chat-protocol';

const { database, delivery } = vi.hoisted(() => ({
  database: { client: undefined as PrismaClient | undefined },
  delivery: { showInConversation: vi.fn(), getAdapter: vi.fn(() => undefined), publish: vi.fn() },
}));

vi.mock('../../lib/prisma', () => {
  const client = new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) });
  return { default: client, prisma: client };
});
vi.mock('../message-delivery.service', () => ({ messageDeliveryService: delivery }));
vi.mock('../../invoke', () => ({ invokeStream: vi.fn() }));
vi.mock('../../lib/telemetry', () => ({ trackEvent: vi.fn(), isTelemetryEnabled: () => false, langfuseTelemetry: () => ({}) }));
vi.mock('../../config', async (original) => {
  const actual = await original<typeof import('../../config')>();
  return { ...actual, config: { ...actual.config, agentId: 'agent-1', ownerUserId: 'user-1' } };
});
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { conversationEngineService as engine } from '../conversation-engine.service';
import { conversationService } from '../conversation.service';
import { inboundMessageService } from '../inbound-message.service';

const AGENT = 'agent-1';
const USER = 'user-1';
const THREAD = 'thread-1';
const person = { agentId: AGENT, userId: USER, message: 'Budget first.' };

let opened: MigratedDatabase;

const BLOCK: QuestionCardBlock = {
  type: 'question_card',
  id: 'card-1',
  status: 'waiting',
  otherMaxLength: 500,
  questions: [{ text: 'Pick?', options: [{ label: 'A' }, { label: 'B' }], allowOther: true, multiSelect: false }],
};

async function statusOf(id: string): Promise<string> {
  const row = await opened.client.conversationMessage.findUniqueOrThrow({ where: { id } });
  return (row.blocks as unknown as QuestionCardBlock[])[0].status;
}

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

let cardRow: string;

beforeEach(async () => {
  vi.clearAllMocks();
  delivery.showInConversation.mockResolvedValue(undefined);
  await opened.client.pendingWork.deleteMany();
  await opened.client.conversationThread.deleteMany();
  await opened.client.conversationThread.create({ data: { id: THREAD, agentId: AGENT, userId: USER } });
  const row = await opened.client.conversationMessage.create({
    data: { threadId: THREAD, role: 'AGENT', content: 'text', triggeredBy: 'USER_INPUT', blocks: [BLOCK] as never },
  });
  cardRow = row.id;
});

describe('an answer message that the next boot stores', () => {
  it('leaves a newer waiting card open', async () => {
    const work = inboundMessageService.pendingWorkFor({
      id: 'answer-1',
      threadId: THREAD,
      content: '1. Pick? A',
      attachmentIds: [],
      sender: null,
      runtimeWritten: true,
    });

    // As resume-replies stores a message from its row.
    await engine.acceptUserMessage(
      { agentId: work.agentId, userId: work.userId, metadata: work.metadata, ...work.message! },
      work.threadId,
      'answer-1',
    );

    expect(await statusOf(cardRow)).toBe('waiting');
    expect(await opened.client.conversationMessage.count({ where: { id: 'answer-1' } })).toBe(1);
  });
});

describe('a task notification while a card waits', () => {
  it('leaves the card open', async () => {
    await engine.acceptUserMessage(
      { agentId: AGENT, userId: USER, message: 'The task finished.', taskNotification: { taskId: 'task-1' } },
      THREAD,
      'task-1',
    );

    expect(await statusOf(cardRow)).toBe('waiting');
    expect(await opened.client.conversationMessage.count({ where: { id: 'task-1' } })).toBe(1);
  });
});

describe('a typed reply while a card waits', () => {
  it('stores the reply, closes the card, and shows the card once both are committed', async () => {
    let seenAtShow: { status: string; reply: number } | undefined;
    delivery.showInConversation.mockImplementationOnce(async () => {
      seenAtShow = {
        status: await statusOf(cardRow),
        reply: await opened.client.conversationMessage.count({ where: { id: 'typed-1' } }),
      };
    });

    await engine.acceptUserMessage(person, THREAD, 'typed-1');

    expect(seenAtShow).toEqual({ status: 'answered_in_chat', reply: 1 });
  });

  it('leaves the card waiting and shows nothing when the insert fails', async () => {
    await opened.client.conversationMessage.create({
      data: { id: 'taken', threadId: THREAD, role: 'USER', content: 'earlier', triggeredBy: 'USER_INPUT' },
    });

    await expect(engine.acceptUserMessage(person, THREAD, 'taken')).rejects.toThrow();

    expect(await statusOf(cardRow)).toBe('waiting');
    expect(delivery.showInConversation).not.toHaveBeenCalled();
    expect(await opened.client.pendingWork.count({ where: { kind: 'chat', key: 'taken' } })).toBe(1);
  });

  it('removes the reply when the write that goes with it fails', async () => {
    await expect(
      conversationService.addMessage(THREAD, { id: 'typed-2', content: 'x', role: 'USER', triggeredBy: 'USER_INPUT' }, async () => {
        throw new Error('card write failed');
      }),
    ).rejects.toThrow('card write failed');

    expect(await opened.client.conversationMessage.count({ where: { id: 'typed-2' } })).toBe(0);
  });
});
