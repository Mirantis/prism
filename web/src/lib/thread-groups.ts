import type { ConversationThread } from '@/types';

export type ThreadGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Previous 30 days' | 'Older';

export interface ThreadGroup<T> {
  label: ThreadGroupLabel;
  threads: T[];
}

/**
 * Split threads into runs by the local calendar day they started on. The input order is kept,
 * so a newest-first list yields newest-first groups, each newest-first.
 */
export function groupThreadsByDate<T extends Pick<ConversationThread, 'createdAt'>>(
  threads: T[],
  now: Date = new Date(),
): ThreadGroup<T>[] {
  // Each cutoff is midnight on a calendar day, counted back in days rather than in hours, so a
  // daylight-saving change does not move it off midnight.
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const today = new Date(y, m, d).getTime();
  const yesterday = new Date(y, m, d - 1).getTime();
  const week = new Date(y, m, d - 7).getTime();
  const month = new Date(y, m, d - 30).getTime();

  const groupFor = (createdAt: string): ThreadGroupLabel => {
    const ts = new Date(createdAt).getTime();
    if (ts >= today) return 'Today';
    if (ts >= yesterday) return 'Yesterday';
    if (ts >= week) return 'Previous 7 days';
    if (ts >= month) return 'Previous 30 days';
    return 'Older';
  };

  const groups: ThreadGroup<T>[] = [];
  for (const thread of threads) {
    const label = groupFor(thread.createdAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.threads.push(thread);
    else groups.push({ label, threads: [thread] });
  }
  return groups;
}
