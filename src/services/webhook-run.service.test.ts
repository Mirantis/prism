/**
 * Webhook Run Service Tests
 *
 * The run record behind the Activity page: what each lifecycle step writes, the
 * bound, the boot sweep, and the shape a page and a detail read serve.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => {
  const webhookRun = {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
  };
  return {
    mockPrisma: {
      webhookRun,
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({ webhookRun })),
    },
  };
});

vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { webhookRunService, MAX_WEBHOOK_RUNS, INTERRUPTED_ERROR } from './webhook-run.service';
import { config } from '../config';
import { logger } from '../logger';

const EVENT = { id: 'run-1', agentId: 'agent-1', name: 'alerts', event: 'push' };

/** A run row as the summary select returns it. */
function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: 'alerts',
    event: 'push',
    status: 'completed',
    error: null,
    createdAt: new Date('2026-10-05T09:00:00.000Z'),
    finishedAt: new Date('2026-10-05T09:00:30.000Z'),
    message: {
      id: `msg-${id}`,
      threadId: 'thread-1',
      thread: { title: 'Alerts', externalThreadId: null },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (config as { agentId?: string }).agentId = 'agent-1';
  mockPrisma.webhookRun.findMany.mockResolvedValue([]);
});

describe('webhookRunService writes', () => {
  it('accepts an event in the status the caller names', async () => {
    await webhookRunService.accept(EVENT, 'queued');
    await webhookRunService.accept({ ...EVENT, id: 'run-2' }, 'running');

    expect(mockPrisma.webhookRun.create).toHaveBeenNthCalledWith(1, { data: { ...EVENT, status: 'queued' } });
    expect(mockPrisma.webhookRun.create).toHaveBeenNthCalledWith(2, {
      data: { ...EVENT, id: 'run-2', status: 'running' },
    });
  });

  it('trims only finished rows beyond the bound, in the insert transaction', async () => {
    mockPrisma.webhookRun.findMany.mockResolvedValue([{ id: 'old-1' }, { id: 'old-2' }]);

    await webhookRunService.accept(EVENT, 'queued');

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // A queued or running row has a worker that still writes to it.
    expect(mockPrisma.webhookRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: 'agent-1', status: { notIn: ['queued', 'running'] } },
        skip: MAX_WEBHOOK_RUNS,
      }),
    );
    expect(mockPrisma.webhookRun.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-1', 'old-2'] } },
    });
  });

  it('deletes nothing while under the bound', async () => {
    await webhookRunService.accept(EVENT, 'queued');

    expect(mockPrisma.webhookRun.deleteMany).not.toHaveBeenCalled();
  });

  it('marks a run running when its turn comes', async () => {
    await webhookRunService.start('run-1');

    expect(mockPrisma.webhookRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'running' },
    });
  });

  it('finishes a run with its result, the message and the time', async () => {
    await webhookRunService.finish('run-1', { status: 'completed', messageId: 'msg-1' });

    expect(mockPrisma.webhookRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'completed', error: null, messageId: 'msg-1', finishedAt: expect.any(Date) },
    });
  });

  it('caps a long error', async () => {
    await webhookRunService.finish('run-1', { status: 'failed', error: 'x'.repeat(5000) });

    const { data } = mockPrisma.webhookRun.update.mock.calls[0][0];
    expect(data.error.length).toBeLessThan(2100);
    expect(data.messageId).toBeNull();
  });

  it('throws when an event cannot be accepted, so the request fails before anything runs', async () => {
    mockPrisma.webhookRun.create.mockRejectedValue(new Error('database is locked'));

    await expect(webhookRunService.accept(EVENT, 'queued')).rejects.toThrow('database is locked');
  });

  it('logs and returns when a run under way cannot be marked running or finished', async () => {
    mockPrisma.webhookRun.update.mockRejectedValue(new Error('database is locked'));

    await expect(webhookRunService.start('run-1')).resolves.toBeUndefined();
    await expect(
      webhookRunService.finish('run-1', { status: 'completed', messageId: 'msg-1' }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), runId: 'run-1' }),
      expect.any(String),
    );
  });

  it('fails the runs a restart cut off', async () => {
    mockPrisma.webhookRun.updateMany.mockResolvedValue({ count: 2 });

    const count = await webhookRunService.failInterrupted('agent-1');

    expect(count).toBe(2);
    expect(mockPrisma.webhookRun.updateMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-1', status: { in: ['queued', 'running'] } },
      data: { status: 'failed', error: INTERRUPTED_ERROR, finishedAt: expect.any(Date) },
    });
  });
});

