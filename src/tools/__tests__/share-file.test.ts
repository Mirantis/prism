/**
 * share_file tool tests.
 *
 * Covers the workspace security boundary (mirrors the shell file tools),
 * the size/empty/not-found guards, and the happy path that persists an
 * agent-sourced attachment with magic-byte media detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runShareFile } from '../share-file';
import { attachmentService } from '../../services/attachment.service';
import { MAX_FILE_SIZE_BYTES } from '../../constants';

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
});
