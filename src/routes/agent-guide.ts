/**
 * Agent Guide Route
 *
 * PATCH /agents/agent-guide — replace the agent's operating manual (`agentMd`),
 * which reaches the system prompt as `# Agent Guide`. No tool writes this
 * document, so the user is its only author, and locked-in mode does not gate the
 * write — that lock covers the agent's own tools.
 *
 * This route exists for the shipped terminal UI, whose binary calls this URL.
 * `PATCH /agents/documents/:field` writes any of the seven documents, `agentMd`
 * included, and both reach `updateWorkspaceDoc`.
 *
 * Auth is terminated by the platform in front of the container, as for every
 * other route, so this one takes no credential from inside it.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { agentWorkspaceService, ValidationError } from '../services/agent-workspace.service';

const router = Router();

/**
 * PATCH /agents/agent-guide
 * Body: { agentMd: string, reason?: string } — the whole document; an empty
 * string clears it, which drops the `# Agent Guide` section from the prompt.
 * `reason` is the note the document's history shows for this write. There is no
 * concurrency control: the last write wins, so two editors open at once
 * overwrite each other instead of merging.
 */
router.patch('/agent-guide', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!('agentMd' in body)) {
      res.status(400).json({ error: "missing required field 'agentMd'" });
      return;
    }
    const agentMd = await agentWorkspaceService.updateWorkspaceDoc(
      'agentMd',
      body.agentMd,
      body.reason,
    );
    res.json({ agentMd });
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[AgentGuide] Failed to update the agent guide');
    res.status(500).json({ error: msg });
  }
});

export { router as agentGuideRouter };
