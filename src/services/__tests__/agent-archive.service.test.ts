/**
 * Agent Archive Service Tests — importAgent staging + telemetry.
 *
 * The heavy I/O (gunzip, sqlite validation) is stubbed at the module
 * boundary so the test exercises the staging flow: gunzip → validate →
 * atomic rename → "agent imported" telemetry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable, PassThrough } from 'stream';

const { mockFs, mockTrackEvent, mockDbBehavior } = vi.hoisted(() => ({
  mockFs: {
    createWriteStream: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
    unlink: vi.fn(),
  },
  mockTrackEvent: vi.fn(),
  // Mutable per-test knobs for the fake sqlite handle.
  mockDbBehavior: {
    integrity: 'ok',
    migrations: [{ migration_name: 'm1' }],
  },
}));

vi.mock('fs', () => ({ default: mockFs }));

vi.mock('zlib', () => ({
  default: { createGunzip: () => new PassThrough() },
}));

vi.mock('better-sqlite3', () => ({
  default: class FakeDatabase {
    prepare(sql: string) {
      return {
        get: () => ({ integrity_check: mockDbBehavior.integrity }),
        all: () => mockDbBehavior.migrations,
        run: vi.fn(),
      };
    }
    close(): void {}
  },
}));

vi.mock('../../lib/sqlite-bootstrap', () => ({
  loadSqliteVec: vi.fn(),
  EMBEDDING_DIMENSION: 1024,
}));

vi.mock('../../lib/sqlite-path', () => ({
  resolvePrismaSqlitePath: () => '/data/agent.db',
}));

vi.mock('../../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

import { importAgent, ArchiveValidationError } from '../agent-archive.service';

describe('importAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbBehavior.integrity = 'ok';
    mockDbBehavior.migrations = [{ migration_name: 'm1' }];
    mockFs.createWriteStream.mockImplementation(
      () => new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    );
  });

  it('stages the upload via atomic rename and emits "agent imported"', async () => {
    await importAgent(Buffer.from('fake-gzip'));

    expect(mockFs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('.import-staging-'),
      '/data/agent.db.next',
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'agent imported',
      null,
      expect.objectContaining({ 'agent.id': 'test-agent-id' }),
    );
  });

  it('rejects a corrupt database and emits nothing', async () => {
    mockDbBehavior.integrity = 'page 3 is corrupt';

    await expect(importAgent(Buffer.from('fake-gzip'))).rejects.toThrow(ArchiveValidationError);

    expect(mockFs.renameSync).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
