/**
 * Model Selection Route
 *
 * GET /agents/model-selection — the agent's model mode (Fixed or Auto) and its
 * three Auto tiers, each as the stored value and the value in force after the
 * deployment default.
 *
 * PATCH /agents/model-selection — write any of `mode` ('fixed' | 'auto'),
 * `small`, `medium` and `large`. `null` clears a field back to the deployment
 * default. Auto needs a small and a large model; a write that leaves either
 * missing is refused with 400.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { agentWorkspaceService, ValidationError } from '../services/agent-workspace.service';

const router = Router();

router.get('/model-selection', async (_req: Request, res: Response) => {
  try {
    res.json(await agentWorkspaceService.getModelSelectionInfo());
  } catch (error: unknown) {
    logger.error({ err: error }, '[ModelSelection] Failed to read the model selection');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.patch('/model-selection', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(await agentWorkspaceService.updateModelSelection(body));
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, '[ModelSelection] Failed to update the model selection');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export { router as modelSelectionRouter };
