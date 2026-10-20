/**
 * Message Routes
 *
 * Root-mounted history replay. The runtime owns exactly one agent, so no
 * agent id appears in the path — the handler reads `config.agentId`.
 *
 *   GET /messages?limit=N&threadId&before — ConversationMessage[] (threadId
 *       optional, defaults to the latest thread; `before` is a message id, and
 *       the page ends just before it)
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import { conversationService } from '../services/conversation.service';
import { attachmentService } from '../services/attachment.service';
import { MAX_MESSAGE_PAGE } from '../constants';

const router = Router();

router.get('/messages', async (req: Request, res: Response) => {
  try {
    if (!config.agentId) {
      res.status(503).json({ error: 'Agent not initialized (agentId unset)' });
      return;
    }
    const raw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_MESSAGE_PAGE) : 50;

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
    // A page shorter than `limit` holds the thread's first message.
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
    const messages = await conversationService.getRecentMessages(threadId, limit, before);
    // Oldest first, a tie broken by id: the order every chat client keeps.
    const sorted = [...messages].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
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
