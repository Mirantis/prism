/**
 * Tool Output Store
 *
 * The saved copy of a tool result that was too big to show the model whole. The
 * model is shown the head and the tail with a notice naming an id; the whole text
 * lives here as a file, and `tools/read-tool-output.ts` is how the agent gets at
 * the part it could not see.
 *
 * A sibling of `lib/media-store.ts` rather than a client of it. The two look alike
 * — atomic write, containment guard, ENOENT means "gone, not broken" — but their
 * lifecycles differ in the way that matters: an attachment is referenced by a DB
 * row, so its reaper works from a live set and needs boot reconciliation, while
 * nothing points at a spill. A spill's entire lifecycle is its mtime against the
 * TTL, plus a best-effort delete when the message that named it goes away. That is
 * simpler, and folding it into a live-set reaper would only make it look
 * complicated.
 *
 * The agent reads a saved copy with `shell_exec`, so the notice carries the file's
 * path and the agent brings its own tool — `jq` for the JSON these payloads
 * usually are, `grep` or `sed` otherwise. A path in stored history goes stale if
 * the data dir moves between a container and local dev; the read then fails the
 * same way an expired copy does, which is the behaviour either way.
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { getExecutionEnvironment } from './execution-environments/get-execution-environment';
import { logger } from '../logger';

/** The filesystem a command sees: the agent reads a saved copy with the shell. */
function files() {
  return getExecutionEnvironment().files;
}

/**
 * Ceiling on one saved copy. Paired with `MAX_EXEC_OUTPUT_BYTES` in
 * `tools/shell/config.ts` — keep them equal. Past it the copy holds the first
 * 10 MiB and says so, because a pathological result must fill neither the row nor
 * the volume.
 */
export const MAX_SPILL_BYTES = 10 * 1024 * 1024;

export interface SpillResult {
  /** Identifies the copy: the file's name, and what the record stores. */
  id: string;
  /** Absolute path, for the notice that sends the agent to it. */
  path: string;
  /** Bytes actually written. */
  bytes: number;
  /** True when the saved copy is itself only the first `MAX_SPILL_BYTES`. */
  capped: boolean;
}

/**
 * An id is ours and never user-supplied, so this is stricter than a path check:
 * only the exact uuid shape passes, which leaves no room for a separator or a
 * traversal to be argued about.
 */
/**
 * The directory the saved copies go in, which belongs to the execution
 * environment: the agent reads one back with the shell, so it has to be a path
 * that environment's commands can open. Joined as POSIX for the same reason.
 */
function toolOutputDir(): string {
  return getExecutionEnvironment().paths().toolOutputDir;
}

export function isToolOutputId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

/**
 * Save a tool result whole and return its id. Atomic: writes a `.tmp` sibling,
 * then renames, so a reader never sees a half-written copy.
 */
export async function writeToolOutput(text: string): Promise<SpillResult> {
  const dir = toolOutputDir();
  // Defensive: ensureDataDirs() creates this at boot, but its temp-dir fallback
  // can repin PRISM_DATA_DIR afterwards.
  await files().mkdir(dir);

  const buf = Buffer.from(text, 'utf8');
  const capped = buf.length > MAX_SPILL_BYTES;
  // Back off the cut to a character boundary. Slicing mid-character leaves a
  // replacement char at the end of the copy, which a search near the cap would
  // then fail to match.
  const data = capped ? buf.subarray(0, charBoundaryAtOrBefore(buf, MAX_SPILL_BYTES)) : buf;

  const id = randomUUID();
  const finalPath = path.join(dir, id);
  const tmpPath = `${finalPath}.tmp`;
  await files().writeBytes(tmpPath, data);
  await files().rename(tmpPath, finalPath);

  return { id, path: finalPath, bytes: data.length, capped };
}

/**
 * The largest cut at or before `limit` that does not split a UTF-8 character.
 * A continuation byte is `10xxxxxx`; a character starts at anything else, and no
 * character is longer than four bytes.
 */
function charBoundaryAtOrBefore(buf: Buffer, limit: number): number {
  let end = limit;
  for (let back = 0; back < 4 && end > 0; back++) {
    if ((buf[end] & 0xc0) !== 0x80) return end;
    end--;
  }
  return end;
}

/**
 * Where a saved output lives, for the notice that points the agent at it.
 *
 * Absolute, because the agent reads it with `shell_exec`, whose commands are not
 * resolved against the shell workspace.
 */
export function toolOutputPath(id: string): string {
  return path.posix.join(toolOutputDir(), id);
}

/**
 * Read a saved output back. `null` when the id is unknown or the copy has expired
 * — a stub outlives its file by design, so callers report that as "no longer
 * stored" rather than as a failure.
 */
export async function readToolOutput(id: string): Promise<string | null> {
  if (!isToolOutputId(id)) return null;
  const full = path.posix.join(toolOutputDir(), id);
  try {
    await files().lstat(full);
  } catch {
    return null;
  }
  return files().readText(full);
}

/**
 * Delete saved outputs by id. Best effort: called when a thread or a message that
 * named them is deleted, so a spill does not sit for the rest of its TTL
 * referenced by nothing. The TTL sweep is the backstop for whatever this misses.
 */
export async function removeToolOutputs(ids: readonly string[]): Promise<number> {
  const dir = toolOutputDir();
  let removed = 0;
  for (const id of ids) {
    if (!isToolOutputId(id)) continue;
    const full = path.posix.join(dir, id);
    try {
      // Already gone is the expected case, so the count reports what was really
      // there rather than how many ids the caller named.
      await files().lstat(full);
    } catch {
      continue;
    }
    try {
      await files().remove(full);
      removed++;
    } catch (err) {
      logger.warn({ err }, `[ToolOutputStore] could not delete saved output ${id}`);
    }
  }
  return removed;
}

/**
 * Delete saved outputs older than `ttlMs`, by mtime. This is the whole retention
 * story — no live set to reconcile against, because nothing holds a reference.
 * Also sweeps `.tmp` files a crash left between write and rename.
 */
export async function reapExpiredToolOutputs(ttlMs: number): Promise<number> {
  const dir = toolOutputDir();
  let entries: string[];
  try {
    entries = (await files().readDir(dir)).map((entry) => entry.name);
  } catch {
    return 0; // never created, or the data dir moved — nothing to sweep
  }

  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = await files().lstat(full);
      if (!st.isFile || st.mtimeMs >= cutoff) continue;
      await files().remove(full);
      removed++;
    } catch {
      // A file that vanished under us, or one we can't stat — either way, skip it
      // rather than abandon the rest of the sweep.
    }
  }
  return removed;
}
