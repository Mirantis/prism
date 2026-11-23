/**
 * Spending reads over `llm_calls` in a database built from the committed
 * migrations, so the grouping, the indexes and the stored buckets are the real ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { openMigratedDatabase, type MigratedDatabase } from '../test-utils/migrated-database';

const { database, mockConfig } = vi.hoisted(() => ({
  database: { client: undefined as PrismaClient | undefined },
  mockConfig: { agentId: 'agent-1' } as Record<string, unknown>,
}));

vi.mock('../lib/prisma', () => {
  const prisma = new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) });
  return { prisma, default: prisma };
});
vi.mock('../config', () => ({ config: mockConfig }));

import { spendingService } from './spending.service';

const OWNER = 'agent-1';
const OTHER_AGENT = 'agent-2';
const BUCKET_MS = 15 * 60 * 1000;

let opened: MigratedDatabase;

function db(): PrismaClient {
  return database.client!;
}

interface Call {
  at: string;
  purpose?: string;
  model?: string;
  cost?: number | null;
  threadId?: string;
  requestId?: string;
  agentId?: string;
  inputTokens?: number;
  sourceKind?: string;
  sourceId?: string;
}

async function record(...calls: Call[]): Promise<void> {
  for (const call of calls) {
    const at = Date.parse(call.at);
    await db().llmCall.create({
      data: {
        agentId: call.agentId ?? OWNER,
        purpose: call.purpose ?? 'chat',
        model: call.model ?? 'claude-opus-5',
        threadId: call.threadId ?? null,
        requestId: call.requestId ?? null,
        sourceKind: call.sourceKind ?? null,
        sourceId: call.sourceId ?? null,
        inputTokens: call.inputTokens ?? 100,
        outputTokens: 10,
        costMicroUsd: call.cost === undefined ? 1000 : call.cost,
        costSource: call.cost === null ? null : 'catalog',
        createdAt: new Date(at),
        bucket: new Date(at - (at % BUCKET_MS)),
      },
    });
  }
}

beforeEach(async () => {
  opened = openMigratedDatabase();
  database.client = opened.client;
  for (const id of [OWNER, OTHER_AGENT]) {
    await db().agentWorkspace.create({
      data: { id, userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
    });
  }
});

afterEach(async () => {
  await opened.close();
});

describe('summary', () => {
  it('adds up the range by spend kind, model and purpose, and counts the unpriced calls apart', async () => {
    await record(
      { at: '2026-11-20T10:00:00Z', cost: 2500 },
      { at: '2026-11-20T10:01:00Z', purpose: 'compaction', cost: 500 },
      { at: '2026-11-20T10:02:00Z', purpose: 'coding-agent', model: 'claude-sonnet-5-5', cost: 4000 },
      { at: '2026-11-20T10:03:00Z', purpose: 'coding-agent', model: 'codex', cost: null },
      { at: '2026-11-20T10:04:00Z', purpose: 'voice-chat', model: 'gpt-realtime-2.1', cost: 1250 },
      // Outside the range, and another agent's.
      { at: '2026-11-19T09:59:59Z', cost: 99_000 },
      { at: '2026-11-20T10:05:00Z', cost: 99_000, agentId: OTHER_AGENT },
    );

    const spend = await spendingService.summary({
      from: new Date('2026-11-20T00:00:00Z'),
      to: new Date('2026-11-21T00:00:00Z'),
    });

    expect(spend).toMatchObject({ costUsd: 0.00825, calls: 5, unpricedCalls: 1, inputTokens: 500 });
    expect(spend.byKind.map(({ kind, costUsd, calls, unpricedCalls }) => ({ kind, costUsd, calls, unpricedCalls }))).toEqual([
      { kind: 'coding-agent', costUsd: 0.004, calls: 2, unpricedCalls: 1 },
      { kind: 'main', costUsd: 0.003, calls: 2, unpricedCalls: 0 },
      { kind: 'voice', costUsd: 0.00125, calls: 1, unpricedCalls: 0 },
    ]);
    expect(spend.byPurpose.map((p) => p.purpose)).toEqual(['coding-agent', 'chat', 'voice-chat', 'compaction']);
    // The calls carry no source, as calls recorded before sources were stored: a chat
    // step is a conversation, and a compaction with no request is background work.
    expect(spend.byCategory.map(({ category, costUsd }) => ({ category, costUsd }))).toEqual([
      { category: 'coding-agent', costUsd: 0.004 },
      { category: 'conversations', costUsd: 0.0025 },
      { category: 'voice', costUsd: 0.00125 },
      { category: 'background', costUsd: 0.0005 },
    ]);
    expect(spend.byModel.find((m) => m.model === 'claude-opus-5')).toMatchObject({ costUsd: 0.003, calls: 2 });
  });
});

describe('periods', () => {
  it('splits days at local midnight, a daylight-saving change included', async () => {
    // Helsinki leaves summer time on 25 October 2026, so that day is 25 hours long.
    await record(
      { at: '2026-10-24T20:59:00Z', cost: 1 }, // 23:59 on the 24th, local
      { at: '2026-10-24T21:00:00Z', cost: 10 }, // 00:00 on the 25th
      { at: '2026-10-25T21:59:00Z', cost: 100 }, // 23:59 on the 25th, after the change
      { at: '2026-10-25T22:00:00Z', cost: 1000 }, // 00:00 on the 26th
    );

    await record({ at: '2026-10-26T10:00:00Z', purpose: 'coding-agent', cost: 5000 });
    const days = await spendingService.periods('day', 3, 'Europe/Helsinki', Date.parse('2026-10-26T12:00:00Z'));

    expect(days.map(({ start, from, to, costUsd, calls }) => ({ start, from, to, costUsd, calls }))).toEqual([
      { start: '2026-10-24', from: '2026-10-23T21:00:00.000Z', to: '2026-10-24T21:00:00.000Z', costUsd: 0.000001, calls: 1 },
      { start: '2026-10-25', from: '2026-10-24T21:00:00.000Z', to: '2026-10-25T22:00:00.000Z', costUsd: 0.00011, calls: 2 },
      { start: '2026-10-26', from: '2026-10-25T22:00:00.000Z', to: '2026-10-26T22:00:00.000Z', costUsd: 0.006, calls: 2 },
    ]);
    expect(days[2].costUsdByKind).toEqual({ main: 0.001, 'coding-agent': 0.005, voice: 0 });
  });

  it('starts a week on Monday and a month on its first day, and lists empty periods', async () => {
    await record({ at: '2026-11-16T00:30:00Z', cost: 3000 }, { at: '2026-09-30T23:59:00Z', cost: 7000 });
    const now = Date.parse('2026-11-21T12:00:00Z'); // a Saturday

    const weeks = await spendingService.periods('week', 2, 'UTC', now);
    expect(weeks.map(({ start, costUsd }) => ({ start, costUsd }))).toEqual([
      { start: '2026-11-09', costUsd: 0 },
      { start: '2026-11-16', costUsd: 0.003 },
    ]);

    const months = await spendingService.periods('month', 3, 'UTC', now);
    expect(months.map(({ start, costUsd }) => ({ start, costUsd }))).toEqual([
      { start: '2026-09-01', costUsd: 0.007 },
      { start: '2026-10-01', costUsd: 0 },
      { start: '2026-11-01', costUsd: 0.003 },
    ]);
  });
});

describe('threads', () => {
  it('ranks the threads by spend, with their titles, a page at a time', async () => {
    await db().conversationThread.create({ data: { id: 'thread-a', agentId: OWNER, userId: 'user-1', title: 'Fix the build' } });
    await record(
      { at: '2026-11-20T10:00:00Z', threadId: 'thread-a', requestId: 'message-1', cost: 1000 },
      { at: '2026-11-20T11:00:00Z', threadId: 'thread-a', requestId: 'message-2', cost: 1000 },
      { at: '2026-11-20T10:30:00Z', threadId: 'thread-b', cost: 5000 },
      { at: '2026-11-20T10:30:00Z', threadId: 'thread-c', cost: 100 },
      { at: '2026-11-20T10:30:00Z', cost: 50_000 },
    );
    const range = { from: new Date('2026-11-20T00:00:00Z'), to: new Date('2026-11-21T00:00:00Z') };

    const first = await spendingService.threads(range, 2, 0);
    expect(first.threads.map(({ threadId, title, costUsd, calls }) => ({ threadId, title, costUsd, calls }))).toEqual([
      { threadId: 'thread-b', title: null, costUsd: 0.005, calls: 1 },
      { threadId: 'thread-a', title: 'Fix the build', costUsd: 0.002, calls: 2 },
    ]);
    expect(first.threads[1]).toMatchObject({
      requests: 2,
      firstCallAt: '2026-11-20T10:00:00.000Z',
      lastCallAt: '2026-11-20T11:00:00.000Z',
    });
    expect(first.nextOffset).toBe(2);

    const second = await spendingService.threads(range, 2, 2);
    expect(second.threads.map((t) => t.threadId)).toEqual(['thread-c']);
    expect(second.nextOffset).toBeNull();
  });
});

describe('thread and request', () => {
  it("lists a thread's requests newest first, with what each one was, and reads one request", async () => {
    await db().conversationThread.create({ data: { id: 'thread-a', agentId: OWNER, userId: 'user-1' } });
    await db().conversationMessage.createMany({
      data: [
        { id: 'message-1', threadId: 'thread-a', role: 'USER', triggeredBy: 'USER_INPUT', content: 'Fix   the\nflaky test in CI' },
        { id: 'task-1', threadId: 'thread-a', role: 'USER', triggeredBy: 'TASK_NOTIFICATION', content: '<task-notification>…' },
      ],
    });
    await record(
      { at: '2026-11-20T10:06:00Z', threadId: 'thread-a', requestId: 'task-1', sourceKind: 'chat', cost: 200 },
      { at: '2026-11-20T10:07:00Z', threadId: 'thread-a', requestId: 'run-1', sourceKind: 'cron', sourceId: 'cron-1', purpose: 'cron', cost: 50 },
      { at: '2026-11-20T10:05:00Z', threadId: 'thread-a', requestId: 'message-2', cost: 300 },
      { at: '2026-11-20T10:00:00Z', threadId: 'thread-a', requestId: 'message-1', cost: 1000 },
      { at: '2026-11-20T10:01:00Z', threadId: 'thread-a', requestId: 'message-1', purpose: 'coding-agent', model: 'claude-sonnet-5-5', cost: 4000 },
      { at: '2026-11-20T10:02:00Z', threadId: 'thread-a', purpose: 'thread-title', cost: 10 },
    );

    const thread = await spendingService.thread('thread-a');
    expect(thread).toMatchObject({ threadId: 'thread-a', opensInChat: true, costUsd: 0.00556, calls: 6 });
    expect(thread!.requests.map(({ requestId, kind, preview, costUsd, calls }) => ({ requestId, kind, preview, costUsd, calls }))).toEqual([
      { requestId: 'run-1', kind: 'cron', preview: null, costUsd: 0.00005, calls: 1 },
      { requestId: 'task-1', kind: 'task-result', preview: null, costUsd: 0.0002, calls: 1 },
      // A message whose row is gone is still listed, without a preview.
      { requestId: 'message-2', kind: 'other', preview: null, costUsd: 0.0003, calls: 1 },
      { requestId: 'message-1', kind: 'message', preview: 'Fix the flaky test in CI', costUsd: 0.005, calls: 2 },
    ]);

    const request = await spendingService.request('message-1');
    expect(request).toMatchObject({ requestId: 'message-1', threadId: 'thread-a', costUsd: 0.005, calls: 2 });
    expect(request!.byKind.map((k) => k.kind)).toEqual(['coding-agent', 'main']);
  });

  it("lists a category's spend per scheduled task, with each task's name", async () => {
    await db().cronTask.create({
      data: { id: 'cron-1', agentId: OWNER, userId: 'user-1', name: 'Nightly report', schedule: '0 2 * * *', instruction: 'Report' },
    });
    await record(
      { at: '2026-11-20T02:00:00Z', purpose: 'cron', sourceKind: 'cron', sourceId: 'cron-1', cost: 3000 },
      { at: '2026-11-20T02:00:01Z', purpose: 'risk-gate', sourceKind: 'cron', sourceId: 'cron-1', cost: 100 },
      // The coding task a scheduled run started is coding-agent spend, not the task's.
      { at: '2026-11-20T02:00:02Z', purpose: 'coding-agent', sourceKind: 'cron', sourceId: 'cron-1', cost: 9000 },
      { at: '2026-11-20T03:00:00Z', purpose: 'cron', sourceKind: 'cron', sourceId: 'deleted-task', cost: 500 },
      { at: '2026-11-19T03:00:00Z', purpose: 'cron', cost: 200 },
      { at: '2026-11-20T04:00:00Z', purpose: 'heartbeat', sourceKind: 'heartbeat', cost: 700 },
    );

    const sources = await spendingService.sources('scheduled-tasks', {
      from: new Date('2026-11-19T00:00:00Z'),
      to: new Date('2026-11-21T00:00:00Z'),
    });

    expect(sources.map(({ sourceId, name, costUsd, calls }) => ({ sourceId, name, costUsd, calls }))).toEqual([
      { sourceId: 'cron-1', name: 'Nightly report', costUsd: 0.0031, calls: 2 },
      { sourceId: 'deleted-task', name: null, costUsd: 0.0005, calls: 1 },
      { sourceId: null, name: null, costUsd: 0.0002, calls: 1 },
    ]);
  });

  it('opens only a web thread in chat', async () => {
    await db().conversationThread.createMany({
      data: [
        { id: 'web', agentId: OWNER, userId: 'user-1' },
        // A channel's thread with stored history: the source is the database, the id is the channel's.
        { id: 'stored-channel', agentId: OWNER, userId: 'user-1', externalThreadId: '1700000000.000100' },
        { id: 'live-channel', agentId: OWNER, userId: 'user-1', threadSource: 'SLACK', externalThreadId: '1700000000.000200' },
      ],
    });
    await record(
      { at: '2026-11-20T10:00:00Z', threadId: 'web', requestId: 'r-1' },
      { at: '2026-11-20T10:00:00Z', threadId: 'stored-channel', requestId: 'r-2' },
      { at: '2026-11-20T10:00:00Z', threadId: 'live-channel', requestId: 'r-3' },
    );

    expect((await spendingService.thread('web'))!.opensInChat).toBe(true);
    expect((await spendingService.thread('stored-channel'))!.opensInChat).toBe(false);
    expect((await spendingService.thread('live-channel'))!.opensInChat).toBe(false);
  });

  it('answers null for a thread or a request with no calls', async () => {
    expect(await spendingService.thread('nothing')).toBeNull();
    expect(await spendingService.request('nothing')).toBeNull();
  });
});
