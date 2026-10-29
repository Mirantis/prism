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
 * TTL. That is simpler, and folding it into a live-set reaper would only make it
 * look complicated.
 *
 * The agent reads a saved copy with `shell_exec`, so the notice carries the file's
 * path and the agent brings its own tool — `jq` for the JSON these payloads
 * usually are, `grep` or `sed` otherwise. A path in stored history goes stale if
 * the data dir moves between a container and local dev; the read then fails the
 * same way an expired copy does, which is the behaviour either way.
 */

import path from 'path';
import { randomUUID } from 'crypto';
import {
  getExecutionEnvironment,
  getExecutionEnvironmentFor,
  getHostEnvironment,
} from './execution-environments/get-execution-environment';
import type { ExecutionFiles } from './execution-environments/execution-environment';
import { resolveWorkspace } from './execution-environments/workspace';

/** One place saved copies are kept, and the filesystem that reaches it. */
interface Store {
  dir: string;
  files: ExecutionFiles;
}

/**
 * Where a thread's saved copies go: beside the shell that reads them back. A
 * thread rooted in a host repository runs its commands on the host even while
 * the deployment runs in a container, so its copies go to the host too.
 */
function storeFor(workspaceRoot?: string | null): Store {
  const environment = getExecutionEnvironmentFor(resolveWorkspace(workspaceRoot));
  return { dir: environment.paths().toolOutputDir, files: environment.files };
}

/**
 * Every place a saved copy can be, for the reads and sweeps that do not know
 * which thread wrote it. One entry when the deployment runs on this machine.
 */
function allStores(): Store[] {
  const stores: Store[] = [];
  for (const environment of [getExecutionEnvironment(), getHostEnvironment()]) {
    const dir = environment.paths().toolOutputDir;
    if (!stores.some((store) => store.dir === dir)) stores.push({ dir, files: environment.files });
  }
  return stores;
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
export function isToolOutputId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

/**
 * Save a tool result whole and return its id. Atomic: writes a `.tmp` sibling,
 * then renames, so a reader never sees a half-written copy.
 */
export async function writeToolOutput(
  text: string,
  workspaceRoot?: string | null,
): Promise<SpillResult> {
  const { dir, files } = storeFor(workspaceRoot);
  // Defensive: ensureDataDirs() creates this at boot, but its temp-dir fallback
  // can repin PRISM_DATA_DIR afterwards.
  await files.mkdir(dir);

  const buf = Buffer.from(text, 'utf8');
  const capped = buf.length > MAX_SPILL_BYTES;
  // Back off the cut to a character boundary. Slicing mid-character leaves a
  // replacement char at the end of the copy, which a search near the cap would
  // then fail to match.
  const data = capped ? buf.subarray(0, charBoundaryAtOrBefore(buf, MAX_SPILL_BYTES)) : buf;

  const id = randomUUID();
  // POSIX, because a container path is POSIX whatever this host is.
  const finalPath = path.posix.join(dir, id);
  const tmpPath = `${finalPath}.tmp`;
  await files.writeBytes(tmpPath, data);
  await files.rename(tmpPath, finalPath);

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
 * Where a saved output of this thread lives, for the notice that points the
 * agent at it.
 *
 * Absolute, because the agent reads it with `shell_exec`, whose commands are not
 * resolved against the shell workspace.
 */
export function toolOutputPath(id: string, workspaceRoot?: string | null): string {
  return path.posix.join(storeFor(workspaceRoot).dir, id);
}

/**
 * Read a saved output back. `null` when the id is unknown or the copy has expired
 * — a stub outlives its file by design, so callers report that as "no longer
 * stored" rather than as a failure.
 */
export async function readToolOutput(id: string): Promise<string | null> {
  if (!isToolOutputId(id)) return null;
  for (const { dir, files } of allStores()) {
    const full = path.posix.join(dir, id);
    try {
      await files.lstat(full);
    } catch {
      continue;
    }
    return files.readText(full);
  }
  return null;
}

/**
 * Delete saved outputs older than `ttlMs`, by mtime. This is the whole retention
 * story — no live set to reconcile against, because nothing holds a reference.
 * Also sweeps `.tmp` files a crash left between write and rename.
 */
export async function reapExpiredToolOutputs(ttlMs: number): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const { dir, files } of allStores()) {
    let entries: string[];
    try {
      entries = (await files.readDir(dir)).map((entry) => entry.name);
    } catch {
      continue; // never created, or the data dir moved — nothing to sweep
    }

    for (const entry of entries) {
      const full = path.posix.join(dir, entry);
      try {
        const st = await files.lstat(full);
        if (!st.isFile || st.mtimeMs >= cutoff) continue;
        await files.remove(full);
        removed++;
      } catch {
        // A file that vanished under us, or one we can't stat — either way, skip it
        // rather than abandon the rest of the sweep.
      }
    }
  }
  return removed;
}
