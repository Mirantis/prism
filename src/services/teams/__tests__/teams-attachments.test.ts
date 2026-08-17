/**
 * Teams attachments — which URL each kind of file is read from, with which
 * credential, and what a failed read turns into. The credential routing is the
 * security-relevant part: the bot's token and the Graph token each go to their
 * own hosts only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, mockTrackEvent } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('../../attachment.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attachment.service')>()),
  attachmentService: { create: mockCreate },
}));
vi.mock('../../../lib/telemetry', () => ({ trackEvent: mockTrackEvent }));

import {
  buildFileFailureNotice,
  describeSharedFiles,
  readInboundFiles,
  TeamsFileTooLargeError,
  TeamsFileFetchers,
} from '../teams-attachments';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function fetchers(bytes: Buffer = PNG): { [K in keyof TeamsFileFetchers]: ReturnType<typeof vi.fn> } {
  return {
    bot: vi.fn().mockResolvedValue(bytes),
    graph: vi.fn().mockResolvedValue(bytes),
    plain: vi.fn().mockResolvedValue(bytes),
  };
}

const PERSONAL_FILE = {
  contentType: 'application/vnd.microsoft.teams.file.download.info',
  contentUrl: 'https://contoso-my.sharepoint.com/personal/jane/Documents/Applications/report.txt',
  name: 'report.txt',
  content: { downloadUrl: 'https://contoso-my.sharepoint.com/download?token=abc', fileType: 'txt' },
};

const CHANNEL_FILE = {
  contentType: 'reference',
  contentUrl: 'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/General/plan.docx',
  name: 'plan.docx',
};

describe('readInboundFiles', () => {
  beforeEach(() => {
    let n = 0;
    mockCreate.mockImplementation(async () => ({ id: `att-${++n}` }));
  });

  it('reads a personal-chat file from its download URL with no credential', async () => {
    const f = fetchers(Buffer.from('hello'));

    const result = await readInboundFiles([PERSONAL_FILE], f, { threadId: 'thread-1' });

    expect(f.plain).toHaveBeenCalledWith('https://contoso-my.sharepoint.com/download?token=abc');
    expect(f.bot).not.toHaveBeenCalled();
    expect(f.graph).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'report.txt', source: 'teams', threadId: 'thread-1', sizeBytes: 5 })
    );
    expect(result).toEqual({ attachmentIds: ['att-1'], failures: [], names: ['report.txt'] });
  });

  it('refuses a download URL outside SharePoint', async () => {
    const f = fetchers();

    const result = await readInboundFiles(
      [{ ...PERSONAL_FILE, content: { downloadUrl: 'https://attacker.example/x' } }],
      f,
      {}
    );

    expect(f.plain).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      { filename: 'report.txt', reason: 'Teams sent no download address for it' },
    ]);
  });

  it('reads a pasted image from the Bot Framework attachment service with the bot token', async () => {
    const f = fetchers();
    const url = 'https://smba.trafficmanager.net/emea/v3/attachments/0-weu-d1/views/original';

    const result = await readInboundFiles([{ contentType: 'image/*', contentUrl: url }], f, {});

    expect(f.bot).toHaveBeenCalledWith(url);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'image-1', mediaType: 'image/png', category: 'image' })
    );
    expect(result.attachmentIds).toEqual(['att-1']);
  });

  it('reads a hosted image from the HTML body with the Graph token, once per URL', async () => {
    const f = fetchers();
    const src =
      'https://graph.microsoft.com/v1.0/teams/t1/channels/c1/messages/m1/hostedContents/h1/$value';

    await readInboundFiles(
      [
        { contentType: 'image/*', contentUrl: src },
        { contentType: 'text/html', content: `<p>look</p><img alt="x" src="${src}" itemtype="img">` },
      ],
      f,
      {}
    );

    expect(f.graph).toHaveBeenCalledTimes(1);
    expect(f.graph).toHaveBeenCalledWith(src);
    expect(f.bot).not.toHaveBeenCalled();
  });

  it('sends no credential to an image on any other host', async () => {
    const f = fetchers();

    const result = await readInboundFiles(
      [
        { contentType: 'image/png', contentUrl: 'https://attacker.example/i.png' },
        { contentType: 'text/html', content: '<img src="https://graph.microsoft.com/v1.0/me/photo/$value">' },
      ],
      f,
      {}
    );

    expect(f.bot).not.toHaveBeenCalled();
    expect(f.graph).not.toHaveBeenCalled();
    expect(result).toEqual({ attachmentIds: [], failures: [], names: [] });
  });

  it('reads a channel file through the Graph shares API', async () => {
    const f = fetchers(Buffer.from('doc'));

    await readInboundFiles([CHANNEL_FILE], f, {});

    const encoded = Buffer.from(CHANNEL_FILE.contentUrl).toString('base64url');
    expect(f.graph).toHaveBeenCalledWith(
      `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem/content`
    );
  });

  it('turns a refused channel-file read into a failure that names the admin permission', async () => {
    const f = fetchers();
    f.graph.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));

    const result = await readInboundFiles([CHANNEL_FILE], f, {});

    expect(result.attachmentIds).toEqual([]);
    expect(result.names).toEqual(['plan.docx']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].filename).toBe('plan.docx');
    expect(result.failures[0].reason).toContain('Files.Read.All');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'teams attachment failed',
      null,
      expect.objectContaining({ 'attachment.kind': 'channel_file', 'failure.reason': 'permission' })
    );
  });

  it('reports an oversized and an empty download as failures', async () => {
    const f = fetchers();
    f.plain.mockRejectedValueOnce(new TeamsFileTooLargeError());
    f.bot.mockResolvedValueOnce(Buffer.alloc(0));

    const result = await readInboundFiles(
      [
        PERSONAL_FILE,
        { contentType: 'image/*', contentUrl: 'https://smba.trafficmanager.net/emea/v3/attachments/a' },
      ],
      f,
      {}
    );

    expect(result.failures).toEqual([
      { filename: 'report.txt', reason: 'it exceeds the 10 MB limit' },
      { filename: 'image-1', reason: 'it downloaded as an empty file' },
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('never puts a file name or URL in the failure event', async () => {
    const f = fetchers();
    f.graph.mockRejectedValue(new Error('boom'));

    await readInboundFiles([CHANNEL_FILE], f, {});

    const props = JSON.stringify(mockTrackEvent.mock.calls[0][2]);
    expect(props).not.toContain('plan.docx');
    expect(props).not.toContain('sharepoint');
  });
});

describe('buildFileFailureNotice', () => {
  it('tells the agent what failed and not to claim nothing was attached', () => {
    const notice = buildFileFailureNotice([{ filename: 'plan.docx', reason: 'no permission' }]);

    expect(notice).toContain('"plan.docx": no permission');
    expect(notice).toContain('Do not say no file was attached');
  });
});

describe('describeSharedFiles', () => {
  it('names one file or several', () => {
    expect(describeSharedFiles(['a.txt'])).toBe('(shared a file: a.txt)');
    expect(describeSharedFiles(['a.txt', 'b.png'])).toBe('(shared files: a.txt, b.png)');
  });
});
