/**
 * Locked-In Mode Route
 *
 * PATCH /agents/locked-in — freeze the workspace markdown files against the
 * agent's own tools. No tool reaches this route, so a locked agent cannot unlock
 * itself with a tool call. The route keeps working while locked, so the user is
 * never shut out.
 *
 * Auth is terminated by the platform in front of the container (same as every
 * other route), so the route takes no credential from inside it. A shell can
 * therefore reach it — see the known holes in `docs/configuration.md`.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { agentWorkspaceService, ValidationError } from '../services/agent-workspace.service';

const router = Router();

/**
 * PATCH /agents/locked-in
 * Body: { lockedIn: boolean }
 */
router.patch('/locked-in', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('lockedIn' in body)) {
      res.status(400).json({ error: "missing required field 'lockedIn'" });
      return;
    }
    const lockedIn = await agentWorkspaceService.updateLockedIn(body.lockedIn);
    res.json({ lockedIn });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[LockedIn] Failed to update locked-in mode');
    res.status(500).json({ error: msg });
  }
});

export { router as lockedInRouter };
