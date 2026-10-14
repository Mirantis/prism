import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../sea/migrate';
import { createSqliteAdapter } from './prisma-adapter';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'sqlite', 'migrations');

let dir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-adapter-'));
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
  prisma = new PrismaClient({ adapter: createSqliteAdapter(`file:${file}`) });
  await prisma.agentWorkspace.create({
    data: { id: 'agent-1', userId: 'user-1', soulMd: '', userMd: '', memoryMd: '', heartbeatMd: '', bootstrapMd: '' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createSqliteAdapter', () => {
  it('keeps a write made while another transaction is open out of that transaction', async () => {
    let transactionOpen!: () => void;
    const opened = new Promise<void>((resolve) => (transactionOpen = resolve));
    const rolledBack = prisma
      .$transaction(async (tx) => {
        await tx.pendingSlackMessage.create({
          data: { agentId: 'agent-1', sender: 'U1', text: 'inside', timestamp: '1' },
        });
        transactionOpen();
        await new Promise((resolve) => setTimeout(resolve, 100));
        throw new Error('roll back');
      })
      .catch(() => 'rolled back');

    await opened;
    await prisma.pendingSlackMessage.create({
      data: { agentId: 'agent-1', sender: 'U1', text: 'outside', timestamp: '2' },
    });

    expect(await rolledBack).toBe('rolled back');
    const rows = await prisma.pendingSlackMessage.findMany({ select: { text: true } });
    expect(rows).toEqual([{ text: 'outside' }]);
  });
});
