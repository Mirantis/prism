/**
 * Tests for the in-memory Slack heartbeat throttle queue.
 *
 * Uses Vitest's fake timers to drive the delayed fire() path without
 * actually waiting the cooldown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockTryClaim, mockTrigger } = vi.hoisted(() => ({
  mockTryClaim: vi.fn(),
  mockTrigger: vi.fn(),
}));

vi.mock('../services/slack-heartbeat-trigger.service', () => ({
  slackHeartbeatTriggerService: { tryClaimTrigger: mockTryClaim },
}));
vi.mock('../services/heartbeat.service', () => ({
  heartbeatService: { triggerFrom: mockTrigger },
}));
vi.mock('../services/slack-message-queue.service', () => ({
  slackMessageQueueService: { channel: 'slack' },
}));

import {
  SlackHeartbeatThrottleQueue,
  getSlackHeartbeatThrottleQueue,
  __resetSlackHeartbeatThrottleQueueForTests,
} from './slack-heartbeat-throttle-queue';

describe('SlackHeartbeatThrottleQueue', () => {
  let queue: SlackHeartbeatThrottleQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    mockTryClaim.mockReset();
    mockTrigger.mockReset();
    __resetSlackHeartbeatThrottleQueueForTests();
    queue = new SlackHeartbeatThrottleQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scheduleDeferred fires after the configured delay and claims the trigger', async () => {
    mockTryClaim.mockResolvedValue({ claimed: true });

    await queue.scheduleDeferred('agent-1', 5);
    expect(mockTryClaim).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * 1000);

    expect(mockTryClaim).toHaveBeenCalledExactlyOnceWith();
    expect(mockTrigger).toHaveBeenCalledExactlyOnceWith({ channel: 'slack' });
  });

  it('does not trigger the heartbeat when the claim is still throttled', async () => {
    mockTryClaim.mockResolvedValue({ claimed: false });

    await queue.scheduleDeferred('agent-2', 3);
    await vi.advanceTimersByTimeAsync(3 * 1000);

    expect(mockTryClaim).toHaveBeenCalledOnce();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('re-scheduling replaces the previous timer for the same agent', async () => {
    mockTryClaim.mockResolvedValue({ claimed: true });

    await queue.scheduleDeferred('agent-3', 10);
    await queue.scheduleDeferred('agent-3', 2); // reschedule sooner

    // 2s should fire the new timer; the original 10s should never run.
    await vi.advanceTimersByTimeAsync(2 * 1000);
    expect(mockTryClaim).toHaveBeenCalledExactlyOnceWith();

    await vi.advanceTimersByTimeAsync(20 * 1000); // past the old 10s too
    expect(mockTryClaim).toHaveBeenCalledOnce(); // still just once
  });

  it('stop() cancels all pending timers', async () => {
    await queue.scheduleDeferred('a', 5);
    await queue.scheduleDeferred('b', 5);

    await queue.stop();

    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(mockTryClaim).not.toHaveBeenCalled();
  });

  it('swallows claim errors without crashing the fire path', async () => {
    mockTryClaim.mockRejectedValue(new Error('boom'));

    await queue.scheduleDeferred('agent-4', 1);
    await vi.advanceTimersByTimeAsync(1 * 1000);
    await vi.runAllTimersAsync(); // let the rejected promise settle

    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('getSlackHeartbeatThrottleQueue() returns a singleton', () => {
    const a = getSlackHeartbeatThrottleQueue();
    const b = getSlackHeartbeatThrottleQueue();
    expect(a).toBe(b);
  });
});
