/**
 * Single-Agent Routes
 *
 * No-auth endpoints. The runtime owns exactly one agent and has no
 * backend in front of it, so a local client (prism-cli) can fetch the
 * latest thread and recent messages — and start a fresh session — without
 * a token.
 *
 *   GET  /single-agent/latest-thread       — { threadId }
 *   GET  /single-agent/messages?limit=N    — ConversationMessage[]
 *   POST /single-agent/threads             — { threadId } (starts a new thread)
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { conversationService } from '../services/conversation.service';
import { attachmentService } from '../services/attachment.service';

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

    const thread = await conversationService.getOrCreateLatestThread(
      config.agentId,
      config.ownerUserId,
    );
    const messages = await conversationService.getRecentMessages(thread.id, limit);
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
