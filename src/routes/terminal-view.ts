import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { trackEvent } from '../lib/telemetry';

export const terminalViewRouter = Router();
const lifecycleEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('started'), elapsedMs: z.number().int().nonnegative() }),
  z.object({ event: z.literal('finished'), elapsedMs: z.number().int().nonnegative(), status: z.enum(['success', 'error']) }),
]);

terminalViewRouter.post('/terminal-view/events', (req, res) => {
  const parsed = lifecycleEvent.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid terminal view event' });
    return;
  }
  const event = parsed.data;
  trackEvent(`terminal web view ${event.event}`, config.ownerUserId, {
    renderer: 'kitty',
    ...(event.event === 'finished' ? { status: event.status, elapsed_ms: String(event.elapsedMs) } : {}),
  });
  res.sendStatus(204);
});
