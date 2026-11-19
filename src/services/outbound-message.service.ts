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
  PostedHistory,
  PostedMessage,
  SendRefusedError,
  WEB_CHAT_NAME,
  WEB_CHAT_TARGET,
} from './channel-adapter.interface';
import type { PostingCeiling } from './delivery-target.service';
import { trackEvent } from '../lib/telemetry';
import { visibleText } from '../lib/visible-text';
import { logger } from '../logger';
import type { ToolCallRecord } from '../types';

/** The tool that posts through this service. */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';

/** A post is a message to people, not a report: one chat message. */
export const MAX_SENT_MESSAGE_LENGTH = 4000;

/** The stored text of a withheld run that sent a message and ended with no text of its own. */
export const WITHHELD_RUN_TEXT = 'This run sent a message and ended with no reply.';

/** What the `agent message sent` event reports about a target. */
type TrackedTarget = { platform: string; kind: string };
const WEB_CHAT_TRACKED: TrackedTarget = { platform: WEB_CHAT_TARGET, kind: WEB_CHAT_TARGET };

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
  /** The conversation and thread the run's own reply goes to, which the service refuses as a target. */
  origin?: { platform: ChannelName; conversationId?: string; thread?: string };
  /** Where an autonomous run may post. Set, it also allows web chat as `WEB_CHAT_TARGET`. */
  ceiling?: PostingCeiling;
}

/** What a send posted to: a target's key and name, and the posted message's id. */
export interface SentMessage {
  key: string;
  name: string | null;
  messageId: string;
}

type PostingAdapter = ChannelAdapter &
  Required<Pick<ChannelAdapter, 'displayName' | 'listLinkedTargets' | 'postToTarget'>>;

class OutboundMessageService {
  async listTargets(agentId: string): Promise<LinkedTarget[]> {
    return (await this.linked(agentId)).map(({ target }) => target);
  }

  /** Post the message, or throw an error whose message tells the agent why not. */
  async send(input: SendInput): Promise<SentMessage> {
    let target: TrackedTarget | undefined;
    try {
      if (input.target === WEB_CHAT_TARGET && input.ceiling?.webChat) {
        target = WEB_CHAT_TRACKED;
        if (input.thread !== undefined) {
          throw new SendRefusedError('Web chat has no threads. Send the message without a thread.', 'web_chat_thread');
        }
        const text = this.checkText(input.text);
        const message = await messageDeliveryService.publishToWebChat(input.agentId, input.userId, text, input.trigger);
        this.track(input, 'sent', target);
        return { key: WEB_CHAT_TARGET, name: WEB_CHAT_NAME, messageId: message.id };
      }
      const resolved = await this.resolveTarget(input);
      target = resolved.target;
      const text = this.checkText(input.text);
      this.checkOrigin(resolved.target, input);
      const { messageId, history } = await this.post(resolved, text, input);
      this.track(input, 'sent', target);
      if (history) await this.storeInTargetHistory(input, history, text);
      return { key: resolved.target.key, name: resolved.target.name, messageId };
    } catch (error: unknown) {
      if (error instanceof SendRefusedError) this.track(input, 'refused', target, error.code);
      throw error;
    }
  }

