/**
 * Resolve the on-disk path for the single-agent SQLite database the way
 * Prisma does it, so every non-Prisma consumer (sqlite-vec bootstrap,
 * backup/restore service) ends up opening the same file Prisma reads and
 * writes.
 *
 * Prisma's rule for SQLite (per the official docs): relative paths in
 * `DATABASE_URL=file:...` are resolved relative to the **directory
 * containing the schema file**, not the process cwd. With our schema at
 * `prisma/sqlite/schema.prisma`, `file:./agent-local.db` resolves to
 * `<agent-runtime>/prisma/sqlite/agent-local.db`. better-sqlite3 with a
 * bare relative path would resolve against `process.cwd()` instead, which
 * is a different file — that mismatch silently broke vec0 in dev (the
 * memory_entries table lived in Prisma's file, vec0 in cwd's) and was
 * about to bite the backup feature the same way.
 *
 * Absolute paths (the production `file:/data/agent.db` shape) pass through
 * unchanged.
 */

import path from 'path';

// `__dirname` is `<root>/src/lib` under tsx-watch and `<root>/dist/lib`
// after tsc, so going up two levels lands on the agent-runtime root in
// both layouts. Schema dir is then a stable sibling of `src`/`dist`.
const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'prisma', 'sqlite');

export function resolvePrismaSqlitePath(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for SQLite single-agent mode');
  }
  const raw = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  // SQLite's in-memory tokens (`:memory:`, named shared-cache `file::memory:?cache=…`)
  // must pass through unchanged — they aren't filesystem paths.
  if (raw === ':memory:' || raw.startsWith(':')) return raw;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(SCHEMA_DIR, raw);
}
