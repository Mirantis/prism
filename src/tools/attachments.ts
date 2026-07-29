/**
 * Attachment tools — hydrate stored attachments to the workspace so the agent
 * can inspect them with shell tools (file, hexdump, pdftotext, etc.).
 *
 * Security: strict RBAC via threadId — an attachment is only accessible if its
 * threadId matches the closed-over threadId of the invocation. This prevents
 * cross-thread data leakage even when the model hallucinates attachment ids.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, tool } from 'ai';
import { z } from 'zod';
import { attachmentService, classifyMediaType } from '../services/attachment.service';
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

// TODO(AGENT-85): view_attachment in Chunk 3

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
  };
}
