/**
 * A SQLite file built from the committed migrations and opened with the runtime's
 * Prisma adapter, for a test that depends on the database's own ordering and indexes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { applyMigrations } from '../sea/migrate';
import { createSqliteAdapter } from '../lib/prisma-adapter';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'sqlite', 'migrations');

export interface MigratedDatabase {
  client: PrismaClient;
  /** Disconnect and delete the file. */
  close(): Promise<void>;
}

export function openMigratedDatabase(): MigratedDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-db-'));
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
  const client = new PrismaClient({ adapter: createSqliteAdapter(`file:${file}`) });
  return {
    client,
    close: async () => {
      await client.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
