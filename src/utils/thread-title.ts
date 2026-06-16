/**
 * Derive a conversation thread title from the user's first message: the first
 * three words, capped at 24 characters with a trailing "..." when truncated
 * (e.g. "keuruun saha transla...").
 *
 * Returns "" when the message has no usable text (e.g. a file-only message) —
 * callers should not set a title in that case.
 */
const MAX_TITLE_LENGTH = 24;
const ELLIPSIS = '...';

export function deriveThreadTitle(content: string): string {
  const text = content.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  if (!text) return '';
  if (text.length <= MAX_TITLE_LENGTH) return text;
  return text.slice(0, MAX_TITLE_LENGTH - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}
