/**
 * share_file tool — deliver a workspace file to the user as a downloadable
 * attachment.
 *
 * The agent already CREATES files on disk via the shell tools
 * (`shell_write_file`, `shell_exec`, `coding_agent`, …) inside its workspace
 * (`SHELL_WORKSPACE_ROOT`, default `/home/node`). This tool is the OUTBOUND
 * half: it reads such a file, stores it as a `MessageAttachment`
 * (`source: 'agent'`, unlinked), and returns its `attachmentId`. The invoke
 * loop collects those ids onto the `InvokeStep`; the conversation engine /
 * heartbeat / cron then link them to the delivered message, and each channel
 * adapter renders them its own way.
 *
 * A share is sequenced against the writes in its own step. The model routinely
 * asks for the edit and the share in one assistant message, and a step's tool
 * calls run concurrently, so reading here would capture the file as it was
 * before the edit — the bytes are copied eagerly into the media store, so the
 * user then downloads a revision the reply does not describe. `PendingFileWrites`
 * makes the read wait for the writes to this same path first; see that module for
 * why the ordering holds. Waiting is free: the step already joins on every tool
 * promise before the next model call.
 *
 * Security model is inherited from the shell file tools: `resolvePath`
 * resolves relative paths against the workspace root and normalizes absolute
 * paths; `isInsideWorkspace` then rejects anything that escapes the workspace
 * (relative `..` traversal AND absolute paths outside it). Media type is
 * sniffed from magic bytes (clients/extensions lie), and the 10 MB cap mirrors
 * the inbound upload limit.
 */

import type { FileStat } from '../lib/execution-environments/execution-environment';
import * as path from 'path';
import { Tool, tool } from 'ai';
import { z } from 'zod';
import { resolvePath, isInsideWorkspace } from './shell/workspace';
import { resolveWorkspace } from '../lib/execution-environments/workspace';
import {
  filesFor,
  getExecutionEnvironment,
} from '../lib/execution-environments/get-execution-environment';

/** The filesystem holding a path, so a shared file is the one the thread's shell wrote. */
function files(forPath: string) {
  return filesFor(forPath);
}
import type { PendingFileWrites } from '../lib/pending-file-writes';
import { logger } from '../logger';
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

export interface ShareFileDeps {
  /** The step's announced writes. Absent means no sequencing — today's behaviour. */
  pendingWrites?: PendingFileWrites;
  /** This call's id, the key both the barrier and the canary are looked up by. */
  toolCallId?: string;
  /** The turn's signal, so a cancelled turn stops waiting instead of timing out. */
  abortSignal?: AbortSignal;
  /** Overridable for tests. */
  pendingWriteTimeoutMs?: number;
}

/**
 * Whether the file changed across a read: either it no longer matches the bytes
 * just read, or its mtime has moved on from the stat taken before that read.
 * Both halves matter — an edit that keeps the length is still a different file.
 */
function moved(
  before: FileStat,
  after: FileStat,
  data: Buffer,
): boolean {
  return after.size !== data.length || after.mtimeMs !== before.mtimeMs;
}

/**
 * How long to wait for a sibling write before refusing to share. Covers the
 * write itself plus the tool risk gate's own pre-execute model call, which can
 * delay a write's `fs.writeFile` by up to `RISK_EVALUATION_TIMEOUT_MS` after this
 * read begins. A constant rather than a setting: an operator has no way to know a
 * better value, and the wait costs no wall-clock in the normal case.
 */
export const PENDING_WRITE_TIMEOUT_MS = 20_000;

/**
 * Read a workspace file and persist it as an agent-sourced attachment.
 * Pure (no closure over user/agent) so it's unit-testable; the `workspace`
 * param defaults to the configured workspace root.
 */