describe('webhookRunService.page', () => {
  it('reads this agent\'s runs newest first, one past the page to tell if more follow', async () => {
    await webhookRunService.page(10);

    expect(mockPrisma.webhookRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: 'agent-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 11,
      }),
    );
  });

  it('resumes after the cursor row', async () => {
    await webhookRunService.page(10, 'run-9');

    expect(mockPrisma.webhookRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'run-9' }, skip: 1 }),
    );
  });

  it('gives a cursor naming the last item when more rows follow', async () => {
    mockPrisma.webhookRun.findMany.mockResolvedValue([row('a'), row('b'), row('c')]);

    const page = await webhookRunService.page(2);

    expect(page.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('b');
  });

  it('ends the list when the page is the last', async () => {
    mockPrisma.webhookRun.findMany.mockResolvedValue([row('a')]);

    const page = await webhookRunService.page(2);

    expect(page.nextCursor).toBeNull();
  });

  it('says whether the delivered message sits in a web conversation', async () => {
    mockPrisma.webhookRun.findMany.mockResolvedValue([
      row('web'),
      row('slack', {
        message: { id: 'msg-s', threadId: 'thread-s', thread: { title: null, externalThreadId: 'D123' } },
      }),
      row('gone', { message: null }),
    ]);

    const { items } = await webhookRunService.page(10);

    expect(items[0].message).toEqual({
      id: 'msg-web',
      threadId: 'thread-1',
      threadTitle: 'Alerts',
      inWebChat: true,
    });
    expect(items[1].message?.inWebChat).toBe(false);
    expect(items[2].message).toBeNull();
  });

  it('answers empty with no agent resolved', async () => {
    (config as { agentId?: string }).agentId = undefined;

    expect(await webhookRunService.page(10)).toEqual({ items: [], nextCursor: null });
    expect(mockPrisma.webhookRun.findMany).not.toHaveBeenCalled();
  });
});

describe('webhookRunService.get', () => {
  it('serves the delivered message and its tool calls in step order', async () => {
    mockPrisma.webhookRun.findFirst.mockResolvedValue(
      row('run-1', {
        message: {
          id: 'msg-1',
          threadId: 'thread-1',
          thread: { title: 'Alerts', externalThreadId: null },
          content: 'All clear.',
          toolCalls: [
            { tool: 'first', input: '{}', output: 'a', success: true, timestamp: 't1' },
            { tool: 'second', input: '{}', output: 'b', success: false, timestamp: 't2' },
          ],
        },
      }),
    );

    const run = await webhookRunService.get('run-1');

    expect(mockPrisma.webhookRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run-1', agentId: 'agent-1' } }),
    );
    expect(run?.delivered?.content).toBe('All clear.');
    expect(run?.delivered?.toolCalls.map((c) => c.tool)).toEqual(['first', 'second']);
  });

  it('serves no delivered message for a run that delivered none', async () => {
    mockPrisma.webhookRun.findFirst.mockResolvedValue(row('run-1', { message: null, status: 'failed' }));

    const run = await webhookRunService.get('run-1');

    expect(run?.delivered).toBeNull();
    expect(run?.status).toBe('failed');
  });

  it('answers null for a run this agent does not have', async () => {
    mockPrisma.webhookRun.findFirst.mockResolvedValue(null);

    expect(await webhookRunService.get('nope')).toBeNull();
  });
});
