/** Common schedules, offered as one-press choices when a task is created. */
export const CRON_PRESETS = [
  { label: 'Every hour', schedule: '0 * * * *' },
  { label: 'Every day at 09:00', schedule: '0 9 * * *' },
  { label: 'Weekdays at 09:00', schedule: '0 9 * * 1-5' },
  { label: 'Mondays at 09:00', schedule: '0 9 * * 1' },
] as const;

/** The words for a schedule that is one of the presets, or null for any other expression. */
export function describeSchedule(schedule: string): string | null {
  const normalized = schedule.trim().replace(/\s+/g, ' ');
  return CRON_PRESETS.find((p) => p.schedule === normalized)?.label ?? null;
}
