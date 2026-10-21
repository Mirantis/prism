/**
 * Outbound Message Service
 *
 * A message the agent posts on its own initiative into a conversation linked
 * to it: a linked channel, a thread in one, or a linked DM. It
 * owns the policy the `send_message` tool relies on: which target is allowed,
 * which text is refused, and the `agent message sent` event. Each adapter owns
 * its platform's mention rules and the post itself.
 */

import { ThreadSource } from '@prisma/client';
import { messageDeliveryService, MessageTrigger } from './message-delivery.service';
import { conversationService } from './conversation.service';
import {
  ChannelAdapter,
  ChannelName,
  describeTarget,
  LinkedTarget,
  PostedMessage,
  SendRefusedError,
} from './channel-adapter.interface';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';
import type { ToolCallRecord } from '../types';

/** The tool that posts through this service. */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';

/** A post is a message to people, not a report: one chat message. */
export const MAX_SENT_MESSAGE_LENGTH = 4000;

/** The stored text of a withheld run that sent a message and ended with no text of its own. */
export const WITHHELD_RUN_TEXT = 'This run sent a message and ended with no reply.';

/** The plain broadcast words, each of which notifies a whole conversation. */
const BROADCAST = /(?:^|[^A-Za-z0-9])@(?:channel|here|everyone)(?![A-Za-z0-9])/i;

export interface SendInput {
  agentId: string;
  userId: string;
  /** A target key from `listTargets`, or `#name` of one linked channel. */
  target: string;
  thread?: string;
  text: string;
  /** What started the sending run, recorded on the message stored in the target's history. */
  trigger: MessageTrigger;
  /**
   * Where the run's own final message goes, which the service refuses as a
   * target: one conversation and thread, or `broadcast` for a run without a
   * thread, whose output goes to the main channel and the user's own DM.
   */
  origin?: { platform: ChannelName; conversationId?: string; thread?: string } | 'broadcast';
}

type PostingAdapter = ChannelAdapter &
  Required<Pick<ChannelAdapter, 'displayName' | 'listLinkedTargets' | 'postToTarget'>>;

class OutboundMessageService {
  async listTargets(agentId: string): Promise<LinkedTarget[]> {
    return (await this.linked(agentId)).map(({ target }) => target);
  }

  /** Post the message, or throw an error whose message tells the agent why not. */
  async send(input: SendInput): Promise<{ target: LinkedTarget; messageId: string }> {
    let target: LinkedTarget | undefined;
    try {
      const resolved = await this.resolveTarget(input);
      target = resolved.target;
      const text = this.checkText(input.text);
      this.checkOrigin(target, input);
      const { messageId, history } = await this.post(resolved, text, input);
      this.track(input, 'sent', target);
      if (history) await this.storeInTargetHistory(input, history, text);
      return { target, messageId };
    } catch (error: unknown) {
      if (error instanceof SendRefusedError) this.track(input, 'refused', target, error.code);
      throw error;
    }
  }

  /**
   * A gate that withholds a run's output also drops the run's record. A run
   * that sent a message keeps it: its message is stored, undelivered, in its
   * own thread, or in the latest thread for a run that has none. A thread read
   * live from a channel replays only the channel's messages and internal rows,
   * so there the record is an internal row.
   */
  async keepWithheldRun(run: {
    agentId: string;
    userId: string;
    threadId?: string;
    content: string;
    triggeredBy: MessageTrigger;
    /** The webhook subscription that produced the run, for the model's history. */
    triggerName?: string;
    toolCalls: ToolCallRecord[];
  }): Promise<void> {
    if (sentMessages(run.toolCalls).length === 0) return;
    // The thread a delivery of this run would write to, as `publish` resolves it.
    const threadId = run.threadId
      ? await conversationService.writableThreadId(run.threadId)
      : (await conversationService.getOrCreateLatestThread(run.agentId, run.userId)).id;
    const readLive =
      run.threadId !== undefined && (await conversationService.getThreadSource(threadId)) !== ThreadSource.DATABASE;
    await conversationService.addMessage(threadId, {
      content: run.content.trim() ? run.content : WITHHELD_RUN_TEXT,
      role: 'AGENT',
      triggeredBy: run.triggeredBy,
      triggerName: run.triggerName,
      toolCalls: run.toolCalls,
      ...(readLive && { internalStep: true }),
    });
  }

  /**
   * A reply in the target conversation reads its history from the stored
   * thread, so the sent text is stored there, as an agent message nobody
   * delivers. The message is already posted, so a failed write is logged and
   * the send still succeeds: an error would make the agent send it again.
   */
  private async storeInTargetHistory(
    input: SendInput,
    history: { userId: string; threadKey: string },
    text: string,
  ): Promise<void> {
    try {
      const thread = await conversationService.getOrCreateThreadByExternalId(
        history.userId,
        input.agentId,
        history.threadKey,
      );
      await conversationService.addMessage(thread.id, { content: text, role: 'AGENT', triggeredBy: input.trigger });
    } catch (err: unknown) {
      logger.error({ err }, '[OutboundMessage] posted, but the message could not be stored in the target history');
    }
  }

