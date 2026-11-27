import { describe, it, expect } from 'vitest';
import { wordLeft, wordRight } from './cursor-motion.js';

describe('word moves', () => {
  it('keep a combining accent with its letter', () => {
    const value = 'cafe\u0301 menu';
    expect(wordRight(value, 0)).toBe(5);
    expect(wordLeft(value, 5)).toBe(0);
  });

  it('move over a Devanagari word as one word', () => {
    const word = 'हिन्दी';
    const value = `${word} भाषा`;
    expect(wordRight(value, 0)).toBe(word.length);
    expect(wordLeft(value, word.length)).toBe(0);
  });
});
