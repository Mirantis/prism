/**
 * Prisma-CLI-free migration runner for the packaged `prism-server` binary.
 *
 * The SEA binary can't shell out to `prisma migrate deploy` (no Prisma CLI /
 * schema engine on disk), so on boot we replay the committed migration SQL
 * directly against the SQLite file via better-sqlite3, recording each applied
 * migration in a Prisma-compatible `_prisma_migrations` table so the DB stays
 * consistent if the real CLI is ever pointed at it later.
 *
 * The migration list is injected at build time by the esbuild `virtual:migrations`
 * plugin (see scripts/build-sea.mjs); callers pass it in so this stays testable.
 */
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface Migration {
  /** Directory name, e.g. `20260427123025_init` — also the ordering key. */
  name: string;
  /** Contents of that migration's `migration.sql`. */
  sql: string;
}

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "checksum"            TEXT NOT NULL,
  "finished_at"         DATETIME,
  "migration_name"      TEXT NOT NULL,
  "logs"                TEXT,
  "rolled_back_at"      DATETIME,
  "started_at"          DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
);`;

/**
 * Apply any not-yet-recorded migrations in `name` order. Idempotent: already
 * applied migrations (by `migration_name`) are skipped. Returns the names of
 * the migrations applied this run.
 */
export function applyMigrations(db: Database, migrations: Migration[]): string[] {
  db.exec(CREATE_MIGRATIONS_TABLE);

  const applied = new Map<string, string>(
    db
      .prepare(
        'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      )
      .all()
      .map((row) => {
        const r = row as { migration_name: string; checksum: string };
        return [r.migration_name, r.checksum];
      }),
  );

  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  const record = db.prepare(
    `INSERT INTO "_prisma_migrations"
       (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
     VALUES (?, ?, current_timestamp, ?, current_timestamp, 1)`,
  );

  const done: string[] = [];
  for (const migration of ordered) {
    const checksum = crypto.createHash('sha256').update(migration.sql).digest('hex');
    const recorded = applied.get(migration.name);
    if (recorded !== undefined) {
      // Drift detection: parity with `prisma migrate deploy` — the SQL of an
      // already-applied migration must not have changed since it ran.
      if (recorded !== checksum) {
        throw new Error(
          `Migration "${migration.name}" has drifted (bundled checksum ${checksum} ` +
            `!= recorded ${recorded}). Roll the change forward as a new migration ` +
            `instead of editing an applied one.`,
        );
      }
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      record.run(crypto.randomUUID(), checksum, migration.name);
    });
    apply();
    done.push(migration.name);
  }
  return done;
}
