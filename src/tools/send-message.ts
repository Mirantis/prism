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
import type { PostingCeiling } from '../services/delivery-target.service';
import { messageDeliveryService, MessageTrigger } from '../services/message-delivery.service';
import { ChannelName, isChatPlatform, WEB_CHAT_NAME, WEB_CHAT_TARGET } from '../services/channel-adapter.interface';

const SEND_MESSAGE_DESCRIPTION =
  'Post a message into a channel, a thread in one, or a DM that is linked to you, or into web chat when list_message_targets lists it. ' +
  'In a conversation your reply already goes to that conversation; use this tool to reach another one. ' +
  'Only the targets list_message_targets shows are allowed. ' +
  'To mention a person so they are notified, write <@ID> with the id from a <@ID:Name> tag in a message you have seen. ' +
  'The person must be a member of the target. ' +
  '@channel, @here, @everyone and group mentions are refused. A refusal says why; fix the cause before you try again.';

/** The trigger each invocation mode stores its messages under. */
const MODE_TRIGGER: Record<string, MessageTrigger> = {
  heartbeat: 'HEARTBEAT',
  cron: 'CRON_TASK',
  webhook: 'WEBHOOK',
  goal: 'GOAL',
};

export function getSendMessageTools(
  userId: string,
  agentId: string,
  /**
   * The invocation mode. It sets the trigger of the message stored in the
   * target's history, and where a goal turn's own reply goes.
   */
  mode: string,
  threadId?: string,
  originChannel?: ChannelName,
  originChannelId?: string,
  /** Where an autonomous run may post. Unset, the run may post to any linked target. */
  ceiling?: PostingCeiling,
): Record<string, Tool> {
  return {
    list_message_targets: tool({
      description:
        'List the channels and DMs linked to you, which send_message can post to.',
      inputSchema: z.object({}),
      execute: async () => {
        const targets = ceiling?.targets ?? (await outboundMessageService.listTargets(agentId));
        return {
          targets: [
            ...(ceiling?.webChat ? [{ target: WEB_CHAT_TARGET, platform: WEB_CHAT_TARGET, kind: WEB_CHAT_TARGET, name: WEB_CHAT_NAME, main: false }] : []),
            ...targets.map((t) => ({
              target: t.key,
              platform: t.platform,
              kind: t.kind,
              name: t.name,
              main: t.isMain,
            })),
          ],
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
        const origin = ceiling ? undefined : await replyDestination(mode, threadId, originChannel, originChannelId);
        const trigger = MODE_TRIGGER[mode] ?? 'USER_INPUT';
        const sent = await outboundMessageService.send({ agentId, userId, target, thread, text, origin, trigger, ceiling });
        return { sent: true, target: sent.key, name: sent.name, messageId: sent.messageId };
      },
    }),
  };
}

/**
 * Where the run's own reply goes: a chat conversation and thread, or nowhere a
 * send can reach (a web turn). A goal turn posts its reply top-level, never in
 * a thread.
 */
async function replyDestination(
  mode: string,
  threadId: string | undefined,
  originChannel: ChannelName | undefined,
  originChannelId: string | undefined,
): Promise<SendInput['origin']> {
  if (!threadId) return undefined;
  if (!isChatPlatform(originChannel)) return undefined;
  const context = await messageDeliveryService.threadContext(threadId, originChannel, originChannelId);
  const thread = mode === 'goal' ? undefined : context.channelThreadId;
  return { platform: context.channel, conversationId: context.channelId, thread };
}
