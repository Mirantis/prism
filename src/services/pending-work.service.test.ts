/**
 * Pending Work Service Tests
 *
 * The journal of accepted, unfinished work: a row from `begin` to `end`, writes
 * to one row in the order they were made, a shutdown that keeps every row of
 * work it stopped, and a boot that reads the rows before new work arrives and
 * gives each owner its rows back, at most `MAX_RESUME_ATTEMPTS` times.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockTrackEvent } = vi.hoisted(() => ({
  mockPrisma: {
    pendingWork: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({ default: mockPrisma, prisma: mockPrisma }));
vi.mock('../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));
vi.mock('../config', () => ({ config: { agentId: 'agent-1', ownerUserId: 'owner-1' } }));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MAX_RESUME_ATTEMPTS,
  PendingWorkService,
  type PendingWorkKind,
  type PendingWorkResumer,
} from './pending-work.service';

/** A row as `findMany` returns it. */
function row(kind: string, key: string, attempts: number, payload: unknown = { key }) {
  return { kind, key, payload, attempts, createdAt: new Date('2026-10-12T08:00:00Z') };
}

function resumers(): Record<PendingWorkKind, PendingWorkResumer & ReturnType<typeof vi.fn>> {
  return {
    chat: vi.fn().mockResolvedValue(undefined),
    webhook: vi.fn().mockResolvedValue(undefined),
    'coding-task': vi.fn().mockResolvedValue(undefined),
    cron: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PendingWorkService', () => {
  let service: PendingWorkService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PendingWorkService();
    mockPrisma.pendingWork.upsert.mockResolvedValue({});
    mockPrisma.pendingWork.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.pendingWork.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.pendingWork.findMany.mockResolvedValue([]);
  });

  describe('Scenario: work from its start to its end', () => {
    it('writes the row when the work begins', async () => {
      await service.begin('chat', 'msg-1', { threadId: 'thread-1' });

      expect(mockPrisma.pendingWork.upsert).toHaveBeenCalledWith({
        where: { kind_key: { kind: 'chat', key: 'msg-1' } },
        create: { kind: 'chat', key: 'msg-1', payload: { threadId: 'thread-1' } },
        update: { payload: { threadId: 'thread-1' } },
      });
    });

    it('lets the caller refuse work it cannot record', async () => {
      mockPrisma.pendingWork.upsert.mockRejectedValueOnce(new Error('disk full'));

      await expect(service.begin('webhook', 'run-1', {})).rejects.toThrow('disk full');
    });

    it('deletes the row of each piece of work that ended, once', async () => {
      service.end('chat', ['msg-1', 'msg-2', 'msg-1']);
      await settle();

      expect(mockPrisma.pendingWork.deleteMany.mock.calls).toEqual([
        [{ where: { kind: 'chat', key: 'msg-1' } }],
        [{ where: { kind: 'chat', key: 'msg-2' } }],
      ]);
    });

    it('applies the writes to one row in the order they were made', async () => {
      const order: string[] = [];
      let finishBegin!: () => void;
      mockPrisma.pendingWork.upsert.mockImplementationOnce(
        () => new Promise<void>((resolve) => { finishBegin = () => { order.push('begin'); resolve(); }; }),
      );
      mockPrisma.pendingWork.updateMany.mockImplementationOnce(async () => { order.push('update'); });
      mockPrisma.pendingWork.deleteMany.mockImplementationOnce(async () => { order.push('end'); });

      const begun = service.begin('coding-task', 'task-1', { params: {} });
      service.update('coding-task', 'task-1', { params: {}, sessionId: 'session-1' });
      service.end('coding-task', 'task-1');
      await settle();
      expect(order).toEqual([]);

      finishBegin();
      await begun;
      await settle();
      expect(order).toEqual(['begin', 'update', 'end']);
    });

    it('keeps a finished result for its reader with no resume attempt counted against it', async () => {
      service.settle('coding-task', 'task-1', { finished: { stopReason: 'end_turn' } });
      await settle();

      expect(mockPrisma.pendingWork.updateMany).toHaveBeenCalledWith({
        where: { kind: 'coding-task', key: 'task-1' },
        data: { payload: { finished: { stopReason: 'end_turn' } }, attempts: 0 },
      });
    });
  });

  describe('Scenario: a shutdown', () => {
    it('stops the work in flight and keeps every row for the next boot', async () => {
      service.shutdown();
      service.update('coding-task', 'task-1', { finished: { stopReason: 'error' } });
      service.settle('coding-task', 'task-2', { finished: { stopReason: 'error' } });
      service.end('chat', 'msg-1');
      await settle();

      expect(service.shutdownSignal.aborted).toBe(true);
      expect(mockPrisma.pendingWork.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.pendingWork.deleteMany).not.toHaveBeenCalled();
    });

    it('still removes the row of work whose result reached its user', async () => {
      service.shutdown();
      service.finish('webhook', 'run-1');
      await service.flush();

      expect(mockPrisma.pendingWork.deleteMany).toHaveBeenCalledWith({ where: { kind: 'webhook', key: 'run-1' } });
    });

    it('waits for the writes in flight before the process exits', async () => {
      let landed = false;
      mockPrisma.pendingWork.deleteMany.mockImplementationOnce(async () => {
        await settle();
        landed = true;
      });
      service.finish('chat', 'msg-1');

      await service.flush();

      expect(landed).toBe(true);
    });

    it('still records work accepted while the process stops', async () => {
      service.shutdown();
      await service.begin('chat', 'msg-late', {});

      expect(mockPrisma.pendingWork.upsert).toHaveBeenCalled();
    });
  });

  describe('Scenario: the boot after a restart', () => {
    it('gives each owner its rows back, also an owner with none', async () => {
      mockPrisma.pendingWork.findMany.mockResolvedValue([
        row('chat', 'msg-1', 1, { threadId: 'thread-1' }),
        row('webhook', 'run-1', 1),
      ]);
      const owners = resumers();

      await service.resumeAll(await service.interrupted(), owners);

      expect(owners.chat).toHaveBeenCalledWith(
        [{ key: 'msg-1', payload: { threadId: 'thread-1' }, attempts: 1, createdAt: expect.any(Date) }],
        [],
      );
      expect(owners.webhook).toHaveBeenCalledWith([expect.objectContaining({ key: 'run-1' })], []);
      expect(owners['coding-task']).toHaveBeenCalledWith([], []);
      expect(mockTrackEvent).toHaveBeenCalledWith('work resumed', 'owner-1', {
        'agent.id': 'agent-1',
        'work.kind': 'chat',
        'work.count': '1',
        'work.dropped': '0',
      });
    });

    it('counts the boot before reading the rows', async () => {
      await service.interrupted();

      expect(mockPrisma.pendingWork.updateMany).toHaveBeenCalledWith({
        data: { attempts: { increment: 1 } },
      });
      expect(mockPrisma.pendingWork.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.pendingWork.findMany.mock.invocationCallOrder[0],
      );
    });

    it('resumes only the rows read before new work arrived', async () => {
      mockPrisma.pendingWork.findMany.mockResolvedValue([row('chat', 'msg-interrupted', 1)]);
      const interrupted = await service.interrupted();
      // A message that arrives while the channels connect is new work with its own turn.
      await service.begin('chat', 'msg-new', {});
      const owners = resumers();

      await service.resumeAll(interrupted, owners);

      expect(owners.chat).toHaveBeenCalledWith([expect.objectContaining({ key: 'msg-interrupted' })], []);
      expect(mockPrisma.pendingWork.findMany).toHaveBeenCalledTimes(1);
    });

    it(`drops work that ${MAX_RESUME_ATTEMPTS} boots in a row could not finish`, async () => {
      mockPrisma.pendingWork.findMany.mockResolvedValue([
        row('chat', 'msg-crashes', MAX_RESUME_ATTEMPTS + 1),
        row('chat', 'msg-ok', 1),
      ]);
      mockPrisma.pendingWork.deleteMany.mockResolvedValue({ count: 1 });
      const owners = resumers();

      const interrupted = await service.interrupted();
      expect(mockPrisma.pendingWork.deleteMany).not.toHaveBeenCalled();
      await service.resumeAll(interrupted, owners);
      await service.flush();

      // The row goes once its owner has closed the work, so a boot that stops first gives it up again.
      expect(mockPrisma.pendingWork.deleteMany).toHaveBeenCalledWith({ where: { kind: 'chat', key: 'msg-crashes' } });
      expect(owners.chat.mock.invocationCallOrder[0]).toBeLessThan(
        mockPrisma.pendingWork.deleteMany.mock.invocationCallOrder[0],
      );
      // The owner gets the dropped work too, so a schedule that would start it again closes it.
      expect(owners.chat).toHaveBeenCalledWith(
        [expect.objectContaining({ key: 'msg-ok' })],
        [expect.objectContaining({ key: 'msg-crashes' })],
      );
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'work resumed',
        'owner-1',
        expect.objectContaining({ 'work.count': '1', 'work.dropped': '1' }),
      );
    });

    it('gives the coding tasks back before the replies and runs that poll them', async () => {
      mockPrisma.pendingWork.findMany.mockResolvedValue([row('chat', 'msg-1', 1), row('coding-task', 'task-1', 1)]);
      const owners = resumers();
      let restored!: () => void;
      owners['coding-task'].mockReturnValue(new Promise<void>((resolve) => (restored = resolve)));

      const resuming = service.resumeAll(await service.interrupted(), owners);
      await vi.waitFor(() => expect(owners['coding-task']).toHaveBeenCalled());
      expect(owners.chat).not.toHaveBeenCalled();
      restored();
      await resuming;

      expect(owners.chat).toHaveBeenCalledWith([expect.objectContaining({ key: 'msg-1' })], []);
    });

    it('keeps the work given up when its owner could not close it', async () => {
      mockPrisma.pendingWork.findMany.mockResolvedValue([row('cron', 'task-loop', MAX_RESUME_ATTEMPTS + 1)]);
      const owners = resumers();
      owners.cron.mockRejectedValue(new Error('database locked'));

      await service.resumeAll(await service.interrupted(), owners);
      await service.flush();

      expect(mockPrisma.pendingWork.deleteMany).not.toHaveBeenCalled();
    });

    it('gives the other owners their rows when one owner fails', async () => {
      mockPrisma.pendingWork.findMany.mockResolvedValue([row('chat', 'msg-1', 1), row('webhook', 'run-1', 1)]);
      const owners = resumers();
      owners.chat.mockRejectedValue(new Error('thread table locked'));

      await service.resumeAll(await service.interrupted(), owners);

      expect(owners.webhook).toHaveBeenCalled();
    });
  });
});
