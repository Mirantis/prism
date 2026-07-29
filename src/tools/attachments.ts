/**
 * Attachment tools — hydrate stored attachments to the workspace so the agent
 * can inspect them with shell tools (file, hexdump, pdftotext, etc.), or view
 * images inline via multimodal tool output.
 *
 * Security: strict RBAC via threadId — an attachment is only accessible if its
 * threadId matches the closed-over threadId of the invocation. This prevents
 * cross-thread data leakage even when the model hallucinates attachment ids.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, tool } from 'ai';
import { z } from 'zod';
import { attachmentService, classifyMediaType, isBedrockImageType } from '../services/attachment.service';
import { resolveWorkspace } from './shell/config';
import { trackEvent } from '../lib/telemetry';

const MAX_FILENAME_BYTES = 255;

function sanitizeFilename(raw: string, fallback: string): string {
  let name = path.basename(raw);
  // Strip control chars and path separators that snuck past basename
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, '_');
  // Reject directory traversal remnants
  name = name.replace(/\.\./g, '_');
  // Cap length in bytes (UTF-8 aware)
  const buf = Buffer.from(name, 'utf8');
  if (buf.length > MAX_FILENAME_BYTES) {
    name = buf.subarray(0, MAX_FILENAME_BYTES).toString('utf8');
  }
  return name.trim() || fallback;
}

export interface HydrateAttachmentSuccess {
  success: true;
  path: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  hint: string;
}

export interface HydrateAttachmentFailure {
  success: false;
  error: string;
}

export async function runHydrateAttachment(
  input: { attachmentId: string },
  userId: string,
  agentId: string,
  threadId: string | undefined,
  workspaceRoot?: string | null,
): Promise<HydrateAttachmentSuccess | HydrateAttachmentFailure> {
  const { attachmentId } = input;

  if (!threadId) {
    trackEvent('attachment hydrate failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return { success: false, error: 'Attachment not found.' };
  }

  const row = await attachmentService.getById(attachmentId);
  if (!row || row.threadId !== threadId) {
    trackEvent('attachment hydrate failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return { success: false, error: 'Attachment not found.' };
  }

  const ws = resolveWorkspace(workspaceRoot);
  const scratchDir = path.join(ws, '.attachments', threadId, attachmentId);
  await fs.mkdir(scratchDir, { recursive: true });

  const filename = sanitizeFilename(row.filename, attachmentId);
  const destPath = path.resolve(scratchDir, filename);

  // Final guard: resolved path must stay inside scratchDir
  if (!destPath.startsWith(scratchDir + path.sep) && destPath !== scratchDir) {
    trackEvent('attachment hydrate failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return { success: false, error: 'Attachment not found.' };
  }

  await fs.writeFile(destPath, Buffer.from(row.data));

  const category = classifyMediaType(row.mediaType);
  trackEvent('attachment hydrated', userId, {
    'agent.id': agentId,
    'attachment.id': attachmentId,
    'attachment.category': category,
    'attachment.size_bytes': String(row.sizeBytes),
  });

  return {
    success: true,
    path: destPath,
    filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    hint: `File written to ${destPath}. You can now inspect it with shell tools (e.g. file, cat, hexdump, pdftotext, exiftool).`,
  };
}

/**
 * Reap stale scratch dirs under `<workspaceRoot>/.attachments/`.
 * Walks `<threadId>/<attachmentId>/` dirs and removes those whose mtime is
 * older than `olderThanMs`. Does NOT follow symlinks.
 */
