/**
 * Message order on a database built from the committed migrations. Two rows
 * written in the same millisecond keep the order they were written in for the
 * model, and are ordered by id for a client.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../sea/migrate';
import { createSqliteAdapter } from '../../lib/prisma-adapter';

const database = vi.hoisted(() => ({ client: undefined as PrismaClient | undefined }));

vi.mock('../../lib/prisma', () => ({
  default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client!, key) }),
}));

import { DatabaseThreadProvider } from './database-thread.provider';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'prisma', 'sqlite', 'migrations');
const SAME_MOMENT = new Date('2026-10-20T08:00:00.000Z');

let dir: string;
const provider = new DatabaseThreadProvider();

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-order-'));
  const file = path.join(dir, 'agent.db');
  const db = new Database(file);
  applyMigrations(
    db,
    fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        sql: fs.readFileSync(path.join(MIGRATIONS_DIR, entry.name, 'migration.sql'), 'utf8'),
      })),
  );
  db.close();
  database.client = new PrismaClient({ adapter: createSqliteAdapter(`file:${file}`) });
  const prisma = database.client;
  await prisma.agentWorkspace.create({
    data: { id: 'agent-1', userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
  });
  await prisma.conversationThread.create({ data: { id: 'thread-1', agentId: 'agent-1', userId: 'user-1' } });
  // Written in this order, in one millisecond, with ids that sort the other way.
  for (const [id, role] of [['message-b', 'AGENT'], ['message-a', 'USER']] as const) {
    await prisma.conversationMessage.create({
      data: { id, threadId: 'thread-1', role, content: id, triggeredBy: 'USER_INPUT', createdAt: SAME_MOMENT },
    });
  }
});

afterAll(async () => {
  await database.client?.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DatabaseThreadProvider on SQLite', () => {
  it('reads rows of one millisecond for the model in the order they were written', async () => {
    expect((await provider.getMessages('thread-1')).map((m) => m.id)).toEqual(['message-b', 'message-a']);
    expect((await provider.getRecentMessages('thread-1', 10)).map((m) => m.id)).toEqual(['message-b', 'message-a']);
  });

  it('reads rows of one millisecond for a client by id', async () => {
    const view = { view: 'client' } as const;
    expect((await provider.getMessages('thread-1', view)).map((m) => m.id)).toEqual(['message-a', 'message-b']);
    expect((await provider.getRecentMessages('thread-1', 10, view)).map((m) => m.id)).toEqual(['message-a', 'message-b']);
    expect((await provider.getRecentMessages('thread-1', 10, { ...view, before: 'message-b' })).map((m) => m.id)).toEqual([
      'message-a',
    ]);
  });
});
