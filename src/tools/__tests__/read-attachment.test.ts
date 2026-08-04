import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadByIds } = vi.hoisted(() => ({ mockLoadByIds: vi.fn() }));

vi.mock('../../services/attachment.service', () => ({
  attachmentService: { loadByIds: mockLoadByIds },
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

async function run(attachmentId: string): Promise<string> {
  const tool = getReadAttachmentTools().read_attachment;
  // The AI SDK's execute signature carries call metadata we do not use.
  const execute = tool.execute as (input: { attachmentId: string }) => Promise<string>;
  return execute({ attachmentId });
}

describe('read_attachment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the text of a shared file', async () => {
    // This tool is what makes stubbing older attachments non-lossy: without it
    // the model would see a file named and have no way to read it.
    mockLoadByIds.mockResolvedValue([makeAttachment()]);
    await expect(run('a1')).resolves.toBe('boom');
  });

  it('says so plainly when the id is unknown', async () => {
    // Ids come from stubs we wrote, so a miss means the file was deleted or the
    // model invented one. Empty text would read as an empty file.
    mockLoadByIds.mockResolvedValue([]);
    const result = await run('nope');
    expect(result).toContain('No attachment found');
    expect(result).toContain('nope');
  });

  it('explains why a non-text attachment has nothing to return', async () => {
    mockLoadByIds.mockResolvedValue([
      makeAttachment({ category: 'image', mediaType: 'image/png', filename: 'shot.png' }),
    ]);
    const result = await run('a1');
    expect(result).toContain('shot.png');
    expect(result).toContain('image/png');
  });

  it('applies the same per-file cap as inlining', async () => {
    // Reading a file back is a way to see one that is out of context, not a way
    // around the limit on how much of it fits.
    const big = 'x'.repeat(MAX_INLINE_TEXT_CHARS + 500);
    mockLoadByIds.mockResolvedValue([makeAttachment({ data: Buffer.from(big) })]);

    const result = await run('a1');

    expect(result).toContain('truncated');
    expect(result.length).toBeLessThan(big.length);
  });
});
