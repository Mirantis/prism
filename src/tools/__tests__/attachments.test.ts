import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runHydrateAttachment, reapScratchDirs } from '../attachments';
import { attachmentService } from '../../services/attachment.service';
import { trackEvent } from '../../lib/telemetry';

vi.mock('../../lib/telemetry', () => ({
  trackEvent: vi.fn(),
}));

const THREAD_ID = 'thread-001';
const AGENT_ID = 'agent-001';
const USER_ID = 'user-001';
const ATTACHMENT_ID = 'att-001';

function makeRow(overrides: Partial<{
  id: string;
  threadId: string | null;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  data: Buffer;
}> = {}) {
  return {
    id: ATTACHMENT_ID,
    threadId: THREAD_ID,
    messageId: 'msg-001',
    filename: 'report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1024,
    category: 'pdf',
    data: Buffer.from('fake-pdf-content'),
    source: 'web',
    slackFileId: null,
    externalTs: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('runHydrateAttachment', () => {
  let workspace: string;
  let getByIdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrate-test-'));
    getByIdSpy = vi.spyOn(attachmentService, 'getById');
    vi.mocked(trackEvent).mockClear();
  });

  afterEach(async () => {
    getByIdSpy.mockRestore();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('returns not-found when threadId is undefined', async () => {
    getByIdSpy.mockResolvedValue(makeRow());
    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, undefined, workspace,
    );

    expect(result).toEqual({ success: false, error: 'Attachment not found.' });
    expect(getByIdSpy).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('attachment hydrate failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('returns not-found when attachment belongs to a different thread', async () => {
    getByIdSpy.mockResolvedValue(makeRow({ threadId: 'other-thread' }));
    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result).toEqual({ success: false, error: 'Attachment not found.' });
    expect(trackEvent).toHaveBeenCalledWith('attachment hydrate failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('returns not-found when attachment does not exist', async () => {
    getByIdSpy.mockResolvedValue(null);
    const result = await runHydrateAttachment(
      { attachmentId: 'nonexistent' },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result).toEqual({ success: false, error: 'Attachment not found.' });
    expect(trackEvent).toHaveBeenCalledWith('attachment hydrate failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': 'nonexistent',
    });
  });

  it('writes file to correct scratch path and returns metadata (happy path)', async () => {
    const data = Buffer.from('hello world');
    getByIdSpy.mockResolvedValue(makeRow({
      data,
      filename: 'notes.txt',
      mediaType: 'text/plain',
      sizeBytes: data.length,
    }));

    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const expectedDir = path.join(workspace, '.attachments', THREAD_ID, ATTACHMENT_ID);
    expect(result.path).toBe(path.join(expectedDir, 'notes.txt'));
    expect(result.filename).toBe('notes.txt');
    expect(result.mediaType).toBe('text/plain');
    expect(result.sizeBytes).toBe(data.length);

    const written = await fs.readFile(result.path);
    expect(written.toString()).toBe('hello world');

    expect(trackEvent).toHaveBeenCalledWith('attachment hydrated', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
      'attachment.category': 'text',
      'attachment.size_bytes': String(data.length),
    });
  });

  it('sanitizes filenames with path traversal attempts', async () => {
    const data = Buffer.from('malicious');
    getByIdSpy.mockResolvedValue(makeRow({
      data,
      filename: '../../etc/passwd',
      mediaType: 'text/plain',
      sizeBytes: data.length,
    }));

    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const scratchDir = path.join(workspace, '.attachments', THREAD_ID, ATTACHMENT_ID);
    expect(result.path.startsWith(scratchDir)).toBe(true);
    expect(result.filename).not.toContain('..');
    expect(result.filename).not.toContain('/');

    const written = await fs.readFile(result.path);
    expect(written.toString()).toBe('malicious');
  });

  it('sanitizes filenames with backslash separators', async () => {
    const data = Buffer.from('test');
    getByIdSpy.mockResolvedValue(makeRow({
      data,
      filename: 'foo\\bar\\..\\..\\secret.txt',
      mediaType: 'text/plain',
      sizeBytes: data.length,
    }));

    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    const scratchDir = path.join(workspace, '.attachments', THREAD_ID, ATTACHMENT_ID);
    expect(result.path.startsWith(scratchDir)).toBe(true);
    expect(result.filename).not.toContain('..');
    expect(result.filename).not.toContain('\\');
  });

  it('falls back to attachmentId when filename sanitizes to empty', async () => {
    const data = Buffer.from('x');
    getByIdSpy.mockResolvedValue(makeRow({
      data,
      filename: '   ',
      mediaType: 'text/plain',
      sizeBytes: data.length,
    }));

    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filename).toBe(ATTACHMENT_ID);
  });
});

describe('reapScratchDirs', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'reap-test-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('returns 0 when .attachments dir does not exist', async () => {
    const count = await reapScratchDirs(workspace, 1000);
    expect(count).toBe(0);
  });

  it('reaps only dirs older than the threshold', async () => {
    const baseDir = path.join(workspace, '.attachments');
    const oldDir = path.join(baseDir, 'thread-1', 'att-old');
    const newDir = path.join(baseDir, 'thread-1', 'att-new');
    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(newDir, { recursive: true });

    await fs.writeFile(path.join(oldDir, 'file.txt'), 'old');
    await fs.writeFile(path.join(newDir, 'file.txt'), 'new');

    // Backdate the old dir
    const pastTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(oldDir, pastTime, pastTime);

    const count = await reapScratchDirs(workspace, 24 * 60 * 60 * 1000);
    expect(count).toBe(1);

    // Old dir removed, new dir still present
    await expect(fs.access(oldDir)).rejects.toThrow();
    await expect(fs.access(newDir)).resolves.toBeUndefined();
  });
});
