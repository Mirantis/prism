import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { computerService } from '../services/computer/computer.service';
import { computerHelpService } from '../services/computer/computer-help.service';

export const computerRouter = Router();
computerRouter.use((_req, res, next) => {
  if (!config.agentId) {
    res.status(503).json({ error: 'Agent is not initialized.' });
    return;
  }
  next();
});

computerRouter.get('/computer', async (_req, res) => {
  try {
    res.json({
      ...computerService.status(),
      help: await computerHelpService.list(config.agentId!, config.ownerUserId),
    });
  } catch (error) {
    logger.warn({ err: error }, '[Computer] Status failed');
    res.status(500).json({ error: 'Could not load computer status.' });
  }
});

const control = z.object({ clientId: z.string().uuid(), helpId: z.string().uuid().optional() });
computerRouter.post('/computer/control', async (req, res) => {
  const parsed = control.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A connected Computer viewer is required.' });
    return;
  }
  try {
    const help = parsed.data.helpId
      ? (await computerHelpService.list(config.agentId!, config.ownerUserId)).find(
          (item) => item.id === parsed.data.helpId,
        )
      : undefined;
    await computerService.takeControl(parsed.data.clientId, help?.targetId);
    res.json(computerService.status());
  } catch (error) {
    res.status(409).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

computerRouter.post('/computer/continue', (req, res) => {
  const parsed = control.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A connected Computer viewer is required.' });
    return;
  }
  try {
    computerService.handBack(parsed.data.clientId);
    res.json(computerService.status());
  } catch (error) {
    res.status(409).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

computerRouter.post('/computer/stop', (_req, res) => {
  computerService.access.stop();
  res.json({ success: true });
});

computerRouter.post('/computer/help/:id', async (req, res) => {
  const body = z
    .object({ action: z.enum(['continue', 'dismiss']), clientId: z.string().uuid().optional() })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Choose continue or dismiss.' });
    return;
  }
  try {
    await computerHelpService.continueRequest(
      config.agentId!,
      config.ownerUserId,
      String(req.params.id),
      body.data.action,
      body.data.clientId,
    );
    res.json({ success: true });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
