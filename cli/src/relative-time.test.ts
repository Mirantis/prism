import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './relative-time.js';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  // Mid-bucket offsets avoid flakiness at exact unit boundaries.
  it('renders "just now" under a minute', () => {
    expect(formatRelativeTime(Date.now() - 30 * SEC)).toBe('just now');
  });

  it('renders singular and plural minutes', () => {
    expect(formatRelativeTime(Date.now() - 1.5 * MIN)).toBe('1 minute ago');
    expect(formatRelativeTime(Date.now() - 53.5 * MIN)).toBe('53 minutes ago');
  });

  it('renders singular and plural hours', () => {
    expect(formatRelativeTime(Date.now() - 1 * HOUR - MIN)).toBe('1 hour ago');
    expect(formatRelativeTime(Date.now() - 2 * HOUR - MIN)).toBe('2 hours ago');
  });

  it('renders singular and plural days', () => {
    expect(formatRelativeTime(Date.now() - 1 * DAY - HOUR)).toBe('1 day ago');
    expect(formatRelativeTime(Date.now() - 3 * DAY - HOUR)).toBe('3 days ago');
  });

  it('accepts an ISO-string timestamp', () => {
    expect(formatRelativeTime(new Date(Date.now() - 1.5 * MIN).toISOString())).toBe(
      '1 minute ago',
    );
  });

  it('returns "unknown" for an unparseable timestamp', () => {
    expect(formatRelativeTime('not-a-date')).toBe('unknown');
  });
});
