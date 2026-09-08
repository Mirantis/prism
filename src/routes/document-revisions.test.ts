/**
 * Identity-Document Revision Route Tests
 *
 * The history read and its drift flag, one revision with its content, and the
 * restore: the rollback revision it appends, the 409 that refuses a stale
 * expected revision, and the heartbeat restart a restored heartbeat config
 * needs. The lock that withholds the agent's document tools does not reach a
 * restore, so a locked agent still restores.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetAgent, mockPrisma, mockTrackEvent, mockStartHeartbeat } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockPrisma: {
    // The transaction client is the same mock, so the restore's column write and
    // its revision are asserted like any other call.
    $transaction: vi.fn(),
    agentWorkspace: {
      update: vi.fn(),
    },
    agentWorkspaceRevision: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  mockTrackEvent: vi.fn(),
  mockStartHeartbeat: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../lib/telemetry', () => ({
  langfuseTelemetry: () => ({}),
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: () => false,
}));

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../services/heartbeat.service', () => ({
  heartbeatService: { startHeartbeat: mockStartHeartbeat },
}));

// Keep the real service, so the restore and its transaction are the real
// implementations, and redirect `getAgent` to the controllable mock.
vi.mock('../services/agent-workspace.service', async () => {
  const actual = await vi.importActual<typeof import('../services/agent-workspace.service')>(
    '../services/agent-workspace.service',
  );
  (actual.agentWorkspaceService as unknown as { getAgent: typeof mockGetAgent }).getAgent =
    mockGetAgent;
  return actual;
});

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { documentRevisionsRouter } from './document-revisions';
import { MAX_REVISIONS_PER_DOCUMENT } from '../services/document-revision.service';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/agents', documentRevisionsRouter);
  return app;
}

const SOUL = '# Soul\n\nDirect, and short.\n';

function createAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    userId: 'user-1',
    agentMd: '# Guide',
    soulMd: SOUL,
    userMd: '# User',
    heartbeatMd: '# Heartbeat',
    memoryMd: '# Memory',
    visionMd: '',
    bootstrapMd: '# Bootstrap',
    ...overrides,
  };
}

function summaryRow(id = 'rev-2') {
  return {
    id,
    actor: 'agent',
    method: 'replace',
    reason: 'Sharpened the tone.',
    createdAt: new Date('2026-09-04T09:00:00.000Z'),
  };
}

/**
 * The two reads the history makes: the summaries, and then the ids of the
 * revisions holding what the document reads now. The second is the one filtered
 * on `content`.
 */
function historyReads(summaries: Array<{ id: string }>, matchingIds: string[]): void {
  mockPrisma.agentWorkspaceRevision.findMany.mockImplementation(
    (args: { where: { content?: string } }) =>
      Promise.resolve(
        args.where.content === undefined ? summaries : matchingIds.map((id) => ({ id })),
      ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
  );
  mockPrisma.agentWorkspaceRevision.findMany.mockResolvedValue([]);
  mockPrisma.agentWorkspaceRevision.create.mockResolvedValue({ id: 'rev-new' });
  mockPrisma.agentWorkspace.update.mockResolvedValue(createAgentRow());
  mockGetAgent.mockResolvedValue(createAgentRow());
});

describe('GET /agents/documents/:field/revisions', () => {
  it('answers the history newest first, with the retention bound and no content', async () => {
    historyReads([summaryRow('rev-2'), summaryRow('rev-1')], ['rev-2']);

    const res = await request(createTestApp()).get('/agents/documents/soulMd/revisions');

    expect(res.status).toBe(200);
    expect(res.body.field).toBe('soulMd');
    expect(res.body.bound).toBe(MAX_REVISIONS_PER_DOCUMENT);
    expect(res.body.revisions.map((row: { id: string }) => row.id)).toEqual(['rev-2', 'rev-1']);
    expect(res.body.revisions[0]).not.toHaveProperty('content');
    expect(res.body.revisions.map((row: { matchesCurrent: boolean }) => row.matchesCurrent)).toEqual(
      [true, false],
    );
  });

  it('reports no drift while the document agrees with its newest revision', async () => {
    historyReads([summaryRow()], ['rev-2']);

    const res = await request(createTestApp()).get('/agents/documents/soulMd/revisions');

    expect(res.body.drifted).toBe(false);
  });

  it('reports drift for a document written outside the write path', async () => {
    mockGetAgent.mockResolvedValue(createAgentRow({ visionMd: '# Written straight into the file' }));
    historyReads([summaryRow('rev-5')], []);

    const res = await request(createTestApp()).get('/agents/documents/visionMd/revisions');

    expect(res.body.drifted).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'agent document drift detected',
      null,
      expect.objectContaining({ 'agent.id': 'agent-1', 'config.field': 'visionMd' }),
    );
  });

  it('reports no drift for a document with no revision yet', async () => {
    const res = await request(createTestApp()).get('/agents/documents/bootstrapMd/revisions');

    expect(res.status).toBe(200);
    expect(res.body.drifted).toBe(false);
    expect(res.body.revisions).toEqual([]);
  });

  it('answers 400 for a field that is not an identity document', async () => {
    const res = await request(createTestApp()).get('/agents/documents/modelId/revisions');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('modelId');
    expect(mockPrisma.agentWorkspaceRevision.findMany).not.toHaveBeenCalled();
  });

  it('answers 500 when the read throws', async () => {
    mockPrisma.agentWorkspaceRevision.findMany.mockRejectedValue(new Error('database is locked'));

    const res = await request(createTestApp()).get('/agents/documents/soulMd/revisions');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('database is locked');
  });
});

