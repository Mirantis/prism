/**
 * Webhook Service
 *
 * Handles inbound webhook events (POST /agents/webhooks/:name). Modeled on
 * hermes-agent's webhook receiver: per-subscription named routes with an
 * optional event-type allowlist, an optional prompt template, and a delivery
 * target. Agent-mode runs are fire-and-forget (the route answers 202 before
 * the LLM finishes); deliver-only subscriptions publish the rendered template
 * directly with no LLM call.
 *
 * Deliveries arrive on the webhook port, which a deployment exposes to senders.
 * A subscription may require its sender to prove itself (generic token/HMAC
 * verification via lib/webhook-signature.ts), checked here before any
 * filtering, delivery or LLM work happens.
 */

import { ConversationMessage, WebhookSubscription } from '@prisma/client';
import { invoke } from '../invoke';
import { messageDeliveryService, PublishOptions } from './message-delivery.service';
import { webhookRunService, WebhookRunResult } from './webhook-run.service';
import { conversationService } from './conversation.service';
import { agentWorkspaceService } from './agent-workspace.service';
import { slackMappingService } from './slack-mapping.service';
import { teamsMappingService } from './teams/teams-mapping.service';
import { prisma } from '../lib/prisma';
import { trackEvent } from '../lib/telemetry';
import { verifyWebhookAuth } from '../lib/webhook-signature';
import { runClassificationGate } from '../lib/classification-gate';
import { WEBHOOK_GATE_PROMPT, buildWebhookGateUserMessage } from '../prompts/webhook-gate-prompt';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export const WEBHOOK_DELIVER_TARGETS = ['all', 'chat', 'slack', 'teams', 'none'] as const;
export type WebhookDeliverTo = (typeof WEBHOOK_DELIVER_TARGETS)[number];

/** Subscription name rule, borrowed from hermes: lowercase slug. */
export const WEBHOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Discriminated outcome of an inbound delivery, mapped to HTTP by the route. */
export type WebhookInboundResult =
  | { status: 'receiver_disabled' } // 403
  | { status: 'not_found' } // 404
  | { status: 'subscription_disabled' } // 403
  | { status: 'unauthorized'; authType: string } // 401 — sender not verified
  | { status: 'busy' } // 429 — this subscription's run queue is full
  | { status: 'ignored'; event: string } // 200 — event filter miss
  | { status: 'delivered'; event: string } // 200 — deliver-only, published
  | { status: 'accepted'; event: string }; // 202 — agent run dispatched or queued

/**
 * What a delivery stored: the message, or null for 'none'. A delivery to chosen
 * Slack channels also counts the channels it posted to and the unlinked ones
 * it skipped.
 */
interface Delivery {
  message: ConversationMessage | null;
  slack?: { posted: number; skipped: number };
}

/** A run's result, with the channel counts its delivery reported. */
type RunOutcome = WebhookRunResult & Pick<Delivery, 'slack'>;

/** The `webhook processed` props for a delivery to chosen Slack channels. */
function slackChannelProps(slack: Delivery['slack']): Record<string, string> {
  if (!slack) return {};
  return { 'webhook.slack_posted': String(slack.posted), 'webhook.slack_skipped': String(slack.skipped) };
}

/**
 * Max agent runs waiting per subscription (excluding the one in flight).
 * Beyond this the delivery answers 429 — a backstop for pathological floods,
 * not a normal-operation limit.
 */
export const WEBHOOK_MAX_PENDING = 10;

// Hermes truncation caps for payload rendering.
const RAW_PAYLOAD_MAX_CHARS = 4000;
const NESTED_VALUE_MAX_CHARS = 2000;

// ============================================================================
// Validation helpers (shared with the management CRUD route)
// ============================================================================

/** Normalize a user-supplied subscription name the way hermes does. */
export function normalizeWebhookName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, '-') : '';
}

export function isValidDeliverTo(value: unknown): value is WebhookDeliverTo {
  return typeof value === 'string' && (WEBHOOK_DELIVER_TARGETS as readonly string[]).includes(value);
}

/** Parse a stored comma-separated column; null or empty is an empty list. */
export function parseCommaList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

/** A subscription as the management API exposes it: no secret, ever. */
export type PublicWebhookSubscription = Omit<WebhookSubscription, 'secret' | 'slackChannelIds'> & {
  slackChannelIds: string[];
  hasSecret: boolean;
};

