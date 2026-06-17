import { describe, it, expect } from 'vitest';
import { deriveThreadTitle } from './thread-title';

describe('deriveThreadTitle', () => {
  it('takes the first three words', () => {
    expect(deriveThreadTitle('one two three four five')).toBe('one two three');
  });

  it('keeps a short message verbatim', () => {
    expect(deriveThreadTitle('hello there')).toBe('hello there');
  });

  it('collapses extra whitespace and trims', () => {
    expect(deriveThreadTitle('   one   two  three   four ')).toBe('one two three');
  });

  it('truncates the first three words to at most 24 chars with an ellipsis', () => {
    const title = deriveThreadTitle('migrate the authentication layer');
    // First three words "migrate the authentication" is 26 chars → truncated.
    expect(title.endsWith('...')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(24);
    expect(title.startsWith('migrate the authent')).toBe(true);
  });

  it('does not add an ellipsis when the first three words fit', () => {
    expect(deriveThreadTitle('alpha beta gamma')).toBe('alpha beta gamma');
    expect(deriveThreadTitle('alpha beta gamma').includes('...')).toBe(false);
  });

  it('trims a trailing space before the ellipsis', () => {
    // First three words exceed 24 but the cut would land on a space.
    const title = deriveThreadTitle('aaaaaaaaaaaaaaaaaaaa bb cccccccc');
    expect(title).not.toContain(' ...');
    expect(title.length).toBeLessThanOrEqual(24);
  });

  it('returns an empty string for empty / whitespace-only content', () => {
    expect(deriveThreadTitle('')).toBe('');
    expect(deriveThreadTitle('   ')).toBe('');
  });
});
