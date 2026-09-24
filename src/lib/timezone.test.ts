import { describe, it, expect } from 'vitest';
import { isTimezone } from './timezone';

describe('isTimezone', () => {
  it('accepts an IANA zone name and UTC', () => {
    expect(isTimezone('Europe/Helsinki')).toBe(true);
    expect(isTimezone('UTC')).toBe(true);
  });

  it('rejects a name no date can be computed in', () => {
    expect(isTimezone('Nope/Zone')).toBe(false);
    expect(isTimezone('')).toBe(false);
  });
});
