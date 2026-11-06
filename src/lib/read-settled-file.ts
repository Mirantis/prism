/**
 * Read a file the agent wrote, for delivery to the user: one regular, non-empty
 * file within the attachment size cap, and the same bytes from start to end of
 * the read.
 */

import type { ExecutionFiles, FileStat } from './execution-environments/execution-environment';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from '../constants';

export type SettledRead = { ok: true; data: Buffer } | { ok: false; error: string };

/**
 * Whether the file changed across a read: either it no longer matches the bytes
 * just read, or its mtime has moved on from the stat taken before that read.
 * Both halves matter — an edit that keeps the length is still a different file.
 */
function moved(before: FileStat, after: FileStat, data: Buffer): boolean {
  return after.size !== data.length || after.mtimeMs !== before.mtimeMs;
}

function tooLarge(bytes: number): string {
  return `File too large (${(bytes / (1024 * 1024)).toFixed(1)} MB) — max ${MAX_FILE_SIZE_MB} MB.`;
}

/** `shownPath` is the path as the agent wrote it, for the error it reads. */
export async function readSettledFile(
  files: ExecutionFiles,
  fullPath: string,
  shownPath: string,
): Promise<SettledRead> {
  let stat: FileStat;
  try {
    stat = await files.stat(fullPath);
  } catch {
    return { ok: false, error: `File not found: ${shownPath}` };
  }
  if (stat.isDirectory) {
    return { ok: false, error: `${shownPath} is a directory — share a single file.` };
  }
  if (stat.size === 0) return { ok: false, error: `File is empty: ${shownPath}` };
  if (stat.size > MAX_FILE_SIZE_BYTES) return { ok: false, error: tooLarge(stat.size) };

  // Read, then confirm the file did not move under the read. This catches the
  // writers that outlive their call (`coding_agent`, `shell_spawn`) in the one
  // window where they are observable at all. One retry: a second change means
  // something is still writing, and guessing which revision the reply describes
  // is exactly the mistake being fixed.
  let data: Buffer;
  try {
    let before = stat;
    data = await files.readBytes(fullPath);
    let after = await files.stat(fullPath);
    if (moved(before, after, data)) {
      before = after;
      data = await files.readBytes(fullPath);
      after = await files.stat(fullPath);
      // Compare against the stat taken just before the retry, and on mtime as
      // well as size — a same-size edit is still a different revision, and size
      // alone would let one through.
      if (moved(before, after, data)) {
        return {
          ok: false,
          error:
            `Not shared: ${shownPath} is changing while it is read, so the attachment ` +
            `would not match what you describe. Wait for the write to finish, then share it.`,
        };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Re-check the guards against the bytes actually read. The stat above can be
  // stale by now — a background writer may have grown the file past the cap or
  // truncated it to nothing — and `data` is what goes into the media store.
  if (data.length === 0) return { ok: false, error: `File is empty: ${shownPath}` };
  if (data.length > MAX_FILE_SIZE_BYTES) return { ok: false, error: tooLarge(data.length) };
  return { ok: true, data };
}
