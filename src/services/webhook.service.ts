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
 * Auth is terminated by the platform in front of the container — this service
 * never sees secrets or signatures.
 */

import { WebhookSubscription } from '@prisma/client';
import { invoke } from '../invoke';
import { messageDeliveryService, PublishOptions } from './message-delivery.service';
import { conversationService } from './conversation.service';
import { agentWorkspaceService } from './agent-workspace.service';
import { prisma } from '../lib/prisma';
import { trackEvent } from '../lib/telemetry';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export const WEBHOOK_DELIVER_TARGETS = ['all', 'chat', 'slack'] as const;
export type WebhookDeliverTo = (typeof WEBHOOK_DELIVER_TARGETS)[number];

/** Subscription name rule, borrowed from hermes: lowercase slug. */
export const WEBHOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Discriminated outcome of an inbound delivery, mapped to HTTP by the route. */
export type WebhookInboundResult =
  | { status: 'receiver_disabled' } // 403
  | { status: 'not_found' } // 404
  | { status: 'subscription_disabled' } // 403
  | { status: 'busy' } // 429 — this subscription's run queue is full
  | { status: 'ignored'; event: string } // 200 — event filter miss
  | { status: 'delivered'; event: string } // 200 — deliver-only, published
  | { status: 'accepted'; event: string }; // 202 — agent run dispatched or queued

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

/** Parse the stored comma-separated allowlist; empty/null means "all events". */
export function parseEventsList(events: string | null | undefined): string[] {
  if (!events) return [];
  return events
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
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
   * Process one inbound delivery. Synchronous parts (lookups, event filter,
   * deliver-only publish) complete before returning; agent-mode runs are
   * dispatched fire-and-forget so the route can answer 202 immediately.
   */
  async handleInbound(
    name: string,
    payload: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
    runId: string,
  ): Promise<WebhookInboundResult> {
    const startTime = Date.now();
    const agent = await agentWorkspaceService.getAgent();

    if (!agent.webhooksEnabled) return { status: 'receiver_disabled' };

    const subscription = await prisma.webhookSubscription.findUnique({ where: { name } });
    if (!subscription) return { status: 'not_found' };
    if (!subscription.isActive) return { status: 'subscription_disabled' };

    const eventType = resolveEventType(headers, payload);
    const allowedEvents = parseEventsList(subscription.events);
    if (allowedEvents.length > 0 && !allowedEvents.includes(eventType)) {
      logger.info(
        `[Webhook] Ignoring event '${eventType}' for '${name}' (allowed: ${allowedEvents.join(', ')})`,
      );
      return { status: 'ignored', event: eventType };
    }

    const prompt = renderWebhookPrompt(subscription.prompt, payload, eventType, name);

    if (subscription.deliverOnly) {
      // Direct delivery: the rendered template IS the message. No LLM.
      await this.deliver(agent.id, agent.userId, subscription.deliverTo, prompt);
      trackEvent('webhook processed', agent.userId, {
        'agent.id': agent.id,
        'webhook.run_id': runId,
        'webhook.subscription_id': subscription.id,
        'webhook.status': 'delivered_direct',
        'webhook.elapsed_ms': String(Date.now() - startTime),
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
    queue.push(() => this.runAgent(subscription, prompt, runId, startTime));
    this.pending.set(subscription.id, queue);
    this.drainQueue(subscription.id);
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
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Webhook] Agent run failed: ${msg}`);
      })
      .finally(() => {
        this.running.delete(subscriptionId);
        this.drainQueue(subscriptionId);
      });
  }

  /** Invoke the agent over the rendered prompt and deliver its final response. */
  private async runAgent(
    subscription: WebhookSubscription,
    prompt: string,
    runId: string,
    startTime: number,
  ): Promise<void> {
    const agent = await agentWorkspaceService.getAgent();
    const trackRun = (status: 'completed' | 'budget_exceeded' | 'error') =>
      trackEvent('webhook processed', agent.userId, {
        'agent.id': agent.id,
        'webhook.run_id': runId,
        'webhook.subscription_id': subscription.id,
        'webhook.status': status,
        'webhook.elapsed_ms': String(Date.now() - startTime),
      });

    try {
      const result = await invoke({
        userId: agent.userId,
        agentId: agent.id,
        mode: 'webhook',
        prompt,
      });

      if (result.error?.type === 'budget_exceeded') {
        const budgetMessage = `**Webhook: ${subscription.name}**\n\nThis event could not be processed — your organization's AI spending limit has been reached${result.error.detail ? `: ${result.error.detail}` : ''}. Please contact your administrator to increase the budget.`;
        await this.deliver(agent.id, agent.userId, subscription.deliverTo, budgetMessage);
        trackRun('budget_exceeded');
        return;
      }

      // Use only the last step's text (the final summary), not intermediate step texts
      const lastStep = result.steps[result.steps.length - 1];
      const responseText = (lastStep?.text ?? '').trim();
      const body = responseText || result.response;

      await this.deliver(agent.id, agent.userId, subscription.deliverTo, `**Webhook: ${subscription.name}**\n\n${body}`, {
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
        attachmentIds: result.attachmentIds,
      });

      logger.info(`[Webhook] '${subscription.name}' completed in ${Date.now() - startTime}ms`);
      trackRun('completed');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Webhook] '${subscription.name}' failed: ${msg}`);
      trackRun('error');
      // The sender already got 202 and won't retry — a silent failure would
      // mean the user never hears about the event at all. Deliver a brief
      // notice (best-effort; delivery itself may be what failed).
      try {
        await this.deliver(
          agent.id,
          agent.userId,
          subscription.deliverTo,
          `**Webhook: ${subscription.name}**\n\nThis event could not be processed — the run failed with: ${msg}`,
        );
      } catch (deliverError: unknown) {
        const deliverMsg = deliverError instanceof Error ? deliverError.message : String(deliverError);
        logger.error(`[Webhook] '${subscription.name}' failure notice could not be delivered: ${deliverMsg}`);
      }
    }
  }

  /**
   * Deliver a webhook message per the subscription's target:
   * - 'all' — broadcast to every connected channel (heartbeat/cron behavior).
   * - 'chat' / 'slack' — scoped to one channel via channelContext; the Slack
   *   adapter falls back to the user's DM mapping when no channelId is given.
   */
  private async deliver(
    agentId: string,
    userId: string,
    deliverTo: string,
    content: string,
    options?: Pick<PublishOptions, 'toolCalls' | 'attachmentIds'>,
  ): Promise<void> {
    if (deliverTo === 'chat' || deliverTo === 'slack') {
      const thread = await conversationService.getOrCreateLatestThread(agentId, userId);
      await messageDeliveryService.publish(userId, thread.id, content, 'WEBHOOK', {
        ...options,
        channelContext: {
          channel: deliverTo === 'chat' ? 'websocket' : 'slack',
          threadId: thread.id,
        },
      });
      return;
    }
    await messageDeliveryService.publishToLatestThread(agentId, userId, content, 'WEBHOOK', options);
  }
}

export const webhookService = new WebhookService();
