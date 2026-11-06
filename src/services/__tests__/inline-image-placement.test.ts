import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { placeInlineImages } from '../inline-image-placement';
import { attachmentService } from '../attachment.service';

// The PNG signature is what classifies a file as an image.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const SHARED = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const EARLIER = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const CREATED = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

type Row = Awaited<ReturnType<typeof attachmentService.getById>>;

describe('placeInlineImages', () => {
  let workspace: string;
  let create: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-images-test-'));
    create = vi
      .spyOn(attachmentService, 'create')
      .mockImplementation(async (input) => ({ id: CREATED, ...input }) as unknown as NonNullable<Row>);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const place = (text: string, shared: string[] = []) =>
    placeInlineImages(text, { threadId: 'thread-1', workspaceRoot: workspace, shared });

  it('stores an image a relative path names and names it by its attachment', async () => {
    await fs.mkdir(path.join(workspace, 'out'));
    await fs.writeFile(path.join(workspace, 'out', 'euribor.png'), PNG);

    const placed = await place('Rates:\n\n![Euribor](out/euribor.png)\n\nThey fell.');

    expect(placed).toEqual({
      content: `Rates:\n\n![Euribor](attachment:${CREATED})\n\nThey fell.`,
      attachmentIds: [CREATED],
      missed: 0,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'euribor.png', mediaType: 'image/png', category: 'image', source: 'agent' }),
    );
  });

  it('reads an absolute path outside the workspace', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-images-elsewhere-'));
    await fs.writeFile(path.join(elsewhere, 'plot.png'), PNG);

    const placed = await place(`![plot](${path.join(elsewhere, 'plot.png')})`);
    await fs.rm(elsewhere, { recursive: true, force: true });

    expect(placed.attachmentIds).toEqual([CREATED]);
  });

  it('stores a file once when the text shows it twice', async () => {
    await fs.writeFile(path.join(workspace, 'a.png'), PNG);

    const placed = await place('![one](a.png) and ![again](a.png)');

    expect(create).toHaveBeenCalledTimes(1);
    expect(placed.content).toBe(`![one](attachment:${CREATED}) and ![again](attachment:${CREATED})`);
  });

  it('leaves a path that holds no image as written, and counts it', async () => {
    await fs.writeFile(path.join(workspace, 'data.csv'), 'a,b\n1,2\n');
    const text = '![table](data.csv) ![gone](missing.png) ![remote](https://example.com/a.png)';

    const placed = await place(text);

    expect(placed).toEqual({ content: text, attachmentIds: [], missed: 3 });
    expect(create).not.toHaveBeenCalled();
  });

  it('places an image this turn shared without storing it again', async () => {
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: SHARED, threadId: null, filename: 'chart.png', mediaType: 'image/png',
    } as NonNullable<Row>);

    const placed = await place(`![chart](attachment:${SHARED})`, [SHARED]);

    expect(placed).toEqual({ content: `![chart](attachment:${SHARED})`, attachmentIds: [SHARED], missed: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves a shared file that is not an image to be attached', async () => {
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: SHARED, threadId: null, filename: 'data.csv', mediaType: 'text/csv',
    } as NonNullable<Row>);

    const placed = await place(`![data](attachment:${SHARED})`, [SHARED]);

    expect(placed).toEqual({ content: `![data](attachment:${SHARED})`, attachmentIds: [], missed: 1 });
  });

  it('copies an image another message of this thread holds', async () => {
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: EARLIER, threadId: 'thread-1', filename: 'upload.png', mediaType: 'image/png',
    } as NonNullable<Row>);
    vi.spyOn(attachmentService, 'loadBytes').mockResolvedValue(PNG);

    const placed = await place(`![your photo](attachment:${EARLIER})`);

    expect(placed.content).toBe(`![your photo](attachment:${CREATED})`);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ filename: 'upload.png', category: 'image' }));
  });

  it('refuses an image another thread holds', async () => {
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: EARLIER, threadId: 'thread-2', filename: 'private.png', mediaType: 'image/png',
    } as NonNullable<Row>);

    const placed = await place(`![x](attachment:${EARLIER})`);

    expect(placed.missed).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });
});
