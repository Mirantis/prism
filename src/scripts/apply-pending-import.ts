/**
 * apply-pending-import — runs *before* anything opens the SQLite DB.
 *
 * Invoked by both `start.sh` (production, compiled JS) and the `dev:single`
 * npm script (dev, via tsx). When the previous run staged a `.prism`
 * restore — atomic-renamed the validated file to `<db>.next` next to the
 * live DB — this script promotes that file in place. No-op when there's
 * nothing staged.
 *
 * Why Node instead of pure shell: the live DB path is encoded in
 * `DATABASE_URL` as a `file:…` URL that resolves *relative to the schema
 * directory*, not the current working directory. That convention lives in
 * `lib/sqlite-path.ts` and would be brittle to mirror in shell. Loading
 * `dotenv/config` first lets dev pick the URL up from `.env`.
 */

import 'dotenv/config';
import fs from 'fs';
import { resolvePrismaSqlitePath } from '../lib/sqlite-path';

function applyPendingImport(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith('file:')) {
    // Multi-tenant runs against Postgres — nothing to swap.
    return;
  }

  const dbPath = resolvePrismaSqlitePath(databaseUrl);
  const next = `${dbPath}.next`;

  if (!fs.existsSync(next)) return;

  // Drop WAL/SHM sidecars from the old inode so the restored file isn't
  // paired with stale write-ahead logs on first open.
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  fs.renameSync(next, dbPath);

  // stderr so this lands in the same stream as the `start.sh` echo it
  // used to live in; doesn't pollute stdout used by tooling.
  process.stderr.write(`[apply-pending-import] applied pending .prism import at ${dbPath}\n`);
}

applyPendingImport();
