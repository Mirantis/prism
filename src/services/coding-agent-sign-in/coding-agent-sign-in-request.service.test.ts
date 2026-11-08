/**
 * The sign-in card in a conversation, on a database built from the committed
 * migrations: one card per coding agent and conversation, and after a sign-in
 * every waiting card shows it and each conversation that asked goes on once.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../../test-utils/migrated-database';

const { database, delivery, engine, config } = vi.hoisted(() => ({
  database: { client: undefined as PrismaClient | undefined },
  delivery: {
    threadContext: vi.fn(async () => ({ channel: 'slack', channelId: 'C1' })),
    publish: vi.fn(),
    showInConversation: vi.fn(async () => {}),
    opensWebUiLinks: vi.fn(() => Boolean(config.publicUrl)),
  },
  engine: { chat: vi.fn(async () => {}), acceptUserMessage: vi.fn() },
  config: { publicUrl: 'https://agent.example.com/' as string | undefined },
}));

vi.mock('../../lib/prisma', () => {
  const client = new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) });
  return { default: client, prisma: client };
});
vi.mock('../message-delivery.service', () => ({ messageDeliveryService: delivery }));
vi.mock('../conversation-engine.service', () => ({ conversationEngineService: engine }));
vi.mock('../../lib/telemetry', () => ({ trackEvent: vi.fn() }));
vi.mock('../../config', async (original) => ({
  ...(await original<typeof import('../../config')>()),
  config,
}));

import { codingAgentSignInRequestService as service, signInLink } from './coding-agent-sign-in-request.service';

let opened: MigratedDatabase;
const caller = (threadId: string) => ({ agentId: 'agent-1', userId: 'user-1', threadId });

beforeAll(async () => {
  opened = openMigratedDatabase();
  database.client = opened.client;
  await opened.client.agentWorkspace.create({
    data: { id: 'agent-1', userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
  });
  for (const id of ['thread-1', 'thread-2']) {
    await opened.client.conversationThread.create({ data: { id, agentId: 'agent-1', userId: 'user-1' } });
  }
});

afterAll(async () => {
  await opened.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  delivery.threadContext.mockResolvedValue({ channel: 'slack', channelId: 'C1' });
  delivery.showInConversation.mockResolvedValue(undefined);
  engine.chat.mockResolvedValue(undefined);
  // The continuation is stored as the engine stores any message it accepts.
  engine.acceptUserMessage.mockImplementation(async (input: { message: string }, threadId: string, id: string) => {
    await opened.client.conversationMessage.create({
      data: { id, threadId, role: 'USER', content: input.message, triggeredBy: 'USER_INPUT' },
    });
    return { titleSet: null };
  });
  // The card is stored as delivery stores any message with blocks.
  delivery.publish.mockImplementation(async (_userId: string, threadId: string, content: string, triggeredBy: string, options: { blocks: unknown[] }) => {
    await opened.client.conversationMessage.create({
      data: { threadId, role: 'AGENT', content, triggeredBy, blocks: options.blocks as never },
    });
  });
});

describe('codingAgentSignInRequestService', () => {
  it('links the sign-in on the agent’s public address, and never to the provider', async () => {
    const { repeated } = await service.request(caller('thread-1'), 'claude-code');
    expect(repeated).toBe(false);
    const text = delivery.publish.mock.calls[0][2] as string;
    expect(text).toContain('(https://agent.example.com/coding-agents?agent=claude-code)');
    expect(text).toMatch(
      /^Sign in to Claude to run Claude Code on your own plan\. Enter the sign-in code only where this link opens, never in chat\.\n\n\[Sign in to Claude\]/,
    );
    expect(text).not.toMatch(/claude\.(ai|com)/);
  });

  it('posts no second card while one waits in the conversation', async () => {
    const { repeated } = await service.request(caller('thread-1'), 'claude-code');
    expect(repeated).toBe(true);
    expect(delivery.publish).not.toHaveBeenCalled();
  });

  it('marks every waiting card signed in and continues each conversation once', async () => {
    await service.request(caller('thread-2'), 'claude-code');
    await service.request(caller('thread-2'), 'codex');

    await service.signedIn('agent-1', 'user-1', 'claude-code');

    const cards = await opened.client.conversationMessage.findMany({ where: { blocks: { not: null as never } } });
    const status = cards.map((c) => (c.blocks as Array<{ agent: string; status: string }>)[0]);
    expect(status.filter((b) => b.agent === 'claude-code').map((b) => b.status)).toEqual(['signed_in', 'signed_in']);
    expect(status.find((b) => b.agent === 'codex')?.status).toBe('waiting');
    expect(engine.chat.mock.calls.map(([input]) => [input.threadId, input.message]).sort()).toEqual([
      ['thread-1', 'I signed in to Claude.'],
      ['thread-2', 'I signed in to Claude.'],
    ]);
    expect(engine.acceptUserMessage.mock.calls[0][0]).toMatchObject({ runtimeWritten: true });
    // Each turn answers the continuation stored before its card was marked.
    expect(engine.chat.mock.calls.map(([input]) => input.stored.id)).toEqual(
      engine.acceptUserMessage.mock.calls.map((call) => call[2]),
    );
    expect(delivery.showInConversation).toHaveBeenCalledTimes(2);

    // A second confirmation finds nothing waiting.
    await service.signedIn('agent-1', 'user-1', 'claude-code');
    expect(engine.chat).toHaveBeenCalledTimes(2);
  });

  it('continues a conversation once when a restart stopped it between storing the continuation and marking the card', async () => {
    await opened.client.conversationThread.create({ data: { id: 'thread-3', agentId: 'agent-1', userId: 'user-1' } });
    await service.request(caller('thread-3'), 'claude-code');
    engine.acceptUserMessage.mockImplementationOnce(async (input: { message: string }, threadId: string, id: string) => {
      await opened.client.conversationMessage.create({
        data: { id, threadId, role: 'USER', content: input.message, triggeredBy: 'USER_INPUT' },
      });
      throw new Error('the process stopped');
    });
    await expect(service.signedIn('agent-1', 'user-1', 'claude-code')).rejects.toThrow('the process stopped');
    const [, , requestId] = engine.acceptUserMessage.mock.calls[0];

    // The boot continues the stored message; the next confirmation only marks the card.
    await service.signedIn('agent-1', 'user-1', 'claude-code');

    expect(engine.acceptUserMessage).toHaveBeenCalledTimes(1);
    expect(engine.chat).not.toHaveBeenCalled();
    const card = await opened.client.conversationMessage.findFirst({ where: { threadId: 'thread-3', role: 'AGENT' } });
    expect(card?.blocks).toMatchObject([{ id: requestId, status: 'signed_in' }]);
  });

  it('links relative to the page when the agent has no public address', () => {
    config.publicUrl = undefined;
    expect(signInLink('codex')).toBe('/coding-agents?agent=codex');
    config.publicUrl = 'https://agent.example.com/';
  });
});
