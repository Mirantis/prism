/**
 * Spending Routes — estimated model spend, from `spendingService`.
 *
 * GET /agents/spending                       — totals for a range (`from`, `to`; default the last 30 days).
 * GET /agents/spending/periods               — per day, week or month (`period`, `count`, `timezone`).
 * GET /agents/spending/threads               — threads by spend (`from`, `to`, `limit`, `offset`).
 * GET /agents/spending/threads/:threadId     — one thread, with its requests.
 * GET /agents/spending/requests/:requestId   — one request.
 * GET /agents/spending/sources               — one category per task, webhook or goal (`category`, `from`, `to`).
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { isTimeZone } from '../lib/zoned-time';
import { agentWorkspaceService } from '../services/agent-workspace.service';
import {
  SOURCED_CATEGORIES,
  spendingService,
  type SourcedCategory,
  type SpendPeriod,
  type SpendRange,
} from '../services/spending.service';

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;

/** Periods listed by default and at most, per period length. */
const PERIOD_COUNTS: Record<SpendPeriod, { fallback: number; max: number }> = {
  day: { fallback: 30, max: 366 },
  week: { fallback: 12, max: 104 },
  month: { fallback: 12, max: 36 },
};

/** A request parameter the route refuses with 400. */
class BadParam extends Error {}

function integer(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const text = String(raw);
  const parsed = Number.parseInt(text, 10);
  if (!/^\d+$/.test(text) || parsed < min || parsed > max) {
    throw new BadParam(`${name} must be an integer in ${min}..${max}`);
  }
  return parsed;
}

function instant(raw: unknown, name: string, fallback: Date): Date {
  if (raw === undefined) return fallback;
  const parsed = Date.parse(String(raw));
  if (Number.isNaN(parsed)) throw new BadParam(`${name} must be an ISO 8601 time`);
  return new Date(parsed);
}

function range(req: Request): SpendRange {
  const to = instant(req.query.to, 'to', new Date());
  const from = instant(req.query.from, 'from', new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS));
  if (from >= to) throw new BadParam('from must be before to');
  return { from, to };
}

function period(raw: unknown): SpendPeriod {
  if (raw === undefined) return 'day';
  if (raw === 'day' || raw === 'week' || raw === 'month') return raw;
  throw new BadParam('period must be day, week or month');
}

function sourcedCategory(raw: unknown): SourcedCategory {
  if (SOURCED_CATEGORIES.includes(raw as SourcedCategory)) return raw as SourcedCategory;
  throw new BadParam(`category must be one of ${SOURCED_CATEGORIES.join(', ')}`);
}

/** The zone a period is read in: the request's, else the agent's own. */
async function timeZone(raw: unknown): Promise<string> {
  if (raw === undefined) return (await agentWorkspaceService.getAgent()).timezone;
  const name = String(raw);
  if (!isTimeZone(name)) throw new BadParam('timezone must be an IANA time zone name');
  return name;
}

/** Answers what `read` returns, a 400 for a bad parameter, a 404 for null and a 500 for anything else. */
function handle(read: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const body = await read(req);
      if (body === null) {
        res.status(404).json({ error: 'No spending recorded' });
        return;
      }
      res.json(body);
    } catch (error: unknown) {
      if (error instanceof BadParam) {
        res.status(400).json({ error: error.message });
        return;
      }
      logger.error({ err: error }, '[Spending] Failed to read spending');
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  };
}

router.get('/spending', handle(async (req) => {
  const { from, to } = range(req);
  return { from: from.toISOString(), to: to.toISOString(), ...(await spendingService.summary({ from, to })) };
}));

router.get('/spending/periods', handle(async (req) => {
  const length = period(req.query.period);
  const { fallback, max } = PERIOD_COUNTS[length];
  const count = integer(req.query.count, 'count', fallback, 1, max);
  const zone = await timeZone(req.query.timezone);
  return { period: length, timezone: zone, periods: await spendingService.periods(length, count, zone) };
}));

router.get('/spending/threads', handle(async (req) => {
  const { from, to } = range(req);
  const limit = integer(req.query.limit, 'limit', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = integer(req.query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  return { from: from.toISOString(), to: to.toISOString(), ...(await spendingService.threads({ from, to }, limit, offset)) };
}));

router.get('/spending/threads/:threadId', handle((req) => spendingService.thread(String(req.params.threadId))));

router.get('/spending/requests/:requestId', handle((req) => spendingService.request(String(req.params.requestId))));

router.get('/spending/sources', handle(async (req) => {
  const category = sourcedCategory(req.query.category);
  const { from, to } = range(req);
  return { category, from: from.toISOString(), to: to.toISOString(), sources: await spendingService.sources(category, { from, to }) };
}));

export { router as spendingRouter };
