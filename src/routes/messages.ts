/**
 * Message Routes
 *
 * Root-mounted history replay. The runtime owns exactly one agent, so no
 * agent id appears in the path — the handler reads `config.agentId`.
 *
 *   GET /messages?limit=N&threadId — ConversationMessage[] (threadId optional;
 *                                    defaults to the latest thread)
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { conversationService } from '../services/conversation.service';
import { attachmentService } from '../services/attachment.service';

const router = Router();

router.get('/messages', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;

    // Optional ?threadId: replay a specific thread (the resume flow). Cheap
    // ownership check (no message load) — 404 when it doesn't belong to this
    // agent+user. getRecentMessages below does the single history read.
    // Without it, fall back to the latest thread.
    const requested = req.query.threadId;
    let threadId: string;
    if (typeof requested === 'string' && requested) {
      const owned = await conversationService.getOwnedThreadId(
        config.ownerUserId,
        config.agentId,
        requested,
      );
      if (!owned) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      threadId = owned;
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
    // Attach shared-file metadata (no bytes) so a client can render attachment
    // chips on history — same enrichment as conversationService.getThread.
    res.json(await attachmentService.attachMetaToMessages(sorted));
  } catch (err) {
    logger.error({ err }, '[Messages] /messages failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export const messagesRouter = router;
