import type { ConversationThread } from '@/types';

/**
 * Display name for a conversation thread in the Recents list.
 *
 * Prefers the thread's `title` (auto-generated from the first user message).
 * Falls back to the basename of the `workspaceRoot` (the CLI launch folder)
 * when there's no title, and finally to the thread's creation date/time.
 */
export function threadDisplayName(
  thread: Pick<ConversationThread, 'title' | 'workspaceRoot' | 'createdAt'>,
): string {
  if (thread.title) return thread.title;
  const base = workspaceBasename(thread.workspaceRoot);
  if (base) return base;
  return formatCreatedAt(thread.createdAt);
}

/** Last path segment of a workspace root, or null when unset/empty. Handles posix + Windows separators. */
function workspaceBasename(workspaceRoot: string | null | undefined): string | null {
  if (typeof workspaceRoot !== 'string') return null;
  const segments = workspaceRoot.split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : null;
}

/** e.g. "Jun 16, 14:03"; falls back to the raw string if it isn't a valid date. */
function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
