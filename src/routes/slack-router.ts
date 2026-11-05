/**
 * Slack router route.
 *
 * POST /agents/slack/router — where a Slack router delivers Slack events and
 * the agent's Slack links in routed mode. The `slack` listener
 * (`services/slack-router.service.ts`) serves this route alone, on
 * `SLACK_PORT`.
 *
 * The ingress in front verifies the router's signature, removes any
 * `x-nexus-webhook-verified` the caller sent, and adds
 * `x-nexus-webhook-verified: 1`; a Lens Agents `webhook` port does all three.
 * A request without that header is refused before its body is read.
 *
 * The header proves nothing on its own: anyone who reaches `SLACK_PORT` past
 * the ingress can send it. Only the ingress may reach the port, so it must not
 * be published without one (docs/slack-router-protocol.md, "The ingress").
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { logger } from '../logger';
import type { RouterOutcome } from '../services/slack-router.service';

export const SLACK_ROUTER_PATH = '/agents/slack/router';

/** The largest envelope the router sends. */
const ENVELOPE_LIMIT = '1mb';

function requireVerified(req: Request, res: Response, next: NextFunction): void {
  if (req.get('x-nexus-webhook-verified') !== '1') {
    res.status(401).json({ ok: false, error: 'not_verified' });
    return;
  }
  next();
}

/** The `slack` listener's app: the route, and JSON answers for a body it cannot read. */
export function createSlackRouterApp(accept: (body: unknown) => Promise<RouterOutcome>): express.Express {
  const app = express();
  app.post(
    SLACK_ROUTER_PATH,
    requireVerified,
    express.json({ limit: ENVELOPE_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const outcome = await accept(req.body);
        switch (outcome) {
          case 'accepted':
          case 'dropped':
            res.json({ ok: true });
            return;
          case 'invalid':
            res.status(400).json({ ok: false, error: 'invalid_envelope' });
            return;
          case 'unavailable':
            res.status(503).json({ ok: false, error: 'unavailable' });
            return;
        }
      } catch (error: unknown) {
        logger.error({ err: error }, '[SlackRouter] Could not apply an envelope');
        res.status(500).json({ ok: false, error: 'internal_error' });
      }
    },
  );
  // A malformed or oversized body: the parser's status, in the route's shape.
  app.use((error: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ ok: false, error: status === 413 ? 'too_large' : 'invalid_envelope' });
  });
  return app;
}
