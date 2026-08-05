/**
 * Media store — the sole reader/writer of attachment content files.
 *
 * Attachment bytes live as files under `<dataDir>/media` (`/data/media` in the
 * container, on the persistent volume); the `MessageAttachment` row keeps only
 * metadata plus `storagePath`, the file's basename. The basename is relative on
 * purpose: the store survives a data-dir relocation, and a stored path can
 * never point outside the media dir.
 *
 * Writes are atomic (temp sibling + rename) so a crash mid-write never leaves
 * a half-file behind under the final name. A file written for a row whose
 * DB insert then failed is invisible to every reader (nothing references it)
 * and is removed by `reapStrayMediaFiles`, whose grace period covers the
 * write-file-then-create-row window.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveMediaDir } from './data-dir';

const MAX_FILENAME_BYTES = 255;

// Room for `<uuid>-` (37 bytes) + the `.tmp` suffix inside a 255-byte basename.
const MAX_STORED_NAME_BYTES = 200;

/**
 * Make an untrusted filename safe to use as (part of) a real file's name:
 * basename only, no control chars, no traversal, byte-capped.
 */
export function sanitizeFilename(raw: string, fallback: string): string {
  let name = path.basename(raw);
  // Strip control chars and path separators that snuck past basename
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, '_');
  // Reject directory traversal remnants
  name = name.replace(/\.\./g, '_');
  // Cap length in bytes (UTF-8 aware)
  const buf = Buffer.from(name, 'utf8');
  if (buf.length > MAX_FILENAME_BYTES) {
    name = buf.subarray(0, MAX_FILENAME_BYTES).toString('utf8');
  }
  return name.trim() || fallback;
}

/**
 * A storagePath is valid only as a plain basename — anything that could
 * escape the media dir (separators, traversal, absolute paths) is rejected.
 * Guards readers against a tampered DB value.
 */
function isSafeStoragePath(storagePath: string): boolean {
  return (
    storagePath.length > 0 &&
    !storagePath.includes('/') &&
    !storagePath.includes('\\') &&
    !storagePath.includes('..') &&
    storagePath === path.basename(storagePath)
  );
}

/** Byte-cap a sanitized name so `<id>-<name>` stays a legal basename. */
function capStoredName(name: string): string {
  const buf = Buffer.from(name, 'utf8');
  if (buf.length <= MAX_STORED_NAME_BYTES) return name;
  return buf.subarray(0, MAX_STORED_NAME_BYTES).toString('utf8');
}

/**
 * Write attachment content to the media dir as `<id>-<sanitized filename>`.
 * Atomic: streams to a `.tmp` sibling, then renames into place. Returns the
 * basename to persist as the row's `storagePath`.
 */
export async function writeMediaFile(id: string, filename: string, data: Buffer): Promise<string> {
  const mediaDir = resolveMediaDir();
  // Defensive: ensureDataDirs() creates this at boot, but the temp-dir
  // fallback can repin PRISM_DATA_DIR after that.
  await fs.mkdir(mediaDir, { recursive: true });

  const storagePath = `${id}-${capStoredName(sanitizeFilename(filename, 'file'))}`;
  const finalPath = path.join(mediaDir, storagePath);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, finalPath);
  return storagePath;
}

/**
 * Read attachment content by its stored basename. Returns `null` when the
 * file is gone (expired / never written / lost) — callers treat that as
 * "content no longer available", not an error.
 */
export async function readMediaFile(storagePath: string): Promise<Buffer | null> {
  if (!isSafeStoragePath(storagePath)) return null;
  try {
    return await fs.readFile(path.join(resolveMediaDir(), storagePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Best-effort unlink. True when the file is gone afterwards. */
export async function removeMediaFile(storagePath: string): Promise<boolean> {
  if (!isSafeStoragePath(storagePath)) return false;
  try {
    await fs.unlink(path.join(resolveMediaDir(), storagePath));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Delete media files no DB row references. Covers rows removed by cascade
 * (message/thread deletion), rows from a `.prism` import pointing at another
 * install's files, and orphaned `.tmp` siblings. `graceMs` spares files
 * younger than the write-file-then-create-row window — never shorten it below
 * the hourly sweep interval's safety margin (1 h).
 */
export async function reapStrayMediaFiles(
  liveStoragePaths: Set<string>,
  graceMs: number,
): Promise<number> {
  const mediaDir = resolveMediaDir();
  let entries: string[];
  try {
    entries = await fs.readdir(mediaDir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - graceMs;
  let reaped = 0;
  for (const entry of entries) {
    if (liveStoragePaths.has(entry)) continue;
    const filePath = path.join(mediaDir, entry);
    const st = await fs.lstat(filePath).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (st.mtimeMs >= cutoff) continue;
    try {
      await fs.unlink(filePath);
      reaped++;
    } catch {
      // Best effort — a vanished or locked file is someone else's win/problem.
    }
  }
  return reaped;
}
