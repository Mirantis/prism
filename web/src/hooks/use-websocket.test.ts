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

  describe('computer frames', () => {
    const payload = {
      available: true,
      running: true,
      starting: false,
      paused: false,
      controller: null,
      owner: null,
      waiting: [{ id: 'use-1', threadId: 't1', mode: 'chat' }],
      help: [],
    };

    it('routes a computer frame to the latest onComputerStatus', async () => {
      const first = vi.fn();
      const { rerender, ws } = await renderConnected({ onComputerStatus: first });

      const second = vi.fn();
      rerender({ onComputerStatus: second });

      act(() => ws.deliver({ type: 'computer', payload }));

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(payload);
    });

    it('keeps the last good reading when a frame arrives with no waiting list', async () => {
      // The banner and the computer page read `waiting` directly, so forwarding a
      // frame without it would throw in render.
      const onComputerStatus = vi.fn();
      const { ws } = await renderConnected({ onComputerStatus });

      act(() => ws.deliver({ type: 'computer', payload }));
      act(() => ws.deliver({ type: 'computer', payload: { running: true } }));
      act(() => ws.deliver({ type: 'computer' }));

      expect(onComputerStatus.mock.calls).toEqual([[payload]]);
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

  describe('thread activity', () => {
    const working = (threadId: string, value: boolean) => ({
      type: 'status',
      payload: { threadId, working: value },
    });

    it('tracks the working threads, apart from the sender state', async () => {
      const { result, ws } = await renderConnected({});

      act(() => ws.deliver(working('t1', true)));
      expect([...result.current.workingThreadIds]).toEqual(['t1']);
      expect(result.current.isTyping).toBe(false);

      act(() => ws.deliver(working('t1', false)));
      expect(result.current.workingThreadIds.size).toBe(0);
    });

    it('tracks each thread on its own', async () => {
      const { result, ws } = await renderConnected({});

      act(() => {
        ws.deliver(working('t1', true));
        ws.deliver(working('t2', true));
        ws.deliver(working('t1', false));
      });
      expect([...result.current.workingThreadIds]).toEqual(['t2']);
    });

    it('forgets every working thread when the socket closes', async () => {
      const { result, ws } = await renderConnected({});

      act(() => ws.deliver(working('t1', true)));
      act(() => ws.onclose?.({ code: 1000 }));
      expect(result.current.workingThreadIds.size).toBe(0);
    });

    it('drops STOP when the socket closes, as the end of the request can be lost', async () => {
      const { result, ws } = await renderConnected({ onMessage: vi.fn(), activeThreadId: 't1' });

      act(() => result.current.sendFollowup('hello', 'a1', 't1', []));
      act(() => ws.deliver({ type: 'status', payload: { processing: true, threadId: 't1' } }));
      act(() => ws.onclose?.({ code: 1000 }));

      expect(result.current.isTyping).toBe(false);
      expect(result.current.isThreadWorking).toBe(false);
    });

    /**
     * The user reads one thread at a time, so the spinner shows the state of the thread on
     * screen, not one flag for the whole user.
     */
    it('follows the thread on screen when the reader moves between them', async () => {
      const { result, rerender, ws } = await renderConnected({
        onMessage: vi.fn(),
        activeThreadId: 't1',
      });

      act(() => ws.deliver(working('t1', true)));
      expect(result.current.isThreadWorking).toBe(true);

      // Reading an idle thread while t1 works.
      rerender({ onMessage: vi.fn(), activeThreadId: 't2' });
      expect(result.current.isThreadWorking).toBe(false);

      // Work that started on t2 while t1 was on screen shows on t2.
      act(() => ws.deliver(working('t2', true)));
      expect(result.current.isThreadWorking).toBe(true);

      rerender({ onMessage: vi.fn(), activeThreadId: 't1' });
      expect(result.current.isThreadWorking).toBe(true);

      act(() => ws.deliver(working('t1', false)));
      expect(result.current.isThreadWorking).toBe(false);
    });

    it('shows the agent working the moment a message is sent to the thread on screen', async () => {
      const { result, rerender, ws } = await renderConnected({
        onMessage: vi.fn(),
        activeThreadId: 't1',
      });

      act(() => result.current.sendFollowup('hello', 'a1', 't1', []));
      expect(result.current.isThreadWorking).toBe(true);
      expect(result.current.isTyping).toBe(true);

      // The send shows on its own thread only.
      rerender({ onMessage: vi.fn(), activeThreadId: 't2' });
      expect(result.current.isThreadWorking).toBe(false);
      rerender({ onMessage: vi.fn(), activeThreadId: 't1' });

      // The runtime's report replaces the state that the send showed.
      act(() => ws.deliver(working('t1', true)));
      act(() => ws.deliver(working('t1', false)));
      expect(result.current.isThreadWorking).toBe(false);
    });

    it('stops showing the agent working when the message fails before its turn starts', async () => {
      const { result, ws } = await renderConnected({ onMessage: vi.fn(), activeThreadId: 't1' });

      act(() => result.current.sendFollowup('hello', 'a1', 't1', []));
      expect(result.current.isThreadWorking).toBe(true);

      act(() => ws.deliver({ type: 'error', payload: { error: 'thread lookup failed' } }));
      expect(result.current.isThreadWorking).toBe(false);
      expect(result.current.isTyping).toBe(false);
    });

    it('keeps a request the runtime reported running through an error envelope', async () => {
      const { result, ws } = await renderConnected({ onMessage: vi.fn(), activeThreadId: 't1' });

      act(() => {
        ws.deliver({ type: 'status', payload: { processing: true, threadId: 't1' } });
        ws.deliver(working('t1', true));
      });
      act(() => ws.deliver({ type: 'error', payload: { error: 'unrelated' } }));
      expect(result.current.isThreadWorking).toBe(true);
      expect(result.current.isTyping).toBe(true);
    });
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

  it('reports a turn on any thread as the agent being busy, for the presence mark', async () => {
    const { result, ws } = await renderConnected({ onMessage: vi.fn(), activeThreadId: 't1' });

    // A turn in another tab: the agent is busy, but this composer stays idle, since
    // its STOP button would cancel that other turn.
    act(() => ws.deliver({ type: 'status', payload: { processing: true, threadId: 't2' } }));
    expect(result.current.isTyping).toBe(false);
    expect(result.current.isAgentBusy).toBe(true);

    act(() => ws.deliver({ type: 'status', payload: { processing: false, threadId: 't2' } }));
    expect(result.current.isAgentBusy).toBe(false);

    act(() => ws.deliver({ type: 'status', payload: { processing: true, threadId: 't1' } }));
    expect(result.current.isTyping).toBe(true);
    expect(result.current.isAgentBusy).toBe(true);
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
        { type: 'state', state: 'live', desktop: false },
        { type: 'clear' },
        { type: 'error', error: 'There is already a voice chat running. End that one first.' },
        { type: 'state', state: 'ended', desktop: false },
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
        expect(result.current.sendVoiceStart({ threadId: 't1' })).toBe(true);
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

  describe('dictation frames', () => {
    it('hands each frame over in the shape the runtime sent it', async () => {
      const onDictationEvent = vi.fn();
      const { ws } = await renderConnected({ onDictationEvent });

      // The frames a runtime sent for one dictation, recorded from /api/ws.
      act(() => {
        ws.deliver({ type: 'dictation_hello', payload: { format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } } });
        ws.deliver({ type: 'dictation_delta', payload: { text: 'Mock dictation ' } });
        ws.deliver({ type: 'dictation_result', payload: { text: 'Mock dictation of 1000 ms.' } });
        ws.deliver({ type: 'dictation_error', payload: { error: 'A dictation is already running on this connection.' } });
      });

      expect(onDictationEvent.mock.calls.map(([e]) => e)).toEqual([
        { type: 'hello', format: { encoding: 'pcm16', sampleRate: 24000, channels: 1 } },
        { type: 'delta', text: 'Mock dictation ' },
        { type: 'result', text: 'Mock dictation of 1000 ms.' },
        { type: 'error', error: 'A dictation is already running on this connection.' },
      ]);
    });

    it('drops a result with no text and words an error that has none', async () => {
      const onDictationEvent = vi.fn();
      const { ws } = await renderConnected({ onDictationEvent });

      act(() => ws.deliver({ type: 'dictation_result', payload: {} }));
      act(() => ws.deliver({ type: 'dictation_error', payload: {} }));

      expect(onDictationEvent.mock.calls.map(([e]) => e)).toEqual([
        { type: 'error', error: 'The dictation could not be transcribed.' },
      ]);
    });

    it('sends start and both kinds of stop', async () => {
      const { result, ws } = await renderConnected({ onDictationEvent: vi.fn() });

      act(() => {
        expect(result.current.sendDictationStart()).toBe(true);
        result.current.sendDictationStop(true);
        result.current.sendDictationStop(false);
      });

      expect(ws.sent).toEqual([
        JSON.stringify({ type: 'dictation_start', payload: {} }),
        JSON.stringify({ type: 'dictation_stop', payload: { commit: true } }),
        JSON.stringify({ type: 'dictation_stop', payload: { commit: false } }),
      ]);
    });

    it('refuses to start while the socket is down', async () => {
      const { result, ws } = await renderConnected({ onDictationEvent: vi.fn() });

      act(() => ws.onclose?.({ code: 1006 }));

      act(() => {
        expect(result.current.sendDictationStart()).toBe(false);
        result.current.sendDictationStop(false);
      });
      expect(ws.sent).toEqual([]);
    });
  });
});
