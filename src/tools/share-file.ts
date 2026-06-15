/**
 * share_file tool — deliver a workspace file to the user as a downloadable
 * attachment.
 *
 * The agent already CREATES files on disk via the shell tools
 * (`shell_write_file`, `shell_exec`, `claude_code`, …) inside its workspace
 * (`SHELL_WORKSPACE_ROOT`, default `/home/node`). This tool is the OUTBOUND
 * half: it reads such a file, stores it as a `MessageAttachment`
 * (`source: 'agent'`, unlinked), and returns its `attachmentId`. The invoke
 * loop collects those ids onto the `InvokeStep`; the conversation engine /
 * heartbeat / cron then link them to the delivered message, and each channel
 * adapter renders them (web + CLI download chips, Slack `files.uploadV2`).
 *
 * Security model is inherited from the shell file tools: `resolvePath`
 * resolves relative paths against the workspace root and normalizes absolute
 * paths; `isInsideWorkspace` then rejects anything that escapes the workspace
 * (relative `..` traversal AND absolute paths outside it). Media type is
 * sniffed from magic bytes (clients/extensions lie), and the 10 MB cap mirrors
 * the inbound upload limit.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, tool } from 'ai';
import { z } from 'zod';
import { resolvePath, isInsideWorkspace } from './shell/workspace';
import { resolveWorkspaceRoot } from './shell/config';
import {
  attachmentService,
  detectMediaType,
  classifyMediaType,
} from '../services/attachment.service';
import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from '../constants';

export const shareFileInput = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to share. Relative paths resolve from the workspace root; the file must live inside the workspace.',
    ),
  filename: z
    .string()
    .optional()
    .describe(
      'Optional display name shown to the user (defaults to the file’s base name). Use this to give a friendlier name than the on-disk path.',
    ),
});

export interface ShareFileSuccess {
  success: true;
  attachmentId: string;
  filename: string;
  sizeBytes: number;
  mediaType: string;
  category: string;
}

export interface ShareFileFailure {
  success: false;
  error: string;
}

/**
 * Read a workspace file and persist it as an agent-sourced attachment.
 * Pure (no closure over user/agent) so it's unit-testable; the `workspace`
 * param defaults to the configured workspace root.
 */
export async function runShareFile(
  input: z.infer<typeof shareFileInput>,
  workspace: string = resolveWorkspaceRoot(),
): Promise<ShareFileSuccess | ShareFileFailure> {
  const fullPath = resolvePath(workspace, input.path);
  if (!isInsideWorkspace(fullPath, workspace)) {
    return { success: false, error: 'Path outside workspace' };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return { success: false, error: `File not found: ${input.path}` };
  }
  if (stat.isDirectory()) {
    return { success: false, error: `${input.path} is a directory — share a single file.` };
  }
  if (stat.size === 0) {
    return { success: false, error: `File is empty: ${input.path}` };
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return {
      success: false,
      error: `File too large (${(stat.size / (1024 * 1024)).toFixed(1)} MB) — max ${MAX_FILE_SIZE_MB} MB.`,
    };
  }

  let data: Buffer;
  try {
    data = await fs.readFile(fullPath);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const filename = (input.filename?.trim() || path.basename(fullPath)) || 'file';
  const mediaType = detectMediaType(data, filename);
  const category = classifyMediaType(mediaType);

  const row = await attachmentService.create({
    filename,
    mediaType,
    sizeBytes: stat.size,
    data,
    category,
    source: 'agent',
  });

  return {
    success: true,
    attachmentId: row.id,
    filename,
    sizeBytes: stat.size,
    mediaType,
    category,
  };
}

/**
 * Tool name whose results carry an `attachmentId` to be delivered. Exported so
 * `invoke.ts` can recognise the tool without duplicating the string.
 */
export const SHARE_FILE_TOOL_NAME = 'share_file';

export function getShareFileTools(): Record<string, Tool> {
  return {
    [SHARE_FILE_TOOL_NAME]: tool({
      description:
        'Share a file from your workspace with the user as a downloadable attachment. ' +
        'Use this whenever the user asks for a file, report, export, document, image, or generated artifact — ' +
        'first create it on disk (e.g. with shell_write_file or shell_exec), then call share_file with its path. ' +
        'The file is delivered as a download in the web/CLI chat and uploaded natively to Slack. ' +
        'Max 10 MB per file. Do NOT paste large file contents into your reply or invent download links — use this tool.',
      inputSchema: shareFileInput,
      execute: async (input) => runShareFile(input),
    }),
  };
}
