/**
 * Tests for the seed directory reader that supplies a new agent's identity
 * documents. Exercises real temp files through `readWorkspaceSeed`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_SEED_DOCUMENT_BYTES, readWorkspaceSeed } from './workspace-seed';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-seed-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(name: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(dir, name), content);
}

describe('readWorkspaceSeed', () => {
  it('reads one document per field file', () => {
    write('soulMd.md', '# Soul\n\nYou are {{agentName}}.');
    write('agentMd.md', '# Guide');
    write('bootstrapMd.md', '# Bootstrap');

    expect(readWorkspaceSeed(dir)).toEqual({
      soulMd: '# Soul\n\nYou are {{agentName}}.',
      agentMd: '# Guide',
      bootstrapMd: '# Bootstrap',
    });
  });

  it('keeps an empty file, which clears that document', () => {
    write('bootstrapMd.md', '');

    expect(readWorkspaceSeed(dir)).toEqual({ bootstrapMd: '' });
  });

  it('does not seed memory', () => {
    write('memoryMd.md', '# Memory');

    expect(readWorkspaceSeed(dir)).toEqual({});
  });

  it('ignores files that name no document', () => {
    write('notes.md', 'hello');
    write('soulMd.txt', 'hello');

    expect(readWorkspaceSeed(dir)).toEqual({});
  });

  it('keeps the default for a document over the size cap', () => {
    write('agentMd.md', Buffer.alloc(MAX_SEED_DOCUMENT_BYTES + 1, 'a'));
    write('soulMd.md', '# Soul');

    expect(readWorkspaceSeed(dir)).toEqual({ soulMd: '# Soul' });
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('agentMd.md'));
  });

  it('keeps the default for a document it cannot read', () => {
    // A directory where the file should be fails the read with EISDIR.
    fs.mkdirSync(path.join(dir, 'agentMd.md'));
    write('soulMd.md', '# Soul');

    expect(readWorkspaceSeed(dir)).toEqual({ soulMd: '# Soul' });
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('agentMd.md'));
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(readWorkspaceSeed(path.join(dir, 'missing'))).toEqual({});
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('returns nothing when no directory is configured', () => {
    expect(readWorkspaceSeed(undefined)).toEqual({});
    expect(readWorkspaceSeed('')).toEqual({});
  });
});
