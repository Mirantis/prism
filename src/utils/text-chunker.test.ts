import { describe, it, expect } from 'vitest';
import { splitContent, splitLongText } from './text-chunker';

describe('splitContent', () => {
  it('keeps short content as a single chunk', () => {
    expect(splitContent('hello world', 100)).toEqual(['hello world']);
  });

  it('splits at paragraph boundaries', () => {
    const para1 = 'a'.repeat(60);
    const para2 = 'b'.repeat(60);
    expect(splitContent(`${para1}\n\n${para2}`, 100)).toEqual([para1, para2]);
  });

  it('packs paragraphs that fit together into one chunk', () => {
    const chunks = splitContent('one\n\ntwo\n\nthree', 100);
    expect(chunks).toEqual(['one\n\ntwo\n\nthree']);
  });

  it('splits an over-long paragraph at a sentence boundary', () => {
    const text = `${'x'.repeat(70)}. ${'y'.repeat(50)}`;
    const chunks = splitContent(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith('.')).toBe(true);
  });

  it('drops nothing: chunks re-join to the original words', () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const joined = splitContent(text, 40).join(' ');
    expect(joined.split(/\s+/)).toEqual(text.split(/\s+/));
  });
});

describe('splitLongText', () => {
  it('hard-splits text with no natural boundaries', () => {
    const text = 'z'.repeat(250);
    const chunks = splitLongText(text, 100);
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(text);
  });

  it('never emits a chunk longer than maxLength, hard split included', () => {
    const hard = splitLongText('z'.repeat(250), 100);
    for (const chunk of hard) expect(chunk.length).toBeLessThanOrEqual(100);

    // A sentence boundary landing exactly on maxLength must not overshoot.
    const boundary = splitLongText(`${'a'.repeat(99)}. ${'b'.repeat(50)}`, 100);
    for (const chunk of boundary) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('prefers a newline over a mid-word split', () => {
    const text = `${'a'.repeat(80)}\n${'b'.repeat(80)}`;
    const chunks = splitLongText(text, 100);
    expect(chunks[0]).toBe('a'.repeat(80));
  });
});
