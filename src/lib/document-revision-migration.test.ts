/**
 * The upgrade baseline, driven through the committed migration SQL.
 *
 * An install created before `agent_workspace_revisions` holds seven documents
 * and no revisions. The migration that adds the table records what each one
 * reads now, so the history of an upgraded install starts at the upgrade rather
 * than at the next edit.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, type Migration } from '../sea/migrate';
import { WORKSPACE_DOC_FIELDS } from './workspace-docs';

const MIGRATIONS_DIR = path.join(__dirname, '../../prisma/sqlite/migrations');
const REVISIONS_MIGRATION = '20260905120000_add_agent_workspace_revisions';
const UPGRADE_REASON = 'Recorded on upgrade. Earlier revisions were not kept.';

/** Every committed migration, in name order. */
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

/** A database at the migration before the revisions table was added. */
function databaseBeforeRevisions() {
  const migrations = allMigrations();
  const cut = migrations.findIndex((m) => m.name === REVISIONS_MIGRATION);
  expect(cut).toBeGreaterThan(0);

  const db = new Database(':memory:');
  applyMigrations(db, migrations.slice(0, cut));
  return { db, revisionsMigration: migrations[cut] };
}

/** One agent row, as an install upgrading from that build holds it. */
function insertAgent(db: Database.Database, id: string): Record<string, string> {
  const documents = Object.fromEntries(
    WORKSPACE_DOC_FIELDS.map((field) => [field, `# ${field} of ${id}`]),
  );
  const columns = ['id', 'userId', ...WORKSPACE_DOC_FIELDS, 'updatedAt'];
  db.prepare(
    `INSERT INTO "agent_workspaces" (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(id, 'user-1', ...WORKSPACE_DOC_FIELDS.map((field) => documents[field]), Date.now());
  return documents;
}

function revisionsOf(db: Database.Database, agentId: string) {
  return db
    .prepare(
      `SELECT "field", "content", "actor", "method", "reason"
         FROM "agent_workspace_revisions" WHERE "agentId" = ? ORDER BY "field"`,
    )
    .all(agentId) as Array<Record<string, string>>;
}

describe('the revisions migration', () => {
  it('records a baseline for every document of an existing agent', () => {
    const { db, revisionsMigration } = databaseBeforeRevisions();
    const documents = insertAgent(db, 'agent-1');

    applyMigrations(db, [...allMigrations()]);

    const rows = revisionsOf(db, 'agent-1');
    expect(rows.map((row) => row.field)).toEqual([...WORKSPACE_DOC_FIELDS].sort());
    for (const row of rows) {
      expect(row.content).toBe(documents[row.field]);
      expect(row.actor).toBe('user');
      expect(row.method).toBe('seed');
      expect(row.reason).toBe(UPGRADE_REASON);
    }
    expect(revisionsMigration.sql).toContain('INSERT OR IGNORE');
    db.close();
  });

  it('records a baseline per agent', () => {
    const { db } = databaseBeforeRevisions();
    insertAgent(db, 'agent-1');
    insertAgent(db, 'agent-2');

    applyMigrations(db, allMigrations());

    expect(revisionsOf(db, 'agent-1')).toHaveLength(WORKSPACE_DOC_FIELDS.length);
    expect(revisionsOf(db, 'agent-2')).toHaveLength(WORKSPACE_DOC_FIELDS.length);
    db.close();
  });

  it('records nothing on a fresh install, where the agent is created later', () => {
    const db = new Database(':memory:');
    applyMigrations(db, allMigrations());

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM "agent_workspace_revisions"')
      .get() as { n: number };
    expect(count.n).toBe(0);
    db.close();
  });

  it('adds nothing when the same migration list runs again', () => {
    const { db } = databaseBeforeRevisions();
    insertAgent(db, 'agent-1');

    const migrations = allMigrations();
    applyMigrations(db, migrations);
    // Second run: already recorded by name, so the seed does not run twice.
    expect(applyMigrations(db, migrations)).toEqual([]);

    expect(revisionsOf(db, 'agent-1')).toHaveLength(WORKSPACE_DOC_FIELDS.length);
    db.close();
  });
});
