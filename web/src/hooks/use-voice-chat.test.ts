// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * The Computer page's end of the call: one socket carrying audio both ways, the agent's
 * screen, and the page's own pointer and keyboard.
 *
 * The audio path itself is `lib/voice-audio.ts` and has its own tests, so it is a double
 * here. What is worth pinning is the socket: which tag goes to which stream, and that a
 * call which has ended lets go of the microphone rather than leaving the tab recording.
 */

const startVoiceAudio = vi.fn();
vi.mock('@/lib/voice-audio', () => ({
  startVoiceAudio: (...args: unknown[]) => startVoiceAudio(...args),
}));

vi.mock('@/api/runtime-client', () => ({ voiceWebSocketUrl: () => 'ws://localhost/api/voice' }));

import { useVoiceChat } from './use-voice-chat';

/** The audio path, as `startVoiceAudio` hands it over. */
function fakeAudio() {
  return {
    resume: vi.fn(),
    enqueue: vi.fn(),
    enqueueComputer: vi.fn(),
    clear: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

/** A socket the test drives, standing in for the runtime. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;
  readyState = 1;
  binaryType = '';
  readonly sent: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });

  constructor() {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  /** Deliver a JSON text frame from the runtime. */
  text(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  /** Deliver a tagged binary audio frame. */
  audio(tag: number, samples: number[]) {
    const pcm = Int16Array.from(samples);
    const buffer = new Uint8Array(2 + pcm.byteLength);
    buffer[0] = tag;
    buffer.set(new Uint8Array(pcm.buffer), 2);
    this.onmessage?.({ data: buffer.buffer } as MessageEvent);
  }
}

/** A frame of the microphone, as the audio path posts one. */
const FRAME = new Int16Array([1, 2]).buffer;

describe('useVoiceChat', () => {
  let audio: ReturnType<typeof fakeAudio>;
  /** What the hook passed to `startVoiceAudio`, so a test can feed it a frame. */
  let captured: { onFrame: (f: ArrayBuffer) => void; onSpeaking?: (s: boolean) => void };

  beforeEach(() => {
    audio = fakeAudio();
    FakeSocket.last = null;
    startVoiceAudio.mockReset();
    startVoiceAudio.mockImplementation(async (options: typeof captured) => {
      captured = options;
      return audio;
    });
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The rectangle the page shows the screen in, which the call waits for. */
  const VIEWPORT = { width: 1920, height: 1080 };

  /** Render the hook and wait for its socket to exist. */
  async function start() {
    const view = renderHook(() => useVoiceChat(VIEWPORT));
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    return { view, ws: FakeSocket.last! };
  }

  it('opens the microphone at the rate this session speaks', async () => {
    await start();

    // The rate the agent's screen is recorded at, so its sound arrives unresampled.
    expect(startVoiceAudio).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 48_000 }));
  });

  it('reports the call ready, and whether it may take the pointer', async () => {
    const { view, ws } = await start();

    act(() => ws.text({ type: 'status', state: 'ready', desktop: true }));

    expect(view.result.current.state).toBe('ready');
    expect(view.result.current.hasDesktop).toBe(true);
  });

  it('plays the agent and its computer as two streams', async () => {
    const { ws } = await start();

    act(() => ws.audio(0x01, [1, 2]));
    act(() => ws.audio(0x02, [3, 4]));

    expect(audio.enqueue).toHaveBeenCalledTimes(1);
    expect(audio.enqueueComputer).toHaveBeenCalledTimes(1);
  });

  it('drops a frame whose tag this build does not know', async () => {
    const { ws } = await start();

    // Bytes that are not pcm16 played as pcm16 are a screech, and the runtime and the
    // bundle do not always update together.
    act(() => ws.audio(0x09, [1, 2]));

    expect(audio.enqueue).not.toHaveBeenCalled();
    expect(audio.enqueueComputer).not.toHaveBeenCalled();
  });

  it('drops what has not played when the agent is interrupted', async () => {
    const { view, ws } = await start();
    act(() => captured.onSpeaking?.(true));

    act(() => ws.text({ type: 'clear' }));

    expect(audio.clear).toHaveBeenCalled();
    expect(view.result.current.agentSpeaking).toBe(false);
  });

  it('draws each screen picture and counts it', async () => {
    const { view, ws } = await start();

    act(() => ws.text({ type: 'screen', data: 'AAAA' }));

    expect(view.result.current.hasScreen).toBe(true);
    expect(view.result.current.lastFrame?.count).toBe(1);
  });

  it('sends the microphone, and stops while muted', async () => {
    const { view, ws } = await start();

    act(() => captured.onFrame(FRAME));
    expect(ws.sent).toHaveLength(1);

    act(() => view.result.current.toggleMute());
    act(() => captured.onFrame(FRAME));

    // The microphone stays open, so unmuting is silence ending rather than a second
    // permission prompt.
    expect(ws.sent).toHaveLength(1);
    expect(view.result.current.muted).toBe(true);
    // The click is also the gesture an autoplay-blocked context was waiting for.
    expect(audio.resume).toHaveBeenCalled();
  });

  it('lets go of the microphone when the call ends', async () => {
    const { view, ws } = await start();
    act(() => ws.text({ type: 'status', state: 'ready', desktop: true }));

    // Another page took the call. Without this the tab goes on recording, and the browser
    // goes on saying so, until the page is left.
    act(() => ws.text({ type: 'status', state: 'ended', message: 'another page took over' }));

    expect(audio.stop).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    expect(view.result.current.state).toBe('ended');
    expect(view.result.current.message).toBe('another page took over');
    expect(view.result.current.hasDesktop).toBe(false);
  });

  it("says the microphone was refused, and in the user's own terms", async () => {
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    startVoiceAudio.mockRejectedValueOnce(denied);

    const view = renderHook(() => useVoiceChat(VIEWPORT));

    await waitFor(() => expect(view.result.current.state).toBe('mic-denied'));
    expect(view.result.current.message).toMatch(/blocked/i);
    // Nothing was opened, so there is no socket to close.
    expect(FakeSocket.last).toBeNull();
  });

  it('releases everything when the page is left', async () => {
    const { view, ws } = await start();

    view.unmount();

    expect(audio.stop).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
  });

  it('sends the page frames only while the socket is open', async () => {
    const { view, ws } = await start();

    act(() => view.result.current.sendInput({ type: 'wheel', dy: 1 }));
    expect(ws.sent).toContain('{"type":"wheel","dy":1}');

    ws.readyState = 3;
    act(() => view.result.current.sendInput({ type: 'wheel', dy: 2 }));
    expect(ws.sent).toHaveLength(1);
  });
});
