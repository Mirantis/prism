/**
 * The upgrade of `llm_calls` to the spend columns, driven through the committed
 * migration SQL.
 *
 * The runtime writes `createdAt` as epoch milliseconds, but a row that took the
 * column's `CURRENT_TIMESTAMP` default holds text. Both must come out of the
 * upgrade as epoch milliseconds with a matching 15-minute bucket, or range and
 * period queries miss them.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, type Migration } from '../sea/migrate';
import { WORKSPACE_DOC_FIELDS } from './workspace-docs';

const MIGRATIONS_DIR = path.join(__dirname, '../../prisma/sqlite/migrations');
const SPEND_MIGRATION = '20261121155112_llm_call_spend';

function allMigrations(): Migration[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => fs.existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql')))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

describe('the llm_calls spend migration', () => {
  it('stores text and integer timestamps as epoch milliseconds, with their bucket', () => {
    const migrations = allMigrations();
    const cut = migrations.findIndex((m) => m.name === SPEND_MIGRATION);
    expect(cut).toBeGreaterThan(0);

    const db = new Database(':memory:');
    applyMigrations(db, migrations.slice(0, cut));
    const columns = ['id', 'userId', ...WORKSPACE_DOC_FIELDS, 'updatedAt'];
    db.prepare(
      `INSERT INTO "agent_workspaces" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run('agent-1', 'user-1', ...WORKSPACE_DOC_FIELDS.map(() => ''), Date.now());
    const insert = db.prepare(
      `INSERT INTO "llm_calls" ("id", "agentId", "purpose", "model", "createdAt") VALUES (?, 'agent-1', 'chat', 'm', ?)`,
    );
    const written = Date.UTC(2026, 10, 20, 10, 7, 30, 250);
    insert.run('integer', written);
    // What SQLite's CURRENT_TIMESTAMP default writes.
    db.prepare(
      `INSERT INTO "llm_calls" ("id", "agentId", "purpose", "model") VALUES ('default', 'agent-1', 'chat', 'm')`,
    ).run();
    db.prepare(`UPDATE "llm_calls" SET "createdAt" = '2026-11-20 10:22:05' WHERE "id" = 'default'`).run();

    applyMigrations(db, migrations);

    const rows = db
      .prepare(`SELECT "id", "createdAt", typeof("createdAt") AS "type", "bucket" FROM "llm_calls" ORDER BY "id"`)
      .all() as Array<{ id: string; createdAt: number; type: string; bucket: number }>;
    const text = Date.UTC(2026, 10, 20, 10, 22, 5);
    expect(rows).toEqual([
      { id: 'default', createdAt: text, type: 'integer', bucket: Date.UTC(2026, 10, 20, 10, 15) },
      { id: 'integer', createdAt: written, type: 'integer', bucket: Date.UTC(2026, 10, 20, 10, 0) },
    ]);
  });
});
