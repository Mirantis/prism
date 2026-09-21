import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { computerService, type SignInOutcome } from '../services/computer/computer.service';
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
    // A takeover naming a request is secure because of that request. One nothing
    // matches is refused, rather than granted as an ordinary takeover with the agent
    // still running.
    if (parsed.data.helpId && !help) {
      res.status(404).json({ error: 'That help request is gone. Reload Computer.' });
      return;
    }
    await computerService.takeControl(
      parsed.data.clientId,
      help && { id: help.id, targetId: help.targetId },
    );
    res.json(computerService.status());
  } catch (error) {
    res.status(409).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

computerRouter.post('/computer/continue', async (req, res) => {
  const parsed = control.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A connected Computer viewer is required.' });
    return;
  }
  try {
    await computerService.handBack(parsed.data.clientId);
    res.json(computerService.status());
  } catch (error) {
    res.status(409).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

computerRouter.post('/computer/stop', (_req, res) => {
  computerService.access.stop();
  res.json({ success: true });
});

/** What the user is told when a sign-in did not go in. */
const SIGN_IN_REFUSALS: Record<Exclude<SignInOutcome, 'filled'>, string> = {
  no_form: 'That page has no sign-in form any more. Open Computer and take control instead.',
  no_password_step:
    'That sign-in took the username and never asked for the password. Open Computer and take control instead.',
  tab_gone: 'The tab needing that sign-in has closed. Open Computer and take control instead.',
  site_changed: 'That tab is on another site now. Open Computer and take control instead.',
  in_use: 'Somebody has control of the computer. Hand it back, then try again.',
  error: 'The sign-in could not be entered. Open Computer and take control instead.',
};

/**
 * The username and the password for a sign-in the agent asked for.
 *
 * Nothing here is stored, logged or shown to a model: the values go to the browser, the
 * form is submitted, and the request resolves the way "I'm done" resolves it. A refusal
 * says what stopped it and leaves the request waiting, so the user can still take control
 * and sign in themselves.
 */
computerRouter.post('/computer/help/:id/credentials', async (req, res) => {
  const body = z
    .object({ username: z.string().max(200).default(''), password: z.string().min(1).max(500) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A password is required.' });
    return;
  }
  const help = (await computerHelpService.list(config.agentId!, config.ownerUserId)).find(
    (item) => item.id === String(req.params.id),
  );
  if (!help?.credentials || help.status !== 'waiting') {
    res.status(409).json({ error: 'That sign-in request is closed. Reload the page.' });
    return;
  }
  const outcome = await computerService.signIn(
    help,
    { username: body.data.username, password: body.data.password },
    config.ownerUserId,
    config.agentId,
  );
  if (outcome !== 'filled') {
    res.status(409).json({ error: SIGN_IN_REFUSALS[outcome] });
    return;
  }
  try {
    await computerHelpService.continueRequest(
      config.agentId!,
      config.ownerUserId,
      help.id,
      'continue',
    );
    res.json({ success: true });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
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