/**
 * Project a subscription row for the API. The stored secret must never leave
 * the process, so every response (list, create, update) goes through here and
 * reports only *whether* a secret is set.
 */
export function toPublicSubscription(row: WebhookSubscription): PublicWebhookSubscription {
  const { secret, slackChannelIds, ...rest } = row;
  return {
    ...rest,
    slackChannelIds: parseCommaList(slackChannelIds),
    hasSecret: Boolean(secret && secret.trim()),
  };
}

// ============================================================================
// Event type resolution + prompt rendering (ported from hermes)
// ============================================================================

/**
 * Resolve the incoming event's type: GitHub header → GitLab header → payload
 * top-level `event_type` → 'unknown'. Sources that don't declare a type
 * (e.g. Alertmanager, PagerDuty) resolve to 'unknown', so their subscriptions
 * should leave the events allowlist empty.
 */
export function resolveEventType(
  headers: Record<string, string | string[] | undefined>,
  payload: Record<string, unknown>,
): string {
  const header = (name: string): string => {
    const value = headers[name];
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
    return '';
  };
  const fromPayload = typeof payload.event_type === 'string' ? payload.event_type.trim() : '';
  return header('x-github-event') || header('x-gitlab-event') || fromPayload || 'unknown';
}

/**
 * Render a prompt template against the webhook payload.
 *
 * Supports `{dot.path}` access into nested objects and the special
 * `{__raw__}` token that dumps the whole payload as indented JSON
 * (truncated). Unresolvable keys are left literal. An empty template falls
 * back to a raw payload dump with an event/route lead-in — the agent reasons
 * over the JSON directly.
 */
export function renderWebhookPrompt(
  template: string | null | undefined,
  payload: Record<string, unknown>,
  eventType: string,
  routeName: string,
): string {
  if (!template || !template.trim()) {
    const truncated = JSON.stringify(payload, null, 2).slice(0, RAW_PAYLOAD_MAX_CHARS);
    return `Webhook event '${eventType}' on route '${routeName}':\n\n\`\`\`json\n${truncated}\n\`\`\``;
  }

  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key: string) => {
    if (key === '__raw__') {
      return JSON.stringify(payload, null, 2).slice(0, RAW_PAYLOAD_MAX_CHARS);
    }
    let value: unknown = payload;
    for (const part of key.split('.')) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        value = (value as Record<string, unknown>)[part];
        if (value === undefined) return match;
      } else {
        return match;
      }
    }
    if (value !== null && typeof value === 'object') {
      return JSON.stringify(value, null, 2).slice(0, NESTED_VALUE_MAX_CHARS);
    }
    return String(value);
  });
}

// ============================================================================
// Webhook Service
// ============================================================================

export class WebhookService {
  /**
   * Per-subscription run queues. Agent runs execute serially per subscription
   * (one in flight, the rest FIFO-queued): rejecting concurrent deliveries
   * outright would silently lose distinct events from senders that don't
   * retry on non-2xx (GitHub never redelivers automatically), while unbounded
   * fan-out would let a flapping alert turn into arbitrary concurrent LLM
   * runs. Queueing gives both: nothing is dropped under normal bursts, and
   * spend stays bounded by serialization plus the WEBHOOK_MAX_PENDING cap.
   */
  private readonly pending = new Map<string, Array<() => Promise<void>>>();
  private readonly running = new Set<string>();

