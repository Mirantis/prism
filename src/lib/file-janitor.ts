/**
 * Hourly janitor for the two durable stores that hold content a conversation
 * refers to but does not itself contain.
 *
 * Attachments: abandoned pre-send uploads (chip added but never sent), stale
 * hydrate scratch dirs, content past its TTL, and stray media files no row
 * references (cascade-deleted messages, imports).
 *
 * Saved tool outputs: everything past its TTL. Nothing references one, so there is
 * no live set to reconcile and no orphan case — mtime against the TTL is the whole
 * of it. Deleting a thread removes its saved outputs eagerly; this is the backstop
 * for what that misses.
 *
 * Every sweep step catches its own failure — one broken step must not stop the
 * others, and the next hour retries it.
 */

import { config } from '../config';
import { logger } from '../logger';
import { attachmentService } from '../services/attachment.service';
import { attachmentsHeldByChatWork } from '../services/conversation-engine.service';
import { reapScratchDirs } from '../tools/attachments';
import { reapStrayMediaFiles } from './media-store';
import { reapExpiredToolOutputs } from './tool-output-store';
import { prisma } from './prisma';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
// Grace before a stray media file may be reaped — covers the window between
// the file write and its row insert. Never shorten below 1 h.
const STRAY_MEDIA_GRACE_MS = 60 * 60 * 1000;

/** One full sweep. Never rejects. */
export async function sweepFiles(): Promise<void> {
  try {
    // A reply a restart interrupted still owes its files, however long the runtime was down.
    const deleted = await attachmentService.deleteOrphans(ORPHAN_TTL_MS, await attachmentsHeldByChatWork());
    if (deleted > 0) logger.info(`[Attachments] reaped ${deleted} orphaned upload(s)`);
  } catch (err) {
    logger.error({ err }, '[Attachments] orphan cleanup failed');
  }
  try {
    // hydrate_attachment writes under the *thread's* workspace root (a TUI
    // thread's launch cwd), not only the default shell workspace — sweep
    // every root we know about or CLI repos accumulate .attachments dirs.
    const threadRoots = await prisma.conversationThread.findMany({
      where: { workspaceRoot: { not: null } },
      select: { workspaceRoot: true },
      distinct: ['workspaceRoot'],
    });
    let reaped = 0;
    for (const root of [null, ...threadRoots.map((t) => t.workspaceRoot)]) {
      reaped += await reapScratchDirs(root, ORPHAN_TTL_MS);
    }
    if (reaped > 0) logger.info(`[Attachments] reaped ${reaped} stale scratch dir(s)`);
  } catch (err) {
    logger.error({ err }, '[Attachments] scratch dir cleanup failed');
  }
  try {
    const expired = await attachmentService.expireContent(config.attachmentContentTtlMs);
    if (expired > 0) logger.info(`[Attachments] expired content of ${expired} attachment(s)`);
  } catch (err) {
    logger.error({ err }, '[Attachments] content expiry failed');
  }
  try {
    const live = await attachmentService.listLiveStoragePaths();
    const strays = await reapStrayMediaFiles(live, STRAY_MEDIA_GRACE_MS);
    if (strays > 0) logger.info(`[Attachments] reaped ${strays} stray media file(s)`);
  } catch (err) {
    logger.error({ err }, '[Attachments] stray media cleanup failed');
  }
  try {
    const expired = await reapExpiredToolOutputs(config.toolOutputTtlMs);
    if (expired > 0) logger.info(`[ToolOutput] reaped ${expired} expired saved output(s)`);
  } catch (err) {
    logger.error({ err }, '[ToolOutput] saved output cleanup failed');
  }
}

/**
 * Sweep once now, then every hour. Returns the timer so the caller can clear
 * it on shutdown; it is unref'd, so it never holds the process open.
 */
export async function startFileJanitor(): Promise<NodeJS.Timeout> {
  await sweepFiles();
  const timer = setInterval(sweepFiles, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
