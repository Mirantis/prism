/**
 * `coding_agent_sign_in`: the agent asking the person to sign a coding agent in
 * to their own Claude or ChatGPT subscription.
 *
 * Chat only: a person is there to answer. The sign-in itself happens where the
 * card opens it, so no code passes through the conversation.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { CODING_AGENTS } from '../config';
import type { ChannelName } from '../services/channel-adapter.interface';
import {
  codingAgentSignInRequestService,
  PROVIDERS,
} from '../services/coding-agent-sign-in/coding-agent-sign-in-request.service';

export const CODING_AGENT_SIGN_IN_TOOL_NAME = 'coding_agent_sign_in';

export function getCodingAgentSignInTools(
  userId: string,
  agentId: string,
  threadId: string | undefined,
  originChannel: ChannelName,
  originChannelId: string | undefined,
): Record<string, Tool> {
  if (!threadId) return {};
  return {
    [CODING_AGENT_SIGN_IN_TOOL_NAME]: tool({
      description:
        'Ask the user to sign a coding agent in to their own subscription, so its coding tasks run on it: ' +
        'claude-code on their Claude plan, codex on their ChatGPT plan. Call it when the user asks for that, ' +
        'or when a coding task failed because nobody is signed in to the subscription. It posts a card the ' +
        'user signs in from. Never ask for a sign-in code or link in chat, and never use one the user pastes ' +
        'in chat: point them to the card instead. Then finish this turn; when the sign-in succeeds, the user ' +
        'tells you so in a new message.',
      inputSchema: z.object({ agent: z.enum(CODING_AGENTS) }),
      execute: async ({ agent }) => {
        const { repeated } = await codingAgentSignInRequestService.request(
          { userId, agentId, threadId, originChannel, originChannelId },
          agent,
        );
        return {
          success: true,
          message: repeated
            ? `A sign-in card for ${PROVIDERS[agent]} is already waiting in this conversation, so nothing new was sent. Finish this turn.`
            : `The user was asked to sign in to ${PROVIDERS[agent]}. Finish this turn.`,
        };
      },
    }),
  };
}
