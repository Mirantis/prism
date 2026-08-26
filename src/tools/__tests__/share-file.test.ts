/**
 * share_file tool tests.
 *
 * Covers the workspace security boundary (mirrors the shell file tools),
 * the size/empty/not-found guards, the happy path that persists an
 * agent-sourced attachment with magic-byte media detection, and the sequencing
 * against writes in the same step — the case where the tool was called correctly
 * and still captured the wrong revision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { runShareFile } from '../share-file';
import { createPendingFileWrites } from '../../lib/pending-file-writes';
import { attachmentService } from '../../services/attachment.service';
import { logger } from '../../logger';
import { MAX_FILE_SIZE_BYTES } from '../../constants';

const sha256 = (data: string | Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

// 8-byte PNG signature — detectMediaType sniffs the first bytes for the type.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('runShareFile', () => {
  let workspace: string;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'share-file-test-'));
    // Stub persistence: return a row echoing the input plus a generated id.
    createSpy = vi
      .spyOn(attachmentService, 'create')
      .mockImplementation(async (input) => ({
        id: 'att-generated',
        messageId: null,
        threadId: null,
        slackFileId: null,
        externalTs: null,
        createdAt: new Date(),
        ...input,
        data: Buffer.from(input.data),
      }) as unknown as Awaited<ReturnType<typeof attachmentService.create>>);
  });

  afterEach(async () => {
    createSpy.mockRestore();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('rejects an absolute path outside the workspace', async () => {
    const result = await runShareFile({ path: '/etc/hosts' }, workspace);
    expect(result).toEqual({ success: false, error: 'Path outside workspace' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects a relative path that escapes via ..', async () => {
    const result = await runShareFile({ path: '../../etc/hosts' }, workspace);
    expect(result).toEqual({ success: false, error: 'Path outside workspace' });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('returns a friendly error when the file does not exist', async () => {
    const result = await runShareFile({ path: 'nope.txt' }, workspace);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it('rejects an empty file', async () => {
    await fs.writeFile(path.join(workspace, 'empty.txt'), '');
    const result = await runShareFile({ path: 'empty.txt' }, workspace);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/empty/i);
  });

  it('rejects a directory', async () => {
    await fs.mkdir(path.join(workspace, 'sub'));
    const result = await runShareFile({ path: 'sub' }, workspace);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/directory/i);
  });

  it('rejects a file over the size cap (without reading it)', async () => {
    const big = path.join(workspace, 'big.bin');
    // Sparse file: sets size past the cap cheaply; the size check fires first.
    const handle = await fs.open(big, 'w');
    await handle.truncate(MAX_FILE_SIZE_BYTES + 1);
    await handle.close();
    const result = await runShareFile({ path: 'big.bin' }, workspace);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/too large/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('shares a PNG: detects image type and persists with source "agent"', async () => {
    await fs.writeFile(path.join(workspace, 'chart.png'), PNG_HEADER);
    const result = await runShareFile({ path: 'chart.png' }, workspace);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attachmentId).toBe('att-generated');
    expect(result.filename).toBe('chart.png');
    expect(result.mediaType).toBe('image/png');
    expect(result.category).toBe('image');

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent', filename: 'chart.png', category: 'image' }),
    );
  });

  it('shares a text file and honors an explicit display filename', async () => {
    await fs.writeFile(path.join(workspace, 'out.csv'), 'a,b\n1,2\n');
    const result = await runShareFile({ path: 'out.csv', filename: 'report.csv' }, workspace);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filename).toBe('report.csv');
    expect(result.category).toBe('text');
  });

  describe('sequencing against writes in the same step', () => {
    // The reported defect: the model asked for the edit and the share in one
    // assistant message, the SDK ran them concurrently, and the read won — so the
    // attachment held the pre-edit bytes while the reply described the new ones.
    it('captures the bytes the sibling write produced, not the ones it replaced', async () => {
      const file = path.join(workspace, 'draft.md');
      const rev1 = 'rev 1\n';
      const rev2 = 'rev 2, considerably longer than the first\n';
      await fs.writeFile(file, rev1);

      const pendingWrites = createPendingFileWrites();
      pendingWrites.register('call-write', 'shell_edit_file', file);
      pendingWrites.announce('call-share', 'share_file');

      // Deliberately not awaited: this is the concurrency the step has.
      const sharing = runShareFile({ path: 'draft.md' }, workspace, {
        pendingWrites,
        toolCallId: 'call-share',
      });

      await fs.writeFile(file, rev2);
      pendingWrites.settle('call-write');

      const result = await sharing;
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sizeBytes).toBe(Buffer.byteLength(rev2));
      expect(result.digest).toBe(sha256(rev2));
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ data: Buffer.from(rev2), sizeBytes: Buffer.byteLength(rev2) }),
      );
    });

    it('waits for a write that has not created the file yet', async () => {
      const file = path.join(workspace, 'fresh.txt');
      const pendingWrites = createPendingFileWrites();
      pendingWrites.register('call-write', 'shell_write_file', file);
      pendingWrites.announce('call-share', 'share_file');

      const sharing = runShareFile({ path: 'fresh.txt' }, workspace, {
        pendingWrites,
        toolCallId: 'call-share',
      });

      await fs.writeFile(file, 'created by the sibling write\n');
      pendingWrites.settle('call-write');

      // Without the barrier this is today's "File not found" for a file the same
      // step is writing.
      await expect(sharing).resolves.toMatchObject({ success: true });
    });

    it('does not wait on a write to a different file', async () => {
      await fs.writeFile(path.join(workspace, 'draft.md'), 'ready\n');
      const pendingWrites = createPendingFileWrites();
      // Never settled — if the path match were loose this would time out.
      pendingWrites.register('call-write', 'shell_write_file', path.join(workspace, 'other.md'));
      pendingWrites.announce('call-share', 'share_file');

      const result = await runShareFile({ path: 'draft.md' }, workspace, {
        pendingWrites,
        toolCallId: 'call-share',
        pendingWriteTimeoutMs: 50,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.digest).toBe(sha256('ready\n'));
    });

    it('refuses to share rather than attach the older copy when the write never lands', async () => {
      await fs.writeFile(path.join(workspace, 'draft.md'), 'stale\n');
      const pendingWrites = createPendingFileWrites();
      pendingWrites.register('call-write', 'shell_edit_file', path.join(workspace, 'draft.md'));
      pendingWrites.announce('call-share', 'share_file');

      const result = await runShareFile({ path: 'draft.md' }, workspace, {
        pendingWrites,
        toolCallId: 'call-share',
        pendingWriteTimeoutMs: 20,
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/was writing/i);
      expect(result.error).toMatch(/shell_edit_file/);
      // Points at the write's own result rather than promising one it may never
      // return: the risk gate can reject a call before its handler ever runs.
      expect(result.error).toMatch(/Check that write's result/i);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('stops waiting when the turn is cancelled', async () => {
      await fs.writeFile(path.join(workspace, 'draft.md'), 'stale\n');
      const pendingWrites = createPendingFileWrites();
      pendingWrites.register('call-write', 'shell_edit_file', path.join(workspace, 'draft.md'));
      pendingWrites.announce('call-share', 'share_file');
      const controller = new AbortController();
      controller.abort();

      const result = await runShareFile({ path: 'draft.md' }, workspace, {
        pendingWrites,
        toolCallId: 'call-share',
        abortSignal: controller.signal,
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toMatch(/cancelled/i);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('shares unsequenced when no registry is supplied', async () => {
      await fs.writeFile(path.join(workspace, 'draft.md'), 'plain\n');
      await expect(runShareFile({ path: 'draft.md' }, workspace)).resolves.toMatchObject({
        success: true,
      });
    });

    // The canary. An empty registry means either "no writes this step" or "the
    // announce hook never ran", and those must not be read alike — otherwise a
    // future SDK change silently restores the defect.
    it('shares unsequenced, with a warning, when its own call was never announced', async () => {
      const file = path.join(workspace, 'draft.md');
      await fs.writeFile(file, 'plain\n');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

      const pendingWrites = createPendingFileWrites();
      // A write is pending on this very path, but share_file was not announced,
      // so it cannot trust the registry and must not block on it.
      pendingWrites.register('call-write', 'shell_edit_file', file);

      const result = await runShareFile({ path: 'draft.md' }, workspace, {
        pendingWrites,
        toolCallId: 'call-share',
        pendingWriteTimeoutMs: 20,
      });

      expect(result.success).toBe(true);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

});
