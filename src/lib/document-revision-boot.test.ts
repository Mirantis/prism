/**
 * Boot Baseline Tests
 *
 * The boot step must not be able to stop a container from starting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '@prisma/client';

const { mockRecordMissingBaselines, mockLogger } = vi.hoisted(() => ({
  mockRecordMissingBaselines: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/document-revision.service', () => ({
  documentRevisionService: { recordMissingBaselines: mockRecordMissingBaselines },
}));

vi.mock('../logger', () => ({ logger: mockLogger }));

import { backfillDocumentRevisions } from './document-revision-boot';

const agent = { id: 'agent-1' } as AgentWorkspace;

describe('backfillDocumentRevisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports the documents it recorded a baseline for', async () => {
    mockRecordMissingBaselines.mockResolvedValue(['soulMd', 'visionMd']);

    await backfillDocumentRevisions(agent);

    expect(mockRecordMissingBaselines).toHaveBeenCalledWith(agent);
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it('logs nothing when every document already has a revision', async () => {
    mockRecordMissingBaselines.mockResolvedValue([]);

    await backfillDocumentRevisions(agent);

    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('swallows its own failure, so boot continues', async () => {
    mockRecordMissingBaselines.mockRejectedValue(new Error('database is locked'));

    await expect(backfillDocumentRevisions(agent)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
