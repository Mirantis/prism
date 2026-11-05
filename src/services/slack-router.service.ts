/**
 * Slack Router Service
 *
 * In routed mode a router outside the runtime receives Slack's events for a
 * shared Slack app and delivers each one meant for this agent as an envelope
 * (`slack-router-envelope.ts`). This service owns the listener the envelopes
 * arrive on (`SLACK_PORT`, bound to `PRISM_HOST`) and what happens to an
 * envelope before the router gets its answer.
 *
 * - An envelope sent more than five minutes from this clock, or one whose
 *   `eventId` was accepted before, is answered and not applied.
 * - A link or a connection change is applied before the answer, so the
 *   router's retry covers a failure.
 * - A Slack event is recorded in `pending_work` before the answer and handled
 *   after it. The record ends once a stored message holds the event, or once
 *   the event is handled, so a restart before then handles it again.
 */

import { createServer, type Server } from 'node:http';
import { config } from '../config';
import { logger } from '../logger';
import { createSlackRouterApp } from '../routes/slack-router';
import { pendingWorkService, type PendingWorkItem } from './pending-work.service';
import {
  routerEnvelopeSchema,
  type RoutedLink,
  type RouterEnvelope,
  type SlackEnvelope,
} from './slack-router-envelope';

/** How far an envelope's `sentAt` may be from this clock. */
const ENVELOPE_MAX_SKEW_MS = 5 * 60_000;

/**
 * How long an accepted event id is remembered. The router retries an event for
 * about ten minutes, and each attempt is sent at most `ENVELOPE_MAX_SKEW_MS`
 * before it arrives.
 */
const SEEN_EVENT_TTL_MS = 15 * 60_000;

/** What the Slack adapter does with each kind of envelope. */
export interface SlackRouterHandlers {
  /** Validate the token again and start the workspace's app. Resolves whether `teamId` is connected. */
  connect(teamId: string): Promise<boolean>;
  disconnect(): Promise<void>;
  link(teamId: string, link: RoutedLink): Promise<void>;
  /** Whether an event of `teamId` can be handled now. Connects when no app runs for the team. */
  ready(teamId: string): Promise<boolean>;
  /** Handle a Slack event. `handOff` ends its record once a stored message holds it. */
  handle(envelope: SlackEnvelope, handOff: () => void): Promise<void>;
}

/** What the route answers: 200 for `accepted` and `dropped`, else 400 or 503. */
export type RouterOutcome = 'accepted' | 'dropped' | 'invalid' | 'unavailable';

class SlackRouterService {
  private server?: Server;
  private handlers?: SlackRouterHandlers;
  /**
   * Event ids accepted in the last `SEEN_EVENT_TTL_MS`, oldest first, with the
   * time each was accepted. Kept in memory: an event whose record ended before
   * a restart is handled again when it arrives after the restart, which takes a
   * lost answer and a restart inside the router's retry window.
   *
   * For `link`, `connected` and `disconnected` this map is the only dedupe. An
   * `add` sent again after a restart, inside the five-minute `sentAt` window,
   * is applied again even when a `remove` of the same link was accepted after
   * it. The protocol asks the router not to send a link envelope again once a
   * later one for the same DM or channel was accepted.
   */
  private readonly seen = new Map<string, number>();

