/**
 * Images a message places in its own text: markdown `![alt](target)` written
 * outside code. A stored message names each placed image as `attachment:<id>`,
 * one of its own attachments, and the channels show it at that position.
 */

export const ATTACHMENT_SCHEME = 'attachment:';

export interface ImageRef {
  /** Offset of the `!`. */
  start: number;
  /** Offset just past the closing `)`. */
  end: number;
  alt: string;
  target: string;
}

/** Shared with the attachment metadata the clients receive. */
interface PlaceableAttachment {
  id: string;
  category: string;
}

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s()]+)(?:\s+"[^"\n]*")?\s*\)/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;

/** The image references in `content`, in order, skipping fenced and inline code. */
export function findImageRefs(content: string): ImageRef[] {
  if (!content.includes('![')) return [];
  const code = codeRanges(content);
  const refs: ImageRef[] = [];
  for (const match of content.matchAll(IMAGE)) {
    const start = match.index;
    if (code.some(([from, to]) => start >= from && start < to)) continue;
    const raw = match[2];
    const target = raw.startsWith('<') ? raw.slice(1, -1).trim() : raw;
    if (!target) continue;
    refs.push({ start, end: start + match[0].length, alt: match[1], target });
  }
  return refs;
}

/** The attachment id an `attachment:<id>` target names, or null for any other target. */
export function attachmentRefId(target: string): string | null {
  if (!target.startsWith(ATTACHMENT_SCHEME)) return null;
  const id = target.slice(ATTACHMENT_SCHEME.length);
  return UUID.test(id) ? id : null;
}

/** True for a target on the agent's filesystem: one with no URL scheme. */
export function isLocalPath(target: string): boolean {
  return !URL_SCHEME.test(target);
}

export function attachmentImage(alt: string, attachmentId: string): string {
  return `![${alt}](${ATTACHMENT_SCHEME}${attachmentId})`;
}

/** `content` with each reference that `replace` answers for swapped for its answer. */
export function replaceImageRefs(
  content: string,
  refs: ImageRef[],
  replace: (ref: ImageRef) => string | null,
): string {
  let out = '';
  let at = 0;
  for (const ref of refs) {
    const replacement = replace(ref);
    if (replacement === null) continue;
    out += content.slice(at, ref.start) + replacement;
    at = ref.end;
  }
  return out + content.slice(at);
}

/** The images `content` shows inline: each attachment it references whose category is `image`. */
export function placeAttachments<T extends PlaceableAttachment>(
  content: string,
  attachments: T[],
): (T & { inline?: true })[] {
  const placed = new Set(
    findImageRefs(content)
      .map((ref) => attachmentRefId(ref.target))
      .filter((id): id is string => id !== null),
  );
  if (placed.size === 0) return attachments;
  return attachments.map((a) => (placed.has(a.id) && a.category === 'image' ? { ...a, inline: true } : a));
}

/** `[from, to)` offsets of fenced code blocks and inline code spans. */
function codeRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { char: string; length: number; start: number } | null = null;
  for (const match of content.matchAll(FENCE)) {
    const marker = match[1];
    if (!open) {
      open = { char: marker[0], length: marker.length, start: match.index };
      continue;
    }
    const closes = marker[0] === open.char && marker.length >= open.length && match[0].trim() === marker;
    if (closes) {
      ranges.push([open.start, match.index + match[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, content.length]);

  const runs = [...content.matchAll(/`+/g)].filter(
    (run) => !ranges.some(([from, to]) => run.index >= from && run.index < to),
  );
  for (let i = 0; i < runs.length; i++) {
    const opening = runs[i];
    const closing = runs.findIndex((run, j) => j > i && run[0].length === opening[0].length);
    if (closing === -1) continue;
    ranges.push([opening.index, runs[closing].index + runs[closing][0].length]);
    i = closing;
  }
  return ranges;
}
