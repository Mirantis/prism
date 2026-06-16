/**
 * Format a timestamp as a coarse "time ago" string for the resume picker,
 * e.g. "just now", "1 minute ago", "53 minutes ago", "2 hours ago",
 * "3 days ago".
 *
 * Uses full words on purpose — the runtime's `formatTimeAgo`
 * (src/prompts/context-builder.ts) renders a terse "1min ago" / "2h ago"
 * style that doesn't match the picker's design.
 */
export function formatRelativeTime(timestamp: number | string): string {
  const then = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'minute')} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'hour')} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'day')} ago`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}
