import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import {
  CHATGPT_AUTH_CLIENT_ID,
  CHATGPT_AUTH_HOST_ID,
  CHATGPT_AUTH_TOKENS,
} from './runtime-state.service';

vi.mock('../lib/sqlite-vec-load', () => ({
  loadSqliteVec: vi.fn(),
}));

vi.mock('../lib/telemetry', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { exportAgent, importAgent } from './agent-archive.service';

function seedDb(dbPath: string, rows: Record<string, string>): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE _prisma_migrations (migration_name TEXT PRIMARY KEY, finished_at TEXT);
      INSERT INTO _prisma_migrations VALUES ('0001_init', '2026-01-01');
      CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL DEFAULT 0);
    `);
    const insert = db.prepare('INSERT INTO runtime_state (key, value, updatedAt) VALUES (?, ?, 0)');
    for (const [k, v] of Object.entries(rows)) {
      insert.run(k, v);
    }
  } finally {
    db.close();
  }
}

function readRuntimeState(dbPath: string): Record<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM runtime_state').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('agent-archive ChatGPT credential stripping', () => {
  let tmpDir: string;
  let dbPath: string;
  const originalDbUrl = config.databaseUrl;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-archive-test-'));
    dbPath = path.join(tmpDir, 'agent.db');
    config.databaseUrl = `file:${dbPath}`;
  });

  afterEach(() => {
    config.databaseUrl = originalDbUrl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exportAgent strips ChatGPT tokens, host ID, and client ID from the snapshot while keeping other runtime_state rows', async () => {
    seedDb(dbPath, {
      deploymentId: 'dep-1',
      [CHATGPT_AUTH_TOKENS]: JSON.stringify({ accessToken: 'secret', refreshToken: 'refresh-secret' }),
      [CHATGPT_AUTH_HOST_ID]: 'urn:uuid:host-1',
      [CHATGPT_AUTH_CLIENT_ID]: 'oaiapp_1',
    });

    const { stream, cleanup } = await exportAgent('Test Agent');
    const gz = await streamToBuffer(stream);
    cleanup();

    const exportedDb = path.join(tmpDir, 'exported.db');
    const rawBytes = zlib.gunzipSync(gz);
    fs.writeFileSync(exportedDb, rawBytes);

    const exportedState = readRuntimeState(exportedDb);
    expect(exportedState).toEqual({ deploymentId: 'dep-1' });
    // Raw SQLite file bytes must not retain any deleted credential strings.
    expect(rawBytes.includes('refresh-secret')).toBe(false);
    expect(rawBytes.includes('urn:uuid:host-1')).toBe(false);
    expect(rawBytes.includes('oaiapp_1')).toBe(false);
    // Live DB retains its credentials untouched.
    const liveState = readRuntimeState(dbPath);
    expect(liveState[CHATGPT_AUTH_TOKENS]).toBeDefined();
  });

  it('importAgent strips ChatGPT credentials from a legacy backup before staging', async () => {
    seedDb(dbPath, { deploymentId: 'live-dep' });

    const legacyDb = path.join(tmpDir, 'legacy.db');
    seedDb(legacyDb, {
      deploymentId: 'backup-dep',
      [CHATGPT_AUTH_TOKENS]: JSON.stringify({ accessToken: 'leaked', refreshToken: 'leaked-refresh' }),
      [CHATGPT_AUTH_HOST_ID]: 'urn:uuid:backup-host',
      [CHATGPT_AUTH_CLIENT_ID]: 'oaiapp_backup',
    });
    const archiveBuf = zlib.gzipSync(fs.readFileSync(legacyDb));

    await importAgent(archiveBuf);

    const stagedState = readRuntimeState(`${dbPath}.next`);
    expect(stagedState).toEqual({ deploymentId: 'backup-dep' });
  });
});
