import { Router, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { computerHelpService } from '../services/computer/computer-help.service';
import { computerService, LOCAL_COMPUTER_ID } from '../services/computer/computer.service';
import type { ComputerSession } from '../services/computer/computer-session';
import { PLATFORMS } from '../services/computer/remote/link-protocol';
import {
  ComputerNameTakenError,
  remoteComputerService,
} from '../services/computer/remote/remote-computer.service';

/**
 * The agent's computers: the runtime's own desktop as `local`, and the remote computers a
 * client adds. Each computer's control routes act on that computer alone.
 */
export const computersRouter = Router();
computersRouter.use((_req, res, next) => {
  if (!config.agentId) {
    res.status(503).json({ error: 'Agent is not initialized.' });
    return;
  }
  next();
});

const name = z.string().trim().min(1).max(100);

function summaryOf(id: string) {
  return computerService.summaries().find((item) => item.id === id) ?? null;
}

/**
 * The computer a route names. The `/computer/…` paths name the runtime's own, as they did
 * before there were others; the shipped desktop app calls them.
 */
function idOf(params: { id?: string }): string {
  return params.id ?? LOCAL_COMPUTER_ID;
}

/** The computer `:id` names, or a 404 answered for it. */
function sessionFor(id: string, res: Response): ComputerSession | null {
  const session = computerService.session(id);
  if (!session) res.status(404).json({ error: 'There is no such computer.' });
  return session ?? null;
}

computersRouter.get('/computers', (_req, res) => {
  res.json({ computers: computerService.summaries() });
});

computersRouter.post('/computers', async (req, res) => {
  const body = z
    .object({
      name,
      platform: z.enum(PLATFORMS).optional(),
      installationId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A computer needs a name of 1 to 100 characters.' });
    return;
  }
  try {
    const { computer, created } = await remoteComputerService.add(body.data, config.ownerUserId);
    computerService.emit('change');
    res.status(created ? 201 : 200).json({ computer: summaryOf(computer.id) });
  } catch (error) {
    if (error instanceof ComputerNameTakenError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logger.warn({ err: error }, '[Computer] Could not add a computer');
    res.status(500).json({ error: 'Could not add the computer.' });
  }
});

computersRouter.get(['/computers/:id', '/computer'], async (req, res) => {
  const session = sessionFor(idOf(req.params), res);
  if (!session) return;
  try {
    const help = await computerHelpService.list(config.agentId!, config.ownerUserId);
    res.json({
      ...summaryOf(session.id),
      ...session.status(),
      help: help.filter((item) => computerHelpService.sessionOf(item) === session),
      awaitingHelp: computerHelpService.awaiting(),
    });
  } catch (error) {
    logger.warn({ err: error }, '[Computer] Status failed');
    res.status(500).json({ error: 'Could not load computer status.' });
  }
});

computersRouter.patch('/computers/:id', async (req, res) => {
  if (req.params.id === LOCAL_COMPUTER_ID) {
    res.status(409).json({ error: "The runtime's own computer cannot be renamed." });
    return;
  }
  if (!sessionFor(req.params.id, res)) return;
  const body = z.object({ name }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'A computer needs a name of 1 to 100 characters.' });
    return;
  }
  try {
    await remoteComputerService.rename(req.params.id, body.data.name);
    computerService.emit('change');
    res.json(summaryOf(req.params.id));
  } catch (error) {
    if (error instanceof ComputerNameTakenError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logger.warn({ err: error }, '[Computer] Could not rename a computer');
    res.status(500).json({ error: 'Could not rename the computer.' });
  }
});

computersRouter.delete('/computers/:id', async (req, res) => {
  if (req.params.id === LOCAL_COMPUTER_ID) {
    res.status(409).json({ error: "The runtime's own computer cannot be removed." });
    return;
  }
  try {
    if (!(await computerService.remove(req.params.id, config.ownerUserId))) {
      res.status(404).json({ error: 'There is no such computer.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    logger.warn({ err: error }, '[Computer] Could not remove a computer');
    res.status(500).json({ error: 'Could not remove the computer.' });
  }
});

const control = z.object({ clientId: z.string().uuid(), helpId: z.string().uuid().optional() });

computersRouter.post(['/computers/:id/control', '/computer/control'], async (req, res) => {
  const session = sessionFor(idOf(req.params), res);
  if (!session) return;
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
    // still running, and so is one about another computer.
    if (parsed.data.helpId && (!help || computerHelpService.sessionOf(help) !== session)) {
      res.status(404).json({ error: 'That help request is gone. Reload Computer.' });
      return;
    }
    await session.takeControl(parsed.data.clientId, help && { id: help.id, targetId: help.targetId });
    res.json(session.status());
  } catch (error) {
    res.status(409).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

computersRouter.post(['/computers/:id/continue', '/computer/continue'], async (req, res) => {
  const session = sessionFor(idOf(req.params), res);
  if (!session) return;
  const parsed = control.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'A connected Computer viewer is required.' });
    return;
  }
  try {
    await session.handBack(parsed.data.clientId);
    res.json(session.status());
  } catch (error) {
    res.status(409).json({ error: String(error instanceof Error ? error.message : error) });
  }
});

computersRouter.post(['/computers/:id/stop', '/computer/stop'], (req, res) => {
  const session = sessionFor(idOf(req.params), res);
  if (!session) return;
  session.access.stop();
  res.json({ success: true });
});
