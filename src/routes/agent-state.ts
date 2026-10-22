/**
 * Agent State Route
 *
 * GET /agents/state — `{"state": "working" | "idle"}`: working while a turn runs
 * or waits, or other work is in flight (`services/agent-activity.ts`). The other
 * agents of the project read it through the delivery service's `list_agents`.
 */

import { Router, Request, Response } from 'express';
import { isAgentIdle } from '../services/agent-activity';

const router = Router();

router.get('/state', async (_req: Request, res: Response) => {
  res.json({ state: (await isAgentIdle()) ? 'idle' : 'working' });
});

export { router as agentStateRouter };
