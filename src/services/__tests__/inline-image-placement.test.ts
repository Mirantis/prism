import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { placeInlineImages, placeReplyImages } from '../inline-image-placement';
import { attachmentService } from '../attachment.service';
import * as environments from '../../lib/execution-environments/get-execution-environment';

// Pass-through, so a test can see which filesystem a path is read through.
vi.mock('../../lib/execution-environments/get-execution-environment', async (importOriginal) => {
  const actual = await importOriginal<typeof environments>();
  return { ...actual, filesFor: vi.fn(actual.filesFor) };
});

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

  it('refuses a path outside the workspace, as share_file does', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-images-elsewhere-'));
    await fs.writeFile(path.join(elsewhere, 'plot.png'), PNG);
    const text = `![plot](${path.join(elsewhere, 'plot.png')}) ![up](../${path.basename(elsewhere)}/plot.png)`;

    const placed = await place(text);
    await fs.rm(elsewhere, { recursive: true, force: true });

    expect(placed).toEqual({ content: text, attachmentIds: [], missed: 2 });
    expect(create).not.toHaveBeenCalled();
  });

  it('reads an absolute path inside the workspace through the filesystem that holds that path', async () => {
    await fs.writeFile(path.join(workspace, 'plot.png'), PNG);
    const full = path.join(workspace, 'plot.png');

    const placed = await place(`![plot](${full})`);

    expect(placed.attachmentIds).toEqual([CREATED]);
    expect(environments.filesFor).toHaveBeenCalledWith(full);
  });

  it('places a file this turn shared by its path as that attachment, not a second copy', async () => {
    await fs.writeFile(path.join(workspace, 'chart.png'), PNG);
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: SHARED, threadId: null, messageId: null, filename: 'chart.png', mediaType: 'image/png', sizeBytes: PNG.length,
    } as NonNullable<Row>);
    vi.spyOn(attachmentService, 'loadBytes').mockResolvedValue(PNG);

    const placed = await place('![chart](chart.png)', [SHARED]);

    expect(placed).toEqual({ content: `![chart](attachment:${SHARED})`, attachmentIds: [SHARED], missed: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves the reference as written when storing the image fails', async () => {
    await fs.writeFile(path.join(workspace, 'chart.png'), PNG);
    create.mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));

    const placed = await place('Rates: ![chart](chart.png)');

    expect(placed).toEqual({ content: 'Rates: ![chart](chart.png)', attachmentIds: [], missed: 1 });
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

  it('copies a shared image a message already holds, so this reply gets its own', async () => {
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: SHARED, threadId: 'thread-1', messageId: 'msg-earlier', filename: 'chart.png', mediaType: 'image/png',
    } as NonNullable<Row>);
    vi.spyOn(attachmentService, 'loadBytes').mockResolvedValue(PNG);

    const placed = await place(`![chart](attachment:${SHARED})`, [SHARED]);

    expect(placed.attachmentIds).toEqual([CREATED]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ filename: 'chart.png' }));
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

describe('placeReplyImages', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'inline-images-reply-'));
    vi.spyOn(attachmentService, 'create').mockImplementation(
      async (input) => ({ id: CREATED, ...input }) as unknown as NonNullable<Row>,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("places a goal or scheduled reply's images from the run's workspace, ahead of its other files", async () => {
    await fs.writeFile(path.join(workspace, 'signups.png'), PNG);
    vi.spyOn(attachmentService, 'getById').mockResolvedValue({
      id: 'att-csv', threadId: null, messageId: null, filename: 'signups.csv', mediaType: 'text/csv', sizeBytes: 9,
    } as NonNullable<Row>);

    const placed = await placeReplyImages('thread-1', '![Sign-ups](signups.png)', ['att-csv'], workspace);

    expect(placed).toEqual({ content: `![Sign-ups](attachment:${CREATED})`, attachmentIds: [CREATED, 'att-csv'] });
  });
});
