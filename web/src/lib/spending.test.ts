import { describe, it, expect } from 'vitest';
import { formatUsd, monthTotals, periodLabel, shortModel, withMentionNames } from './spending';
import type { PeriodSpend } from '@/types';

function day(start: string, costUsd: number): PeriodSpend {
  return {
    start,
    from: '',
    to: '',
    costUsd,
    calls: 1,
    unpricedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdByKind: { main: costUsd, 'coding-agent': 0, voice: 0 },
  };
}

describe('formatUsd', () => {
  it('shows cents, and spend below a cent as less than a cent rather than as nothing', () => {
    expect(formatUsd(1234.567)).toBe('$1,234.57');
    expect(formatUsd(0.004)).toBe('< $0.01');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('monthTotals', () => {
  it('compares this month so far with the same days of last month', () => {
    const totals = monthTotals([
      day('2026-10-02', 4),
      day('2026-10-03', 6),
      day('2026-10-04', 100),
      day('2026-11-01', 5),
      day('2026-11-02', 2),
      day('2026-11-03', 1),
    ]);

    expect(totals).toEqual({
      today: 1,
      thisMonth: 8,
      lastMonth: 110,
      lastMonthToDate: 10,
      dayOfMonth: 3,
      lastMonthStart: '2026-10-01',
    });
  });

  it('takes December as the month before January', () => {
    expect(monthTotals([day('2025-12-01', 3), day('2026-01-01', 1)])).toMatchObject({
      lastMonth: 3,
      lastMonthToDate: 3,
      lastMonthStart: '2025-12-01',
    });
  });
});

describe('periodLabel', () => {
  it('names a day, a week and a month by their local start date', () => {
    expect(periodLabel('day', '2026-11-18', 'long')).toBe('Wed, Nov 18');
    expect(periodLabel('week', '2026-11-16', 'long')).toBe('Week of November 16');
    expect(periodLabel('month', '2026-11-01', 'long')).toBe('November 2026');
    expect(periodLabel('month', '2026-11-01')).toBe('Nov');
  });
});

describe('withMentionNames', () => {
  it('reads each stored mention as its name', () => {
    expect(withMentionNames('<@U01ET9F2HK4:Ana Lopez>: <@U0B7X8UM7FV:Prismith> can you check')).toBe(
      'Ana Lopez: Prismith can you check',
    );
  });

  it('reads a mention whose id is a GUID', () => {
    expect(withMentionNames('<@6f1c2d3e-0000-4000-8000-00000000a001:Ana Example>: hi')).toBe('Ana Example: hi');
  });

  it('reads a mention a title cut short as the name up to the cut', () => {
    expect(withMentionNames('<@U01ET9F2HK4:Ana Lop…')).toBe('Ana Lop…');
    expect(withMentionNames('<@U01ET9F2HK4:Ana Lop...')).toBe('Ana Lop...');
  });

  it('drops a mention a title cut before its name, and keeps the ellipsis', () => {
    // deriveThreadTitle of "<@U01ET9F2HK4:Li>: <@U0B7X8UM7FV:Prismith> can you check".
    expect(withMentionNames('<@U01ET9F2HK4:Li>: <@...')).toBe('Li:...');
    expect(withMentionNames('<@U01ET9F2HK4:Li>: <@U0B7…')).toBe('Li:…');
    expect(withMentionNames('<@U0B7')).toBe('');
  });

  it('leaves text without a mention unchanged', () => {
    expect(withMentionNames('Fix the flaky test')).toBe('Fix the flaky test');
  });
});

describe('shortModel', () => {
  it('drops the region and vendor prefixes of a model id', () => {
    expect(shortModel('global.anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(shortModel('anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(shortModel('openai.gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(shortModel('gpt-realtime-2.1')).toBe('gpt-realtime-2.1');
  });
});
