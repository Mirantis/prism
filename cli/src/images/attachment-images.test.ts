import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentMeta } from '../attachments.js';

const download = vi.fn<(id: string) => Promise<Buffer>>();
vi.mock('../api-client.js', () => ({ apiClient: { downloadAttachment: (id: string) => download(id) } }));
// A picture of 2048 × 2048 RGBA without the pixels: only the size counts here.
vi.mock('./decode-image.js', () => ({
  decodeImage: async () => ({ width: 2048, height: 2048, data: { byteLength: 2048 * 2048 * 4 } }),
}));

const { CACHE_BYTES, clearAttachmentImages, loadAttachmentImage } = await import('./attachment-images.js');

const attachment = (id: string): AttachmentMeta => ({ id, mediaType: 'image/png', inline: true }) as AttachmentMeta;

describe('loadAttachmentImage', () => {
  beforeEach(() => {
    clearAttachmentImages();
    download.mockReset();
    download.mockResolvedValue(Buffer.from([]));
  });

  it('loads an attachment once while it is kept', async () => {
    await loadAttachmentImage(attachment('a'));
    await loadAttachmentImage(attachment('a'));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('tries a failed download again on the next load', async () => {
    download.mockRejectedValueOnce(new Error('503'));
    await expect(loadAttachmentImage(attachment('a'))).rejects.toThrow('503');
    await expect(loadAttachmentImage(attachment('a'))).resolves.toMatchObject({ width: 2048 });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('drops the least recently used picture past the byte budget', async () => {
    const fit = CACHE_BYTES / (2048 * 2048 * 4);
    for (let i = 0; i < fit; i++) await loadAttachmentImage(attachment(`p${i}`));
    await loadAttachmentImage(attachment('p0')); // p0 is now the most recently used
    await loadAttachmentImage(attachment('new'));
    download.mockClear();
    await loadAttachmentImage(attachment('p0'));
    expect(download).not.toHaveBeenCalled();
    await loadAttachmentImage(attachment('p1'));
    expect(download).toHaveBeenCalledWith('p1');
  });
});
