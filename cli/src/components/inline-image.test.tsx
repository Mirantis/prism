import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import type { Bitmap } from '../images/bitmap.js';
import type { AttachmentMeta } from '../attachments.js';

const loadAttachmentImage = vi.fn<(a: AttachmentMeta) => Promise<Bitmap>>();
vi.mock('../images/attachment-images.js', () => ({ loadAttachmentImage: (a: AttachmentMeta) => loadAttachmentImage(a) }));

const { InlineImage } = await import('./inline-image.js');

const ID = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const attachment: AttachmentMeta = {
  id: ID,
  filename: 'chart.png',
  mediaType: 'image/png',
  sizeBytes: 120,
  category: 'image',
  inline: true,
};
const cell = { width: 2, height: 4 };

/** Four pixels wide, four tall: red over blue. */
function redOverBlue(): Bitmap {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set(i < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
  return { width: 4, height: 4, data };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('InlineImage', () => {
  beforeEach(() => {
    loadAttachmentImage.mockReset();
    loadAttachmentImage.mockResolvedValue(redOverBlue());
  });

  it('stores the picture in the terminal and draws its placeholders', async () => {
    const { stdout, unmount } = render(
      <InlineImage href={`attachment:${ID}`} alt="chart" attachments={[attachment]} cell={cell} maxCols={40} maxRows={10} />,
    );
    await settle();
    const transmission = stdout.frames.find((f) => f.startsWith('\x1b_G'));
    expect(transmission).toMatch(/^\x1b_Ga=T,U=1,i=(\d+),c=2,r=1,f=32,s=4,v=4,o=z,q=2,m=0;/);
    const id = Number(/i=(\d+)/.exec(transmission!)![1]);
    const color = `\x1b[38;2;${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}m`;
    // The transmission goes straight to the terminal; the frames Ink draws are the rest.
    const frame = stdout.frames.filter((f) => !f.startsWith('\x1b_G')).at(-1);
    expect(frame).toContain(`${color}\u{10EEEE}̅̅\u{10EEEE}`);
    unmount();
  });

  it('reads as its description until the picture is ready', () => {
    loadAttachmentImage.mockReturnValue(new Promise(() => undefined));
    const { lastFrame, unmount } = render(
      <InlineImage href={`attachment:${ID}`} alt="chart" attachments={[attachment]} cell={cell} maxCols={40} maxRows={10} />,
    );
    expect(lastFrame()).toContain('[image: chart]');
    unmount();
  });

  it('says an expired image is expired', async () => {
    const { lastFrame, unmount } = render(
      <InlineImage
        href={`attachment:${ID}`}
        alt="chart"
        attachments={[{ ...attachment, expired: true }]}
        cell={cell}
        maxCols={40}
        maxRows={10}
      />,
    );
    await settle();
    expect(lastFrame()).toContain('[image: chart · expired]');
    expect(loadAttachmentImage).not.toHaveBeenCalled();
    unmount();
  });

  it('draws only an image the message holds as inline', async () => {
    const { lastFrame, unmount } = render(
      <InlineImage
        href={`attachment:${ID}`}
        alt="chart"
        attachments={[{ ...attachment, inline: false }]}
        cell={cell}
        maxCols={40}
        maxRows={10}
      />,
    );
    await settle();
    expect(lastFrame()).toContain('[image: chart]');
    expect(loadAttachmentImage).not.toHaveBeenCalled();
    unmount();
  });
});
