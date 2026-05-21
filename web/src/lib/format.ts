export function formatInterval(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export function formatRelativeTime(input: string | number | Date | null | undefined): string {
  if (input == null) return '—';
  const ts = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diffMs = ts - Date.now();
  const absMs = Math.abs(diffMs);
  const past = diffMs < 0;

  const sec = Math.round(absMs / 1000);
  if (sec < 60) return past ? 'just now' : 'in a moment';

  const min = Math.round(sec / 60);
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`;

  const hr = Math.round(min / 60);
  if (hr < 24) return past ? `${hr}h ago` : `in ${hr}h`;

  const day = Math.round(hr / 24);
  if (day < 30) return past ? `${day}d ago` : `in ${day}d`;

  const mon = Math.round(day / 30);
  if (mon < 12) return past ? `${mon}mo ago` : `in ${mon}mo`;

  const yr = Math.round(mon / 12);
  return past ? `${yr}y ago` : `in ${yr}y`;
}
