/**
 * Update Routes
 *
 * GET  /agents/update/status — updater state: enabled/reason, current and
 *      latest version, whether an update is available, and the last attempt.
 *      A failed check is not an error here — latestVersion just stays null.
 * POST /agents/update — check now, then apply the newer release (manual
 *      trigger; bypasses the idle gate the automatic path waits on). Responds
 *      202 `{ ok, version }` before the download starts — staging can take
 *      minutes, longer than HTTP client timeouts — and the apply runs on. Its
 *      progress arrives as WS `update` frames, its outcome lands in the
 *      attempt record, and clients poll /agents/update/status until the
 *      runtime reports the new version.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { UpdateInProgressError, updateService } from '../services/update/update.service';

const router = Router();

router.get('/update/status', async (_req: Request, res: Response) => {
  try {
    res.json(await updateService.getStatus());
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Update] Failed to read update status');
    res.status(500).json({ error: msg });
  }
});

router.post('/update', async (_req: Request, res: Response) => {
  try {
    const status = await updateService.getStatus();
    if (!status.enabled) {
      res.status(409).json({ error: `Updates are not available in this install (${status.reason}).` });
      return;
    }
    if (status.applying) {
      res.status(409).json({ error: 'An update is already in progress.' });
      return;
    }

    const latest = await updateService.checkNow();
    if (latest === null) {
      res.status(502).json({ error: 'Could not check for updates. Try again later.' });
      return;
    }
    const fresh = await updateService.getStatus();
    if (!fresh.updateAvailable) {
      res.status(409).json({ error: `Already up to date (${status.currentVersion}).` });
      return;
    }

    // Accept synchronously (single-flight claimed, attempt row persisted —
    // the outcome is recorded whatever happens next), then let staging and
    // activation run on. A completion failure is recorded on the row and
    // announced as a WS `failed` frame, which is what the clients poll/watch.
    const { completion } = await updateService.startApply(latest, 'MANUAL');
    void completion
      .then(({ willExit }) => {
        if (willExit) updateService.scheduleRestartExit();
      })
      .catch((error: unknown) => {
        logger.warn(
          `[Update] manual update to ${latest} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    res.status(202).json({ ok: true, version: latest });
  } catch (error: unknown) {
    if (error instanceof UpdateInProgressError) {
      // An automatic apply won the race between the status check and this
      // call — it carries the user's intent out anyway.
      res.status(409).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Update] Manual update failed');
    res.status(500).json({ error: msg });
  }
});

export { router as updateRouter };
