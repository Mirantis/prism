/**
 * Thread Routes
 *
 * Root-mounted endpoints to resolve, list, and open threads. The runtime
 * owns exactly one agent, so no agent id appears in the path — every
 * handler reads `config.agentId`.
 *
 *   GET  /latest-thread — { threadId }
 *   GET  /threads       — ThreadSummary[] (resumable threads, newest first;
 *                         `?workspaceRoot` keeps the ones rooted in that folder)
 *   POST /threads       — { threadId } (starts a new thread)
 */

import { Router, Request, Response } from 'express';
import { ThreadSource } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { conversationService } from '../services/conversation.service';
import { getGitBranch } from '../utils/git-branch';
import { buildContextSnapshot } from '../lib/context-window';

const router = Router();

router.get('/latest-thread', async (_req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    const thread = await conversationService.getOrCreateLatestThread(
      config.agentId,
      config.ownerUserId,
    );
    res.json({ threadId: thread.id });
  } catch (err) {
    logger.error({ err }, '[Threads] /latest-thread failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/threads', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    // A client that works in one folder lists that folder's threads, so the 50
    // are that folder's newest and not every folder's.
    const root: unknown = req.query.workspaceRoot;
    const workspaceRoot = typeof root === 'string' && root ? root : undefined;
    // Resumable threads only (newest first): threadSource DATABASE drops the
    // threads a channel reads live, which reopen only there. 50 bounds the response
    // while leaving a scrollable list plenty of rows. Each row is labelled with
    // the git branch of its workspace root when set.
    const threads = await conversationService.listThreads(
      config.ownerUserId,
      config.agentId,
      { threadSource: ThreadSource.DATABASE, limit: 50, ...(workspaceRoot ? { workspaceRoot } : {}) },
    );
    // Resolve the git branch once per unique workspace root — many threads in
    // the same repo would otherwise each spawn a redundant `git` subprocess.
    const uniqueRoots = [
      ...new Set(threads.map((t) => t.workspaceRoot).filter((r): r is string => Boolean(r))),
    ];
    const branchByRoot = new Map<string, string | null>();
    await Promise.all(
      uniqueRoots.map(async (root) => {
        branchByRoot.set(root, await getGitBranch(root));
      }),
    );
    const summaries = threads.map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      workspaceRoot: t.workspaceRoot,
      branch: t.workspaceRoot ? branchByRoot.get(t.workspaceRoot) ?? null : null,
      // Carries the thread's context percentage up front, so a resumed session can
      // show it without waiting for the first turn of that thread to complete.
      contextUsage: buildContextSnapshot(t.id, t.contextModel, t.contextTokens),
    }));
    res.json(summaries);
  } catch (err) {
    logger.error({ err }, '[Threads] GET /threads failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/threads', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    // Optional: the directory the caller is rooted in, persisted on the new
    // thread so shell tools can use it as their cwd. Ignored unless a
    // non-empty string.
    const raw: unknown = req.body?.workspaceRoot;
    const workspaceRoot = typeof raw === 'string' && raw.trim() ? raw : undefined;
    const thread = await conversationService.startNewThread(
      config.agentId,
      config.ownerUserId,
      workspaceRoot ? { workspaceRoot } : undefined,
    );
    res.json({ threadId: thread.id });
  } catch (err) {
    logger.error({ err }, '[Threads] POST /threads failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export const threadsRouter = router;
