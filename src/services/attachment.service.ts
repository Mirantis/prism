/**
 * Attachment Service
 *
 * Owns all `MessageAttachment` DB access plus the media-type detection and
 * classification used by both the upload route (web) and the Slack ingest
 * path. Content lives as files under `<dataDir>/media` (`lib/media-store.ts`);
 * the DB row keeps metadata plus the file's basename (`storagePath`). Legacy
 * rows may still carry a `data` BLOB until the boot-time backfill moves them —
 * `loadBytes()` is the one accessor that hides which of the two holds the
 * content, and returns null when neither does (content expired).
 *
 * Detection is allowlist-based on purpose: the Bedrock message converter
 * THROWS on an unknown mediaType in an image/file content part, which would
 * kill the whole `generateText` call. So anything we can't confidently read
 * is classified `unreadable` and shown to the model as a plain text note
 * (see `prompts/context-builder.ts`).
 */

import { randomUUID } from 'crypto';
import { MessageAttachment } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { readMediaFile, removeMediaFile, writeMediaFile } from '../lib/media-store';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../constants';

export type AttachmentCategory = 'image' | 'pdf' | 'text' | 'unreadable';

/** Metadata-only view (no bytes) — safe to serialize into JSON responses. */
export interface AttachmentMeta {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: AttachmentCategory;
}

export interface CreateAttachmentInput {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  data: Buffer;
  category: AttachmentCategory;
  // 'web'/'slack' = inbound user uploads; 'agent' = a file the agent shared
  // outbound via the share_file tool.
  source: 'web' | 'slack' | 'agent';
  threadId?: string;
  messageId?: string;
  slackFileId?: string;
  externalTs?: string;
}

// Bedrock natively understands exactly these image formats; emit image parts
// only for these (see getBedrockImageFormat in @ai-sdk/amazon-bedrock).
const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// `application/*` media types we still treat as inline-able text/code.
const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh',
]);

// Extension → media type, used when magic-byte sniffing doesn't match.
// Code files map to a text/* type so they classify as `text` and get inlined.
const EXT_MEDIA_TYPES: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  jsx: 'text/plain',
  ts: 'application/typescript',
  tsx: 'text/plain',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cc: 'text/x-c++',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  yml: 'application/x-yaml',
  yaml: 'application/x-yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  sql: 'text/plain',
  // NOTE: image/pdf extensions are deliberately absent. Those types are only
  // ever assigned from magic bytes (sniffMagicBytes) — a valid image/PDF always
  // carries its header, so an extension- or mime-based guess would only fire on
  // a corrupt/mislabeled file, which would then be emitted as an image/file
  // content part and fail the entire Bedrock turn. See detectMediaType's gate.
};

/** True for the media types that become Bedrock image/file content parts. */
function isImageOrPdfType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mediaType) || mediaType === 'application/pdf';
}

/** Sniff well-known binary headers. Returns null when nothing matches. */
function sniffMagicBytes(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}

/** True when the bytes are clean UTF-8 text (no NUL, valid encoding). */
function looksLikeUtf8Text(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort media type for an uploaded file. Magic bytes win (clients lie
 * about `Content-Type`), then the extension map, then a UTF-8 text heuristic
 * so arbitrary code files still inline, else `application/octet-stream`.
 */
export function detectMediaType(buffer: Buffer, filename: string, declaredMime?: string): string {
  // Magic bytes are the ONLY source that may yield an image/pdf type — a valid
  // image/PDF always carries its header in a complete upload.
  const magic = sniffMagicBytes(buffer);
  if (magic) return magic;

  let resolved: string;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (ext && EXT_MEDIA_TYPES[ext]) {
    resolved = EXT_MEDIA_TYPES[ext];
  } else if (declaredMime && (declaredMime.startsWith('text/') || declaredMime === 'application/json')) {
    resolved = declaredMime;
  } else if (looksLikeUtf8Text(buffer)) {
    resolved = 'text/plain';
  } else {
    resolved = declaredMime || 'application/octet-stream';
  }

  // Invariant: image/pdf parts are only emitted for magic-confirmed files.
  // A `.png`/image-mime guess on bytes without the matching header (corrupt or
  // mislabeled) would be sent to Bedrock as an image/file part and fail the
  // whole turn — downgrade it to an unreadable binary instead.
  return isImageOrPdfType(resolved) ? 'application/octet-stream' : resolved;
}

/** True for image media types Bedrock natively accepts as image content parts. */
export function isBedrockImageType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mediaType);
}

