import { describe, expect, it } from 'vitest';
import { createPendingFileWrites } from './pending-file-writes';

describe('createPendingFileWrites', () => {
  it('holds a reader behind a write with no path, except a reader inside that call', async () => {
    const writes = createPendingFileWrites();
    writes.register('program', 'run_program');

    const inside = await writes.waitFor('/w/file', { timeoutMs: 1_000, callerId: 'program:1' });
    expect(inside.status).toBe('none');

    const sibling = writes.waitFor('/w/file', { timeoutMs: 1_000, callerId: 'share' });
    writes.settle('program');
    expect((await sibling).status).toBe('settled');
  });
});
