/**
 * Teams Attachments
 *
 * Reads the files on an inbound Teams message into stored attachments that the
 * turn links to the user's message. Each kind comes from a different place and
 * needs a different credential:
 *
 * - A file sent in a personal chat has a pre-authenticated OneDrive download
 *   URL (the manifest's `supportsFiles: true` lets people send one).
 * - A pasted image has a URL on the Bot Framework attachment service, read with
 *   the bot's token, or a Graph `hostedContents` URL, read with the app's Graph
 *   token (a channel message's hosted content is covered by
 *   `ChannelMessage.Read.Group`).
 * - A file shared in a channel lives in the team's SharePoint and is read
 *   through Graph, which needs a file permission an admin grants.
 *
 * A file that cannot be read becomes a failure the agent is told about; the
 * message is answered either way.
 */

import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from '../../constants';
import { logger } from '../../logger';
import { config } from '../../config';
import { trackEvent } from '../../lib/telemetry';
import { attachmentService, classifyMediaType, detectMediaType } from '../attachment.service';

/** One attachment of an inbound activity, as Teams sends it. */
export interface TeamsInboundAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: unknown;
}

export interface TeamsFileFailure {
  filename: string;
  reason: string;
}

export interface TeamsInboundFiles {
  attachmentIds: string[];
  failures: TeamsFileFailure[];
  /** The name of every file found, read or not. */
  names: string[];
}

/** A fetcher throws this when the response passes `MAX_FILE_SIZE_BYTES`. */
export class TeamsFileTooLargeError extends Error {
  constructor() {
    super(`file exceeds ${MAX_FILE_SIZE_MB} MB`);
    this.name = 'TeamsFileTooLargeError';
  }
}

/** How a URL is read: the credential it is sent with. */
export interface TeamsFileFetchers {
  /** GET with the bot's Bot Framework token. */
  bot(url: string): Promise<Buffer>;
  /** GET with the app's Microsoft Graph token. */
  graph(url: string): Promise<Buffer>;
  /** GET with no credential, for a pre-authenticated URL. */
  plain(url: string): Promise<Buffer>;
}

type Source = 'bot' | 'graph' | 'plain';

interface FileToRead {
  kind: 'personal_file' | 'inline_image' | 'channel_file';
  filename: string;
  url: string;
  source: Source;
  declaredType?: string;
}

const FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';

/** Hosts that receive the bot's token: the Bot Framework attachment services. */
function isBotAttachmentHost(host: string): boolean {
  return (
    host === 'smba.trafficmanager.net' ||
    host.endsWith('.botframework.com') ||
    host.endsWith('.asm.skype.com')
  );
}

function httpsUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Graph's `/shares` address for a SharePoint URL (`u!` + unpadded base64url). */
function graphShareContentUrl(sharingUrl: string): string {
  const encoded = Buffer.from(sharingUrl).toString('base64url');
  return `${GRAPH_ORIGIN}/v1.0/shares/u!${encoded}/driveItem/content`;
}

/** Image URLs in a message's HTML body copy. */
function htmlImageUrls(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
}

function imageSource(url: URL): Source | null {
  if (url.origin === GRAPH_ORIGIN && url.pathname.includes('/hostedContents/')) return 'graph';
  if (isBotAttachmentHost(url.hostname)) return 'bot';
  return null;
}

