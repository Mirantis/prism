/**
 * Single-Agent Routes
 *
 * No-auth read endpoints. The runtime owns exactly one agent and has no
 * backend in front of it, so a local client (prism-cli) can fetch the
 * active thread and recent messages without a token.
 *
 *   GET /single-agent/active-thread       — { threadId }
 *   GET /single-agent/messages?limit=N    — ConversationMessage[]
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { conversationService } from '../services/conversation.service';
import { attachmentService } from '../services/attachment.service';

const router = Router();

router.get('/active-thread', async (_req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Single-agent mode not initialized (agentId unset)' });
      return;
    }
    const thread = await conversationService.getOrCreateActiveThread(
      config.agentId,
      config.ownerUserId,
    );
    res.json({ threadId: thread.id });
  } catch (err) {
    logger.error({ err }, '[SingleAgent] /active-thread failed');
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

    const thread = await conversationService.getOrCreateActiveThread(
      config.agentId,
      config.ownerUserId,
    );
    const messages = await conversationService.getRecentMessages(thread.id, limit);
    const sorted = [...messages].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    // Attach shared-file metadata (no bytes) so the TUI renders 📎 chips on
    // history — same enrichment as conversationService.getThread.
    const metaMap = await attachmentService.getMetaByMessageIds(sorted.map((m) => m.id));
    res.json(
      sorted.map((m) => {
        const attachments = metaMap.get(m.id);
        return attachments && attachments.length > 0 ? { ...m, attachments } : m;
      }),
    );
  } catch (err) {
    logger.error({ err }, '[SingleAgent] /messages failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export const singleAgentRouter = router;
