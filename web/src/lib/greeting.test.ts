import { describe, it, expect } from 'vitest';
import { greetingFor } from './greeting';

const at = (hour: number) => new Date(2026, 8, 24, hour, 30);

describe('greetingFor', () => {
  it('greets by the local hour', () => {
    expect(greetingFor(at(7))).toBe('Good morning');
    expect(greetingFor(at(11))).toBe('Good morning');
    expect(greetingFor(at(12))).toBe('Good afternoon');
    expect(greetingFor(at(17))).toBe('Good afternoon');
    expect(greetingFor(at(18))).toBe('Good evening');
    expect(greetingFor(at(23))).toBe('Good evening');
  });

  it('treats the small hours as evening', () => {
    expect(greetingFor(at(2))).toBe('Good evening');
  });
});
