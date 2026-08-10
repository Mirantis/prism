/**
 * Boot-time attachment storage reconciliation.
 *
 * Brings the attachment rows and the media dir back into agreement after a
 * `.prism` import onto another install, a lost volume, or an upgrade from the
 * legacy in-database BLOB storage. Runs once per process from `index.ts`.
 */

import { config } from '../config';
import { logger } from '../logger';
import { attachmentService } from '../services/attachment.service';

/**
 * Reconcile attachment storage, in dependency order. All three steps run
 * before listen() — acceptable because expiry runs first, so the backfill only
 * ever exports content younger than the TTL (bounded work), and a per-row
 * failure is logged and retried next boot rather than thrown.
 *
 * @param mediaDir Media file root, reported with the backfill result.
 */
export async function reconcileAttachmentStorage(mediaDir: string): Promise<void> {
  // 1. Rows pointing at media files that no longer exist (a `.prism` import
  //    onto another install, a lost volume) go back to storagePath = null.
  const reconciled = await attachmentService.reconcileMissingFiles();
  if (reconciled > 0) {
    logger.warn('[Attachments] %d row(s) pointed at missing media files; marked expired', reconciled);
  }

  // 2. Expire over-TTL content now — clearing legacy BLOBs *before* the
  //    backfill, so a long-lived database doesn't write years of old BLOBs to
  //    disk only to unlink them minutes later.
  try {
    const expired = await attachmentService.expireContent(config.attachmentContentTtlMs);
    if (expired > 0) logger.info(`[Attachments] expired content of ${expired} attachment(s)`);
  } catch (err) {
    logger.error({ err }, '[Attachments] boot content expiry failed');
  }

  // 3. Migrate the surviving legacy BLOB rows to media files (idempotent; a
  //    migrated database matches nothing).
  const backfill = await attachmentService.backfillBlobsToFiles();
  if (backfill.migrated > 0 || backfill.failed > 0) {
    logger.info(
      '[Attachments] backfilled %d BLOB row(s) to %s (%d failed)',
      backfill.migrated,
      mediaDir,
      backfill.failed,
    );
  }
}
