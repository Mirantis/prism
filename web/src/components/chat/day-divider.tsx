import { dayLabel } from '@/lib/day-label';

/** The day the messages under it were sent, across the conversation. */
export default function DayDivider({ date }: { date: string }) {
  return (
    <div role="separator" aria-label={dayLabel(date)} data-testid="day-divider" className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium text-muted-foreground">{dayLabel(date)}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