  /** Open the listener, which hands each envelope it accepts to `handlers`. */
  async start(handlers: SlackRouterHandlers): Promise<void> {
    this.handlers = handlers;
    if (this.server) return;
    const server = createServer(createSlackRouterApp((body) => this.accept(body)));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.slackPort, config.host, () => {
        server.off('error', reject);
        // A failed accept emits 'error' on a listening server; without a
        // listener that error stops the process.
        server.on('error', (err) => logger.error({ err }, '[SlackRouter] Listener error'));
        resolve();
      });
    });
    this.server = server;
    logger.info({ port: config.slackPort, host: config.host }, '[SlackRouter] Listening for the Slack router');
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async accept(body: unknown): Promise<RouterOutcome> {
    const handlers = this.handlers;
    if (!handlers || pendingWorkService.shutdownSignal.aborted) return 'unavailable';

    const parsed = routerEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn(
        { fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))] },
        '[SlackRouter] Refused an envelope that does not match the schema',
      );
      return 'invalid';
    }
    const envelope = parsed.data;
    if (Math.abs(Date.now() - Date.parse(envelope.sentAt)) > ENVELOPE_MAX_SKEW_MS) {
      logger.warn(
        { eventId: envelope.eventId, kind: envelope.kind },
        '[SlackRouter] Dropped an envelope sent more than five minutes from this clock',
      );
      return 'dropped';
    }

    this.forgetOldEvents();
    if (this.seen.has(envelope.eventId)) {
      logger.info({ eventId: envelope.eventId }, '[SlackRouter] Dropped an envelope accepted before');
      return 'dropped';
    }
    this.seen.set(envelope.eventId, Date.now());
    try {
      const outcome = await this.apply(envelope, handlers);
      if (outcome === 'unavailable') this.seen.delete(envelope.eventId);
      return outcome;
    } catch (error) {
      this.seen.delete(envelope.eventId);
      throw error;
    }
  }

  /**
   * Handle the Slack events a restart interrupted. Called at boot, after the
   * adapter has started; with no handlers this runtime is not routed any more,
   * and the events have nowhere to go.
   */
  async resume(items: PendingWorkItem[]): Promise<void> {
    const handlers = this.handlers;
    for (const item of items) {
      const parsed = routerEnvelopeSchema.safeParse(item.payload);
      if (!handlers || !parsed.success || parsed.data.kind !== 'slack') {
        pendingWorkService.end('routed-event', item.key);
        continue;
      }
      // An event for a workspace with no app stays for the next boot.
      if (!(await handlers.ready(parsed.data.teamId))) continue;
      this.seen.set(item.key, Date.now());
      void this.handle(parsed.data, handlers);
    }
  }

  private async apply(envelope: RouterEnvelope, handlers: SlackRouterHandlers): Promise<RouterOutcome> {
    switch (envelope.kind) {
      case 'connected':
        return (await handlers.connect(envelope.workspace.teamId)) ? 'accepted' : 'unavailable';
      case 'disconnected':
        await handlers.disconnect();
        return 'accepted';
      case 'link':
        await handlers.link(envelope.teamId, envelope.link);
        return 'accepted';
      case 'slack':
        if (!(await handlers.ready(envelope.teamId))) return 'unavailable';
        // A row left by a delivery before a restart is the same event.
        if (!(await pendingWorkService.claim('routed-event', envelope.eventId, envelope))) return 'dropped';
        void this.handle(envelope, handlers);
        return 'accepted';
    }
  }

  /**
   * The hand-off ends the record even during a shutdown, since the stored
   * message carries the event from then on. The end of the handling does not,
   * so an event a shutdown cut short is handled again at the next boot.
   */
  private async handle(envelope: SlackEnvelope, handlers: SlackRouterHandlers): Promise<void> {
    let handedOff = false;
    const handOff = () => {
      if (handedOff) return;
      handedOff = true;
      pendingWorkService.finish('routed-event', envelope.eventId);
    };
    try {
      await handlers.handle(envelope, handOff);
    } catch (err) {
      logger.error({ err, eventId: envelope.eventId }, '[SlackRouter] Could not handle a Slack event');
    } finally {
      if (!handedOff) pendingWorkService.end('routed-event', envelope.eventId);
    }
  }

  private forgetOldEvents(): void {
    const oldest = Date.now() - SEEN_EVENT_TTL_MS;
    for (const [eventId, acceptedAt] of this.seen) {
      if (acceptedAt >= oldest) return;
      this.seen.delete(eventId);
    }
  }
}

export const slackRouterService = new SlackRouterService();
