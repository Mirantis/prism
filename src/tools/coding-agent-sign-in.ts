/**
 * `coding_agent_sign_in`: the agent asking the person to sign a coding agent in
 * to their own Claude or ChatGPT subscription.
 *
 * Chat only: a person is there to answer. Offered for the coding agents whose
 * CLI runs here. The sign-in itself happens where the card opens it, so no code
 * passes through the conversation.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import type { CodingAgentName } from '../config';
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
  agents: readonly CodingAgentName[],
): Record<string, Tool> {
  const [first, ...rest] = agents;
  if (!threadId || !first) return {};
  return {
    [CODING_AGENT_SIGN_IN_TOOL_NAME]: tool({
      description:
        'Ask the user to sign a coding agent in to their own subscription, so its coding tasks run on it: ' +
        'claude-code on their Claude plan, codex on their ChatGPT plan. Call it when the user asks for that, ' +
        'or when a coding task failed because nobody is signed in to the subscription. It posts a card the ' +
        'user signs in from. Never write a sign-in link yourself, never ask for a sign-in code or link in chat, ' +
        'and never use one the user pastes in chat: point them to the card instead. Then finish this turn. ' +
        'When the sign-in succeeds, a new message says "I signed in to Claude." or "I signed in to ChatGPT.". ' +
        'It is sent only after the runtime has checked the saved login and switched coding tasks to it, so ' +
        'treat it as confirmed. Do not check it with `claude auth status` or `codex login status` in the ' +
        "shell: the shell runs on the deployment's own settings and home, so it never shows the subscription.",
      inputSchema: z.object({ agent: z.enum([first, ...rest]) }),
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
