/**
 * Inbound Webhook Route
 *
 * POST /agents/webhooks/:name — the ingestion endpoint external systems
 * (Alertmanager, PagerDuty, GitHub, …) POST events to. Agent-mode
 * subscriptions are fire-and-forget: the route answers 202 with a runId and
 * the agent's response is delivered to the subscription's channels when the
 * run finishes. Deliver-only subscriptions publish synchronously (200).
 *
 * The webhook listener serves this router alone, on `WEBHOOK_PORT`
 * (`webhook-receiver.service.ts`). A subscription can require its sender to
 * prove itself with a token or an HMAC signature, which the service verifies
 * before doing any work (401 on failure). Subscription CRUD lives in
 * routes/management.ts, on the main port.
 */

import { Router, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { webhookService } from '../services/webhook.service';
import { trackEvent } from '../lib/telemetry';
import { getRawBody } from '../lib/raw-body';
import { logger } from '../logger';

const router = Router();

// Some senders check the endpoint with a HEAD request before they save it.
// Every name answers 200, so the check reveals no subscription names.
router.head('/webhooks/:name', (_req: Request, res: Response) => {
  res.status(200).end();
});

router.post('/webhooks/:name', async (req: Request<{ name: string }>, res: Response) => {
  const { name } = req.params;
  try {
    const payload = req.body;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(400).json({ error: 'Body must be a JSON object' });
      return;
    }

    const runId = uuidv7();
    const result = await webhookService.handleInbound(
      name,
      payload as Record<string, unknown>,
      req.headers,
      runId,
      getRawBody(req),
    );

    // One owning emitter for 'webhook received' — every delivery attempt is
    // counted with its gate outcome. No user resolved on this hot path.
    trackEvent('webhook received', null, {
      'webhook.run_id': runId,
      'webhook.outcome':
        result.status === 'accepted' || result.status === 'delivered'
          ? 'accepted'
          : result.status === 'ignored'
            ? 'filtered'
            : result.status === 'unauthorized'
              ? 'unauthorized'
              : 'rejected',
      // Which scheme turned it away (generic: 'token' | 'hmac' | 'none'), so a
      // misconfigured secret is distinguishable from a probe.
      ...(result.status === 'unauthorized' ? { 'webhook.auth_type': result.authType } : {}),
    });

    switch (result.status) {
      case 'receiver_disabled':
        res.status(403).json({ error: 'Webhook receiver is disabled' });
        return;
      case 'not_found':
      case 'subscription_disabled':
      case 'unauthorized':
        // Hide subscription names, state and verification failure reasons.
        res.status(401).json({ error: 'Webhook sender verification failed' });
        return;
      case 'busy':
        res.status(429).json({ error: `Webhook "${name}" run queue is full — retry later` });
        return;
      case 'ignored':
        res.json({ status: 'ignored', event: result.event });
        return;
      case 'delivered':
        res.json({ status: 'delivered', event: result.event });
        return;
      case 'accepted':
        res.status(202).json({ status: 'accepted', event: result.event, runId });
        return;
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Webhook] Failed to handle inbound webhook '${name}': ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export const webhookRouter = router;
