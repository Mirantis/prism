/**
 * share_file staleness tests — what the captured bytes get reported as, and what
 * happens when the file moves under the read.
 *
 * Separate from `share-file.test.ts` because these need `fs/promises` itself
 * mocked: an ESM module namespace is not configurable, so `vi.spyOn(fs, …)`
 * cannot reach `readFile`/`stat`, and mocking the module for the whole of the
 * main suite would obscure the guards it covers.
 *
 * The barrier in `pending-file-writes.ts` only covers writers whose target path
 * is in their input. `shell_exec` and `claude_code` write files too, and the
 * read-then-confirm here is the one window where those are observable at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * Hooks the mocked `fs/promises` consults. Mutated per test rather than baked
 * into the factory, because a `mockReset` between tests would wipe an
 * implementation set inside the factory.
 */
const hooks: {
  /** Inflate only the first `stat`, i.e. the guard stat before the read. */
  inflateFirstStatBy: number;
  /** Run after a `readFile` returns; the count is how many reads have happened. */
  afterRead?: (reads: number) => Promise<void>;
} = { inflateFirstStatBy: 0 };

let statCalls = 0;
let readCalls = 0;

vi.mock('fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs/promises')>();
  const stat = async (p: Parameters<typeof real.stat>[0]) => {
    const st = await real.stat(p);
    statCalls += 1;
    if (statCalls === 1 && hooks.inflateFirstStatBy > 0) {
      return Object.assign(st, { size: st.size + hooks.inflateFirstStatBy });
    }
    return st;
  };
  const readFile = async (p: Parameters<typeof real.readFile>[0]) => {
    const data = await real.readFile(p);
    readCalls += 1;
    if (hooks.afterRead) await hooks.afterRead(readCalls);
    return data;
  };
  return { ...real, default: { ...real, stat, readFile }, stat, readFile };
});

const fs = await import('fs/promises');
const { runShareFile } = await import('../share-file');
const { attachmentService } = await import('../../services/attachment.service');

const sha256 = (data: string) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

describe('runShareFile staleness', () => {
  let workspace: string;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    hooks.inflateFirstStatBy = 0;
    hooks.afterRead = undefined;
    statCalls = 0;
    readCalls = 0;
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'share-stale-test-'));
    createSpy = vi
      .spyOn(attachmentService, 'create')
      .mockImplementation(async (input) => ({ id: 'att-generated', ...input }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('reports the bytes it read, not the size stat taken before the read', async () => {
    const body = 'the real contents\n';
    await fs.writeFile(path.join(workspace, 'draft.md'), body);
    // The guard stat overstates the file. `sizeBytes` is what the download chip
    // and the Slack upload show, so it has to describe the bytes actually stored.
    hooks.inflateFirstStatBy = 4096;

    const result = await runShareFile({ path: 'draft.md' }, workspace);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sizeBytes).toBe(Buffer.byteLength(body));
    expect(result.digest).toBe(sha256(body));
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: Buffer.byteLength(body) }),
    );
  });

  it('re-reads once when the file changed under the read', async () => {
    const file = path.join(workspace, 'draft.md');
    const settled = 'second, and now stable\n';
    await fs.writeFile(file, 'first\n');
    // Change the file only after the first read returns, so the confirming stat
    // sees a moved target and the retry picks up the settled content.
    hooks.afterRead = async (reads) => {
      if (reads === 1) await fs.writeFile(file, settled);
    };

    const result = await runShareFile({ path: 'draft.md' }, workspace);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.digest).toBe(sha256(settled));
    expect(result.sizeBytes).toBe(Buffer.byteLength(settled));
  });

  it('refuses rather than guess when the file keeps changing across both reads', async () => {
    const file = path.join(workspace, 'draft.md');
    await fs.writeFile(file, 'first\n');
    hooks.afterRead = async (reads) => {
      await fs.writeFile(file, `growing ${'x'.repeat(reads * 32)}\n`);
    };

    const result = await runShareFile({ path: 'draft.md' }, workspace);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/changing while it is read/i);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
