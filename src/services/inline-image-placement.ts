/**
 * The images a reply places in its text become attachments of the message that
 * shows them. A reply names an image by a path on the agent's filesystem or by
 * `attachment:<id>`, and the stored message names each image it placed by the
 * attachment that holds it.
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
import { getExecutionEnvironmentFor } from '../lib/execution-environments/get-execution-environment';
import { resolvePath } from '../tools/shell/workspace';
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

async function attachmentFor(target: string, context: PlacementContext): Promise<string | null> {
  const id = attachmentRefId(target);
  if (id) return storedImage(id, context);
  if (isLocalPath(target)) return captureImage(target, context.workspaceRoot);
  return null;
}

/**
 * A stored image: one this turn shared, or one another message of this thread
 * holds, copied for this message. The thread bound keeps a reply from showing a
 * file from a conversation its readers are not in.
 */
async function storedImage(id: string, context: PlacementContext): Promise<string | null> {
  const row = await attachmentService.getById(id);
  if (!row || classifyMediaType(row.mediaType) !== 'image') return null;
  if (context.shared.includes(id)) return id;
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

/** Read through the environment that runs the thread's commands, so a path means what it means to the agent's shell. */
async function captureImage(target: string, workspaceRoot: string | undefined): Promise<string | null> {
  const workspace = resolveWorkspace(workspaceRoot);
  const fullPath = resolvePath(workspace, target);
  const read = await readSettledFile(getExecutionEnvironmentFor(workspace).files, fullPath, target);
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
