// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/api/runtime-client', () => ({ webSocketUrl: () => 'ws://test/api/ws' }));

import { useWebSocket } from './use-websocket';

/** Minimal WebSocket stand-in the hook can drive in jsdom. */
class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }

  // Test helpers
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
}

describe('useWebSocket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Render the hook and wait for it to open its (single) socket. */
  async function renderConnected(initialProps: Parameters<typeof useWebSocket>[0]) {
    const utils = renderHook((props: Parameters<typeof useWebSocket>[0]) => useWebSocket(props), {
      initialProps,
    });
    await waitFor(() => expect(FakeWS.instances.length).toBe(1));
    const ws = FakeWS.instances[0]!;
    act(() => ws.open());
    return { ...utils, ws };
  }

  it('always dispatches to the latest onMessage, not the connect-time closure', async () => {
    const first = vi.fn();
    const { rerender, ws } = await renderConnected({ onMessage: first });

    // Re-render with a fresh callback — mirrors AgentChat passing a new closure
    // each render (e.g. after the active thread changes).
    const second = vi.fn();
    rerender({ onMessage: second });

    act(() => ws.deliver({ type: 'chat', payload: { id: 'm1', threadId: 't1' } }));

    // The bound handler is set once at connect; without latest-callback refs it
    // would call the stale `first`. It must call the current `second`.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', threadId: 't1' }));

    // And it must not have churned the connection on re-render.
    expect(FakeWS.instances.length).toBe(1);
  });

  it('routes thread updates to the latest onThreadUpdate', async () => {
    const first = vi.fn();
    const { rerender, ws } = await renderConnected({ onThreadUpdate: first });

    const second = vi.fn();
    rerender({ onThreadUpdate: second });

    act(() => ws.deliver({ type: 'thread', payload: { threadId: 't9', title: 'Database Schema Migration' } }));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ threadId: 't9', title: 'Database Schema Migration' });
  });

  it('keeps isTyping set across a verbose turn until the runtime ends it', async () => {
    const onMessage = vi.fn();
    const { result, ws } = await renderConnected({ onMessage });

    act(() => ws.deliver({ type: 'status', payload: { processing: true } }));
    expect(result.current.isTyping).toBe(true);

    // Verbose mode delivers each intermediate step mid-turn. An inbound message
    // must not be read as the turn ending, or the spinner and STOP button
    // revert while the agent is still working.
    act(() => ws.deliver({ type: 'chat', payload: { id: 'm1', content: 'step one' } }));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(result.current.isTyping).toBe(true);

    act(() => ws.deliver({ type: 'chat', payload: { id: 'm2', content: 'final' } }));
    expect(result.current.isTyping).toBe(true);

    act(() => ws.deliver({ type: 'status', payload: { processing: false } }));
    expect(result.current.isTyping).toBe(false);
  });

  it('ignores the connect handshake status, which carries no processing flag', async () => {
    const { result, ws } = await renderConnected({ onMessage: vi.fn() });

    act(() => ws.deliver({ type: 'status', payload: { processing: true } }));
    act(() => ws.deliver({ type: 'status', payload: { connected: true } }));

    expect(result.current.isTyping).toBe(true);
  });
});
