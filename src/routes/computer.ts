import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import type { SignInOutcome } from '../services/computer/computer.service';
import { computerHelpService } from '../services/computer/computer-help.service';

/** Help requests, answered wherever the user sees them; each computer's own routes are in `computers.ts`. */
export const computerRouter = Router();
computerRouter.use((_req, res, next) => {
  if (!config.agentId) {
    res.status(503).json({ error: 'Agent is not initialized.' });
    return;
  }
  next();
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
  // A page that asks for both takes both: signing in with an empty username would clear
  // the field the page filled in for itself and submit a sign-in that cannot work.
  if (help.credentialFields !== 'password' && !body.data.username) {
    res.status(400).json({ error: 'A username is required.' });
    return;
  }
  const outcome = await computerHelpService.sessionOf(help).signIn(
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