/** What each attachment is, and how to read it. Unknown kinds are left out. */
function planReads(attachments: TeamsInboundAttachment[]): {
  reads: FileToRead[];
  failures: TeamsFileFailure[];
} {
  const reads: FileToRead[] = [];
  const failures: TeamsFileFailure[] = [];
  const seen = new Set<string>();
  let images = 0;

  const addImage = (raw: string | undefined, declaredType?: string, name?: string) => {
    const url = httpsUrl(raw);
    if (!url || seen.has(url.href)) return;
    const source = imageSource(url);
    if (!source) return;
    seen.add(url.href);
    images++;
    reads.push({
      kind: 'inline_image',
      filename: name || `image-${images}`,
      url: url.href,
      source,
      declaredType,
    });
  };

  for (const attachment of attachments) {
    const contentType = attachment.contentType ?? '';
    logger.info(
      { contentType, host: httpsUrl(attachment.contentUrl)?.hostname },
      '[TeamsAttachments] inbound attachment'
    );

    if (contentType === FILE_DOWNLOAD_INFO) {
      const filename = attachment.name || 'file';
      const downloadUrl = httpsUrl((attachment.content as { downloadUrl?: string } | undefined)?.downloadUrl);
      if (!downloadUrl || !downloadUrl.hostname.endsWith('.sharepoint.com')) {
        failures.push({ filename, reason: 'Teams sent no download address for it' });
        continue;
      }
      reads.push({ kind: 'personal_file', filename, url: downloadUrl.href, source: 'plain' });
      continue;
    }

    if (contentType === 'reference') {
      const filename = attachment.name || 'file';
      const sharingUrl = httpsUrl(attachment.contentUrl);
      if (!sharingUrl || !sharingUrl.hostname.endsWith('.sharepoint.com')) {
        failures.push({ filename, reason: 'it is not stored in SharePoint, where Prism reads files from' });
        continue;
      }
      reads.push({
        kind: 'channel_file',
        filename,
        url: graphShareContentUrl(sharingUrl.href),
        source: 'graph',
      });
      continue;
    }

    if (contentType.startsWith('image/')) {
      addImage(attachment.contentUrl, contentType, attachment.name);
      continue;
    }

    if (contentType === 'text/html' && typeof attachment.content === 'string') {
      for (const src of htmlImageUrls(attachment.content)) addImage(src);
    }
  }

  return { reads, failures };
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** A user-facing reason for a failed read, and the telemetry code for it. */
function failureReason(read: FileToRead, error: unknown): { reason: string; code: string } {
  const status = httpStatus(error);
  if (status === 401 || status === 403) {
    return read.kind === 'channel_file'
      ? {
          reason:
            "Prism has no permission to read files in this team's SharePoint. A Microsoft 365 admin " +
            'can grant it the Files.Read.All application permission',
          code: 'permission',
        }
      : { reason: 'Teams refused Prism access to it', code: 'permission' };
  }
  if (error instanceof TeamsFileTooLargeError) {
    return { reason: `it exceeds the ${MAX_FILE_SIZE_MB} MB limit`, code: 'too_large' };
  }
  return {
    reason: status ? `the download failed with HTTP ${status}` : 'the download failed',
    code: 'error',
  };
}

/**
 * Read and store every file on the message. Owns `teams attachment failed`;
 * a stored file is counted by `attachment uploaded`, which the attachment
 * service emits.
 */
export async function readInboundFiles(
  attachments: TeamsInboundAttachment[] | undefined,
  fetchers: TeamsFileFetchers,
  ctx: { threadId?: string }
): Promise<TeamsInboundFiles> {
  const planned = planReads(attachments ?? []);
  const failures = [...planned.failures];
  const names = [...planned.reads.map((r) => r.filename), ...planned.failures.map((f) => f.filename)];
  const attachmentIds: string[] = [];

  let reads = planned.reads;
  if (reads.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    failures.push({
      filename: `${reads.length - MAX_ATTACHMENTS_PER_MESSAGE} more file(s)`,
      reason: `only the first ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message are kept`,
    });
    reads = reads.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  }

  for (const read of reads) {
    try {
      const bytes = await fetchers[read.source](read.url);
      if (bytes.byteLength === 0) {
        failures.push({ filename: read.filename, reason: 'it downloaded as an empty file' });
        trackFailure(read, 'empty');
        continue;
      }
      if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
        failures.push({ filename: read.filename, reason: `it exceeds the ${MAX_FILE_SIZE_MB} MB limit` });
        trackFailure(read, 'too_large');
        continue;
      }
      const mediaType = detectMediaType(bytes, read.filename, read.declaredType);
      const row = await attachmentService.create({
        filename: read.filename,
        mediaType,
        sizeBytes: bytes.byteLength,
        data: bytes,
        category: classifyMediaType(mediaType),
        source: 'teams',
        threadId: ctx.threadId,
      });
      attachmentIds.push(row.id);
    } catch (error: unknown) {
      const { reason, code } = failureReason(read, error);
      logger.warn({ err: error, kind: read.kind }, '[TeamsAttachments] could not read an inbound file');
      failures.push({ filename: read.filename, reason });
      trackFailure(read, code);
    }
  }

  return { attachmentIds, failures, names };
}

function trackFailure(read: FileToRead, code: string): void {
  trackEvent('teams attachment failed', null, {
    ...(config.agentId ? { 'agent.id': config.agentId } : {}),
    'attachment.kind': read.kind,
    'failure.reason': code,
  });
}

/**
 * The runtime notice for files that could not be read. Worded so the agent
 * tells the user, rather than claim nothing was attached or look for the file
 * on disk.
 */
export function buildFileFailureNotice(failures: TeamsFileFailure[]): string {
  const list = failures.map((f) => `"${f.filename}": ${f.reason}`).join('; ');
  const many = failures.length > 1;
  return (
    `The user attached ${many ? 'files' : 'a file'} to this Microsoft Teams message that Prism could ` +
    `not read, so you do NOT have ${many ? 'their' : 'its'} contents: ${list}. In your reply, tell the ` +
    `user you couldn't read ${many ? 'their attached files' : 'their attached file'} and give the ` +
    'reason. Do not say no file was attached, and do not ask for a file path or look on disk.'
  );
}

/** The message text when a message carries files and no words. */
export function describeSharedFiles(names: string[]): string {
  return names.length > 1 ? `(shared files: ${names.join(', ')})` : `(shared a file: ${names[0]})`;
}
