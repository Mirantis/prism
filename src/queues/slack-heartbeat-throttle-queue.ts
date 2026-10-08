/**
 * Slack Heartbeat Throttle Queue
 *
 * When a Slack message arrives during a throttle cooldown we can't fire the
 * heartbeat right away, but we also don't want to drop the trigger —
 * otherwise a lone incoming message would be lost for up to the cooldown
 * window. We defer it: schedule a timer that re-attempts the claim when the
 * window expires.
 *
 * Implementation: in-memory `setTimeout` keyed by agentId. At most one
 * pending timer per agent; re-scheduling cancels the previous one
 * (equivalent to pg-boss's `singletonKey`). Timers are `unref`ed so they
 * never keep the process alive on their own, and `stop()` clears them on
 * graceful shutdown.
 *
 * We previously used pg-boss here for durable deferral across restarts.
 * In practice the window is seconds to minutes, and if the process does
 * restart inside that window the next incoming Slack message re-triggers
 * the heartbeat anyway — durability wasn't worth the Postgres dependency.
 */

import { slackHeartbeatTriggerService } from '../services/slack-heartbeat-trigger.service';
import { heartbeatService } from '../services/heartbeat.service';
import { slackMessageQueueService } from '../services/slack-message-queue.service';
import { logger } from '../logger';

export class SlackHeartbeatThrottleQueue {
  private timers = new Map<string, NodeJS.Timeout>();

  async start(): Promise<void> {
    logger.info('[ThrottleQueue] started (in-memory)');
  }

  /**
   * Schedule a deferred trigger for an agent. If one is already pending for
   * the same agent, the previous timer is cancelled (singleton-per-agent).
   */
  async scheduleDeferred(agentId: string, delaySeconds: number): Promise<void> {
    const existing = this.timers.get(agentId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => this.fire(agentId), delaySeconds * 1000);
    timer.unref();
    this.timers.set(agentId, timer);

    logger.info(
      { agentId, delaySeconds },
      '[ThrottleQueue] Scheduled deferred trigger for agent %s in %ds',
      agentId,
      delaySeconds,
    );
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    logger.info('[ThrottleQueue] Stopped');
  }

  private async fire(agentId: string): Promise<void> {
    this.timers.delete(agentId);
    logger.info({ agentId }, '[ThrottleQueue] Deferred trigger firing for agent %s', agentId);

    try {
      const result = await slackHeartbeatTriggerService.tryClaimTrigger();
      if (result.claimed) {
        heartbeatService.triggerFrom(slackMessageQueueService);
        logger.info({ agentId }, '[ThrottleQueue] Triggered heartbeat for agent %s', agentId);
      } else {
        logger.info(
          { agentId },
          '[ThrottleQueue] Trigger still throttled for agent %s, skipping',
          agentId,
        );
      }
    } catch (error: unknown) {
      logger.error(
        { err: error, agentId },
        '[ThrottleQueue] Failed to trigger heartbeat for agent %s',
        agentId,
      );
    }
  }
}

// Lazy singleton — kept for call-site compatibility. The underlying class
// no longer needs a config value at construction time.
let _instance: SlackHeartbeatThrottleQueue | null = null;
export function getSlackHeartbeatThrottleQueue(): SlackHeartbeatThrottleQueue {
  if (!_instance) {
    _instance = new SlackHeartbeatThrottleQueue();
  }
  return _instance;
}

/**
 * Test-only: reset the singleton so each test starts clean.
 * @internal
 */
export function __resetSlackHeartbeatThrottleQueueForTests(): void {
  _instance = null;
}
