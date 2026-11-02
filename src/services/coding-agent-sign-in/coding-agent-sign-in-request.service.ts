/**
 * The agent asking the person, in chat, to sign a coding agent in to their
 * own subscription: a card in the conversation that opens the sign-in, and,
 * once a sign-in succeeds, the next turn of that conversation.
 *
 * The code a sign-in needs is typed where the card opens it, never into chat,
 * so nothing here reads or carries one.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { config, type CodingAgentName } from '../../config';
import { logger } from '../../logger';
import { trackEvent } from '../../lib/telemetry';
import type { ChannelName } from '../channel-adapter.interface';

export interface CodingAgentSignInRequest {
  type: 'coding_agent_sign_in';
  id: string;
  agent: CodingAgentName;
  status: 'waiting' | 'signed_in';
  originChannel?: ChannelName;
  originChannelId?: string;
}

/** Whose subscription the person signs in to. */
export const PROVIDERS: Record<CodingAgentName, string> = { 'claude-code': 'Claude', codex: 'ChatGPT' };

/** The name each coding agent is shown with. */
export const NAMES: Record<CodingAgentName, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export interface SignInCaller {
  agentId: string;
  userId: string;
  threadId: string;
  originChannel?: ChannelName;
  originChannelId?: string;
}

/** The web UI's sign-in for `agent`, opened from request `id`. */
export function signInLink(agent: CodingAgentName, id: string): string {
  const suffix = `coding-agents?${new URLSearchParams({ agent, 'sign-in': id }).toString()}`;
  return config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${suffix}` : `/${suffix}`;
}

const REQUEST_TYPE = { path: '$[0].type', equals: 'coding_agent_sign_in' } as const;
const WAITING = { path: '$[0].status', equals: 'waiting' } as const;

class CodingAgentSignInRequestService {
  /** Posts the card, unless one for the same coding agent already waits in the conversation. */
  async request(
    caller: SignInCaller,
    agent: CodingAgentName,
  ): Promise<{ request: CodingAgentSignInRequest; repeated: boolean }> {
    const waiting = (await this.waiting(caller.agentId, caller.userId, caller.threadId)).find(
      (item) => item.agent === agent,
    );
    if (waiting) return { request: waiting, repeated: true };
    const request: CodingAgentSignInRequest = {
      type: 'coding_agent_sign_in',
      id: randomUUID(),
      agent,
      status: 'waiting',
      originChannel: caller.originChannel,
      originChannelId: caller.originChannelId,
    };
    const { messageDeliveryService } = await import('../message-delivery.service');
    const channelContext = await messageDeliveryService.threadContext(
      caller.threadId,
      caller.originChannel,
      caller.originChannelId,
    );
    const provider = PROVIDERS[agent];
    const link =
      config.publicUrl || channelContext.channel === 'websocket'
        ? `[Sign in to ${provider}](${signInLink(agent, request.id)})`
        : `Sign in from Coding agents in the agent's settings.`;
    await messageDeliveryService.publish(
      caller.userId,
      caller.threadId,
      `Sign in to ${provider} to run ${NAMES[agent]} on your own plan. Enter the sign-in code only where this link opens, never in chat.\n\n${link}`,
      'USER_INPUT',
      { blocks: [request], channelContext },
    );
    trackEvent('coding agent sign-in requested', caller.userId, {
      'agent.id': caller.agentId,
      'coding_agent.name': agent,
    });
    return { request, repeated: false };
  }

  private async waiting(
    agentId: string,
    userId: string,
    threadId?: string,
  ): Promise<Array<CodingAgentSignInRequest & { threadId: string; messageId: string }>> {
    const rows = await prisma.conversationMessage.findMany({
      where: { thread: { agentId, userId }, ...(threadId ? { threadId } : {}), AND: [{ blocks: REQUEST_TYPE }, { blocks: WAITING }] },
      select: { id: true, threadId: true, blocks: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      ...(row.blocks as unknown as CodingAgentSignInRequest[])[0],
      threadId: row.threadId,
      messageId: row.id,
    }));
  }

  /**
   * Marks every request waiting for `agent` signed in and continues each
   * conversation that asked, once.
   */
  async signedIn(agentId: string, userId: string, agent: CodingAgentName): Promise<void> {
    const waiting = (await this.waiting(agentId, userId)).filter((item) => item.agent === agent);
    const { messageDeliveryService } = await import('../message-delivery.service');
    const continued = new Set<string>();
    for (const { threadId, messageId, ...request } of waiting) {
      const updated: CodingAgentSignInRequest = { ...request, status: 'signed_in' };
      const result = await prisma.conversationMessage.updateMany({
        where: { id: messageId, blocks: WAITING },
        data: { blocks: [updated] as unknown as Prisma.InputJsonValue },
      });
      if (!result.count) continue;
      const row = await prisma.conversationMessage.findUnique({ where: { id: messageId } });
      // The card is part of the transcript, so every open client shows it signed in.
      if (row) await messageDeliveryService.showInConversation(userId, row);
      if (continued.has(threadId)) continue;
      continued.add(threadId);
      await this.continueConversation(agentId, userId, threadId, updated);
    }
  }

  private async continueConversation(
    agentId: string,
    userId: string,
    threadId: string,
    request: CodingAgentSignInRequest,
  ): Promise<void> {
    const { messageDeliveryService } = await import('../message-delivery.service');
    const { conversationEngineService } = await import('../conversation-engine.service');
    const context = await messageDeliveryService.threadContext(
      threadId,
      request.originChannel,
      request.originChannelId,
    );
    void conversationEngineService
      .chat({
        userId,
        agentId,
        threadId,
        message: `I signed in to ${PROVIDERS[request.agent]}.`,
        metadata: {
          channel: context.channel,
          channelId: context.channelId,
          channelThreadId: context.channelThreadId,
          channelLabel: context.channelLabel,
        },
      })
      .catch((error) => logger.error({ err: error }, '[CodingAgents] Continuation after sign-in failed'));
  }
}

export const codingAgentSignInRequestService = new CodingAgentSignInRequestService();