  private async linked(agentId: string): Promise<Array<{ target: LinkedTarget; adapter: PostingAdapter }>> {
    const adapters = messageDeliveryService
      .getAdapters()
      .filter((adapter): adapter is PostingAdapter =>
        Boolean(adapter.displayName && adapter.listLinkedTargets && adapter.postToTarget),
      );
    const lists = await Promise.all(
      adapters.map(async (adapter) => (await adapter.listLinkedTargets(agentId)).map((target) => ({ target, adapter }))),
    );
    return lists.flat();
  }

  /** A refusal passes through; any other error is the platform's, and names it. */
  private async post(
    { target, adapter }: { target: LinkedTarget; adapter: PostingAdapter },
    text: string,
    input: SendInput,
  ): Promise<PostedMessage> {
    try {
      return await adapter.postToTarget(target, text, input.thread);
    } catch (error: unknown) {
      if (error instanceof SendRefusedError) throw error;
      this.track(input, 'failed', target);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${adapter.displayName} did not accept the message: ${reason}`);
    }
  }

  private async resolveTarget(input: SendInput): Promise<{ target: LinkedTarget; adapter: PostingAdapter }> {
    const linked = await this.linked(input.agentId);
    const exact = linked.find(({ target }) => target.key === input.target);
    if (exact) return exact;

    const name = input.target.replace(/^#/, '').toLowerCase();
    const named = linked.filter(({ target }) => target.kind === 'channel' && target.name?.toLowerCase() === name);
    if (named.length === 1) return named[0];

    const targets = linked.map(({ target }) => target);
    const known = targets.length
      ? `Linked targets: ${targets.map((t) => (t.name ? `${t.key} (${t.name})` : t.key)).join(', ')}.`
      : 'No channel or DM is linked to this agent.';
    if (named.length > 1) {
      throw new SendRefusedError(
        `More than one linked channel is named "${input.target}". Name one by its target. ${known}`,
        'ambiguous_target',
      );
    }
    throw new SendRefusedError(
      `"${input.target}" is not a channel or DM linked to this agent, so nothing was sent. ${known}`,
      'unknown_target',
    );
  }

  private checkText(raw: string): string {
    const text = raw.trim();
    if (!text) throw new SendRefusedError('The message is empty.', 'empty');
    if (text.length > MAX_SENT_MESSAGE_LENGTH) {
      throw new SendRefusedError(
        `The message is ${text.length} characters, and the limit is ${MAX_SENT_MESSAGE_LENGTH}. Shorten it.`,
        'too_long',
      );
    }
    if (BROADCAST.test(text)) {
      throw new SendRefusedError(
        'The message has a broadcast mention (@channel, @here or @everyone), so nothing was sent. Mention people one at a time as <@ID>.',
        'broadcast',
      );
    }
    return text;
  }

  private checkOrigin(target: LinkedTarget, input: SendInput): void {
    const origin = input.origin;
    if (origin === 'broadcast') {
      if (!target.isMain && !(target.kind === 'dm' && target.dmUserId === input.userId)) return;
      throw new SendRefusedError(
        `Your final message already goes to ${describeTarget(target)}: the output of a run without a conversation goes to the main channel and to your user's DM. Write the message as your final message instead.`,
        'own_conversation',
      );
    }
    if (!origin || origin.platform !== target.platform || origin.conversationId !== target.conversationId) return;
    if ((origin.thread ?? undefined) !== (input.thread ?? undefined)) return;
    throw new SendRefusedError(
      'Your reply already goes to this conversation. Write the message in your reply instead.',
      'own_conversation',
    );
  }

  private track(input: SendInput, outcome: 'sent' | 'refused' | 'failed', target?: LinkedTarget, reason?: string): void {
    trackEvent('agent message sent', input.userId, {
      'agent.id': input.agentId,
      'send.outcome': outcome,
      ...(reason ? { 'send.reason': reason } : {}),
      ...(target ? { 'send.platform': target.platform, 'send.target_kind': target.kind } : {}),
      'send.threaded': String(input.thread !== undefined),
    });
  }
}

export const outboundMessageService = new OutboundMessageService();

/** The messages a run's tool calls posted, one line each: where it went, then its text. */
export function sentMessages(toolCalls: ToolCallRecord[]): string[] {
  return toolCalls
    .filter((call) => call.tool === SEND_MESSAGE_TOOL_NAME && call.success)
    .map((call) => {
      const { target, thread, text } = JSON.parse(call.input) as { target: string; thread?: string; text: string };
      return `- To ${target}${thread ? `, in thread ${thread}` : ''}: ${text}`;
    });
}
