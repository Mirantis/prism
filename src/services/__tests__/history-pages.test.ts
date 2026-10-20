/**
 * Paged history on a database built from the committed migrations. A page shows a
 * concise turn's hidden tool calls on its answer as the whole history does, also when
 * a heartbeat posted while the turn ran and the answer opens the page.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../../test-utils/migrated-database';

const database = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock('../../lib/prisma', () => {
  const client = new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) });
  return { default: client, prisma: client };
});

import { conversationService } from '../conversation.service';

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 8, 0, second));
const call = (id: string) => ({ id, tool: `tool-${id}`, input: '{}', output: 'ok', success: true });
const callIds = (message?: { toolCalls: unknown }) =>
  ((message?.toolCalls ?? []) as Array<{ id: string }>).map((c) => c.id);

let opened: MigratedDatabase;

beforeAll(async () => {
  opened = openMigratedDatabase();
  database.client = opened.client;
  const prisma = database.client;
  await prisma.agentWorkspace.create({
    data: { id: 'agent-1', userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
  });
  await prisma.conversationThread.create({ data: { id: 'thread-1', agentId: 'agent-1', userId: 'user-1' } });
  // A question, a concise turn's steps with a heartbeat posted between them, and the answer.
  const rows = [
    { id: 'question', role: 'USER', second: 1 },
    { id: 'step-1', role: 'AGENT', second: 2, internalStep: true, toolCalls: [call('a')] },
    { id: 'heartbeat', role: 'AGENT', second: 3, triggeredBy: 'HEARTBEAT' },
    { id: 'step-2', role: 'AGENT', second: 4, internalStep: true, toolCalls: [call('b')] },
    { id: 'answer', role: 'AGENT', second: 5 },
  ] as const;
  for (const row of rows) {
    await prisma.conversationMessage.create({
      data: {
        id: row.id,
        threadId: 'thread-1',
        role: row.role,
        content: row.id,
        triggeredBy: 'triggeredBy' in row ? row.triggeredBy : 'USER_INPUT',
        internalStep: 'internalStep' in row ? row.internalStep : false,
        ...('toolCalls' in row ? { toolCalls: row.toolCalls } : {}),
        createdAt: at(row.second),
      },
    });
  }
});

afterAll(async () => {
  await opened?.close();
});

describe('a page of history', () => {
  it('shows the calls of a turn that a heartbeat interrupted on its answer, as the whole history does', async () => {
    const whole = await conversationService.getRecentMessages('thread-1', 50);
    const newest = await conversationService.getRecentMessages('thread-1', 1);
    const older = await conversationService.getRecentMessages('thread-1', 50, 'answer');

    expect(whole.map((m) => m.id)).toEqual(['question', 'heartbeat', 'answer']);
    expect(callIds(whole.find((m) => m.id === 'answer'))).toEqual(['a', 'b']);
    expect(newest.map((m) => [m.id, callIds(m)])).toEqual([['answer', ['a', 'b']]]);
    expect(older.map((m) => [m.id, callIds(m)])).toEqual([
      ['question', []],
      ['heartbeat', []],
    ]);
  });
});
