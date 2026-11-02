import { Router } from 'express';
import { z } from 'zod';
import { CODING_AGENTS, type CodingAgentName } from '../config';
import { logger } from '../logger';
import {
  codingAgentSignInService,
  SignInClosedError,
  SignInUnavailableError,
} from '../services/coding-agent-sign-in/coding-agent-sign-in.service';

/**
 * The coding agents' subscriptions: which one each runs on, and signing in and
 * out. The code a Claude sign-in shows comes in here and goes to the CLI; it is
 * never stored, logged or shown to a model.
 */
export const codingAgentsRouter = Router();

const agentParam = (value: unknown): CodingAgentName | null =>
  CODING_AGENTS.includes(value as CodingAgentName) ? (value as CodingAgentName) : null;

codingAgentsRouter.get('/coding-agents', async (_req, res) => {
  res.json({ agents: await codingAgentSignInService.list() });
});

codingAgentsRouter.post('/coding-agents/:agent/sign-in', async (req, res) => {
  const agent = agentParam(req.params.agent);
  if (!agent) {
    res.status(404).json({ error: 'No such coding agent.' });
    return;
  }
  try {
    res.status(201).json(await codingAgentSignInService.start(agent));
  } catch (err) {
    if (!(err instanceof SignInUnavailableError)) throw err;
    res.status(409).json({ error: err.message });
  }
});

codingAgentsRouter.get('/coding-agents/:agent/sign-in/:id', (req, res) => {
  const agent = agentParam(req.params.agent);
  const attempt = agent && codingAgentSignInService.get(agent, String(req.params.id));
  if (!attempt) {
    res.status(404).json({ error: 'That sign-in has ended. Get a new link.' });
    return;
  }
  res.json(attempt);
});

codingAgentsRouter.post('/coding-agents/claude-code/sign-in/:id/code', async (req, res) => {
  const body = z.object({ code: z.string().trim().min(1).max(2048) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Paste the code the sign-in page shows.' });
    return;
  }
  try {
    res.json(await codingAgentSignInService.submitCode(String(req.params.id), body.data.code));
  } catch (err) {
    if (!(err instanceof SignInClosedError)) throw err;
    res.status(409).json({ error: err.message });
  }
});

codingAgentsRouter.post('/coding-agents/:agent/sign-out', async (req, res) => {
  const agent = agentParam(req.params.agent);
  if (!agent) {
    res.status(404).json({ error: 'No such coding agent.' });
    return;
  }
  try {
    res.json(await codingAgentSignInService.signOut(agent));
  } catch (err) {
    logger.error({ err, agent }, '[CodingAgents] Sign-out failed');
    res.status(500).json({ error: 'The sign-out failed. Try again.' });
  }
});
