export const SCHEDULE_PRESETS = [
  { name: 'Daily', expression: '0 9 * * *', description: 'Every day at 09:00' },
  { name: 'Weekdays', expression: '0 9 * * 1-5', description: 'Monday–Friday at 09:00' },
  { name: 'Weekly', expression: '0 9 * * 1', description: 'Every Monday at 09:00' },
] as const;

export function scheduleDescription(expression: string): string | undefined {
  return SCHEDULE_PRESETS.find((preset) => preset.expression === expression.trim())?.description;
}
