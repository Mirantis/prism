import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runHydrateAttachment, runViewAttachment, reapScratchDirs, getAttachmentTools } from '../attachments';
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
  data: Buffer | null;
  storagePath: string | null;
}> = {}) {
  return {
    id: ATTACHMENT_ID,
    threadId: THREAD_ID,
    messageId: 'msg-001',
    filename: 'report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1024,
    category: 'pdf',
    // Legacy-BLOB shape by default: bytes in the row, no media file — so
    // loadBytes() serves from `data` without touching the filesystem. Tests
    // that need the expired state override both to null.
    data: Buffer.from('fake-pdf-content'),
    storagePath: null,
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

  it('returns an expired error when the content is gone (row without file or BLOB)', async () => {
    getByIdSpy.mockResolvedValue(makeRow({ data: null }));
    const result = await runHydrateAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, workspace,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('expired');
    expect(trackEvent).toHaveBeenCalledWith('attachment hydrate failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
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

describe('runViewAttachment', () => {
  let getByIdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getByIdSpy = vi.spyOn(attachmentService, 'getById');
    vi.mocked(trackEvent).mockClear();
  });

  afterEach(() => {
    getByIdSpy.mockRestore();
  });

  it('returns not-found when threadId is undefined', async () => {
    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, undefined,
    );

    expect(result).toEqual({ success: false, error: 'Attachment not found.' });
    expect(getByIdSpy).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('attachment view failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('returns not-found when attachment belongs to a different thread', async () => {
    getByIdSpy.mockResolvedValue(makeRow({ threadId: 'other-thread' }));
    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID,
    );

    expect(result).toEqual({ success: false, error: 'Attachment not found.' });
    expect(trackEvent).toHaveBeenCalledWith('attachment view failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('returns metadata (never bytes) for an image attachment (happy path)', async () => {
    const data = Buffer.from('fake-png-bytes');
    getByIdSpy.mockResolvedValue(makeRow({
      data,
      filename: 'screenshot.png',
      mediaType: 'image/png',
      sizeBytes: data.length,
    }));

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.attachmentId).toBe(ATTACHMENT_ID);
    expect(result.filename).toBe('screenshot.png');
    expect(result.mediaType).toBe('image/png');
    expect(result.category).toBe('image');
    expect(result.sizeBytes).toBe(data.length);
    expect(result.note).toContain('screenshot.png');
    // Bytes stay out of the execute() result — it's persisted verbatim into
    // the ToolCallRecord; the image rides toModelOutput instead.
    expect(result).not.toHaveProperty('data');

    expect(trackEvent).toHaveBeenCalledWith('attachment viewed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
      'attachment.category': 'image',
      'attachment.media_type': 'image/png',
      'attachment.size_bytes': String(data.length),
    });
  });

  it('returns an expired error when the image content is gone', async () => {
    getByIdSpy.mockResolvedValue(makeRow({
      filename: 'screenshot.png',
      mediaType: 'image/png',
      data: null,
    }));

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('expired');
    expect(trackEvent).toHaveBeenCalledWith('attachment view failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('returns failure for oversize images exceeding the ceiling', async () => {
    const oversizeBytes = 4_000_000;
    getByIdSpy.mockResolvedValue(makeRow({
      data: Buffer.alloc(oversizeBytes),
      filename: 'huge.png',
      mediaType: 'image/png',
      sizeBytes: oversizeBytes,
    }));

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('size limit');
    expect(result.error).toContain('hydrate_attachment');

    expect(trackEvent).toHaveBeenCalledWith('attachment view failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('directs PDFs to hydrate when no injection registrar is available', async () => {
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'doc.pdf',
    }));

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('hydrate_attachment');

    expect(trackEvent).toHaveBeenCalledWith('attachment view failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });

  it('attaches a PDF as a user-message document via the injection registrar', async () => {
    const data = Buffer.from('%PDF-1.7 fake');
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'report.pdf',
      data,
      sizeBytes: data.length,
    }));
    const registered: unknown[] = [];
    const ctx = {
      registerInjection: (m: unknown) => registered.push(m),
      injectedDocumentIds: new Set<string>(),
    };

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, ctx,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.category).toBe('pdf');
    expect(result.note).toContain('report.pdf');
    expect(result).not.toHaveProperty('data');

    expect(registered).toHaveLength(1);
    expect(registered[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'file',
          data,
          mediaType: 'application/pdf',
          filename: 'report.pdf',
          // Bedrock text-extracts documents unless citations are enabled.
          providerOptions: { bedrock: { citations: { enabled: true } } },
        },
        { type: 'text', text: expect.stringContaining('report.pdf') },
      ],
    });

    expect(trackEvent).toHaveBeenCalledWith('attachment viewed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
      'attachment.category': 'pdf',
      'attachment.media_type': 'application/pdf',
      'attachment.size_bytes': String(data.length),
    });
  });

  it('does not re-inject a PDF already attached in this invocation', async () => {
    const data = Buffer.from('%PDF-1.7 fake');
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'report.pdf',
      data,
      sizeBytes: data.length,
    }));
    const registered: unknown[] = [];
    const ctx = {
      registerInjection: (m: unknown) => registered.push(m),
      injectedDocumentIds: new Set<string>(),
    };

    const first = await runViewAttachment({ attachmentId: ATTACHMENT_ID }, USER_ID, AGENT_ID, THREAD_ID, ctx);
    const second = await runViewAttachment({ attachmentId: ATTACHMENT_ID }, USER_ID, AGENT_ID, THREAD_ID, ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.note).toContain('already attached');
    // Only the first call injected — the document is re-spliced every step
    // anyway, so a second copy would just burn tokens.
    expect(registered).toHaveLength(1);
  });

  it('injects once when the same PDF is viewed twice in parallel (same step)', async () => {
    // The SDK executes a step's tool calls with Promise.all — the dedupe id is
    // claimed before the byte read, so a concurrent duplicate can't slip in.
    const data = Buffer.from('%PDF-1.7 fake');
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'report.pdf',
      data,
      sizeBytes: data.length,
    }));
    const registered: unknown[] = [];
    const ctx = {
      registerInjection: (m: unknown) => registered.push(m),
      injectedDocumentIds: new Set<string>(),
    };

    const [a, b] = await Promise.all([
      runViewAttachment({ attachmentId: ATTACHMENT_ID }, USER_ID, AGENT_ID, THREAD_ID, ctx),
      runViewAttachment({ attachmentId: ATTACHMENT_ID }, USER_ID, AGENT_ID, THREAD_ID, ctx),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(registered).toHaveLength(1);
  });

  it('releases the dedupe claim when the PDF content turns out expired', async () => {
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'gone.pdf',
      data: null,
    }));
    const ctx = {
      registerInjection: () => {},
      injectedDocumentIds: new Set<string>(),
    };

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, ctx,
    );

    expect(result.success).toBe(false);
    // A failed view must not squat on the id — a later retry (e.g. after the
    // user reshares) would otherwise be answered with "already attached".
    expect(ctx.injectedDocumentIds.size).toBe(0);
  });

  it('rejects an oversized PDF with a hydrate hint', async () => {
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'huge.pdf',
      sizeBytes: 11 * 1024 * 1024,
    }));
    const ctx = { registerInjection: () => {}, injectedDocumentIds: new Set<string>() };

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, ctx,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('size limit');
    expect(result.error).toContain('pdftotext');
  });

  it('returns an expired error for a PDF whose content is gone', async () => {
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/pdf',
      filename: 'gone.pdf',
      data: null,
    }));
    const registered: unknown[] = [];
    const ctx = {
      registerInjection: (m: unknown) => registered.push(m),
      injectedDocumentIds: new Set<string>(),
    };

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID, ctx,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('expired');
    expect(registered).toHaveLength(0);
  });

  it('returns failure for non-viewable types (e.g. application/zip)', async () => {
    getByIdSpy.mockResolvedValue(makeRow({
      mediaType: 'application/zip',
      filename: 'archive.zip',
    }));

    const result = await runViewAttachment(
      { attachmentId: ATTACHMENT_ID },
      USER_ID, AGENT_ID, THREAD_ID,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('hydrate_attachment');

    expect(trackEvent).toHaveBeenCalledWith('attachment view failed', USER_ID, {
      'agent.id': AGENT_ID,
      'attachment.id': ATTACHMENT_ID,
    });
  });
});

