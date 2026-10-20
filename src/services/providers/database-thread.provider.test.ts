/**
 * Message order on a database built from the committed migrations. Two rows
 * written in the same millisecond keep the order they were written in for the
 * model, and are ordered by id for a client.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../../test-utils/migrated-database';

const database = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock('../../lib/prisma', () => ({
  default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) }),
}));

import { DatabaseThreadProvider } from './database-thread.provider';

const SAME_MOMENT = new Date('2026-10-20T08:00:00.000Z');

let opened: MigratedDatabase;
const provider = new DatabaseThreadProvider();

beforeAll(async () => {
  opened = openMigratedDatabase();
  database.client = opened.client;
  const prisma = database.client;
  await prisma.agentWorkspace.create({
    data: { id: 'agent-1', userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
  });
  await prisma.conversationThread.create({ data: { id: 'thread-1', agentId: 'agent-1', userId: 'user-1' } });
  // Written in this order, in one millisecond, with ids that sort the other way.
  for (const [id, role] of [['message-b', 'AGENT'], ['message-a', 'USER']] as const) {
    await prisma.conversationMessage.create({
      data: { id, threadId: 'thread-1', role, content: id, triggeredBy: 'USER_INPUT', createdAt: SAME_MOMENT },
    });
  }
});

afterAll(async () => {
  await opened?.close();
});

describe('DatabaseThreadProvider on SQLite', () => {
  it('reads rows of one millisecond for the model in the order they were written', async () => {
    expect((await provider.getMessages('thread-1')).map((m) => m.id)).toEqual(['message-b', 'message-a']);
    expect((await provider.getRecentMessages('thread-1', 10)).map((m) => m.id)).toEqual(['message-b', 'message-a']);
  });

  it('reads rows of one millisecond for a client by id', async () => {
    const view = { view: 'client' } as const;
    expect((await provider.getMessages('thread-1', view)).map((m) => m.id)).toEqual(['message-a', 'message-b']);
    expect((await provider.getRecentMessages('thread-1', 10, view)).map((m) => m.id)).toEqual(['message-a', 'message-b']);
    expect((await provider.getRecentMessages('thread-1', 10, { ...view, before: 'message-b' })).map((m) => m.id)).toEqual([
      'message-a',
    ]);
  });
});