  /**
   * Process one inbound delivery. Synchronous parts (lookups, sender
   * verification, event filter, deliver-only publish) complete before
   * returning; agent-mode runs are dispatched fire-and-forget so the route can
   * answer 202 immediately.
   *
   * `rawBody` is the exact received bytes (lib/raw-body.ts), needed to verify
   * HMAC signatures.
   */
  async handleInbound(
    name: string,
    payload: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
    runId: string,
    rawBody?: Buffer,
  ): Promise<WebhookInboundResult> {
    const startTime = Date.now();
    const agent = await agentWorkspaceService.getAgent();

    if (!agent.webhooksEnabled) return { status: 'receiver_disabled' };

    const subscription = await prisma.webhookSubscription.findUnique({ where: { name } });
    if (!subscription) return { status: 'not_found' };
    if (!subscription.isActive) return { status: 'subscription_disabled' };

    // Verify the sender before anything else looks at the payload: an unsigned
    // request must not be able to probe the event allowlist, let alone reach a
    // delivery or an LLM run.
    const auth = verifyWebhookAuth({
      authType: subscription.authType,
      secret: subscription.secret,
      authHeader: subscription.authHeader,
      authPrefix: subscription.authPrefix,
      authAlgorithm: subscription.authAlgorithm,
      authEncoding: subscription.authEncoding,
      authSignedUrl: subscription.authSignedUrl,
      headers,
      rawBody,
    });
    if (auth !== 'ok') {
      // The reason stays in the log; the response is deliberately uniform so
      // probes learn nothing about the configuration.
      logger.warn(
        auth === 'misconfigured'
          ? `[Webhook] '${name}' requires '${subscription.authType}' auth but is misconfigured (missing secret or header) — rejecting`
          : `[Webhook] '${name}' rejected an unverified request ('${subscription.authType}' auth)`,
      );
      return { status: 'unauthorized', authType: subscription.authType };
    }

    const eventType = resolveEventType(headers, payload);
    // An empty allowlist accepts every event.
    const allowedEvents = parseCommaList(subscription.events);
    if (allowedEvents.length > 0 && !allowedEvents.includes(eventType)) {
      logger.info(
        `[Webhook] Ignoring event '${eventType}' for '${name}' (allowed: ${allowedEvents.join(', ')})`,
      );
      return { status: 'ignored', event: eventType };
    }

    const prompt = renderWebhookPrompt(subscription.prompt, payload, eventType, name);

    const run = { id: runId, agentId: agent.id, name, event: eventType };

    if (subscription.deliverOnly) {
      // Direct delivery: the rendered template IS the message. No LLM. The row
      // is written first, so a database that cannot record the event answers
      // 500 before anything is sent.
      await webhookRunService.accept(run, 'running');
      let delivery: Delivery;
      try {
        delivery = await this.deliver(agent.id, agent.userId, subscription, prompt);
      } catch (error: unknown) {
        await webhookRunService.finish(runId, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      await webhookRunService.finish(runId, { status: 'delivered', messageId: delivery.message?.id });
      trackEvent('webhook processed', agent.userId, {
        'agent.id': agent.id,
        'webhook.run_id': runId,
        'webhook.subscription_id': subscription.id,
        'webhook.status': 'delivered_direct',
        'webhook.elapsed_ms': String(Date.now() - startTime),
        ...slackChannelProps(delivery.slack),
      });
      return { status: 'delivered', event: eventType };
    }

    // Agent mode — enqueue and answer 202 now; runs drain serially per
    // subscription so nothing is dropped and nothing fans out.
    const queue = this.pending.get(subscription.id) ?? [];
    if (queue.length >= WEBHOOK_MAX_PENDING) {
      logger.warn(`[Webhook] '${name}' queue is full (${queue.length} pending) — rejecting with 429`);
      return { status: 'busy' };
    }
    // The slot is taken in the same tick as the check above, so concurrent
    // deliveries cannot overfill the queue. The run waits for its row and is
    // skipped without one; the rejection below reports that failure.
    const accepted = webhookRunService.accept(run, 'queued');
    const recorded = accepted.then(
      () => true,
      () => false,
    );
    queue.push(async () => {
      if (await recorded) await this.runAgent(subscription, prompt, runId, startTime);
    });
    this.pending.set(subscription.id, queue);
    this.drainQueue(subscription.id);
    await accepted;
    return { status: 'accepted', event: eventType };
  }

  /** Run the next queued delivery for a subscription, if none is in flight. */
  private drainQueue(subscriptionId: string): void {
    if (this.running.has(subscriptionId)) return;
    const next = this.pending.get(subscriptionId)?.shift();
    if (!next) {
      this.pending.delete(subscriptionId);
      return;
    }
    this.running.add(subscriptionId);
    next()
      .catch((error: unknown) => {
        logger.error({ err: error }, '[Webhook] Agent run failed');
      })
      .finally(() => {
        this.running.delete(subscriptionId);
        this.drainQueue(subscriptionId);
      });
  }

  /** Run the agent over the rendered prompt and record how the run ended. */
  private async runAgent(
    subscription: WebhookSubscription,
    prompt: string,
    runId: string,
    startTime: number,
  ): Promise<void> {
    const agent = await agentWorkspaceService.getAgent();
    await webhookRunService.start(runId);

    let result: RunOutcome;
    try {
      result = await this.invokeAndDeliver(agent, subscription, prompt);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, `[Webhook] '${subscription.name}' failed`);
      const notice = await this.deliverFailureNotice(agent, subscription, msg);
      result = { status: 'failed', error: msg, messageId: notice?.message?.id ?? null, slack: notice?.slack };
    }

    await webhookRunService.finish(runId, result);
    const elapsed = Date.now() - startTime;
    if (result.status === 'failed' || result.status === 'budget_exceeded') {
      logger.warn(`[Webhook] '${subscription.name}' ended ${result.status} after ${elapsed}ms: ${result.error ?? 'no detail'}`);
    } else {
      logger.info(`[Webhook] '${subscription.name}' ${result.status} in ${elapsed}ms`);
    }
    trackEvent('webhook processed', agent.userId, {
      'agent.id': agent.id,
      'webhook.run_id': runId,
      'webhook.subscription_id': subscription.id,
      'webhook.status': result.status === 'failed' ? 'error' : result.status,
      'webhook.elapsed_ms': String(Date.now() - startTime),
      ...slackChannelProps(result.slack),
    });
  }

  /** Invoke the agent and deliver its final response, or the spending-limit notice. */
  private async invokeAndDeliver(
    agent: { id: string; userId: string },
    subscription: WebhookSubscription,
    prompt: string,
  ): Promise<RunOutcome> {
    const result = await invoke({
      userId: agent.userId,
      agentId: agent.id,
      mode: 'webhook',
      prompt,
    });

    // The message stores the run's tool calls and shared files whatever the result.
    const stored = {
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      attachmentIds: result.attachmentIds,
    };

    if (result.error?.type === 'budget_exceeded') {
      const budgetMessage = `**Webhook: ${subscription.name}**\n\nThis event could not be processed — your organization's AI spending limit has been reached${result.error.detail ? `: ${result.error.detail}` : ''}. Please contact your administrator to increase the budget.`;
      const { message, slack } = await this.deliver(agent.id, agent.userId, subscription, budgetMessage, stored);
      return { status: 'budget_exceeded', error: result.error.detail, messageId: message?.id, slack };
    }

    // Use only the last step's text (the final summary), not intermediate step texts
    const lastStep = result.steps[result.steps.length - 1];
    const responseText = (lastStep?.text ?? '').trim();
    const body = responseText || result.response;

    // 'none' delivers nothing, so it skips the gate's model call too.
    if (
      subscription.deliverTo !== 'none' &&
      !(await this.passesDeliveryGate(subscription, body, result.error !== undefined, agent))
    ) {
      return { status: 'suppressed' };
    }

    const { message, slack } = await this.deliver(
      agent.id,
      agent.userId,
      subscription,
      `**Webhook: ${subscription.name}**\n\n${body}`,
      stored,
    );

    // A model error ends the run on an error step, delivered like any reply.
    if (result.error) return { status: 'failed', error: result.error.detail, messageId: message?.id, slack };
    return { status: 'completed', messageId: message?.id, slack };
  }

  /**
   * Whether an agent-mode reply is delivered. An empty reply is not. An error
   * reply always is, and so is every reply of a subscription without a prompt,
   * which set the agent no condition. The classification gate decides the rest
   * from the prompt, so a webhook that asks for a message on every event gets
   * one, and a reply with nothing to report stays quiet.
   */
  private async passesDeliveryGate(
    subscription: WebhookSubscription,
    body: string,
    isError: boolean,
    agent: { id: string; userId: string },
  ): Promise<boolean> {
    if (!body.trim()) return false;
    if (isError || !subscription.prompt) return true;
    return runClassificationGate({
      system: WEBHOOK_GATE_PROMPT,
      user: buildWebhookGateUserMessage({ instruction: subscription.prompt, replyText: body }),
      functionId: 'webhook-gate',
      userId: agent.userId,
      agentId: agent.id,
      logLabel: 'Webhook:Gate',
    });
  }

  /**
   * The sender already got 202 and won't retry, so a run that threw tells the
   * user in a brief notice. Best-effort, since delivery may be what failed.
   */
  private async deliverFailureNotice(
    agent: { id: string; userId: string },
    subscription: WebhookSubscription,
    msg: string,
  ): Promise<Delivery | null> {
    try {
      return await this.deliver(
        agent.id,
        agent.userId,
        subscription,
        `**Webhook: ${subscription.name}**\n\nThis event could not be processed — the run failed with: ${msg}`,
      );
    } catch (deliverError: unknown) {
      logger.error({ err: deliverError }, `[Webhook] '${subscription.name}' failure notice could not be delivered`);
      return null;
    }
  }

  /**
   * Deliver a webhook message: to the chosen channels of a Slack subscription
   * that has them, else per the subscription's target.
   */
  private async deliver(
    agentId: string,
    userId: string,
    target: Pick<WebhookSubscription, 'deliverTo' | 'slackChannelIds'>,
    content: string,
    options?: Pick<PublishOptions, 'toolCalls' | 'attachmentIds'>,
  ): Promise<Delivery> {
    const chosen = parseCommaList(target.slackChannelIds);
    if (target.deliverTo === 'slack' && chosen.length > 0) {
      return this.deliverToSlackChannels(agentId, userId, chosen, content, options);
    }
    return { message: await this.deliverToTarget(agentId, userId, target.deliverTo, content, options) };
  }

  /**
   * Deliver a webhook message per the subscription's target, and return the
   * stored message, or null for 'none':
   * - 'all' — broadcast to every connected channel (heartbeat/cron behavior);
   *   post-#58 the Slack side is the DM + main channel, not every channel.
   * - 'chat' — scoped to web chat; stored in the web-visible latest thread.
   * - 'slack' — scoped to Slack (DM in personal mode, main channel in team
   *   mode). Stored in the Slack destination's own thread — the DM
   *   conversation thread (keyed by dmChannelId) or a per-main-channel thread —
   *   both keyed by a non-null externalThreadId, so `listThreads` hides them
   *   from web Recents + the CLI resume picker. Falls back to the latest
   *   (web-visible) thread + a warning when no Slack destination is linked.
   * - 'none' — nothing is published or stored.
   */
  private async deliverToTarget(
    agentId: string,
    userId: string,
    deliverTo: string,
    content: string,
    options?: Pick<PublishOptions, 'toolCalls' | 'attachmentIds'>,
  ): Promise<ConversationMessage | null> {
    if (deliverTo === 'none') return null;

    if (deliverTo === 'chat') {
      return this.deliverToChat(agentId, userId, content, options);
    }

    if (deliverTo === 'slack') {
      const destChannelId = await this.resolveSlackDestination(agentId, userId);
      if (destChannelId) {
        // Reuse the Slack destination's conversation thread (the DM chat thread
        // in personal mode; a dedicated per-channel thread in team mode). Both
        // are DATABASE-source with externalThreadId set, hidden from web/CLI.
        // No channelId in channelContext → the adapter's mapping fallback posts
        // to the DM (personal) or the main channel (team), matching autonomous
        // routing. (A channelId would route to deliverToChannel, which can't
        // post to DM ids.)
        const thread = await conversationService.getOrCreateThreadByExternalId(userId, agentId, destChannelId);
        return messageDeliveryService.publish(userId, thread.id, content, 'WEBHOOK', {
          ...options,
          channelContext: { channel: 'slack', threadId: thread.id },
        });
      }
      // No DM or channel linked — Slack delivery is impossible. Store in the
      // web-visible latest thread so the event isn't silently lost, and warn.
      logger.warn(
        "[Webhook] deliverTo:'slack' but no Slack DM or channel is linked — storing in the web thread instead",
      );
      return messageDeliveryService.publishToLatestThread(agentId, userId, content, 'WEBHOOK', options);
    }

    if (deliverTo === 'teams') {
      const dest = await this.resolveTeamsDestination(agentId, userId);
      if (dest) {
        // Mirror of the Slack branch: reuse the destination's own conversation
        // thread, keyed by the conversation id, hidden from web/CLI Recents.
        // A DM destination carries no channelId (the adapter's DM-scoped path
        // posts to the user's personal conversation); a channel destination
        // must carry it — a Teams channelContext without a channelId is
        // DM-scoped by design and would deliver nothing in Team Mode.
        const thread = await conversationService.getOrCreateThreadByExternalId(userId, agentId, dest.conversationId);
        return messageDeliveryService.publish(userId, thread.id, content, 'WEBHOOK', {
          ...options,
          channelContext: {
            channel: 'teams',
            ...(dest.kind === 'channel' ? { channelId: dest.conversationId } : {}),
            threadId: thread.id,
          },
        });
      }
      logger.warn(
        "[Webhook] deliverTo:'teams' but no Teams DM or channel is linked — storing in the web thread instead",
      );
      return messageDeliveryService.publishToLatestThread(agentId, userId, content, 'WEBHOOK', options);
    }

    // 'all' — broadcast (web + Slack/Teams DM/main channel).
    return messageDeliveryService.publishToLatestThread(agentId, userId, content, 'WEBHOOK', options);
  }

  /** Publish to web chat only, in the web-visible latest thread. */
  private async deliverToChat(
    agentId: string,
    userId: string,
    content: string,
    options?: Pick<PublishOptions, 'toolCalls' | 'attachmentIds'>,
  ): Promise<ConversationMessage> {
    const thread = await conversationService.getOrCreateLatestThread(agentId, userId);
    return messageDeliveryService.publish(userId, thread.id, content, 'WEBHOOK', {
      ...options,
      channelContext: { channel: 'websocket', threadId: thread.id },
    });
  }

  /**
   * Post to each chosen channel that is still linked to the agent, and return
   * the first stored message. Each post is stored in its channel's own thread.
   * A shared file belongs to one message, so files go with the first post
   * only: a run that shares files and posts to several channels is rare.
   * When no chosen channel is linked any more, the message goes to web chat
   * only, because the list excludes every other Slack destination.
   */
  private async deliverToSlackChannels(
    agentId: string,
    userId: string,
    chosen: string[],
    content: string,
    options?: Pick<PublishOptions, 'toolCalls' | 'attachmentIds'>,
  ): Promise<Delivery> {
    const linked = new Set(await slackMappingService.listChannelIds(agentId));
    const reachable = chosen.filter((id) => linked.has(id));
    const slack = { posted: reachable.length, skipped: chosen.length - reachable.length };
    if (slack.skipped > 0) {
      const unlinked = chosen.filter((id) => !linked.has(id));
      logger.warn(`[Webhook] Skipping Slack channels that are no longer linked: ${unlinked.join(', ')}`);
    }

    let first: ConversationMessage | null = null;
    for (const channelId of reachable) {
      const thread = await conversationService.getOrCreateThreadByExternalId(userId, agentId, channelId);
      const message = await messageDeliveryService.publish(userId, thread.id, content, 'WEBHOOK', {
        ...options,
        channelContext: { channel: 'slack', channelId, threadId: thread.id },
      });
      first ??= message;
    }
    if (first) return { message: first, slack };

    logger.warn('[Webhook] None of the chosen Slack channels is linked — storing in the web thread instead');
    return { message: await this.deliverToChat(agentId, userId, content, options), slack };
  }

  /**
   * Resolve the Slack destination channel id for a slack-scoped delivery:
   * the user's DM channel (personal mode) if linked, else the agent's main
   * linked channel (team mode), else null when Slack isn't linked.
   */
  private async resolveSlackDestination(agentId: string, userId: string): Promise<string | null> {
    const dm = await prisma.slackMapping.findFirst({
      where: { lensUserId: userId, agentId, dmChannelId: { not: null } },
      select: { dmChannelId: true },
    });
    if (dm?.dmChannelId) return dm.dmChannelId;
    return slackMappingService.getMainChannel(agentId);
  }

  /**
   * Resolve the Teams destination for a teams-scoped delivery: the user's
   * personal conversation if linked, else the agent's main linked channel,
   * else null when Teams isn't linked. The kind matters downstream — channel
   * destinations must ride channelContext.channelId.
   */
  private async resolveTeamsDestination(
    agentId: string,
    userId: string,
  ): Promise<{ conversationId: string; kind: 'dm' | 'channel' } | null> {
    const dm = await prisma.teamsMapping.findFirst({
      where: { lensUserId: userId, agentId, dmConversationId: { not: null } },
      select: { dmConversationId: true },
    });
    if (dm?.dmConversationId) return { conversationId: dm.dmConversationId, kind: 'dm' };
    const mainChannel = await teamsMappingService.getMainChannel(agentId);
    return mainChannel ? { conversationId: mainChannel, kind: 'channel' } : null;
  }
}

export const webhookService = new WebhookService();
