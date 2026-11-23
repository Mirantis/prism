import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMessageParts, type MessagePart } from './markdown.js';

const ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const HREF = `attachment:${ID}`;

/** The parts with color codes removed, as a reader sees them. */
function seen(parts: MessagePart[]): MessagePart[] {
  return parts.map((part) => (part.kind === 'text' ? { kind: 'text', text: stripVTControlCharacters(part.text) } : part));
}

describe('renderMarkdown', () => {
  it('keeps the description of an image inside its line', () => {
    expect(stripVTControlCharacters(renderMarkdown(`See ![chart](${HREF}) for May.`, 80))).toBe('See [image: chart] for May.');
  });

  it('shows an image a message places as its description, at its place in the text', () => {
    const out = renderMarkdown(`Rates fell.\n\n![Euribor, past year](${HREF})\n\nThey bottomed in May.`, 80);
    const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines).toEqual(['Rates fell.', '[image: Euribor, past year]', 'They bottomed in May.']);
  });

  it('keeps text that already holds the marker characters, without them', () => {
    expect(stripVTControlCharacters(renderMarkdown('see \uE0005\uE001 here', 80))).toBe('see 5 here');
  });

  it('shows an image in a list item as its description', () => {
    const out = stripVTControlCharacters(renderMarkdown(`- first\n- ![chart](${HREF})`, 80));
    expect(out).toContain('[image: chart]');
    expect(out).not.toContain('attachment:');
  });
});

describe('renderMessageParts', () => {
  it('splits the text around an image block, keeping the blank lines between', () => {
    const parts = renderMessageParts(`Rates fell.\n\n![Euribor, past year](${HREF})\n\nThey bottomed in May.`, 80);
    expect(seen(parts)).toEqual([
      { kind: 'text', text: 'Rates fell.\n' },
      { kind: 'image', href: HREF, alt: 'Euribor, past year' },
      { kind: 'text', text: '\nThey bottomed in May.' },
    ]);
  });

  it('puts the text beside an image in a line above and below it', () => {
    const parts = renderMessageParts(`See ![chart](${HREF}) for **May**.`, 80);
    expect(seen(parts)).toEqual([
      { kind: 'text', text: 'See' },
      { kind: 'image', href: HREF, alt: 'chart' },
      { kind: 'text', text: 'for May.' },
    ]);
  });

  it('finds an image in a list item', () => {
    const parts = renderMessageParts(`- first\n- ![chart](${HREF})\n- last`, 80);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'image', 'text']);
  });

  it('leaves an image from anywhere else as written', () => {
    const parts = renderMessageParts('![logo](https://example.com/logo.png)', 80);
    expect(seen(parts)).toEqual([{ kind: 'text', text: '![logo](https://example.com/logo.png)' }]);
  });

  it('keeps text that already holds the marker characters as text, so no image part lacks its picture', () => {
    expect(seen(renderMessageParts('see \uE0005\uE001 here', 80))).toEqual([{ kind: 'text', text: 'see 5 here' }]);
  });

  it('draws a placed image once when the text also holds a marker for it', () => {
    const parts = renderMessageParts(`\uE0000\uE001 ![chart](${HREF})`, 80);
    expect(parts.filter((p) => p.kind === 'image')).toHaveLength(1);
  });

  it('keeps image syntax inside code as written', () => {
    const parts = seen(renderMessageParts(`Write \`![chart](${HREF})\`:\n\n\`\`\`md\n![chart](${HREF})\n\`\`\``, 80));
    expect(parts.every((p) => p.kind === 'text')).toBe(true);
    expect(parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n').match(/!\[chart\]/g)).toHaveLength(2);
  });

  it('keeps image syntax inside code spans and escaped images in a list item as written', () => {
    const parts = seen(renderMessageParts(`- \`![x](${HREF})\` and \\![y](${HREF})\n- **![chart](${HREF})**`, 80));
    expect(parts.filter((p) => p.kind === 'image')).toEqual([{ kind: 'image', href: HREF, alt: 'chart' }]);
    const text = parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n');
    expect(text).toContain(`![x](${HREF})`);
  });

  it('shows an image in a table cell as its description, keeping the table whole', () => {
    const parts = seen(renderMessageParts(`| Month | Chart |\n|---|---|\n| May | ![c](${HREF}) |`, 80));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.kind === 'text' && parts[0]!.text).toContain('[image: c]');
  });
});
