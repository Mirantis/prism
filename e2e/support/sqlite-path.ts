/**
 * Resolve the on-disk path for the SQLite database, so every connection the
 * runtime opens (the Prisma client, the sqlite-vec bootstrap, backup/restore)
 * reads and writes the same file.
 *
 * Relative paths in `DATABASE_URL=file:...` resolve against the **directory
 * containing the schema file**, not the process cwd: `file:./agent-local.db`
 * is `<agent-runtime>/prisma/sqlite/agent-local.db`. `prisma.config.ts`
 * applies the same rule for the Prisma CLI, so migrations land in that file
 * too.
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
    throw new Error('DATABASE_URL is required');
  }
  const raw = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  // SQLite's in-memory tokens (`:memory:`, named shared-cache `file::memory:?cache=…`)
  // must pass through unchanged — they aren't filesystem paths.
  if (raw === ':memory:' || raw.startsWith(':')) return raw;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(SCHEMA_DIR, raw);
}
