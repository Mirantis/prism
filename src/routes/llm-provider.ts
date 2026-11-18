/**
 * LLM Provider Route
 *
 * GET /agents/llm-provider — `{ provider, missingSettings }`: the selected LLM
 * provider and the settings it still needs before it can send a request, by
 * variable name. The clients warn while the list is not empty.
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { missingProviderSettings } from '../lib/llm-providers/create-provider';

const router = Router();

router.get('/llm-provider', async (_req: Request, res: Response) => {
  res.json({ provider: config.llmProvider, missingSettings: await missingProviderSettings() });
});

export { router as llmProviderRouter };
