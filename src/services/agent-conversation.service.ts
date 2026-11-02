/**
 * Agent Conversation Service
 *
 * Which web conversation holds each conversation between agents, so the next
 * message of one arrives beside the last. The delivery service gives every
 * message a `conversationId`: a new message starts one, and a reply, and a
 * notice about a message, carry the one it belongs to. The web conversation a
 * delivery lands in is kept under `agentConversation:<conversationId>` in
 * `runtime_state`. The runtime never reads the agent's own messages to other
 * agents, so an answer to one arrives where an unknown conversation does.
 */

import { config } from '../config';
import prisma from '../lib/prisma';
import { conversationService } from './conversation.service';
import { runtimeStateService } from './runtime-state.service';

const conversationKey = (conversationId: string) => `agentConversation:${conversationId}`;

class AgentConversationService {
  /**
   * The web conversation that holds `conversationId`, while a client can still
   * write to it. Null when none does yet, when it was deleted, and when
   * single-thread mode hides it.
   */
  async threadFor(conversationId: string, agentId: string): Promise<string | null> {
    const threadId = await runtimeStateService.get(conversationKey(conversationId));
    if (!threadId) return null;
    const thread = await prisma.conversationThread.findFirst({
      where: {
        id: threadId,
        agentId,
        userId: config.ownerUserId,
        externalThreadId: null,
        threadSource: 'DATABASE',
        AND: await conversationService.clientThreadFilter(agentId, config.ownerUserId),
      },
      select: { id: true },
    });
    return thread?.id ?? null;
  }

  /** Keep `conversationId` in the web conversation that now holds it. */
  async remember(conversationId: string, threadId: string): Promise<void> {
    await runtimeStateService.set(conversationKey(conversationId), threadId);
  }
}

export const agentConversationService = new AgentConversationService();
