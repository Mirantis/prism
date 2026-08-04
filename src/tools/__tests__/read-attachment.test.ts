import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadByIdForThread } = vi.hoisted(() => ({ mockLoadByIdForThread: vi.fn() }));

vi.mock('../../services/attachment.service', () => ({
  attachmentService: { loadByIdForThread: mockLoadByIdForThread },
}));

import { getReadAttachmentTools } from '../read-attachment';
import { MAX_INLINE_TEXT_CHARS } from '../../constants';

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    filename: 'run.log',
    mediaType: 'text/plain',
    category: 'text',
    sizeBytes: 4,
    data: Buffer.from('boom'),
    ...overrides,
  };
}

const THREAD = 'thread-1';

async function run(attachmentId: string, offset?: number): Promise<string> {
  const tool = getReadAttachmentTools(THREAD).read_attachment;
  // The AI SDK's execute signature carries call metadata we do not use.
  const execute = tool.execute as (input: {
    attachmentId: string;
    offset?: number;
  }) => Promise<string>;
  return execute({ attachmentId, offset });
}

describe('read_attachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the text of a shared file', async () => {
    // This tool is what makes stubbing older attachments non-lossy: without it
    // the model would see a file named and have no way to read it.
    mockLoadByIdForThread.mockResolvedValue(makeAttachment());
    await expect(run('a1')).resolves.toBe('boom');
  });

  it('says so plainly when the id is unknown', async () => {
    // Ids come from stubs we wrote, so a miss means the file was deleted or the
    // model invented one. Empty text would read as an empty file.
    mockLoadByIdForThread.mockResolvedValue(null);
    const result = await run('nope');
    expect(result).toContain('No attachment found');
    expect(result).toContain('nope');
  });

  it('explains why a non-text attachment has nothing to return', async () => {
    mockLoadByIdForThread.mockResolvedValue(
      makeAttachment({ category: 'image', mediaType: 'image/png', filename: 'shot.png' }),
    );
    const result = await run('a1');
    expect(result).toContain('shot.png');
    expect(result).toContain('image/png');
  });

  it('applies the same per-file cap as inlining', async () => {
    // Reading a file back is a way to see one that is out of context, not a way
    // around the limit on how much of it fits.
    const big = 'x'.repeat(MAX_INLINE_TEXT_CHARS + 500);
    mockLoadByIdForThread.mockResolvedValue(makeAttachment({ data: Buffer.from(big) }));

    const result = await run('a1');

    expect(result).toContain('characters remain');
    expect(result.length).toBeLessThan(big.length);
  });

  it('scopes the lookup to the calling thread', async () => {
    // An id supplied by the MODEL is untrusted — it can arrive from a
    // prompt-injected page or another conversation — so it must never be the
    // sole authority for handing back file bytes.
    mockLoadByIdForThread.mockResolvedValue(makeAttachment());
    await run('a1');
    expect(mockLoadByIdForThread).toHaveBeenCalledWith('a1', THREAD);
  });

  it('gives no tool at all to a turn with no thread', async () => {
    // Heartbeat and cron runs have no conversation to scope against. No tool is
    // the right answer there; an unscoped one would read anything in the DB.
    expect(getReadAttachmentTools(undefined)).toEqual({});
  });

  it('answers the same for an unknown id and one from another thread', async () => {
    // Distinguishable answers would let the model probe which uuids exist
    // elsewhere in the database.
    mockLoadByIdForThread.mockResolvedValue(null);
    const result = await run('someone-elses-id');
    expect(result).toContain('No attachment found');
    expect(result).not.toMatch(/another|other thread|not yours|forbidden/i);
  });

  it('walks a large file through successive offsets', async () => {
    // Stubbing is only non-lossy if the whole file is reachable. A single
    // capped read would strand everything past the first chunk.
    const big = 'a'.repeat(MAX_INLINE_TEXT_CHARS) + 'TAIL_MARKER';
    mockLoadByIdForThread.mockResolvedValue(makeAttachment({ data: Buffer.from(big) }));

    const first = await run('a1');
    expect(first).toContain(`offset ${MAX_INLINE_TEXT_CHARS}`);

    const second = await run('a1', MAX_INLINE_TEXT_CHARS);
    expect(second).toContain('TAIL_MARKER');
  });
});
