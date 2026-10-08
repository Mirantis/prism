/**
 * send_message and list_message_targets — the agent posts a message on its own
 * initiative into a conversation linked to it.
 *
 * The policy lives in `outboundMessageService`; these tools only pass the
 * run's identity and the conversation its reply goes to. A refusal throws, so
 * the agent reads the reason and the stored tool call is marked failed.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { outboundMessageService, SEND_MESSAGE_TOOL_NAME, SendInput } from '../services/outbound-message.service';
import { conversationService } from '../services/conversation.service';

const SEND_MESSAGE_DESCRIPTION =
  'Post a message into a channel, a thread in one, or a DM that is linked to you. ' +
  'Use it to reach a conversation other than the one you are replying in: your reply already goes there. ' +
  'Only linked targets are allowed; list_message_targets shows them. ' +
  'To mention a person so they are notified, write <@ID> with the id from a <@ID:Name> tag in a message you have seen. ' +
  'The person must be a member of the target. ' +
  '@channel, @here, @everyone and group mentions are refused. A refusal says why; fix the cause before you try again.';

export function getSendMessageTools(
  userId: string,
  agentId: string,
  threadId?: string,
  originChannel?: 'slack' | 'websocket' | 'teams',
  originChannelId?: string,
  broadcastsOutput?: boolean,
): Record<string, Tool> {
  return {
    list_message_targets: tool({
      description:
        'List the channels and DMs linked to you, which send_message can post to.',
      inputSchema: z.object({}),
      execute: async () => {
        const targets = await outboundMessageService.listTargets(agentId);
        return {
          targets: targets.map((t) => ({
            target: t.key,
            platform: t.platform,
            kind: t.kind,
            name: t.name,
            main: t.isMain,
          })),
        };
      },
    }),
    [SEND_MESSAGE_TOOL_NAME]: tool({
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: z.object({
        target: z
          .string()
          .describe('A target from list_message_targets, or #name of a linked channel when the name is unique'),
        thread: z
          .string()
          .optional()
          .describe("Post into this thread of the target: the id of the thread's first message, such as a messageId send_message returned"),
        text: z.string().describe('The message, in markdown'),
      }),
      execute: async ({ target, thread, text }) => {
        const origin = await replyDestination(threadId, originChannel, originChannelId, broadcastsOutput);
        const sent = await outboundMessageService.send({ agentId, userId, target, thread, text, origin });
        return { sent: true, target: sent.target.key, name: sent.target.name, messageId: sent.messageId };
      },
    }),
  };
}

/**
 * Where the run's own reply goes: the broadcast, a chat conversation and
 * thread, or nowhere a send can reach (a web turn, a run delivered to the web
 * chat or not at all).
 */
async function replyDestination(
  threadId: string | undefined,
  originChannel: 'slack' | 'websocket' | 'teams' | undefined,
  originChannelId: string | undefined,
  broadcastsOutput: boolean | undefined,
): Promise<SendInput['origin']> {
  if (broadcastsOutput) return 'broadcast';
  if (!threadId) return undefined;
  if (originChannel !== 'slack' && originChannel !== 'teams') return undefined;
  const context = await conversationService.getChannelContext(threadId, originChannel, originChannelId);
  return { platform: context.channel, conversationId: context.channelId, thread: context.threadTs };
}