export async function runShareFile(
  input: z.infer<typeof shareFileInput>,
  workspace: string = getExecutionEnvironment().workspaceRoot(),
  deps: ShareFileDeps = {},
): Promise<ShareFileSuccess | ShareFileFailure> {
  const fullPath = resolvePath(workspace, input.path);
  if (!isInsideWorkspace(fullPath, workspace)) {
    return { success: false, error: 'Path outside workspace' };
  }

  // Before the stat, not just before the read: a write that has not yet *created*
  // the file must be waited for too, or a batched create-and-share reports "file
  // not found" for a file the same step is writing.
  const barrier = await awaitPendingWrites(fullPath, deps);
  if (barrier) return barrier;

  let stat: FileStat;
  try {
    stat = await files(fullPath).stat(fullPath);
  } catch {
    return { success: false, error: `File not found: ${input.path}` };
  }
  if (stat.isDirectory) {
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

  // Read, then confirm the file did not move under the read. The barrier covers
  // the writes in this step; this catches the writers that outlive their call
  // (`coding_agent`, `shell_spawn`) in the one window where they are observable
  // at all. One retry: a second change means something is still writing, and
  // guessing which revision the reply describes is exactly the mistake being fixed.
  let data: Buffer;
  try {
    let before = stat;
    data = await files(fullPath).readBytes(fullPath);
    let after = await files(fullPath).stat(fullPath);
    if (moved(before, after, data)) {
      before = after;
      data = await files(fullPath).readBytes(fullPath);
      after = await files(fullPath).stat(fullPath);
      // Compare against the stat taken just before the retry, and on mtime as
      // well as size — a same-size edit is still a different revision, and size
      // alone would let one through.
      if (moved(before, after, data)) {
        return {
          success: false,
          error:
            `Not shared: ${input.path} is changing while it is read, so the attachment ` +
            `would not match what you describe. Wait for the write to finish, then share it.`,
        };
      }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Re-check the guards against the bytes actually read. The stat above can be
  // stale by now — a background writer may have grown the file past the cap or
  // truncated it to nothing — and `data` is what goes into the media store.
  if (data.length === 0) {
    return { success: false, error: `File is empty: ${input.path}` };
  }
  if (data.length > MAX_FILE_SIZE_BYTES) {
    return {
      success: false,
      error: `File too large (${(data.length / (1024 * 1024)).toFixed(1)} MB) — max ${MAX_FILE_SIZE_MB} MB.`,
    };
  }

  const filename = (input.filename?.trim() || path.basename(fullPath)) || 'file';
  const mediaType = detectMediaType(data, filename);
  const category = classifyMediaType(mediaType);

  const row = await attachmentService.create({
    filename,
    mediaType,
    // The bytes read, not `stat.size` from before the read: this value is what
    // every channel shows, so a stat taken earlier can label
    // the attachment with a size it does not have.
    sizeBytes: data.length,
    data,
    category,
    source: 'agent',
  });

  return {
    success: true,
    attachmentId: row.id,
    filename,
    sizeBytes: data.length,
    mediaType,
    category,
  };
}

/**
 * Wait for the step's writes that can change `fullPath`. Returns a failure to
 * hand straight back to the model, or `null` to carry on with the read.
 *
 * The canary is the `wasAnnounced` check. An empty registry is ambiguous — it
 * means either "no writes in this step" or "the announce hook never ran" — and
 * those must not be treated alike, or a future SDK change would silently restore
 * the defect. A share that cannot find its own id gives up on sequencing loudly
 * rather than concluding the step is clear.
 */
async function awaitPendingWrites(
  fullPath: string,
  deps: ShareFileDeps,
): Promise<ShareFileFailure | null> {
  const { pendingWrites, toolCallId } = deps;
  if (!pendingWrites) return null;

  if (!pendingWrites.wasAnnounced(toolCallId)) {
    logger.warn(
      { toolCallId },
      'share_file was not announced before executing — not sequencing it against this step\'s writes',
    );
    return null;
  }

  const outcome = await pendingWrites.waitFor(fullPath, {
    timeoutMs: deps.pendingWriteTimeoutMs ?? PENDING_WRITE_TIMEOUT_MS,
    abortSignal: deps.abortSignal,
  });
  if (outcome.status === 'none') return null;

  if (outcome.status === 'settled') {
    logger.info(
      { toolNames: outcome.toolNames, elapsedMs: outcome.elapsedMs },
      'share_file waited for writes in its own step that can change the file',
    );
    return null;
  }

  const writer = outcome.toolNames[0] ?? 'a write';
  const reason =
    outcome.status === 'aborted'
      ? 'the turn was cancelled'
      : outcome.status === 'cleared'
        ? 'it was abandoned before it finished'
        : 'it has not returned';
  return {
    success: false,
    error:
      `Not shared: ${writer} can change ${path.basename(fullPath)}, ran in this same tool block, and ${reason}. ` +
      `share_file captures the file when it runs, so the attachment would have held the bytes from before that write. ` +
      // Deliberately not "once the write has returned its result": the write may
      // have been rejected outright (the tool risk gate blocks before the handler
      // runs), in which case waiting for a result it will never produce is a
      // dead end. Check the write's own outcome first.
      `Check that write's result: if it succeeded, share the file again in your next step and the download will match ` +
      `what you describe; if it was rejected or failed, say so instead of describing a file you did not write.`,
  };
}

/**
 * Tool name whose results carry an `attachmentId` to be delivered. Exported so
 * `invoke.ts` can recognise the tool without duplicating the string.
 */
export const SHARE_FILE_TOOL_NAME = 'share_file';

/**
 * `workspaceRoot` must be the same per-thread root the shell tools resolve, or a
 * relative path means two different files to the two halves of write-then-share —
 * and the barrier's path comparison would never match.
 */
export function getShareFileTools(
  workspaceRoot?: string,
  pendingWrites?: PendingFileWrites,
): Record<string, Tool> {
  const workspace = resolveWorkspace(workspaceRoot);
  return {
    [SHARE_FILE_TOOL_NAME]: tool({
      description:
        'Share a file from your workspace with the user as a downloadable attachment. ' +
        'Use this whenever the user asks for a file, report, export, document, image, or generated artifact — ' +
        'first create it on disk (e.g. with shell_write_file or shell_exec), then call share_file with its path. ' +
        'The file is delivered as a download in the web/CLI chat and uploaded natively to Slack. ' +
        'Max 10 MB per file. Do NOT paste large file contents into your reply or invent download links — use this tool.',
      inputSchema: shareFileInput,
      // Announce this call so it can tell "no pending writes" from "the hook that
      // records them never ran". See `awaitPendingWrites`.
      onInputAvailable: ({ toolCallId }) =>
        pendingWrites?.announce(toolCallId, SHARE_FILE_TOOL_NAME),
      execute: async (input, { toolCallId, abortSignal }) =>
        runShareFile(input, workspace, { pendingWrites, toolCallId, abortSignal }),
    }),
  };
}
