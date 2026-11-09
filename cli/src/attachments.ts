/**
 * Shared attachment types and helpers for the TUI's `/attach` flow.
 *
 * Files are uploaded to the runtime's `POST /agents/attachments` (multipart,
 * stored server-side under the data dir's media folder) and staged locally
 * until the next chat message carries their ids. The server detects the media
 * type from magic bytes and enforces the size cap — everything here is
 * client-side convenience.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Server-side classification: image | pdf | text | unreadable. */
export type AttachmentCategory = string;

/** Metadata returned by POST /agents/attachments (never the bytes). */
export interface AttachmentMeta {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: AttachmentCategory;
  /** Content deleted by the server's retention sweep (7 days) — metadata only. */
  expired?: boolean;
}

/**
 * Mirrors the runtime's MAX_FILE_SIZE_BYTES (src/constants.ts — different
 * workspace, not importable here). Used only for a fast local pre-check;
 * the server remains authoritative.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Max files staged on one message — mirrors the runtime's
 * MAX_ATTACHMENTS_PER_MESSAGE (separate workspace, not importable). UX guard
 * only; the server re-enforces it at link time.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 100;

/**
 * Human-readable byte size, e.g. "1.2 MB".
 *
 * Kept in sync with the runtime's `src/services/attachment.service.ts#humanFileSize`
 * and the web's `ChatAttachmentChip.tsx#humanSize` — separate workspaces, so the
 * formatter is mirrored rather than imported.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Expand a leading `~` (alone, `~/…`, or `~\…` on Windows) to the home directory. */
export function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export interface PathSuggestion {
  /** What the popup shows: the entry name, with a trailing '/' for dirs. */
  display: string;
  /** The full new argument after '/attach ': typed dirPart + name (+ '/' for dirs). */
  insert: string;
  isDirectory: boolean;
}

const MAX_SUGGESTIONS = 24;

/**
 * Best-effort local path suggestions for the partial path typed after
 * `/attach `. Splits at the last '/' into a directory part (kept verbatim —
 * including `~` — so re-insertion stays readable) and a basename prefix.
 * Synchronous readdir per keystroke is fine: it's one local dir listing.
 */
export function listPathSuggestions(partial: string, cwd = process.cwd()): PathSuggestion[] {
  // Split on the platform separator too (Windows backslash paths) — but only
  // via path.sep, since on POSIX a backslash is a legal filename character.
  const lastSlash = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf(path.sep));
  const dirPart = lastSlash === -1 ? '' : partial.slice(0, lastSlash + 1);
  const base = lastSlash === -1 ? partial : partial.slice(lastSlash + 1);

  const absDir = path.resolve(cwd, expandPath(dirPart || '.'));

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    // ENOENT / ENOTDIR / EACCES — nothing to suggest.
    return [];
  }

  const showHidden = base.startsWith('.');
  return entries
    .filter((e) => e.name.startsWith(base) && (showHidden || !e.name.startsWith('.')))
    .sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    })
    .slice(0, MAX_SUGGESTIONS)
    .map((e) => {
      const isDirectory = e.isDirectory();
      const suffix = isDirectory ? '/' : '';
      return {
        display: e.name + suffix,
        insert: dirPart + e.name + suffix,
        isDirectory,
      };
    });
}

/**
 * The files of the latest turn that delivered any: every agent message since
 * the user's last message that holds one, oldest first. A verbose turn places
 * a chart in one step's reply and attaches a CSV to the last, and `/save`
 * offers both. With no files since the user's last message, the newest agent
 * turn that has any.
 */
export function latestTurnAttachments(
  messages: ReadonlyArray<{ role: string; attachments?: AttachmentMeta[] | null }>,
): AttachmentMeta[] {
  const turn: AttachmentMeta[][] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'USER') {
      if (turn.length > 0) break;
      continue;
    }
    if (m.role === 'AGENT' && Array.isArray(m.attachments) && m.attachments.length > 0) {
      turn.unshift(m.attachments);
    }
  }
  const seen = new Set<string>();
  return turn.flat().filter((a) => !seen.has(a.id) && seen.add(a.id));
}
