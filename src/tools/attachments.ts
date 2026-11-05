/**
 * Attachment tools — hydrate stored attachments to the workspace so the agent
 * can inspect them with shell tools (file, hexdump, pdftotext, etc.), or view
 * images inline via multimodal tool output.
 *
 * Security: strict RBAC via threadId — an attachment is only accessible if its
 * threadId matches the closed-over threadId of the invocation. This prevents
 * cross-thread data leakage even when the model hallucinates attachment ids.
 */

import { filesFor } from '../lib/execution-environments/get-execution-environment';
import * as path from 'path';
import { ModelMessage, Tool, tool } from 'ai';
import { z } from 'zod';
import {
  attachmentRetention,
  attachmentService,
  classifyMediaType,
  isBedrockImageType,
} from '../services/attachment.service';
import { sanitizeFilename } from '../lib/media-store';
import { MAX_FILE_SIZE_BYTES } from '../constants';
import { resolveWorkspace } from '../lib/execution-environments/workspace';
import type { DirEntry } from '../lib/execution-environments/execution-environment';
import { trackEvent } from '../lib/telemetry';
import { withModelOnlyOutput } from './program/model-only';

/** The filesystem holding a path, so a hydrated file is one the thread's shell can read. */
function files(forPath: string) {
  return filesFor(forPath);
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

  const bytes = await attachmentService.loadBytes(row);
  if (!bytes) {
    trackEvent('attachment hydrate failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return {
      success: false,
      error: `The content of "${row.filename}" has expired (attachments are kept for ${attachmentRetention()}). Ask the user to share the file again if you need it.`,
    };
  }

  const ws = resolveWorkspace(workspaceRoot);
  const scratchDir = path.join(ws, '.attachments', threadId, attachmentId);
  await files(scratchDir).mkdir(scratchDir);

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

  await files(destPath).writeBytes(destPath, bytes);

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

  let threadDirs: DirEntry[];
  try {
    threadDirs = await files(baseDir).readDir(baseDir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - olderThanMs;
  let reaped = 0;

  for (const threadDir of threadDirs) {
    const threadPath = path.join(baseDir, threadDir.name);
    const threadStat = await files(threadPath).lstat(threadPath).catch(() => null);
    if (!threadStat?.isDirectory) continue;

    let attachmentDirs: DirEntry[];
    try {
      attachmentDirs = await files(threadPath).readDir(threadPath);
    } catch {
      continue;
    }

    for (const attDir of attachmentDirs) {
      const attPath = path.join(threadPath, attDir.name);
      const attStat = await files(attPath).lstat(attPath).catch(() => null);
      if (!attStat?.isDirectory) continue;

      if (attStat.mtimeMs < cutoff) {
        await files(attPath).remove(attPath);
        reaped++;
      }
    }

    // Clean up empty thread dirs
    const remaining = await files(threadPath).readDir(threadPath).catch(() => [null]);
    if (remaining.length === 0) {
      await files(threadPath).removeDir(threadPath).catch(() => {});
    }
  }

  return reaped;
}

// ~3.75 MB Bedrock per-image tool-result ceiling (base64 encoded).
const IMAGE_SIZE_CEILING_BYTES = 3_750_000;

export interface ViewAttachmentSuccess {
  success: true;
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: 'image' | 'pdf';
  /**
   * What actually happened, for the model. Bytes deliberately stay out of the
   * tool's `execute` result — `onStepFinish` renders it into the persisted
   * ToolCallRecord (see `lib/tool-output-limiter`), so a base64 payload here
   * would write megabytes into the message row. Images ride `toModelOutput` (which loads bytes at
   * prompt-conversion time); PDFs ride a registered user-message injection.
   */
  note: string;
}

export interface ViewAttachmentFailure {
  success: false;
  error: string;
}

export interface ViewAttachmentContext {
  /**
   * Queues a message for injection into the running invocation at the next
   * step boundary (invoke.ts prepareStep). PDFs need this: on Bedrock's
   * Converse surface a document block is only legal in a *user* message —
   * the converter throws on `file-data` inside a tool result — so the tool
   * result stays text and the document follows as a user message.
   */
  registerInjection?: (message: ModelMessage) => void;
  /**
   * Documents already injected in this invocation. An injection is re-spliced
   * into every later step, so viewing the same PDF twice must not attach a
   * second multi-MB copy.
   */
  injectedDocumentIds?: Set<string>;
}

export async function runViewAttachment(
  input: { attachmentId: string },
  userId: string,
  agentId: string,
  threadId: string | undefined,
  ctx: ViewAttachmentContext = {},
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

  const isPdf = row.mediaType === 'application/pdf' && Boolean(ctx.registerInjection);

  // Everything that is neither a Bedrock-safe image nor an injectable PDF
  // goes to hydrate_attachment + shell tools.
  if (!isBedrockImageType(row.mediaType) && !isPdf) {
    trackEvent('attachment view failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return {
      success: false,
      error: 'This file type cannot be viewed inline. Use hydrate_attachment to write the file to disk, then inspect with shell tools.',
    };
  }

  // Size guards. Images: base64 expands ~33%, but we check raw size against
  // the ceiling since it accounts for the expansion on Bedrock's side. PDFs:
  // the upload cap is the proven bound for user-message file parts.
  const sizeCeiling = isPdf ? MAX_FILE_SIZE_BYTES : IMAGE_SIZE_CEILING_BYTES;
  if (row.sizeBytes > sizeCeiling) {
    trackEvent('attachment view failed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
    });
    return {
      success: false,
      error: `${isPdf ? 'Document' : 'Image'} exceeds the ${(sizeCeiling / 1_000_000).toFixed(2)} MB size limit for inline viewing. Use hydrate_attachment to write it to disk and inspect with shell tools${isPdf ? ' (e.g. pdftotext)' : ''}.`,
    };
  }

  const meta = {
    attachmentId,
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
  };

  if (isPdf) {
    // Idempotent per invocation — the injected document is re-spliced into
    // every subsequent step, so it is still in view.
    if (ctx.injectedDocumentIds?.has(attachmentId)) {
      return {
        success: true,
        ...meta,
        category: 'pdf',
        note: `"${row.filename}" is already attached to this turn from an earlier view_attachment call — its content is still visible above.`,
      };
    }
    // Claim the id BEFORE the await: the SDK runs a step's tool calls with
    // Promise.all, and a check-then-add spanning the read would let two
    // parallel calls for the same id both inject a multi-MB copy.
    ctx.injectedDocumentIds?.add(attachmentId);

    const bytes = await attachmentService.loadBytes(row);
    if (!bytes) {
      ctx.injectedDocumentIds?.delete(attachmentId);
      return viewExpiredFailure(row.filename, userId, agentId, attachmentId);
    }

    ctx.registerInjection!({
      role: 'user',
      content: [
        {
          type: 'file',
          data: bytes,
          mediaType: 'application/pdf',
          filename: row.filename,
          // Bedrock Converse text-extracts a document unless citations are
          // enabled; enabling them gives Claude the full visual pages. Other
          // providers ignore the bedrock namespace.
          providerOptions: { bedrock: { citations: { enabled: true } } },
        },
        {
          type: 'text',
          text: `[Document "${row.filename}" (id=${attachmentId}) attached for analysis via view_attachment]`,
        },
      ],
    });

    trackEvent('attachment viewed', userId, {
      'agent.id': agentId,
      'attachment.id': attachmentId,
      'attachment.category': 'pdf',
      'attachment.media_type': row.mediaType,
      'attachment.size_bytes': String(row.sizeBytes),
    });

    return {
      success: true,
      ...meta,
      category: 'pdf',
      // Turn-scoped on purpose: this note is persisted into the ToolCallRecord
      // and replayed verbatim in later turns' history — where no document
      // follows. Overclaiming here would invite confabulated answers later.
      note: `Attached "${row.filename}" as a document for this turn — its full content follows this tool result. In a later turn, call view_attachment again if you need it back.`,
    };
  }

  // Image: verify the content is still there so the failure is a clear tool
  // error; the bytes themselves are loaded again in toModelOutput.
  const bytes = await attachmentService.loadBytes(row);
  if (!bytes) return viewExpiredFailure(row.filename, userId, agentId, attachmentId);

  trackEvent('attachment viewed', userId, {
    'agent.id': agentId,
    'attachment.id': attachmentId,
    'attachment.category': 'image',
    'attachment.media_type': row.mediaType,
    'attachment.size_bytes': String(row.sizeBytes),
  });

  return {
    success: true,
    ...meta,
    category: 'image',
    // Turn-scoped for the same reason as the PDF note above.
    note: `Image "${row.filename}" is attached to this tool result for this turn. In a later turn, call view_attachment again if you need it back.`,
  };
}

function viewExpiredFailure(
  filename: string,
  userId: string,
  agentId: string,
  attachmentId: string,
): ViewAttachmentFailure {
  trackEvent('attachment view failed', userId, {
    'agent.id': agentId,
    'attachment.id': attachmentId,
  });
  return {
    success: false,
    error: `The content of "${filename}" has expired (attachments are kept for ${attachmentRetention()}). Ask the user to share the file again if you need it.`,
  };
}

export function getAttachmentTools(
  userId: string,
  agentId: string,
  threadId: string | undefined,
  workspaceRoot?: string | null,
  registerInjection?: (message: ModelMessage) => void,
): Record<string, Tool> {
  const injectedDocumentIds = new Set<string>();
  return {
    hydrate_attachment: tool({
      description:
        'Make a message attachment available on the workspace filesystem. ' +
        'Attachment bytes are not on disk until you call this: the filename in the attachment ' +
        "stub is not a path, so shell tools (`cat`, `grep`, `jq`, `unzip`, `python`) will fail with 'no such file' " +
        'until the file is hydrated. ' +
        'Returns the absolute path to the hydrated file — use that path in shell commands. ' +
        'Use it for text, code, archives and data files, and for any file you want to inspect ' +
        'with `file`, `pdftotext`, `exiftool` or `hexdump`.',
      inputSchema: z.object({
        attachmentId: z
          .string()
          .describe('The id of the attachment to hydrate (from the message metadata).'),
      }),
      execute: async (input) =>
        runHydrateAttachment(input, userId, agentId, threadId, workspaceRoot),
    }),
    view_attachment: withModelOnlyOutput({
      ...tool({
        description:
          'Look at an image or read a PDF attachment without writing it to disk. ' +
          'Images (PNG, JPEG, GIF, WebP) are returned inline for visual inspection; ' +
          'a PDF is attached to the conversation as a document you can read directly. ' +
          'For other file types or oversized files, use hydrate_attachment instead.',
        inputSchema: z.object({
          attachmentId: z
            .string()
            .describe('The id of the image or PDF attachment to view (from the message metadata).'),
        }),
        execute: async (input) =>
          runViewAttachment(input, userId, agentId, threadId, {
            registerInjection,
            injectedDocumentIds,
          }),
      }),
      // Images ride the tool result as multimodal content; bytes are loaded
      // here — at prompt-conversion time — so the (persisted, UI-visible)
      // execute() result above stays metadata-sized. PDFs already went out as
      // a user-message injection, so their result is the plain note.
      toModelOutput: async ({ output }: { output: unknown }) => {
        const result = output as ViewAttachmentSuccess | ViewAttachmentFailure;
        if (!result.success) {
          return { type: 'text' as const, value: result.error };
        }
        if (result.category !== 'image') {
          return { type: 'text' as const, value: result.note };
        }
        const row = await attachmentService.getById(result.attachmentId);
        const bytes = row ? await attachmentService.loadBytes(row) : null;
        if (!bytes) {
          // Expired between the tool call and this conversion — rare, benign.
          return {
            type: 'text' as const,
            value: `The content of "${result.filename}" is no longer available (expired).`,
          };
        }
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: `[Viewing ${result.filename}]` },
            {
              type: 'image-data' as const,
              data: bytes.toString('base64'),
              mediaType: result.mediaType,
            },
          ],
        };
      },
    }),
  };
}
