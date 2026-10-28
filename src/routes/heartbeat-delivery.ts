/**
 * Heartbeat Delivery Route
 *
 * GET /agents/heartbeat/delivery — where a heartbeat run may post:
 * `{ deliverTo, channelIds }`.
 *
 * PATCH /agents/heartbeat/delivery — change `deliverTo` (a `DELIVER_TARGETS`
 * value) and `channelIds` (linked channels of that target's channel; `null`
 * clears them). An invalid value is refused with 400.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import { agentStatusService } from '../services/agent-status.service';
import { trackEvent } from '../lib/telemetry';
import { config } from '../config';

const router = Router();

router.get('/heartbeat/delivery', async (_req: Request, res: Response) => {
  try {
    res.json(await agentStatusService.getHeartbeatDelivery());
  } catch (error: unknown) {
    logger.error({ err: error }, '[HeartbeatDelivery] Failed to read the heartbeat delivery');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.patch('/heartbeat/delivery', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await agentStatusService.updateHeartbeatDelivery({ deliverTo: body.deliverTo, channelIds: body.channelIds });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    trackEvent('heartbeat delivery updated', null, {
      ...(config.agentId ? { 'agent.id': config.agentId } : {}),
      'heartbeat.deliver_to': result.value.deliverTo,
      'heartbeat.channels': String(result.value.channelIds.length),
    });
    res.json(result.value);
  } catch (error: unknown) {
    logger.error({ err: error }, '[HeartbeatDelivery] Failed to update the heartbeat delivery');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export { router as heartbeatDeliveryRouter };
