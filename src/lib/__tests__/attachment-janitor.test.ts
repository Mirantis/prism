/**
 * Janitor sweep tests.
 *
 * The property that matters here is isolation: every step catches its own failure,
 * so one broken store cannot stop the others from being swept for the rest of the
 * process's life.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config', () => ({
  config: { attachmentContentTtlMs: 1000, toolOutputTtlMs: 2000 },
}));

const deleteOrphans = vi.fn();
const expireContent = vi.fn();
const listLiveStoragePaths = vi.fn();
vi.mock('../../services/attachment.service', () => ({
  attachmentService: {
    deleteOrphans: (...a: unknown[]) => deleteOrphans(...a),
    expireContent: (...a: unknown[]) => expireContent(...a),
    listLiveStoragePaths: (...a: unknown[]) => listLiveStoragePaths(...a),
  },
}));

const reapScratchDirs = vi.fn();
vi.mock('../../tools/attachments', () => ({
  reapScratchDirs: (...a: unknown[]) => reapScratchDirs(...a),
}));

const reapStrayMediaFiles = vi.fn();
vi.mock('../media-store', () => ({
  reapStrayMediaFiles: (...a: unknown[]) => reapStrayMediaFiles(...a),
}));

const reapExpiredToolOutputs = vi.fn();
vi.mock('../tool-output-store', () => ({
  reapExpiredToolOutputs: (...a: unknown[]) => reapExpiredToolOutputs(...a),
}));

vi.mock('../prisma', () => ({
  prisma: { conversationThread: { findMany: vi.fn().mockResolvedValue([]) } },
}));

import { reapOrphanAttachments } from '../attachment-janitor';

beforeEach(() => {
  vi.clearAllMocks();
  deleteOrphans.mockResolvedValue(0);
  expireContent.mockResolvedValue(0);
  listLiveStoragePaths.mockResolvedValue(new Set());
  reapScratchDirs.mockResolvedValue(0);
  reapStrayMediaFiles.mockResolvedValue(0);
  reapExpiredToolOutputs.mockResolvedValue(0);
});

describe('reapOrphanAttachments', () => {
  it('sweeps saved tool outputs against their own TTL', async () => {
    await reapOrphanAttachments();

    expect(reapExpiredToolOutputs).toHaveBeenCalledWith(2000);
  });

  it('sweeps the other stores even when the saved-output sweep throws', async () => {
    reapExpiredToolOutputs.mockRejectedValue(new Error('disk gone'));

    await expect(reapOrphanAttachments()).resolves.toBeUndefined();

    expect(deleteOrphans).toHaveBeenCalled();
    expect(expireContent).toHaveBeenCalled();
    expect(reapStrayMediaFiles).toHaveBeenCalled();
  });

  it('still sweeps saved tool outputs when an earlier step throws', async () => {
    deleteOrphans.mockRejectedValue(new Error('db gone'));
    expireContent.mockRejectedValue(new Error('db gone'));

    await expect(reapOrphanAttachments()).resolves.toBeUndefined();

    expect(reapExpiredToolOutputs).toHaveBeenCalledWith(2000);
  });
});
