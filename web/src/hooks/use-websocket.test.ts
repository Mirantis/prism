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
  binaryType = 'blob';
  sent: (string | ArrayBuffer)[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
  }

  // Test helpers
  /** The JSON frames only — the audio frames are binary and not parseable. */
  get sentText(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string');
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent);
  }
  /** A frame of the agent's speech, as the browser delivers it. */
  deliverAudio(frame: ArrayBuffer) {
    this.onmessage?.({ data: frame } as MessageEvent);
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
    expect(JSON.parse(ws.sentText.at(-1)!)).toEqual({
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

  it('ignores the connect handshake status, which carries no processing flag', async () => {
    const { result, ws } = await renderConnected({ onMessage: vi.fn() });

    act(() => ws.deliver({ type: 'status', payload: { processing: true } }));
    act(() => ws.deliver({ type: 'status', payload: { connected: true } }));

    expect(result.current.isTyping).toBe(true);
  });

  describe('voice frames', () => {
    const pcm = (byte: number) => new Uint8Array([byte, 0, byte, 0]).buffer;

    it('asks for the audio as buffers rather than blobs', async () => {
      // A blob needs an asynchronous read to open, which would let the audio
      // overtake or fall behind the control frames it is ordered against.
      const { ws } = await renderConnected({ onVoiceAudio: vi.fn() });
      expect(ws.binaryType).toBe('arraybuffer');
    });

    it('keeps the chat path parsing with audio interleaved', async () => {
      const onMessage = vi.fn();
      const onVoiceAudio = vi.fn();
      const { result, ws } = await renderConnected({ onMessage, onVoiceAudio });

      act(() => ws.deliver({ type: 'chat', payload: { id: 'm1', content: 'first' } }));
      act(() => ws.deliverAudio(pcm(1)));
      act(() => ws.deliver({ type: 'chat', payload: { id: 'm2', content: 'second' } }));

      expect(onMessage.mock.calls.map(([m]) => m.id)).toEqual(['m1', 'm2']);
      expect(onVoiceAudio).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe('connected');
    });

    it('routes audio to onVoiceAudio and never to onMessage', async () => {
      const onMessage = vi.fn();
      const onVoiceAudio = vi.fn();
      const { ws } = await renderConnected({ onMessage, onVoiceAudio });

      const frame = pcm(7);
      act(() => ws.deliverAudio(frame));

      expect(onVoiceAudio).toHaveBeenCalledWith(frame);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('hands audio and the clear that cancels it over in arrival order', async () => {
      // The guarantee the barge-in rests on: one handler, no await, so a
      // `voice_clear` cannot be applied before the audio it is meant to drop.
      const seen: string[] = [];
      const { ws } = await renderConnected({
        onVoiceAudio: () => seen.push('audio'),
        onVoiceEvent: (e) => seen.push(e.type),
      });

      act(() => ws.deliverAudio(pcm(1)));
      act(() => ws.deliverAudio(pcm(2)));
      act(() => ws.deliver({ type: 'voice_clear' }));
      act(() => ws.deliverAudio(pcm(3)));

      expect(seen).toEqual(['audio', 'audio', 'clear', 'audio']);
    });

    it('routes each control frame to the latest onVoiceEvent', async () => {
      const first = vi.fn();
      const { rerender, ws } = await renderConnected({ onVoiceEvent: first });

      const onVoiceEvent = vi.fn();
      rerender({ onVoiceEvent });

      act(() =>
        ws.deliver({
          type: 'voice_hello',
          payload: { format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } },
        }),
      );
      act(() => ws.deliver({ type: 'voice_state', payload: { state: 'live' } }));
      act(() => ws.deliver({ type: 'voice_clear' }));
      act(() =>
        ws.deliver({
          type: 'voice_error',
          payload: { error: 'There is already a voice chat running. End that one first.' },
        }),
      );
      act(() => ws.deliver({ type: 'voice_state', payload: { state: 'ended' } }));

      expect(first).not.toHaveBeenCalled();
      expect(onVoiceEvent.mock.calls.map(([e]) => e)).toEqual([
        { type: 'hello', format: { encoding: 'pcm16', sampleRate: 24_000, channels: 1 } },
        { type: 'state', state: 'live' },
        { type: 'clear' },
        { type: 'error', error: 'There is already a voice chat running. End that one first.' },
        { type: 'state', state: 'ended' },
      ]);
    });

    it('reports a refusal that arrived without text, rather than nothing', async () => {
      const onVoiceEvent = vi.fn();
      const { ws } = await renderConnected({ onVoiceEvent });

      act(() => ws.deliver({ type: 'voice_error', payload: {} }));

      expect(onVoiceEvent).toHaveBeenCalledWith({
        type: 'error',
        error: 'The voice chat could not run.',
      });
    });

    it('drops a half-stated format and an unknown state', async () => {
      const onVoiceEvent = vi.fn();
      const { ws } = await renderConnected({ onVoiceEvent });

      act(() => ws.deliver({ type: 'voice_hello', payload: { format: { encoding: 'pcm16' } } }));
      act(() => ws.deliver({ type: 'voice_state', payload: { state: 'starting' } }));
      act(() => ws.deliver({ type: 'voice_state' }));

      expect(onVoiceEvent).not.toHaveBeenCalled();
    });

    it('sends start, audio and stop without disturbing the turn state', async () => {
      const { result, ws } = await renderConnected({ onVoiceEvent: vi.fn() });

      const frame = pcm(9);
      act(() => {
        expect(result.current.sendVoiceStart('t1')).toBe(true);
        result.current.sendVoiceAudio(frame);
        result.current.sendVoiceStop();
      });

      expect(ws.sent).toEqual([
        JSON.stringify({ type: 'voice_start', payload: { threadId: 't1' } }),
        frame,
        JSON.stringify({ type: 'voice_stop' }),
      ]);
      // A call is not a turn: the composer's spinner belongs to the text chat.
      expect(result.current.isTyping).toBe(false);
    });

    it('drops the audio and refuses to start while the socket is down', async () => {
      const { result, ws } = await renderConnected({ onVoiceEvent: vi.fn() });

      act(() => ws.onclose?.({ code: 1006 }));

      act(() => {
        expect(result.current.sendVoiceStart()).toBe(false);
        result.current.sendVoiceAudio(pcm(1));
        result.current.sendVoiceStop();
      });

      expect(ws.sent).toEqual([]);
    });
  });
});