export async function reapScratchDirs(
  workspaceRoot: string | undefined | null,
  olderThanMs: number,
): Promise<number> {
  const ws = resolveWorkspace(workspaceRoot);
  const baseDir = path.join(ws, '.attachments');

  let threadDirs: string[];
  try {
    threadDirs = await fs.readdir(baseDir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - olderThanMs;
  let reaped = 0;

  for (const threadDir of threadDirs) {
    const threadPath = path.join(baseDir, threadDir);
    const threadStat = await fs.lstat(threadPath).catch(() => null);
    if (!threadStat || !threadStat.isDirectory()) continue;

    let attachmentDirs: string[];
    try {
      attachmentDirs = await fs.readdir(threadPath);
    } catch {
      continue;
    }

    for (const attDir of attachmentDirs) {
      const attPath = path.join(threadPath, attDir);
      const attStat = await fs.lstat(attPath).catch(() => null);
      if (!attStat || !attStat.isDirectory()) continue;

      if (attStat.mtimeMs < cutoff) {
        await fs.rm(attPath, { recursive: true, force: true });
        reaped++;
      }
    }

    // Clean up empty thread dirs
    const remaining = await fs.readdir(threadPath).catch(() => ['_']);
    if (remaining.length === 0) {
      await fs.rmdir(threadPath).catch(() => {});
    }
  }

  return reaped;
}

// ~3.75 MB Bedrock per-image tool-result ceiling (base64 encoded).
const IMAGE_SIZE_CEILING_BYTES = 3_750_000;

export interface ViewAttachmentSuccess {
  success: true;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: 'image';
  data: string; // base64
}

export interface ViewAttachmentFailure {
  success: false;
  error: string;
}

export async function runViewAttachment(
  input: { attachmentId: string },
  userId: string,
  agentId: string,
  threadId: string | undefined,
): Promise<ViewAttachmentSuccess | ViewAttachmentFailure> {
  const { attachmentId } = input;

  if (!threadId) {
    trackEvent('attachment view failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return { success: false, error: 'Attachment not found.' };
  }

  const row = await attachmentService.getById(attachmentId);
  if (!row || row.threadId !== threadId) {
    trackEvent('attachment view failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return { success: false, error: 'Attachment not found.' };
  }

  // Only Bedrock-supported image types can be returned as multimodal content.
  if (!isBedrockImageType(row.mediaType)) {
    // TODO(AGENT-85): optional provider-split PDF vision on Azure
    const hint = row.mediaType === 'application/pdf'
      ? 'PDF files cannot be viewed inline. Use hydrate_attachment to write the file to disk, then inspect with `pdftotext`.'
      : 'This file type cannot be viewed inline. Use hydrate_attachment to write the file to disk, then inspect with shell tools.';

    trackEvent('attachment view failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return { success: false, error: hint };
  }

  // Size guard: base64 expands ~33%, but we check raw size against the ceiling
  // since the ceiling accounts for the base64 expansion on Bedrock's side.
  if (row.sizeBytes > IMAGE_SIZE_CEILING_BYTES) {
    trackEvent('attachment view failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return {
      success: false,
      error: `Image exceeds the ${(IMAGE_SIZE_CEILING_BYTES / 1_000_000).toFixed(2)} MB size limit for inline viewing. Use hydrate_attachment to write it to disk and inspect with shell tools.`,
    };
  }

  const base64 = Buffer.from(row.data).toString('base64');

  trackEvent('attachment viewed', userId, {
    'agent.id': agentId,
    'attachment.id': attachmentId,
    'attachment.category': 'image',
    'attachment.media_type': row.mediaType,
    'attachment.size_bytes': String(row.sizeBytes),
  });

  return {
    success: true,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    category: 'image',
    data: base64,
  };
}

export function getAttachmentTools(
  userId: string,
  agentId: string,
  threadId: string | undefined,
  workspaceRoot?: string | null,
): Record<string, Tool> {
  return {
    hydrate_attachment: tool({
      description:
        'Write a message attachment to a workspace file so you can inspect it with shell tools. ' +
        'Use this when you need to examine an attachment beyond what the chat context shows ' +
        '(e.g. run `file`, `pdftotext`, `exiftool`, `hexdump`, or read binary formats). ' +
        'Returns the absolute path to the hydrated file.',
      inputSchema: z.object({
        attachmentId: z
          .string()
          .describe('The id of the attachment to hydrate (from the message metadata).'),
      }),
      execute: async (input) =>
        runHydrateAttachment(input, userId, agentId, threadId, workspaceRoot),
    }),
    view_attachment: {
      ...tool({
        description:
          'View an image attachment inline without writing it to disk. ' +
          'Use this for quick visual inspection of PNG, JPEG, GIF, or WebP images. ' +
          'For PDFs, large images, or non-image files, use hydrate_attachment instead.',
        inputSchema: z.object({
          attachmentId: z
            .string()
            .describe('The id of the image attachment to view (from the message metadata).'),
        }),
        execute: async (input) =>
          runViewAttachment(input, userId, agentId, threadId),
      }),
      toModelOutput: async ({ output }: { output: unknown }) => {
        const result = output as ViewAttachmentSuccess | ViewAttachmentFailure;
        if (!result.success) {
          return { type: 'text' as const, value: result.error };
        }
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: `[Viewing ${result.filename}]` },
            { type: 'image-data' as const, data: result.data, mediaType: result.mediaType },
          ],
        };
      },
    },
  };
}
