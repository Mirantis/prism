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

  describe('context frames', () => {
    const payload = {
      threadId: 't1',
      modelId: 'us.anthropic.claude-opus-5',
      usedTokens: 580_000,
      windowTokens: 1_000_000,
      usedPercent: 58,
    };

    it('routes a context frame to the latest onContextUsage', async () => {
      // Same ref-freshness contract as onThreadUpdate: the socket handler is
      // bound once, so a stale closure would apply the frame to the wrong thread.
      const first = vi.fn();
      const { rerender, ws } = await renderConnected({ onContextUsage: first });

      const second = vi.fn();
      rerender({ onContextUsage: second });

      act(() => ws.deliver({ type: 'context', payload }));

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(payload);
    });

    it('drops a malformed context frame rather than forwarding NaN', async () => {
      const onContextUsage = vi.fn();
      const { ws } = await renderConnected({ onContextUsage });

      act(() => ws.deliver({ type: 'context', payload: { threadId: 't1' } }));
      act(() => ws.deliver({ type: 'context', payload: { ...payload, usedPercent: 'lots' } }));
      act(() => ws.deliver({ type: 'context' }));
      // A truthy-but-not-string threadId would pass a truthiness guard and then
      // never match the string comparison AgentChat filters on, so every reading
      // would be silently dropped downstream instead of loudly here.
      act(() => ws.deliver({ type: 'context', payload: { ...payload, threadId: 1 } }));

      expect(onContextUsage).not.toHaveBeenCalled();
    });

    it('ignores an unknown frame type without throwing', async () => {
      // Forward compatibility: an older client must survive a newer runtime.
      const onContextUsage = vi.fn();
      const { result, ws } = await renderConnected({ onContextUsage });

      act(() => ws.deliver({ type: 'something-new', payload: { a: 1 } }));

      expect(onContextUsage).not.toHaveBeenCalled();
      expect(result.current.status).toBe('connected');
    });
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

  it('sends a mid-turn followup with its thread id instead of suppressing it', async () => {
    const { result, ws } = await renderConnected({ onMessage: vi.fn() });

    act(() => ws.deliver({ type: 'status', payload: { processing: true } }));
    expect(result.current.isTyping).toBe(true);

    act(() => result.current.sendFollowup('change of plan', 'a1', 't1', []));

    // The hook must not gate on isTyping: this frame is what the gateway offers
    // to the turn that owns t1, and the thread id is what makes that offer
    // possible at all.
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: 'chat',
      payload: {
        mode: 'followup',
        content: 'change of plan',
        agentId: 'a1',
        threadId: 't1',
        attachmentIds: [],
      },
    });
    expect(result.current.isTyping).toBe(true);
  });

  describe('voice frames', () => {
    it('routes every voice frame to the latest onVoice', async () => {
      // Same ref-freshness contract as the callbacks above: the socket handler is
      // bound once, so a stale closure would hand the frames to a call state
      // machine that no longer exists.
      const first = vi.fn();
      const { rerender, ws } = await renderConnected({ onVoice: first });

      const second = vi.fn();
      rerender({ onVoice: second });

      act(() => ws.deliver({ type: 'voice_answer', payload: { sdp: 'v=0\r\n' } }));
      act(() =>
        ws.deliver({
          type: 'voice_ice',
          payload: { candidate: 'candidate:1 1 udp 1 10.0.0.4 51000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
        }),
      );
      act(() => ws.deliver({ type: 'voice_state', payload: { state: 'live' } }));
      act(() => ws.deliver({ type: 'voice_error', payload: { error: 'There is already a voice chat running.' } }));

      expect(first).not.toHaveBeenCalled();
      expect(second.mock.calls.map(([frame]) => frame)).toEqual([
        { kind: 'answer', sdp: 'v=0\r\n' },
        {
          kind: 'ice',
          candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.4 51000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
        },
        { kind: 'state', state: 'live' },
        { kind: 'error', error: 'There is already a voice chat running.' },
      ]);
    });

    it('drops a malformed voice frame rather than forwarding it', async () => {
      const onVoice = vi.fn();
      const { ws } = await renderConnected({ onVoice });

      // A state that is neither `live` nor `ended` would strand the call: the UI
      // would leave the state machine wherever the last good frame put it.
      act(() => ws.deliver({ type: 'voice_state', payload: { state: 'nearly' } }));
      act(() => ws.deliver({ type: 'voice_state' }));
      act(() => ws.deliver({ type: 'voice_answer', payload: {} }));
      act(() => ws.deliver({ type: 'voice_ice', payload: { sdpMid: '0' } }));
      act(() => ws.deliver({ type: 'voice_error', payload: { error: 42 } }));

      expect(onVoice).not.toHaveBeenCalled();
    });

    it('sends the three client frames as docs/voice-chat.md specifies them', async () => {
      const { result, ws } = await renderConnected({});

      act(() => result.current.sendVoiceOffer('v=0\r\nm=audio', 't1'));
      expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
        type: 'voice_offer',
        payload: { sdp: 'v=0\r\nm=audio', threadId: 't1' },
      });

      // No thread: the frame carries the sdp alone rather than a null threadId.
      act(() => result.current.sendVoiceOffer('v=0\r\nm=audio'));
      expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
        type: 'voice_offer',
        payload: { sdp: 'v=0\r\nm=audio' },
      });

      act(() =>
        result.current.sendVoiceIce({ candidate: 'candidate:2 1 udp 1 10.0.0.9 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }),
      );
      expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
        type: 'voice_ice',
        payload: { candidate: 'candidate:2 1 udp 1 10.0.0.9 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 },
      });

      act(() => result.current.sendVoiceStop());
      expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ type: 'voice_stop' });
    });

    it('sends nothing on a socket that is not open', async () => {
      const { result, ws } = await renderConnected({});
      act(() => ws.close());

      act(() => result.current.sendVoiceOffer('v=0\r\n'));
      act(() => result.current.sendVoiceStop());

      expect(ws.sent).toEqual([]);
    });
  });

  it('ignores the connect handshake status, which carries no processing flag', async () => {
    const { result, ws } = await renderConnected({ onMessage: vi.fn() });

    act(() => ws.deliver({ type: 'status', payload: { processing: true } }));
    act(() => ws.deliver({ type: 'status', payload: { connected: true } }));

    expect(result.current.isTyping).toBe(true);
  });
});
