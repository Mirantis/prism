/**
 * Single-Agent Routes
 *
 * No-auth endpoints. The runtime owns exactly one agent and has no
 * backend in front of it, so a local client (prism-cli) can fetch a
 * thread's recent messages — and start a fresh session — without a token.
 *
 *   GET  /latest-thread             — { threadId }
 *   GET  /messages?limit=N&threadId — ConversationMessage[] (threadId optional;
 *                                     defaults to the latest thread)
 *   GET  /threads                   — ThreadSummary[] (resume picker)
 *   POST /threads                   — { threadId } (starts a new thread)
 */

import { Router, Request, Response } from 'express';
import { ThreadSource } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { conversationService } from '../services/conversation.service';
import { attachmentService } from '../services/attachment.service';
import { getGitBranch } from '../utils/git-branch';

const router = Router();

router.get('/latest-thread', async (_req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Single-agent mode not initialized (agentId unset)' });
      return;
    }
    const thread = await conversationService.getOrCreateLatestThread(
      config.agentId,
      config.ownerUserId,
    );
    res.json({ threadId: thread.id });
  } catch (err) {
    logger.error({ err }, '[SingleAgent] /latest-thread failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/messages', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Single-agent mode not initialized (agentId unset)' });
      return;
    }
    const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;

    // Optional ?threadId: replay a specific thread (the CLI's --resume flow).
    // Ownership-checked via getThread — 404 when it doesn't belong to this
    // agent+user. Without it, fall back to the latest thread.
    const requested = req.query.threadId;
    let threadId: string;
    if (typeof requested === 'string' && requested) {
      const owned = await conversationService.getThread(
        config.ownerUserId,
        config.agentId,
        requested,
      );
      if (!owned) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      threadId = owned.id;
    } else {
      const thread = await conversationService.getOrCreateLatestThread(
        config.agentId,
        config.ownerUserId,
      );
      threadId = thread.id;
    }
    const messages = await conversationService.getRecentMessages(threadId, limit);
    const sorted = [...messages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    // Attach shared-file metadata (no bytes) so the TUI renders 📎 chips on
    // history — same enrichment as conversationService.getThread.
    res.json(await attachmentService.attachMetaToMessages(sorted));
  } catch (err) {
    logger.error({ err }, '[SingleAgent] /messages failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/threads', async (_req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Single-agent mode not initialized (agentId unset)' });
      return;
    }
    // Resumable threads only (newest first): threadSource DATABASE drops Slack
    // threads, which the resume picker can't open. 50 leaves the scrollable
    // picker plenty beyond its 5 visible rows. Each row is labelled with the
    // git branch of its workspace root when set.
    const threads = await conversationService.listThreads(
      config.ownerUserId,
      config.agentId,
      { threadSource: ThreadSource.DATABASE, limit: 50 },
    );
    const summaries = await Promise.all(
      threads.map(async (t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        workspaceRoot: t.workspaceRoot,
        branch: t.workspaceRoot ? await getGitBranch(t.workspaceRoot) : null,
      })),
    );
    res.json(summaries);
  } catch (err) {
    logger.error({ err }, '[SingleAgent] GET /threads failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/threads', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Single-agent mode not initialized (agentId unset)' });
      return;
    }
    // Optional: the directory the client (CLI) is rooted in, persisted on the
    // new thread so shell tools can use it as their cwd. Ignored unless a
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
    logger.error({ err }, '[SingleAgent] POST /threads failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export const singleAgentRouter = router;
