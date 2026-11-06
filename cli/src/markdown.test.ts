import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

const ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';

describe('renderMarkdown', () => {
  it('shows an image a message places as its description, at its place in the text', () => {
    const out = renderMarkdown(`Rates fell.\n\n![Euribor, past year](attachment:${ID})\n\nThey bottomed in May.`, 80);
    const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines).toEqual(['Rates fell.', '[image: Euribor, past year]', 'They bottomed in May.']);
  });
});