describe('view_attachment toModelOutput', () => {
  let getByIdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getByIdSpy = vi.spyOn(attachmentService, 'getById');
  });

  afterEach(() => {
    getByIdSpy.mockRestore();
  });

  function viewTool() {
    const tools = getAttachmentTools(USER_ID, AGENT_ID, THREAD_ID, '/tmp');
    return tools.view_attachment as { toModelOutput: (opts: { output: unknown }) => Promise<unknown> };
  }

  const imageOutput = {
    success: true,
    attachmentId: ATTACHMENT_ID,
    filename: 'photo.jpg',
    mediaType: 'image/jpeg',
    sizeBytes: 5,
    category: 'image',
    note: 'Image "photo.jpg" is attached to this tool result.',
  };

  it('loads the bytes at conversion time and returns an image-data part', async () => {
    getByIdSpy.mockResolvedValue(makeRow({ mediaType: 'image/jpeg', data: Buffer.from('hello') }));

    const modelOutput = await viewTool().toModelOutput({ output: imageOutput });
    expect(modelOutput).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: '[Viewing photo.jpg]' },
        { type: 'image-data', data: Buffer.from('hello').toString('base64'), mediaType: 'image/jpeg' },
      ],
    });
  });

  it('degrades to text when the content expired between call and conversion', async () => {
    getByIdSpy.mockResolvedValue(makeRow({ mediaType: 'image/jpeg', data: null }));

    const modelOutput = await viewTool().toModelOutput({ output: imageOutput });
    expect(modelOutput).toEqual({
      type: 'text',
      value: 'The content of "photo.jpg" is no longer available (expired).',
    });
  });

  it('returns the note as text for a PDF result (document rode the injection)', async () => {
    const modelOutput = await viewTool().toModelOutput({
      output: { ...imageOutput, category: 'pdf', note: 'Attached "photo.jpg" to the conversation.' },
    });
    expect(modelOutput).toEqual({
      type: 'text',
      value: 'Attached "photo.jpg" to the conversation.',
    });
    expect(getByIdSpy).not.toHaveBeenCalled();
  });

  it('returns text on failure', async () => {
    const failureOutput = {
      success: false,
      error: 'Attachment not found.',
    };

    const modelOutput = await viewTool().toModelOutput({ output: failureOutput });
    expect(modelOutput).toEqual({
      type: 'text',
      value: 'Attachment not found.',
    });
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
