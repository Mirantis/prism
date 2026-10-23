/**
 * The socket watch fires once a Socket Mode client has gone SOCKET_STALL_MS
 * without `connected`. The event orders below are the ones
 * `@slack/socket-mode` 3.1.0 emits.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SOCKET_STALL_MS, watchSocket } from '../slack-socket-watchdog';

const LIFECYCLE = ['connected', 'reconnecting', 'disconnected'] as const;

describe('Requirement: a Socket Mode client that stays disconnected is reported once', () => {
  let client: EventEmitter;
  let onStall: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new EventEmitter();
    onStall = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A start that reached Slack: `connecting` after `apps.connections.open`, `connected` on `hello`. */
  function connect(): void {
    client.emit('authenticated');
    client.emit('connecting');
    client.emit('connected');
  }

  it('reports a reconnect whose apps.connections.open never answers', () => {
    watchSocket(client, onStall);
    connect();

    // After a drop the client waits, emits `reconnecting`, and then waits on
    // `apps.connections.open` with no deadline.
    client.emit('reconnecting');
    vi.advanceTimersByTime(SOCKET_STALL_MS - 1);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it('reports a socket that opens but never receives hello', () => {
    watchSocket(client, onStall);
    connect();

    client.emit('reconnecting');
    client.emit('authenticated');
    client.emit('connecting');
    vi.advanceTimersByTime(SOCKET_STALL_MS);

    expect(onStall).toHaveBeenCalledOnce();
  });

  it('reports a first start that never connects', () => {
    watchSocket(client, onStall);

    vi.advanceTimersByTime(SOCKET_STALL_MS);

    expect(onStall).toHaveBeenCalledOnce();
  });

  it('never reports a connection that reconnects within the window', () => {
    watchSocket(client, onStall);
    connect();

    // Slack asks a client to reconnect from time to time; the client is back in seconds.
    for (let minute = 0; minute < 30; minute += 1) {
      vi.advanceTimersByTime(55_000);
      client.emit('reconnecting');
      vi.advanceTimersByTime(5_000);
      connect();
    }
    vi.advanceTimersByTime(30 * 60_000);

    expect(onStall).not.toHaveBeenCalled();
  });

  it('counts the window from the first lost state, not the last', () => {
    watchSocket(client, onStall);
    connect();

    client.emit('reconnecting');
    vi.advanceTimersByTime(SOCKET_STALL_MS / 2);
    client.emit('reconnecting');
    client.emit('disconnected');
    vi.advanceTimersByTime(SOCKET_STALL_MS / 2);

    expect(onStall).toHaveBeenCalledOnce();
  });

  it('reports once and then leaves the client alone', () => {
    watchSocket(client, onStall);

    vi.advanceTimersByTime(SOCKET_STALL_MS);
    client.emit('reconnecting');
    vi.advanceTimersByTime(10 * SOCKET_STALL_MS);

    expect(onStall).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    for (const event of LIFECYCLE) expect(client.listenerCount(event)).toBe(0);
  });

  it('leaves no timer and no listener after it is stopped', () => {
    const stop = watchSocket(client, onStall);
    client.emit('reconnecting');

    stop();
    client.emit('disconnected');
    vi.advanceTimersByTime(10 * SOCKET_STALL_MS);

    expect(onStall).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    for (const event of LIFECYCLE) expect(client.listenerCount(event)).toBe(0);
  });
});
