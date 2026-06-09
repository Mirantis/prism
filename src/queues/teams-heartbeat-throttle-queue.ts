/**
 * Teams Heartbeat Throttle Queue
 *
 * When a Teams message arrives during a throttle cooldown we can't fire the
 * heartbeat right away, but we also don't want to drop the trigger. We defer
 * it: schedule a timer that re-attempts the claim when the window expires.
 * Same in-memory design as `slack-heartbeat-throttle-queue.ts` — at most one
 * pending `unref`ed timer per agent, cleared on graceful shutdown.
 */

import { teamsHeartbeatTriggerService } from '../services/teams-heartbeat-trigger.service';
import { heartbeatService } from '../services/heartbeat.service';
import { logger } from '../logger';

export class TeamsHeartbeatThrottleQueue {
  private timers = new Map<string, NodeJS.Timeout>();

  async start(): Promise<void> {
    logger.info('[TeamsThrottleQueue] started (in-memory)');
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
      '[TeamsThrottleQueue] Scheduled deferred trigger for agent %s in %ds',
      agentId,
      delaySeconds,
    );
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    logger.info('[TeamsThrottleQueue] Stopped');
  }

  private async fire(agentId: string): Promise<void> {
    this.timers.delete(agentId);
    logger.info({ agentId }, '[TeamsThrottleQueue] Deferred trigger firing for agent %s', agentId);

    try {
      const result = await teamsHeartbeatTriggerService.tryClaimTrigger();
      if (result.claimed) {
        heartbeatService.triggerFromChannel();
        logger.info({ agentId }, '[TeamsThrottleQueue] Triggered heartbeat for agent %s', agentId);
      } else {
        logger.info(
          { agentId },
          '[TeamsThrottleQueue] Trigger still throttled for agent %s, skipping',
          agentId,
        );
      }
    } catch (error: unknown) {
      logger.error(
        { err: error, agentId },
        '[TeamsThrottleQueue] Failed to trigger heartbeat for agent %s',
        agentId,
      );
    }
  }
}

// Lazy singleton — mirrors the Slack throttle queue accessor.
let _instance: TeamsHeartbeatThrottleQueue | null = null;
export function getTeamsHeartbeatThrottleQueue(): TeamsHeartbeatThrottleQueue {
  if (!_instance) {
    _instance = new TeamsHeartbeatThrottleQueue();
  }
  return _instance;
}

/**
 * Test-only: reset the singleton so each test starts clean.
 * @internal
 */
export function __resetTeamsHeartbeatThrottleQueueForTests(): void {
  _instance = null;
}
