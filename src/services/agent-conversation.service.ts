/**
 * Agent Conversation Service
 *
 * Which web conversation holds each conversation between agents, so an answer
 * comes back where the question was asked. The delivery service gives every
 * message a `conversationId`: a new message starts one, and a reply, and a
 * notice about a message, carry the one it belongs to. The agent's own
 * `message_agent` call answers the id, and each delivery names it. The web
 * conversation is kept under `agentConversation:<conversationId>` in
 * `runtime_state`.
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { config } from '../config';
import { isAgentMessagingTool } from '../lib/mcp-client';
import prisma from '../lib/prisma';
import { stringifyToolOutput } from '../lib/tool-output-limiter';
import { logger } from '../logger';
import { uuid } from '../protocol/chat-protocol';
import { conversationService } from './conversation.service';
import { runtimeStateService } from './runtime-state.service';

const conversationKey = (conversationId: string) => `agentConversation:${conversationId}`;

/** The first line of `message_agent`'s answer. A sentence for the model follows it. */
const sentAnswer = z.object({ conversationId: uuid });

/** The conversation a `message_agent` result started or answered, or null. */
function sentConversationId(result: unknown): string | null {
  try {
    const answer = sentAnswer.safeParse(JSON.parse(stringifyToolOutput(result).split('\n', 1)[0]!));
    return answer.success ? answer.data.conversationId : null;
  } catch {
    return null;
  }
}

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

  /**
   * Wrap the agent's `message_agent` tools so that each call that starts or
   * answers a conversation keeps it in `threadId` before its result returns.
   * The other agent can answer while the step still runs, so the answer comes
   * back to the run's thread in every mode. Without a thread the tools are
   * returned untouched.
   */
  withSentConversations(tools: Record<string, Tool>, threadId: string | undefined): Record<string, Tool> {
    if (!threadId) return tools;
    const wrapped: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      const execute = tool.execute;
      if (!execute || !isAgentMessagingTool(name, 'message_agent')) {
        wrapped[name] = tool;
        continue;
      }
      wrapped[name] = {
        ...tool,
        execute: async (args: unknown, options: unknown) => {
          const result = await (execute as (a: unknown, o: unknown) => Promise<unknown>)(args, options);
          await this.keepSent(sentConversationId(result), threadId);
          return result;
        },
      } as Tool;
    }
    return wrapped;
  }

  /** Keep a conversation the agent's own message started. A failure costs only where its answer goes. */
  private async keepSent(conversationId: string | null, threadId: string): Promise<void> {
    if (!conversationId) return;
    try {
      await this.remember(conversationId, threadId);
    } catch (err) {
      logger.warn({ err, threadId, conversationId }, '[AgentConversation] Could not keep where a conversation between agents is');
    }
  }
}

export const agentConversationService = new AgentConversationService();