  /**
   * A run whose final message is not delivered keeps its record when it sent a
   * message: the message is stored, undelivered, in its own thread, or in the
   * latest thread for a run that has none. The record is an internal row, which
   * the model reads and no client shows, in a thread read live from a channel,
   * which replays only the channel's messages and internal rows, and when the
   * run posted into web chat, where the post itself already shows.
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
  }): Promise<string | null> {
    if (sentMessages(run.toolCalls).length === 0) return null;
    // The thread a delivery of this run would write to, as `publish` resolves it.
    const threadId = run.threadId
      ? await conversationService.writableThreadId(run.threadId)
      : (await conversationService.getOrCreateLatestThread(run.agentId, run.userId)).id;
    const readLive =
      run.threadId !== undefined && (await conversationService.getThreadSource(threadId)) !== ThreadSource.DATABASE;
    const postedToWebChat = sentMessageList(run.toolCalls).some(({ target }) => target === WEB_CHAT_TARGET);
    const { message } = await conversationService.addMessage(threadId, {
      content: visibleText(run.content) ? run.content : WITHHELD_RUN_TEXT,
      role: 'AGENT',
      triggeredBy: run.triggeredBy,
      triggerName: run.triggerName,
      toolCalls: run.toolCalls,
      ...((readLive || postedToWebChat) && { internalStep: true }),
    });
    return message.id;
  }

  /**
   * A reply in the target conversation reads its history from the stored
   * thread, so the sent text is stored there, as an agent message nobody
   * delivers. The message is already posted, so a failed write is logged and
   * the send still succeeds: an error would make the agent send it again.
   */
  private async storeInTargetHistory(
    input: SendInput,
    history: PostedHistory,
    text: string,
  ): Promise<void> {
    try {
      const { userId, threadKey, channelId, externalMessageId } = history;
      const thread = channelId
        ? await conversationService.getOrCreateThreadByExternalId(userId, input.agentId, threadKey, {
            source: ThreadSource.DATABASE,
            channelId,
          })
        : await conversationService.getOrCreateThreadByExternalId(userId, input.agentId, threadKey);
      await conversationService.addMessage(thread.id, {
        content: text,
        role: 'AGENT',
        triggeredBy: input.trigger,
        ...(externalMessageId && { externalMessageId }),
      });
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
    const found = this.findTarget(linked, input.target);
    if (!input.ceiling) return this.orRefuse(found, input.target, () => linkedList(linked.map(({ target }) => target)));

    const ceiling = input.ceiling;
    const allowed = new Set(ceiling.targets.map((t) => t.key));
    const known = () => ceilingList(ceiling);
    if (found.length === 1 && !allowed.has(found[0].target.key)) {
      throw new SendRefusedError(
        `Your delivery setting does not let this run post to ${describeTarget(found[0].target)}, so nothing was sent. ${known()}`,
        'outside_delivery',
      );
    }
    return this.orRefuse(
      found.filter(({ target }) => allowed.has(target.key)),
      input.target,
      known,
    );
  }

  /** The linked targets `requested` names: its exact key, else each channel of that name. */
  private findTarget(
    linked: Array<{ target: LinkedTarget; adapter: PostingAdapter }>,
    requested: string,
  ): Array<{ target: LinkedTarget; adapter: PostingAdapter }> {
    const exact = linked.find(({ target }) => target.key === requested);
    if (exact) return [exact];
    const name = requested.replace(/^#/, '').toLowerCase();
    return linked.filter(({ target }) => target.kind === 'channel' && target.name?.toLowerCase() === name);
  }

  private orRefuse(
    found: Array<{ target: LinkedTarget; adapter: PostingAdapter }>,
    requested: string,
    /** The places to name when the send is refused. */
    known: () => string,
  ): { target: LinkedTarget; adapter: PostingAdapter } {
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new SendRefusedError(
        `More than one linked channel is named "${requested}". Name one by its target. ${known()}`,
        'ambiguous_target',
      );
    }
    throw new SendRefusedError(
      `"${requested}" is not a channel or DM linked to this agent, so nothing was sent. ${known()}`,
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
    if (!origin || origin.platform !== target.platform || origin.conversationId !== target.conversationId) return;
    if ((origin.thread ?? undefined) !== (input.thread ?? undefined)) return;
    throw new SendRefusedError(
      'Your reply already goes to this conversation. Write the message in your reply instead.',
      'own_conversation',
    );
  }

  private track(input: SendInput, outcome: 'sent' | 'refused' | 'failed', target?: TrackedTarget, reason?: string): void {
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

function targetName(t: LinkedTarget): string {
  return t.name ? `${t.key} (${t.name})` : t.key;
}

function linkedList(targets: LinkedTarget[]): string {
  return targets.length ? `Linked targets: ${targets.map(targetName).join(', ')}.` : 'No channel or DM is linked to this agent.';
}

/** The targets a delivery setting allows, as a refusal names them. */
function ceilingList(ceiling: PostingCeiling): string {
  const names = [...(ceiling.webChat ? [`${WEB_CHAT_TARGET} (${WEB_CHAT_NAME})`] : []), ...ceiling.targets.map(targetName)];
  return names.length ? `This run may post to: ${names.join(', ')}.` : 'This run may post nowhere.';
}

/** The messages a run's tool calls posted: the target, where each went with the thread included, and its text. */
export function sentMessageList(toolCalls: ToolCallRecord[]): Array<{ target: string; place: string; text: string }> {
  return toolCalls
    .filter((call) => call.tool === SEND_MESSAGE_TOOL_NAME && call.success)
    .map((call) => {
      const { target, thread, text } = JSON.parse(call.input) as { target: string; thread?: string; text: string };
      return { target, place: `${target}${thread ? `, in thread ${thread}` : ''}`, text };
    });
}

/** The messages a run's tool calls posted, one line each: where it went, then its text. */
export function sentMessages(toolCalls: ToolCallRecord[]): string[] {
  return sentMessageList(toolCalls).map(({ place, text }) => `- To ${place}: ${text}`);
}
