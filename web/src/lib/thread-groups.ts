import type { ConversationThread } from '@/types';

export type ThreadGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Previous 30 days' | 'Older';

export interface ThreadGroup<T> {
  label: ThreadGroupLabel;
  threads: T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function groupFor(createdAt: string, startOfToday: number): ThreadGroupLabel {
  const ts = new Date(createdAt).getTime();
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - DAY_MS) return 'Yesterday';
  if (ts >= startOfToday - 7 * DAY_MS) return 'Previous 7 days';
  if (ts >= startOfToday - 30 * DAY_MS) return 'Previous 30 days';
  return 'Older';
}

/**
 * Split threads into runs by the local calendar day they started on. The input order is kept,
 * so a newest-first list yields newest-first groups, each newest-first.
 */
export function groupThreadsByDate<T extends Pick<ConversationThread, 'createdAt'>>(
  threads: T[],
  now: Date = new Date(),
): ThreadGroup<T>[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: ThreadGroup<T>[] = [];
  for (const thread of threads) {
    const label = groupFor(thread.createdAt, startOfToday);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.threads.push(thread);
    else groups.push({ label, threads: [thread] });
  }
  return groups;
}
