import { describe, it, expect } from 'vitest';
import {
  attachmentImage,
  attachmentRefId,
  findImageRefs,
  isLocalPath,
  placeAttachments,
  replaceImageRefs,
} from './inline-images';

const ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const OTHER = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

describe('findImageRefs', () => {
  it('finds each image with its alt text, target and offsets, in order', () => {
    const content = `Rates fell.\n\n![Euribor, past year](charts/euribor.png)\n\nThen ![b](attachment:${ID}) too.`;
    const refs = findImageRefs(content);
    expect(refs.map((r) => [r.alt, r.target])).toEqual([
      ['Euribor, past year', 'charts/euribor.png'],
      ['b', `attachment:${ID}`],
    ]);
    expect(content.slice(refs[0].start, refs[0].end)).toBe('![Euribor, past year](charts/euribor.png)');
  });

  it('reads an angle-bracket target with spaces and ignores a title', () => {
    const refs = findImageRefs('![chart](</work/my chart.png> "Rates")');
    expect(refs.map((r) => r.target)).toEqual(['/work/my chart.png']);
  });

  it('skips an escaped image, which the renderer shows as text', () => {
    const content = `\\![chart](attachment:${ID}) and \\\\![real](d.png)`;
    expect(findImageRefs(content).map((r) => r.target)).toEqual(['d.png']);
  });

  it('skips an image in an indented code block but not in a list item or a continued paragraph', () => {
    const content = [
      '    ![at the start](a.png)',
      '',
      'Example:',
      '',
      `    ![indented](attachment:${ID})`,
      '    more code',
      '',
      'A paragraph',
      '    ![continued](b.png)',
      '',
      '- an item',
      '',
      '    ![in the item](c.png)',
      '',
      'Done.',
      '',
      '\t![tab](e.png)',
    ].join('\n');
    expect(findImageRefs(content).map((r) => r.target)).toEqual(['b.png', 'c.png']);
    expect(placeAttachments(content, [{ id: ID, category: 'image' }])).toEqual([{ id: ID, category: 'image' }]);
  });

  it('skips images inside fenced code blocks and inline code', () => {
    const content = [
      '```markdown',
      '![in a fence](a.png)',
      '```',
      'Write `![inline](b.png)` to place one.',
      '~~~',
      '![tilde fence](c.png)',
      '~~~',
      '![real](d.png)',
    ].join('\n');
    expect(findImageRefs(content).map((r) => r.target)).toEqual(['d.png']);
  });

  it('treats an unclosed fence as code to the end', () => {
    expect(findImageRefs('```\n![x](a.png)')).toEqual([]);
  });

  it('ignores a link that is not an image', () => {
    expect(findImageRefs('[report](report.pdf)')).toEqual([]);
  });
});

describe('targets', () => {
  it('reads an attachment id only from a well-formed reference', () => {
    expect(attachmentRefId(`attachment:${ID}`)).toBe(ID);
    expect(attachmentRefId('attachment:not-an-id')).toBeNull();
    expect(attachmentRefId('chart.png')).toBeNull();
  });

  it('tells a path on the agent filesystem from a URL', () => {
    expect(isLocalPath('chart.png')).toBe(true);
    expect(isLocalPath('/home/node/out/chart.png')).toBe(true);
    expect(isLocalPath('https://example.com/a.png')).toBe(false);
    expect(isLocalPath('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalPath(`attachment:${ID}`)).toBe(false);
  });
});

describe('replaceImageRefs', () => {
  it('swaps the references it answers for and keeps the rest of the text', () => {
    const content = 'A ![one](a.png) B ![two](b.png) C';
    const refs = findImageRefs(content);
    const out = replaceImageRefs(content, refs, (ref) => (ref.target === 'a.png' ? attachmentImage(ref.alt, ID) : null));
    expect(out).toBe(`A ![one](attachment:${ID}) B ![two](b.png) C`);
  });
});

describe('placeAttachments', () => {
  const image = { id: ID, category: 'image' };
  const pdf = { id: OTHER, category: 'pdf' };

  it('marks each image the text references as inline', () => {
    expect(placeAttachments(`See ![chart](attachment:${ID})`, [image, pdf])).toEqual([{ ...image, inline: true }, pdf]);
  });

  it('keeps a file that is not an image under the text, even when the text references it', () => {
    expect(placeAttachments(`![brief](attachment:${OTHER})`, [pdf])).toEqual([pdf]);
  });

  it('places nothing for a reference written as code', () => {
    expect(placeAttachments(`\`![chart](attachment:${ID})\``, [image])).toEqual([image]);
  });
});