describe('GET /agents/documents/:field/revisions/:id', () => {
  it('answers one revision with its content', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue({
      ...summaryRow(),
      content: SOUL,
    });

    const res = await request(createTestApp()).get('/agents/documents/soulMd/revisions/rev-2');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe(SOUL);
    expect(mockPrisma.agentWorkspaceRevision.findFirst).toHaveBeenCalledWith({
      where: { id: 'rev-2', agentId: 'agent-1', field: 'soulMd' },
    });
  });

  it('answers 404 for a revision that belongs to another document', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue(null);

    const res = await request(createTestApp()).get('/agents/documents/soulMd/revisions/rev-9');

    expect(res.status).toBe(404);
  });

  it('answers 400 for a field that is not an identity document', async () => {
    const res = await request(createTestApp()).get('/agents/documents/name/revisions/rev-2');

    expect(res.status).toBe(400);
    expect(mockPrisma.agentWorkspaceRevision.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /agents/documents/:field/revisions/:id/restore', () => {
  const target = {
    id: 'rev-1',
    content: '# Older soul',
    createdAt: new Date('2026-09-01T08:30:00.000Z'),
  };

  /** The target revision, then the newest one, which is what the caller names. */
  function revisionReads(newestId: string | null) {
    mockPrisma.agentWorkspaceRevision.findFirst.mockReset();
    mockPrisma.agentWorkspaceRevision.findFirst
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(newestId === null ? null : { id: newestId });
  }

  it('writes the restored content and appends a rollback revision', async () => {
    revisionReads('rev-2');

    const res = await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2', reason: 'The rewrite lost the boundaries.' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      field: 'soulMd',
      content: '# Older soul',
      revision: { id: 'rev-new' },
    });
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { soulMd: '# Older soul' },
    });
    expect(mockPrisma.agentWorkspaceRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        field: 'soulMd',
        content: '# Older soul',
        actor: 'user',
        method: 'rollback',
        reason: 'The rewrite lost the boundaries.',
      }),
    });
  });

  it('answers 409 and writes nothing when the caller names a stale revision', async () => {
    revisionReads('rev-written-since');

    const res = await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(res.status).toBe(409);
    expect(res.body.newestRevisionId).toBe('rev-written-since');
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
    expect(mockPrisma.agentWorkspaceRevision.create).not.toHaveBeenCalled();
  });

  it('answers 404 for a revision id this document does not have', async () => {
    mockPrisma.agentWorkspaceRevision.findFirst.mockResolvedValue(null);

    const res = await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-9/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(res.status).toBe(404);
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('answers 400 without writing when the body names no expected revision', async () => {
    const res = await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-1/restore')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('expectedRevisionId');
    expect(mockPrisma.agentWorkspaceRevision.findFirst).not.toHaveBeenCalled();
  });

  it('answers 400 for a field that is not an identity document', async () => {
    const res = await request(createTestApp())
      .post('/agents/documents/timezone/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(res.status).toBe(400);
    expect(mockPrisma.agentWorkspace.update).not.toHaveBeenCalled();
  });

  it('restarts the heartbeat after restoring the heartbeat config', async () => {
    revisionReads('rev-2');

    const res = await request(createTestApp())
      .post('/agents/documents/heartbeatMd/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(res.status).toBe(200);
    expect(mockStartHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('restarts nothing after restoring another document', async () => {
    revisionReads('rev-2');

    await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(mockStartHeartbeat).not.toHaveBeenCalled();
  });

  // The lock withholds the agent's own document tools. A restore is the user
  // acting, so it stays open, the same as the agent-guide editor does.
  it('restores while locked-in mode is on', async () => {
    mockGetAgent.mockResolvedValue(createAgentRow({ lockedIn: true }));
    revisionReads('rev-2');

    const res = await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(res.status).toBe(200);
    expect(mockPrisma.agentWorkspace.update).toHaveBeenCalled();
  });

  it('answers 500 when the column write throws', async () => {
    revisionReads('rev-2');
    mockPrisma.agentWorkspace.update.mockRejectedValue(new Error('database is locked'));

    const res = await request(createTestApp())
      .post('/agents/documents/soulMd/revisions/rev-1/restore')
      .send({ expectedRevisionId: 'rev-2' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('database is locked');
  });
});
