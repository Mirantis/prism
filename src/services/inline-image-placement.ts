/**
 * The images a reply places in its text become attachments of the message that
 * shows them. A reply names an image by a path in its workspace or by
 * `attachment:<id>`, and the stored message names each image it placed by the
 * attachment that holds it.
 *
 * A path is held to `share_file`'s bound: it must resolve inside the thread's
 * workspace, and it is read through the filesystem that holds it. Placement runs
 * once the step's tool calls have finished, so no write of that step is still
 * pending. A file this turn already shared is placed as that attachment, not
 * stored a second time.
 */

import * as path from 'path';
import { attachmentService, classifyMediaType, detectMediaType } from './attachment.service';
import {
  attachmentImage,
  attachmentRefId,
  findImageRefs,
  isLocalPath,
  replaceImageRefs,
} from '../lib/inline-images';
import { readSettledFile } from '../lib/read-settled-file';
import { resolveWorkspace } from '../lib/execution-environments/workspace';
import { filesFor } from '../lib/execution-environments/get-execution-environment';
import { isInsideWorkspace, resolvePath } from '../tools/shell/workspace';
import { conversationService } from './conversation.service';
import { logger } from '../logger';

export interface PlacedImages {
  /** The text, with each image it places named by its attachment. */
  content: string;
  /** The attachments the text places, in order of first reference. */
  attachmentIds: string[];
  /** References that show no image. */
  missed: number;
}

export interface PlacementContext {
  threadId: string;
  /** The thread's workspace, which a relative path is read from. */
  workspaceRoot?: string;
  /** Files this turn shared that no message holds yet. */
  shared: readonly string[];
}

export async function placeInlineImages(text: string, context: PlacementContext): Promise<PlacedImages> {
  const refs = findImageRefs(text);
  if (refs.length === 0) return { content: text, attachmentIds: [], missed: 0 };

  const placed = new Map<string, string | null>();
  for (const ref of refs) {
    if (!placed.has(ref.target)) placed.set(ref.target, await attachmentFor(ref.target, context));
  }
  return {
    content: replaceImageRefs(text, refs, (ref) => {
      const id = placed.get(ref.target);
      return id ? attachmentImage(ref.alt, id) : null;
    }),
    attachmentIds: [...new Set([...placed.values()].filter((id): id is string => id !== null))],
    missed: refs.filter((ref) => !placed.get(ref.target)).length,
  };
}

/**
 * A reply delivered outside a chat turn (a goal turn, a bound scheduled run):
 * its text with the images it places, and its attachments, the placed images
 * first. A failure leaves the text and the files as they were.
 */
export async function placeReplyImages(
  threadId: string,
  text: string,
  attachmentIds: readonly string[] = [],
): Promise<{ content: string; attachmentIds: string[] }> {
  try {
    const workspaceRoot = (await conversationService.getThreadWorkspaceRoot(threadId)) ?? undefined;
    const placed = await placeInlineImages(text, { threadId, workspaceRoot, shared: attachmentIds });
    return {
      content: placed.content,
      attachmentIds: [...placed.attachmentIds, ...attachmentIds.filter((id) => !placed.attachmentIds.includes(id))],
    };
  } catch (err) {
    logger.error({ err }, '[InlineImages] placing the images of a reply in %s failed', threadId);
    return { content: text, attachmentIds: [...attachmentIds] };
  }
}

/** A failure to store one image leaves its reference as written, so the reply still goes out. */
async function attachmentFor(target: string, context: PlacementContext): Promise<string | null> {
  try {
    const id = attachmentRefId(target);
    if (id) return await storedImage(id, context);
    if (isLocalPath(target)) return await captureImage(target, context);
    return null;
  } catch (err) {
    logger.error({ err }, '[InlineImages] %s shows no image: storing it failed', target);
    return null;
  }
}

/**
 * A stored image: one this turn shared, or one another message of this thread
 * holds, copied for this message. The thread bound keeps a reply from showing a
 * file from a conversation its readers are not in.
 */
async function storedImage(id: string, context: PlacementContext): Promise<string | null> {
  const row = await attachmentService.getById(id);
  if (!row || classifyMediaType(row.mediaType) !== 'image') return null;
  // A shared row a message already holds (a resumed turn's list can name one)
  // is copied like any other of this thread, so this message gets its own.
  if (context.shared.includes(id) && !row.messageId) return id;
  if (row.threadId !== context.threadId) return null;
  const data = await attachmentService.loadBytes(row);
  if (!data) return null;
  const copy = await attachmentService.create({
    filename: row.filename,
    mediaType: row.mediaType,
    sizeBytes: data.length,
    data,
    category: 'image',
    source: 'agent',
  });
  return copy.id;
}

/**
 * Read an image in the workspace through the filesystem that holds its path, as
 * `share_file` does, so a path means what it means to the agent's shell.
 */
async function captureImage(target: string, context: PlacementContext): Promise<string | null> {
  const workspace = resolveWorkspace(context.workspaceRoot);
  const fullPath = resolvePath(workspace, target);
  if (!isInsideWorkspace(fullPath, workspace)) {
    logger.info('[InlineImages] %s shows no image: it is outside the workspace', target);
    return null;
  }
  const read = await readSettledFile(filesFor(fullPath), fullPath, target);
  if (!read.ok) {
    logger.info('[InlineImages] %s shows no image: %s', target, read.error);
    return null;
  }
  const filename = path.basename(fullPath);
  const mediaType = detectMediaType(read.data, filename);
  if (classifyMediaType(mediaType) !== 'image') {
    logger.info('[InlineImages] %s shows no image: it is %s', target, mediaType);
    return null;
  }
  const shared = await sharedCopy(read.data, context.shared);
  if (shared) return shared;
  const row = await attachmentService.create({
    filename,
    mediaType,
    sizeBytes: read.data.length,
    data: read.data,
    category: 'image',
    source: 'agent',
  });
  return row.id;
}

/** The file this turn shared, still unlinked, that holds these same bytes. */
async function sharedCopy(data: Buffer, shared: readonly string[]): Promise<string | null> {
  for (const id of shared) {
    const row = await attachmentService.getById(id);
    if (!row || row.messageId || row.sizeBytes !== data.length) continue;
    if (classifyMediaType(row.mediaType) !== 'image') continue;
    const bytes = await attachmentService.loadBytes(row);
    if (bytes?.equals(data)) return id;
  }
  return null;
}
