import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from './migrate';

describe('applyMigrations', () => {
  it('applies migrations in name order, records them, and is idempotent', () => {
    const db = new Database(':memory:');
    const migrations = [
      { name: '002_second', sql: 'CREATE TABLE b (id INTEGER);' },
      { name: '001_first', sql: 'CREATE TABLE a (id INTEGER);' },
    ];

    const applied = applyMigrations(db, migrations);
    expect(applied).toEqual(['001_first', '002_second']);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('a');
    expect(tables).toContain('b');

    const recorded = db
      .prepare('SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name')
      .all()
      .map((r) => (r as { migration_name: string }).migration_name);
    expect(recorded).toEqual(['001_first', '002_second']);

    // Re-running applies nothing.
    expect(applyMigrations(db, migrations)).toEqual([]);
    db.close();
  });

  it('throws when an already-applied migration has drifted on disk', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [{ name: '001_init', sql: 'CREATE TABLE a (id INTEGER);' }]);
    // Same name, different SQL → simulates an edit-after-deploy.
    expect(() =>
      applyMigrations(db, [{ name: '001_init', sql: 'CREATE TABLE a (id INTEGER, extra TEXT);' }]),
    ).toThrow(/drifted/);
    db.close();
  });

  it('rolls back a failing migration and records nothing for it', () => {
    const db = new Database(':memory:');
    expect(() =>
      applyMigrations(db, [{ name: '001_bad', sql: 'CREATE TABLE x (id INTEGER); INVALID SQL;' }]),
    ).toThrow();

    const count = db.prepare('SELECT count(*) AS c FROM "_prisma_migrations"').get() as { c: number };
    expect(count.c).toBe(0);
    const xExists = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='x'")
      .get() as { c: number };
    expect(xExists.c).toBe(0);
    db.close();
  });
});
