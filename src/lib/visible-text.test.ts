import { describe, expect, it } from 'vitest';
import { visibleText } from './visible-text';

describe('visibleText', () => {
  it('trims text a reader can see', () => {
    expect(visibleText('  Deployed.\n')).toBe('Deployed.');
  });

  it('is empty for whitespace and format characters alone', () => {
    expect(visibleText('')).toBe('');
    expect(visibleText(' \n\t')).toBe('');
    expect(visibleText('​')).toBe('');
    expect(visibleText(' ‌‍⁠﻿­ ')).toBe('');
  });

  it('keeps format characters inside visible text', () => {
    expect(visibleText('​done​')).toBe('​done​');
    expect(visibleText('👩‍💻')).toBe('👩‍💻');
  });
});
