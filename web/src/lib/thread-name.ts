import type { ConversationThread } from '@/types';

/**
 * Display name for a conversation thread in the Recents list.
 *
 * Threads launched from the CLI carry a `workspaceRoot` (the launch folder) —
 * we show that folder's basename. Web-created threads have no folder, so we
 * fall back to the thread's creation date/time.
 */
export function threadDisplayName(
  thread: Pick<ConversationThread, 'workspaceRoot' | 'createdAt'>,
): string {
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
