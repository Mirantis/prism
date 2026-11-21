import type { PeriodSpend, RequestKind, SourcedSpendCategory, SpendCategory, SpendKind, SpendPeriodLength } from '@/types';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * A dollar amount for a figure: cents, and "< $0.01" for spend below a cent, so a
 * call that cost something never reads "$0.00".
 */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '< $0.01';
  return USD.format(usd);
}

/** The amount to six decimals, for the place a figure's exact value is shown. */
export function formatUsdExact(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

/** The chart's series, in their fixed order. */
export const SPEND_KINDS: readonly SpendKind[] = ['main', 'coding-agent', 'voice'];

export const SPEND_KIND_LABEL: Record<SpendKind, string> = {
  main: 'Agent',
  'coding-agent': 'Coding agent',
  voice: 'Voice',
};

export const SPEND_KIND_FILL: Record<SpendKind, string> = {
  main: 'bg-spend-main',
  'coding-agent': 'bg-spend-coding-agent',
  voice: 'bg-spend-voice',
};

export const SPEND_CATEGORY_LABEL: Record<SpendCategory, string> = {
  conversations: 'Conversations',
  'coding-agent': 'Coding agent',
  voice: 'Voice',
  heartbeat: 'Heartbeat',
  'scheduled-tasks': 'Scheduled tasks',
  webhooks: 'Webhooks',
  goals: 'Goals',
  background: 'Background work',
};

export const SPEND_CATEGORY_HINT: Partial<Record<SpendCategory, string>> = {
  background: 'Conversation titles, compaction and other work no message started',
};

const SOURCED: readonly SpendCategory[] = ['scheduled-tasks', 'webhooks', 'goals'];

/** The categories whose spend is listed per scheduled task, webhook or goal. */
export function isSourcedCategory(category: SpendCategory): category is SourcedSpendCategory {
  return SOURCED.includes(category);
}

/** What a source with no name is: deleted since, or recorded before runs named their source. */
export function unnamedSource(category: SourcedSpendCategory, sourceId: string | null): string {
  if (sourceId === null) return 'Earlier runs';
  return { 'scheduled-tasks': 'Deleted task', webhooks: 'Deleted webhook', goals: 'Deleted goal' }[category];
}

export const REQUEST_KIND_LABEL: Record<RequestKind, string> = {
  message: 'Your message',
  'agent-message': 'Message from an agent',
  'task-result': 'Coding task result',
  chat: 'Conversation turn',
  heartbeat: 'Heartbeat',
  cron: 'Scheduled task',
  webhook: 'Webhook',
  goal: 'Goal',
  'voice-chat': 'Voice chat',
  meeting: 'Meeting',
  dictation: 'Dictation',
  other: 'Message',
};

const PURPOSE_LABEL: Record<string, string> = {
  chat: 'Agent replies',
  heartbeat: 'Heartbeat',
  cron: 'Scheduled task',
  goal: 'Goal turns',
  webhook: 'Webhook run',
  subagent: 'Subagent',
  'early-stopping': 'Step-limit summary',
  compaction: 'Compaction',
  'thread-title': 'Conversation title',
  'feedback-gate': 'Feedback check',
  'goal-gate': 'Goal check',
  'risk-gate': 'Safety check',
  'model-routing': 'Model choice',
  'agent-voice': 'Voice choice',
  'coding-agent': 'Coding agent',
  'voice-chat': 'Voice chat',
  meeting: 'Meeting',
  dictation: 'Dictation',
};

/** A model id without its region and vendor prefix: `global.anthropic.claude-opus-5-5` reads `claude-opus-5-5`. */
export function shortModel(model: string): string {
  return model.replace(/^(?:[a-z]{2,6}\.)?(?:anthropic|openai)\./, '');
}

/** What a call was for, in words; a purpose this list does not name reads as itself. */
export function purposeLabel(purpose: string): string {
  return PURPOSE_LABEL[purpose] ?? purpose;
}

export const PERIOD_COUNT: Record<SpendPeriodLength, number> = { day: 30, week: 12, month: 12 };

/** A period's label, read from its local start date (`YYYY-MM-DD`). */
export function periodLabel(period: SpendPeriodLength, start: string, style: 'short' | 'long' = 'short'): string {
  const [year, month, day] = start.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(date);
  if (period === 'month') return fmt(style === 'short' ? { month: 'short' } : { month: 'long', year: 'numeric' });
  if (period === 'week') return style === 'short' ? fmt({ month: 'short', day: 'numeric' }) : `Week of ${fmt({ month: 'long', day: 'numeric' })}`;
  return fmt(style === 'short' ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

export interface MonthTotals {
  today: number;
  thisMonth: number;
  lastMonth: number;
  /** Last month up to the same day of the month as today. */
  lastMonthToDate: number;
  /** The days counted in this month so far. */
  dayOfMonth: number;
  /** The first day of last month, `YYYY-MM-DD`; null with no days. */
  lastMonthStart: string | null;
}

/** Days enough to cover today, the month so far and the whole previous month. */
export const MONTH_TOTALS_DAYS = 62;

/** Today's, this month's and last month's totals, from daily periods ending today. */
export function monthTotals(days: PeriodSpend[]): MonthTotals {
  const today = days.at(-1);
  if (!today) return { today: 0, thisMonth: 0, lastMonth: 0, lastMonthToDate: 0, dayOfMonth: 0, lastMonthStart: null };
  const [year, month, dayOfMonth] = today.start.split('-').map(Number);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };

  let thisMonth = 0;
  let lastMonth = 0;
  let lastMonthToDate = 0;
  for (const day of days) {
    const [y, m, d] = day.start.split('-').map(Number);
    if (y === year && m === month) thisMonth += day.costUsd;
    if (y === previous.year && m === previous.month) {
      lastMonth += day.costUsd;
      if (d <= dayOfMonth) lastMonthToDate += day.costUsd;
    }
  }
  const lastMonthStart = `${previous.year}-${String(previous.month).padStart(2, '0')}-01`;
  return { today: today.costUsd, thisMonth, lastMonth, lastMonthToDate, dayOfMonth, lastMonthStart };
}
