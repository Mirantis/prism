/**
 * Activity Routes
 *
 * GET /agents/activity/llm-usage        — token totals.
 * GET /agents/activity/tool-calls        — paged tool calls.
 * GET /agents/activity/webhook-runs      — paged webhook runs.
 * GET /agents/activity/webhook-runs/:id  — one run with the message it delivered.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { llmUsageService } from '../services/llm-usage.service';
import { toolCallHistoryService } from '../services/tool-call-history.service';
import { webhookRunService } from '../services/webhook-run.service';

const router = Router();

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 31;

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;

/** An absent or empty cursor starts at the newest entry. */
function cursorParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** An absent param takes the default; anything not an integer in 1..max is a 400. */
function positiveInt(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const text = String(raw);
  if (!/^\d+$/.test(text)) throw new RangeError(`must be an integer in 1..${max}`);
  const parsed = Number.parseInt(text, 10);
  if (parsed < 1 || parsed > max) throw new RangeError(`must be an integer in 1..${max}`);
  return parsed;
}

router.get('/activity/llm-usage', async (req: Request, res: Response) => {
  let windowHours: number;
  try {
    windowHours = positiveInt(req.query.hours, DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS);
  } catch (error: unknown) {
    res.status(400).json({ error: `hours ${(error as Error).message}` });
    return;
  }
  try {
    res.json(await llmUsageService.summarize(windowHours));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Activity] Failed to summarize LLM usage');
    res.status(500).json({ error: msg });
  }
});

router.get('/activity/tool-calls', async (req: Request, res: Response) => {
  let limit: number;
  try {
    limit = positiveInt(req.query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  } catch (error: unknown) {
    res.status(400).json({ error: `limit ${(error as Error).message}` });
    return;
  }
  try {
    res.json(await toolCallHistoryService.page(limit, cursorParam(req.query.cursor)));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Activity] Failed to list tool calls');
    res.status(500).json({ error: msg });
  }
});

router.get('/activity/webhook-runs', async (req: Request, res: Response) => {
  let limit: number;
  try {
    limit = positiveInt(req.query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  } catch (error: unknown) {
    res.status(400).json({ error: `limit ${(error as Error).message}` });
    return;
  }
  try {
    res.json(await webhookRunService.page(limit, cursorParam(req.query.cursor)));
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Activity] Failed to list webhook runs');
    res.status(500).json({ error: msg });
  }
});

router.get('/activity/webhook-runs/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const run = await webhookRunService.get(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Webhook run not found' });
      return;
    }
    res.json(run);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, '[Activity] Failed to read a webhook run');
    res.status(500).json({ error: msg });
  }
});

export { router as activityRouter };
