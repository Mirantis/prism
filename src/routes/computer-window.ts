import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';

export const computerWindowRouter = Router();
const event = z.object({ status: z.enum(['opened', 'closed', 'blocked']) });

computerWindowRouter.post('/computer-window/events', (req, res) => {
  const parsed = event.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Choose a computer window status.' });
    return;
  }
  trackEvent('computer window ' + parsed.data.status, config.ownerUserId, {
    agent_id: config.agentId ?? '',
  });
  res.sendStatus(204);
});
