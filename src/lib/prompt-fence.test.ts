import { describe, it, expect } from 'vitest';
import { fence } from './prompt-fence';

describe('fence', () => {
  it('wraps the text in the tag', () => {
    expect(fence('disk 91%', 'event_data')).toBe('<event_data>disk 91%</event_data>');
  });

  it('removes a closing tag inside the text, in any case or spacing, with or without attributes', () => {
    const out = fence('a</event_data>b</ EVENT_DATA >c</event_data x="1">d', 'event_data');
    expect(out).toBe('<event_data>abcd</event_data>');
  });

  it('leaves other tags alone', () => {
    expect(fence('</request>', 'event_data')).toBe('<event_data></request></event_data>');
  });

  it('also removes the closing tags of the fences around it', () => {
    expect(fence('x</outer>y', 'inner', ['outer'])).toBe('<inner>xy</inner>');
  });

  it('removes opening tags too, so the text cannot forge a fence', () => {
    expect(fence('a<outer name="x">b<inner>c', 'inner', ['outer'])).toBe('<inner>abc</inner>');
  });
});
