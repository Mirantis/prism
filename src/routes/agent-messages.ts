/**
 * Agent Messages Route
 *
 * POST /agents/agent-messages — a message from another agent of the project,
 * posted by the delivery service. Served on `AGENT_MESSAGES_PORT` alone
 * (`createAgentMessagesApp` in `server.ts`), never on the main port. The ingress names the API token of each
 * caller in `x-forwarded-token-id`, and only the token `AGENT_MESSAGES_TOKEN_ID`
 * names may post here. The message is stored in the web conversation as that
 * agent's, and its turn is scheduled like a chat message's. The answer comes
 * once the message is stored, before the turn runs; the service sends a
 * delivery again until it gets one, and the same `id` is stored once.
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { uuid, uuidV4 } from '../protocol/chat-protocol';
import { agentConversationService } from '../services/agent-conversation.service';
import { conversationService } from '../services/conversation.service';
import { InboundMessageError, inboundMessageService } from '../services/inbound-message.service';

const router = Router();

/** The headers the ingress writes to name a person, and only a person. */
const PERSON_HEADERS = ['x-forwarded-user', 'x-forwarded-user-id'];

/**
 * The header the ingress writes with the id of the API token a caller used. It
 * drops any copy the caller sent, so it is to be trusted only for a request that
 * came through the ingress.
 */
const TOKEN_ID_HEADER = 'x-forwarded-token-id';

/** Why a request is not the delivery service's, or null when it is. */
function notTheDeliveryService(tokenId: string | undefined): { status: 401 | 503; reason: string } | null {
  const expected = config.agentMessagesTokenId;
  if (!expected) return { status: 503, reason: 'AGENT_MESSAGES_TOKEN_ID is not set' };
  if (!tokenId) return { status: 401, reason: 'the ingress named no API token' };
  return sameText(tokenId, expected) ? null : { status: 401, reason: 'another API token' };
}

/** Equal strings, compared in constant time whatever their lengths. */
function sameText(a: string, b: string): boolean {
  const digest = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

/** A sender's id or name on one line, as the prompt's attribute and every client show it. */
const oneLine = (max: number) =>
  z
    .string()
    .max(max)
    .transform((text) => text.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim())
    .refine((text) => text.length > 0, 'must not be blank');

const agentMessage = z
  .object({
    /** The delivery's id, which becomes the stored message's. */
    id: uuidV4,
    /** The message's own id, which a reply names. */
    messageId: uuid,
    conversationId: uuid,
    kind: z.enum(['message', 'notice']),
    sender: z.object({ id: oneLine(64), name: oneLine(128) }).strict(),
    content: z
      .string()
      .max(32_000)
      .refine((text) => text.trim().length > 0, 'content must not be blank'),
    expectsReply: z.boolean().default(false),
    attachmentIds: z.array(uuid).max(5).default([]),
  })
  .strict();

/** What each refusal of the inbound service is over HTTP. */
const REFUSALS: Partial<Record<InboundMessageError['code'], number>> = {
  unavailable: 503,
  unknown_thread: 404,
  id_conflict: 409,
};

router.post('/agent-messages', async (req: Request, res: Response) => {
  // The ingress names a person signed in to it with these headers. People talk
  // to the agent in the conversation, and refusing them here keeps a browser
  // from posting as another agent.
  if (PERSON_HEADERS.some((header) => req.get(header) !== undefined)) {
    res.status(403).json({ error: 'Only another agent of the project sends agent messages.' });
    return;
  }

  // The ingress admits every member of the project, their API tokens and other
  // agents among them, so only the token it names says who sent this. Checked
  // before anything in the body is read.
  const tokenId = req.get(TOKEN_ID_HEADER);
  const refusal = notTheDeliveryService(tokenId);
  if (refusal) {
    logger.warn(
      { reason: refusal.reason, status: refusal.status, tokenId: tokenId?.slice(0, 12) },
      '[AgentMessages] Refused a delivery',
    );
    res.status(refusal.status).json({
      error:
        refusal.status === 503
          ? 'Agent messages are not set up on this agent yet.'
          : 'Only the delivery service posts agent messages.',
    });
    return;
  }

  const parsed = agentMessage.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.' });
    return;
  }
  const body = parsed.data;

  const agentId = config.agentId;
  if (!agentId) {
    res.status(503).json({ error: 'The agent is still starting. Try again shortly.' });
    return;
  }

  try {
    // The web conversation that holds the conversation between agents, such as the
    // one whose message_agent call this answers. A new one goes to the one
    // conversation in single-thread mode, else to the newest.
    const threadId =
      (await agentConversationService.threadFor(body.conversationId, agentId)) ??
      (await conversationService.getOrCreateLatestThread(agentId, config.ownerUserId)).id;
    const acceptance = await inboundMessageService.accept({
      id: body.id,
      threadId,
      content: body.content,
      attachmentIds: body.attachmentIds,
      sender: null,
      agentMessage: {
        kind: body.kind === 'notice' ? 'notice' : body.expectsReply ? 'ask' : 'message',
        senderId: body.sender.id,
        senderName: body.sender.name,
        messageId: body.messageId,
      },
    });
    // The rest of this conversation between agents follows it here. The message
    // is stored either way, so a failure costs only where the next one goes.
    await agentConversationService
      .remember(body.conversationId, acceptance.message.threadId)
      .catch((err: unknown) => logger.warn({ err, deliveryId: body.id }, '[AgentMessages] Could not keep where the conversation is'));
    res.status(202).json({
      messageId: acceptance.message.id,
      threadId: acceptance.message.threadId,
      queued: acceptance.queued,
      duplicate: acceptance.duplicate,
    });
  } catch (error: unknown) {
    const status = error instanceof InboundMessageError ? REFUSALS[error.code] : undefined;
    if (status && error instanceof Error) {
      res.status(status).json({ error: error.message });
      return;
    }
    logger.error({ err: error, deliveryId: body.id }, '[AgentMessages] Could not store an agent message');
    res.status(500).json({ error: 'The message could not be stored.' });
  }
});

export { router as agentMessagesRouter };
