import { describe, it, expect } from 'vitest';
import { groupThreadsByDate } from './thread-groups';

const now = new Date(2026, 8, 24, 15, 0);
const at = (days: number, hour = 12) =>
  ({ createdAt: new Date(2026, 8, 24 - days, hour).toISOString(), days });

describe('groupThreadsByDate', () => {
  it('buckets threads by the local day they started on, keeping their order', () => {
    const groups = groupThreadsByDate([at(0, 14), at(0, 1), at(1), at(3), at(20), at(90)], now);
    expect(groups.map((g) => [g.label, g.threads.map((t) => t.days)])).toEqual([
      ['Today', [0, 0]],
      ['Yesterday', [1]],
      ['Previous 7 days', [3]],
      ['Previous 30 days', [20]],
      ['Older', [90]],
    ]);
  });

  it('counts a thread from just after midnight as today and one from just before as yesterday', () => {
    const groups = groupThreadsByDate(
      [
        { createdAt: new Date(2026, 8, 24, 0, 1).toISOString() },
        { createdAt: new Date(2026, 8, 23, 23, 59).toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
  });

  it('returns no groups for no threads', () => {
    expect(groupThreadsByDate([], now)).toEqual([]);
  });
});