/** Map a media type to the four categories the context builder understands. */
export function classifyMediaType(mediaType: string): AttachmentCategory {
  if (IMAGE_MEDIA_TYPES.has(mediaType)) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('text/') || TEXT_APPLICATION_TYPES.has(mediaType)) return 'text';
  return 'unreadable';
}

/**
 * Human-readable byte size, e.g. "1.2 MB".
 *
 * Kept in sync with `cli/src/attachments.ts#formatFileSize` and
 * `web/src/components/chat/ChatAttachmentChip.tsx#humanSize` — the three
 * workspaces can't import each other, so the formatter is mirrored.
 */
export function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function toMeta(row: Pick<MessageAttachment, 'id' | 'filename' | 'mediaType' | 'sizeBytes' | 'category'>): AttachmentMeta {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    category: row.category as AttachmentCategory,
  };
}

const META_SELECT = {
  id: true,
  filename: true,
  mediaType: true,
  sizeBytes: true,
  category: true,
} as const;

class AttachmentService {
  /** Persist an uploaded/downloaded file: bytes to the media dir, metadata to the DB. */
  async create(input: CreateAttachmentInput): Promise<MessageAttachment> {
    // Id first so the content file exists before the row that references it —
    // a reader that sees the row can always read the file. The reverse order
    // would leave a window where the row points at nothing.
    const id = randomUUID();
    const storagePath = await writeMediaFile(id, input.filename, input.data);
    let row: MessageAttachment;
    try {
      row = await prisma.messageAttachment.create({
        data: {
          id,
          filename: input.filename,
          mediaType: input.mediaType,
          sizeBytes: input.sizeBytes,
          category: input.category,
          storagePath,
          source: input.source,
          threadId: input.threadId,
          messageId: input.messageId,
          slackFileId: input.slackFileId,
          externalTs: input.externalTs,
        },
      });
    } catch (err) {
      // Row never landed (e.g. a Slack redelivery losing the slackFileId
      // unique race) — the content file is unreachable, remove it now rather
      // than leaving it to the stray-file reaper.
      await removeMediaFile(storagePath);
      throw err;
    }
    // No filename in telemetry — it can reveal private information.
    trackEvent('attachment uploaded', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'attachment.id': row.id,
      'attachment.category': input.category,
      'attachment.media_type': input.mediaType,
      'attachment.size_bytes': String(input.sizeBytes),
      'attachment.source': input.source,
    });
    return row;
  }

  /**
   * Like `create()`, but idempotent on `slackFileId`: returns `null` when the
   * file is already stored. The unique index on `slackFileId` is the real
   * de-dupe guarantee — this swallows the unique-violation (P2002) that a
   * concurrent at-least-once Slack redelivery races into past the
   * `existsBySlackFileId` pre-check.
   */
  async createSlackAttachment(input: CreateAttachmentInput): Promise<MessageAttachment | null> {
    try {
      return await this.create(input);
    } catch (err) {
      // P2002 = unique-constraint violation. Duck-type on the code (robust
      // across module/mock boundaries); the unique index is the real guarantee.
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        return null;
      }
      throw err;
    }
  }

  /** Full row (metadata + storage handles) — bytes come from `loadBytes()`. */
  async getById(id: string): Promise<MessageAttachment | null> {
    return prisma.messageAttachment.findUnique({ where: { id } });
  }

  /**
   * The one content accessor. Prefers the media file, falls back to the
   * legacy BLOB (rows the boot backfill hasn't migrated), and returns null
   * when neither exists — content expired, only metadata remains.
   */
  async loadBytes(row: Pick<MessageAttachment, 'storagePath' | 'data'>): Promise<Buffer | null> {
    if (row.storagePath) {
      const bytes = await readMediaFile(row.storagePath);
      if (bytes) return bytes;
    }
    if (row.data) return Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    return null;
  }

  /** Metadata only (no bytes) for the given message ids — for thread reads. */
  async getMetaByMessageIds(messageIds: string[]): Promise<Map<string, AttachmentMeta[]>> {
    const map = new Map<string, AttachmentMeta[]>();
    if (messageIds.length === 0) return map;
    const rows = await prisma.messageAttachment.findMany({
      where: { messageId: { in: messageIds } },
      select: { ...META_SELECT, messageId: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      if (!row.messageId) continue;
      const list = map.get(row.messageId) ?? [];
      list.push(toMeta(row));
      map.set(row.messageId, list);
    }
    return map;
  }

  /**
   * Join attachment metadata (no bytes) onto messages by message id — the
   * shared enrichment for thread-read endpoints, so the join shape lives in
   * one place. Returns the input array untouched when nothing matches.
   */
  async attachMetaToMessages<T extends { id: string }>(
    messages: T[],
  ): Promise<(T & { attachments?: AttachmentMeta[] })[]> {
    if (messages.length === 0) return messages;
    const metaMap = await this.getMetaByMessageIds(messages.map((m) => m.id));
    if (metaMap.size === 0) return messages;
    return messages.map((m) => {
      const attachments = metaMap.get(m.id);
      return attachments && attachments.length > 0 ? { ...m, attachments } : m;
    });
  }

  /** Metadata only (no bytes) keyed by Slack message ts — for live Slack reads. */
  async getMetaByExternalTs(threadId: string, tsList: string[]): Promise<Map<string, AttachmentMeta[]>> {
    const map = new Map<string, AttachmentMeta[]>();
    if (tsList.length === 0) return map;
    const rows = await prisma.messageAttachment.findMany({
      where: { threadId, externalTs: { in: tsList } },
      select: { ...META_SELECT, externalTs: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) {
      if (!row.externalTs) continue;
      const list = map.get(row.externalTs) ?? [];
      list.push(toMeta(row));
      map.set(row.externalTs, list);
    }
    return map;
  }

  /**
   * Metadata by attachment ids, in upload order.
   *
   * For files that must reach the model *before* they are linked to a message
   * row: a message handed to a turn already in flight is folded into that turn
   * directly, so the only handle its files have at that point is the id the
   * upload returned.
   */
  async getMetaByIds(attachmentIds: string[]): Promise<AttachmentMeta[]> {
    if (attachmentIds.length === 0) return [];
    const rows = await prisma.messageAttachment.findMany({
      where: { id: { in: attachmentIds } },
      select: META_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toMeta);
  }

  /** Link pre-uploaded (web) attachments to the message that carries them. */
  async linkToMessage(attachmentIds: string[], messageId: string, threadId: string): Promise<void> {
    if (attachmentIds.length === 0) return;
    // Authoritative count cap (both web and Slack funnel through here). Bounds
    // the per-message stub count in the LLM context and the media-dir write
    // volume a single message can cause. Excess ids stay unlinked and the
    // orphan janitor reaps them. attachmentIds is client-controlled, so this
    // can't be trusted to the UI caps alone.
    const capped =
      attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE
        ? attachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
        : attachmentIds;
    if (capped.length < attachmentIds.length) {
      logger.warn(
        '[Attachments] message %s exceeded the %d-attachment cap (%d requested); linking first %d',
        messageId,
        MAX_ATTACHMENTS_PER_MESSAGE,
        attachmentIds.length,
        capped.length,
      );
    }
    await prisma.messageAttachment.updateMany({
      // Only pre-send (unlinked) uploads may be claimed — attachmentIds is a
      // client-controlled field, and a replayed/forged id must not steal an
      // attachment from the message it already belongs to.
      where: { id: { in: capped }, messageId: null },
      data: { messageId, threadId },
    });
  }

  /** True when a Slack file id was already stored (at-least-once redelivery). */
  async existsBySlackFileId(slackFileId: string): Promise<boolean> {
    const row = await prisma.messageAttachment.findFirst({
      where: { slackFileId },
      select: { id: true },
    });
    return row !== null;
  }

  /** Delete an unlinked (pre-send) attachment — used by chip removal. Returns deleted count. */
  async deleteUnlinked(id: string): Promise<number> {
    // Capture the file handle before the row goes — after deleteMany nothing
    // references it and only the slow stray-file reaper would find it.
    const victim = await prisma.messageAttachment.findFirst({
      where: { id, messageId: null },
      select: { storagePath: true },
    });
    const result = await prisma.messageAttachment.deleteMany({
      where: { id, messageId: null },
    });
    if (result.count > 0) {
      if (victim?.storagePath) await removeMediaFile(victim.storagePath);
      trackEvent('attachment deleted', null, {
        ...(config.agentId ? { 'agent.id': config.agentId } : {}),
        'attachment.id': id,
      });
    }
    return result.count;
  }

  /** Reap abandoned pre-send uploads that never got linked to a message. */
  async deleteOrphans(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const victims = await prisma.messageAttachment.findMany({
      where: { messageId: null, createdAt: { lt: cutoff } },
      select: { id: true, storagePath: true },
    });
    if (victims.length === 0) return 0;
    const result = await prisma.messageAttachment.deleteMany({
      where: { id: { in: victims.map((v) => v.id) } },
    });
    for (const v of victims) {
      if (v.storagePath) await removeMediaFile(v.storagePath);
    }
    return result.count;
  }
}

export const attachmentService = new AttachmentService();
